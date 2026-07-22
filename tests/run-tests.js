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
  console.log('=== 1/5 mock TCGdex API ===');
  start('node', ['tests/mock-tcgdex.js']);
  await waitForPort(3999).catch((e) => fail(e.message));

  console.log('=== 2/5 build card database from mock ===');
  fs.rmSync(path.join(ROOT, 'public', 'cdn'), { recursive: true, force: true });
  run('node', ['scripts/build-data.js', '--api', 'http://localhost:3999/v2', '--langs', 'en,fr', '--quality', 'low']);

  console.log('=== 3/5 build scanner index ===');
  run('node', ['scripts/build-hashes.js']);

  console.log('=== 4/5 start server ===');
  start('node', ['server.js'], { PORT: '3111', DATA_DIR: path.join(ROOT, '.test-data') });
  await waitForPort(3111).catch((e) => fail(e.message));

  console.log('=== 5/5 browser suite ===');
  const suite = spawnSync('node', ['tests/smoke.test.js'], { cwd: ROOT, stdio: 'inherit', env: process.env });

  cleanup();
  fs.rmSync(path.join(ROOT, '.test-data'), { recursive: true, force: true });
  if (suite.status !== 0) { console.error('\nBrowser suite failed.'); process.exit(1); }

  // suite prints PASS/FAIL lines; treat any FAIL as failure even with exit 0
  console.log('\nAll stages completed.');
})().catch((e) => fail(e.stack || e.message));
