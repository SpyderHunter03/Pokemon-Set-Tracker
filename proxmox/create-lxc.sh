#!/usr/bin/env bash
# ------------------------------------------------------------------------
# Pokémon TCG Tracker — Proxmox LXC creator
# Run this ON THE PROXMOX HOST (as root). In the style of the community
# Proxmox VE Helper-Scripts: creates a Debian 12 LXC, installs the app as
# a systemd service, and (on the dev branch) enables auto-updates from git.
#
#   Dev:   bash create-lxc.sh
#   Prod:  PTCG_BRANCH=main bash create-lxc.sh
#
# Or straight from GitHub:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/SpyderHunter03/Pokemon-Set-Tracker/dev/proxmox/create-lxc.sh)"
#
# Overridable env vars (defaults in brackets):
#   PTCG_REPO    GitHub repo "owner/name"        [SpyderHunter03/Pokemon-Set-Tracker]
#   PTCG_BRANCH  branch to deploy                [dev]
#   CT_ID        container id                    [next free id]
#   CT_HOSTNAME  container hostname              [ptcg-<branch>]
#   CT_STORAGE   rootfs storage                  [local-lvm]
#   CT_DISK_GB   disk size — card images need room [16]
#   CT_MEM_MB    memory                          [1024]
#   CT_CORES     cpu cores                       [2]
#   CT_BRIDGE    network bridge                  [vmbr0]
#   AUTO_UPDATE  yes/no git auto-deploy timer    [yes on dev, no on main]
# ------------------------------------------------------------------------
set -euo pipefail

RD=$'\033[01;31m'; GN=$'\033[1;92m'; YW=$'\033[33m'; CL=$'\033[m'
msg()  { echo -e "${GN} ✓ ${CL}$1"; }
info() { echo -e "${YW} → ${CL}$1"; }
die()  { echo -e "${RD} ✗ $1${CL}"; exit 1; }

REPO="${PTCG_REPO:-SpyderHunter03/Pokemon-Set-Tracker}"
BRANCH="${PTCG_BRANCH:-dev}"
command -v pct >/dev/null || die "This script must run on a Proxmox VE host (pct not found)."

CT_ID="${CT_ID:-$(pvesh get /cluster/nextid)}"
CT_HOSTNAME="${CT_HOSTNAME:-ptcg-${BRANCH}}"
CT_STORAGE="${CT_STORAGE:-local-lvm}"
CT_DISK_GB="${CT_DISK_GB:-16}"
CT_MEM_MB="${CT_MEM_MB:-1024}"
CT_CORES="${CT_CORES:-2}"
CT_BRIDGE="${CT_BRIDGE:-vmbr0}"
if [[ -z "${AUTO_UPDATE:-}" ]]; then
  [[ "$BRANCH" == "dev" ]] && AUTO_UPDATE="yes" || AUTO_UPDATE="no"
fi

echo -e "${GN}Pokémon TCG Tracker — LXC deploy${CL}"
info "repo=${REPO}  branch=${BRANCH}  ctid=${CT_ID}  host=${CT_HOSTNAME}  auto-update=${AUTO_UPDATE}"

# ---- find or download a Debian 12 template ----
info "Locating Debian 12 template…"
TEMPLATE="$(pveam list local 2>/dev/null | awk '/debian-12-standard/ {print $1}' | sort | tail -n1)"
if [[ -z "$TEMPLATE" ]]; then
  pveam update >/dev/null
  REMOTE_TEMPLATE="$(pveam available --section system | awk '/debian-12-standard/ {print $2}' | sort | tail -n1)"
  [[ -n "$REMOTE_TEMPLATE" ]] || die "No debian-12-standard template available."
  info "Downloading ${REMOTE_TEMPLATE}…"
  pveam download local "$REMOTE_TEMPLATE"
  TEMPLATE="local:vztmpl/${REMOTE_TEMPLATE}"
fi
msg "Template: ${TEMPLATE}"

# ---- create + start ----
info "Creating LXC ${CT_ID}…"
pct create "$CT_ID" "$TEMPLATE" \
  -hostname "$CT_HOSTNAME" \
  -memory "$CT_MEM_MB" \
  -cores "$CT_CORES" \
  -rootfs "${CT_STORAGE}:${CT_DISK_GB}" \
  -net0 "name=eth0,bridge=${CT_BRIDGE},ip=dhcp" \
  -features nesting=1 \
  -unprivileged 1 \
  -onboot 1
msg "Container created"

pct start "$CT_ID"
info "Waiting for network…"
for _ in $(seq 1 30); do
  if pct exec "$CT_ID" -- bash -c "ping -c1 -W1 github.com" >/dev/null 2>&1; then break; fi
  sleep 2
done
msg "Network is up"

# ---- install the app inside ----
info "Installing Pokémon TCG Tracker (branch: ${BRANCH})…"
pct exec "$CT_ID" -- bash -c "curl -fsSL https://raw.githubusercontent.com/${REPO}/${BRANCH}/proxmox/install.sh | REPO='${REPO}' BRANCH='${BRANCH}' AUTO_UPDATE='${AUTO_UPDATE}' bash"

IP="$(pct exec "$CT_ID" -- hostname -I | awk '{print $1}')"
echo
msg "Done! Pokémon TCG Tracker (${BRANCH}) is running:"
echo -e "    ${GN}http://${IP}:3000${CL}"
echo
info "Next steps inside the container (pct enter ${CT_ID}):"
echo "    cd /opt/pokemon-tcg-tracker && node scripts/build-data.js     # download the card database"
echo "    npm install --no-save sharp && node scripts/build-hashes.js   # enable the card scanner"
[[ "$AUTO_UPDATE" == "yes" ]] && info "Auto-update is ON: this container redeploys '${BRANCH}' within ~5 minutes of a push."
[[ "$AUTO_UPDATE" == "no"  ]] && info "Auto-update is OFF: deploy manually with  pct exec ${CT_ID} -- ptcg-update"
