#!/usr/bin/env node
/**
 * Test orchestrator — runs the full end-to-end suite locally or in CI.
 *
 * 1. starts a mock TCGdex API (fixtures in tests/fixtures)
 * 2. runs scripts/build-data.js against it (en + fr, image edge cases)
 * 3. runs scripts/build-hashes.js (scanner index — requires sharp)
 * 4. starts the real server on :3111
 * 5. runs the Playwright browser suite (tests/smoke.test.js)
 *
 * Requirements: `npm install playwright sharp` and a Playwright chromium
 * (npx playwright install chromium), or set CHROMIUM_PATH to a chromium binary.
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const children = [];

// The committed public/config.js points cdnBase at the project's hosted CDN.
// Tests must run against the local fixture database, so pin a local config
// for the duration of the suite and restore the real one afterwards.
const CONFIG_PATH = path.join(ROOT, 'public', 'config.js');
const realConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
function pinTestConfig() {
  fs.writeFileSync(CONFIG_PATH,
    "self.PTCG_CONFIG = { cdnBase: 'cdn', defaultLanguage: 'en', imageBase: null };\n");
}
function restoreConfig() {
  try { fs.writeFileSync(CONFIG_PATH, realConfig); } catch { /* best effort */ }
}
process.on('exit', restoreConfig);

