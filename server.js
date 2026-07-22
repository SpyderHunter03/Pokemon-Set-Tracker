#!/usr/bin/env node
/**
 * Pokemon TCG Tracker — self-hostable server
 * Zero dependencies: plain Node.js (>= 18).
 *
 * Serves the PWA from ./public and provides optional account + cloud-sync API.
 * Data is stored as JSON files under DATA_DIR (default ./data).
 *
 * Usage:  node server.js          (then open http://localhost:3000)
 * Env:    PORT=3000  DATA_DIR=./data
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
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const COLLECTIONS_DIR = path.join(DATA_DIR, 'collections');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 90; // 90 days
const MAX_BODY = 8 * 1024 * 1024; // 8 MB — a full collection is far smaller

// ---------- storage helpers ----------

fs.mkdirSync(COLLECTIONS_DIR, { recursive: true });

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

function loadUsers() { return readJSON(USERS_FILE, {}); }
function saveUsers(users) { writeJSONAtomic(USERS_FILE, users); }

// ---------- auth ----------

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
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
  const users = loadUsers();
  const entry = Object.entries(users).find(([, u]) => u.id === payload.uid);
  if (!entry) return null;
  return { username: entry[0], ...entry[1] };
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
function isAdminUser(user, users) {
  if (user.admin === true) return true;
  if (Object.values(users).some((u) => u.admin === true)) return false;
  // accounts created before the admin flag existed: earliest registration wins
  const earliest = Object.values(users).sort((a, b) => new Date(a.created) - new Date(b.created))[0];
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

// ---------- custom printings & variant image library ----------

const CUSTOM_FILE = path.join(CDN_DIR, 'custom.json');
const CARD_ID_RE = /^[a-zA-Z0-9.-]{1,64}$/;
const VARIANT_KEY_RE = /^[a-zA-Z0-9_-]{1,24}$/;
const LANG_RE = /^[a-z-]{2,7}$/;

function slugifyVariant(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
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
    return sendJSON(res, 200, { ok: true, auth: true, version: 2 });
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
    if (build.running) return sendJSON(res, 409, { error: 'A download is already running' });
    const body = await readBody(req);
    const langs = typeof body.langs === 'string' && /^[a-z-]{2,7}(,[a-z-]{2,7})*$/.test(body.langs) ? body.langs : '';
    const quality = ['low', 'high', 'both'].includes(body.quality) ? body.quality : '';
    if (dbExists()) {
      // database already present → only the administrator may re-run/update it
      const admin = authUser(req);
      if (!admin || !isAdminUser(admin, loadUsers())) {
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
    const users = loadUsers();
    const key = username.toLowerCase();
    if (users[key]) return sendJSON(res, 409, { error: 'Username already taken' });
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: crypto.randomUUID(),
      display: username,
      salt,
      hash: hashPassword(password, salt),
      created: new Date().toISOString(),
      admin: Object.keys(users).length === 0, // first account = administrator
    };
    users[key] = user;
    saveUsers(users);
    const token = sign({ uid: user.id, exp: Date.now() + TOKEN_TTL_MS });
    return sendJSON(res, 200, { token, username: user.display });
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    if (rateLimited(ip, 'auth', 20, 10 * 60 * 1000)) return sendJSON(res, 429, { error: 'Too many attempts, try again later' });
    const { username, password } = await readBody(req);
    const users = loadUsers();
    const user = users[(username || '').toLowerCase()];
    const bad = () => sendJSON(res, 401, { error: 'Invalid username or password' });
    if (!user || typeof password !== 'string') return bad();
    const hash = hashPassword(password, user.salt);
    const a = Buffer.from(hash), b = Buffer.from(user.hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return bad();
    const token = sign({ uid: user.id, exp: Date.now() + TOKEN_TTL_MS });
    return sendJSON(res, 200, { token, username: user.display });
  }

  // authenticated routes
  const user = authUser(req);
  if (!user) return sendJSON(res, 401, { error: 'Not signed in' });
  const collFile = path.join(COLLECTIONS_DIR, user.id + '.json');

  if (pathname === '/api/me' && req.method === 'GET') {
    return sendJSON(res, 200, { username: user.display, admin: isAdminUser(user, loadUsers()) });
  }

  // ---- admin: define a custom printing (e.g. "Cracked Ice Holo") for a card ----
  if (pathname === '/api/custom-variant' && req.method === 'POST') {
    if (!isAdminUser(user, loadUsers())) return sendJSON(res, 403, { error: 'Administrator account required' });
    const body = await readBody(req);
    const cardId = typeof body.cardId === 'string' && CARD_ID_RE.test(body.cardId) ? body.cardId : null;
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 40) : '';
    if (!cardId || label.length < 2) return sendJSON(res, 400, { error: 'cardId and a printing name (2+ characters) are required' });
    const key = slugifyVariant(label);
    if (!VARIANT_KEY_RE.test(key)) return sendJSON(res, 400, { error: 'That name produces an invalid key' });
    const custom = readJSON(CUSTOM_FILE, { cards: {} });
    if (!custom.cards[cardId]) custom.cards[cardId] = { variants: {} };
    custom.cards[cardId].variants[key] = label;
    writeJSONAtomic(CUSTOM_FILE, custom);
    return sendJSON(res, 200, { ok: true, cardId, key, label });
  }

  // ---- admin: upload your own image for a specific printing of a card ----
  if (pathname === '/api/variant-image' && req.method === 'POST') {
    if (!isAdminUser(user, loadUsers())) return sendJSON(res, 403, { error: 'Administrator account required' });
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
    if (!card) return sendJSON(res, 404, { error: `Card ${cardId} not found in the ${lang} database` });
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
    if (!card.variantImages) card.variantImages = {};
    card.variantImages[variant] = ['low', 'high'];
    if (!card.image) card.image = `images/${setId}/${localId}`; // imageless card gains a base path for variant art
    writeJSONAtomic(setFile, set);
    return sendJSON(res, 200, {
      ok: true,
      urls: {
        low: `/cdn/${lang}/images/${setId}/${localId}/${variant}-low.webp`,
        high: `/cdn/${lang}/images/${setId}/${localId}/${variant}-high.webp`,
      },
    });
  }

  if (pathname === '/api/collection' && req.method === 'GET') {
    const data = readJSON(collFile, { collection: {}, updatedAt: 0 });
    return sendJSON(res, 200, data);
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
    const data = { collection: clean, updatedAt: Date.now() };
    writeJSONAtomic(collFile, data);
    return sendJSON(res, 200, { ok: true, updatedAt: data.updatedAt, count: Object.keys(clean).length });
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
