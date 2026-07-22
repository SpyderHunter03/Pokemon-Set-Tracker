#!/usr/bin/env bash
# Installs Pokémon TCG Tracker inside a Debian 12 container/VM.
# Normally invoked by create-lxc.sh, but safe to run standalone:
#   curl -fsSL https://raw.githubusercontent.com/SpyderHunter03/Pokemon-Set-Tracker/dev/proxmox/install.sh | REPO=SpyderHunter03/Pokemon-Set-Tracker BRANCH=dev bash
set -euo pipefail

REPO="${REPO:?Set REPO=owner/name}"
BRANCH="${BRANCH:-dev}"
AUTO_UPDATE="${AUTO_UPDATE:-no}"
APP_DIR="/opt/pokemon-tcg-tracker"
SERVICE="pokemon-tcg-tracker"

export DEBIAN_FRONTEND=noninteractive
echo "→ Installing dependencies…"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates >/dev/null

if ! command -v node >/dev/null || [[ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 18 ]]; then
  echo "→ Installing Node.js 22…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "✓ Node $(node --version)"

if [[ -d "$APP_DIR/.git" ]]; then
  echo "→ App already present, updating…"
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/${BRANCH}"
else
  echo "→ Cloning ${REPO} (${BRANCH})…"
  git clone --branch "$BRANCH" "https://github.com/${REPO}.git" "$APP_DIR"
fi

# sharp is optional (scanner index builder); never fail the install over it
(cd "$APP_DIR" && npm install --no-save sharp >/dev/null 2>&1) || echo "! sharp install skipped (scanner index can be built later)"

echo "→ Creating systemd service…"
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=Pokemon TCG Tracker
After=network.target

[Service]
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node server.js
Environment=PORT=3000
Environment=DATA_DIR=${APP_DIR}/data
Restart=on-failure
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$SERVICE" >/dev/null

echo "→ Installing update command (ptcg-update)…"
install -m 0755 "${APP_DIR}/proxmox/update.sh" /usr/local/bin/ptcg-update

if [[ "$AUTO_UPDATE" == "yes" ]]; then
  echo "→ Enabling auto-update timer (checks git every 5 min)…"
  cat > /etc/systemd/system/ptcg-update.service <<EOF
[Unit]
Description=Pokemon TCG Tracker auto-update

[Service]
Type=oneshot
ExecStart=/usr/local/bin/ptcg-update
EOF
  cat > /etc/systemd/system/ptcg-update.timer <<EOF
[Unit]
Description=Pokemon TCG Tracker auto-update timer

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now ptcg-update.timer >/dev/null
fi

echo "✓ Installed. Service '${SERVICE}' is running on port 3000."
echo "  Card database: cd ${APP_DIR} && node scripts/build-data.js"
