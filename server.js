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
// Fingerprints for cards this install added or re-pictured itself. The main
// scan index is built in bulk (or pulled from the bucket) and knows nothing
// about them, so they are kept beside it and merged when the scanner asks.
const SCAN_EXTRA_FILE = path.join(DATA_DIR, 'scan-extra.json');

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
try { db.exec('ALTER TABLE printings ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0'); } catch { /* already present */ }
// An account had no address to reach it at, so a forgotten password had
// nowhere to go. Nullable on purpose: accounts that predate this keep working
// and are asked for one when their owner next has a reason to give it.
try { db.exec('ALTER TABLE users ADD COLUMN email TEXT'); } catch { /* already present */ }
try { db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0'); } catch { /* already present */ }
// A second factor, off until somebody turns it on. The secret is stored as
// written: it has to be given back to the authenticator app on enrolment, and
// unlike a password there is nothing to compare it against — a hash of it
// could not generate the next code.
try { db.exec('ALTER TABLE users ADD COLUMN totp_secret TEXT'); } catch { /* already present */ }
try { db.exec('ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0'); } catch { /* already present */ }
// An account can also be reachable through somebody else's identity provider.
// The pair is (issuer, subject): a subject is only unique within its issuer,
// and storing the subject alone would let a second provider's user id collide
// with a first provider's and inherit the account.
try { db.exec('ALTER TABLE users ADD COLUMN oidc_iss TEXT'); } catch { /* already present */ }
try { db.exec('ALTER TABLE users ADD COLUMN oidc_sub TEXT'); } catch { /* already present */ }
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_oidc ON users (oidc_iss, oidc_sub) WHERE oidc_sub IS NOT NULL'); } catch { /* already present */ }
// A binder can be handed to somebody who has no account here. NULL is private
// — the default, and what every binder that predates this is. A value is an
// unguessable token that stands in for the binder in a public URL: the real
// id is never published, so a shared link cannot be filed down into an API
// path that expects its owner to be signed in.
try { db.exec('ALTER TABLE binders ADD COLUMN share TEXT'); } catch { /* already present */ }
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS binders_share ON binders (share) WHERE share IS NOT NULL'); } catch { /* already present */ }
// Whether a shared binder admits which cards its owner actually holds. On by
// default, because "here is my binder" is what sharing one usually means —
// but a link is also a partial inventory of somebody's house, so it should be
// a choice rather than a consequence.
try { db.exec('ALTER TABLE binders ADD COLUMN share_have INTEGER NOT NULL DEFAULT 1'); } catch { /* already present */ }

/* One-shot links: verify this address, reset this password. Only the SHA-256
 * of each token is kept — the raw value exists in the email and nowhere else,
 * so a copy of the database is not a set of skeleton keys. Every one carries
 * an expiry and is struck off the moment it is spent. */
db.exec(`
  CREATE TABLE IF NOT EXISTS auth_tokens (
    hash    TEXT PRIMARY KEY,               -- sha256 of the token, never the token
    user_id TEXT NOT NULL,
    kind    TEXT NOT NULL,                  -- 'verify' | 'reset'
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL,
    used    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS auth_tokens_user ON auth_tokens (user_id, kind);

  -- Recovery codes: what gets you in when the phone with the authenticator on
  -- it is at the bottom of a lake. Hashed, because unlike the TOTP secret
  -- these only ever need checking, never reproducing.
  CREATE TABLE IF NOT EXISTS recovery_codes (
    hash    TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created INTEGER NOT NULL,
    used    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS recovery_codes_user ON recovery_codes (user_id);
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

const rowToUser = (r) => (r ? { id: r.id, username: r.username, display: r.display, salt: r.salt, hash: r.hash, created: r.created, admin: !!r.admin, email: r.email || null, emailVerified: !!r.email_verified, totpSecret: r.totp_secret || null, totpEnabled: !!r.totp_enabled, oidcIss: r.oidc_iss || null, oidcSub: r.oidc_sub || null } : null);

const _getUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const _getUserByName = db.prepare('SELECT * FROM users WHERE username = ?');
const _getUserByEmail = db.prepare('SELECT * FROM users WHERE email IS NOT NULL AND lower(email) = ?');
const _getUserByOidc = db.prepare('SELECT * FROM users WHERE oidc_iss = ? AND oidc_sub = ?');
const _setUserOidc = db.prepare('UPDATE users SET oidc_iss = ?, oidc_sub = ? WHERE id = ?');
const _insertUser = db.prepare('INSERT INTO users (id, username, display, salt, hash, created, admin, email, email_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const _updateUserHash = db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?');
const _setUserEmail = db.prepare('UPDATE users SET email = ?, email_verified = ? WHERE id = ?');
const _markEmailVerified = db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?');

const _putToken = db.prepare('INSERT INTO auth_tokens (hash, user_id, kind, created, expires, used) VALUES (?, ?, ?, ?, ?, 0)');
const _getToken = db.prepare('SELECT * FROM auth_tokens WHERE hash = ?');
const _spendToken = db.prepare('UPDATE auth_tokens SET used = 1 WHERE hash = ?');
const _dropTokensOf = db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND kind = ?');
const _dropExpiredTokens = db.prepare('DELETE FROM auth_tokens WHERE expires < ?');

const _setTotp = db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = ? WHERE id = ?');
const _putRecovery = db.prepare('INSERT INTO recovery_codes (hash, user_id, created, used) VALUES (?, ?, ?, 0)');
const _getRecovery = db.prepare('SELECT * FROM recovery_codes WHERE hash = ? AND user_id = ?');
const _spendRecovery = db.prepare('UPDATE recovery_codes SET used = 1 WHERE hash = ?');
const _dropRecovery = db.prepare('DELETE FROM recovery_codes WHERE user_id = ?');
const _countRecovery = db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used = 0');
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
  _insertUser.run(u.id, u.username, u.display, u.salt, u.hash, u.created, u.admin ? 1 : 0,
    u.email || null, u.emailVerified ? 1 : 0);
}
const getUserByEmail = (addr) => rowToUser(_getUserByEmail.get(String(addr || '').trim().toLowerCase()));
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
// 'none' is a real choice, not a missing value: the front of the binder holds
// one thing at a time, and a picture wants a plain shell behind it rather than
// a color it has to fight.
const BINDER_COLORS = ['red', 'blue', 'green', 'purple', 'black', 'none'];
const MAX_BINDER_PAGES = 60;                     // the most sheets one binder holds
const _bindersOf = db.prepare('SELECT id, name, size, color, pages, slots, cover, share FROM binders WHERE user_id = ? ORDER BY created');
const _binderGet = db.prepare('SELECT * FROM binders WHERE user_id = ? AND id = ?');
const _binderShare = db.prepare('UPDATE binders SET share = ?, share_have = ?, updated = ? WHERE user_id = ? AND id = ?');
// the only binder lookup that does not start from a signed-in account, so it
// carries the owner's name along: the shared page says whose binder it is
const _binderByShare = db.prepare(
  'SELECT b.name, b.size, b.color, b.pages, b.slots, b.cover, b.share_have, u.display AS owner ' +
  'FROM binders b JOIN users u ON u.id = b.user_id WHERE b.share = ?');
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
    // optional placement (drag/resize in the cover editor) — cover-units,
    // everything scaled by the cover's rendered width
    const num = (n, lo, hi) => (Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null);
    const view = (c.view && typeof c.view === 'object')
      ? { x: num(c.view.x, -5000, 5000) ?? 0, y: num(c.view.y, -5000, 5000) ?? 0, s: num(c.view.s, 5, 10000) }
      : null;
    const flip = ['x', 'y', 'xy'].includes(c.flip) ? c.flip : null;
    const out = view && view.s ? { type: 'art', img: c.img, view } : { type: 'art', img: c.img };
    if (flip) out.flip = flip;
    return out;
  }
  return null;
}
const _binderDel = db.prepare('DELETE FROM binders WHERE user_id = ? AND id = ?');

/* ---------- reclaiming binder art ----------
 * An uploaded picture is written to disk before anything points at it, and
 * every way of taking one off a binder — deleting the binder, clearing a
 * pocket, putting a color on the front — leaves the file behind. Nobody can
 * reach it again, so it is pure weight in DATA_DIR, which is the folder that
 * gets backed up.
 *
 * The sweep is the obvious one — anything on disk that no binder mentions —
 * with the one caveat that matters: a file that has just been uploaded is
 * unreferenced by definition, because the PUT that places it has not happened
 * yet. So nothing is touched until it has been on disk an hour, which is far
 * longer than any upload-then-place takes and short enough to keep the folder
 * honest. Filenames are UUIDs and the folder is shared, so references are
 * collected across every user's binders, not just the one being saved. */
const BINDER_ART_GRACE = 60 * 60 * 1000;         // leave a new upload alone this long
const _allBinderArt = db.prepare('SELECT slots, cover FROM binders');

const _artName = (u) => {
  const m = /^\/bimg\/([a-f0-9-]{36}\.webp)$/.exec(typeof u === 'string' ? u : '');
  return m ? m[1] : null;
};

/** The /bimg/ files one binder points at, cover art included. */
function artNamesIn(slots, cover) {
  const out = new Set();
  const add = (u) => { const n = _artName(u); if (n) out.add(n); };
  try { const c = typeof cover === 'string' ? JSON.parse(cover) : cover; if (c && c.type === 'art') add(c.img); }
  catch { /* an unreadable cover keeps nothing alive */ }
  try {
    const s = typeof slots === 'string' ? JSON.parse(slots || '{}') : (slots || {});
    for (const v of Object.values(s)) if (v && typeof v === 'object') add(v.img);
  } catch { /* same for slots */ }
  return out;
}

/** Every /bimg/ file some binder still points at, across every account. */
function referencedBinderArt() {
  const refs = new Set();
  for (const row of _allBinderArt.all()) for (const n of artNamesIn(row.slots, row.cover)) refs.add(n);
  return refs;
}

/** Delete unreferenced art older than the grace period. Returns how many went.
 * Only called when something actually stopped pointing at a picture, so it
 * does not need a timer to keep it from running on every ordinary save. */
function sweepBinderArt() {
  const now = Date.now();
  let files;
  try { files = fs.readdirSync(BINDER_IMG_DIR); } catch { return 0; }   // nothing uploaded yet
  const refs = referencedBinderArt();
  let gone = 0;
  for (const f of files) {
    if (!/^[a-f0-9-]{36}\.webp$/.test(f) || refs.has(f)) continue;
    const full = path.join(BINDER_IMG_DIR, f);
    try {
      if (now - fs.statSync(full).mtimeMs < BINDER_ART_GRACE) continue;  // still in flight
      fs.unlinkSync(full);
      gone++;
    } catch { /* raced with another sweep, or gone already */ }
  }
  return gone;
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
      // pre-SQLite accounts predate email entirely — they arrive without one
      _insertUser.run(u.id, key, u.display || key, u.salt || '', u.hash || '', u.created || new Date(0).toISOString(), u.admin ? 1 : 0, null, 0);
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

/* Passwords were hashed with scrypt at Node's defaults, synchronously. Two
 * problems with that on a server strangers can reach: the defaults (N=16384)
 * are below what is now advised, and scryptSync stops the entire event loop
 * for the duration — every sign-in freezes the server for everyone, which is
 * a lever worth pulling if you want to take the thing down.
 *
 * Cost now travels WITH the hash rather than being implied by whatever the
 * code happened to use the day it ran: `scrypt$N=65536,r=8,p=1$<hex>`. A hash
 * with no parameters in it is one of the old ones and verifies at the old
 * cost, so nobody is locked out of an account they already had; the next time
 * they sign in correctly it is quietly rewritten at the new cost. That is the
 * only way to raise the floor without a flag day. */
const SCRYPT_PARAMS = { N: 65536, r: 8, p: 1 };
const LEGACY_SCRYPT = { N: 16384, r: 8, p: 1 };          // Node's defaults, what the old rows used
const SCRYPT_KEYLEN = 64;
// scrypt needs roughly 128*N*r bytes; Node's default ceiling is 32 MB, which
// N=65536 sails straight past, so say the number rather than discover it
const scryptMem = (o) => 256 * o.N * o.r;

const paramsOf = (stored) => {
  const m = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$/.exec(String(stored || ''));
  return m ? { N: +m[1], r: +m[2], p: +m[3] } : LEGACY_SCRYPT;
};
const digestOf = (stored) => {
  const s = String(stored || '');
  const i = s.lastIndexOf('$');
  return i < 0 ? s : s.slice(i + 1);
};
const isCurrent = (stored) => {
  const p = paramsOf(stored);
  return p.N === SCRYPT_PARAMS.N && p.r === SCRYPT_PARAMS.r && p.p === SCRYPT_PARAMS.p;
};

function scryptHex(password, salt, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN,
      { N: opts.N, r: opts.r, p: opts.p, maxmem: scryptMem(opts) },
      (err, key) => (err ? reject(err) : resolve(key.toString('hex'))));
  });
}

/** A new hash, at today's cost, carrying the cost it was made with. */
async function hashPassword(password, salt) {
  const hex = await scryptHex(password, salt, SCRYPT_PARAMS);
  return `scrypt$N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}$${hex}`;
}

/** Check a password against a stored hash of any vintage, in constant time. */
async function verifyPassword(password, salt, stored) {
  if (typeof password !== 'string' || !stored) return false;
  let hex;
  try { hex = await scryptHex(password, salt, paramsOf(stored)); }
  catch { return false; }
  const a = Buffer.from(hex), b = Buffer.from(digestOf(stored));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** After a correct sign-in on an old hash, quietly bring it up to date. */
async function upgradeHashIfStale(user, password) {
  if (isCurrent(user.hash)) return user;
  try {
    const fresh = await hashPassword(password, user.salt);
    _updateUserHash.run(user.salt, fresh, user.id);
    return { ...user, hash: fresh };
  } catch { return user; }        // an upgrade that fails is not a failed login
}

/** Short fingerprint of a password hash, embedded in tokens so that changing
 * the password invalidates every existing session (as Uptime Kuma does). */
function pwFingerprint(hash) {
  return crypto.createHash('sha256').update(hash).digest('hex').slice(0, 16);
}

/* ---------- the second factor ----------
 * TOTP as RFC 6238 describes it: HMAC-SHA1 over a 30-second counter, six
 * digits. That is the whole algorithm, and node:crypto has every part of it,
 * so no dependency arrives for this.
 *
 * SHA1 here is not the weakness it sounds like. TOTP does not rely on the
 * hash being collision-resistant; it relies on HMAC being unforgeable without
 * the key, which SHA1 still gives. It is also what every authenticator app
 * actually implements — an installation that insisted on SHA256 would simply
 * not work with most of them.
 */
const TOTP_STEP_MS = 30 * 1000;
const TOTP_DIGITS = 6;
// how far either side of now a code is still taken. One step covers a clock a
// little out of true and the user typing the last digit as it rolls over; more
// than that just widens the window for someone guessing.
const TOTP_DRIFT_STEPS = 1;
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(str).toUpperCase().replace(/[\s=]/g, '')) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** The six digits for one 30-second step. */
function totpAt(secretB32, stepIndex) {
  const key = base32Decode(secretB32);
  if (!key || !key.length) return null;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(stepIndex));
  const mac = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** Does this code belong to this secret, now or a step either side? */
function totpMatches(secretB32, code, at = Date.now()) {
  const given = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return false;
  const step = Math.floor(at / TOTP_STEP_MS);
  for (let d = -TOTP_DRIFT_STEPS; d <= TOTP_DRIFT_STEPS; d++) {
    const want = totpAt(secretB32, step + d);
    if (!want) return false;
    const a = Buffer.from(given), b = Buffer.from(want);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

/* A code, once used, must not work again for the rest of its 30 seconds —
 * otherwise anyone who watches one being typed has half a minute to use it.
 * Remembering the (user, step) pairs recently spent is enough; they age out
 * on their own because a step that old would fail the window check anyway. */
const spentTotp = new Map();
function totpAlreadyUsed(userId, code) {
  const k = userId + ':' + code;
  const now = Date.now();
  for (const [key, when] of spentTotp) if (now - when > 3 * TOTP_STEP_MS) spentTotp.delete(key);
  if (spentTotp.has(k)) return true;
  spentTotp.set(k, now);
  return false;
}

/** Recovery codes: shown once at enrolment, stored only as hashes. */
function issueRecoveryCodes(userId, howMany = 10) {
  _dropRecovery.run(userId);
  const codes = [];
  for (let i = 0; i < howMany; i++) {
    // grouped for reading aloud and typing without losing your place
    const raw = crypto.randomBytes(5).toString('hex');
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    codes.push(code);
    _putRecovery.run(tokenHash(code), userId, Date.now());
  }
  return codes;
}

/** Spend a recovery code. Case and spacing are not the point. */
function redeemRecoveryCode(userId, given) {
  const norm = String(given || '').trim().toLowerCase().replace(/\s/g, '');
  if (!norm) return false;
  const row = _getRecovery.get(tokenHash(norm), userId);
  if (!row || row.used) return false;
  _spendRecovery.run(row.hash);
  return true;
}

/* ---------- one-shot links ----------
 * The value that goes in the email is 32 random bytes. What the database
 * keeps is its SHA-256, so somebody holding a copy of ptcg.db holds no usable
 * link — the same reason passwords are not stored either. Single use, short
 * life, and issuing a new one of a kind cancels the last, so a reset link
 * sent twice does not leave two working doors. */
const EMAIL_TOKEN_BYTES = 32;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 45 * 60 * 1000;
const tokenHash = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

function issueEmailToken(userId, kind) {
  const ttl = kind === 'reset' ? RESET_TTL_MS : VERIFY_TTL_MS;
  const raw = crypto.randomBytes(EMAIL_TOKEN_BYTES).toString('base64url');
  _dropTokensOf.run(userId, kind);                 // the newest link is the only link
  const now = Date.now();
  _putToken.run(tokenHash(raw), userId, kind, now, now + ttl);
  try { _dropExpiredTokens.run(now); } catch { /* tidying is optional */ }
  return raw;
}

/** Spend a token: valid, unused, unexpired, of the right kind. */
function redeemEmailToken(raw, kind) {
  if (typeof raw !== 'string' || !raw) return null;
  const h = tokenHash(raw);
  const row = _getToken.get(h);
  if (!row || row.kind !== kind || row.used || row.expires < Date.now()) return null;
  _spendToken.run(h);
  return getUserById(row.user_id);
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

/* Between the password and the second factor there is a moment where somebody
 * has proved one thing and not the other. This names that moment: bound to
 * the same password fingerprint, marked so it cannot be mistaken for a
 * session, and short enough that walking away from a half-finished sign-in
 * does not leave a door ajar. */
const TOTP_TICKET_TTL_MS = 5 * 60 * 1000;
const issueTotpTicket = (user) =>
  sign({ uid: user.id, pv: pwFingerprint(user.hash), stage: 'totp', exp: Date.now() + TOTP_TICKET_TTL_MS });

function redeemTotpTicket(ticket) {
  const p = verifyToken(ticket);
  if (!p || p.stage !== 'totp') return null;
  const user = getUserById(p.uid);
  if (!user || p.pv !== pwFingerprint(user.hash)) return null;   // password changed underneath it
  return user;
}

/** Anything this server signed, still in date. Says nothing about what it is
 * for — a half-finished sign-in is signed by us too, and is not a session. */
function verifySigned(token) {
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
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/** A signed thing that names an account. */
function verifyToken(token) {
  const payload = verifySigned(token);
  return payload && payload.uid ? payload : null;
}

function authUser(req) {
  const header = req.headers.authorization || '';
  // an explicit Bearer token wins; otherwise the cookie the browser holds
  const token = header.startsWith('Bearer ') ? header.slice(7) : cookieOf(req, SESSION_COOKIE);
  const payload = verifyToken(token);
  if (!payload) return null;
  // A ticket says "the password was right", not "you are in". Treating one as
  // a session would make the second factor a formality anyone could skip by
  // pointing at the API instead of the form.
  if (payload.stage) return null;
  const user = getUserById(payload.uid);
  if (!user) return null;
  // token bound to the password hash: a password change logs out old sessions
  if (payload.pv && payload.pv !== pwFingerprint(user.hash)) return null;
  return user;
}

/* ---------- who is actually asking ----------
 * X-Forwarded-For is a claim, not a fact — anyone can put one on a request.
 * Believing it unconditionally means the rate limiter counts a different
 * "address" every time and therefore never fires, which on a server anyone
 * can reach is the same as having no rate limiter at all. So it is believed
 * only when the connection itself came from a proxy this install was told
 * about: PTCG_TRUSTED_PROXY, a comma-separated list of addresses, IPv4 CIDRs,
 * or the words `loopback`, `private` and `any`. Empty by default, because an
 * install nobody told about a proxy does not have one. */
const TRUSTED_PROXIES = (process.env.PTCG_TRUSTED_PROXY || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const normIp = (a) => {
  const s = String(a || '');
  return s.startsWith('::ffff:') ? s.slice(7) : s;
};

function proxyMatch(addr, rule) {
  const a = normIp(addr);
  if (rule === 'any' || rule === '*') return true;
  if (rule === 'loopback') return a === '127.0.0.1' || a === '::1';
  if (rule === 'private') {
    return /^10\./.test(a) || /^192\.168\./.test(a) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^f[cd]/i.test(a);
  }
  if (rule.includes('/')) {
    const [net, bitsRaw] = rule.split('/');
    const bits = parseInt(bitsRaw, 10);
    const quad = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
    if (!quad.test(a) || !quad.test(net) || !(bits >= 0 && bits <= 32)) return false;
    const toInt = (x) => x.split('.').reduce((n, o) => ((n * 256) + (parseInt(o, 10) || 0)), 0) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (toInt(a) & mask) >>> 0 === (toInt(net) & mask) >>> 0;
  }
  return a === normIp(rule);
}
const isTrustedProxy = (addr) => TRUSTED_PROXIES.some((r) => proxyMatch(addr, r));

/* Some proxies publish the client address in a header of their own, which they
 * SET rather than append — Cloudflare's CF-Connecting-IP is the common one. A
 * single value the proxy overwrites is better than a list the client gets to
 * contribute the front of, so when an install names such a header it is used
 * in preference to the chain. Still only from a trusted connection: a header
 * is only as good as the hop that put it there. */
const CLIENT_IP_HEADER = (process.env.PTCG_CLIENT_IP_HEADER || '').trim().toLowerCase();

/** The address to hold responsible: the proxy's own header if this install
 * named one, otherwise X-Forwarded-For walked from the right, stepping over
 * proxies we trust — a stranger can prepend to that list but not append to it.
 * With nothing trusted this is the socket, which is the only thing a stranger
 * cannot choose at all. */
function clientIp(req) {
  const peer = normIp(req.socket.remoteAddress) || '?';
  if (!TRUSTED_PROXIES.length || !isTrustedProxy(peer)) return peer;
  if (CLIENT_IP_HEADER) {
    const v = normIp(String(req.headers[CLIENT_IP_HEADER] || '').split(',')[0].trim());
    if (v) return v;
  }
  const chain = String(req.headers['x-forwarded-for'] || '')
    .split(',').map((s) => normIp(s.trim())).filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) if (!isTrustedProxy(chain[i])) return chain[i];
  return chain[0] || peer;
}

/** Was the request HTTPS by the time it reached the user? Same trust rule —
 * this decides whether the session cookie may carry the Secure flag, and
 * guessing yes on a plain-http install would throw the cookie away. */
function isSecureRequest(req) {
  if (req.socket.encrypted) return true;
  if (TRUSTED_PROXIES.length && isTrustedProxy(normIp(req.socket.remoteAddress))) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (proto) return proto === 'https';
  }
  return false;
}

/* ---------- the session, in a cookie the page cannot read ----------
 * The token used to live in localStorage, which means any script that ever
 * runs on the page — one bad dependency, one reflected string — can read it
 * and keep the account for the ninety days the token lasts. httpOnly takes
 * that off the table: the browser sends it and JavaScript cannot see it.
 *
 * SameSite=Strict is the other half. Once the browser attaches credentials by
 * itself, a form on someone else's site could POST to this one on your behalf
 * — Strict means the cookie simply is not sent on anything that did not start
 * here. Bearer tokens still work for scripts and for anything that is not a
 * browser; they were never the part at risk. */
const SESSION_COOKIE = 'ptcg_session';
const MIN_PASSWORD = 10;

const cookieOf = (req, name) => {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
};

const sessionCookie = (req, token) => `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}` + (isSecureRequest(req) ? '; Secure' : '');
const clearSessionCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

/** Hand back a signed-in session: the cookie for browsers, and the token in
 * the body for everything else (the tests and any script API client). */
function sendSession(req, res, user) {
  const token = issueToken(user);
  return sendJSON(res, 200, { token, username: user.display }, { 'Set-Cookie': sessionCookie(req, token) });
}

/* A cookie is sent by the browser whether or not the page meant it, so a
 * cookie-authenticated write needs to prove it came from here. SameSite=Strict
 * already does that in every browser that honours it; this is the second lock,
 * for the ones that do not and for anything that predates it. A Bearer token
 * is exempt — nothing attaches that by accident. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
function crossSiteWrite(req) {
  if (SAFE_METHODS.has(req.method)) return false;
  if ((req.headers.authorization || '').startsWith('Bearer ')) return false;
  if (!cookieOf(req, SESSION_COOKIE)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site) return !(site === 'same-origin' || site === 'none');
  const origin = req.headers.origin;
  if (!origin) return false;              // not a browser form post
  try { return new URL(origin).host !== req.headers.host; } catch { return true; }
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

/* Failed sign-ins are counted per ACCOUNT as well as per address. A per-IP
 * limit does nothing about one account guessed from a thousand addresses,
 * which is what credential stuffing actually looks like. Only failures count
 * — signing in correctly ten times in a row is not an attack — and the window
 * is short on purpose: a lockout an attacker can trigger at will is itself a
 * way to keep someone out, so this slows guessing without handing anyone a
 * lever to lock a known username out for the day. */
const LOGIN_MAX_FAILURES = 10;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const loginFailures = new Map();

function loginLocked(accountKey) {
  const b = loginFailures.get(accountKey);
  if (!b) return false;
  if (Date.now() - b.start > LOGIN_LOCKOUT_MS) { loginFailures.delete(accountKey); return false; }
  return b.count >= LOGIN_MAX_FAILURES;
}

function noteLoginFailure(accountKey) {
  const now = Date.now();
  let b = loginFailures.get(accountKey);
  if (!b || now - b.start > LOGIN_LOCKOUT_MS) { b = { start: now, count: 0 }; loginFailures.set(accountKey, b); }
  b.count++;
  if (loginFailures.size > 10000) loginFailures.clear();
}

const clearLoginFailures = (accountKey) => loginFailures.delete(accountKey);

/* ---------- signing in with somebody else's identity provider ----------
 * Optional, and off unless configured. Local accounts remain the default so a
 * fresh install works with nothing else running; this is for people who
 * already run Authentik, Keycloak, Zitadel, Auth0, Okta or Pocket ID and
 * would rather have one sign-in for everything.
 *
 * Standard OpenID Connect authorization code flow with PKCE, and no
 * dependency: discovery is one fetch, and verifying the identity token is
 * RSA/ECDSA over a JSON Web Key, both of which node:crypto does natively.
 */
const oidcSettings = () => {
  const s = loadSettings().oidc || {};
  const e = process.env;
  return {
    issuer: (e.PTCG_OIDC_ISSUER || s.issuer || '').replace(/\/+$/, ''),
    clientId: e.PTCG_OIDC_CLIENT_ID || s.clientId || '',
    clientSecret: e.PTCG_OIDC_CLIENT_SECRET || s.clientSecret || '',
    label: e.PTCG_OIDC_LABEL || s.label || 'single sign-on',
    // 'link'   — an identity nobody has claimed is turned away
    // 'create' — it gets an account of its own
    unknown: ['link', 'create'].includes(e.PTCG_OIDC_UNKNOWN || s.unknown) ? (e.PTCG_OIDC_UNKNOWN || s.unknown) : 'link',
  };
};
const oidcConfigured = () => {
  const c = oidcSettings();
  return !!(c.issuer && c.clientId);
};

/* Discovery and the signing keys, both cached: an install that signs people in
 * all day should not ask its provider who it is on every request, and a
 * provider that rotates keys should not need a restart to be believed. */
const _oidcCache = { doc: null, docAt: 0, jwks: null, jwksAt: 0, issuer: '' };
const OIDC_CACHE_MS = 60 * 60 * 1000;

async function oidcDiscover() {
  const { issuer } = oidcSettings();
  if (!issuer) throw new Error('No identity provider is configured');
  const fresh = _oidcCache.doc && _oidcCache.issuer === issuer && Date.now() - _oidcCache.docAt < OIDC_CACHE_MS;
  if (fresh) return _oidcCache.doc;
  const r = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error(`The provider did not answer discovery (${r.status})`);
  const doc = await r.json();
  if (doc.issuer !== issuer) {
    // a document claiming to speak for a different issuer is not this provider
    throw new Error(`The provider calls itself ${doc.issuer}, not ${issuer}`);
  }
  Object.assign(_oidcCache, { doc, docAt: Date.now(), issuer, jwks: null, jwksAt: 0 });
  return doc;
}

async function oidcKeys(force) {
  const doc = await oidcDiscover();
  if (!force && _oidcCache.jwks && Date.now() - _oidcCache.jwksAt < OIDC_CACHE_MS) return _oidcCache.jwks;
  const r = await fetch(doc.jwks_uri);
  if (!r.ok) throw new Error(`Could not fetch the provider's signing keys (${r.status})`);
  const jwks = await r.json();
  Object.assign(_oidcCache, { jwks: jwks.keys || [], jwksAt: Date.now() });
  return _oidcCache.jwks;
}

