# Proxmox VE Helper-Scripts submission

These files are the [community-scripts/ProxmoxVED](https://github.com/community-scripts/ProxmoxVED)
submission for Pokemon Set Tracker — written to their house format (their
`build.func`, their helper functions, release-based install/update). They are
**not used by this repo's own deployment** (that's `/ct`, `/install`, `/misc`
at the repo root, which deploy from git branches).

## Submission workflow

1. This repo must have a **GitHub Release** (their scripts install the latest
   release tarball): merge dev → main, then push a tag — the release workflow
   creates the release automatically:

   ```bash
   git checkout main && git merge dev && git push origin main
   git tag v1.0.0 && git push origin v1.0.0
   ```

2. Fork `community-scripts/ProxmoxVED`, create a branch `feat/pokemon-set-tracker`,
   and copy these files into the fork at their canonical paths:

   | from (this folder)                        | to (ProxmoxVED fork)                  |
   |-------------------------------------------|---------------------------------------|
   | `ct/pokemon-set-tracker.sh`               | `ct/pokemon-set-tracker.sh`           |
   | `ct/headers/pokemon-set-tracker`          | `ct/headers/pokemon-set-tracker`      |
   | `install/pokemon-set-tracker-install.sh`  | `install/pokemon-set-tracker-install.sh` |

3. Test from the fork on a real Proxmox host:

   ```bash
   bash -c "$(curl -fsSL https://raw.githubusercontent.com/<your-fork>/ProxmoxVED/feat/pokemon-set-tracker/ct/pokemon-set-tracker.sh)"
   ```

   (their `dev_mode="trace,keep"` env helps debugging; re-run the same script
   inside the container to test the update path)

4. Open the PR against `community-scripts/ProxmoxVED` — new scripts go there,
   never to ProxmoxVE directly. After review, maintainers promote accepted
   scripts to ProxmoxVE, which is what [the website](https://community-scripts.github.io/ProxmoxVE/)
   lists. Website metadata (logo, description) is handled on the website side.

## Notes for reviewers / future updates

- Data safety across updates: `update_script()` backs up and restores
  `data/` (accounts + collections), `public/cdn/` (the self-hosted card
  database) and `public/config.js` around the `CLEAN_INSTALL` redeploy.
- `sharp` is the app's single optional dependency (card-scanner index +
  in-app image uploads); installation failure is non-fatal by design.
- First visit to the web UI offers the card-database download (the app owns
  its data lifecycle; the install stays fast).
