# Deployment & CI/CD

> **This file is one thing only: how the tracker gets onto, and stays on,
> the east Vultr box.** Publishing the card database to R2 lives in
> **[PUBLISHING.md](PUBLISHING.md)**; the retired self-host flow (Proxmox
> LXC / Docker / `ptcg-update`) lives in
> **[LEGACY-DEPLOY.md](LEGACY-DEPLOY.md)**.

## The flow at a glance

```
you edit code
   │  git push origin dev
   ▼
GitHub Actions (CI)              ← full end-to-end suite, every push
   │  it looks good → merge dev into main
   ▼
GitHub Actions (CI on main)      ← the same suite, on the merge commit
   │  green
   ▼
GitHub Actions (deploy)          ← fires ONLY on a green CI run on main
   │  ssh
   ▼
east (Vultr)                     ← deploy/deploy-node.sh: update, restart,
   ptcg-tracker.service            verify the running process reports the
   tracker.yourdomain.com          deployed commit — or roll back
```

Branches: **`dev`** is where you work; **`main`** is production and every
green push to it deploys. Never commit straight to main — merge dev into
it when dev looks good.

Run the suite locally before pushing (optional — CI runs it anyway):

```bash
npm install --no-save playwright sharp
npx playwright install chromium
node tests/run-tests.js
```

## Hosting on the API's Vultr box (the current production home)

The hosted tracker lives on the **same Vultr instance as the TCG Card API's
east node** — two small Node processes, one 1GB box, one bill. The API's
runbook (`deploy/DEPLOY.md` in the Pkmn-Card-Api repo) stands the box up;
these steps add the tracker beside it.

Two architecture rules, decided up front:

- **The tracker runs on east ONLY, never replicated.** The API was built to
  cluster — tokens and counts sync between peers. The tracker was not:
  accounts, collections and binders are one SQLite database with no
  replication story. When the API grows a west node, the tracker stays where
  its database is.
- **The tracker gets its OWN Cloudflare tunnel.** Every connector on a
  tunnel serves all of that tunnel's hostnames, so parking the tracker's
  hostname on the API's tunnel would break the day west joins it (tracker
  traffic would round-robin to a box not running the tracker). A second
  tunnel with a single connector on east keeps both stories clean.

### 1. User + code + dependencies

```bash
useradd --system --home /var/lib/ptcg-tracker --create-home --shell /usr/sbin/nologin ptcg

git clone https://github.com/SpyderHunter03/Pokemon-Set-Tracker /opt/ptcg-tracker
cd /opt/ptcg-tracker && npm install --omit=dev   # sharp (image uploads), nodemailer (mail), qrcode
# the service writes uploads + the scanner-index cache into public/cdn:
chown -R ptcg:ptcg /opt/ptcg-tracker/public/cdn
```

### 2. The env file

```bash
mkdir -p /etc/ptcg-tracker && touch /etc/ptcg-tracker/env && chmod 600 /etc/ptcg-tracker/env
```

`/etc/ptcg-tracker/env`:

```ini
PORT=3000
HOST=127.0.0.1                    # only the tunnel talks to it, and the tunnel is local
                                  # (the API can't do this — its cluster peers dial in — but the tracker has no peers)
DATA_DIR=/var/lib/ptcg-tracker
# the card API is on the SAME box — talk to it over localhost, not the
# public hostname (no Cloudflare round-trip for catalog pulls)
PTCG_API_BASE=http://localhost:3400
PTCG_API_TOKEN=ptcg_live_…        # mint on this box: cd /opt/card-api &&
                                  #   sudo -u cardapi DATA_DIR=/var/lib/card-api \
                                  #   node scripts/tokens.js issue --name "Set Tracker (hosted)" --plan app
# behind the tunnel every visitor looks like localhost without this —
# rate limiting and lockouts would count everyone as one person
PTCG_CLIENT_IP_HEADER=cf-connecting-ip
```

### 3. The service

