# Publishing the card database (maintainer workspace → R2)

> **Maintainer notes.** This is the other half of operations: how card
> data and images get FROM the maintainer workspace INTO the R2 bucket
> that the card API and the hosted tracker consume. Nothing here runs on
> the east box — see [DEPLOYMENT.md](DEPLOYMENT.md) for that.

## The card database on Cloudflare R2

The whole card database — data AND images — lives in a Cloudflare R2 bucket. The **maintainer workspace** (see README, "The maintainer workspace") maintains the database (in-app download/updates, admin uploads, custom printings) and publishes it; the hosted tracker consumes it through the card API, and images hotlink the bucket directly.

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

*From your Windows PC* (needs Node.js; database at `public\cdn` — build it with `node scripts\build-data.js` or copy it from the maintainer workspace, which preserves custom printings and uploaded scans):

```powershell
# once: create r2.env in the repo root (gitignored) with the four values —
# R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET
.\scripts\publish-images.ps1 --dry-run   # preview
.\scripts\publish-images.ps1             # publish
```

*From the maintainer workspace (an LXC)*:

```bash
cd /opt/pokemon-set-tracker
R2_ACCOUNT_ID=<account-id> R2_ACCESS_KEY_ID=<key> R2_SECRET_ACCESS_KEY=<secret> \
R2_BUCKET=pokemon-cards node scripts/publish-images.js
```

*Copying the database from the workspace LXC to your PC* (keeps custom printings + uploaded scans): on the Proxmox host — `pct exec <ctid> -- tar czf /tmp/cdn.tgz -C /opt/pokemon-set-tracker/public cdn` then `pct pull <ctid> /tmp/cdn.tgz /root/cdn.tgz`, move that file to your PC (WinSCP/scp), and extract it so it lands at `public\cdn` in the repo.

Zero dependencies (SigV4 is hand-rolled), idempotent — re-run after any database update, admin image upload, or new custom printing; only new/changed files transfer. Images upload immutable; data JSON uploads with a 60s cache so updates propagate fast. `--dry-run` previews, `--langs en` filters, `--images-only` skips data. Tip: keep the env vars in `/root/.r2.env` and run `env $(cat /root/.r2.env) node scripts/publish-images.js`.

