#!/usr/bin/env bash

# Copyright (c) 2021-2026 community-scripts ORG
# Author: SpyderHunter03
# License: MIT | https://github.com/community-scripts/ProxmoxVED/raw/main/LICENSE
# Source: https://github.com/SpyderHunter03/Pokemon-Set-Tracker

source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

NODE_VERSION="22" setup_nodejs

fetch_and_deploy_gh_release "pokemon-set-tracker" "SpyderHunter03/Pokemon-Set-Tracker" "tarball"

msg_info "Setting up Pokemon Set Tracker"
cd /opt/pokemon-set-tracker || exit
$STD npm install --no-save sharp || true
msg_ok "Set up Pokemon Set Tracker"

msg_info "Creating Service"
cat <<EOF >/etc/systemd/system/pokemon-set-tracker.service
[Unit]
Description=Pokemon Set Tracker
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/pokemon-set-tracker
ExecStart=/usr/bin/node server.js
Environment=PORT=3000
Environment=DATA_DIR=/opt/pokemon-set-tracker/data
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl enable -q --now pokemon-set-tracker
msg_ok "Created Service"

motd_ssh
customize
cleanup_lxc
