#!/usr/bin/env bash
source <(curl -fsSL "https://raw.githubusercontent.com/${PTCG_REPO:-SpyderHunter03/Pokemon-Set-Tracker}/${PTCG_BRANCH:-main}/misc/build.func")
# Copyright (c) 2026 SpyderHunter03
# Author: SpyderHunter03
# License: MIT | https://github.com/SpyderHunter03/Pokemon-Set-Tracker/raw/main/LICENSE
# Source: https://github.com/SpyderHunter03/Pokemon-Set-Tracker

APP="Pokemon Set Tracker"
var_tags="${var_tags:-pokemon;collection;tracker}"
var_cpu="${var_cpu:-2}"
var_ram="${var_ram:-1024}"
var_disk="${var_disk:-16}"
var_os="${var_os:-debian}"
var_version="${var_version:-12}"
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

  msg_info "Updating ${APP}"
  cd /opt/pokemon-set-tracker
  CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  git fetch origin "$CURRENT_BRANCH" --quiet
  if [[ "$(git rev-parse HEAD)" == "$(git rev-parse "origin/${CURRENT_BRANCH}")" ]]; then
    msg_ok "${APP} is already up to date (${CURRENT_BRANCH} @ $(git rev-parse --short HEAD))"
    exit
  fi
  systemctl stop pokemon-set-tracker
  git reset --hard "origin/${CURRENT_BRANCH}" --quiet
  npm install --no-save sharp >/dev/null 2>&1 || true
  systemctl start pokemon-set-tracker
  msg_ok "Updated ${APP} to ${CURRENT_BRANCH} @ $(git rev-parse --short HEAD)"
  msg_ok "Updated successfully!"
  exit
}

start
build_container
description

msg_ok "Completed successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW}Access it using the following URL:${CL}"
echo -e "${GATEWAY}${BGN}http://${IP}:3000${CL}"
