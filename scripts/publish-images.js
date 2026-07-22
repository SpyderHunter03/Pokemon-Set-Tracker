#!/usr/bin/env node
/**
 * Image publisher — syncs your card images to Cloudflare R2 (or any
 * S3-compatible bucket). Zero dependencies: SigV4 signing is done with
 * Node's crypto.
 *
 * Uploads everything under public/cdn/<lang>/images/ as keys
 * "<lang>/images/..." — exactly the layout the app expects from
 * config.js `imageBase`. Idempotent: unchanged files (same MD5) are
 * skipped, so re-running after new downloads or admin uploads only
 * transfers what's new. Never deletes anything remote.
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
 *   --dry-run     show what would upload, do nothing
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

function localImages() {
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
    const imgDir = path.join(CDN_DIR, lang, 'images');
    walk(imgDir, `${lang}/images/`, files);
  }
  return files;
}

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
  const keys = localImages();
  console.log(`Local images: ${keys.length}`);
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

  if (DRY) {
    toUpload.slice(0, 20).forEach((k) => console.log('  would upload: ' + k));
    if (toUpload.length > 20) console.log(`  … and ${toUpload.length - 20} more`);
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
          'content-type': CONTENT_TYPES[ext] || 'application/octet-stream',
          'cache-control': 'public, max-age=31536000, immutable',
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

  console.log(`Done. Uploaded ${done}, skipped ${keys.length - toUpload.length} unchanged${failed ? `, FAILED ${failed}` : ''}.`);
  if (failed) process.exit(1);
})().catch((e) => {
  console.error('Failed: ' + e.message);
  process.exit(1);
});
