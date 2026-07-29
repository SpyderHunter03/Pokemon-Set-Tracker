#!/usr/bin/env node
/**
 * Pokemon TCG Tracker — self-hostable server
 * Zero dependencies: plain Node.js (>= 18).
 *
 * Serves the PWA from ./public and provides optional account + cloud-sync API.
 * Accounts and collections live in a SQLite database (DATA_DIR/ptcg.db) via
 * Node's built-in node:sqlite — no external dependency. Requires Node 22.5+.
 * Card-database overlays and settings remain small JSON files under DATA_DIR.
 *
 * Usage:  node server.js          (then open http://localhost:3000)
 * Env:    PORT=3000  DATA_DIR=./data
 *         PTCG_READONLY=1  central-server mode: every endpoint that could
 *         change the card database (downloads, custom printings, image
 *         uploads, mirroring) returns 403 — enforced here, not just hidden
 *         in the UI. Self-hosted installs leave this unset.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
// The deployed release (GitHub tag). The deploy tooling records it in one of
// two places depending on version: version.txt next to the app, or the
// Helper-Scripts marker ~/.pokemon-set-tracker. Absent in dev.
let RELEASE_VERSION = null;
for (const f of [path.join(__dirname, 'version.txt'), path.join(require('os').homedir(), '.pokemon-set-tracker')]) {
  try {
    const v = fs.readFileSync(f, 'utf8').trim().replace(/^v/, '');
    if (v) { RELEASE_VERSION = v; break; }
  } catch { /* try next location */ }
}
const USERS_FILE = path.join(DATA_DIR, 'users.json');           // legacy (pre-SQLite) — migrated on first run
const COLLECTIONS_DIR = path.join(DATA_DIR, 'collections');     // legacy (pre-SQLite) — migrated on first run
const DB_FILE = path.join(DATA_DIR, 'ptcg.db');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 90; // 90 days
const MAX_BODY = 8 * 1024 * 1024; // 8 MB — a full collection is far smaller
const READONLY = process.env.PTCG_READONLY === '1';
// Maintainer/curation workspace: this instance manages the MASTER database
// (edits here are what get published). It is not a personal install — the app
// shows a banner so the two are never confused. See README "maintainer
// workspace".
const MASTER_MODE = process.env.PTCG_MASTER === '1';
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- database (accounts + collections) ----------
// Uses SQLite via Node's built-in node:sqlite (no external dependency), the
// same storage model the mature self-hosted apps use (Uptime Kuma, Gitea,
// Nextcloud). Everything lives in one file, DATA_DIR/ptcg.db — back it up by
// copying that single file.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error('This server needs Node 22.5+ (for the built-in node:sqlite database). Please update Node and restart.');
  process.exit(1);
}
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');       // concurrent-safe writes
db.exec('PRAGMA busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id       TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,          -- lowercase login key
    display  TEXT NOT NULL,
    salt     TEXT NOT NULL,
    hash     TEXT NOT NULL,
    created  TEXT NOT NULL,
    admin    INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS collections (
    user_id    TEXT PRIMARY KEY,
    data       TEXT NOT NULL,               -- JSON: { cardId: { variant: qty } }
    updated_at INTEGER NOT NULL
  );
  -- Binders: a user's physical binders, tracked pocket by pocket. Pages of
  -- size×size pockets; slots is a sparse JSON map of pocket index →
  -- { card, variant, have } with its own independent have/need checklist.
  CREATE TABLE IF NOT EXISTS binders (
    user_id TEXT NOT NULL,
    id      TEXT NOT NULL,
    name    TEXT NOT NULL,
    size    INTEGER NOT NULL,               -- pockets per side: 2, 3, 4 or 5
    color   TEXT NOT NULL,
    pages   INTEGER NOT NULL,
    slots   TEXT NOT NULL,                  -- JSON: { "17": { card, variant, have } }
    created TEXT NOT NULL,
    updated INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );

  -- ---- card catalog (the app reads cards from here, not from R2 JSON) ----
  -- Every card and printing is a row. Image fields hold a full location: a
  -- remote URL (default, e.g. the R2 bucket) OR a local path served by this
  -- server (e.g. /cdn/en/images/…) once an admin uploads or downloads one.
  -- source = 'master' (imported/pulled) or 'local' (this install's own edits);
  -- hidden = 1 tombstones a row so a future pull can't bring it back.
  CREATE TABLE IF NOT EXISTS sets (
    lang           TEXT NOT NULL DEFAULT 'en',
    id             TEXT NOT NULL,
    name           TEXT NOT NULL,
    release_date   TEXT,
    logo           TEXT,                     -- image location or null
    official_count INTEGER,                  -- printed set size (completion denominator)
    position       INTEGER NOT NULL DEFAULT 0, -- release order
    source         TEXT NOT NULL DEFAULT 'master',
    hidden         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (lang, id)
  );
  CREATE TABLE IF NOT EXISTS cards (
    lang        TEXT NOT NULL DEFAULT 'en',
    id          TEXT NOT NULL,               -- e.g. base1-4
    set_id      TEXT NOT NULL,
    local_id    TEXT NOT NULL,
    name        TEXT NOT NULL,
    rarity      TEXT,
    category    TEXT,
    dex_csv     TEXT,                         -- "6" or "6,7"
    types_csv   TEXT,
    hp          INTEGER,
    illustrator TEXT,
    variants_csv TEXT,                        -- base variants present: "normal,holo,firstEdition"
    img_low     TEXT,                          -- base image URLs (remote or local) or null
    img_high    TEXT,
    position    INTEGER NOT NULL DEFAULT 0,
    source      TEXT NOT NULL DEFAULT 'master',
    hidden      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (lang, id)
  );
  CREATE INDEX IF NOT EXISTS idx_cards_set ON cards (lang, set_id);
  -- one row per printing that is either custom-named or has its own image
  CREATE TABLE IF NOT EXISTS printings (
    lang     TEXT NOT NULL DEFAULT 'en',
    card_id  TEXT NOT NULL,
    variant  TEXT NOT NULL,                   -- normal/holo/reverse/firstEdition/cracked-ice-holo…
    label    TEXT,                             -- custom printing name (null for standard variants)
    img_low  TEXT,                             -- image override URLs or null (→ use the card image)
    img_high TEXT,
    source   TEXT NOT NULL DEFAULT 'master',
    PRIMARY KEY (lang, card_id, variant)
  );
`);
// migrate older catalog schemas (add columns introduced after first release)
try { db.exec('ALTER TABLE sets ADD COLUMN official_count INTEGER'); } catch { /* already present */ }
try { db.exec('ALTER TABLE binders ADD COLUMN cover TEXT'); } catch { /* already present */ }

// ---------- storage helpers ----------

function loadSecret() {
  try {
    return fs.readFileSync(SECRET_FILE);
  } catch {
    const secret = crypto.randomBytes(32);
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    return secret;
  }
}
const SECRET = loadSecret();

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSONAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); // survive data dir removal at runtime
  const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

// ---------- user & collection queries ----------

const rowToUser = (r) => (r ? { id: r.id, username: r.username, display: r.display, salt: r.salt, hash: r.hash, created: r.created, admin: !!r.admin } : null);

const _getUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const _getUserByName = db.prepare('SELECT * FROM users WHERE username = ?');
const _insertUser = db.prepare('INSERT INTO users (id, username, display, salt, hash, created, admin) VALUES (?, ?, ?, ?, ?, ?, ?)');
const _updateUserHash = db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?');
const _countUsers = db.prepare('SELECT COUNT(*) AS n FROM users');
const _countAdmins = db.prepare('SELECT COUNT(*) AS n FROM users WHERE admin = 1');
const _earliestUser = db.prepare('SELECT * FROM users ORDER BY created ASC, id ASC LIMIT 1');
const _getCollection = db.prepare('SELECT data, updated_at FROM collections WHERE user_id = ?');
const _upsertCollection = db.prepare(
  'INSERT INTO collections (user_id, data, updated_at) VALUES (?, ?, ?) ' +
  'ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at');

const getUserById = (id) => rowToUser(_getUserById.get(id));
const getUserByName = (key) => rowToUser(_getUserByName.get(key));
const userCount = () => _countUsers.get().n;
function createUser(u) {
  _insertUser.run(u.id, u.username, u.display, u.salt, u.hash, u.created, u.admin ? 1 : 0);
}
function getCollectionOf(userId) {
  const row = _getCollection.get(userId);
  return row ? { collection: JSON.parse(row.data), updatedAt: row.updated_at } : { collection: {}, updatedAt: 0 };
}
function putCollectionOf(userId, collection, updatedAt) {
  _upsertCollection.run(userId, JSON.stringify(collection), updatedAt);
}

// ---------- binders ----------
const BINDER_SIZES = [2, 3, 4, 5];               // pockets per side
const BINDER_IMG_DIR = path.join(DATA_DIR, 'binder-images');   // user-uploaded slot art
const BINDER_COLORS = ['red', 'blue', 'green', 'purple', 'black'];
const _bindersOf = db.prepare('SELECT id, name, size, color, pages, slots, cover FROM binders WHERE user_id = ? ORDER BY created');
const _binderGet = db.prepare('SELECT * FROM binders WHERE user_id = ? AND id = ?');
const _binderPut = db.prepare(`INSERT INTO binders (user_id, id, name, size, color, pages, slots, cover, created, updated)
  VALUES (?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(user_id, id) DO UPDATE SET name=excluded.name, size=excluded.size, color=excluded.color,
    pages=excluded.pages, slots=excluded.slots, cover=excluded.cover, updated=excluded.updated`);
/** validate a binder cover choice: a set logo, a card's picture, or uploaded art */
function cleanBinderCover(c) {
  if (!c || typeof c !== 'object') return null;
  if (c.type === 'set' && typeof c.set === 'string' && SET_ID_RE.test(c.set)) {
    return { type: 'set', set: c.set, lang: LANG_RE.test(c.lang || '') ? c.lang : 'en' };
  }
  if (c.type === 'card' && typeof c.card === 'string' && CARD_ID_RE.test(c.card)) {
    const v = typeof c.variant === 'string' && VARIANT_KEY_RE.test(c.variant) ? c.variant : null;
    return v ? { type: 'card', card: c.card, variant: v } : { type: 'card', card: c.card };
  }
  if (c.type === 'art' && typeof c.img === 'string' && /^\/bimg\/[a-f0-9-]{36}\.webp$/.test(c.img)) {
    return { type: 'art', img: c.img };
  }
  return null;
}
const _binderDel = db.prepare('DELETE FROM binders WHERE user_id = ? AND id = ?');

/** First-run migration: import any pre-SQLite JSON accounts/collections. */
function migrateJsonToDb() {
  if (userCount() > 0) return;               // DB already populated
  const users = readJSON(USERS_FILE, null);
  if (!users || typeof users !== 'object') return;
  let migrated = 0;
  db.exec('BEGIN');
  try {
    for (const [key, u] of Object.entries(users)) {
      if (!u || !u.id) continue;
      _insertUser.run(u.id, key, u.display || key, u.salt || '', u.hash || '', u.created || new Date(0).toISOString(), u.admin ? 1 : 0);
      const coll = readJSON(path.join(COLLECTIONS_DIR, u.id + '.json'), null);
      if (coll && coll.collection) _upsertCollection.run(u.id, JSON.stringify(coll.collection), coll.updatedAt || 0);
      migrated++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('Account migration failed (leaving JSON files in place): ' + e.message);
    return;
  }
  if (migrated) {
    // keep the old files as a backup, but out of the way so we don't re-import
    try { fs.renameSync(USERS_FILE, USERS_FILE + '.migrated'); } catch { /* ignore */ }
    try { if (fs.existsSync(COLLECTIONS_DIR)) fs.renameSync(COLLECTIONS_DIR, COLLECTIONS_DIR + '.migrated'); } catch { /* ignore */ }
    console.log(`Migrated ${migrated} account(s) from JSON files into ${DB_FILE}`);
  }
}
migrateJsonToDb();

// ---------- auth ----------

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

/** Short fingerprint of a password hash, embedded in tokens so that changing
 * the password invalidates every existing session (as Uptime Kuma does). */
function pwFingerprint(hash) {
  return crypto.createHash('sha256').update(hash).digest('hex').slice(0, 16);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}

function issueToken(user) {
  return sign({ uid: user.id, pv: pwFingerprint(user.hash), exp: Date.now() + TOKEN_TTL_MS });
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.uid || !payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function authUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const user = getUserById(payload.uid);
  if (!user) return null;
  // token bound to the password hash: a password change logs out old sessions
  if (payload.pv && payload.pv !== pwFingerprint(user.hash)) return null;
  return user;
}

// ---------- rate limiting (in-memory, per IP) ----------

const hits = new Map();
function rateLimited(ip, key, max, windowMs) {
  const now = Date.now();
  const bucketKey = ip + ':' + key;
  let bucket = hits.get(bucketKey);
  if (!bucket || now - bucket.start > windowMs) {
    bucket = { start: now, count: 0 };
    hits.set(bucketKey, bucket);
  }
  bucket.count++;
  if (hits.size > 10000) hits.clear(); // crude memory cap
  return bucket.count > max;
}

// ---------- http helpers ----------

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', // token auth, no cookies — safe to open reads
  });
  res.end(body);
}

function readRawBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ---------- static files ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback: unknown non-file paths get the app shell
      if (!path.extname(rel)) {
        serveStatic(req, res, '/index.html');
      } else {
        res.writeHead(404); res.end('Not found');
      }
      return;
    }
    const ext = path.extname(file).toLowerCase();
    // The ENTIRE app shell must always revalidate: a stale HTTP-cached app.js
    // once kept showing an old UI for a day after an upgrade (the service
    // worker's "network-first" fetch still goes through the HTTP cache, so a
    // max-age here poisons even that path). Revalidation is cheap — 304s via
    // Last-Modified below.
    const isShell = ext === '.html' || file.endsWith('sw.js') || file.endsWith('config.js')
      || file.endsWith('app.js') || file.endsWith('styles.css') || file.endsWith('manifest.webmanifest');
    const inCdn = file.startsWith(path.join(PUBLIC_DIR, 'cdn'));
    const isCardImage = inCdn && file.includes(`${path.sep}images${path.sep}`);
    // card images never change → cache hard; cdn JSON (indexes/sets/custom)
    // DOES change (builds, admin uploads) → always revalidate
    const cacheControl = isShell ? 'no-cache'
      : isCardImage ? 'public, max-age=2592000, immutable'
      : inCdn ? 'no-cache'
      : 'public, max-age=86400';
    const lastModified = stat.mtime.toUTCString();
    const ims = req.headers['if-modified-since'];
    if (ims && !isNaN(Date.parse(ims)) && Date.parse(ims) >= Math.floor(stat.mtimeMs / 1000) * 1000) {
      res.writeHead(304, { 'Cache-Control': cacheControl, 'Last-Modified': lastModified });
      return res.end();
    }
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl,
      'Last-Modified': lastModified,
      'Content-Length': stat.size,
    };
    if (inCdn) headers['Access-Control-Allow-Origin'] = '*'; // card database is openly readable
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- card database builder (runs scripts/build-data.js on demand) ----------

const CDN_DIR = path.join(PUBLIC_DIR, 'cdn');
const PROGRESS_FILE = path.join(CDN_DIR, '.progress.json');
let build = { running: false, phase: null, startedAt: 0, error: null, hashesOk: null, log: [] };

function dbExists() {
  try {
    return fs.readdirSync(CDN_DIR, { withFileTypes: true })
      .some((d) => d.isDirectory() && fs.existsSync(path.join(CDN_DIR, d.name, 'index.json')));
  } catch { return false; }
}

/** The first registered account is the administrator. */
function isAdminUser(user) {
  if (user.admin === true) return true;
  if (_countAdmins.get().n > 0) return false;
  // accounts created before the admin flag existed: earliest registration wins
  const earliest = rowToUser(_earliestUser.get());
  return !!earliest && earliest.id === user.id;
}

function pushLog(line) {
  const text = String(line).trim();
  if (!text) return;
  build.log.push(text.slice(0, 200));
  if (build.log.length > 30) build.log.splice(0, build.log.length - 30);
}

function startBuild(opts = {}) {
  const args = [path.join(__dirname, 'scripts', 'build-data.js')];
  if (opts.langs) args.push('--langs', opts.langs);
  if (opts.quality) args.push('--quality', opts.quality);
  if (process.env.PTCG_SOURCE_API) args.push('--api', process.env.PTCG_SOURCE_API); // used by tests
  // e.g. PTCG_BUILD_EXTRA_ARGS="--no-images" when images live on an external CDN (config.imageBase)
  if (process.env.PTCG_BUILD_EXTRA_ARGS) args.push(...process.env.PTCG_BUILD_EXTRA_ARGS.split(/\s+/).filter(Boolean));
  build = { running: true, phase: 'data', startedAt: Date.now(), error: null, hashesOk: null, log: [] };
  const child = spawn(process.execPath, args, { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => d.toString().split('\n').forEach(pushLog));
  child.stderr.on('data', (d) => d.toString().split('\n').forEach(pushLog));
  child.on('error', (e) => { build.running = false; build.phase = null; build.error = 'Could not start downloader: ' + e.message; });
  child.on('exit', (code) => {
    if (code === 0) runHashes();
    else { build.running = false; build.phase = null; build.error = `Card downloader exited with code ${code}`; }
  });
}

/** After the data build: best-effort scanner index (needs the optional sharp package). */
function runHashes() {
  build.phase = 'hashes';
  const finish = (ok) => {
    // the freshly downloaded catalog (public/cdn) becomes the DB's card source
    try { importCatalogToDb(); } catch (e) { pushLog('Catalog import after build failed: ' + e.message); }
    build.running = false; build.phase = null; build.hashesOk = ok;
  };
  const runScript = () => {
    const child = spawn(process.execPath, [path.join(__dirname, 'scripts', 'build-hashes.js')], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => d.toString().split('\n').forEach(pushLog));
    child.stderr.on('data', (d) => d.toString().split('\n').forEach(pushLog));
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
  };
  try {
    require.resolve('sharp');
    runScript();
  } catch {
    const npm = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-save', 'sharp'], { cwd: __dirname, stdio: 'ignore' });
    npm.on('error', () => finish(false));
    npm.on('exit', (code) => (code === 0 ? runScript() : finish(false)));
  }
}

// ---------- offline mirror (copy a remote card database to this server) ----------
/* Self-hosted installs boot against the public CDN. The administrator can
 * download the whole database (data + images) locally, after which the app
 * pulls images from this server instead — no internet needed. Existing local
 * files are never overwritten, so admin-uploaded photos survive re-mirrors
 * and a re-run only fetches what's new. */

const loadSettings = () => readJSON(SETTINGS_FILE, {});
const saveSettings = (s) => writeJSONAtomic(SETTINGS_FILE, s);

function startMirror(remoteBase) {
  build = { running: true, phase: 'mirror', startedAt: Date.now(), error: null, hashesOk: null, log: [] };
  pushLog('Mirroring card database from ' + remoteBase);
  runMirror(remoteBase.replace(/\/+$/, ''))
    .then(() => {
      const s = loadSettings();
      s.imageSource = 'local';
      s.mirroredFrom = remoteBase;
      s.mirroredAt = new Date().toISOString();
      saveSettings(s);
      build.running = false; build.phase = null; build.hashesOk = true;
      pushLog('Local copy complete — images now served from this server');
    })
    .catch((e) => {
      build.running = false; build.phase = null;
      build.error = 'Mirror failed: ' + e.message + ' (safe to retry — it resumes where it stopped)';
    });
}

async function runMirror(base) {
  const progress = {
    startedAt: new Date().toISOString(), mirror: true,
    langIndex: 0, langCount: 1, lang: null, setsDone: 0, setTotal: 0, setName: null,
    cardsEstimate: 0, imagesDownloaded: 0, imagesSkipped: 0, imageFailures: 0,
    done: false, error: null,
  };
  const writeProgress = (extra = {}) => {
    Object.assign(progress, extra, { updatedAt: new Date().toISOString() });
    try { writeJSONAtomic(PROGRESS_FILE, progress); } catch { /* cosmetic */ }
  };
  const get = async (rel, asJson) => {
    const res = await fetch(base + '/' + rel);
    if (!res.ok) { const e = new Error(`HTTP ${res.status} for ${rel}`); e.status = res.status; throw e; }
    return asJson ? res.json() : Buffer.from(await res.arrayBuffer());
  };
  const save = (rel, buf) => {
    const f = path.join(CDN_DIR, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, buf);
  };
  const copyIfMissing = async (rel) => {
    if (fs.existsSync(path.join(CDN_DIR, rel))) { progress.imagesSkipped++; return; }
    try {
      save(rel, await get(rel, false));
      progress.imagesDownloaded++;
    } catch (e) {
      if (e.status !== 404) { progress.imageFailures++; pushLog('! ' + rel + ': ' + e.message); }
    }
  };

  // language list (single-language remotes may not publish languages.json)
  let langs = ['en'];
  try {
    const lj = await get('languages.json', true);
    save('languages.json', Buffer.from(JSON.stringify(lj)));
    const codes = (lj.languages || []).map((l) => l.code || l).filter(Boolean);
    if (codes.length) langs = codes;
  } catch { /* default en */ }

  // custom printings: remote first, local definitions win on conflict
  try {
    const remoteCustom = await get('custom.json', true);
    const localCustom = readJSON(CUSTOM_FILE, { cards: {} });
    const merged = { cards: {} };
    for (const [id, entry] of Object.entries(remoteCustom.cards || {})) {
      merged.cards[id] = { variants: { ...(entry.variants || {}) } };
    }
    for (const [id, entry] of Object.entries(localCustom.cards || {})) {
      merged.cards[id] = { variants: { ...((merged.cards[id] || {}).variants || {}), ...(entry.variants || {}) } };
    }
    writeJSONAtomic(CUSTOM_FILE, merged);
  } catch { /* remote has no custom printings */ }

  for (let li = 0; li < langs.length; li++) {
    const lang = langs[li];
    const index = await get(`${lang}/index.json`, true);
    save(`${lang}/index.json`, Buffer.from(JSON.stringify(index)));
    const qualities = Array.isArray(index.qualities) && index.qualities.length ? index.qualities : ['low'];
    writeProgress({ lang, langIndex: li, langCount: langs.length, setsDone: 0, setTotal: (index.sets || []).length });
    for (const f of ['search-index.json', 'scan-index.json']) {
      try { save(`${lang}/${f}`, await get(`${lang}/${f}`, false)); } catch { /* optional */ }
    }
    const sets = index.sets || [];
    for (let si = 0; si < sets.length; si++) {
      const brief = sets[si];
      writeProgress({ setName: brief.name });
      const raw = await get(`${lang}/sets/${brief.id}.json`, false);
      save(`${lang}/sets/${brief.id}.json`, raw);
      const set = JSON.parse(raw.toString('utf8'));
      if (brief.logo) await copyIfMissing(`${lang}/images/${set.id}/logo.png`);
      const files = [];
      for (const c of set.cards || []) {
        const num = localIdOfCard(c.id);
        if (c.image) for (const q of qualities) files.push(`${lang}/images/${set.id}/${num}/${q}.webp`);
        if (c.variantImages) {
          for (const [vk, qs] of Object.entries(c.variantImages)) {
            for (const q of qs) files.push(`${lang}/images/${set.id}/${num}/${vk}-${q}.webp`);
          }
        }
      }
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(8, files.length || 1) }, async () => {
        while (next < files.length) {
          const i = next++;
          await copyIfMissing(files[i]);
          if (i % 25 === 0) writeProgress();
        }
      }));
      mergeLocalVariantImages(path.join(CDN_DIR, lang, 'sets', set.id + '.json'), lang);
      writeProgress({ setsDone: si + 1 });
    }
  }
  writeProgress({ done: true, finishedAt: new Date().toISOString() });
}

/** Re-attach locally uploaded variant scans to a freshly mirrored set file, so
 * a re-mirror never loses photos the admin added on this install. */
function mergeLocalVariantImages(setFile, lang) {
  const set = readJSON(setFile, null);
  if (!set || !Array.isArray(set.cards)) return;
  let changed = false;
  for (const c of set.cards) {
    const dir = path.join(CDN_DIR, lang, 'images', set.id, localIdOfCard(c.id));
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    const vimgs = {};
    for (const f of entries) {
      const m = f.match(/^([a-zA-Z0-9_-]+)-(low|high)\.webp$/);
      if (m) (vimgs[m[1]] = vimgs[m[1]] || []).push(m[2]);
    }
    for (const k of Object.keys(vimgs)) {
      vimgs[k].sort();
      const cur = (c.variantImages && c.variantImages[k]) || [];
      if (JSON.stringify(cur) !== JSON.stringify(vimgs[k])) {
        c.variantImages = c.variantImages || {};
        c.variantImages[k] = vimgs[k];
        if (!c.image) c.image = `images/${set.id}/${localIdOfCard(c.id)}`;
        changed = true;
      }
    }
  }
  if (changed) writeJSONAtomic(setFile, set);
}

// ---------- custom printings & variant image library ----------

const CUSTOM_FILE = path.join(CDN_DIR, 'custom.json');       // master overlay (published to R2)
const CARD_ID_RE = /^[a-zA-Z0-9.-]{1,64}$/;
const SET_ID_RE = /^[a-zA-Z0-9.-]{1,40}$/;
const VARIANT_KEY_RE = /^[a-zA-Z0-9_-]{1,24}$/;
const LANG_RE = /^[a-z-]{2,7}$/;

function slugifyVariant(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

/* ---------- catalog editing ----------
 * Admins can create whole cards and sets, edit any card, and hide (tombstone)
 * cards. Edits write straight into the SQLite catalog with source='local':
 *   - on a normal install, source='local' rows are never touched by a master
 *     pull (no override) and never swept (no deletion), so local edits stick;
 *   - on the master workspace, the publisher normalizes every exported row to
 *     source='master', so the same edits propagate to every install. */

/** Sanitize a card patch/definition coming from the editor API. */
function sanitizeCardPatch(body) {
  const out = {};
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  if (body.name !== undefined) out.name = str(body.name, 80);
  if (body.rarity !== undefined) out.rarity = str(body.rarity, 40);
  if (body.category !== undefined) out.category = str(body.category, 20);
  if (body.localId !== undefined) out.localId = str(body.localId, 24);
  if (body.illustrator !== undefined) out.illustrator = str(body.illustrator, 60);
  if (body.hp !== undefined) { const h = parseInt(body.hp, 10); out.hp = (h >= 0 && h < 100000) ? h : null; }
  if (Array.isArray(body.types)) out.types = body.types.filter((t) => typeof t === 'string' && t.trim()).slice(0, 6).map((t) => t.trim().slice(0, 20));
  if (Array.isArray(body.dexId)) out.dexId = body.dexId.map((d) => parseInt(d, 10)).filter((d) => d > 0 && d < 100000).slice(0, 6);
  if (body.variants && typeof body.variants === 'object' && !Array.isArray(body.variants)) {
    out.variants = {};
    for (const [k, v] of Object.entries(body.variants)) if (VARIANT_KEY_RE.test(k)) out.variants[k] = !!v;
  }
  return out;
}

function setIdOfCard(cardId) {
  const i = cardId.lastIndexOf('-');
  return i > 0 ? cardId.slice(0, i) : cardId;
}
function localIdOfCard(cardId) {
  const i = cardId.lastIndexOf('-');
  return i > 0 ? cardId.slice(i + 1) : cardId;
}

// ---------- card catalog import (JSON catalog → SQLite) ----------
/* Loads the static JSON catalog (index.json + sets/*.json + custom.json) into
 * the sets/cards/printings tables. Image fields become full locations. When the
 * app's configured CDN is a remote URL (R2), images default to that URL; when
 * it's local ('cdn'), they point at this server's /cdn path. Re-import only
 * updates rows that are still 'master' — a self-hoster's 'local' edits and
 * tombstones are left untouched. */

// Master-source upserts. The trailing `hidden` parameter lets master
// tombstones (deletions) propagate on pull; the WHERE source='master' guard
// is the other half of the contract — rows this install edited locally
// (source='local') are NEVER touched by a master import/pull.
const _catSet = db.prepare(`INSERT INTO sets (lang,id,name,release_date,logo,official_count,position,source,hidden)
  VALUES (?,?,?,?,?,?,?, 'master', ?)
  ON CONFLICT(lang,id) DO UPDATE SET name=excluded.name, release_date=excluded.release_date,
    logo=excluded.logo, official_count=excluded.official_count, position=excluded.position,
    hidden=excluded.hidden WHERE sets.source='master'`);
const _catCard = db.prepare(`INSERT INTO cards (lang,id,set_id,local_id,name,rarity,category,dex_csv,types_csv,hp,illustrator,variants_csv,img_low,img_high,position,source,hidden)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'master', ?)
  ON CONFLICT(lang,id) DO UPDATE SET set_id=excluded.set_id, local_id=excluded.local_id, name=excluded.name,
    rarity=excluded.rarity, category=excluded.category, dex_csv=excluded.dex_csv, types_csv=excluded.types_csv,
    hp=excluded.hp, illustrator=excluded.illustrator, variants_csv=excluded.variants_csv,
    img_low=excluded.img_low, img_high=excluded.img_high, position=excluded.position,
    hidden=excluded.hidden WHERE cards.source='master'`);
const _catPrinting = db.prepare(`INSERT INTO printings (lang,card_id,variant,label,img_low,img_high,source)
  VALUES (?,?,?,?,?,?, 'master')
  ON CONFLICT(lang,card_id,variant) DO UPDATE SET label=excluded.label,
    img_low=excluded.img_low, img_high=excluded.img_high WHERE printings.source='master'`);
const _countCards = db.prepare('SELECT COUNT(*) AS n FROM cards');
const _countSets = db.prepare('SELECT COUNT(*) AS n FROM sets');
const _countPrintings = db.prepare('SELECT COUNT(*) AS n FROM printings');

/** Read the app's configured cdnBase from public/config.js (server-side). */
function configCdnBase() {
  // An explicit env override wins (handy for deployments and tests) — must be a
  // full http(s) URL to count as a *remote* database.
  const envBase = (process.env.PTCG_CDN_BASE || '').trim();
  if (/^https?:\/\//.test(envBase)) return envBase.replace(/\/+$/, '');
  try {
    // Anchored + multiline so it matches the real `cdnBase: '…'` property and
    // NOT the examples in the file's comments (` *   cdnBase: 'cdn'`) — the
    // unanchored version grabbed the comment first and silently disabled the
    // remote master on every install.
    const m = fs.readFileSync(path.join(PUBLIC_DIR, 'config.js'), 'utf8').match(/^\s*cdnBase:\s*['"]([^'"]+)['"]/m);
    return m && /^https?:\/\//.test(m[1]) ? m[1].replace(/\/+$/, '') : null;
  } catch { return null; }
}

// shared upsert helpers so local and remote imports build rows identically
function _upsertCatSet(lang, s, pos, imageBase) {
  const official = (s.cardCount && (s.cardCount.official || s.cardCount.total)) || null;
  _catSet.run(lang, s.id, s.name, s.releaseDate || null, s.logo ? `${imageBase}/${lang}/${s.logo}` : null, official, pos, 0);
}
function _upsertCatCard(lang, c, setId, ci, imageBase, hasHigh, custom) {
  const prefix = c.image ? `${imageBase}/${lang}/${c.image}` : null;
  const variantsCsv = c.variants
    ? (Object.entries(c.variants).filter(([, v]) => v).map(([k]) => k).join(',') || 'normal')
    : 'normal';
  _catCard.run(lang, c.id, setId, String(c.localId ?? localIdOfCard(c.id)), c.name || c.id,
    c.rarity || null, c.category || null, (c.dexId || []).join(',') || null, (c.types || []).join(',') || null,
    c.hp || null, c.illustrator || null, variantsCsv,
    prefix ? prefix + '/low.webp' : null, (prefix && hasHigh) ? prefix + '/high.webp' : null, ci, 0);
  const prints = {};
  const num = localIdOfCard(c.id);
  for (const [vk, qs] of Object.entries(c.variantImages || {})) {
    const b = `${imageBase}/${lang}/images/${setId}/${num}/${vk}`;
    prints[vk] = { label: null, img_low: qs.includes('low') ? b + '-low.webp' : null, img_high: qs.includes('high') ? b + '-high.webp' : null };
  }
  const cu = custom && custom.cards && custom.cards[c.id];
  const cuVars = cu && (cu.printings || cu.variants);
  if (cuVars) for (const [vk, label] of Object.entries(cuVars)) {
    prints[vk] = { label, img_low: (prints[vk] || {}).img_low || null, img_high: (prints[vk] || {}).img_high || null };
  }
  let n = 0;
  for (const [vk, p] of Object.entries(prints)) { _catPrinting.run(lang, c.id, vk, p.label, p.img_low, p.img_high); n++; }
  return n;
}

/** Import the catalog from the LOCAL public/cdn tree (a build on this server). */
function importCatalogToDb() {
  const imageBase = configCdnBase() || '/cdn';   // remote R2 URL, or this server's local path
  let langs = [];
  try {
    langs = fs.readdirSync(CDN_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(CDN_DIR, d.name, 'index.json')))
      .map((d) => d.name);
  } catch { /* no catalog present */ }
  if (!langs.length) return { sets: 0, cards: 0, printings: 0, empty: true };
  const custom = readJSON(CUSTOM_FILE, { cards: {} });
  let nSets = 0, nCards = 0, nPrint = 0;
  db.exec('BEGIN');
  try {
    for (const lang of langs) {
      const index = readJSON(path.join(CDN_DIR, lang, 'index.json'), { sets: [] });
      const hasHigh = (Array.isArray(index.qualities) ? index.qualities : ['low']).includes('high');
      (index.sets || []).forEach((s, pos) => {
        _upsertCatSet(lang, s, pos, imageBase); nSets++;
        const setData = readJSON(path.join(CDN_DIR, lang, 'sets', s.id + '.json'), null);
        if (!setData) return;
        (setData.cards || []).forEach((c, ci) => { nPrint += _upsertCatCard(lang, c, s.id, ci, imageBase, hasHigh, custom); nCards++; });
      });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { sets: nSets, cards: nCards, printings: nPrint };
}

/** Import the catalog from the REMOTE master database (catalog.db on the
 * bucket). The merge contract, in both directions:
 *   - master rows (source='master') here are made to MATCH the master:
 *     updated in place, hidden state included (master deletions propagate),
 *     and rows the master no longer has are removed — but only within the
 *     languages the master actually covers.
 *   - rows this install created or edited itself (source='local') are NEVER
 *     touched, so the master can't override local changes.
 * Records the master's version (meta table) in settings for update checks.
 * progressCb({ setsDone, setTotal, lang, setName }) drives the UI. */
async function importCatalogFromRemote(base, progressCb) {
  base = base.replace(/\/+$/, '');
  const { DatabaseSync } = require('node:sqlite');

  // 1) download the master catalog.db to a temp file next to our own DB
  const res = await fetch(base + '/catalog.db');
  if (!res.ok) { const e = new Error('HTTP ' + res.status + ' for catalog.db'); e.status = res.status; throw e; }
  const tmp = path.join(DATA_DIR, `.catalog-pull-${process.pid}.db`);
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));

  let src, nSets = 0, nCards = 0, nPrint = 0, version = null;
  try {
    src = new DatabaseSync(tmp);
    try { version = Number((src.prepare("SELECT value FROM meta WHERE key='version'").get() || {}).value) || null; } catch { /* pre-versioning master */ }

    // 2) upsert every master row (including hidden ones — tombstones travel)
    const sets = src.prepare('SELECT lang,id,name,release_date,logo,official_count,position,hidden FROM sets ORDER BY position').all();
    const setTotal = sets.length;
    const cardsOf = src.prepare('SELECT lang,id,set_id,local_id,name,rarity,category,dex_csv,types_csv,hp,illustrator,variants_csv,img_low,img_high,position,hidden FROM cards WHERE lang=? AND set_id=?');
    const masterLangs = new Set(), seenSets = new Set(), seenCards = new Set(), seenPrints = new Set();
    for (const s of sets) {
      masterLangs.add(s.lang);
      seenSets.add(s.lang + '\n' + s.id);
      db.exec('BEGIN');
      try {
        _catSet.run(s.lang, s.id, s.name, s.release_date, s.logo, s.official_count, s.position, s.hidden ? 1 : 0);
        for (const c of cardsOf.all(s.lang, s.id)) {
          _catCard.run(c.lang, c.id, c.set_id, c.local_id, c.name, c.rarity, c.category, c.dex_csv, c.types_csv,
            c.hp, c.illustrator, c.variants_csv, c.img_low, c.img_high, c.position, c.hidden ? 1 : 0);
          seenCards.add(c.lang + '\n' + c.id);
          nCards++;
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      nSets++;
      if (progressCb) progressCb({ setsDone: nSets, setTotal, lang: s.lang, setName: s.name });
    }
    // custom printings (labels / per-printing image overrides)
    db.exec('BEGIN');
    try {
      for (const p of src.prepare('SELECT lang,card_id,variant,label,img_low,img_high FROM printings').all()) {
        _catPrinting.run(p.lang, p.card_id, p.variant, p.label, p.img_low, p.img_high);
        seenPrints.add(p.lang + '\n' + p.card_id + '\n' + p.variant);
        nPrint++;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    // 3) deletion sweep: master-source rows the master no longer has are
    //    removed — restricted to the master's own languages so a locally
    //    built extra language is left alone. Local-source rows never sweep.
    db.exec('BEGIN');
    try {
      for (const lang of masterLangs) {
        for (const r of db.prepare("SELECT id FROM sets WHERE lang=? AND source='master'").all(lang))
          if (!seenSets.has(lang + '\n' + r.id)) db.prepare("DELETE FROM sets WHERE lang=? AND id=? AND source='master'").run(lang, r.id);
        for (const r of db.prepare("SELECT id FROM cards WHERE lang=? AND source='master'").all(lang))
          if (!seenCards.has(lang + '\n' + r.id)) db.prepare("DELETE FROM cards WHERE lang=? AND id=? AND source='master'").run(lang, r.id);
        for (const r of db.prepare("SELECT card_id, variant FROM printings WHERE lang=? AND source='master'").all(lang))
          if (!seenPrints.has(lang + '\n' + r.card_id + '\n' + r.variant))
            db.prepare("DELETE FROM printings WHERE lang=? AND card_id=? AND variant=? AND source='master'").run(lang, r.card_id, r.variant);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    // 4) remember which master version this install now mirrors
    const st = loadSettings();
    st.masterVersion = version || st.masterVersion || 1;
    st.masterPulledAt = new Date().toISOString();
    saveSettings(st);
  } finally {
    if (src) { try { src.close(); } catch { /* already closed */ } }
    try { fs.rmSync(tmp, { force: true }); } catch { /* temp */ }
  }
  return { sets: nSets, cards: nCards, printings: nPrint, version };
}

/** Background job: pull the catalog from a remote database into this DB. */
function startCatalogPull(base) {
  build = { running: true, phase: 'import', startedAt: Date.now(), error: null, hashesOk: null, log: [] };
  pushLog('Loading the card database from ' + base);
  const progress = { startedAt: new Date().toISOString(), catalogPull: true, setsDone: 0, setTotal: 0, setName: null, done: false, error: null };
  const write = (extra) => { Object.assign(progress, extra); try { writeJSONAtomic(PROGRESS_FILE, progress); } catch { /* cosmetic */ } };
  write({});
  importCatalogFromRemote(base, (p) => write(p))
    .then((r) => { write({ done: true, finishedAt: new Date().toISOString() }); build.running = false; build.phase = null; build.hashesOk = true; pushLog(`Card database loaded: ${r.cards} cards, ${r.sets} sets`); })
    .catch((e) => { build.running = false; build.phase = null; build.error = 'Loading the card database failed: ' + e.message + ' (safe to retry)'; write({ error: e.message }); });
}

const catalogStats = () => ({
  cards: _countCards.get().n, sets: _countSets.get().n, printings: _countPrintings.get().n,
});

// ---------- catalog served from the DB (the app reads cards from here) ----------
const LANG_NAMES = {
  en: 'English', fr: 'Français', de: 'Deutsch', es: 'Español', it: 'Italiano',
  'pt-br': 'Português (BR)', ja: '日本語', ko: '한국어', 'zh-tw': '中文 (繁體)',
  nl: 'Nederlands', pl: 'Polski', ru: 'Русский',
};
const _langsDistinct = db.prepare('SELECT DISTINCT lang FROM sets ORDER BY lang');
const _setsIndex = db.prepare('SELECT id, name, release_date, logo, official_count FROM sets WHERE lang = ? AND hidden = 0 ORDER BY position, id');
const _setCount = db.prepare('SELECT COUNT(*) AS n FROM cards WHERE lang = ? AND set_id = ? AND hidden = 0');
const _oneSet = db.prepare('SELECT id, name, release_date, official_count FROM sets WHERE lang = ? AND id = ? AND hidden = 0');
const _cardsOfSet = db.prepare('SELECT * FROM cards WHERE lang = ? AND set_id = ? AND hidden = 0 ORDER BY position, local_id');
const _cardsOfLang = db.prepare('SELECT id, set_id, local_id, name, rarity, category, dex_csv, types_csv, variants_csv, img_low, img_high FROM cards WHERE lang = ? AND hidden = 0 ORDER BY position');
const _printsOfCard = db.prepare('SELECT variant, label, img_low, img_high FROM printings WHERE lang = ? AND card_id = ?');
const _printsOfLang = db.prepare('SELECT card_id, variant, label, img_low, img_high FROM printings WHERE lang = ?');

const langsAvailable = () => { const r = _langsDistinct.all().map((x) => x.lang); return r.length ? r : ['en']; };
const emitLanguages = () => ({ languages: langsAvailable().map((code) => ({ code, name: LANG_NAMES[code] || code })) });

function printingMaps(rows) {
  const printings = {}, variantImages = {};
  for (const p of rows || []) {
    if (p.label) printings[p.variant] = p.label;
    if (p.img_low || p.img_high) variantImages[p.variant] = { low: p.img_low || null, high: p.img_high || null };
  }
  return { printings, variantImages };
}
function cardObj(c, maps, lean) {
  const variants = {};
  (c.variants_csv ? c.variants_csv.split(',') : ['normal']).forEach((v) => { if (v) variants[v] = true; });
  const o = {
    id: c.id, localId: c.local_id, name: c.name,
    rarity: c.rarity || undefined, category: c.category || undefined,
    dexId: c.dex_csv ? c.dex_csv.split(',').map(Number) : undefined,
    types: c.types_csv ? c.types_csv.split(',') : undefined,
    variants,
    img: (c.img_low || c.img_high) ? { low: c.img_low || null, high: c.img_high || null } : null,
  };
  if (!lean) { o.hp = c.hp || undefined; o.illustrator = c.illustrator || undefined; }
  if (Object.keys(maps.printings).length) o.printings = maps.printings;
  if (Object.keys(maps.variantImages).length) o.variantImages = maps.variantImages;
  return o;
}
function emitIndex(lang) {
  const sets = _setsIndex.all(lang).map((s) => {
    const n = _setCount.get(lang, s.id).n;
    const official = s.official_count || n;   // printed set size (completion denominator)
    return { id: s.id, name: s.name, releaseDate: s.release_date || undefined, logo: s.logo || null, cardCount: { total: Math.max(n, official), official } };
  });
  return { language: lang, sets };
}
function emitSet(lang, id) {
  const s = _oneSet.get(lang, id);
  if (!s) return null;
  const cards = _cardsOfSet.all(lang, id).map((c) => cardObj(c, printingMaps(_printsOfCard.all(lang, c.id)), false));
  const official = s.official_count || cards.length;
  return { id: s.id, name: s.name, releaseDate: s.release_date || undefined, cardCount: { total: Math.max(cards.length, official), official }, cards };
}
function emitSearch(lang) {
  const byCard = {};
  for (const p of _printsOfLang.all(lang)) (byCard[p.card_id] = byCard[p.card_id] || []).push(p);
  const cards = _cardsOfLang.all(lang).map((c) => cardObj(c, printingMaps(byCard[c.id]), true));
  return { cards };
}

// ---------- catalog editing (admin) + image localisation ----------
const _cardExists = db.prepare('SELECT 1 FROM cards WHERE lang = ? AND id = ?');
const _cardRow = db.prepare('SELECT * FROM cards WHERE lang = ? AND id = ?');
const _setRow = db.prepare('SELECT * FROM sets WHERE lang = ? AND id = ?');
const _maxCardPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM cards WHERE lang = ? AND set_id = ?');
const _maxSetPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM sets WHERE lang = ?');
const _localCardPut = db.prepare(`INSERT INTO cards (lang,id,set_id,local_id,name,rarity,category,dex_csv,types_csv,hp,illustrator,variants_csv,img_low,img_high,position,source,hidden)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'local', ?)
  ON CONFLICT(lang,id) DO UPDATE SET set_id=excluded.set_id, local_id=excluded.local_id, name=excluded.name,
    rarity=excluded.rarity, category=excluded.category, dex_csv=excluded.dex_csv, types_csv=excluded.types_csv,
    hp=excluded.hp, illustrator=excluded.illustrator, variants_csv=excluded.variants_csv,
    img_low=excluded.img_low, img_high=excluded.img_high, position=excluded.position, source='local', hidden=excluded.hidden`);
const _localSetPut = db.prepare(`INSERT INTO sets (lang,id,name,release_date,logo,official_count,position,source,hidden)
  VALUES (?,?,?,?,NULL,?,?, 'local', 0)`);
const _cardHide = db.prepare("UPDATE cards SET hidden = ?, source = 'local' WHERE lang = ? AND id = ?");
const _hiddenOfSet = db.prepare('SELECT id, local_id, name FROM cards WHERE lang = ? AND set_id = ? AND hidden = 1 ORDER BY position, local_id');
const _setCardBaseImg = db.prepare("UPDATE cards SET img_low = ?, img_high = ?, source = 'local' WHERE lang = ? AND id = ?");
const _localPrintingLabel = db.prepare(`INSERT INTO printings (lang, card_id, variant, label, source) VALUES (?,?,?,?, 'local')
  ON CONFLICT(lang, card_id, variant) DO UPDATE SET label = excluded.label, source = 'local'`);
const _localPrintingImg = db.prepare(`INSERT INTO printings (lang, card_id, variant, img_low, img_high, source) VALUES (?,?,?,?,?, 'local')
  ON CONFLICT(lang, card_id, variant) DO UPDATE SET img_low = excluded.img_low, img_high = excluded.img_high, source = 'local'`);
const _imgRemote = db.prepare("SELECT COUNT(*) AS n FROM cards WHERE hidden = 0 AND img_low LIKE 'http%'");
const _imgLocal = db.prepare("SELECT COUNT(*) AS n FROM cards WHERE hidden = 0 AND img_low IS NOT NULL AND img_low NOT LIKE 'http%'");
const imageCounts = () => ({ remote: _imgRemote.get().n, local: _imgLocal.get().n });

// rows whose images are remote URLs, for the "download all images" job
const _remoteImgCards = db.prepare("SELECT lang, id, set_id, local_id, img_low, img_high FROM cards WHERE img_low LIKE 'http%' OR img_high LIKE 'http%'");
const _remoteImgPrints = db.prepare("SELECT lang, card_id, variant, img_low, img_high FROM printings WHERE img_low LIKE 'http%' OR img_high LIKE 'http%'");
const _setCardImg = db.prepare('UPDATE cards SET img_low = ?, img_high = ? WHERE lang = ? AND id = ?');
const _setPrintImg = db.prepare('UPDATE printings SET img_low = ?, img_high = ? WHERE lang = ? AND card_id = ? AND variant = ?');

/** Download all remote (http) card images to this server and repoint each row
 * to its local /cdn path, so the install works fully offline. */
async function runImageDownload() {
  const progress = {
    startedAt: new Date().toISOString(), imagesLocalize: true,
    setsDone: 0, setTotal: 0, imagesDownloaded: 0, imagesSkipped: 0, imageFailures: 0, done: false, error: null,
  };
  const write = (extra) => { Object.assign(progress, extra); try { writeJSONAtomic(PROGRESS_FILE, progress); } catch { /* cosmetic */ } };
  const cards = _remoteImgCards.all();
  const prints = _remoteImgPrints.all();
  write({ setTotal: cards.length + prints.length });
  let done = 0;
  const fetchTo = async (urlRemote, destRel) => {
    const dest = path.join(CDN_DIR, destRel);
    if (fs.existsSync(dest)) { progress.imagesSkipped++; return '/cdn/' + destRel.split(path.sep).join('/'); }
    const res = await fetch(urlRemote);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    progress.imagesDownloaded++;
    return '/cdn/' + destRel.split(path.sep).join('/');
  };
  const localOrKeep = async (urlRemote, destRel) => {
    if (!urlRemote || !/^https?:\/\//i.test(urlRemote)) return urlRemote;
    try { return await fetchTo(urlRemote, destRel); }
    catch (e) { progress.imageFailures++; pushLog('! image ' + destRel + ': ' + e.message); return urlRemote; }
  };
  for (const c of cards) {
    const dir = path.join(c.lang, 'images', c.set_id, c.local_id);
    const low = await localOrKeep(c.img_low, path.join(dir, 'low.webp'));
    const high = await localOrKeep(c.img_high, path.join(dir, 'high.webp'));
    _setCardImg.run(low, high, c.lang, c.id);
    if (++done % 25 === 0) write({ setsDone: done });
  }
  for (const p of prints) {
    const dir = path.join(p.lang, 'images', setIdOfCard(p.card_id), localIdOfCard(p.card_id));
    const low = await localOrKeep(p.img_low, path.join(dir, `${p.variant}-low.webp`));
    const high = await localOrKeep(p.img_high, path.join(dir, `${p.variant}-high.webp`));
    _setPrintImg.run(low, high, p.lang, p.card_id, p.variant);
    if (++done % 25 === 0) write({ setsDone: done });
  }
  write({ setsDone: cards.length + prints.length, done: true, finishedAt: new Date().toISOString() });
}
function startImageDownload() {
  build = { running: true, phase: 'images', startedAt: Date.now(), error: null, hashesOk: null, log: [] };
  pushLog('Downloading remote card images to this server');
  runImageDownload()
    .then(() => { build.running = false; build.phase = null; build.hashesOk = true; pushLog('Image download complete — images now served locally'); })
    .catch((e) => { build.running = false; build.phase = null; build.error = 'Image download failed: ' + e.message + ' (safe to retry)'; });
}

/** Every printing that has its own image, from the database, for the API. */
const _printsWithImg = db.prepare(`SELECT p.card_id, p.variant, p.img_low, p.img_high, c.name
  FROM printings p JOIN cards c ON c.lang = p.lang AND c.id = p.card_id
  WHERE p.lang = ? AND (p.img_low IS NOT NULL OR p.img_high IS NOT NULL)`);
function variantImageManifest(lang) {
  return _printsWithImg.all(lang).map((r) => {
    const urls = {};
    if (r.img_low) urls.low = r.img_low;
    if (r.img_high) urls.high = r.img_high;
    return { card: r.card_id, name: r.name, set: setIdOfCard(r.card_id), variant: r.variant, qualities: Object.keys(urls), urls };
  });
}

// ---------- api routes ----------

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;

async function handleApi(req, res, pathname, ip, url) {
  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJSON(res, 200, { ok: true, auth: true, version: 2, readonly: READONLY });
  }

  // where should the app load card data/images from? (offline mirror support)
  if (pathname === '/api/app-config' && req.method === 'GET') {
    const s = loadSettings();
    return sendJSON(res, 200, {
      readonly: READONLY,
      imageSource: s.imageSource === 'local' ? 'local' : 'remote',
      localDbExists: dbExists(),
      mirroredAt: s.mirroredAt || null,
      images: imageCounts(),
      catalogCards: catalogStats().cards,
      remoteCatalog: configCdnBase() || null,
      masterVersion: s.masterVersion || null,
      masterPulledAt: s.masterPulledAt || null,
      master: MASTER_MODE,
      release: RELEASE_VERSION,
      canPublish: !READONLY && !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET),
    });
  }

  // hidden (tombstoned) cards of a set — lets the admin see and restore them
  if (pathname === '/api/hidden-cards' && req.method === 'GET') {
    const hUser = authUser(req);
    if (!hUser || !isAdminUser(hUser)) return sendJSON(res, 403, { error: 'Administrator account required' });
    const qLang = LANG_RE.test(url.searchParams.get('lang') || '') ? url.searchParams.get('lang') : 'en';
    const setId = url.searchParams.get('set') || '';
    if (!SET_ID_RE.test(setId)) return sendJSON(res, 400, { error: 'A valid set id is required' });
    return sendJSON(res, 200, { cards: _hiddenOfSet.all(qLang, setId).map((c) => ({ id: c.id, localId: c.local_id, name: c.name })) });
  }

  // how many cards/sets/printings are in the database catalog
  if (pathname === '/api/catalog/stats' && req.method === 'GET') {
    return sendJSON(res, 200, catalogStats());
  }

  // ---- catalog read API: the app loads card data from these (from the DB) ----
  if (pathname === '/api/catalog/languages' && req.method === 'GET') {
    return sendJSON(res, 200, emitLanguages());
  }
  if (pathname === '/api/catalog/index' && req.method === 'GET') {
    const lang = LANG_RE.test(url.searchParams.get('lang') || '') ? url.searchParams.get('lang') : 'en';
    return sendJSON(res, 200, emitIndex(lang));
  }
  if (pathname === '/api/catalog/set' && req.method === 'GET') {
    const lang = LANG_RE.test(url.searchParams.get('lang') || '') ? url.searchParams.get('lang') : 'en';
    const id = url.searchParams.get('id') || '';
    if (!SET_ID_RE.test(id)) return sendJSON(res, 400, { error: 'A valid set id is required' });
    const set = emitSet(lang, id);
    if (!set) return sendJSON(res, 404, { error: 'Set not found' });
    return sendJSON(res, 200, set);
  }
  if (pathname === '/api/catalog/search' && req.method === 'GET') {
    const lang = LANG_RE.test(url.searchParams.get('lang') || '') ? url.searchParams.get('lang') : 'en';
    return sendJSON(res, 200, emitSearch(lang));
  }
  if (pathname === '/api/catalog/scan-index' && req.method === 'GET') {
    const lang = LANG_RE.test(url.searchParams.get('lang') || '') ? url.searchParams.get('lang') : 'en';
    const localFile = path.join(CDN_DIR, lang, 'scan-index.json');
    if (fs.existsSync(localFile)) return sendJSON(res, 200, readJSON(localFile, { cards: [] }));
    // No local scanner index (this install pulled the master rather than
    // building locally) — fetch the published one from the bucket and cache
    // it to disk so the scanner works on pulled-only installs too.
    const base = configCdnBase();
    if (base) {
      try {
        const r = await fetch(`${base}/${lang}/scan-index.json`);
        if (r.ok) {
          const data = await r.json();
          try { fs.mkdirSync(path.dirname(localFile), { recursive: true }); writeJSONAtomic(localFile, data); } catch { /* cache is best-effort */ }
          return sendJSON(res, 200, data);
        }
      } catch { /* fall through to empty */ }
    }
    return sendJSON(res, 200, { cards: [] });
  }

  // does the master have a newer database than this install? (cheap ping of
  // catalog.json — no card data moves until the admin actually updates)
  if (pathname === '/api/catalog/update-check' && req.method === 'GET') {
    const base = configCdnBase();
    if (!base) return sendJSON(res, 200, { configured: false });
    const s = loadSettings();
    const local = s.masterVersion || 0;
    try {
      const r = await fetch(base + '/catalog.json');
      if (!r.ok) return sendJSON(res, 200, { configured: true, reachable: false, localVersion: local });
      const m = await r.json();
      const remote = Number(m.version) || 0;
      return sendJSON(res, 200, {
        configured: true, reachable: true,
        localVersion: local, remoteVersion: remote,
        behind: remote > local,
        remoteCards: m.cards || null, remoteSets: m.sets || null,
      });
    } catch {
      return sendJSON(res, 200, { configured: true, reachable: false, localVersion: local });
    }
  }

  // admin: download all remote card images to this server, repointing rows local
  if (pathname === '/api/catalog/download-images' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    const admin = authUser(req);
    if (!admin || !isAdminUser(admin)) return sendJSON(res, 403, { error: 'Administrator account required' });
    if (build.running) return sendJSON(res, 409, { error: 'Another job is already running' });
    if (imageCounts().remote === 0) return sendJSON(res, 200, { ok: true, started: false, message: 'All images are already local' });
    startImageDownload();
    return sendJSON(res, 200, { ok: true, started: true });
  }

  // admin: (re)load the static JSON catalog into the database
  if (pathname === '/api/catalog/import' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    const admin = authUser(req);
    if (!admin || !isAdminUser(admin)) return sendJSON(res, 403, { error: 'Administrator account required' });
    try {
      const r = importCatalogToDb();
      return sendJSON(res, 200, { ok: true, ...r });
    } catch (e) {
      return sendJSON(res, 500, { error: 'Import failed: ' + e.message });
    }
  }

  // admin: pull the catalog from the remote published database (R2) into this DB.
  // Used when there is no local JSON build to import from (the common case for a
  // fresh self-hosted install that reads from a shared CDN).
  if (pathname === '/api/catalog/pull' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    const admin = authUser(req);
    if (!admin || !isAdminUser(admin)) return sendJSON(res, 403, { error: 'Administrator account required' });
    if (build.running) return sendJSON(res, 409, { error: 'Another job is already running' });
    const base = configCdnBase();
    if (!base) return sendJSON(res, 400, { error: 'No remote database is configured (set cdnBase in public/config.js)' });
    startCatalogPull(base);
    return sendJSON(res, 200, { ok: true, started: true, source: base });
  }

  if (pathname === '/api/build-status' && req.method === 'GET') {
    return sendJSON(res, 200, {
      running: build.running,
      phase: build.phase,
      error: build.error,
      hashesOk: build.hashesOk,
      dbExists: dbExists(),
      progress: readJSON(PROGRESS_FILE, null),
      log: build.log.slice(-5),
    });
  }

  if (pathname === '/api/build-data' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    if (build.running) return sendJSON(res, 409, { error: 'A download is already running' });
    const body = await readBody(req);
    const langs = typeof body.langs === 'string' && /^[a-z-]{2,7}(,[a-z-]{2,7})*$/.test(body.langs) ? body.langs : '';
    const quality = ['low', 'high', 'both'].includes(body.quality) ? body.quality : '';
    if (dbExists()) {
      // database already present → only the administrator may re-run/update it
      const admin = authUser(req);
      if (!admin || !isAdminUser(admin)) {
        return sendJSON(res, 403, { error: 'Administrator account required to update the card database' });
      }
    }
    startBuild({ langs, quality });
    return sendJSON(res, 200, { ok: true, started: true });
  }

  // public, CORS-open image API: every user-added variant image with URLs
  if (pathname === '/api/variant-images' && req.method === 'GET') {
    const lang = LANG_RE.test(url.searchParams.get('lang') || '') ? url.searchParams.get('lang') : 'en';
    return sendJSON(res, 200, { lang, images: variantImageManifest(lang) });
  }

  if (pathname === '/api/register' && req.method === 'POST') {
    if (rateLimited(ip, 'auth', 20, 10 * 60 * 1000)) return sendJSON(res, 429, { error: 'Too many attempts, try again later' });
    const { username, password } = await readBody(req);
    if (!USERNAME_RE.test(username || '')) return sendJSON(res, 400, { error: 'Username must be 3-30 letters, numbers or underscores' });
    if (typeof password !== 'string' || password.length < 8) return sendJSON(res, 400, { error: 'Password must be at least 8 characters' });
    const key = username.toLowerCase();
    if (getUserByName(key)) return sendJSON(res, 409, { error: 'Username already taken' });
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: crypto.randomUUID(),
      username: key,
      display: username,
      salt,
      hash: hashPassword(password, salt),
      created: new Date().toISOString(),
      admin: userCount() === 0, // first account = administrator
    };
    try {
      createUser(user);
    } catch {
      return sendJSON(res, 409, { error: 'Username already taken' }); // UNIQUE race
    }
    return sendJSON(res, 200, { token: issueToken(user), username: user.display });
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    if (rateLimited(ip, 'auth', 20, 10 * 60 * 1000)) return sendJSON(res, 429, { error: 'Too many attempts, try again later' });
    const { username, password } = await readBody(req);
    const user = getUserByName((username || '').toLowerCase());
    const bad = () => sendJSON(res, 401, { error: 'Invalid username or password' });
    if (!user || typeof password !== 'string') return bad();
    const hash = hashPassword(password, user.salt);
    const a = Buffer.from(hash), b = Buffer.from(user.hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return bad();
    return sendJSON(res, 200, { token: issueToken(user), username: user.display });
  }

  // authenticated routes
  const user = authUser(req);
  if (!user) return sendJSON(res, 401, { error: 'Not signed in' });

  if (pathname === '/api/me' && req.method === 'GET') {
    return sendJSON(res, 200, { username: user.display, admin: isAdminUser(user) });
  }

  // ---- change password (invalidates all other sessions via the hash-bound token) ----
  if (pathname === '/api/change-password' && req.method === 'POST') {
    const body = await readBody(req);
    const bad = () => sendJSON(res, 401, { error: 'Current password is incorrect' });
    if (typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string') {
      return sendJSON(res, 400, { error: 'currentPassword and newPassword are required' });
    }
    if (body.newPassword.length < 8) return sendJSON(res, 400, { error: 'New password must be at least 8 characters' });
    const cur = hashPassword(body.currentPassword, user.salt);
    const a = Buffer.from(cur), b = Buffer.from(user.hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return bad();
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(body.newPassword, salt);
    _updateUserHash.run(salt, hash, user.id);
    // fresh token for THIS session; every previously-issued token no longer
    // matches the new hash fingerprint and is now dead
    return sendJSON(res, 200, { ok: true, token: issueToken({ id: user.id, hash }) });
  }

  // ---- admin: mirror a remote card database onto this server (offline use) ----
  if (pathname === '/api/mirror' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    if (!isAdminUser(user)) return sendJSON(res, 403, { error: 'Administrator account required' });
    if (build.running) return sendJSON(res, 409, { error: 'A download is already running' });
    const body = await readBody(req);
    const remote = typeof body.remote === 'string' && /^https?:\/\/[^\s]{4,300}$/i.test(body.remote) ? body.remote : null;
    if (!remote) return sendJSON(res, 400, { error: 'remote must be the card database URL (https://…)' });
    startMirror(remote);
    return sendJSON(res, 200, { ok: true, started: true });
  }

  // ---- admin: choose where the app pulls images/data from ----
  if (pathname === '/api/image-source' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    if (!isAdminUser(user)) return sendJSON(res, 403, { error: 'Administrator account required' });
    const body = await readBody(req);
    if (!['local', 'remote'].includes(body.source)) return sendJSON(res, 400, { error: 'source must be "local" or "remote"' });
    if (body.source === 'local' && !dbExists()) return sendJSON(res, 400, { error: 'No local copy exists yet — download the database first' });
    const s = loadSettings();
    s.imageSource = body.source;
    saveSettings(s);
    return sendJSON(res, 200, { ok: true, imageSource: body.source });
  }

  // ---- admin: define a custom printing (e.g. "Cracked Ice Holo") for a card ----
  if (pathname === '/api/custom-variant' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    if (!isAdminUser(user)) return sendJSON(res, 403, { error: 'Administrator account required' });
    const body = await readBody(req);
    const cardId = typeof body.cardId === 'string' && CARD_ID_RE.test(body.cardId) ? body.cardId : null;
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 40) : '';
    if (!cardId || label.length < 2) return sendJSON(res, 400, { error: 'cardId and a printing name (2+ characters) are required' });
    const key = slugifyVariant(label);
    if (!VARIANT_KEY_RE.test(key)) return sendJSON(res, 400, { error: 'That name produces an invalid key' });
    const lang = LANG_RE.test(body.lang || '') ? body.lang : 'en';
    _localPrintingLabel.run(lang, cardId, key, label);
    return sendJSON(res, 200, { ok: true, cardId, key, label });
  }

  // ---- admin: create a whole new card, or edit any card's details ----
  if (pathname === '/api/card' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    if (!isAdminUser(user)) return sendJSON(res, 403, { error: 'Administrator account required' });
    const body = await readBody(req);
    const cLang = LANG_RE.test(body.lang || '') ? body.lang : 'en';
    const patch = sanitizeCardPatch(body);
    const csvOf = (arr) => (arr && arr.length ? arr.join(',') : null);
    const varsCsv = (v) => { const ks = v ? Object.keys(v).filter((k) => v[k]) : []; return ks.length ? ks.join(',') : 'normal'; };
    if (body.new) {
      const setId = typeof body.set === 'string' && SET_ID_RE.test(body.set) ? body.set : null;
      if (!setId) return sendJSON(res, 400, { error: 'New cards need a set id' });
      if (!_setRow.get(cLang, setId)) return sendJSON(res, 404, { error: `Set ${setId} not found in the ${cLang} database` });
      const localId = (patch.localId || '').trim().replace(/\s+/g, '');
      if (!localId) return sendJSON(res, 400, { error: 'New cards need a card number' });
      if (!patch.name || !patch.name.trim()) return sendJSON(res, 400, { error: 'New cards need a name' });
      const cardId = `${setId}-${localId}`;
      if (!CARD_ID_RE.test(cardId)) return sendJSON(res, 400, { error: 'That card number produces an invalid id — letters, numbers, dots and dashes only' });
      if (_cardRow.get(cLang, cardId)) return sendJSON(res, 409, { error: `${cardId} already exists — open that card and edit it instead` });
      _localCardPut.run(cLang, cardId, setId, localId, patch.name.trim(), patch.rarity || null, patch.category || null,
        csvOf(patch.dexId), csvOf(patch.types), patch.hp ?? null, patch.illustrator || null,
        varsCsv(patch.variants), null, null, _maxCardPos.get(cLang, setId).p + 1, 0);
      return sendJSON(res, 200, { ok: true, cardId, created: true });
    }
    // edit an existing card — the edited row becomes source='local', which
    // protects it from master pulls (and, on the workspace, publishes as-is)
    const cardId = typeof body.cardId === 'string' && CARD_ID_RE.test(body.cardId) ? body.cardId : null;
    if (!cardId) return sendJSON(res, 400, { error: 'A valid cardId is required' });
    const row = _cardRow.get(cLang, cardId);
    if (!row) return sendJSON(res, 404, { error: `Card ${cardId} not found in the ${cLang} database` });
    const pick = (v, cur) => (v !== undefined ? v : cur);
    const name = (patch.name !== undefined ? patch.name.trim() : row.name) || row.name;
    _localCardPut.run(cLang, cardId, row.set_id, pick(patch.localId, row.local_id) || row.local_id, name,
      pick(patch.rarity, row.rarity) || null, pick(patch.category, row.category) || null,
      patch.dexId !== undefined ? csvOf(patch.dexId) : row.dex_csv,
      patch.types !== undefined ? csvOf(patch.types) : row.types_csv,
      patch.hp !== undefined ? patch.hp : row.hp, pick(patch.illustrator, row.illustrator) || null,
      patch.variants !== undefined ? varsCsv(patch.variants) : (row.variants_csv || 'normal'),
      row.img_low, row.img_high, row.position, row.hidden);
    return sendJSON(res, 200, { ok: true, cardId });
  }

  // ---- admin: create a brand-new set (for promos and the like) ----
  if (pathname === '/api/set-create' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    if (!isAdminUser(user)) return sendJSON(res, 403, { error: 'Administrator account required' });
    const body = await readBody(req);
    const cLang = LANG_RE.test(body.lang || '') ? body.lang : 'en';
    const setId = typeof body.id === 'string' && SET_ID_RE.test(body.id) ? body.id : null;
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    if (!setId || name.length < 2) return sendJSON(res, 400, { error: 'A valid set id and name (2+ characters) are required' });
    if (_setRow.get(cLang, setId)) return sendJSON(res, 409, { error: `Set ${setId} already exists` });
    const releaseDate = typeof body.releaseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.releaseDate) ? body.releaseDate : null;
    const official = Number.isInteger(body.officialCount) && body.officialCount > 0 ? Math.min(body.officialCount, 10000) : null;
    _localSetPut.run(cLang, setId, name, releaseDate, official, _maxSetPos.get(cLang).p + 1);
    return sendJSON(res, 200, { ok: true, set: { id: setId, name, releaseDate } });
  }

  // ---- admin: hide (tombstone) or restore a card ----
  // On the master workspace a hide publishes as a deletion to every install;
  // on a normal install it is a local hide that master updates can't undo.
  if (pathname === '/api/card-hide' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    if (!isAdminUser(user)) return sendJSON(res, 403, { error: 'Administrator account required' });
    const body = await readBody(req);
    const cLang = LANG_RE.test(body.lang || '') ? body.lang : 'en';
    const cardId = typeof body.cardId === 'string' && CARD_ID_RE.test(body.cardId) ? body.cardId : null;
    if (!cardId) return sendJSON(res, 400, { error: 'A valid cardId is required' });
    if (!_cardRow.get(cLang, cardId)) return sendJSON(res, 404, { error: `Card ${cardId} not found in the ${cLang} database` });
    const hide = body.hidden !== false;   // default: hide
    _cardHide.run(hide ? 1 : 0, cLang, cardId);
    return sendJSON(res, 200, { ok: true, cardId, hidden: hide });
  }

  // ---- admin: upload the card's own picture (its base image) ----
  if (pathname === '/api/card-image' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    if (!isAdminUser(user)) return sendJSON(res, 403, { error: 'Administrator account required' });
    const cardId = url.searchParams.get('cardId') || '';
    const cLang = LANG_RE.test(url.searchParams.get('lang') || '') ? url.searchParams.get('lang') : 'en';
    if (!CARD_ID_RE.test(cardId)) return sendJSON(res, 400, { error: 'A valid cardId query parameter is required' });
    let sharp;
    try { sharp = require('sharp'); } catch {
      return sendJSON(res, 501, { error: 'Image processing needs the sharp package on the server: npm install --no-save sharp (the in-app database download installs it automatically)' });
    }
    if (!_cardExists.get(cLang, cardId)) return sendJSON(res, 404, { error: `Card ${cardId} not found in the ${cLang} database` });
    const setId = setIdOfCard(cardId);
    const localId = localIdOfCard(cardId);
    const raw = await readRawBody(req);
    if (!raw.length) return sendJSON(res, 400, { error: 'Send the image file as the request body' });
    const dir = path.join(CDN_DIR, cLang, 'images', setId, localId);
    fs.mkdirSync(dir, { recursive: true });
    try {
      await sharp(raw).resize({ width: 745, withoutEnlargement: true }).webp({ quality: 88 }).toFile(path.join(dir, 'card-high.webp'));
      await sharp(raw).resize({ width: 245, withoutEnlargement: true }).webp({ quality: 82 }).toFile(path.join(dir, 'card-low.webp'));
    } catch (e) {
      return sendJSON(res, 400, { error: 'Could not process that image: ' + e.message });
    }
    const low = `/cdn/${cLang}/images/${setId}/${localId}/card-low.webp`;
    const high = `/cdn/${cLang}/images/${setId}/${localId}/card-high.webp`;
    _setCardBaseImg.run(low, high, cLang, cardId);
    return sendJSON(res, 200, { ok: true, urls: { low, high } });
  }

  // ---- admin: upload your own image for a specific printing of a card ----
  if (pathname === '/api/variant-image' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    if (!isAdminUser(user)) return sendJSON(res, 403, { error: 'Administrator account required' });
    const cardId = url.searchParams.get('cardId') || '';
    const variant = url.searchParams.get('variant') || '';
    const lang = LANG_RE.test(url.searchParams.get('lang') || '') ? url.searchParams.get('lang') : 'en';
    if (!CARD_ID_RE.test(cardId) || !VARIANT_KEY_RE.test(variant)) {
      return sendJSON(res, 400, { error: 'Valid cardId and variant query parameters are required' });
    }
    let sharp;
    try { sharp = require('sharp'); } catch {
      return sendJSON(res, 501, { error: 'Image processing needs the sharp package on the server: npm install --no-save sharp (the in-app database download installs it automatically)' });
    }
    if (!_cardExists.get(lang, cardId)) return sendJSON(res, 404, { error: `Card ${cardId} not found in the ${lang} database` });
    const setId = setIdOfCard(cardId);
    const localId = localIdOfCard(cardId);
    const raw = await readRawBody(req);
    if (!raw.length) return sendJSON(res, 400, { error: 'Send the image file as the request body' });
    const dir = path.join(CDN_DIR, lang, 'images', setId, localId);
    fs.mkdirSync(dir, { recursive: true });
    try {
      await sharp(raw).resize({ width: 745, withoutEnlargement: true }).webp({ quality: 88 }).toFile(path.join(dir, `${variant}-high.webp`));
      await sharp(raw).resize({ width: 245, withoutEnlargement: true }).webp({ quality: 82 }).toFile(path.join(dir, `${variant}-low.webp`));
    } catch (e) {
      return sendJSON(res, 400, { error: 'Could not process that image: ' + e.message });
    }
    const low = `/cdn/${lang}/images/${setId}/${localId}/${variant}-low.webp`;
    const high = `/cdn/${lang}/images/${setId}/${localId}/${variant}-high.webp`;
    _localPrintingImg.run(lang, cardId, variant, low, high);   // point this printing at the local upload
    return sendJSON(res, 200, { ok: true, urls: { low, high } });
  }

  if (pathname === '/api/collection' && req.method === 'GET') {
    return sendJSON(res, 200, getCollectionOf(user.id));
  }

  if (pathname === '/api/collection' && req.method === 'PUT') {
    const body = await readBody(req);
    if (typeof body.collection !== 'object' || body.collection === null || Array.isArray(body.collection)) {
      return sendJSON(res, 400, { error: 'collection must be an object of cardId -> quantity' });
    }
    // sanitize: card ids are short strings; values are either a number (legacy)
    // or an object of variant -> quantity ({ normal: 1, reverse: 2, ... })
    const VARIANT_RE = /^[a-zA-Z0-9_-]{1,24}$/;
    const clamp = (q) => Math.min(Math.max(parseInt(q, 10) || 0, 0), 9999);
    const clean = {};
    let n = 0;
    for (const [id, val] of Object.entries(body.collection)) {
      if (typeof id !== 'string' || id.length > 64) continue;
      const variants = {};
      if (typeof val === 'number') {
        const q = clamp(val);
        if (q > 0) variants.normal = q;
      } else if (val && typeof val === 'object' && !Array.isArray(val)) {
        let vn = 0;
        for (const [vk, q] of Object.entries(val)) {
          if (!VARIANT_RE.test(vk)) continue;
          const qq = clamp(q);
          if (qq > 0) variants[vk] = qq;
          if (++vn > 16) break;
        }
      }
      if (Object.keys(variants).length) clean[id] = variants;
      if (++n > 100000) break;
    }
    const updatedAt = Date.now();
    putCollectionOf(user.id, clean, updatedAt);
    return sendJSON(res, 200, { ok: true, updatedAt, count: Object.keys(clean).length });
  }

  // ---------- binders (per-account; independent have/need checklist) ----------
  if (pathname === '/api/binders' && req.method === 'GET') {
    const rows = _bindersOf.all(user.id).map((b) => {
      const slots = JSON.parse(b.slots);
      const entries = Object.values(slots).filter((e) => e.card);   // art spans don't track
      return { id: b.id, name: b.name, size: b.size, color: b.color, pages: b.pages,
        cover: b.cover ? JSON.parse(b.cover) : null,
        filled: entries.length, have: entries.filter((s) => s.have).length };
    });
    return sendJSON(res, 200, { binders: rows });
  }

  if (pathname === '/api/binders' && req.method === 'POST') {
    const body = await readBody(req);
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
    const size = BINDER_SIZES.includes(body.size) ? body.size : null;
    const color = BINDER_COLORS.includes(body.color) ? body.color : BINDER_COLORS[0];
    if (!name || !size) return sendJSON(res, 400, { error: 'A name and a pocket size (2–5) are required' });
    if (_bindersOf.all(user.id).length >= 100) return sendJSON(res, 400, { error: 'Binder limit reached (100)' });
    const perPage = size * size;
    let slots = {}, pages = 1;
    if (body.fillFromSet && SET_ID_RE.test(body.fillFromSet)) {
      const flang = LANG_RE.test(body.lang || '') ? body.lang : 'en';
      const cards = _cardsOfSet.all(flang, body.fillFromSet);
      if (!cards.length) return sendJSON(res, 400, { error: 'That set has no cards to fill from' });
      cards.forEach((c, i) => {
        const primary = (c.variants_csv ? c.variants_csv.split(',') : ['normal'])[0] || 'normal';
        slots[i] = { card: c.id, variant: primary, have: 0 };
      });
      pages = Math.max(1, Math.ceil(cards.length / perPage));
    }
    const binder = {
      id: crypto.randomUUID(), name, size, color, pages,
      slots, created: new Date().toISOString(), updated: Date.now(),
    };
    _binderPut.run(user.id, binder.id, binder.name, binder.size, binder.color, binder.pages,
      JSON.stringify(binder.slots), null, binder.created, binder.updated);
    return sendJSON(res, 200, { ok: true, binder });
  }

  // upload an image to place in binder pockets (any signed-in user's own art)
  if (pathname === '/api/binder-image' && req.method === 'POST') {
    let sharp;
    try { sharp = require('sharp'); } catch {
      return sendJSON(res, 501, { error: 'Image processing needs the sharp package on the server: npm install --no-save sharp' });
    }
    const raw = await readRawBody(req, 8 * 1024 * 1024).catch(() => null);
    if (!raw || !raw.length) return sendJSON(res, 400, { error: 'Send the image file as the request body (8 MB max)' });
    fs.mkdirSync(BINDER_IMG_DIR, { recursive: true });
    const name = crypto.randomUUID() + '.webp';
    try {
      await sharp(raw).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 }).toFile(path.join(BINDER_IMG_DIR, name));
    } catch (e) {
      return sendJSON(res, 400, { error: 'Could not process that image: ' + e.message });
    }
    return sendJSON(res, 200, { ok: true, url: '/bimg/' + name });
  }

  const binderMatch = pathname.match(/^\/api\/binders\/([a-f0-9-]{36})$/);
  if (binderMatch) {
    const row = _binderGet.get(user.id, binderMatch[1]);
    if (!row) return sendJSON(res, 404, { error: 'Binder not found' });
    if (req.method === 'GET') {
      return sendJSON(res, 200, { binder: { id: row.id, name: row.name, size: row.size, color: row.color,
        pages: row.pages, slots: JSON.parse(row.slots), cover: row.cover ? JSON.parse(row.cover) : null, updated: row.updated } });
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 40) : row.name;
      const color = BINDER_COLORS.includes(body.color) ? body.color : row.color;
      // resizing re-lays every pocket, so a size change must bring the
      // remapped slots along with it (the client computes the new layout)
      const size = BINDER_SIZES.includes(body.size) ? body.size : row.size;
      if (size !== row.size && body.slots === undefined) {
        return sendJSON(res, 400, { error: 'A size change must include the remapped slots' });
      }
      let pages = Number.isInteger(body.pages) ? Math.min(Math.max(body.pages, 1), 60) : row.pages;
      let slots = JSON.parse(row.slots);
      if (body.slots !== undefined) {
        if (typeof body.slots !== 'object' || body.slots === null || Array.isArray(body.slots)) {
          return sendJSON(res, 400, { error: 'slots must be an object of pocket index -> card entry' });
        }
        const capacity = pages * size * size;
        const clean = {};
        for (const [k, v] of Object.entries(body.slots)) {
          const i = parseInt(k, 10);
          if (!Number.isInteger(i) || i < 0 || i >= capacity) continue;
          if (!v || typeof v !== 'object') continue;
          if (typeof v.img === 'string') {
            // user-uploaded art placed across an arbitrary set of pockets on
            // one page, with a pan/zoom view transform and a gap-cutting mode
            if (!/^\/bimg\/[a-f0-9-]{36}\.webp$/.test(v.img)) continue;
            if (Array.isArray(v.cells)) {
              const perPage = size * size;
              const cells = [...new Set(v.cells.filter((c) => Number.isInteger(c) && c >= 0 && c < capacity))].sort((a, b) => a - b);
              if (!cells.length || cells.length > perPage) continue;
              const pg = Math.floor(cells[0] / perPage);
              if (!cells.every((c) => Math.floor(c / perPage) === pg)) continue;   // one page only
              if (cells[0] !== i) continue;                                       // anchored at its lowest cell
              const num = (n, lo, hi) => (Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null);
              const view = (v.view && typeof v.view === 'object')
                ? { x: num(v.view.x, -5000, 5000) ?? 0, y: num(v.view.y, -5000, 5000) ?? 0, s: num(v.view.s, 5, 10000) }
                : null;
              clean[i] = { img: v.img, cells, view: view && view.s ? view : null, gaps: v.gaps === 'without' ? 'without' : 'with' };
              continue;
            }
            // legacy rectangular span { img, w, h } (pre-editor clients)
            const w = Number.isInteger(v.w) ? Math.min(Math.max(v.w, 1), size) : 1;
            const hh = Number.isInteger(v.h) ? Math.min(Math.max(v.h, 1), size) : 1;
            clean[i] = { img: v.img, w, h: hh };
            continue;
          }
          if (typeof v.card !== 'string' || !CARD_ID_RE.test(v.card)) continue;
          const variant = typeof v.variant === 'string' && VARIANT_KEY_RE.test(v.variant) ? v.variant : 'normal';
          // n = copies in hand (only meaningful when have; 1 is the default)
          const n = Number.isInteger(v.n) ? Math.min(Math.max(v.n, 1), 99) : 1;
          clean[i] = { card: v.card, variant, have: v.have ? 1 : 0, ...(n > 1 ? { n } : {}) };
        }
        slots = clean;
      } else {
        // shrinking pages must not orphan filled pockets
        const capacity = pages * size * size;
        for (const k of Object.keys(slots)) if (parseInt(k, 10) >= capacity) { pages = row.pages; break; }
      }
      let cover = row.cover;
      if (body.cover !== undefined) {
        const cc = cleanBinderCover(body.cover);
        cover = cc ? JSON.stringify(cc) : null;
      }
      const updated = Date.now();
      _binderPut.run(user.id, row.id, name, size, color, pages, JSON.stringify(slots), cover, row.created, updated);
      return sendJSON(res, 200, { ok: true, updated });
    }
    if (req.method === 'DELETE') {
      _binderDel.run(user.id, row.id);
      return sendJSON(res, 200, { ok: true });
    }
  }

  return sendJSON(res, 404, { error: 'Unknown API endpoint' });
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url.pathname, ip, url);
    } else if (url.pathname.startsWith('/bimg/') && (req.method === 'GET' || req.method === 'HEAD')) {
      // user-uploaded binder images (stored under DATA_DIR, not public/)
      const m = url.pathname.match(/^\/bimg\/([a-f0-9-]{36}\.webp)$/);
      const file = m && path.join(BINDER_IMG_DIR, m[1]);
      fs.stat(file || '', (err, stat) => {
        if (err || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': stat.size,
          'Cache-Control': 'public, max-age=31536000, immutable' });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(file).pipe(res);
      });
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, url.pathname);
    } else {
      res.writeHead(405); res.end('Method not allowed');
    }
  } catch (err) {
    sendJSON(res, 400, { error: err.message || 'Bad request' });
  }
});

// seed the catalog DB from a local JSON catalog on first boot, if one is present
if (catalogStats().cards === 0 && dbExists()) {
  try {
    const r = importCatalogToDb();
    if (r.cards) console.log(`Imported catalog into the database: ${r.cards} cards, ${r.sets} sets, ${r.printings} printings`);
  } catch (e) {
    console.error('Initial catalog import failed: ' + e.message);
  }
}

if (process.argv.includes('--pull-master')) {
  // CLI mode (no web server): load the master card database into this
  // install's DB and exit. Used by the installers so a fresh install comes
  // up with every card already in place; safe to re-run any time (same
  // merge as the in-app update — local edits survive).
  (async () => {
    const base = configCdnBase();
    if (!base) {
      console.error('No master database configured — set cdnBase in public/config.js (or PTCG_CDN_BASE) to the bucket URL.');
      process.exit(2);
    }
    console.log(`Loading the card database from ${base} …`);
    try {
      const r = await importCatalogFromRemote(base, (p) => {
        if (p.setsDone === 1 || p.setsDone % 25 === 0 || p.setsDone === p.setTotal) {
          console.log(`  sets ${p.setsDone}/${p.setTotal}${p.setName ? ' — ' + p.setName : ''}`);
        }
      });
      console.log(`Card database loaded: ${r.cards} cards, ${r.sets} sets, ${r.printings} printings` +
        (r.version ? ` (master v${r.version})` : ''));
      try { db.close(); } catch { /* already closed */ }
      process.exit(0);
    } catch (e) {
      console.error('Loading the card database failed: ' + e.message + ' (safe to retry; the app also retries on boot)');
      try { db.close(); } catch { /* already closed */ }
      process.exit(1);
    }
  })();
} else {
  server.listen(PORT, HOST, () => {
    console.log(`Pokemon TCG Tracker running at http://localhost:${PORT}`);
    console.log(`Data directory: ${DATA_DIR}`);

    // Fresh install with no local card build but a remote database configured
    // (reads cards from a shared CDN): pull the catalog into the DB so cards
    // show up without the admin having to click anything. Runs in the
    // background — and keeps retrying every 10 minutes while the database is
    // still empty, so an install that boots before the master is reachable
    // (or before it has been published) heals itself.
    const tryMasterPull = () => {
      if (READONLY || build.running) return;
      if (catalogStats().cards > 0 || dbExists() || !configCdnBase()) return;
      try { startCatalogPull(configCdnBase()); }
      catch (e) { console.error('Auto-load from remote database failed to start: ' + e.message); }
    };
    tryMasterPull();
    setInterval(tryMasterPull, 10 * 60 * 1000).unref();
  });
}

// close the database cleanly on shutdown so SQLite checkpoints its WAL into
// the main .db file (keeps backups of DATA_DIR/ptcg.db self-contained)
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  try { db.close(); } catch { /* already closed */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
