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
Dev LXC on your Proxmox         ← auto-pulls the dev branch every 5 min,
   │                              redeploys itself (CD)
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
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SpyderHunter03/Pokemon-Set-Tracker/dev/proxmox/create-lxc.sh)"
```

In the style of the Proxmox VE Helper-Scripts, this: downloads a Debian 12 template if needed, creates an unprivileged LXC (2 cores / 1 GB / 16 GB disk / DHCP — all overridable, see the header of `proxmox/create-lxc.sh`), installs Node and the app as a systemd service, and — because it's the dev branch — enables the **auto-update timer**: every 5 minutes the container checks git and redeploys if you've pushed. Push to dev, wait a few minutes, refresh your browser.

Then, once, inside the container (`pct enter <ctid>`):

```bash
cd /opt/pokemon-tcg-tracker
node scripts/build-data.js                              # card database
npm install --no-save sharp && node scripts/build-hashes.js   # scanner index
```

Updates never touch this data: deploys are `git reset --hard`, and `data/` (accounts, collections) + `public/cdn/` (card database) are gitignored, so they survive every deploy.

### 3. Spin up Prod (later, when you're ready for the world)

Same one-liner with two changes — track `main`, no auto-update:

```bash
PTCG_BRANCH=main \
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SpyderHunter03/Pokemon-Set-Tracker/main/proxmox/create-lxc.sh)"
```

Deploying to Prod is then a deliberate two-step: merge `dev` → `main` on GitHub (CI runs again), then on the Proxmox host: `pct exec <prod-ctid> -- ptcg-update`. If you'd rather Prod also auto-deploy from main, create it with `AUTO_UPDATE=yes`.

For showing the world: put a reverse proxy with HTTPS in front (Caddy/Nginx Proxy Manager — both have helper scripts too). HTTPS also unlocks phone installation and live camera scanning.

## Day-to-day workflow

```bash
# hack on the app…
git add -A && git commit -m "add wishlist flags"
git push origin dev          # → CI runs → Dev box redeploys itself within ~5 min

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

## Also built: container images

Every push to dev/main also publishes a Docker image to GitHub's registry (`ghcr.io/spyderhunter03/pokemon-set-tracker:dev` / `:latest`) via `.github/workflows/docker.yml`. The LXC route doesn't use them — they're there if you ever want to run the app on anything that speaks Docker instead.

## Operations cheat-sheet

| Task | Command |
|---|---|
| App logs (inside LXC) | `journalctl -u pokemon-tcg-tracker -f` |
| Auto-update logs (dev) | `journalctl -u ptcg-update -f` |
| Manual deploy | `ptcg-update` (inside) or `pct exec <ctid> -- ptcg-update` |
| Restart app | `systemctl restart pokemon-tcg-tracker` |
| Pause dev auto-updates | `systemctl disable --now ptcg-update.timer` |
| New sets released | inside: `cd /opt/pokemon-tcg-tracker && node scripts/build-data.js && node scripts/build-hashes.js` |
| Back up everything | copy `/opt/pokemon-tcg-tracker/data` (accounts/collections); `public/cdn` is rebuildable |
