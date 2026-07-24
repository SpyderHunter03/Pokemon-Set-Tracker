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
const USERS_FILE = path.join(DATA_DIR, 'users.json');           // legacy (pre-SQLite) — migrated on first run
const COLLECTIONS_DIR = path.join(DATA_DIR, 'collections');     // legacy (pre-SQLite) — migrated on first run
const DB_FILE = path.join(DATA_DIR, 'ptcg.db');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 90; // 90 days
const MAX_BODY = 8 * 1024 * 1024; // 8 MB — a full collection is far smaller
const READONLY = process.env.PTCG_READONLY === '1';
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
`);

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
    const isShell = ext === '.html' || file.endsWith('sw.js') || file.endsWith('config.js');
    const inCdn = file.startsWith(path.join(PUBLIC_DIR, 'cdn'));
    const isCardImage = inCdn && file.includes(`${path.sep}images${path.sep}`);
    // card images never change → cache hard; cdn JSON (indexes/sets/custom)
    // DOES change (builds, admin uploads) → always revalidate
    const cacheControl = isShell ? 'no-cache'
      : isCardImage ? 'public, max-age=2592000, immutable'
      : inCdn ? 'no-cache'
      : 'public, max-age=86400';
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl,
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
  const finish = (ok) => { build.running = false; build.phase = null; build.hashesOk = ok; };
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
const LOCAL_OVERLAY_FILE = path.join(DATA_DIR, 'local-overlay.json'); // this install's own layer
const CARD_ID_RE = /^[a-zA-Z0-9.-]{1,64}$/;
const SET_ID_RE = /^[a-zA-Z0-9.-]{1,40}$/;
const VARIANT_KEY_RE = /^[a-zA-Z0-9_-]{1,24}$/;
const LANG_RE = /^[a-z-]{2,7}$/;

function slugifyVariant(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

/* ---------- overlay layers ----------
 * The card database is rendered as three stacked layers:
 *   TCGdex base  →  master overlay (custom.json, published to R2)  →  local overlay
 * Each overlay is { cards:{id:{…}}, sets:{id:{…}}, removed:[id] }. A card entry
 * either patches an existing card (partial fields) or defines a brand-new one
 * (new:true). `removed` is a tombstone list: a card listed here is hidden even
 * if a lower layer (or a future master pull) still has it. The local overlay is
 * this install's own edits — it lives in DATA_DIR, is never touched by a master
 * pull, and is applied last so it always wins. */
const EMPTY_OVERLAY = () => ({ cards: {}, sets: {}, removed: [] });
const loadLocalOverlay = () => {
  const o = readJSON(LOCAL_OVERLAY_FILE, null) || EMPTY_OVERLAY();
  o.cards = o.cards || {}; o.sets = o.sets || {}; o.removed = Array.isArray(o.removed) ? o.removed : [];
  return o;
};
const saveLocalOverlay = (o) => writeJSONAtomic(LOCAL_OVERLAY_FILE, o);

/** Sanitize a card patch/definition coming from the editor API. */
function sanitizeOverlayCard(body) {
  const out = {};
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  if (body.name !== undefined) out.name = str(body.name, 80);
  if (body.rarity !== undefined) out.rarity = str(body.rarity, 40);
  if (body.category !== undefined) out.category = str(body.category, 20);
  if (body.localId !== undefined) out.localId = str(body.localId, 24);
  if (body.image !== undefined) out.image = body.image === null ? null : str(body.image, 120);
  if (body.hp !== undefined) { const h = parseInt(body.hp, 10); if (h >= 0 && h < 100000) out.hp = h; }
  if (Array.isArray(body.types)) out.types = body.types.filter((t) => typeof t === 'string').slice(0, 6).map((t) => t.slice(0, 20));
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

/** List every variant image on disk (from the per-set JSON files) for the API. */
function variantImageManifest(lang) {
  const langDir = path.join(CDN_DIR, lang);
  const setsDir = path.join(langDir, 'sets');
  const images = [];
  let setFiles = [];
  try { setFiles = fs.readdirSync(setsDir).filter((f) => f.endsWith('.json')); } catch { return images; }
  for (const f of setFiles) {
    const set = readJSON(path.join(setsDir, f), null);
    if (!set || !Array.isArray(set.cards)) continue;
    for (const c of set.cards) {
      if (!c.variantImages) continue;
      for (const [vk, qualities] of Object.entries(c.variantImages)) {
        images.push({
          card: c.id,
          name: c.name,
          set: set.id,
          variant: vk,
          qualities,
          urls: Object.fromEntries(qualities.map((q) => [q, `/cdn/${lang}/images/${set.id}/${localIdOfCard(c.id)}/${vk}-${q}.webp`])),
        });
      }
    }
  }
  return images;
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
      canPublish: !READONLY && !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET),
    });
  }

  // this install's own overlay layer (adds/edits/removals) — public read so the
  // app can merge it on top of the master database
  if (pathname === '/api/local-overlay' && req.method === 'GET') {
    return sendJSON(res, 200, loadLocalOverlay());
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
    const overlay = loadLocalOverlay();
    const entry = overlay.cards[cardId] = overlay.cards[cardId] || {};
    entry.printings = entry.printings || {};
    entry.printings[key] = label;
    saveLocalOverlay(overlay);
    return sendJSON(res, 200, { ok: true, cardId, key, label });
  }

  // ---- admin: add or edit a card (patch an existing one, or define a new one) ----
  if (pathname === '/api/overlay-card' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    if (!isAdminUser(user)) return sendJSON(res, 403, { error: 'Administrator account required' });
    const body = await readBody(req);
    const cardId = typeof body.cardId === 'string' && CARD_ID_RE.test(body.cardId) ? body.cardId : null;
    const setId = typeof body.set === 'string' && SET_ID_RE.test(body.set) ? body.set : null;
    if (!cardId) return sendJSON(res, 400, { error: 'A valid cardId is required' });
    const overlay = loadLocalOverlay();
    const existing = overlay.cards[cardId] || {};
    const patch = sanitizeOverlayCard(body);
    const merged = { ...existing, ...patch };
    if (body.new) {
      // defining a brand-new card the base database doesn't have
      if (!setId) return sendJSON(res, 400, { error: 'New cards need a set id' });
      merged.new = true;
      merged.set = setId;
      if (!merged.localId) merged.localId = localIdOfCard(cardId);
      if (!merged.name) return sendJSON(res, 400, { error: 'New cards need a name' });
    }
    overlay.cards[cardId] = merged;
    // adding a card back un-tombstones it
    overlay.removed = (overlay.removed || []).filter((id) => id !== cardId);
    saveLocalOverlay(overlay);
    return sendJSON(res, 200, { ok: true, cardId, card: merged });
  }

  // ---- admin: add a brand-new set the base database doesn't have ----
  if (pathname === '/api/overlay-set' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    if (!isAdminUser(user)) return sendJSON(res, 403, { error: 'Administrator account required' });
    const body = await readBody(req);
    const setId = typeof body.id === 'string' && SET_ID_RE.test(body.id) ? body.id : null;
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    if (!setId || name.length < 2) return sendJSON(res, 400, { error: 'A valid set id and name (2+ characters) are required' });
    const overlay = loadLocalOverlay();
    overlay.sets[setId] = {
      id: setId, name,
      releaseDate: typeof body.releaseDate === 'string' ? body.releaseDate.slice(0, 10) : undefined,
    };
    saveLocalOverlay(overlay);
    return sendJSON(res, 200, { ok: true, set: overlay.sets[setId] });
  }

  // ---- admin: remove (tombstone) or restore a card ----
  if (pathname === '/api/overlay-remove' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    if (!isAdminUser(user)) return sendJSON(res, 403, { error: 'Administrator account required' });
    const body = await readBody(req);
    const cardId = typeof body.cardId === 'string' && CARD_ID_RE.test(body.cardId) ? body.cardId : null;
    if (!cardId) return sendJSON(res, 400, { error: 'A valid cardId is required' });
    const overlay = loadLocalOverlay();
    overlay.removed = overlay.removed || [];
    const remove = body.removed !== false; // default: remove
    if (remove) {
      if (!overlay.removed.includes(cardId)) overlay.removed.push(cardId);
      // a purely-overlay-added card with no other data → drop it entirely
      const e = overlay.cards[cardId];
      if (e && e.new && !e.printings) delete overlay.cards[cardId];
    } else {
      overlay.removed = overlay.removed.filter((id) => id !== cardId);
    }
    saveLocalOverlay(overlay);
    return sendJSON(res, 200, { ok: true, cardId, removed: remove });
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
    const setId = setIdOfCard(cardId);
    const localId = localIdOfCard(cardId);
    const setFile = path.join(CDN_DIR, lang, 'sets', setId + '.json');
    const set = readJSON(setFile, null);
    const card = set && Array.isArray(set.cards) ? set.cards.find((c) => c.id === cardId) : null;
    // the card may be an overlay-added one that has no base set-file entry
    const overlay = loadLocalOverlay();
    const overlayCard = overlay.cards[cardId];
    if (!card && !overlayCard) return sendJSON(res, 404, { error: `Card ${cardId} not found — add it to the database first` });
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
    if (card) {
      if (!card.variantImages) card.variantImages = {};
      card.variantImages[variant] = ['low', 'high'];
      if (!card.image) card.image = `images/${setId}/${localId}`;
      writeJSONAtomic(setFile, set);
    } else {
      overlayCard.variantImages = overlayCard.variantImages || {};
      overlayCard.variantImages[variant] = ['low', 'high'];
      if (!overlayCard.image) overlayCard.image = `images/${setId}/${localId}`;
      saveLocalOverlay(overlay);
    }
    return sendJSON(res, 200, {
      ok: true,
      urls: {
        low: `/cdn/${lang}/images/${setId}/${localId}/${variant}-low.webp`,
        high: `/cdn/${lang}/images/${setId}/${localId}/${variant}-high.webp`,
      },
    });
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

  return sendJSON(res, 404, { error: 'Unknown API endpoint' });
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url.pathname, ip, url);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, url.pathname);
    } else {
      res.writeHead(405); res.end('Method not allowed');
    }
  } catch (err) {
    sendJSON(res, 400, { error: err.message || 'Bad request' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Pokemon TCG Tracker running at http://localhost:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});

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
