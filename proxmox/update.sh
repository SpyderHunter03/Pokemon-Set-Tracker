#!/usr/bin/env bash
# Deploys the latest commit of this container's branch (the CD half of the
# pipeline). Runs from the auto-update timer on dev, or manually: ptcg-update
set -euo pipefail

APP_DIR="/opt/pokemon-tcg-tracker"
SERVICE="pokemon-tcg-tracker"

cd "$APP_DIR"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch origin "$BRANCH" --quiet
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/${BRANCH}")"

if [[ "$LOCAL" == "$REMOTE" ]]; then
  echo "Up to date (${BRANCH} @ ${LOCAL:0:7})"
  exit 0
fi

echo "Deploying ${BRANCH}: ${LOCAL:0:7} → ${REMOTE:0:7}"
# hard reset only touches tracked files — data/ and public/cdn/ are untracked
# (gitignored), so user accounts, collections and the card database survive.
git reset --hard "origin/${BRANCH}" --quiet
(npm install --no-save sharp >/dev/null 2>&1) || true
systemctl restart "$SERVICE"
echo "Deployed ${REMOTE:0:7} and restarted ${SERVICE}."
