#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/../misc/build.func" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_URL:-https://raw.githubusercontent.com/community-scripts/ProxmoxVED/main}/misc/build.func")
# Copyright (c) 2021-2026 community-scripts ORG
# Author: SpyderHunter03
# License: MIT | https://github.com/community-scripts/ProxmoxVED/raw/main/LICENSE
# Source: https://github.com/SpyderHunter03/Pokemon-Set-Tracker

APP="Pokemon Set Tracker"
var_tags="${var_tags:-collection;tracker}"
var_cpu="${var_cpu:-2}"
var_ram="${var_ram:-1024}"
var_disk="${var_disk:-16}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_unprivileged="${var_unprivileged:-1}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources

  if [[ ! -d /opt/pokemon-set-tracker ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi

  if check_for_gh_release "pokemon-set-tracker" "SpyderHunter03/Pokemon-Set-Tracker"; then
    msg_info "Stopping Service"
    systemctl stop pokemon-set-tracker
    msg_ok "Stopped Service"

    msg_info "Backing up Data"
    mkdir -p /opt/pokemon-set-tracker_backup
    [[ -d /opt/pokemon-set-tracker/data ]] && cp -r /opt/pokemon-set-tracker/data /opt/pokemon-set-tracker_backup/data
    [[ -d /opt/pokemon-set-tracker/public/cdn ]] && cp -r /opt/pokemon-set-tracker/public/cdn /opt/pokemon-set-tracker_backup/cdn
    [[ -f /opt/pokemon-set-tracker/public/config.js ]] && cp /opt/pokemon-set-tracker/public/config.js /opt/pokemon-set-tracker_backup/config.js
    msg_ok "Backed up Data"

    CLEAN_INSTALL=1 fetch_and_deploy_gh_release "pokemon-set-tracker" "SpyderHunter03/Pokemon-Set-Tracker" "tarball"

    msg_info "Restoring Data"
    [[ -d /opt/pokemon-set-tracker_backup/data ]] && cp -r /opt/pokemon-set-tracker_backup/data /opt/pokemon-set-tracker/data
    [[ -d /opt/pokemon-set-tracker_backup/cdn ]] && cp -r /opt/pokemon-set-tracker_backup/cdn /opt/pokemon-set-tracker/public/cdn
    [[ -f /opt/pokemon-set-tracker_backup/config.js ]] && cp /opt/pokemon-set-tracker_backup/config.js /opt/pokemon-set-tracker/public/config.js
    rm -rf /opt/pokemon-set-tracker_backup
    msg_ok "Restored Data"

    msg_info "Updating Optional Dependencies"
    cd /opt/pokemon-set-tracker || exit
    $STD npm install --no-save sharp || true
    msg_ok "Updated Optional Dependencies"

    msg_info "Starting Service"
    systemctl start pokemon-set-tracker
    msg_ok "Started Service"
    msg_ok "Updated successfully!"
  fi
  exit
}

start
build_container
description

msg_ok "Completed Successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW}Access it using the following URL:${CL}"
echo -e "${GATEWAY}${BGN}http://${IP}:3000${CL}"
