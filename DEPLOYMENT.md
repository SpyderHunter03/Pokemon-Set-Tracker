# Deployment & CI/CD

> **Maintainer notes.** This documents how the hosted deployment runs. Local installs of the tracker are not currently offered or supported — the sections below that describe Proxmox/Docker installs are kept for the maintainer's own use and for whenever local installs return.

How this repo goes from your keyboard to your servers.

## The flow at a glance

```
you edit code
   │  git push origin dev
   ▼
GitHub Actions (CI)             ← runs the full end-to-end test suite
   │  tests pass
   ▼
Dev LXC on your Proxmox         ← YOU deploy: run `ptcg-update` inside
   │                              the container when you want the latest
   │  it looks good → merge dev into main (PR or git merge)
   ▼
GitHub Actions (CI again on main)
   ▼
Prod LXC on your Proxmox        ← updates when YOU say so (run `ptcg-update`)
```

Branches: **`dev`** is where you work and what your Dev box tracks. **`main`** is Prod. Never commit straight to main — merge dev into it when Dev looks good.

## One-time setup

### 1. Create the GitHub repo and push

From the extracted project folder (it's already a git repo with `main` and `dev` branches):

```bash
git remote add origin https://github.com/SpyderHunter03/Pokemon-Set-Tracker.git   # already configured in this clone
git push -u origin main dev
```

(Or with the GitHub CLI: `gh repo create Pokemon-Set-Tracker --private --source . --push` then `git push origin dev`.)

That's it for CI — the first push triggers the test workflow. See it under the repo's **Actions** tab. Every future push or pull request to `dev`/`main` runs the whole suite (mock card API → downloader → scanner hashes → real server → 34 browser checks).

> **Private repo note:** the Proxmox scripts clone over anonymous HTTPS, which requires the repo to be **public**. Keeping it private is fine too — you'll just need to use a git credential (a fine-grained PAT) in the clone URL when installing: `https://<token>@github.com/you/repo.git`.

### 2. Spin up the Dev container (when your Proxmox box is ready)

On the Proxmox host, as root:

```bash
PTCG_BRANCH=dev bash -c "$(curl -fsSL https://raw.githubusercontent.com/SpyderHunter03/Pokemon-Set-Tracker/dev/ct/pokemonsettracker.sh)"
```

This follows the community **Proxmox VE Helper-Scripts** structure exactly — `ct/pokemonsettracker.sh` + `install/pokemonsettracker-install.sh` + `misc/build.func`/`install.func` (vendored in this repo, since the upstream build.func only installs apps from the community-scripts repo). You get the familiar flow: header art, a whiptail **Default / Advanced** settings dialog (container ID, hostname, branch, disk/CPU/RAM, bridge, storage), Debian 12 template download, unprivileged LXC creation, and the app installed as a systemd service. **Deploys are manual by design**: when you want the container to pick up what you've pushed, run `ptcg-update` inside it (or `pct exec <ctid> -- ptcg-update` from the host, or community-scripts style: re-run this same one-liner *inside* the container). Prefer a self-updating container? Opt in at create time with `AUTO_UPDATE=yes` — it then checks git every 5 minutes. Non-interactive? `PTCG_DEFAULTS=yes` skips the dialogs; `CT_ID`, `CT_STORAGE`, `CT_DISK_GB`, etc. override defaults.

Then open `http://<container-ip>:3000` and press **Download card database** — the app pulls the full database in the background with a progress bar and builds the scanner index when done. (The first account you register becomes the administrator and gets an **Update card database** button on the Administration page (👤 → Administration) for new set releases. CLI equivalent for extra languages/high-res: `node scripts/build-data.js --langs en,ja --quality both` inside the container.)

Updates never touch this data: deploys are `git reset --hard`, and `data/` (accounts, collections) + `public/cdn/` (card database) are gitignored, so they survive every deploy.

### 3. Spin up Prod (later, when you're ready for the world)

Same script from `main` (the default branch it deploys):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SpyderHunter03/Pokemon-Set-Tracker/main/ct/pokemonsettracker.sh)"
```

Deploying to Prod is then a deliberate two-step: merge `dev` → `main` on GitHub (CI runs again), then on the Proxmox host: `pct exec <prod-ctid> -- ptcg-update` — or, community-scripts style, re-run the ct one-liner **inside** the container to update it.

For showing the world: put a reverse proxy with HTTPS in front (Caddy/Nginx Proxy Manager — both have helper scripts too). HTTPS also unlocks phone installation and live camera scanning.

## Day-to-day workflow

```bash
# hack on the app…
git add -A && git commit -m "add wishlist flags"
git push origin dev          # → CI runs
# deploy it to the Dev box when you're ready:
#   pct exec <dev-ctid> -- ptcg-update