```bash
cp /opt/ptcg-tracker/deploy/ptcg-tracker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ptcg-tracker
journalctl -u ptcg-tracker -n 20    # first boot prints the setup code — claim the admin account soon
```

No firewall change: the tunnel reaches :3000 from inside the box, and ufw
keeps strangers out exactly as before.

### 4. The tunnel (its own, not the API's)

Cloudflare Zero Trust → Networks → Tunnels → **Create tunnel** (call it
`ptcg-tracker`). Public hostname: `tracker.yourdomain.com` → service
`http://localhost:3000`. Run its connector install command on east. Both
connectors (API's and tracker's) coexist happily on one box.

### 5. Prove it

```bash
curl -s http://localhost:3000/api/app-config | grep -o '"remoteCatalog":"[^"]*"\|"catalogViaApi":[a-z]*'
#   → "remoteCatalog":"http://localhost:3400/v1"  "catalogViaApi":true
curl -sI https://tracker.yourdomain.com/ | head -1
# in the browser: claim the setup code from the journal, then Administration →
# the update check should say it is up to date (through the API), and on the
# API side the token's spend is visible:
#   cd /opt/card-api && sudo -u cardapi DATA_DIR=/var/lib/card-api node scripts/tokens.js list
```

### 6. Push-to-deploy (one-time setup)

`.github/workflows/deploy.yml` deploys this box automatically: push to
main → the existing **CI** workflow runs the full end-to-end suite → only
a green run on main triggers the deploy. On the box,
`deploy/deploy-node.sh` updates the checkout, refreshes optional deps,
writes the commit into `version.txt`, restarts the service, and then polls
`/api/app-config` until the running process reports **exactly that
commit** back (`release`) — if it never does, the script rolls back to the
previous commit and restarts, so a failed deploy leaves the box on the old
working version. User data is untouchable throughout: it lives in
`/var/lib/ptcg-tracker`, outside the repo.

Two repository secrets (GitHub → Settings → Secrets and variables →
Actions); until they exist the workflow runs, says there is nothing to
deploy to, and exits green:

- `DEPLOY_SSH_KEY` — a private key whose public half is in the box's
  `/root/.ssh/authorized_keys`. A **separate keypair from the API repo's**
  is the tidier choice: rotation and revocation stay per-repo (delete one
  line from `authorized_keys`, replace one secret, the other pipeline
  never notices).
- `DEPLOY_HOST` — the box's IP. One host, not a list: the tracker is
  single-home by design (see the rules above), which is also why this
  workflow is simpler than the API's serial rollout.

The manual trigger (**Actions → deploy → Run workflow**) redeploys current
main without a push. Manual fallback if GitHub itself is down:

```bash
cd /opt/ptcg-tracker && git pull && npm install --omit=dev && systemctl restart ptcg-tracker
```

### What to back up on this box

`/var/lib/ptcg-tracker` (accounts, collections, binders — the state that
cannot rebuild itself) and `/opt/ptcg-tracker/public/cdn` **if** admin
image uploads happen on the hosted box rather than in the maintainer
workspace. The API's ledger (`/var/lib/card-api`) is worth a copy while
east is the only node; once a peer exists it replicates and retires from
the backup list. The catalog, as ever, re-pulls itself.

## Operations cheat-sheet (the east box)

| Task | Command |
|---|---|
| Deploy | push to main (CI green → auto), or **Actions → deploy → Run workflow** |
| Tracker logs | `journalctl -u ptcg-tracker -f` |
| API logs | `journalctl -u card-api -f` |
| Restart tracker | `systemctl restart ptcg-tracker` |
| What's running | `curl -s localhost:3000/api/app-config` → `release` is the deployed commit |
| New sets released | publish per [PUBLISHING.md](PUBLISHING.md), then in-app: 👤 → Administration → **Update card database** |
| Mint/inspect API tokens | `cd /opt/card-api && sudo -u cardapi DATA_DIR=/var/lib/card-api node scripts/tokens.js …` |
| Back up | `/var/lib/ptcg-tracker` (+ `/var/lib/card-api` while east is the only API node) |
