# Pokémon TCG Tracker

> **Deploying / developing?** See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the dev/main branch workflow, GitHub Actions CI, and the Proxmox LXC one-liner (Helper-Scripts style) with git auto-deploy.

A lightweight, self-hostable web app (PWA) for tracking which Pokémon cards you own — with card images, per-variant tracking (holo, reverse, 1st edition…), a Pokémon-by-Pokémon view, multi-language card data, set-completion progress, and an offline card scanner.

**Everything is self-hosted.** A one-time downloader script builds a static card database (JSON + images) that you host yourself — on the same server as the app, or on any CDN/static host. At runtime the app talks only to *your* server: no third-party APIs, ever. Sets are loaded lazily, so opening the app doesn't download the whole database — just the sets you actually view.

## Features

- **Three ways to browse**
  - **Sets** — every set with completion progress bars
  - **Pokémon** — every printing of each Pokémon across all sets (grouped by Pokédex number: Base Set Charizard, Charizard VMAX, etc. all in one place)
  - **Search** — instant name search with rarity/type filters (built automatically from your data)
- **Per-variant tracking** — each card's real variants come from the data (Normal, Holo, Reverse Holo, 1st Edition, W Promo), plus an "Other / Stamped" slot for prerelease/staff stamps and the like. Track quantities of each.
- **Master set mode** — a toggle on each set page that counts every variant separately in the progress bar, for true master-set collectors.
- **Variant looks** — printings are visually distinct: 1st Edition tiles carry the edition stamp, holo/reverse printings get a sheen. Got a real scan of a specific printing? Drop it in as `cdn/<lang>/images/<set>/<number>/<variant>-low.webp` (e.g. `firstEdition-low.webp`) and the app uses it instead (the downloader auto-detects these on its next run).
- **Sorting everywhere** — sets by newest/oldest/name; cards by number, name, or set release date (remembered per page).
- **Card scanner** — at a shop? Open Scan, point your camera at a card (or take a photo), and the app matches it against your own card database — entirely on-device, no cloud service — and tells you whether you already have it.
- **Multi-language** — download card data in any language TCGdex supports (`--langs en,ja,de,…`) and switch in-app. Your collection carries across languages (it's keyed by card ID, not name).
- **One-tap tracking** — tap a card to mark it owned/missing; cards with multiple variants/copies open details instead so a stray tap never wipes your data.
- **Works offline** — installs as an app on your phone; visited sets and images are cached.
- **Your data, three ways** — saved on-device automatically; JSON export/import backups; optional accounts + cloud sync via the bundled server.

## Setup

Requires Node.js 18+. The server has **zero dependencies**; only the optional scanner index needs one package.

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

Env vars: `PORT` (default 3000), `DATA_DIR` (default `./data` — user accounts & synced collections live there as JSON files; back up that folder and you've backed up everything).

Or with Docker: `docker compose up -d`.

## Hosting the card database somewhere else (CDN)

By default the app expects the database at `cdn/` next to the app files. To host it elsewhere, upload the generated `public/cdn/` folder to any static host and point `public/config.js` at it:

```js
self.PTCG_CONFIG = { cdnBase: 'https://cards.example.com/cdn', defaultLanguage: 'en' };
```

A cross-origin host must send `Access-Control-Allow-Origin: *`. Card images never change — long cache headers are safe (the bundled server already sets them).

## Put it on your phone (as an app)

1. Host the app somewhere your phone can reach and open it in the phone's browser.
2. **iPhone (Safari):** Share → *Add to Home Screen*. **Android (Chrome):** Menu → *Install app*.

> Phones require **HTTPS** for install, offline mode, and **live camera scanning** (`localhost` is exempt). A reverse proxy with automatic HTTPS (e.g. Caddy) in front of `node server.js` is the easiest path. Without HTTPS, the scanner still works via "take a photo".

## Using the scanner

Line the card up with the on-screen frame and capture (or snap a photo). The app computes a perceptual fingerprint of the image and compares it against the fingerprints of every card in your database, showing the top matches with an ownership badge — tap one to add it to your collection on the spot. Tips: fill the frame with the card, avoid glare/sleeves' reflections, and expect the match list (rather than a single guess) to be the norm — reprints with identical artwork genuinely look alike.

## Cloud sync

With the bundled server running, the 👤 button lets anyone create an account. Collections auto-sync (variant quantities included): local changes push after ~1.5 s; signing in on a new device pulls and merges (per-variant highest count wins, merges never delete). Passwords hashed with scrypt; signed 90-day tokens; rate-limited auth endpoints. Put it behind HTTPS if it faces the internet.

## Project layout

```
server.js                zero-dependency Node server (static files + auth/sync API)
scripts/build-data.js    card database downloader (multi-language, resumable)
scripts/build-hashes.js  scan-index builder for the card scanner (needs sharp)
public/                  the entire frontend (vanilla JS PWA, no build step)
  config.js              database location + default language
  index.html, app.js, styles.css, sw.js, manifest.webmanifest, icons/
  cdn/                   generated card database
    languages.json
    <lang>/index.json, sets/, images/, search-index.json, scan-index.json
data/                    created at runtime: users.json, collections/, secret.key
```

## Collection data format

`{ "<cardId>": { "<variant>": quantity, ... }, ... }` — e.g. `{ "base1-4": { "holo": 1, "firstEdition": 1 } }`. Variant keys: `normal`, `holo`, `reverse`, `firstEdition`, `wPromo`, `other`. Older single-number exports import cleanly (treated as `normal`).

## Legal

Fan project for personal collection tracking. Not affiliated with, endorsed by, or sponsored by Nintendo, The Pokémon Company, or Creatures Inc. Card data and images originate from the community-run TCGdex project; host responsibly for personal use.