# happy with it?
git checkout main && git merge dev && git push origin main && git checkout dev
# → CI runs on main → run `ptcg-update` on the Prod box when ready
```

Run the full test suite locally before pushing (optional — CI runs it anyway):

```bash
npm install --no-save playwright sharp
npx playwright install chromium
node tests/run-tests.js
```

## The card database on Cloudflare R2

The whole card database — data AND images — can live in a Cloudflare R2 bucket. Point `cdnBase` at it and **every install boots with cards immediately**: no "Download card database" button, no per-instance downloads. One *master* machine (your dev LXC) maintains the database (in-app download/updates, admin uploads, custom printings) and publishes it; every other instance just reads. If the CDN is ever unreachable, instances with a local database fall back to it automatically.

Cost: full English database (≈5–8 GB with both qualities) fits R2's always-free 10 GB tier, and R2 egress is free at any volume — $0 regardless of popularity.

**One-time setup (Cloudflare dashboard):**

1. **R2 → Create bucket** (e.g. `pokemon-cards`).
2. Bucket **Settings → Public access** → enable the `r2.dev` subdomain (or attach a custom domain). Note the public URL (`https://pub-….r2.dev`).
3. Bucket **Settings → CORS policy** — required, the app fetches JSON cross-origin:

   ```json
   [{ "AllowedOrigins": ["*"], "AllowedMethods": ["GET"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 86400 }]
   ```

4. **Manage R2 API Tokens → Create token**, *Object Read & Write*, scoped to the bucket. Note your Account ID (dashboard sidebar), Access Key ID and Secret.

**Publish** — from wherever the database files live. The script talks to the R2 API directly (S3-compatible, signed with your token); it does NOT run through the app, and only works with your secret token. The dashboard's drag-and-drop caps at ~100 files, so this is the practical route for a 20k-file database.

*From your Windows PC* (needs Node.js; database at `public\cdn` — build it with `node scripts\build-data.js` or copy it from the master LXC, which preserves custom printings and uploaded scans):

```powershell
# once: create r2.env in the repo root (gitignored) with the four values —
# R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET
.\scripts\publish-images.ps1 --dry-run   # preview
.\scripts\publish-images.ps1             # publish
```

*From the master LXC*:

```bash
cd /opt/pokemon-set-tracker
R2_ACCOUNT_ID=<account-id> R2_ACCESS_KEY_ID=<key> R2_SECRET_ACCESS_KEY=<secret> \
R2_BUCKET=pokemon-cards node scripts/publish-images.js
```

*Copying the database from the LXC to your PC* (keeps custom printings + uploaded scans): on the Proxmox host — `pct exec <ctid> -- tar czf /tmp/cdn.tgz -C /opt/pokemon-set-tracker/public cdn` then `pct pull <ctid> /tmp/cdn.tgz /root/cdn.tgz`, move that file to your PC (WinSCP/scp), and extract it so it lands at `public\cdn` in the repo.

Zero dependencies (SigV4 is hand-rolled), idempotent — re-run after any database update, admin image upload, or new custom printing; only new/changed files transfer. Images upload immutable; data JSON uploads with a 60s cache so updates propagate fast. `--dry-run` previews, `--langs en` filters, `--images-only` skips data. Tip: keep the env vars in `/root/.r2.env` and run `env $(cat /root/.r2.env) node scripts/publish-images.js`.

**Point the app at the bucket** in `public/config.js` (commit it — it's your deployment's config):

```js
cdnBase: 'https://pub-xxxxxxxx.r2.dev',
```

The master keeps `cdnBase: 'cdn'`? No — the master can use the remote URL too (it falls back to its local copy if the bucket's empty), but the simplest mental model: master = the one machine where you run database updates + `publish-images.js`; its own `config.js` may stay `'cdn'` so its admin tools remain active. Instances pointed at R2 hide the download/update UI automatically.

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
  `/root/.ssh/authorized_keys`. **The same keypair the API repo uses is
  fine** — same box, one door; add the same secret to both repos.
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

## Also built: container images

Every push to dev/main also publishes a Docker image to GitHub's registry (`ghcr.io/spyderhunter03/pokemon-set-tracker:dev` / `:latest`) via `.github/workflows/docker.yml`. The LXC route doesn't use them — they're there if you ever want to run the app on anything that speaks Docker instead.

## Operations cheat-sheet

| Task | Command |
|---|---|
| App logs (inside LXC) | `journalctl -u pokemon-set-tracker -f` |
| Deploy logs | `journalctl -u ptcg-update -f` (also shows auto-update runs if enabled) |
| Manual deploy | `ptcg-update` (inside), `pct exec <ctid> -- ptcg-update`, or re-run the ct one-liner inside the container |
| Restart app | `systemctl restart pokemon-set-tracker` |
| Turn auto-update off/on | `systemctl disable --now ptcg-update.timer` / `enable --now` (only exists if created with AUTO_UPDATE=yes) |
| New sets released | in-app: 👤 → Administration → Card database → **Update card database** (or the CLI inside the container) |
| Back up everything | copy `/opt/pokemon-set-tracker/data` (accounts/collections); `public/cdn` is rebuildable |
