# Pokémon TCG Tracker

> **Deploying / developing?** See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the dev/main branch workflow, GitHub Actions CI, and the Proxmox LXC one-liner (Helper-Scripts style) with git auto-deploy.

A lightweight, self-hostable web app (PWA) for tracking which Pokémon cards you own — with card images, per-variant tracking (holo, reverse, 1st edition…), a Pokémon-by-Pokémon view, multi-language card data, set-completion progress, and an offline card scanner.

**Everything is self-hosted.** At runtime the app talks only to *your* server — no third-party APIs, ever. Each install keeps its cards in a local SQLite database and the app reads from that.

**How new installs get their cards — the master database.** You host one **master card database** (a single `catalog.db` SQLite file, plus the card images) on cheap object storage such as Cloudflare R2. Every install — your public site, a friend's Proxmox box, anyone's own server — pulls that master on first boot and ends up with an identical copy of all the cards, image locations, and any edits you've published. Nobody has to run the slow TCGdex download; they just pull your master. See [How the card database works](#how-the-card-database-works) below.

## Features

- **Three ways to browse**
  - **Sets** — every set with completion progress bars
  - **Pokémon** — every printing of each Pokémon across all sets (grouped by Pokédex number: Base Set Charizard, Charizard VMAX, etc. all in one place)
  - **Search** — instant name search with rarity/type filters (built automatically from your data)
