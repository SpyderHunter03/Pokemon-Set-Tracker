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
  console.log('=== 1/6 mock TCGdex API ===');
  start('node', ['tests/mock-tcgdex.js']);
  await waitForPort(3999).catch((e) => fail(e.message));

  console.log('=== 2/6 start server (no card database yet) ===');
  fs.rmSync(path.join(ROOT, 'public', 'cdn'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, '.test-data'), { recursive: true, force: true });
  start('node', ['server.js'], {
    PORT: '3111',
    DATA_DIR: path.join(ROOT, '.test-data'),
    PTCG_SOURCE_API: 'http://localhost:3999/v2',
  });
  await waitForPort(3111).catch((e) => fail(e.message));

  console.log('=== 3/6 bootstrap suite (in-app download button + admin update) ===');
  const bootstrap = spawnSync('node', ['tests/bootstrap.test.js'], { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (bootstrap.status !== 0) fail('bootstrap suite failed');

  console.log('=== 4/6 top up database via CLI (adds French; detects a custom variant scan) ===');
  // simulate a user-supplied real 1st Edition scan for Pikachu (base1-58)
  const customScan = path.join(ROOT, 'public', 'cdn', 'en', 'images', 'base1', '58', 'firstEdition-low.webp');
  fs.mkdirSync(path.dirname(customScan), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'base1-58.png'), customScan);
  run('node', ['scripts/build-data.js', '--api', 'http://localhost:3999/v2', '--langs', 'en,fr', '--quality', 'low']);

  console.log('=== 5/6 rebuild scanner index ===');
  run('node', ['scripts/build-hashes.js']);

  console.log('=== 6/6 main browser suite ===');
  const suite = spawnSync('node', ['tests/smoke.test.js'], { cwd: ROOT, stdio: 'inherit', env: process.env });

  cleanup();
  fs.rmSync(path.join(ROOT, '.test-data'), { recursive: true, force: true });
  if (suite.status !== 0) { console.error('\nBrowser suite failed.'); process.exit(1); }

  console.log('\nAll stages completed.');
})().catch((e) => fail(e.stack || e.message));