function start(cmd, args, env = {}) {
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'inherit' });
  children.push(child);
  return child;
}

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'inherit' });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} exited with ${r.status}`);
}

function waitForPort(port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function attempt() {
      const sock = net.connect(port, '127.0.0.1');
      sock.on('connect', () => { sock.destroy(); resolve(); });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`port ${port} never opened`));
        else setTimeout(attempt, 250);
      });
    })();
  });
}

function cleanup() {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
}

function fail(msg) {
  console.error('\nFAILED: ' + msg);
  cleanup();
  process.exit(1);
}

(async () => {
  console.log('=== 1/8 mock TCGdex API ===');
  start('node', ['tests/mock-tcgdex.js']);
  await waitForPort(3999).catch((e) => fail(e.message));

  console.log('=== 2/8 start server (no card database yet) ===');
  pinTestConfig();
  fs.rmSync(path.join(ROOT, 'public', 'cdn'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, '.test-data'), { recursive: true, force: true });
  start('node', ['server.js'], {
    PORT: '3111',
    DATA_DIR: path.join(ROOT, '.test-data'),
    PTCG_SOURCE_API: 'http://localhost:3999/v2',
  });
  await waitForPort(3111).catch((e) => fail(e.message));

  console.log('=== 3/8 bootstrap suite (in-app download button + admin update) ===');
  const bootstrap = spawnSync('node', ['tests/bootstrap.test.js'], { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (bootstrap.status !== 0) fail('bootstrap suite failed');

  console.log('=== 4/8 top up database via CLI (adds French; detects a custom variant scan) ===');
  // simulate a user-supplied real 1st Edition scan for Pikachu (base1-58)
  const customScan = path.join(ROOT, 'public', 'cdn', 'en', 'images', 'base1', '58', 'firstEdition-low.webp');
  fs.mkdirSync(path.dirname(customScan), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'base1-58.png'), customScan);
  run('node', ['scripts/build-data.js', '--api', 'http://localhost:3999/v2', '--langs', 'en,fr', '--quality', 'low']);

  console.log('=== 5/8 rebuild scanner index ===');
  run('node', ['scripts/build-hashes.js']);

  console.log('=== 6/8 main browser suite ===');
  const suite = spawnSync('node', ['tests/smoke.test.js'], { cwd: ROOT, stdio: 'inherit', env: process.env });

  const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) stageFails++; };
  let stageFails = 0;
  const jfetch = async (url, opts) => fetch(url, opts).then((r) => r.json());

  console.log('=== 7/8 variant importer + read-only mode + offline mirror ===');
  // ---- tcgcsv variant importer against a mock ----
  start('node', ['tests/mock-tcgcsv.js']);
  await waitForPort(3997).catch((e) => fail(e.message));
  // seed a previously-published master printing to prove the importer's additive merge
  fs.writeFileSync(path.join(ROOT, 'public', 'cdn', 'custom.json'),
    JSON.stringify({ cards: { 'base1-4': { variants: { 'cracked-ice-holo': 'Cracked Ice Holo' } } } }));
  const imp = spawnSync('node', ['scripts/import-variants.js', '--api', 'http://localhost:3997/tcgplayer'], { cwd: ROOT, encoding: 'utf8' });
  const customNow = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'cdn', 'custom.json'), 'utf8'));
  const vOf = (id) => (customNow.cards[id] || {}).variants || {};
  check('importer adds descriptor printings (incl. leading-zero numbers)',
    imp.status === 0 && vOf('base1-58')['red-cheeks'] === 'Red Cheeks' && vOf('swsh3-20')['cracked-ice-holo'] === 'Cracked Ice Holo');
  check('importer skips standard printings', !Object.keys(vOf('base1-58')).some((k) => /1st|first|holo$|normal/.test(k)));
  check('importer preserves admin-added printings', vOf('base1-4')['cracked-ice-holo'] === 'Cracked Ice Holo');

  // ---- pokemasterlist CSV importer ----
  const ml = spawnSync('node', ['scripts/import-masterlist.js', 'tests/fixtures/masterlist-sample.csv'], { cwd: ROOT, encoding: 'utf8' });
  const mlOut = (ml.stdout || '') + (ml.stderr || '');
  const customML = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'cdn', 'custom.json'), 'utf8'));
  const vML = (id) => (customML.cards[id] || {}).variants || {};
  check('masterlist importer adds new printings (card exists, variant new)',
    ml.status === 0 && vML('base1-58')['parallel-holo'] === 'Parallel Holo' && vML('base1-58')['fxe-wtf-g7z'] === 'FXE-WTF-G7Z');
  check('masterlist importer skips reverse-covered Parallel Holo', /Already covered by the database: 2/.test(mlOut));
  check('masterlist importer reports cards not in the database (NEED-CARD)', /Cards not in the database:       1/.test(mlOut));
  check('masterlist importer reports unmatched expansions', /Expansions with no matching set: 1/.test(mlOut));
  const mlA = spawnSync('node', ['scripts/import-masterlist.js', 'tests/fixtures/masterlist-sample.csv', '--analyze'], { cwd: ROOT, encoding: 'utf8' });
  check('masterlist importer --analyze parses without a database', mlA.status === 0 && /Printings: 7/.test(mlA.stdout || ''));

  // ---- read-only (central) server mode ----
  fs.rmSync(path.join(ROOT, '.test-data-ro'), { recursive: true, force: true });
  start('node', ['server.js'], { PORT: '3113', DATA_DIR: path.join(ROOT, '.test-data-ro'), PTCG_READONLY: '1' });
  await waitForPort(3113).catch((e) => fail(e.message));
  const roReg = await jfetch('http://localhost:3113/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'roadmin', password: 'password123' }) });
  const roAuth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + roReg.token };
  const roCfg = await jfetch('http://localhost:3113/api/app-config');
  const roBuild = (await fetch('http://localhost:3113/api/build-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status;
  const roMirror = (await fetch('http://localhost:3113/api/mirror', { method: 'POST', headers: roAuth, body: JSON.stringify({ remote: 'http://localhost:3111/cdn' }) })).status;
  const roCustom = (await fetch('http://localhost:3113/api/custom-variant', { method: 'POST', headers: roAuth, body: JSON.stringify({ cardId: 'base1-4', label: 'Nope Holo' }) })).status;
  const roUpload = (await fetch('http://localhost:3113/api/variant-image?cardId=base1-4&variant=holo', { method: 'POST', headers: roAuth, body: 'x' })).status;
  check('read-only server reports itself in app-config', roCfg.readonly === true);
  check('read-only blocks every database write (build/mirror/printing/upload)',
    roBuild === 403 && roMirror === 403 && roCustom === 403 && roUpload === 403);
  const roOverlayCard = (await fetch('http://localhost:3113/api/overlay-card', { method: 'POST', headers: roAuth, body: JSON.stringify({ cardId: 'x-1', set: 'x', name: 'X', new: true }) })).status;
  const roOverlayRemove = (await fetch('http://localhost:3113/api/overlay-remove', { method: 'POST', headers: roAuth, body: JSON.stringify({ cardId: 'base1-4' }) })).status;
  check('read-only blocks overlay editing (add-card / remove)', roOverlayCard === 403 && roOverlayRemove === 403);

  // ---- overlay engine: add card, patch, tombstone, printing → local overlay ----
  fs.rmSync(path.join(ROOT, '.test-data-ov'), { recursive: true, force: true });
  start('node', ['server.js'], { PORT: '3115', DATA_DIR: path.join(ROOT, '.test-data-ov'), PTCG_SOURCE_API: 'http://localhost:3999/v2' });
  await waitForPort(3115).catch((e) => fail(e.message));
  const ovReg = await jfetch('http://localhost:3115/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ovadmin', password: 'password123' }) });
  const ovAuth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ovReg.token };
  const ovH = (p, b) => jfetch('http://localhost:3115' + p, { method: 'POST', headers: ovAuth, body: JSON.stringify(b) });
  await ovH('/api/overlay-card', { cardId: 'promoX-1', set: 'promoX', name: 'Eevee Promo', dexId: [133], new: true }); // new card TCGdex lacks
  await ovH('/api/overlay-set', { id: 'promoX', name: 'My Promo Set' });
  await ovH('/api/custom-variant', { cardId: 'base1-4', label: 'Cosmos Holo' });           // printing on existing card
  await ovH('/api/overlay-card', { cardId: 'base1-58', name: 'Renamed Pikachu' });          // patch existing card
  await ovH('/api/overlay-remove', { cardId: 'base1-97' });                                 // tombstone
  const ov = await jfetch('http://localhost:3115/api/local-overlay');
  const ovCfg = await jfetch('http://localhost:3115/api/app-config');
  check('overlay stores a new card (not in TCGdex)', ov.cards['promoX-1'] && ov.cards['promoX-1'].new === true && ov.cards['promoX-1'].name === 'Eevee Promo');
  check('overlay stores a new set', ov.sets['promoX'] && ov.sets['promoX'].name === 'My Promo Set');
  check('overlay stores a printing in the local layer', ov.cards['base1-4'].printings['cosmos-holo'] === 'Cosmos Holo');
  check('overlay patches an existing card', ov.cards['base1-58'].name === 'Renamed Pikachu');
  check('overlay tombstones a card', ov.removed.includes('base1-97'));
  const ovRestore = await ovH('/api/overlay-remove', { cardId: 'base1-97', removed: false });
  const ov2 = await jfetch('http://localhost:3115/api/local-overlay');
  check('overlay restore lifts the tombstone', ovRestore.removed === false && !ov2.removed.includes('base1-97'));
  check('app-config reports publish capability (no R2 creds here)', ovCfg.canPublish === false);

  // ---- offline mirror: fresh install copies a remote database locally ----
  fs.rmSync(path.join(ROOT, '.test-data-mirror'), { recursive: true, force: true });
  start('node', ['server.js'], { PORT: '3114', DATA_DIR: path.join(ROOT, '.test-data-mirror') });
  await waitForPort(3114).catch((e) => fail(e.message));
  const mReg = await jfetch('http://localhost:3114/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'mirroradmin', password: 'password123' }) });
  const mStart = await jfetch('http://localhost:3114/api/mirror', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + mReg.token }, body: JSON.stringify({ remote: 'http://localhost:3111/cdn' }) });
  let mDone = null;
  for (let i = 0; i < 240 && !mDone; i++) {
    const st = await jfetch('http://localhost:3114/api/build-status');
    if (!st.running) mDone = st;
    else await new Promise((r) => setTimeout(r, 500));
  }
  const mCfg = await jfetch('http://localhost:3114/api/app-config');
  check('mirror runs to completion without errors',
    mStart.started === true && mDone && !mDone.error && mDone.progress && mDone.progress.done === true);
  check('mirror skips files that already exist locally',
    mDone && mDone.progress.imagesSkipped > 0 && mDone.progress.imageFailures === 0);
  check('mirror switches the install to the local copy', mCfg.imageSource === 'local' && mCfg.localDbExists === true);

  console.log('=== 8/8 R2 image publisher (against mock S3) ===');
  start('node', ['tests/mock-s3.js']);
  await waitForPort(3998).catch((e) => fail(e.message));
  const r2env = {
    R2_ENDPOINT: 'http://localhost:3998',
    R2_ACCESS_KEY_ID: 'testkey',
    R2_SECRET_ACCESS_KEY: 'testsecret',
    R2_BUCKET: 'cards',
  };
  const pub1 = spawnSync('node', ['scripts/publish-images.js'], { cwd: ROOT, env: { ...process.env, ...r2env }, encoding: 'utf8' });
  const out1 = (pub1.stdout || '') + (pub1.stderr || '');
  const uploaded = parseInt((out1.match(/Uploaded (\d+)/) || [])[1] || '0', 10);
  const storeInfo = await (await fetch('http://localhost:3998/__store')).json();
  const pub2 = spawnSync('node', ['scripts/publish-images.js'], { cwd: ROOT, env: { ...process.env, ...r2env }, encoding: 'utf8' });
  const out2 = (pub2.stdout || '') + (pub2.stderr || '');
  check('publisher uploads all local files', pub1.status === 0 && uploaded > 0 && storeInfo.count === uploaded);
  check('publisher includes card data, not just images', storeInfo.hasDataIndex === true && storeInfo.hasSetData === true);
  check('publisher pagination + idempotent re-run', pub2.status === 0 && /Uploaded 0, skipped/.test(out2));

  // --prune: seed a remote-only object (a "removed" set), verify default run
  // keeps it but hints, --prune with --langs is refused, --prune deletes it
  await fetch('http://localhost:3998/__seed?key=en/images/A1/1/low.webp', { method: 'POST' });
  const pub3 = spawnSync('node', ['scripts/publish-images.js'], { cwd: ROOT, env: { ...process.env, ...r2env }, encoding: 'utf8' });
  const out3 = (pub3.stdout || '') + (pub3.stderr || '');
  const storeMid = await (await fetch('http://localhost:3998/__store')).json();
  const pubGuard = spawnSync('node', ['scripts/publish-images.js', '--prune', '--langs', 'en'], { cwd: ROOT, env: { ...process.env, ...r2env }, encoding: 'utf8' });
  const pub4 = spawnSync('node', ['scripts/publish-images.js', '--prune'], { cwd: ROOT, env: { ...process.env, ...r2env }, encoding: 'utf8' });
  const out4 = (pub4.stdout || '') + (pub4.stderr || '');
  const storeAfter = await (await fetch('http://localhost:3998/__store')).json();
  check('publisher keeps remote-only files by default (with a hint)', pub3.status === 0 && /--prune to delete/.test(out3) && storeMid.count === uploaded + 1);
  check('publisher refuses --prune with a partial sync', pubGuard.status === 1);
  check('publisher --prune deletes stale remote objects', pub4.status === 0 && /deleted 1/.test(out4) && storeAfter.count === uploaded);
  const publishOk = pub1.status === 0 && uploaded > 0 && storeInfo.count === uploaded && pub2.status === 0 && /Uploaded 0, skipped/.test(out2) &&
    pub3.status === 0 && pubGuard.status === 1 && pub4.status === 0 && /deleted 1/.test(out4) && storeAfter.count === uploaded;

  cleanup();
  for (const d of ['.test-data', '.test-data-ro', '.test-data-mirror', '.test-data-ov']) {
    fs.rmSync(path.join(ROOT, d), { recursive: true, force: true });
  }
  if (suite.status !== 0) { console.error('\nBrowser suite failed.'); process.exit(1); }
  if (!publishOk) { console.error('\nPublisher checks failed.'); process.exit(1); }
  if (stageFails) { console.error(`\n${stageFails} importer/read-only/mirror check(s) failed.`); process.exit(1); }

  console.log('\nAll stages completed.');
})().catch((e) => fail(e.stack || e.message));
