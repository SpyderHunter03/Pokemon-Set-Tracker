#!/usr/bin/env node
/**
 * CDN publisher — syncs your card database (data + images) to Cloudflare
 * R2 (or any S3-compatible bucket). Zero dependencies: SigV4 signing is
 * done with Node's crypto.
 *
 * Uploads everything under public/cdn/ (images, per-set data, indexes,
 * custom printings, languages) in exactly the layout the app expects —
 * point config.js `cdnBase` at the bucket's public URL and fresh installs
 * boot straight from the CDN with no local download. Idempotent:
 * unchanged files (same MD5) are skipped, so re-running after new
 * downloads or admin uploads/printings only transfers what's new. By
 * default nothing remote is ever deleted; pass --prune to also delete
 * remote objects that no longer exist locally (e.g. sets removed by
 * build-data's series exclusion). Images upload with immutable cache
 * headers; data JSON uploads with short cache (60s) so updates propagate
 * fast.
 *
 * Setup (Cloudflare dashboard):
 *   R2 → Create bucket → Settings → enable public access (r2.dev or a
 *   custom domain) → Manage API tokens → create token with Object
 *   Read & Write on the bucket.
 *
 * Usage:
 *   R2_ACCOUNT_ID=xxxx R2_ACCESS_KEY_ID=xxxx R2_SECRET_ACCESS_KEY=xxxx \
 *   R2_BUCKET=pokemon-cards node scripts/publish-images.js
 *
 * Options / env:
 *   R2_ENDPOINT   override endpoint URL (defaults to
 *                 https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com;
 *                 also how tests point this at a mock)
 *   --langs en,fr publish only these languages (default: all found)
 *   --images-only skip data files (the pre-v3.7 behaviour)
 *   --prune       delete remote objects that don't exist locally.
 *                 Refused together with --langs/--images-only (a partial
 *                 local view would wrongly delete everything outside it).
 *   --dry-run     show what would upload/delete, do nothing
 *   --concurrency N   parallel uploads (default 8)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const CDN_DIR = path.join(__dirname, '..', 'public', 'cdn');
const ACCOUNT = process.env.R2_ACCOUNT_ID || '';
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID || '';
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const BUCKET = process.env.R2_BUCKET || '';
const ENDPOINT = (process.env.R2_ENDPOINT || (ACCOUNT ? `https://${ACCOUNT}.r2.cloudflarestorage.com` : '')).replace(/\/+$/, '');
const DRY = flag('dry-run');
const CONCURRENCY = Math.max(1, parseInt(opt('concurrency', '8'), 10) || 8);
const ONLY_LANGS = opt('langs', '') ? opt('langs', '').split(',').map((s) => s.trim()).filter(Boolean) : null;
const IMAGES_ONLY = flag('images-only');
const PRUNE = flag('prune');

if (PRUNE && (ONLY_LANGS || IMAGES_ONLY)) {
  console.error('--prune requires a full sync: it deletes every remote object missing locally,\n' +
    'so combining it with --langs or --images-only would delete everything outside that subset.');
  process.exit(1);
}

if (!ENDPOINT || !ACCESS_KEY || !SECRET_KEY || !BUCKET) {
  console.error(`Missing configuration. Required environment variables:
  R2_ACCOUNT_ID        (your Cloudflare account id — or set R2_ENDPOINT directly)
  R2_ACCESS_KEY_ID     (R2 API token access key)
  R2_SECRET_ACCESS_KEY (R2 API token secret)
  R2_BUCKET            (bucket name)`);
  process.exit(1);
}

// ---------- SigV4 (region "auto", service "s3", path-style) ----------

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 3986 encode a single path segment or query value. */
function awsEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function encodePath(key) {
  return '/' + key.split('/').map(awsEncode).join('/');
}

function signedFetch(method, key, { query = {}, body = null, headers = {} } = {}) {
  const url = new URL(ENDPOINT);
  const canonicalUri = encodePath(BUCKET + (key ? '/' + key : ''));
  const queryPairs = Object.entries(query)
    .map(([k, v]) => [awsEncode(k), awsEncode(String(v))])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const canonicalQuery = queryPairs.map(([k, v]) => `${k}=${v}`).join('&');

  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body || '');

  const allHeaders = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  };
  const signedNames = Object.keys(allHeaders).sort();
  const canonicalHeaders = signedNames.map((k) => `${k}:${String(allHeaders[k]).trim()}\n`).join('');
  const signedHeaders = signedNames.join(';');

  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + SECRET_KEY, date), 'auto'), 's3'), 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  const reqHeaders = { ...allHeaders };
  delete reqHeaders.host; // fetch sets it from the URL
  reqHeaders.Authorization = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const target = `${ENDPOINT}${canonicalUri}${canonicalQuery ? '?' + canonicalQuery : ''}`;
  return fetch(target, { method, headers: reqHeaders, body });
}

// ---------- remote inventory ----------