const b64urlJson = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const JWT_ALGS = { RS256: 'RSA-SHA256', RS384: 'RSA-SHA384', RS512: 'RSA-SHA512', ES256: 'sha256', ES384: 'sha384', ES512: 'sha512' };

/**
 * Check an identity token the whole way down: signature against the
 * provider's published key, then every claim that says who it is for.
 * A token that is merely well-formed is not evidence of anything.
 */
async function verifyIdToken(idToken, { nonce }) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('That identity token is not a token');
  const header = b64urlJson(parts[0]);
  const claims = b64urlJson(parts[1]);
  if (!JWT_ALGS[header.alg]) throw new Error(`Unsupported signing algorithm ${header.alg}`);

  let keys = await oidcKeys(false);
  let key = keys.find((k) => (!header.kid || k.kid === header.kid) && (!k.alg || k.alg === header.alg));
  if (!key) {                                   // a rotated key is worth one refetch
    keys = await oidcKeys(true);
    key = keys.find((k) => (!header.kid || k.kid === header.kid) && (!k.alg || k.alg === header.alg));
  }
  if (!key) throw new Error('The provider has no published key for that token');

  const pub = crypto.createPublicKey({ key, format: 'jwk' });
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], 'base64url');
  const ok = header.alg.startsWith('ES')
    ? crypto.verify(JWT_ALGS[header.alg], signed, { key: pub, dsaEncoding: 'ieee-p1363' }, sig)
    : crypto.verify(JWT_ALGS[header.alg], signed, pub, sig);
  if (!ok) throw new Error('That identity token is not signed by the provider');

  const cfg = oidcSettings();
  const now = Math.floor(Date.now() / 1000);
  const SKEW = 120;                             // clocks are never quite the same
  if (claims.iss !== cfg.issuer) throw new Error('That token was issued by somebody else');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(cfg.clientId)) throw new Error('That token was issued for a different application');
  if (claims.azp && claims.azp !== cfg.clientId) throw new Error('That token was authorised for a different application');
  if (!claims.exp || claims.exp + SKEW < now) throw new Error('That token has expired');
  if (claims.iat && claims.iat - SKEW > now) throw new Error('That token is dated in the future');
  // the nonce is what stops a token obtained elsewhere being replayed here
  if (nonce && claims.nonce !== nonce) throw new Error('That token belongs to a different sign-in');
  if (!claims.sub) throw new Error('That token does not say who it is for');
  return claims;
}