- **Per-variant tracking** — each card's real variants come from the data (Normal, Holo, Reverse Holo, 1st Edition, W Promo), plus an "Other / Stamped" slot for prerelease/staff stamps and the like. Track quantities of each.
- **Master set mode** — a toggle on each set page that counts every variant separately in the progress bar, for true master-set collectors.
- **Variant looks** — printings are visually distinct: 1st Edition tiles carry the edition stamp, holo/reverse printings get a sheen — until you replace them with real images (below).
- **Custom printings & your own images (admin)** — open any card's details as the admin: **＋ Add printing** creates printings the base data doesn't know ("Cracked Ice Holo", staff stamps, whatever your checklist needs) as fully tracked tiles, and **⬆ Upload image** attaches your own photo/scan to the selected printing (converted to webp on the server, shown instead of any synthetic look). Files can also be dropped in manually as `cdn/<lang>/images/<set>/<number>/<variant>-low.webp` — the downloader auto-detects them.
- **Sorting everywhere** — sets by newest/oldest/name; cards by number, name, or set release date (remembered per page).
- **Card scanner** — at a shop? Open Scan, point your camera at a card (or take a photo), and the app matches it against your own card database — entirely on-device, no cloud service — and tells you whether you already have it.
- **Multi-language** — download card data in any language TCGdex supports (`--langs en,ja,de,…`) and switch in-app. Your collection carries across languages (it's keyed by card ID, not name).
- **One-tap tracking** — tap a card to mark it owned/missing; cards with multiple variants/copies open details instead so a stray tap never wipes your data.
- **Works offline** — installs as an app on your phone; visited sets and images are cached.
- **Your data, three ways** — saved on-device automatically; JSON export/import backups; optional accounts + cloud sync via the bundled server.

## How the card database works

There are two roles, and they are deliberately kept apart:

- **The maintainer workspace** manages the one authoritative copy of the card data. It is *not* a personal install — it's a dedicated workbench (see [The maintainer workspace](#the-maintainer-workspace) below) where the TCGdex download runs, edits are made (add printings, upload images, repoint pictures), and from which the master is **published** to object storage (Cloudflare R2 or any S3-compatible bucket). The master is a single file, `catalog.db`, holding only card information and the R2 locations of the images, plus a tiny `catalog.json` manifest carrying the **master version number**.
- **Every install** (public site, Proxmox box, anyone's own server) is a **consumer**: on first boot it downloads `catalog.db` and loads it into its own local SQLite database, ending up an exact duplicate of the master — cards, image locations, and all published edits.

**Versioning and updates.** Every publish that actually changes the data bumps the master version automatically. Installs check the version with one tiny request (`catalog.json`) — the admin panel shows whether you're up to date, and when you're behind, an **Update card database (vX → vY)** button pulls just the card data. Updating never re-downloads images: image files stay wherever they already are (on the bucket, or on your server if you used "Download all images"). Those are two independent things — keeping card *data* current, and choosing where *images* are served from.

**The merge contract.** Updates flow strictly one way, master → installs, with two guarantees:

- Nothing an install changes locally ever reaches the master — publishing only ever happens from the maintainer workspace.
- The master never overrides an install's own changes. Every row carries a source marker: rows that came from the master are updated (and deleted) to match the master on every pull, while rows the install created or edited itself are never touched.

Deletions propagate too: if a card or set is removed from the master, installs drop it on their next update (their own local additions are exempt).

You point an install at a master by setting `cdnBase` in `public/config.js` (or the `PTCG_CDN_BASE` environment variable) to the bucket's public URL:

```js
self.PTCG_CONFIG = { cdnBase: 'https://pub-xxxx.r2.dev', defaultLanguage: 'en' };
```

The repository already ships with `cdnBase` pointing at the project's hosted master, so a fresh install pulls a full, ready-to-use card database with no configuration. Change it to your own bucket if you host your own master.

## Installing

### 1. Self-hosting on Proxmox (Helper-Scripts)

Run the community Helper-Scripts one-liner (see **[DEPLOYMENT.md](DEPLOYMENT.md)**). It creates an LXC, installs the app as a service, and **loads the card database from the master as part of the install** (`node server.js --pull-master`) — so the container comes up already showing every card. If the master isn't reachable during install, the app retries automatically after boot. Nothing else to do.

### 2. Installing on any other server (Docker)

For a public site or any non-Proxmox server, Docker is the simplest path. Requires Docker + Docker Compose.

```bash
git clone https://github.com/SpyderHunter03/Pokemon-Set-Tracker.git
cd Pokemon-Set-Tracker
docker compose up -d
# the app is now on http://<server>:3000
```

On first boot it pulls the master database from the `cdnBase` in `public/config.js` and loads every card. To point at *your own* master instead of the default, edit `public/config.js` before `up`, or set the environment variable in `docker-compose.yml`:

```yaml
    environment:
      - PTCG_CDN_BASE=https://pub-xxxx.r2.dev   # your bucket's public URL
```

The SQLite database, accounts and synced collections live in a mounted `./data` volume — back that folder up and you've backed up everything user-specific (the cards themselves always come from the master).

### 3. Installing on any other server (bare Node)

No Docker? The server has zero dependencies and needs only Node.js 22+.

```bash
git clone https://github.com/SpyderHunter03/Pokemon-Set-Tracker.git
cd Pokemon-Set-Tracker
node server.js          # http://localhost:3000
```

On first boot it pulls the master from `cdnBase`. To run it as a background service, a minimal systemd unit:

```ini
# /etc/systemd/system/ptcg.service
[Unit]
Description=Pokemon TCG Tracker
After=network.target

[Service]
WorkingDirectory=/opt/Pokemon-Set-Tracker
ExecStart=/usr/bin/node server.js
Environment=PORT=3000
Environment=DATA_DIR=/opt/Pokemon-Set-Tracker/data
# optional: point at your own master instead of the committed default
# Environment=PTCG_CDN_BASE=https://pub-xxxx.r2.dev
Restart=on-failure
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now ptcg
```

> **Phones need HTTPS** for install, offline mode, and live camera scanning (`localhost` is exempt). Put a reverse proxy with automatic HTTPS (Caddy is the easiest) in front of `node server.js`.

If an install ever comes up with no cards (for example the master wasn't reachable at first boot), it retries on its own every 10 minutes, the welcome screen has a **Load cards from the database** button, and `node server.js --pull-master` does the same from the command line — any of the three pulls the master on demand. Once cards are loaded, the admin **Administration** panel checks the master version automatically and offers **Update card database** whenever a newer master has been published.

## The maintainer workspace

Skip this entire section if you're happy pulling the project's default master — it's only for running your own.

The master database is managed **entirely separately from any install**. The workspace is just the same app run against a dedicated data directory with the `PTCG_MASTER=1` flag — it exists only to curate and publish the master; nobody tracks a personal collection on it. The app shows a "Master curation workspace" banner in the admin panel so it can't be mistaken for a real install.

**One-time bucket setup (Cloudflare R2 shown; any S3-compatible storage works):** create a bucket, enable public access (you'll get a `pub-….r2.dev` URL or attach a custom domain), and create an API token with Object Read & Write. Point `cdnBase` in `public/config.js` at the public URL.

**One-time workspace setup**, in a clone of this repo (your PC is fine):

```bash
mkdir master-data
node scripts/build-data.js --langs en          # download card data + images from TCGdex
node scripts/build-hashes.js                   # scanner fingerprints (needs sharp)
PTCG_MASTER=1 DATA_DIR=./master-data node server.js   # open http://localhost:3000
# register the workspace admin account, then edit: add printings, upload images…
```

(Windows PowerShell: `$env:PTCG_MASTER='1'; $env:DATA_DIR='.\master-data'; node server.js`)

**Publish** — build `catalog.db` from the workspace database (so every edit rides along) and upload it, the manifest, and the images to the bucket:

```bash
R2_ACCOUNT_ID=xxxx R2_ACCESS_KEY_ID=xxxx R2_SECRET_ACCESS_KEY=xxxx \
R2_BUCKET=pokemon-cards DATA_DIR=./master-data node scripts/publish-images.js
```

The publisher compares content, and only when something actually changed does it bump the master version and upload a new `catalog.db` + `catalog.json`. Unchanged images are skipped (they're immutable). Every install then sees the new version on its next update check. Re-run the publish after every editing session — that's your "save to master" step. Add `--prune` to also delete images you've removed.

The day-to-day loop: start the workspace server → edit in the app → stop it → publish. Your personal installs stay pure consumers and get the changes through the normal update path.

## Setup (bootstrapping the card data)

Requires Node.js 22+. The server has **zero dependencies**; only the optional scanner index needs one package.

### 1. Run the app

```bash
node server.js
# open http://localhost:3000
```

### 2. Download the card database — from the app

On first visit the main page shows a **Download card database** button: press it and a progress bar tracks the download (sets become browsable as they finish; the scanner index is built automatically at the end). Later, the **first registered account** gets an **Administration** section in the 👤 menu with an **Update card database** button that picks up newly released sets.

Prefer the command line (needed for extra languages / high-res images)? The same downloader is scriptable:

```bash
node scripts/build-data.js                  # English, all sets, low-res images
```

Useful options:

```bash
node scripts/build-data.js --langs en,ja    # multiple languages
node scripts/build-data.js --sets base1,sv10
node scripts/build-data.js --quality both   # also high-res images (bigger)
node scripts/build-data.js --no-images      # data only
```

Resumable: re-run any time — it skips what's already downloaded and picks up newly released sets.

**Size expectations (rough):** JSON data is tens of MB per language; low-res images run several hundred MB to ~1 GB per language for the full database; high-res is several GB. `--sets` keeps it small.

### Scanner index (automatic)

The in-app download builds the scanner fingerprints automatically (it installs `sharp`, the one optional dependency, on the fly). Manual equivalent: `npm install --no-save sharp && node scripts/build-hashes.js`.

Env vars: `PORT` (default 3000), `DATA_DIR` (default `./data` — the local SQLite database `ptcg.db` holds the card catalog, user accounts and synced collections; back up that folder and you've backed up everything), `PTCG_CDN_BASE` (override the master database location from `public/config.js`).

Or with Docker: `docker compose up -d`.

## Serving images from a CDN you control

Card *data* (a few tens of MB of JSON) and card *images* (hundreds of MB+) don't have to live together. Point `imageBase` in `public/config.js` at any host you control and the app links every card image there instead of serving it itself:

```js
self.PTCG_CONFIG = { cdnBase: 'cdn', defaultLanguage: 'en', imageBase: 'https://cards-cdn.example.com' };
```

The CDN just needs the same layout the downloader produces — sync your `public/cdn/<lang>/images` folders up to it (rsync, rclone, object storage, anything) and you're done. Workflow: keep one "master" machine that runs the image download and any admin image uploads, sync its `images/` folders to the CDN on whatever schedule you like, and run the app itself data-only (`node scripts/build-data.js --no-images`, or set `PTCG_BUILD_EXTRA_ARGS=--no-images` in the service environment so the in-app download button skips images too). Notes: the CDN host should send `Access-Control-Allow-Origin: *` and long cache headers (images are immutable); the card scanner's index has to be built on the machine that has the image files locally.

## Hosting the whole card database elsewhere

The publisher (`scripts/publish-images.js`) uploads the master `catalog.db` **and** the image files to your bucket, which is the normal way to host the whole database off-box — see [The maintainer workspace](#the-maintainer-workspace) above. Any S3-compatible object storage works; the bucket must be publicly readable and send `Access-Control-Allow-Origin: *`. Installs pull `catalog.db` from the bucket root and load images from it directly.

## Put it on your phone (as an app)

1. Host the app somewhere your phone can reach and open it in the phone's browser.
2. **iPhone (Safari):** Share → *Add to Home Screen*. **Android (Chrome):** Menu → *Install app*.

> Phones require **HTTPS** for install, offline mode, and **live camera scanning** (`localhost` is exempt). A reverse proxy with automatic HTTPS (e.g. Caddy) in front of `node server.js` is the easiest path. Without HTTPS, the scanner still works via "take a photo".

## Using the scanner

Line the card up with the on-screen frame and capture (or snap a photo). The app computes a perceptual fingerprint of the image and compares it against the fingerprints of every card in your database, showing the top matches with an ownership badge — tap one to add it to your collection on the spot. Tips: fill the frame with the card, avoid glare/sleeves' reflections, and expect the match list (rather than a single guess) to be the norm — reprints with identical artwork genuinely look alike.

## Variant image API (share your library)

Your card database is served openly (CORS `*`), so other apps — or friends running this tracker — can pull your variant images:

- `GET /api/variant-images?lang=en` — JSON manifest of every variant image you've added (card, set, variant, URLs).
- `GET /cdn/en/images/<set>/<number>/<variant>-<low|high>.webp` — the images themselves (long-cached, immutable).
- The rest of the database is equally fetchable: `/cdn/languages.json`, `/cdn/en/index.json`, `/cdn/en/sets/<set>.json`, `/cdn/custom.json` (custom printing definitions).

A note on sourcing: for a public API, share images of your own cards (or scans you made). Pictures saved from marketplaces like Cardmarket are fine as personal reference, but redistributing them publicly isn't yours to license.

## Cloud sync

With the bundled server running, the 👤 button lets anyone create an account. Collections auto-sync (variant quantities included): local changes push after ~1.5 s; signing in on a new device pulls and merges (per-variant highest count wins, merges never delete). Passwords hashed with scrypt; signed 90-day tokens; rate-limited auth endpoints. Put it behind HTTPS if it faces the internet.

## Project layout

```
server.js                zero-dependency Node server (static files, SQLite catalog + auth/sync API)
scripts/build-data.js    card database downloader (multi-language, resumable) — maintainer only
scripts/build-hashes.js  scan-index builder for the card scanner (needs sharp)
scripts/publish-images.js  uploads images + the master catalog.db to your bucket — maintainer only
public/                  the entire frontend (vanilla JS PWA, no build step)
  config.js              master database location (cdnBase) + default language
  index.html, app.js, styles.css, sw.js, manifest.webmanifest, icons/
  cdn/                   generated card database (on the maintainer machine; published to the bucket)
    <lang>/index.json, sets/, images/, scan-index.json
data/                    created at runtime:
  ptcg.db                SQLite — the local card catalog, accounts, and synced collections
  secret.key             token-signing key
your bucket (R2/S3)      catalog.db + catalog.json (versioned master every install pulls) + <lang>/images/…
```

## Collection data format

`{ "<cardId>": { "<variant>": quantity, ... }, ... }` — e.g. `{ "base1-4": { "holo": 1, "firstEdition": 1 } }`. Variant keys: `normal`, `holo`, `reverse`, `firstEdition`, `wPromo`, `other`. Older single-number exports import cleanly (treated as `normal`).

## Legal

Fan project for personal collection tracking. Not affiliated with, endorsed by, or sponsored by Nintendo, The Pokémon Company, or Creatures Inc. Card data and images originate from the community-run TCGdex project; host responsibly for personal use.