async function listRemote() {
  const remote = new Map(); // key -> etag (md5, no quotes)
  let token = null;
  do {
    const query = { 'list-type': '2' };
    if (token) query['continuation-token'] = token;
    const res = await signedFetch('GET', '', { query });
    if (!res.ok) throw new Error(`List failed: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const block = m[1];
      const key = (block.match(/<Key>([\s\S]*?)<\/Key>/) || [])[1];
      const etag = ((block.match(/<ETag>([\s\S]*?)<\/ETag>/) || [])[1] || '').replace(/&quot;|"/g, '');
      if (key) remote.set(key, etag);
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    token = truncated ? (xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/) || [])[1] : null;
  } while (token);
  return remote;
}

// ---------- local inventory ----------

function walk(dir, base, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base + e.name + '/', out);
    else out.push(base + e.name);
  }
  return out;
}

function localFiles() {
  const files = [];
  let langs = [];
  try {
    langs = fs.readdirSync(CDN_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    console.error(`No card database found at ${CDN_DIR} — run the downloader first.`);
    process.exit(1);
  }
  for (const lang of langs) {
    if (ONLY_LANGS && !ONLY_LANGS.includes(lang)) continue;
    walk(path.join(CDN_DIR, lang, 'images'), `${lang}/images/`, files);
    if (!IMAGES_ONLY) {
      walk(path.join(CDN_DIR, lang, 'sets'), `${lang}/sets/`, files);
      for (const f of ['index.json', 'search-index.json', 'scan-index.json']) {
        if (fs.existsSync(path.join(CDN_DIR, lang, f))) files.push(`${lang}/${f}`);
      }
    }
  }
  if (!IMAGES_ONLY) {
    for (const f of ['languages.json', 'custom.json']) {
      if (fs.existsSync(path.join(CDN_DIR, f))) files.push(f);
    }
  }
  return files;
}

const isImageKey = (key) => key.includes('/images/');

const CONTENT_TYPES = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

async function pool(items, size, worker) {
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

// ---------- main ----------

(async () => {
  console.log(`Endpoint: ${ENDPOINT}  bucket: ${BUCKET}`);
  const keys = localFiles();
  console.log(`Local files: ${keys.length}${IMAGES_ONLY ? ' (images only)' : ' (data + images)'}`);
  console.log('Fetching remote inventory…');
  const remote = await listRemote();
  console.log(`Remote objects: ${remote.size}`);

  const toUpload = [];
  for (const key of keys) {
    const file = path.join(CDN_DIR, key);
    const md5 = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
    if (remote.get(key) !== md5) toUpload.push(key);
  }
  console.log(`To upload (new or changed): ${toUpload.length}`);

  const localSet = new Set(keys);
  const stale = [...remote.keys()].filter((k) => !localSet.has(k));
  if (PRUNE) console.log(`To delete (remote only): ${stale.length}`);
  else if (stale.length && !ONLY_LANGS && !IMAGES_ONLY) {
    console.log(`Note: ${stale.length} remote object(s) no longer exist locally — re-run with --prune to delete them.`);
  }

  if (DRY) {
    toUpload.slice(0, 20).forEach((k) => console.log('  would upload: ' + k));
    if (toUpload.length > 20) console.log(`  … and ${toUpload.length - 20} more`);
    if (PRUNE) {
      stale.slice(0, 20).forEach((k) => console.log('  would delete: ' + k));
      if (stale.length > 20) console.log(`  … and ${stale.length - 20} more`);
    }
    return;
  }

  let done = 0, failed = 0;
  await pool(toUpload, CONCURRENCY, async (key) => {
    const body = fs.readFileSync(path.join(CDN_DIR, key));
    const ext = path.extname(key).toLowerCase();
    try {
      const res = await signedFetch('PUT', key, {
        body,
        headers: {
          'content-type': ext === '.json' ? 'application/json' : (CONTENT_TYPES[ext] || 'application/octet-stream'),
          // images never change; data JSON must propagate quickly
          'cache-control': isImageKey(key) ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
        },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      done++;
      if (done % 250 === 0) console.log(`  uploaded ${done}/${toUpload.length}…`);
    } catch (e) {
      failed++;
      console.warn(`  ! failed: ${key} (${e.message})`);
    }
  });

  let deleted = 0, deleteFailed = 0;
  if (PRUNE && stale.length) {
    await pool(stale, CONCURRENCY, async (key) => {
      try {
        const res = await signedFetch('DELETE', key);
        if (!res.ok && res.status !== 404) throw new Error('HTTP ' + res.status);
        deleted++;
        if (deleted % 250 === 0) console.log(`  deleted ${deleted}/${stale.length}…`);
      } catch (e) {
        deleteFailed++;
        console.warn(`  ! delete failed: ${key} (${e.message})`);
      }
    });
  }

  console.log(`Done. Uploaded ${done}, skipped ${keys.length - toUpload.length} unchanged` +
    (PRUNE ? `, deleted ${deleted}` : '') +
    (failed || deleteFailed ? `, FAILED ${failed + deleteFailed}` : '') + '.');
  if (failed || deleteFailed) process.exit(1);
})().catch((e) => {
  console.error('Failed: ' + e.message);
  process.exit(1);
});
