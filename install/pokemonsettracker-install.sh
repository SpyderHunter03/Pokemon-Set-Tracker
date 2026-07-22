#!/usr/bin/env bash

# Copyright (c) 2026 SpyderHunter03
# Author: SpyderHunter03
# License: MIT | https://github.com/SpyderHunter03/Pokemon-Set-Tracker/raw/main/LICENSE
# Source: https://github.com/SpyderHunter03/Pokemon-Set-Tracker

source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

msg_info "Installing Dependencies"
$STD apt-get install -y curl git ca-certificates
msg_ok "Installed Dependencies"

NODE_VERSION="22" setup_nodejs

msg_info "Installing Pokemon Set Tracker (${BRANCH})"
$STD git clone --branch "$BRANCH" "https://github.com/${REPO}.git" /opt/pokemon-set-tracker
cd /opt/pokemon-set-tracker
$STD npm install --no-save sharp || true
msg_ok "Installed Pokemon Set Tracker"

msg_info "Creating Service"
cat <<EOF >/etc/systemd/system/pokemon-set-tracker.service
[Unit]
Description=Pokemon Set Tracker
After=network.target

[Service]
WorkingDirectory=/opt/pokemon-set-tracker
ExecStart=/usr/bin/node server.js
Environment=PORT=3000
Environment=DATA_DIR=/opt/pokemon-set-tracker/data
Restart=on-failure
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl enable -q --now pokemon-set-tracker

cat <<'EOF' >/usr/local/bin/ptcg-update
#!/usr/bin/env bash
# Deploys the latest commit of this container's branch. Runs from the
# auto-update timer (dev) or manually. Data (data/, public/cdn/) is
# untracked, so it survives every deploy.
set -euo pipefail
cd /opt/pokemon-set-tracker
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch origin "$BRANCH" --quiet
LOCAL="$(git rev-parse HEAD)"; REMOTE="$(git rev-parse "origin/${BRANCH}")"
if [[ "$LOCAL" == "$REMOTE" ]]; then echo "Up to date (${BRANCH} @ ${LOCAL:0:7})"; exit 0; fi
echo "Deploying ${BRANCH}: ${LOCAL:0:7} → ${REMOTE:0:7}"
git reset --hard "origin/${BRANCH}" --quiet
npm install --no-save sharp >/dev/null 2>&1 || true
systemctl restart pokemon-set-tracker
echo "Deployed ${REMOTE:0:7} and restarted pokemon-set-tracker."
EOF
chmod 0755 /usr/local/bin/ptcg-update
msg_ok "Created Service"

if [[ "${AUTO_UPDATE:-no}" == "yes" ]]; then
  msg_info "Enabling git auto-update timer (every 5 min)"
  cat <<EOF >/etc/systemd/system/ptcg-update.service
[Unit]
Description=Pokemon Set Tracker auto-update

[Service]
Type=oneshot
ExecStart=/usr/local/bin/ptcg-update
EOF
  cat <<EOF >/etc/systemd/system/ptcg-update.timer
[Unit]
Description=Pokemon Set Tracker auto-update timer

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
  systemctl enable -q --now ptcg-update.timer
  msg_ok "Enabled git auto-update timer"
fi

motd_ssh
customize
cleanup