/* The half-finished sign-in has to survive a trip to somebody else's website
 * and back. It cannot live in the session cookie, which is SameSite=Strict and
 * therefore deliberately absent on the way back from a redirect — so it gets
 * its own, Lax, short-lived, holding only what the callback must check. */
const OIDC_COOKIE = 'ptcg_oidc';
const OIDC_FLOW_TTL_MS = 10 * 60 * 1000;

const oidcFlowCookie = (req, payload) => {
  const value = sign({ ...payload, exp: Date.now() + OIDC_FLOW_TTL_MS });
  return `${OIDC_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${OIDC_FLOW_TTL_MS / 1000}`
    + (isSecureRequest(req) ? '; Secure' : '');
};
const clearOidcCookie = () => `${OIDC_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

const oidcRedirectUri = (req) => `${publicBase(req)}/api/oidc/callback`;

/** Exchange the one-time code for tokens. */
async function oidcExchange(req, code, verifier) {
  const doc = await oidcDiscover();
  const cfg = oidcSettings();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: oidcRedirectUri(req),
    client_id: cfg.clientId,
    code_verifier: verifier,
  });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  // a confidential client authenticates; a public one has only PKCE
  if (cfg.clientSecret) {
    headers.Authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString('base64');
  }
  const r = await fetch(doc.token_endpoint, { method: 'POST', headers, body });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error_description || data.error || `The provider refused the code (${r.status})`);
  if (!data.id_token) throw new Error('The provider returned no identity token');
  return data;
}

/** A page that hands the browser back to the app with a message. */
function oidcDone(res, req, hash, extraCookie) {
  const to = `${publicBase(req)}/${hash}`;
  res.writeHead(302, {
    Location: to,
    'Cache-Control': 'no-store',
    'Set-Cookie': extraCookie ? [clearOidcCookie(), extraCookie] : [clearOidcCookie()],
  });
  res.end();
}

/* ---------- sending mail ----------
 * SMTP, because it is the one thing every provider speaks: Brevo, Resend,
 * SES, Postmark and Mailgun all hand out credentials for it, and somebody
 * with their own mail server just points at that. No provider-specific code,
 * nothing to sign up for, and an install that configures none of it simply
 * does not offer the features that need mail.
 *
 * nodemailer is an optional dependency, exactly like sharp — a password-reset
 * mail that silently fails to arrive is worse than a dependency, and TLS
 * negotiation and AUTH mechanisms are not places to be clever.
 *
 * Settings come from the environment first and the settings file second, so a
 * container can be configured without a wizard and a wizard can configure an
 * install without editing a unit file. */
const mailSettings = () => {
  const s = loadSettings().smtp || {};
  const e = process.env;
  const host = e.PTCG_SMTP_HOST || s.host || '';
  const port = parseInt(e.PTCG_SMTP_PORT || s.port || '587', 10) || 587;
  return {
    host,
    port,
    // 465 is TLS from the first byte; 587 upgrades with STARTTLS
    secure: (e.PTCG_SMTP_SECURE || s.secure) === undefined ? port === 465 : String(e.PTCG_SMTP_SECURE ?? s.secure) === 'true' || port === 465,
    user: e.PTCG_SMTP_USER || s.user || '',
    pass: e.PTCG_SMTP_PASS || s.pass || '',
    from: e.PTCG_SMTP_FROM || s.from || (e.PTCG_SMTP_USER || s.user || ''),
  };
};
const mailConfigured = () => !!mailSettings().host;

/** The address to build links with. Behind a proxy the app cannot know its own
 * public name, so it is told — otherwise the request's own Host is the best
 * guess available, and a link to the wrong host is worse than none. */
function publicBase(req) {
  const set = (process.env.PTCG_PUBLIC_URL || loadSettings().publicUrl || '').replace(/\/+$/, '');
  if (set) return set;
  const host = (req && req.headers.host) || `localhost:${PORT}`;
  return `${req && isSecureRequest(req) ? 'https' : 'http'}://${host}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const nodemailerAvailable = () => { try { require.resolve('nodemailer'); return true; } catch { return false; } };

/* The setup code. Generated once per boot while the install is still empty,
 * printed to the console, and never written to disk — reading the container
 * log is the proof of ownership, and a restart simply issues a new one.
 *
 * Hex rather than base64url deliberately: this is the one token a person has
 * to get out of a terminal and into a browser by hand, and `-` and `_` break
 * double-click selection, look like line noise in a box-drawn banner, and are
 * easy to mistake for each other read aloud. 128 bits is plenty. */
let _setupToken = null;
function setupToken() {
  if (!_setupToken) _setupToken = crypto.randomBytes(16).toString('hex');
  return _setupToken;
}

async function sendMail({ to, subject, text }) {
  const cfg = mailSettings();
  if (!cfg.host) throw new Error('No mail server is configured on this install');
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch { throw new Error('Sending mail needs the nodemailer package on the server: npm install --no-save nodemailer'); }
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.pass } } : {}),
  });
  await transport.sendMail({ from: cfg.from || cfg.user, to, subject, text });
}

/* The setup key as something a camera can read. Optional, like sharp and
 * nodemailer: without it enrolment still works from the key and the
 * otpauth:// link, it is just more typing on a desktop.
 *
 * This is deliberately not hand-rolled. A QR encoder is a specification's
 * worth of tables, masks and Reed-Solomon, and a subtly wrong one produces
 * something that looks exactly like a QR code and scans as nothing. */
function qrSvgFor(text) {
  let qrcode;
  try { qrcode = require('qrcode-generator'); } catch { return null; }
  try {
    const qr = qrcode(0, 'L');              // 0 = pick the smallest version that fits
    qr.addData(text, 'Byte');
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
  } catch { return null; }                  // a missing picture is not a failed enrolment
}

/** Ask someone to confirm the address they gave us. */
async function sendVerificationMail(req, user) {
  const raw = issueEmailToken(user.id, 'verify');
  const link = `${publicBase(req)}/#/verify/${raw}`;
  await sendMail({
    to: user.email,
    subject: 'Confirm your email for Pokémon TCG Tracker',
    text: `Hello ${user.display},\n\nConfirm this address so your account can be recovered if you ever forget your password:\n\n${link}\n\nThe link works once and expires in 24 hours. If you did not create this account, you can ignore this message — nothing happens until the link is opened.\n`,
  });
}

/** Send a way back in. Only ever to an address that has been confirmed. */
async function sendResetMail(req, user) {
  const raw = issueEmailToken(user.id, 'reset');
  const link = `${publicBase(req)}/#/reset/${raw}`;
  await sendMail({
    to: user.email,
    subject: 'Reset your Pokémon TCG Tracker password',
    text: `Hello ${user.display},\n\nOpen this link to choose a new password:\n\n${link}\n\nIt works once and expires in 45 minutes. Setting a new password signs out every device that is currently signed in.\n\nIf you did not ask for this, no action is needed — your password has not changed.\n`,
  });
}

// ---------- http helpers ----------

