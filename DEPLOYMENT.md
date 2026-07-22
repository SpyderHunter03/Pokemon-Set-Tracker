# Deployment & CI/CD

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

Then open `http://<container-ip>:3000` and press **Download card database** — the app pulls the full database in the background with a progress bar and builds the scanner index when done. (The first account you register becomes the administrator and gets an **Update card database** button in the 👤 menu for new set releases. CLI equivalent for extra languages/high-res: `node scripts/build-data.js --langs en,ja --quality both` inside the container.)

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

## Publishing images to Cloudflare R2

The app can serve card images from a Cloudflare R2 bucket instead of hosting them itself (`imageBase` in `public/config.js`). At typical size (full English database, both qualities ≈ 5–8 GB) this fits R2's always-free 10 GB tier, and R2 egress is free at any volume — the bill stays $0 no matter how popular the app gets.

One-time setup (Cloudflare dashboard): **R2 → Create bucket** (e.g. `pokemon-cards`) → bucket **Settings → Public access** → enable the `r2.dev` subdomain (or attach a custom domain) → **Manage R2 API Tokens → Create token** with *Object Read & Write* scoped to the bucket. Note your Account ID (dashboard sidebar), the token's Access Key ID and Secret.

Publish (from wherever the images live — your dev LXC):

```bash
cd /opt/pokemon-set-tracker
R2_ACCOUNT_ID=<account-id> R2_ACCESS_KEY_ID=<key> R2_SECRET_ACCESS_KEY=<secret> \
R2_BUCKET=pokemon-cards node scripts/publish-images.js
```

Zero dependencies (SigV4 is hand-rolled), idempotent — re-run any time after downloading new sets or uploading variant images; only new/changed files transfer. `--dry-run` previews, `--langs en` filters. Tip: keep the env vars in `/root/.r2.env` and run `env $(cat /root/.r2.env) node scripts/publish-images.js`.

Then point the app at the bucket in `public/config.js` (commit this — it's your deployment's config):

```js
imageBase: 'https://pub-xxxxxxxx.r2.dev',
```

Optionally set `Environment=PTCG_BUILD_EXTRA_ARGS=--no-images` in the systemd unit if you later want app instances that don't store images locally at all (the master that runs `publish-images` still needs them).

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
| New sets released | in-app: 👤 → Administration → **Update card database** (or the CLI inside the container) |
| Back up everything | copy `/opt/pokemon-set-tracker/data` (accounts/collections); `public/cdn` is rebuildable |
