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
  console.log('=== 1/7 mock TCGdex API ===');
  start('node', ['tests/mock-tcgdex.js']);
  await waitForPort(3999).catch((e) => fail(e.message));

  console.log('=== 2/7 start server (no card database yet) ===');
  pinTestConfig();
  fs.rmSync(path.join(ROOT, 'public', 'cdn'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, '.test-data'), { recursive: true, force: true });
  start('node', ['server.js'], {
    PORT: '3111',
    DATA_DIR: path.join(ROOT, '.test-data'),
    PTCG_SOURCE_API: 'http://localhost:3999/v2',
  });
  await waitForPort(3111).catch((e) => fail(e.message));

  console.log('=== 3/7 bootstrap suite (in-app download button + admin update) ===');
  const bootstrap = spawnSync('node', ['tests/bootstrap.test.js'], { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (bootstrap.status !== 0) fail('bootstrap suite failed');

  console.log('=== 4/7 top up database via CLI (adds French; detects a custom variant scan) ===');
  // simulate a user-supplied real 1st Edition scan for Pikachu (base1-58)
  const customScan = path.join(ROOT, 'public', 'cdn', 'en', 'images', 'base1', '58', 'firstEdition-low.webp');
  fs.mkdirSync(path.dirname(customScan), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'base1-58.png'), customScan);
  run('node', ['scripts/build-data.js', '--api', 'http://localhost:3999/v2', '--langs', 'en,fr', '--quality', 'low']);

  console.log('=== 5/7 rebuild scanner index ===');
  run('node', ['scripts/build-hashes.js']);

  console.log('=== 6/7 main browser suite ===');
  const suite = spawnSync('node', ['tests/smoke.test.js'], { cwd: ROOT, stdio: 'inherit', env: process.env });

  console.log('=== 7/7 R2 image publisher (against mock S3) ===');
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
  const check = (name, cond) => console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name);
  check('publisher uploads all local files', pub1.status === 0 && uploaded > 0 && storeInfo.count === uploaded);
  check('publisher includes card data, not just images', storeInfo.hasDataIndex === true && storeInfo.hasSetData === true);
  check('publisher pagination + idempotent re-run', pub2.status === 0 && /Uploaded 0, skipped/.test(out2));
  const publishOk = pub1.status === 0 && uploaded > 0 && storeInfo.count === uploaded && pub2.status === 0 && /Uploaded 0, skipped/.test(out2);

  cleanup();
  fs.rmSync(path.join(ROOT, '.test-data'), { recursive: true, force: true });
  if (suite.status !== 0) { console.error('\nBrowser suite failed.'); process.exit(1); }
  if (!publishOk) { console.error('\nPublisher checks failed.'); process.exit(1); }

  console.log('\nAll stages completed.');
})().catch((e) => fail(e.stack || e.message));