function sendJSON(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    // Open on purpose so other apps can read the card database. Note the
    // absence of Access-Control-Allow-Credentials: without it no browser will
    // attach the session cookie to a cross-origin call, so opening reads does
    // not open anybody's account. Do not add it.
    'Access-Control-Allow-Origin': '*',
    ...(extraHeaders || {}),
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
    // NOTE: the overlay is deliberately NOT cleared here. A full rebuild reads
    // public/cdn/<lang>/sets/*.json, and a card this install invented has no
    // entry there — so the rebuild would silently drop exactly the cards the
    // overlay exists to carry. Merging a fingerprint twice costs nothing.
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
const _catPrinting = db.prepare(`INSERT INTO printings (lang,card_id,variant,label,img_low,img_high,source,hidden)
  VALUES (?,?,?,?,?,?, 'master', ?)
  ON CONFLICT(lang,card_id,variant) DO UPDATE SET label=excluded.label,
    img_low=excluded.img_low, img_high=excluded.img_high, hidden=excluded.hidden WHERE printings.source='master'`);
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

/** The card API this install is a client of, if PTCG_API_BASE is set. The
 * base is accepted with or without its /v1 suffix — both spell the same
 * intent, so both work. PTCG_API_TOKEN rides along as a Bearer header; the
 * API decides whether the token is good, and apiRefusal() below translates
 * its refusals into sentences. */
function catalogApi() {
  let base = (process.env.PTCG_API_BASE || '').trim();
  if (!/^https?:\/\//.test(base)) return null;
  base = base.replace(/\/+$/, '');
  if (!/\/v1$/.test(base)) base += '/v1';
  const token = (process.env.PTCG_API_TOKEN || '').trim();
  return { base, headers: token ? { authorization: 'Bearer ' + token } : {} };
}

/** Where catalog PULLS come from: the card API when configured, else the
 * bucket (cdnBase) exactly as before. This choice moves card DATA only —
 * the master rows carry absolute image URLs, so pictures keep hotlinking
 * the public bucket no matter which door the data came through. */
function catalogSource() {
  const api = catalogApi();
  if (api) return { ...api, api: true };
  const cdn = configCdnBase();
  return cdn ? { base: cdn, headers: {}, api: false } : null;
}

/** The card API's refusal statuses, as sentences an admin can act on. A
 * refusal never touches the cards already here — an install that has its
 * catalog keeps serving it; only UPDATES stop. */
function apiRefusal(status) {
  if (status === 401) return 'the card API requires a token and this install did not send a valid one — set PTCG_API_TOKEN';
  if (status === 403) return 'this install’s card-API token has been revoked — issue a new one and update PTCG_API_TOKEN';
  if (status === 402) return 'this install’s card-API monthly allowance is spent — the cards already here keep working, and updates resume when the period resets';
  if (status === 429) return 'the card API is rate-limiting this install — wait a minute and try again';
  return null;
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
  for (const [vk, p] of Object.entries(prints)) { _catPrinting.run(lang, c.id, vk, p.label, p.img_low, p.img_high, 0); n++; }
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
async function importCatalogFromRemote(source, progressCb) {
  const base = source.base.replace(/\/+$/, '');
  const { DatabaseSync } = require('node:sqlite');

  // 1) download the master catalog.db to a temp file next to our own DB
  const res = await fetch(base + '/catalog.db', { headers: source.headers || {} });
  if (!res.ok) { const e = new Error(apiRefusal(res.status) || ('HTTP ' + res.status + ' for catalog.db')); e.status = res.status; throw e; }
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
      let pullPrints;   // older master catalogs predate the printings hidden column
      try { pullPrints = src.prepare('SELECT lang,card_id,variant,label,img_low,img_high,hidden FROM printings').all(); }
      catch { pullPrints = src.prepare('SELECT lang,card_id,variant,label,img_low,img_high FROM printings').all(); }
      for (const p of pullPrints) {
        _catPrinting.run(p.lang, p.card_id, p.variant, p.label, p.img_low, p.img_high, p.hidden ? 1 : 0);
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

/** Soft-bypass reviewed additions right after a pull: everything stays in the
 * table, just hidden + source='local' — future pulls see the original row and
 * bypass it, and the admin can restore any of it later. */
function applyBypass(bp) {
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const x of bp.sets || []) { _setHide.run(1, x.lang, x.id); _hideCardsOfSet.run(x.lang, x.id); n++; }
    for (const x of bp.cards || []) { _cardHide.run(1, x.lang, x.id); n++; }
    for (const x of bp.variants || []) { _printingHide.run(x.lang, x.card, x.variant); n++; }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return n;
}

/** What would a master pull ADD to this install? New sets, new cards in
 * existing sets, and new printings of existing cards — for the admin's
 * review step. Reads only; nothing here mutates the database. */
async function previewRemoteAdditions(source) {
  const base = source.base.replace(/\/+$/, '');
  const { DatabaseSync } = require('node:sqlite');
  const res = await fetch(base + '/catalog.db', { headers: source.headers || {} });
  if (!res.ok) { const e = new Error(apiRefusal(res.status) || ('HTTP ' + res.status + ' for catalog.db')); e.status = res.status; throw e; }
  const tmp = path.join(DATA_DIR, `.catalog-preview-${process.pid}.db`);
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  let src;
  try {
    src = new DatabaseSync(tmp);
    let version = null;
    try { version = Number((src.prepare("SELECT value FROM meta WHERE key='version'").get() || {}).value) || null; } catch { /* pre-versioning */ }
    const haveSet = new Set(db.prepare('SELECT lang, id FROM sets').all().map((r) => r.lang + '\n' + r.id));
    const localCards = new Map(db.prepare('SELECT lang, id, variants_csv FROM cards').all().map((r) => [r.lang + '\n' + r.id, r]));
    const localPrints = new Set(db.prepare('SELECT lang, card_id, variant FROM printings').all().map((r) => r.lang + '\n' + r.card_id + '\n' + r.variant));
    const splitVars = (csv) => (csv == null ? ['normal'] : csv.split(',')).filter(Boolean);

    const masterSets = src.prepare('SELECT lang, id, name FROM sets WHERE hidden = 0 ORDER BY position').all();
    const setNames = new Map(masterSets.map((x) => [x.lang + '\n' + x.id, x.name]));
    const newSets = [], newSetKeys = new Set();
    for (const x of masterSets) {
      const k = x.lang + '\n' + x.id;
      if (haveSet.has(k)) continue;   // present — visible OR already bypassed
      newSets.push({ lang: x.lang, id: x.id, name: x.name,
        cards: src.prepare('SELECT COUNT(*) AS n FROM cards WHERE lang = ? AND set_id = ? AND hidden = 0').get(x.lang, x.id).n });
      newSetKeys.add(k);
    }

    const cardMeta = new Map();   // for naming variant rows
    const newCardsBySet = new Map(), newVariants = [], seenVar = new Set();
    for (const c of src.prepare('SELECT lang, id, set_id, local_id, name, variants_csv FROM cards WHERE hidden = 0 ORDER BY lang, set_id, position, local_id').all()) {
      cardMeta.set(c.lang + '\n' + c.id, c);
      if (newSetKeys.has(c.lang + '\n' + c.set_id)) continue;   // travels with its new set
      const local = localCards.get(c.lang + '\n' + c.id);
      if (!local) {
        const k = c.lang + '\n' + c.set_id;
        if (!newCardsBySet.has(k)) newCardsBySet.set(k, { lang: c.lang, set: c.set_id, setName: setNames.get(k) || c.set_id, cards: [] });
        newCardsBySet.get(k).cards.push({ id: c.id, localId: c.local_id, name: c.name });
        continue;
      }
      // existing card — printings the master has that this install lacks.
      // A tombstoned printing counts as present, so it is never re-offered.
      const localVars = new Set(splitVars(local.variants_csv));
      for (const v of splitVars(c.variants_csv)) {
        const vk = c.lang + '\n' + c.id + '\n' + v;
        if (!localVars.has(v) && !localPrints.has(vk) && !seenVar.has(vk)) {
          seenVar.add(vk);
          newVariants.push({ lang: c.lang, card: c.id, localId: c.local_id, name: c.name, set: c.set_id, variant: v });
        }
      }
    }
    let mPrints;
    try { mPrints = src.prepare('SELECT lang, card_id, variant, label, hidden FROM printings').all(); }
    catch { mPrints = src.prepare('SELECT lang, card_id, variant, label FROM printings').all(); }
    for (const pr of mPrints) {
      if (pr.hidden) continue;
      const vk = pr.lang + '\n' + pr.card_id + '\n' + pr.variant;
      if (localPrints.has(vk) || seenVar.has(vk)) continue;
      const meta = cardMeta.get(pr.lang + '\n' + pr.card_id);
      if (!meta || !localCards.has(pr.lang + '\n' + pr.card_id)) continue;   // arrives with its card
      if (newSetKeys.has(pr.lang + '\n' + meta.set_id)) continue;
      seenVar.add(vk);
      newVariants.push({ lang: pr.lang, card: pr.card_id, localId: meta.local_id, name: meta.name, set: meta.set_id, variant: pr.variant, label: pr.label || undefined });
    }
    const newCards = [...newCardsBySet.values()];
    const additions = newSets.length + newCards.reduce((a, g) => a + g.cards.length, 0) + newVariants.length;
    return { version, additions, newSets, newCards, newVariants };
  } finally {
    if (src) { try { src.close(); } catch { /* already closed */ } }
    try { fs.rmSync(tmp, { force: true }); } catch { /* temp */ }
  }
}

/** Background job: pull the catalog from a remote database into this DB. */
function startCatalogPull(source, bypass) {
  build = { running: true, phase: 'import', startedAt: Date.now(), error: null, hashesOk: null, log: [] };
  pushLog('Loading the card database from ' + source.base + (source.api ? ' (card API)' : ''));
  const progress = { startedAt: new Date().toISOString(), catalogPull: true, setsDone: 0, setTotal: 0, setName: null, done: false, error: null };
  const write = (extra) => { Object.assign(progress, extra); try { writeJSONAtomic(PROGRESS_FILE, progress); } catch { /* cosmetic */ } };
  write({});
  importCatalogFromRemote(source, (p) => write(p))
    .then((r) => {
      let skipped = 0;
      if (bypass) { try { skipped = applyBypass(bypass); } catch (e) { pushLog('Review step failed: ' + e.message); } }
      write({ done: true, finishedAt: new Date().toISOString() });
      build.running = false; build.phase = null; build.hashesOk = true;
      pushLog(`Card database loaded: ${r.cards} cards, ${r.sets} sets` + (skipped ? ` — ${skipped} addition(s) bypassed (stored hidden)` : ''));
    })
    .catch((e) => { build.running = false; build.phase = null; build.error = 'Loading the card database failed: ' + e.message + ' (safe to retry)'; write({ error: e.message }); });
}

const catalogStats = () => ({
  cards: _countCards.get().n, sets: _countSets.get().n, printings: _countPrintings.get().n,
});

/* ---------- the scanner index, and the cards the bulk build never sees ----------
 * scan-index.json is produced in one pass over public/cdn (or pulled straight
 * from the bucket). Neither route knows about a card this install invented in
 * the editor, or one whose picture the admin replaced here — so the scanner
 * would look straight past exactly the cards somebody cared enough to add by
 * hand, and say nothing about why.
 *
 * So every card image uploaded here is fingerprinted on the spot and kept in a
 * small overlay next to the settings. The published index is never rewritten —
 * the overlay is merged on the way out, and wins on a shared id because it is
 * the fresher picture. */
const SCAN_ALGO = require('./scripts/card-hash').ALGO;
const loadScanExtras = () => readJSON(SCAN_EXTRA_FILE, {});

/** Remember this install's own fingerprint for one card. */
function rememberScanHash(lang, cardId, hash) {
  const all = loadScanExtras();
  if (!all[lang] || typeof all[lang] !== 'object') all[lang] = {};
  all[lang][cardId] = hash;
  writeJSONAtomic(SCAN_EXTRA_FILE, all);
}

/** Merge this install's fingerprints over a published index. */
function withScanExtras(lang, index) {
  const extra = loadScanExtras()[lang];
  const rows = Array.isArray(index && index.cards) ? index.cards : [];
  if (!extra || !Object.keys(extra).length) return { algo: (index && index.algo) || SCAN_ALGO, cards: rows };
  const merged = rows.filter((r) => !(Array.isArray(r) && extra[r[0]] !== undefined));
  for (const [id, hash] of Object.entries(extra)) merged.push([id, hash]);
  return { algo: (index && index.algo) || SCAN_ALGO, cards: merged };
}

/* ---------- keeping up with the master ----------
 * Checking whether the master has moved on is one tiny request for
 * catalog.json. Doing it only when somebody happens to open the admin panel
 * means an install can sit a month behind and look fine, so the same check
 * also runs on a timer. What happens NEXT is a separate question, because a
 * pull is not a read: master deletions propagate, and additions are supposed
 * to pass under the admin's eye first. So the timer's job is to KNOW, and
 * 'apply' is something you have to ask for. */
const AUTO_UPDATE_MODES = ['off', 'check', 'apply'];
const AUTO_UPDATE_EVERY = 6 * 60 * 60 * 1000;      // six hours
const autoUpdateMode = () => {
  const m = loadSettings().autoUpdate;
  return AUTO_UPDATE_MODES.includes(m) ? m : 'check';
};

/* Who may make an account here. A box on the internet with open registration
 * collects accounts whether or not anyone wanted it to, so this is a decision
 * the install makes rather than one the code makes for it. `open` stays the
 * default because the very first account has to be creatable — and until the
 * setup screen exists, `closed` would lock an empty install out of itself,
 * which is why closed still lets account number one through. */
const REGISTRATION_MODES = ['open', 'closed'];
const registrationMode = () => {
  const m = loadSettings().registration;
  return REGISTRATION_MODES.includes(m) ? m : 'open';
};

/** Is the master ahead of us? One fetch of catalog.json, no card data moved. */
async function masterUpdateStatus() {
  const source = catalogSource();
  if (!source) return { configured: false };
  const local = loadSettings().masterVersion || 0;
  try {
    // through the card API this manifest ping costs 0 against the allowance,
    // so even a spent token still learns whether it is behind — it just can't
    // PULL until the period resets (and the refusal below says exactly that)
    const r = await fetch(source.base + '/catalog.json', { headers: source.headers });
    if (!r.ok) return { configured: true, reachable: false, localVersion: local, refusal: apiRefusal(r.status) };
    const m = await r.json();
    const remote = Number(m.version) || 0;
    return {
      configured: true, reachable: true,
      localVersion: local, remoteVersion: remote,
      behind: remote > local,
      remoteCards: m.cards || null, remoteSets: m.sets || null,
    };
  } catch {
    return { configured: true, reachable: false, localVersion: local };
  }
}

/** The scheduled half: record what we found, and pull only if asked to. */
async function runScheduledUpdateCheck() {
  // an install with no cards at all is tryMasterPull's problem, not this one;
  // the workspace PRODUCES the master, so it never follows one
  if (READONLY || MASTER_MODE || build.running || !catalogSource()) return;
  if (catalogStats().cards === 0) return;
  const mode = autoUpdateMode();
  if (mode === 'off') return;
  let st;
  try { st = await masterUpdateStatus(); } catch { return; }
  const s = loadSettings();
  s.updateCheckedAt = new Date().toISOString();
  s.updateReachable = !!st.reachable;
  if (st.reachable) s.updateRemoteVersion = st.remoteVersion || 0;
  saveSettings(s);
  if (mode !== 'apply' || !st.behind || build.running) return;
  // unattended, so nothing is bypassed — every addition is accepted, which is
  // exactly why this is not the default
  try { startCatalogPull(catalogSource()); }
  catch (e) { console.error('Scheduled master update failed to start: ' + e.message); }
}

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
// every printing of one species, oldest set first — dex_csv is "6" or "6,7",
// so match the whole field or the number as a comma-delimited word inside it
const _cardsOfDex = db.prepare(`SELECT c.* FROM cards c JOIN sets s ON s.lang = c.lang AND s.id = c.set_id
  WHERE c.lang = ? AND c.hidden = 0 AND s.hidden = 0
    AND (',' || c.dex_csv || ',') LIKE ('%,' || ? || ',%')
  ORDER BY s.position, c.position, c.local_id`);
const _cardsOfLang = db.prepare('SELECT id, set_id, local_id, name, rarity, category, dex_csv, types_csv, variants_csv, img_low, img_high FROM cards WHERE lang = ? AND hidden = 0 ORDER BY position');
const _printsOfCard = db.prepare('SELECT variant, label, img_low, img_high, hidden FROM printings WHERE lang = ? AND card_id = ?');
const _printsOfLang = db.prepare('SELECT card_id, variant, label, img_low, img_high, hidden FROM printings WHERE lang = ?');

const langsAvailable = () => { const r = _langsDistinct.all().map((x) => x.lang); return r.length ? r : ['en']; };
const emitLanguages = () => ({ languages: langsAvailable().map((code) => ({ code, name: LANG_NAMES[code] || code })) });

function printingMaps(rows) {
  const printings = {}, variantImages = {}, removed = [];
  for (const p of rows || []) {
    if (p.hidden) { removed.push(p.variant); continue; }   // soft-removal tombstone
    if (p.label) printings[p.variant] = p.label;
    if (p.img_low || p.img_high) variantImages[p.variant] = { low: p.img_low || null, high: p.img_high || null };
  }
  return { printings, variantImages, removed };
}
// The order collectors read a card's printings in, and the same order the card
// page shows them in — a filled binder should run the way the card page does.
const VARIANT_ORDER = ['normal', 'holo', 'reverse', 'firstEdition', 'wPromo'];

/** Every printing of a card that actually exists right now: its base variants
 * minus anything soft-removed, plus the admin-defined custom ones. This mirrors
 * realVariants() in the client and the two have to agree — a pocket made for a
 * printing the card page says doesn't exist could never be ticked off. */
function printingsOf(lang, card) {
  const rows = _printsOfCard.all(lang, card.id);
  const tombs = new Set(rows.filter((r) => r.hidden).map((r) => r.variant));
  const base = (card.variants_csv == null ? ['normal'] : card.variants_csv.split(','))
    .filter(Boolean).filter((v) => !tombs.has(v));
  const out = VARIANT_ORDER.filter((v) => base.includes(v));
  for (const v of base) if (!out.includes(v)) out.push(v);           // an unrecognised one still counts
  for (const r of rows) if (!r.hidden && !out.includes(r.variant)) out.push(r.variant);
  // a card whose normal printing was removed but which keeps a custom one must
  // not have "normal" resurrected — only a card with nothing at all falls back
  return out.length ? out : ['normal'];
}

function cardObj(c, maps, lean) {
  const variants = {};
  (c.variants_csv == null ? ['normal'] : c.variants_csv.split(',')).forEach((v) => { if (v) variants[v] = true; });
  for (const k of maps.removed || []) delete variants[k];
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
const _printingHide = db.prepare(`INSERT INTO printings (lang, card_id, variant, hidden, source) VALUES (?,?,?, 1, 'local')
  ON CONFLICT(lang, card_id, variant) DO UPDATE SET hidden = 1, source = 'local'`);
const _setHide = db.prepare("UPDATE sets SET hidden = ?, source = 'local' WHERE lang = ? AND id = ?");
const _hideCardsOfSet = db.prepare("UPDATE cards SET hidden = 1, source = 'local' WHERE lang = ? AND set_id = ?");
const _unhideCardsOfSet = db.prepare("UPDATE cards SET hidden = 0 WHERE lang = ? AND set_id = ? AND hidden = 1 AND source = 'local'");
const _hiddenSets = db.prepare('SELECT id, name FROM sets WHERE lang = ? AND hidden = 1 ORDER BY position, id');
const _allPrints = db.prepare('SELECT variant, hidden FROM printings WHERE lang = ? AND card_id = ?');
const _printingUnhide = db.prepare("UPDATE printings SET hidden = 0, source = 'local' WHERE lang = ? AND card_id = ? AND variant = ? AND hidden = 1");
const _hiddenOfSet = db.prepare('SELECT id, local_id, name FROM cards WHERE lang = ? AND set_id = ? AND hidden = 1 ORDER BY position, local_id');
const _setCardBaseImg = db.prepare("UPDATE cards SET img_low = ?, img_high = ?, source = 'local' WHERE lang = ? AND id = ?");
const _localPrintingLabel = db.prepare(`INSERT INTO printings (lang, card_id, variant, label, source) VALUES (?,?,?,?, 'local')
  ON CONFLICT(lang, card_id, variant) DO UPDATE SET label = excluded.label, source = 'local', hidden = 0`);
const _localPrintingImg = db.prepare(`INSERT INTO printings (lang, card_id, variant, img_low, img_high, source) VALUES (?,?,?,?,?, 'local')
  ON CONFLICT(lang, card_id, variant) DO UPDATE SET img_low = excluded.img_low, img_high = excluded.img_high, source = 'local', hidden = 0`);
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
  // a write that arrived on somebody else's say-so, carrying our cookie
  if (crossSiteWrite(req)) return sendJSON(res, 403, { error: 'Cross-site request refused' });

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
      remoteCatalog: (catalogSource() || {}).base || null,
      catalogViaApi: !!catalogApi(),
      masterVersion: s.masterVersion || null,
      masterPulledAt: s.masterPulledAt || null,
      autoUpdate: autoUpdateMode(),
      mailConfigured: mailConfigured(),
      oidc: oidcConfigured() ? { label: oidcSettings().label } : null,
      registration: registrationMode(),
      minPassword: MIN_PASSWORD,
      updateCheckedAt: s.updateCheckedAt || null,
      updateRemoteVersion: s.updateRemoteVersion || null,
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

  // hidden (bypassed) sets — lets the admin see and restore them
  if (pathname === '/api/hidden-sets' && req.method === 'GET') {
    const hUser = authUser(req);
    if (!hUser || !isAdminUser(hUser)) return sendJSON(res, 403, { error: 'Administrator account required' });
    const qLang = LANG_RE.test(url.searchParams.get('lang') || '') ? url.searchParams.get('lang') : 'en';
    return sendJSON(res, 200, { sets: _hiddenSets.all(qLang).map((x) => ({ id: x.id, name: x.name })) });
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
    if (fs.existsSync(localFile)) return sendJSON(res, 200, withScanExtras(lang, readJSON(localFile, { cards: [] })));
    // No local scanner index (this install pulled the master rather than
    // building locally) — fetch the published one and cache it to disk so
    // the scanner works on pulled-only installs too. Through the card API
    // when configured (/v1/scan-index), straight off the bucket otherwise.
    const api = catalogApi();
    const base = api ? null : configCdnBase();
    if (api || base) {
      try {
        const r = api
          ? await fetch(`${api.base}/scan-index?lang=${encodeURIComponent(lang)}`, { headers: api.headers })
          : await fetch(`${base}/${lang}/scan-index.json`);
        if (r.ok) {
          const data = await r.json();
          try { fs.mkdirSync(path.dirname(localFile), { recursive: true }); writeJSONAtomic(localFile, data); } catch { /* cache is best-effort */ }
          // the cached copy stays exactly as published; this install's own
          // cards are merged on the way out, never written into the master's file
          return sendJSON(res, 200, withScanExtras(lang, data));
        }
      } catch { /* fall through to empty */ }
    }
    // even with no index at all, a card added here is still scannable
    return sendJSON(res, 200, withScanExtras(lang, { algo: SCAN_ALGO, cards: [] }));
  }

  // admin: rebuild the whole scanner index from the images on this server.
  // Only meaningful where those images exist — a pulled-only install serves
  // the master's index and gets its own cards from the overlay instead.
  if (pathname === '/api/scan-index/rebuild' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    const rbUser = authUser(req);
    if (!rbUser || !isAdminUser(rbUser)) return sendJSON(res, 403, { error: 'Administrator account required' });
    if (build.running) return sendJSON(res, 409, { error: 'Another job is already running' });
    if (!dbExists()) {
      return sendJSON(res, 400, { error: 'There are no card images on this server to hash. Cards you add here are fingerprinted as you upload their pictures, so the scanner already knows them.' });
    }
    try { require.resolve('sharp'); } catch {
      return sendJSON(res, 501, { error: 'Rebuilding the scanner index needs the sharp package on the server: npm install --no-save sharp' });
    }
    build = { running: true, phase: 'hashes', startedAt: Date.now(), error: null, hashesOk: null, log: [] };
    runHashes();
    return sendJSON(res, 200, { ok: true, started: true });
  }

  // does the master have a newer database than this install? (cheap ping of
  // catalog.json — no card data moves until the admin actually updates)
  if (pathname === '/api/catalog/update-check' && req.method === 'GET') {
    // same answer the scheduled check records, asked on demand
    const st = await masterUpdateStatus();
    if (st.configured && st.reachable) {
      const s = loadSettings();
      s.updateCheckedAt = new Date().toISOString();
      s.updateReachable = true;
      s.updateRemoteVersion = st.remoteVersion || 0;
      saveSettings(s);
    }
    return sendJSON(res, 200, st);
  }

  // admin: how this install keeps up with the master — know only, or apply
  if (pathname === '/api/auto-update' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    // `user` is not bound this early in handleApi — ask for it directly
    const auUser = authUser(req);
    if (!auUser || !isAdminUser(auUser)) return sendJSON(res, 403, { error: 'Administrator account required' });
    const body = await readBody(req);
    if (!AUTO_UPDATE_MODES.includes(body.mode)) {
      return sendJSON(res, 400, { error: 'mode must be one of: ' + AUTO_UPDATE_MODES.join(', ') });
    }
    const s = loadSettings();
    s.autoUpdate = body.mode;
    saveSettings(s);
    return sendJSON(res, 200, { ok: true, autoUpdate: body.mode });
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
    const source = catalogSource();
    if (!source) return sendJSON(res, 400, { error: 'No card source is configured — set PTCG_API_BASE (+ PTCG_API_TOKEN), or cdnBase in public/config.js' });
    // optional reviewed additions to bypass (from /api/catalog/preview):
    // bypassed items still land in the table, just hidden + source='local'
    const body = await readBody(req);
    const bp = body && body.bypass && typeof body.bypass === 'object' && !Array.isArray(body.bypass) ? body.bypass : null;
    const bypass = bp ? {
      sets: (Array.isArray(bp.sets) ? bp.sets : []).filter((x) => x && LANG_RE.test(x.lang || '') && SET_ID_RE.test(x.id || '')).map((x) => ({ lang: x.lang, id: x.id })).slice(0, 5000),
      cards: (Array.isArray(bp.cards) ? bp.cards : []).filter((x) => x && LANG_RE.test(x.lang || '') && CARD_ID_RE.test(x.id || '')).map((x) => ({ lang: x.lang, id: x.id })).slice(0, 20000),
      variants: (Array.isArray(bp.variants) ? bp.variants : []).filter((x) => x && LANG_RE.test(x.lang || '') && CARD_ID_RE.test(x.card || '') && VARIANT_KEY_RE.test(x.variant || '')).map((x) => ({ lang: x.lang, card: x.card, variant: x.variant })).slice(0, 20000),
    } : null;
    startCatalogPull(source, bypass);
    return sendJSON(res, 200, { ok: true, started: true, source: source.base });
  }

  // what a master update would ADD — the admin reviews this before pulling
  if (pathname === '/api/catalog/preview' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    const admin = authUser(req);
    if (!admin || !isAdminUser(admin)) return sendJSON(res, 403, { error: 'Administrator account required' });
    if (build.running) return sendJSON(res, 409, { error: 'Another job is already running' });
    const source = catalogSource();
    if (!source) return sendJSON(res, 400, { error: 'No card source is configured — set PTCG_API_BASE (+ PTCG_API_TOKEN), or cdnBase in public/config.js' });
    try { return sendJSON(res, 200, await previewRemoteAdditions(source)); }
    catch (e) { return sendJSON(res, 502, { error: 'Could not read the master database: ' + e.message }); }
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

  /* ---------- first run ----------
   * An install with no accounts hands the first person to arrive the keys, and
   * on a public address that person is whoever finds it first. So setup is
   * gated by a token the server prints to its own console at boot — you have
   * to be able to read the container log to claim the install, which is the
   * one thing a stranger cannot do. Once an account exists, all of this is
   * closed and stays closed. */
  if (pathname === '/api/setup/status' && req.method === 'GET') {
    return sendJSON(res, 200, {
      needed: userCount() === 0,
      mailConfigured: mailConfigured(),
      mailPossible: nodemailerAvailable(),
    });
  }

  if (pathname === '/api/setup' && req.method === 'POST') {
    if (rateLimited(ip, 'setup', 20, 10 * 60 * 1000)) return sendJSON(res, 429, { error: 'Too many attempts, try again later' });
    if (userCount() > 0) return sendJSON(res, 409, { error: 'This install has already been set up' });
    const body = await readBody(req);
    // constant-time, so the answer cannot be found one character at a time
    const given = Buffer.from(String(body.token || ''));
    const want = Buffer.from(setupToken());
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      return sendJSON(res, 403, { error: 'That setup code is not right. It is printed in this server’s log when it starts.' });
    }
    if (!USERNAME_RE.test(body.username || '')) return sendJSON(res, 400, { error: 'Username must be 3-30 letters, numbers or underscores' });
    if (typeof body.password !== 'string' || body.password.length < MIN_PASSWORD) {
      return sendJSON(res, 400, { error: `Password must be at least ${MIN_PASSWORD} characters` });
    }
    const email = typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null;
    if (email && !EMAIL_RE.test(email)) return sendJSON(res, 400, { error: 'That does not look like an email address' });
    const s = loadSettings();
    if (REGISTRATION_MODES.includes(body.registration)) s.registration = body.registration;
    if (body.smtp && typeof body.smtp === 'object') {
      s.smtp = {
        host: String(body.smtp.host || '').trim(),
        port: parseInt(body.smtp.port, 10) || 587,
        secure: !!body.smtp.secure,
        user: String(body.smtp.user || '').trim(),
        pass: String(body.smtp.pass || ''),
        from: String(body.smtp.from || '').trim(),
      };
    }
    if (typeof body.publicUrl === 'string' && body.publicUrl.trim()) s.publicUrl = body.publicUrl.trim().replace(/\/+$/, '');
    saveSettings(s);
    const salt = crypto.randomBytes(16).toString('hex');
    const admin = {
      id: crypto.randomUUID(), username: body.username.toLowerCase(), display: body.username, salt,
      hash: await hashPassword(body.password, salt), created: new Date().toISOString(),
      admin: true, email, emailVerified: false,
    };
    try { createUser(admin); }
    catch { return sendJSON(res, 409, { error: 'Username already taken' }); }
    _setupToken = null;                      // spent: the log line is now useless
    if (email && mailConfigured()) sendVerificationMail(req, admin).catch(() => { /* the account exists either way */ });
    return sendSession(req, res, admin);
  }

  if (pathname === '/api/register' && req.method === 'POST') {
    if (rateLimited(ip, 'auth', 20, 10 * 60 * 1000)) return sendJSON(res, 429, { error: 'Too many attempts, try again later' });
    const { username, password, email: rawEmail } = await readBody(req);
    // who may sign up at all — a server anyone can reach is a server anyone
    // can fill with accounts, so this is a choice the install makes
    const mode = registrationMode();
    if (mode === 'closed' && userCount() > 0) {
      return sendJSON(res, 403, { error: 'This server is not accepting new accounts' });
    }
    if (!USERNAME_RE.test(username || '')) return sendJSON(res, 400, { error: 'Username must be 3-30 letters, numbers or underscores' });
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
      return sendJSON(res, 400, { error: `Password must be at least ${MIN_PASSWORD} characters` });
    }
    // Optional, and only worth asking for where the install can actually send
    // mail. Unverified until the link is opened — an address nobody has proved
    // they own is somebody else's address.
    const email = typeof rawEmail === 'string' && rawEmail.trim() ? rawEmail.trim() : null;
    if (email && !EMAIL_RE.test(email)) return sendJSON(res, 400, { error: 'That does not look like an email address' });
    if (email && getUserByEmail(email)) return sendJSON(res, 409, { error: 'That email address is already in use' });
    const key = username.toLowerCase();
    if (getUserByName(key)) return sendJSON(res, 409, { error: 'Username already taken' });
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: crypto.randomUUID(),
      username: key,
      display: username,
      salt,
      hash: await hashPassword(password, salt),
      created: new Date().toISOString(),
      admin: userCount() === 0, // first account = administrator
      email,
      emailVerified: false,
    };
    try {
      createUser(user);
    } catch {
      return sendJSON(res, 409, { error: 'Username already taken' }); // UNIQUE race
    }
    // the account is made either way; a mail server having a bad day is not a
    // reason to refuse somebody an account they just created
    if (email && mailConfigured()) sendVerificationMail(req, user).catch((e) => console.error('Verification mail failed: ' + e.message));
    return sendSession(req, res, user);
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    if (rateLimited(ip, 'auth', 20, 10 * 60 * 1000)) return sendJSON(res, 429, { error: 'Too many attempts, try again later' });
    const { username, password } = await readBody(req);
    const key = (username || '').toLowerCase();
    const user = getUserByName(key);
    const bad = () => sendJSON(res, 401, { error: 'Invalid username or password' });
    // the account itself is throttled, not only the address asking
    if (key && loginLocked(key)) {
      return sendJSON(res, 429, { error: 'Too many failed attempts for this account. Try again in a few minutes.' });
    }
    if (!user || typeof password !== 'string') { if (key) noteLoginFailure(key); return bad(); }
    if (!(await verifyPassword(password, user.salt, user.hash))) { noteLoginFailure(key); return bad(); }
    clearLoginFailures(key);
    // right password on an old hash: rewrite it before the token is cut, so
    // the token is bound to the hash the account will actually have
    const settled = await upgradeHashIfStale(user, password);
    // the password was one of two things asked for
    if (settled.totpEnabled) {
      return sendJSON(res, 200, { needTotp: true, ticket: issueTotpTicket(settled), username: settled.display });
    }
    return sendSession(req, res, settled);
  }

  /* The second step. A wrong code here counts against the same account lock as
   * a wrong password: an attacker who has the password and is guessing six
   * digits is exactly who this is for. */
  if (pathname === '/api/login/totp' && req.method === 'POST') {
    if (rateLimited(ip, 'auth', 20, 10 * 60 * 1000)) return sendJSON(res, 429, { error: 'Too many attempts, try again later' });
    const body = await readBody(req);
    const who = redeemTotpTicket(body.ticket);
    if (!who) return sendJSON(res, 401, { error: 'That sign-in took too long. Start again.' });
    if (loginLocked(who.username)) {
      return sendJSON(res, 429, { error: 'Too many failed attempts for this account. Try again in a few minutes.' });
    }
    if (typeof body.recoveryCode === 'string' && body.recoveryCode.trim()) {
      if (!redeemRecoveryCode(who.id, body.recoveryCode)) {
        noteLoginFailure(who.username);
        return sendJSON(res, 401, { error: 'That recovery code is not valid, or has already been used.' });
      }
      clearLoginFailures(who.username);
      return sendSession(req, res, who);
    }
    const code = String(body.code || '').replace(/\s/g, '');
    if (!totpMatches(who.totpSecret, code) || totpAlreadyUsed(who.id, code)) {
      noteLoginFailure(who.username);
      return sendJSON(res, 401, { error: 'That code is not right, or has already been used.' });
    }
    clearLoginFailures(who.username);
    return sendSession(req, res, who);
  }

  /* ---- starting a sign-in with the provider ----
   * A GET, because the browser is about to be sent somewhere. `link` means
   * "attach this identity to the account I am already signed into" rather
   * than "sign me in", and the difference is carried in the flow cookie so
   * the callback cannot be talked into the wrong one.
   */
  if (pathname === '/api/oidc/start' && req.method === 'GET') {
    if (!oidcConfigured()) return sendJSON(res, 400, { error: 'No identity provider is configured' });
    let doc;
    try { doc = await oidcDiscover(); }
    catch (e) { return sendJSON(res, 502, { error: e.message }); }
    const cfg = oidcSettings();
    const linking = url.searchParams.get('mode') === 'link';
    const me = linking ? authUser(req) : null;
    if (linking && !me) return sendJSON(res, 401, { error: 'Sign in first, then link' });

    const state = crypto.randomBytes(24).toString('base64url');
    const nonce = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const authUrl = new URL(doc.authorization_endpoint);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: cfg.clientId,
      redirect_uri: oidcRedirectUri(req),
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })) authUrl.searchParams.set(k, v);

    res.writeHead(302, {
      Location: authUrl.toString(),
      'Cache-Control': 'no-store',
      'Set-Cookie': oidcFlowCookie(req, { state, nonce, verifier, link: linking ? me.id : null }),
    });
    return res.end();
  }

  if (pathname === '/api/oidc/callback' && req.method === 'GET') {
    const flow = verifySigned(cookieOf(req, OIDC_COOKIE));
    const fail = (why) => oidcDone(res, req, '#/signin-failed?why=' + encodeURIComponent(why), null);
    if (!flow) return fail('That sign-in took too long. Try again.');
    // state ties this answer to the request that started it
    const given = String(url.searchParams.get('state') || '');
    const a = Buffer.from(given), b = Buffer.from(flow.state);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail('That sign-in did not start here.');
    if (url.searchParams.get('error')) return fail(url.searchParams.get('error_description') || url.searchParams.get('error'));
    const code = url.searchParams.get('code');
    if (!code) return fail('The provider sent no code.');

    let claims;
    try {
      const tokens = await oidcExchange(req, code, flow.verifier);
      claims = await verifyIdToken(tokens.id_token, { nonce: flow.nonce });
    } catch (e) { return fail(e.message); }

    const cfg = oidcSettings();
    const existing = rowToUser(_getUserByOidc.get(claims.iss, claims.sub));

    // linking: attach this identity to the account that asked for it
    if (flow.link) {
      const me = getUserById(flow.link);
      if (!me) return fail('That account is gone.');
      if (existing && existing.id !== me.id) return fail('That identity is already attached to another account.');
      _setUserOidc.run(claims.iss, claims.sub, me.id);
      return oidcDone(res, req, '#/linked', sessionCookie(req, issueToken(me)));
    }

    if (existing) {
      // a second factor is a second factor, whoever vouched for the first
      if (existing.totpEnabled) {
        return oidcDone(res, req, '#/signin-2fa?ticket=' + encodeURIComponent(issueTotpTicket(existing)), null);
      }
      return oidcDone(res, req, '#/signed-in', sessionCookie(req, issueToken(existing)));
    }

    if (cfg.unknown !== 'create') {
      return fail('That identity is not attached to any account here. Sign in with your password first, then link it from your account.');
    }

    // making an account for somebody the provider vouches for
    const base = String(claims.preferred_username || claims.email || claims.sub).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24) || 'user';
    let username = base.length >= 3 ? base : `user${base}`;
    for (let i = 2; getUserByName(username); i++) username = `${base}${i}`.slice(0, 30);
    const salt = crypto.randomBytes(16).toString('hex');
    const fresh = {
      id: crypto.randomUUID(), username, display: claims.name || claims.preferred_username || username, salt,
      // no password: this account is reached through the provider
      hash: await hashPassword(crypto.randomBytes(32).toString('hex'), salt),
      created: new Date().toISOString(), admin: userCount() === 0,
      email: claims.email && claims.email_verified ? claims.email : null,
      emailVerified: !!(claims.email && claims.email_verified),
    };
    try { createUser(fresh); } catch { return fail('Could not create an account for that identity.'); }
    _setUserOidc.run(claims.iss, claims.sub, fresh.id);
    return oidcDone(res, req, '#/signed-in', sessionCookie(req, issueToken(fresh)));
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    // the cookie is httpOnly, so only the server can take it away
    return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
  }

  // ---- confirming an address ----
  if (pathname === '/api/verify-email' && req.method === 'POST') {
    if (rateLimited(ip, 'token', 30, 10 * 60 * 1000)) return sendJSON(res, 429, { error: 'Too many attempts, try again later' });
    const body = await readBody(req);
    const who = redeemEmailToken(body.token, 'verify');
    if (!who) return sendJSON(res, 400, { error: 'That confirmation link has already been used, or it has expired. Ask for a new one from your account.' });
    _markEmailVerified.run(who.id);
    return sendJSON(res, 200, { ok: true, username: who.display });
  }

  /* ---- forgetting a password ----
   * The reply never varies. Saying "no such address" here would turn this
   * endpoint into a way to ask which of a list of addresses has an account,
   * which is worth more to a stranger than it is to the person who genuinely
   * forgot. Unverified addresses get nothing sent either — mail to an address
   * nobody proved they own is mail to somebody else. */
  if (pathname === '/api/forgot-password' && req.method === 'POST') {
    if (rateLimited(ip, 'forgot', 10, 15 * 60 * 1000)) return sendJSON(res, 429, { error: 'Too many attempts, try again later' });
    const body = await readBody(req);
    const sameAnswer = { ok: true, message: 'If that address belongs to a confirmed account, a reset link is on its way.' };
    const who = typeof body.email === 'string' ? getUserByEmail(body.email) : null;
    if (who && who.emailVerified && mailConfigured()) {
      try { await sendResetMail(req, who); }
      catch (e) { console.error('Password reset mail failed: ' + e.message); }
    }
    return sendJSON(res, 200, sameAnswer);
  }

  if (pathname === '/api/reset-password' && req.method === 'POST') {
    if (rateLimited(ip, 'token', 30, 10 * 60 * 1000)) return sendJSON(res, 429, { error: 'Too many attempts, try again later' });
    const body = await readBody(req);
    if (typeof body.newPassword !== 'string' || body.newPassword.length < MIN_PASSWORD) {
      return sendJSON(res, 400, { error: `Password must be at least ${MIN_PASSWORD} characters` });
    }
    const who = redeemEmailToken(body.token, 'reset');
    if (!who) return sendJSON(res, 400, { error: 'That reset link has already been used, or it has expired. Ask for a new one.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await hashPassword(body.newPassword, salt);
    _updateUserHash.run(salt, hash, who.id);
    // a reset is also how you throw out whoever might already be in: every
    // token issued against the old hash stops matching the moment it changes
    _dropTokensOf.run(who.id, 'reset');
    clearLoginFailures(who.username);
    const token = issueToken({ id: who.id, hash });
    return sendJSON(res, 200, { ok: true, token, username: who.display }, { 'Set-Cookie': sessionCookie(req, token) });
  }

  /* ---- a binder somebody chose to hand out ----
   * Deliberately on this side of the sign-in gate: the whole point is that a
   * link works for a person who has no account here. What comes back is the
   * binder and the name of whoever shared it, and nothing else — not the
   * binder's real id, not the owner's address, not their other binders. The
   * token is the entire credential, so it is 80 bits of it. */
  const sharedMatch = pathname.match(/^\/api\/shared\/([a-f0-9]{20})$/);
  if (sharedMatch && req.method === 'GET') {
    // guessing this is hopeless, but a wrong link should not be free either
    if (rateLimited(ip, 'shared', 120, 10 * 60 * 1000)) return sendJSON(res, 429, { error: 'Too many requests, try again later' });
    const row = _binderByShare.get(sharedMatch[1]);
    if (!row) return sendJSON(res, 404, { error: 'That link does not lead anywhere — it may have been turned off, or replaced with a new one.' });
    const showHave = row.share_have !== 0;
    const slots = JSON.parse(row.slots);
    // stripped here rather than merely undrawn: a browser is the visitor's to
    // inspect, so anything this answer carries is published whatever the app
    // chooses to do with it
    if (!showHave) {
      for (const k of Object.keys(slots)) {
        if (slots[k] && slots[k].card) { delete slots[k].have; delete slots[k].n; }
      }
    }
    return sendJSON(res, 200, {
      owner: row.owner, showHave,
      binder: { name: row.name, size: row.size, color: row.color, pages: row.pages,
        slots, cover: row.cover ? JSON.parse(row.cover) : null },
    });
  }

  // authenticated routes
  const user = authUser(req);
  if (!user) return sendJSON(res, 401, { error: 'Not signed in' });

  if (pathname === '/api/me' && req.method === 'GET') {
    return sendJSON(res, 200, {
      username: user.display, admin: isAdminUser(user),
      email: user.email, emailVerified: user.emailVerified,
      totpEnabled: user.totpEnabled,
      recoveryLeft: user.totpEnabled ? _countRecovery.get(user.id).n : 0,
      oidcLinked: !!user.oidcSub,
    });
  }

  /* ---- the address on this account ----
   * Only settable at registration until now, so every account older than that
   * feature has none and no way back in if the password goes. Changing it
   * needs the password: the address IS the recovery path, so quietly moving
   * it is quietly taking the account. A new address starts unconfirmed, which
   * means the old one stops working for resets and the new one does not start
   * until somebody proves they can read it. */
  if (pathname === '/api/email' && req.method === 'POST') {
    if (rateLimited(ip, 'email', 10, 15 * 60 * 1000)) return sendJSON(res, 429, { error: 'Too many attempts, try again later' });
    const body = await readBody(req);
    if (!(await verifyPassword(body.password, user.salt, user.hash))) {
      return sendJSON(res, 401, { error: 'Current password is incorrect' });
    }
    const addr = typeof body.email === 'string' ? body.email.trim() : '';
    if (!addr) {                                   // clearing it is allowed, and means no resets
      _setUserEmail.run(null, 0, user.id);
      _dropTokensOf.run(user.id, 'verify');
      return sendJSON(res, 200, { ok: true, email: null, emailVerified: false });
    }
    if (!EMAIL_RE.test(addr)) return sendJSON(res, 400, { error: 'That does not look like an email address' });
    const taken = getUserByEmail(addr);
    if (taken && taken.id !== user.id) return sendJSON(res, 409, { error: 'That email address is already in use' });
    const same = user.email && user.email.toLowerCase() === addr.toLowerCase();
    _setUserEmail.run(addr, same && user.emailVerified ? 1 : 0, user.id);
    let sent = false;
    if (!(same && user.emailVerified) && mailConfigured()) {
      try { await sendVerificationMail(req, { ...user, email: addr }); sent = true; }
      catch (e) { console.error('Verification mail failed: ' + e.message); }
    }
    return sendJSON(res, 200, { ok: true, email: addr, emailVerified: !!(same && user.emailVerified), sent });
  }

  if (pathname === '/api/email/resend' && req.method === 'POST') {
    if (rateLimited(ip, 'email', 10, 15 * 60 * 1000)) return sendJSON(res, 429, { error: 'Too many attempts, try again later' });
    if (!user.email) return sendJSON(res, 400, { error: 'There is no address on this account yet' });
    if (user.emailVerified) return sendJSON(res, 400, { error: 'That address is already confirmed' });
    if (!mailConfigured()) return sendJSON(res, 400, { error: 'This server has no mail server configured' });
    try { await sendVerificationMail(req, user); }
    catch (e) { return sendJSON(res, 502, { error: 'Could not send it: ' + e.message }); }
    return sendJSON(res, 200, { ok: true });
  }

  /* ---- unlinking, and what the account page shows ---- */
  if (pathname === '/api/oidc/unlink' && req.method === 'POST') {
    const body = await readBody(req);
    // the password, because unlinking is a change to how the account is reached
    if (!(await verifyPassword(body.password, user.salt, user.hash))) {
      return sendJSON(res, 401, { error: 'Current password is incorrect' });
    }
    _setUserOidc.run(null, null, user.id);
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/oidc-settings' && req.method === 'GET') {
    if (!isAdminUser(user)) return sendJSON(res, 403, { error: 'Administrator account required' });
    const cfg = oidcSettings();
    const e = process.env;
    return sendJSON(res, 200, {
      issuer: cfg.issuer, clientId: cfg.clientId, label: cfg.label, unknown: cfg.unknown,
      secretSet: !!cfg.clientSecret,
      redirectUri: oidcRedirectUri(req),
      fromEnvironment: !!(e.PTCG_OIDC_ISSUER || e.PTCG_OIDC_CLIENT_ID || e.PTCG_OIDC_CLIENT_SECRET),
    });
  }

  if (pathname === '/api/oidc-settings' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    if (!isAdminUser(user)) return sendJSON(res, 403, { error: 'Administrator account required' });
    const body = await readBody(req);
    const s2 = loadSettings();
    const prev = (s2.oidc && typeof s2.oidc === 'object') ? s2.oidc : {};
    s2.oidc = {
      issuer: String(body.issuer || '').trim().replace(/\/+$/, ''),
      clientId: String(body.clientId || '').trim(),
      // blank means keep, same reasoning as the mail password
      clientSecret: typeof body.clientSecret === 'string' && body.clientSecret ? body.clientSecret : (prev.clientSecret || ''),
      label: String(body.label || '').trim() || 'single sign-on',
      unknown: ['link', 'create'].includes(body.unknown) ? body.unknown : 'link',
    };
    saveSettings(s2);
    Object.assign(_oidcCache, { doc: null, docAt: 0, jwks: null, jwksAt: 0, issuer: '' });
    return sendJSON(res, 200, { ok: true, configured: oidcConfigured() });
  }

  /** Ask the provider who it says it is — a way to check a URL before trusting it. */
  if (pathname === '/api/oidc-settings/probe' && req.method === 'POST') {
    if (!isAdminUser(user)) return sendJSON(res, 403, { error: 'Administrator account required' });
    try {
      const doc = await oidcDiscover();
      const keys = await oidcKeys(true);
      return sendJSON(res, 200, { ok: true, issuer: doc.issuer, keys: keys.length,
        authorization: !!doc.authorization_endpoint, token: !!doc.token_endpoint });
    } catch (e) { return sendJSON(res, 502, { error: e.message }); }
  }

  /* ---- the mail server this install sends through ----
   * The setup screen asks for this once, which does nothing for an install
   * that was already running when mail arrived. The password is write-only:
   * it goes in and is never handed back, so a borrowed session cannot read
   * the credentials out of the settings it is allowed to change. */
  if (pathname === '/api/mail-settings' && req.method === 'GET') {
    if (!isAdminUser(user)) return sendJSON(res, 403, { error: 'Administrator account required' });
    const cfg = mailSettings();
    const env = process.env;
    return sendJSON(res, 200, {
      host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, from: cfg.from,
      passwordSet: !!cfg.pass,
      publicUrl: publicBase(req),
      // an install told by its environment cannot be argued with from here
      fromEnvironment: !!(env.PTCG_SMTP_HOST || env.PTCG_SMTP_USER || env.PTCG_SMTP_PASS),
      packageAvailable: nodemailerAvailable(),
    });
  }

  if (pathname === '/api/mail-settings' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    if (!isAdminUser(user)) return sendJSON(res, 403, { error: 'Administrator account required' });
    const body = await readBody(req);
    const s = loadSettings();
    const prev = (s.smtp && typeof s.smtp === 'object') ? s.smtp : {};
    const port = parseInt(body.port, 10) || 587;
    s.smtp = {
      host: String(body.host || '').trim(),
      port,
      secure: body.secure === undefined ? port === 465 : !!body.secure,
      user: String(body.user || '').trim(),
      // blank means "leave it alone" — the form never had the old one to show
      pass: typeof body.pass === 'string' && body.pass ? body.pass : (prev.pass || ''),
      from: String(body.from || '').trim(),
    };
    if (typeof body.publicUrl === 'string') s.publicUrl = body.publicUrl.trim().replace(/\/+$/, '');
    saveSettings(s);
    return sendJSON(res, 200, { ok: true, mailConfigured: mailConfigured() });
  }

  /* Sending one on demand, because the alternative way to find out that the
   * settings are wrong is somebody failing to reset their password. */
  if (pathname === '/api/mail-test' && req.method === 'POST') {
    if (!isAdminUser(user)) return sendJSON(res, 403, { error: 'Administrator account required' });
    if (rateLimited(ip, 'mailtest', 10, 15 * 60 * 1000)) return sendJSON(res, 429, { error: 'Too many attempts, try again later' });
    const body = await readBody(req);
    const to = (typeof body.to === 'string' && body.to.trim()) || user.email;
    if (!to || !EMAIL_RE.test(to)) return sendJSON(res, 400, { error: 'Give an address to send the test to' });
    try {
      await sendMail({
        to,
        subject: 'Test message from Pokémon TCG Tracker',
        text: 'If you are reading this, this install can send mail.\n\nThat means it can confirm addresses and send password resets.\n',
      });
    } catch (e) {
      return sendJSON(res, 502, { error: e.message });
    }
    return sendJSON(res, 200, { ok: true, to });
  }

  /* ---- turning the second factor on ----
   * Two steps on purpose. The first hands over a secret and enables nothing;
   * the second wants a code made from it, which is the only proof that the
   * authenticator app really has it. Enabling on the first step would lock
   * people out of their own accounts with a secret they never successfully
   * stored. */
  if (pathname === '/api/totp/setup' && req.method === 'POST') {
    if (user.totpEnabled) return sendJSON(res, 409, { error: 'Two-factor is already on for this account' });
    const secret = base32Encode(crypto.randomBytes(20));
    _setTotp.run(secret, 0, user.id);
    const label = encodeURIComponent(`Pokemon TCG Tracker:${user.display}`);
    const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=Pokemon%20TCG%20Tracker&digits=${TOTP_DIGITS}&period=30`;
    return sendJSON(res, 200, { secret, otpauth, qrSvg: qrSvgFor(otpauth) });
  }

  if (pathname === '/api/totp/enable' && req.method === 'POST') {
    if (user.totpEnabled) return sendJSON(res, 409, { error: 'Two-factor is already on for this account' });
    const body = await readBody(req);
    if (!user.totpSecret) return sendJSON(res, 400, { error: 'Start again — there is no pending secret for this account' });
    if (!totpMatches(user.totpSecret, body.code)) {
      return sendJSON(res, 400, { error: 'That code is not right. Check the time on the device running your authenticator.' });
    }
    _setTotp.run(user.totpSecret, 1, user.id);
    // shown exactly once; from here on only their hashes exist
    return sendJSON(res, 200, { ok: true, recoveryCodes: issueRecoveryCodes(user.id) });
  }

  /* Turning it off needs the password. A borrowed session should not be able
   * to quietly remove the thing standing in the way of the next one. */
  if (pathname === '/api/totp/disable' && req.method === 'POST') {
    const body = await readBody(req);
    if (!(await verifyPassword(body.password, user.salt, user.hash))) {
      return sendJSON(res, 401, { error: 'Current password is incorrect' });
    }
    _setTotp.run(null, 0, user.id);
    _dropRecovery.run(user.id);
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/totp/recovery-codes' && req.method === 'POST') {
    if (!user.totpEnabled) return sendJSON(res, 400, { error: 'Two-factor is not on for this account' });
    const body = await readBody(req);
    if (!(await verifyPassword(body.password, user.salt, user.hash))) {
      return sendJSON(res, 401, { error: 'Current password is incorrect' });
    }
    // a fresh set retires the old one, so a list written down and lost stops working
    return sendJSON(res, 200, { ok: true, recoveryCodes: issueRecoveryCodes(user.id) });
  }

  /* What this server thinks of the connection you are on. PTCG_TRUSTED_PROXY
   * fails silently when it is wrong — the rate limiter simply counts everyone
   * behind the proxy as one person, and the first anyone hears of it is being
   * locked out by a stranger's typo. This says it out loud: if `you` is the
   * address you actually browse from, the setting is right. Administrator
   * only, because it reports the shape of the network in front of the app. */
  if (pathname === '/api/connection' && req.method === 'GET') {
    if (!isAdminUser(user)) return sendJSON(res, 403, { error: 'Administrator account required' });
    const peer = normIp(req.socket.remoteAddress) || '?';
    const trusted = isTrustedProxy(peer);
    return sendJSON(res, 200, {
      you: ip,
      peer,
      proxyTrusted: trusted,
      proxyConfigured: TRUSTED_PROXIES.length > 0,
      clientIpHeader: CLIENT_IP_HEADER || null,
      clientIpHeaderSeen: CLIENT_IP_HEADER ? (req.headers[CLIENT_IP_HEADER] || null) : null,
      forwardedFor: req.headers['x-forwarded-for'] || null,
      secure: isSecureRequest(req),
    });
  }

  // ---- change password (invalidates all other sessions via the hash-bound token) ----
  if (pathname === '/api/change-password' && req.method === 'POST') {
    const body = await readBody(req);
    const bad = () => sendJSON(res, 401, { error: 'Current password is incorrect' });
    if (typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string') {
      return sendJSON(res, 400, { error: 'currentPassword and newPassword are required' });
    }
    if (body.newPassword.length < MIN_PASSWORD) {
      return sendJSON(res, 400, { error: `New password must be at least ${MIN_PASSWORD} characters` });
    }
    if (!(await verifyPassword(body.currentPassword, user.salt, user.hash))) return bad();
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await hashPassword(body.newPassword, salt);
    _updateUserHash.run(salt, hash, user.id);
    clearLoginFailures(user.username);
    // fresh token (and cookie) for THIS session; every previously-issued token
    // no longer matches the new hash fingerprint and is now dead
    const token = issueToken({ id: user.id, hash });
    return sendJSON(res, 200, { ok: true, token }, { 'Set-Cookie': sessionCookie(req, token) });
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
    // an explicitly empty selection is honored ('' — the card lives on its
    // custom printings alone); only an ABSENT variants object means 'normal'
    const varsCsv = (v) => (v ? Object.keys(v).filter((k) => v[k]).join(',') : 'normal');
    // reuse another card's picture (duplicates, or "from an existing card")
    let imgFrom;
    if (typeof body.imageFrom === 'string' && CARD_ID_RE.test(body.imageFrom)) {
      const ir = _cardRow.get(cLang, body.imageFrom);
      if (!ir || (!ir.img_low && !ir.img_high)) return sendJSON(res, 400, { error: 'That card has no picture to reuse' });
      imgFrom = { low: ir.img_low, high: ir.img_high };
    }
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
        varsCsv(patch.variants), imgFrom ? imgFrom.low : null, imgFrom ? imgFrom.high : null,
        _maxCardPos.get(cLang, setId).p + 1, 0);
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
      patch.variants !== undefined ? varsCsv(patch.variants) : (row.variants_csv ?? 'normal'),
      imgFrom ? imgFrom.low : row.img_low, imgFrom ? imgFrom.high : row.img_high, row.position, row.hidden);
    // re-ticking a printing lifts its soft-removal tombstone (scan and all)
    if (patch.variants) for (const [k, on] of Object.entries(patch.variants)) if (on) _printingUnhide.run(cLang, cardId, k);
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

  // ---- admin: remove one printing (variant) of a card ----
  // Base variants come off the card's variants list; custom printings get a
  // hidden marker row. Both end up source='local', so a master pull can't
  // re-add them — and on the workspace the removal publishes to everyone.
  // Restore: re-add a printing with the same name, or re-tick the variant in
  // the card editor.
  if (pathname === '/api/variant-remove' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    if (!isAdminUser(user)) return sendJSON(res, 403, { error: 'Administrator account required' });
    const body = await readBody(req);
    const cLang = LANG_RE.test(body.lang || '') ? body.lang : 'en';
    const cardId = typeof body.cardId === 'string' && CARD_ID_RE.test(body.cardId) ? body.cardId : null;
    const variant = typeof body.variant === 'string' && VARIANT_KEY_RE.test(body.variant) ? body.variant : null;
    if (!cardId || !variant) return sendJSON(res, 400, { error: 'A valid cardId and variant are required' });
    const row = _cardRow.get(cLang, cardId);
    if (!row) return sendJSON(res, 404, { error: `Card ${cardId} not found in the ${cLang} database` });
    // every removal is SOFT: a hidden marker row in printings. The card row is
    // never rewritten, so it stays under master control (name/image fixes keep
    // flowing in) — the merge sees the original variant and bypasses it.
    const rows = _allPrints.all(cLang, cardId);
    const tombs = new Set(rows.filter((r) => r.hidden).map((r) => r.variant));
    const visPrintKeys = rows.filter((r) => !r.hidden).map((r) => r.variant);
    const baseVars = (row.variants_csv == null ? ['normal'] : row.variants_csv.split(',')).filter(Boolean).filter((v) => !tombs.has(v));
    const all = new Set([...baseVars, ...visPrintKeys]);
    if (!all.has(variant)) return sendJSON(res, 404, { error: 'That printing does not exist on this card' });
    if (all.size <= 1) return sendJSON(res, 400, { error: 'A card needs at least one printing — hide the whole card instead' });
    _printingHide.run(cLang, cardId, variant);
    return sendJSON(res, 200, { ok: true, cardId, variant, removed: true });
  }

  // ---- admin: hide (tombstone) or restore a whole set ----
  // Restoring also unhides the set's own soft-hidden cards.
  if (pathname === '/api/set-hide' && req.method === 'POST') {
    if (READONLY) return sendJSON(res, 403, { error: 'This server is read-only — its card database is managed centrally' });
    if (!isAdminUser(user)) return sendJSON(res, 403, { error: 'Administrator account required' });
    const body = await readBody(req);
    const cLang = LANG_RE.test(body.lang || '') ? body.lang : 'en';
    const setId = typeof body.id === 'string' && SET_ID_RE.test(body.id) ? body.id : null;
    if (!setId) return sendJSON(res, 400, { error: 'A valid set id is required' });
    if (!_setRow.get(cLang, setId)) return sendJSON(res, 404, { error: `Set ${setId} not found in the ${cLang} database` });
    const hide = body.hidden !== false;   // default: hide
    _setHide.run(hide ? 1 : 0, cLang, setId);
    if (hide) _hideCardsOfSet.run(cLang, setId); else _unhideCardsOfSet.run(cLang, setId);
    return sendJSON(res, 200, { ok: true, id: setId, hidden: hide });
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
    // fingerprint it now, so the scanner can find this card without waiting
    // for a rebuild it may never get (a pulled-only install never runs one)
    let scannable = false;
    try {
      rememberScanHash(cLang, cardId, await require('./scripts/card-hash').hashImageFile(path.join(dir, 'card-low.webp')));
      scannable = true;
    } catch (e) {
      pushLog(`Could not fingerprint ${cardId} for the scanner: ${e.message}`);
    }
    return sendJSON(res, 200, { ok: true, urls: { low, high }, scannable });
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
        cover: b.cover ? JSON.parse(b.cover) : null, shared: !!b.share,
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
    let slots = {}, pages = 1, skipped = 0;
    // fill from a whole set, or from every printing of one Pokémon — a species
    // binder is the other way collectors organise, and it spans sets by nature
    const flang = LANG_RE.test(body.lang || '') ? body.lang : 'en';
    const dex = parseInt(body.fillFromPokemon, 10);
    const fill = body.fillFromSet && SET_ID_RE.test(body.fillFromSet)
      ? { cards: _cardsOfSet.all(flang, body.fillFromSet), what: 'That set' }
      : (dex > 0 && dex < 100000 ? { cards: _cardsOfDex.all(flang, String(dex)), what: 'That Pokémon' } : null);
    if (fill) {
      if (!fill.cards.length) return sendJSON(res, 400, { error: `${fill.what} has no cards to fill from` });
      // ONE POCKET PER PRINTING, not per card. A holo and its normal are two
      // different pieces of cardboard, and a binder that gives them one pocket
      // between them can never actually be finished. Each card's printings sit
      // together, so the set's own numbering still runs front to back.
      const wanted = [];
      for (const c of fill.cards) for (const variant of printingsOf(flang, c)) wanted.push({ card: c.id, variant, have: 0 });
      // a binder is a physical object with a limit; when the fill is bigger than
      // one, it fills what fits and says how much it left rather than silently
      // stopping short or making a binder the app can't page through
      const room = MAX_BINDER_PAGES * perPage;
      wanted.slice(0, room).forEach((s, i) => { slots[i] = s; });
      skipped = Math.max(0, wanted.length - room);
      pages = Math.min(MAX_BINDER_PAGES, Math.max(1, Math.ceil(Math.min(wanted.length, room) / perPage)));
    }
    const binder = {
      id: crypto.randomUUID(), name, size, color, pages,
      slots, created: new Date().toISOString(), updated: Date.now(),
    };
    _binderPut.run(user.id, binder.id, binder.name, binder.size, binder.color, binder.pages,
      JSON.stringify(binder.slots), null, binder.created, binder.updated);
    // filled/skipped are what the client tells the user it made — the pocket
    // count is no longer the card count, so it should not have to be guessed at
    return sendJSON(res, 200, { ok: true, binder, filled: Object.keys(slots).length, skipped });
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

  /* ---- turning one binder into a link, and taking it back ----
   * Off is the default and off is instant: clearing the column is all it
   * takes for every copy of the URL that ever left this machine to stop
   * working. `rotate` mints a fresh token over an existing one, which is the
   * same thing with a replacement — the only answer to a link that reached
   * somebody it should not have. */
  const shareToggle = pathname.match(/^\/api\/binders\/([a-f0-9-]{36})\/share$/);
  if (shareToggle && req.method === 'POST') {
    const row = _binderGet.get(user.id, shareToggle[1]);
    if (!row) return sendJSON(res, 404, { error: 'Binder not found' });
    const body = await readBody(req);
    const share = !body.on ? null
      : (row.share && !body.rotate) ? row.share
        : crypto.randomBytes(10).toString('hex');
    // absent means "leave it as it was" — the panel changes one thing at a time
    const showHave = body.showHave === undefined ? (row.share_have !== 0) : !!body.showHave;
    _binderShare.run(share, showHave ? 1 : 0, Date.now(), user.id, row.id);
    return sendJSON(res, 200, { ok: true, share, showHave });
  }

  const binderMatch = pathname.match(/^\/api\/binders\/([a-f0-9-]{36})$/);
  if (binderMatch) {
    const row = _binderGet.get(user.id, binderMatch[1]);
    if (!row) return sendJSON(res, 404, { error: 'Binder not found' });
    if (req.method === 'GET') {
      return sendJSON(res, 200, { binder: { id: row.id, name: row.name, size: row.size, color: row.color,
        pages: row.pages, slots: JSON.parse(row.slots), cover: row.cover ? JSON.parse(row.cover) : null,
        share: row.share || null, shareHave: row.share_have !== 0, updated: row.updated } });
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
      let pages = Number.isInteger(body.pages) ? Math.min(Math.max(body.pages, 1), MAX_BINDER_PAGES) : row.pages;
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
              const flip = ['x', 'y', 'xy'].includes(v.flip) ? v.flip : null;
              clean[i] = { img: v.img, cells, view: view && view.s ? view : null, gaps: v.gaps === 'without' ? 'without' : 'with',
                ...(flip ? { flip } : {}) };
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
      // Sweep only when this save actually dropped a picture — a cleared
      // pocket, a color over the front. Comparing before against after means
      // the ordinary save (moving a card, renaming) never touches the disk.
      const wasUsing = artNamesIn(row.slots, row.cover);
      const nowUsing = artNamesIn(slots, cover);
      if ([...wasUsing].some((n) => !nowUsing.has(n))) sweepBinderArt();
      return sendJSON(res, 200, { ok: true, updated });
    }
    if (req.method === 'DELETE') {
      _binderDel.run(user.id, row.id);
      sweepBinderArt();   // a whole binder's worth just became unreachable
      return sendJSON(res, 200, { ok: true });
    }
  }

  return sendJSON(res, 404, { error: 'Unknown API endpoint' });
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = clientIp(req);
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

/* ---------- setting a password from the machine itself ----------
 * Mail is optional, so an install without it has no self-service way back in,
 * and "forgot my password" would otherwise mean editing ptcg.db by hand. The
 * answer is the same one the setup code rests on: whoever can run commands on
 * the server is entitled to the account. The new password is read from stdin
 * rather than taken as an argument, because arguments end up in shell history
 * and in the process list where anyone on the box can read them. */
if (process.argv.includes('--set-password')) {
  const who = process.argv[process.argv.indexOf('--set-password') + 1];
  if (!who) {
    console.error('Usage: node server.js --set-password <username>   (the new password is read from stdin)');
    process.exit(2);
  }
  (async () => {
    const user = getUserByName(String(who).toLowerCase());
    if (!user) { console.error(`No account called ${who} on this install.`); process.exit(1); }
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) input += chunk;
    const pw = input.replace(/\r?\n$/, '');
    if (pw.length < MIN_PASSWORD) {
      console.error(`That password is ${pw.length} characters; the minimum is ${MIN_PASSWORD}.`);
      process.exit(1);
    }
    const salt = crypto.randomBytes(16).toString('hex');
    _updateUserHash.run(salt, await hashPassword(pw, salt), user.id);
    try { _dropTokensOf.run(user.id, 'reset'); } catch { /* nothing outstanding */ }
    console.log(`Password changed for ${user.display}. Every device that was signed in has been signed out.`);
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  })();
} else if (process.argv.includes('--clear-2fa')) {
  // The companion to --set-password, and needed for the same reason: with no
  // mail server, a lost authenticator would otherwise be a lost account.
  const who = process.argv[process.argv.indexOf('--clear-2fa') + 1];
  if (!who) {
    console.error('Usage: node server.js --clear-2fa <username>');
    process.exit(2);
  }
  const user = getUserByName(String(who).toLowerCase());
  if (!user) { console.error(`No account called ${who} on this install.`); process.exit(1); }
  _setTotp.run(null, 0, user.id);
  _dropRecovery.run(user.id);
  console.log(`Two-factor turned off for ${user.display}. The password alone signs in again — set a new one if you are not sure it is still private.`);
  try { db.close(); } catch { /* already closed */ }
  process.exit(0);
} else if (process.argv.includes('--pull-master')) {
  // CLI mode (no web server): load the master card database into this
  // install's DB and exit. Used by the installers so a fresh install comes
  // up with every card already in place; safe to re-run any time (same
  // merge as the in-app update — local edits survive).
  (async () => {
    const source = catalogSource();
    if (!source) {
      console.error('No card source configured — set PTCG_API_BASE (+ PTCG_API_TOKEN), or cdnBase in public/config.js / PTCG_CDN_BASE.');
      process.exit(2);
    }
    console.log(`Loading the card database from ${source.base}${source.api ? ' (card API)' : ''} …`);
    try {
      const r = await importCatalogFromRemote(source, (p) => {
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

    // Nobody owns this install yet. Whoever opens it first would otherwise
    // become its administrator, so the setup screen asks for a code that only
    // exists here — in the log of the machine running it.
    if (userCount() === 0 && !READONLY) {
      console.log('');
      console.log('  ┌─────────────────────────────────────────────────────────────┐');
      console.log('  │  This install has no account yet. Open it in a browser and  │');
      console.log('  │  enter this setup code to claim it:                         │');
      console.log('  │                                                             │');
      console.log(`  │      ${setupToken().padEnd(55)}│`);
      console.log('  │                                                             │');
      console.log('  │  A new code is issued every time the server restarts.        │');
      console.log('  └─────────────────────────────────────────────────────────────┘');
      console.log('');
    }

    // Fresh install with no local card build but a remote database configured
    // (reads cards from a shared CDN): pull the catalog into the DB so cards
    // show up without the admin having to click anything. Runs in the
    // background — and keeps retrying every 10 minutes while the database is
    // still empty, so an install that boots before the master is reachable
    // (or before it has been published) heals itself.
    const tryMasterPull = () => {
      if (READONLY || build.running) return;
      if (catalogStats().cards > 0 || dbExists() || !catalogSource()) return;
      try { startCatalogPull(catalogSource()); }
      catch (e) { console.error('Auto-load from remote database failed to start: ' + e.message); }
    };
    tryMasterPull();
    setInterval(tryMasterPull, 10 * 60 * 1000).unref();

    // An install that already HAS cards never asked itself whether the master
    // had moved on — it waited for somebody to open the admin panel. Now it
    // asks on its own, six-hourly, starting a minute after boot so a container
    // coming up in a batch does not stampede the bucket.
    const sched = () => { runScheduledUpdateCheck().catch(() => { /* offline is normal */ }); };
    setTimeout(sched, 60 * 1000).unref();
    setInterval(sched, AUTO_UPDATE_EVERY).unref();
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
  // server.close() politely waits for idle keep-alive sockets (every browser
  // tab holds one), which turns a 10ms shutdown into the 2s failsafe below —
  // and during a deploy that whole wait is downtime. Idle connections can be
  // dropped instantly; requests actually in flight still get to finish.
  try { server.closeIdleConnections(); } catch { /* older Node */ }
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
