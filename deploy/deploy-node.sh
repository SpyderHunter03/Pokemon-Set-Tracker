#!/usr/bin/env bash
# Runs ON the tracker's box, piped in over SSH by .github/workflows/deploy.yml:
#   TARGET_SHA=<commit> bash -s < deploy/deploy-node.sh
#
# The contract: exit 0 means the box is verified serving TARGET_SHA; anything
# else means it was rolled back to the commit it was on. Either way it ends
# on exactly one working version.
#
# The verification is honest: /api/app-config reports the contents of
# version.txt (its `release` field), this script writes TARGET_SHA there
# before restarting, and then refuses to believe the deploy until the
# running process reports that exact value back. "systemd restarted it" is
# not "the new code is serving".
#
# User data is never in danger here: accounts, collections and binders live
# in /var/lib/ptcg-tracker, outside the repo, and `git reset --hard` touches
# only /opt/ptcg-tracker. Admin-uploaded card images under public/cdn are
# untracked files, which reset --hard leaves alone too.
set -euo pipefail

: "${TARGET_SHA:?TARGET_SHA must be set to the commit to deploy}"

cd /opt/ptcg-tracker

OLD_SHA=$(git rev-parse HEAD)

deps() {
  # optional deps (sharp, nodemailer, qrcode) move rarely, and when nothing
  # changed this is a no-op costing a second or two
  npm install --omit=dev --no-audit --no-fund
}

verify() {
  # up AND reporting the wanted release — poll a little longer than the API's
  # script because a restart may land mid-catalog-work
  local want="$1" body
  for _ in $(seq 1 45); do
    sleep 1
    body=$(curl -s --max-time 2 http://localhost:3000/api/app-config || true)
    if [ "${body#*\"release\":\"$want\"}" != "$body" ]; then
      return 0
    fi
  done
  return 1
}

place() {
  # put the tree at a commit and stamp it as the running release
  git reset --hard "$1"
  deps
  printf '%s\n' "$1" > version.txt
}

git fetch origin
place "$TARGET_SHA"

systemctl restart ptcg-tracker

if verify "$TARGET_SHA"; then
  echo "$(hostname): tracker healthy on $TARGET_SHA"
  exit 0
fi

echo "$(hostname): FAILED to verify $TARGET_SHA — rolling back to $OLD_SHA" >&2
place "$OLD_SHA"
systemctl restart ptcg-tracker
if verify "$OLD_SHA"; then
  echo "$(hostname): rolled back, healthy again on $OLD_SHA" >&2
else
  echo "$(hostname): rollback restart did NOT verify — check 'journalctl -u ptcg-tracker' NOW" >&2
fi
exit 1
