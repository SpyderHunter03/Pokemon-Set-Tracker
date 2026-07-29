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

  // the app now reads cards from the server's database — refresh :3111's catalog
  // from the freshly built public/cdn (adds French + the custom variant scan)
  {
    const login = await fetch('http://localhost:3111/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ptcgadmin', password: 'password123' }) }).then((r) => r.json());
    const imp = await fetch('http://localhost:3111/api/catalog/import', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token }, body: '{}' }).then((r) => r.json());
    if (!imp.ok) fail('catalog re-import into :3111 failed: ' + JSON.stringify(imp));
    console.log(`  catalog refreshed: ${imp.cards} cards, ${imp.sets} sets, ${imp.printings} printings`);
  }

  console.log('=== 6/8 main browser suite ===');
  const suite = spawnSync('node', ['tests/smoke.test.js'], { cwd: ROOT, stdio: 'inherit', env: process.env });

  const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) stageFails++; };
  let stageFails = 0;
  const jfetch = async (url, opts) => fetch(url, opts).then((r) => r.json());
  const CARD_OK = (id) => typeof id === 'string' && /^[a-zA-Z0-9.-]+$/.test(id);

  console.log('=== 7/8 variant importer + read-only mode + offline mirror ===');

  // ---- shell caching: app.js must ALWAYS revalidate (a max-age here once
  //      kept browsers on an old UI for a day after an upgrade) ----
  // (first fetch may land on a stale keep-alive socket idle-closed by the
  //  server during the long browser stage — retry once on a fresh one)
  const rfetch = async (url, opts) => { try { return await fetch(url, opts); } catch { await new Promise((r) => setTimeout(r, 150)); return fetch(url, opts); } };
  {
    const shellRes = await rfetch('http://localhost:3111/app.js');
    const cc = shellRes.headers.get('cache-control') || '';
    const lm = shellRes.headers.get('last-modified') || '';
    check('app shell served with no-cache + Last-Modified', /no-cache/.test(cc) && !!lm);
    const rev = await rfetch('http://localhost:3111/app.js', { headers: { 'If-Modified-Since': new Date(Date.now() + 60000).toUTCString() } });
    check('app shell revalidation answers 304', rev.status === 304);
    const imgHdr = (await rfetch('http://localhost:3111/cdn/en/index.json')).headers.get('cache-control') || '';
    check('cdn data always revalidates too', /no-cache/.test(imgHdr));
  }
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
  const roOverlayCard = (await fetch('http://localhost:3113/api/card', { method: 'POST', headers: roAuth, body: JSON.stringify({ localId: '1', set: 'x', name: 'X', new: true }) })).status;
  const roOverlayRemove = (await fetch('http://localhost:3113/api/card-hide', { method: 'POST', headers: roAuth, body: JSON.stringify({ cardId: 'base1-4' }) })).status;
  check('read-only blocks overlay editing (add-card / remove)', roOverlayCard === 403 && roOverlayRemove === 403);

  // ---- catalog editing writes to the database (add printing shows in the API) ----
  fs.rmSync(path.join(ROOT, '.test-data-ov'), { recursive: true, force: true });
  start('node', ['server.js'], { PORT: '3115', DATA_DIR: path.join(ROOT, '.test-data-ov'), PTCG_SOURCE_API: 'http://localhost:3999/v2' });
  await waitForPort(3115).catch((e) => fail(e.message));
  const ovReg = await jfetch('http://localhost:3115/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ovadmin', password: 'password123' }) });
  const ovAuth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ovReg.token };
  const ovH = (p, b) => jfetch('http://localhost:3115' + p, { method: 'POST', headers: ovAuth, body: JSON.stringify(b) });
  await ovH('/api/custom-variant', { cardId: 'base1-4', label: 'Cosmos Holo' });
  const ovSet = await jfetch('http://localhost:3115/api/catalog/set?lang=en&id=base1');
  const ovB4 = (ovSet.cards || []).find((c) => c.id === 'base1-4');
  const ovCfg = await jfetch('http://localhost:3115/api/app-config');
  check('add-printing writes to the catalog (shows on the card)', ovB4 && ovB4.printings && ovB4.printings['cosmos-holo'] === 'Cosmos Holo');
  check('app-config reports publish capability (no R2 creds here)', ovCfg.canPublish === false);

  // ---- catalog imported into the database (Phase 1: cards live in SQLite) ----
  const catStats = await jfetch('http://localhost:3115/api/catalog/stats');
  check('catalog auto-imported into the DB on boot', catStats.cards > 10 && catStats.sets >= 4);
  const catImp = await ovH('/api/catalog/import', {});
  check('admin can re-import the catalog (idempotent count)', catImp.ok === true && catImp.cards === catStats.cards);
  const catDenied = (await fetch('http://localhost:3115/api/catalog/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status;
  check('catalog import requires admin', catDenied === 403);
  {
    const { DatabaseSync } = require('node:sqlite');
    const cdb = new DatabaseSync(path.join(ROOT, '.test-data-ov', 'ptcg.db'));
    const cRow = cdb.prepare('SELECT img_low, variants_csv, source FROM cards WHERE lang = ? AND id = ?').get('en', 'base1-4');
    const imgless = cdb.prepare("SELECT img_low FROM cards WHERE lang='en' AND id='base1-102'").get();
    const pRow = cdb.prepare("SELECT label FROM printings WHERE lang='en' AND card_id='base1-4' AND variant='cracked-ice-holo'").get();
    cdb.close();
    check('imported card has an image location + variants', !!cRow && /images\/base1\/4\/low\.webp$/.test(cRow.img_low || '') && cRow.variants_csv.includes('holo'));
    check('imageless card has a null image location', imgless && imgless.img_low === null);
    check('imported custom printing carried its label', pRow && pRow.label === 'Cracked Ice Holo');
  }

  // ---- whole-card editor: new sets, new cards, edits, hide/restore ----
  const nsRes = await ovH('/api/set-create', { id: 'promo-x', name: 'Promo X', releaseDate: '2026-01-01', lang: 'en' });
  const nsDup = (await fetch('http://localhost:3115/api/set-create', { method: 'POST', headers: ovAuth, body: JSON.stringify({ id: 'promo-x', name: 'Promo X' }) })).status;
  const nsIdx = await jfetch('http://localhost:3115/api/catalog/index?lang=en');
  check('editor: brand-new set created (and duplicates refused)',
    nsRes.ok === true && nsDup === 409 && (nsIdx.sets || []).some((s) => s.id === 'promo-x'));

  const ncRes = await ovH('/api/card', { new: true, set: 'promo-x', localId: '1', name: 'Eevee Star', rarity: 'Rare',
    category: 'Pokemon', hp: 70, types: ['Colorless'], dexId: [133], variants: { normal: true, holo: true }, lang: 'en' });
  const ncDup = (await fetch('http://localhost:3115/api/card', { method: 'POST', headers: ovAuth, body: JSON.stringify({ new: true, set: 'promo-x', localId: '1', name: 'Again' }) })).status;
  const ncSet = await jfetch('http://localhost:3115/api/catalog/set?lang=en&id=promo-x');
  const ncCard = (ncSet.cards || []).find((c) => c.id === 'promo-x-1');
  check('editor: brand-new card created with full details (duplicates refused)',
    ncRes.ok === true && ncRes.cardId === 'promo-x-1' && ncDup === 409 &&
    ncCard && ncCard.name === 'Eevee Star' && ncCard.hp === 70 && (ncCard.dexId || [])[0] === 133 &&
    ncCard.variants && ncCard.variants.holo === true && ncCard.img === null);
  const ncSearch = await jfetch('http://localhost:3115/api/catalog/search?lang=en');
  check('editor: new card reaches the search index', (ncSearch.cards || []).some((c) => c.id === 'promo-x-1'));

  const edRes = await ovH('/api/card', { cardId: 'promo-x-1', name: 'Eevee Star EX', rarity: 'Ultra Rare', lang: 'en' });
  const edSet = await jfetch('http://localhost:3115/api/catalog/set?lang=en&id=promo-x');
  const edCard = (edSet.cards || []).find((c) => c.id === 'promo-x-1');
  check('editor: editing a card updates it in place (untouched fields kept)',
    edRes.ok === true && edCard && edCard.name === 'Eevee Star EX' && edCard.rarity === 'Ultra Rare' && edCard.hp === 70);

  // edits mark rows source='local', so a catalog re-import can't undo them
  await ovH('/api/card', { cardId: 'base1-4', rarity: 'Shiny Rare', lang: 'en' });
  await ovH('/api/catalog/import', {});
  const reSet = await jfetch('http://localhost:3115/api/catalog/set?lang=en&id=base1');
  const reB4 = (reSet.cards || []).find((c) => c.id === 'base1-4');
  const rePromo = await jfetch('http://localhost:3115/api/catalog/set?lang=en&id=promo-x');
  check('editor: local edits and new cards survive a catalog re-import',
    reB4 && reB4.rarity === 'Shiny Rare' && ((rePromo.cards || []).find((c) => c.id === 'promo-x-1') || {}).name === 'Eevee Star EX');

  const hdRes = await ovH('/api/card-hide', { cardId: 'promo-x-1', lang: 'en' });
  const hdSet = await jfetch('http://localhost:3115/api/catalog/set?lang=en&id=promo-x');
  const hdList = await jfetch('http://localhost:3115/api/hidden-cards?set=promo-x&lang=en', { headers: ovAuth });
  const hdAnon = (await fetch('http://localhost:3115/api/hidden-cards?set=promo-x&lang=en')).status;
  check('editor: hiding a card tombstones it (admin sees it in hidden-cards)',
    hdRes.ok === true && !(hdSet.cards || []).some((c) => c.id === 'promo-x-1') &&
    (hdList.cards || []).some((c) => c.id === 'promo-x-1') && hdAnon === 403);
  const rsRes = await ovH('/api/card-hide', { cardId: 'promo-x-1', hidden: false, lang: 'en' });
  const rsSet = await jfetch('http://localhost:3115/api/catalog/set?lang=en&id=promo-x');
  check('editor: restoring brings the card back',
    rsRes.ok === true && (rsSet.cards || []).some((c) => c.id === 'promo-x-1'));

  // a new card can wear another card's picture (and imageless donors refuse)
  const ifRes = await ovH('/api/card', { new: true, set: 'promo-x', localId: '2', name: 'Copy Cat', imageFrom: 'base1-4', lang: 'en' });
  const ifSet = await jfetch('http://localhost:3115/api/catalog/set?lang=en&id=promo-x');
  const ifCard = (ifSet.cards || []).find((c) => c.id === 'promo-x-2');
  const ifB4 = (reSet.cards || []).find((c) => c.id === 'base1-4');
  const ifBad = (await fetch('http://localhost:3115/api/card', { method: 'POST', headers: ovAuth, body: JSON.stringify({ new: true, set: 'promo-x', localId: '3', name: 'X', imageFrom: 'base1-102' }) })).status;
  check('editor: a new card can reuse another card’s picture (imageless donor refused)',
    ifRes.ok === true && ifCard && ifCard.img && !!ifCard.img.low &&
    ifB4 && ifB4.img && ifCard.img.low === ifB4.img.low && ifBad === 400);

  // ---- removing printings (variants) of a card ----
  const vrCustom = await ovH('/api/variant-remove', { cardId: 'base1-4', variant: 'cosmos-holo', lang: 'en' });
  const vrSet = await jfetch('http://localhost:3115/api/catalog/set?lang=en&id=base1');
  const vrB4 = (vrSet.cards || []).find((c) => c.id === 'base1-4');
  check('editor: removing a custom printing hides it',
    vrCustom.ok === true && !(vrB4.printings && vrB4.printings['cosmos-holo']));
  await ovH('/api/custom-variant', { cardId: 'base1-4', label: 'Cosmos Holo' });
  const raSet = await jfetch('http://localhost:3115/api/catalog/set?lang=en&id=base1');
  const raB4 = (raSet.cards || []).find((c) => c.id === 'base1-4');
  check('editor: re-adding the same printing name restores it',
    raB4.printings && raB4.printings['cosmos-holo'] === 'Cosmos Holo');

  const vrBase = await ovH('/api/variant-remove', { cardId: 'base1-4', variant: 'firstEdition', lang: 'en' });
  await ovH('/api/catalog/import', {});   // a re-import must not resurrect it
  const vrSet2 = await jfetch('http://localhost:3115/api/catalog/set?lang=en&id=base1');
  const vrB42 = (vrSet2.cards || []).find((c) => c.id === 'base1-4');
  check('editor: removed base variant stays gone through a catalog re-import',
    vrBase.ok === true && vrB42 && vrB42.variants && !vrB42.variants.firstEdition && vrB42.variants.holo === true);

  await ovH('/api/variant-remove', { cardId: 'promo-x-1', variant: 'holo', lang: 'en' });
  const vrLast = (await fetch('http://localhost:3115/api/variant-remove', { method: 'POST', headers: ovAuth, body: JSON.stringify({ cardId: 'promo-x-1', variant: 'normal', lang: 'en' }) })).status;
  const vrPromo = await jfetch('http://localhost:3115/api/catalog/set?lang=en&id=promo-x');
  const vrP1 = (vrPromo.cards || []).find((c) => c.id === 'promo-x-1');
  check('editor: the last printing cannot be removed',
    vrLast === 400 && vrP1 && vrP1.variants && vrP1.variants.normal === true && !vrP1.variants.holo);

  // removals are SOFT tombstones: the card row itself stays under master
  // control (updates keep flowing), and the merge bypasses the removed variant
  await ovH('/api/variant-remove', { cardId: 'base1-58', variant: 'firstEdition', lang: 'en' });
  await ovH('/api/catalog/import', {});
  const pkSet = await jfetch('http://localhost:3115/api/catalog/set?lang=en&id=base1');
  const pk = (pkSet.cards || []).find((c) => c.id === 'base1-58');
  let pkSource;
  {
    const { DatabaseSync } = require('node:sqlite');
    const pdb = new DatabaseSync(path.join(ROOT, '.test-data-ov', 'ptcg.db'));
    pkSource = (pdb.prepare("SELECT source FROM cards WHERE lang='en' AND id='base1-58'").get() || {}).source;
    pdb.close();
  }
  check('editor: a variant tombstone leaves the card itself master-owned (soft removal)',
    pk && pk.variants && !pk.variants.firstEdition && pk.variants.normal === true && pkSource === 'master');
  // re-ticking the variant in the card editor lifts the tombstone, scan intact
  await ovH('/api/card', { cardId: 'base1-58', variants: { normal: true, firstEdition: true }, lang: 'en' });
  const pkSet2 = await jfetch('http://localhost:3115/api/catalog/set?lang=en&id=base1');
  const pk2 = (pkSet2.cards || []).find((c) => c.id === 'base1-58');
  check('editor: re-ticking the variant restores it with its scan',
    pk2 && pk2.variants && pk2.variants.firstEdition === true &&
    !!(pk2.variantImages && pk2.variantImages.firstEdition && pk2.variantImages.firstEdition.low));

  // ---- download all images locally: repoint a remote image to /cdn ----
  {
    const { DatabaseSync } = require('node:sqlite');
    const ddb = new DatabaseSync(path.join(ROOT, '.test-data-ov', 'ptcg.db'));
    // point a card at a remote image the mock TCGdex CDN can serve
    ddb.exec("UPDATE cards SET img_low = 'http://localhost:3999/imgcdn/en/images/base1/4/low.webp', img_high = NULL WHERE lang='en' AND id='base1-4'");
    ddb.close();
  }
  const dlCfg = await jfetch('http://localhost:3115/api/app-config');
  const dlStart = await ovH('/api/catalog/download-images', {});
  let dlDone = null;
  for (let i = 0; i < 120 && !dlDone; i++) {
    const st = await jfetch('http://localhost:3115/api/build-status');
    if (!st.running) dlDone = st; else await new Promise((r) => setTimeout(r, 300));
  }
  const dlSet = await jfetch('http://localhost:3115/api/catalog/set?lang=en&id=base1');
  const dlB4 = (dlSet.cards || []).find((c) => c.id === 'base1-4');
  check('download-images: a remote image is detected', dlCfg.images && dlCfg.images.remote >= 1);
  check('download-images: run completes and repoints the row to a local /cdn path',
    dlStart.started === true && dlDone && !dlDone.error && dlB4 && dlB4.img && /^\/cdn\//.test(dlB4.img.low || ''));
  check('download-images: the file was saved on this server',
    fs.existsSync(path.join(ROOT, 'public', 'cdn', 'en', 'images', 'base1', '4', 'low.webp')));

  // ---- SQLite accounts: change-password invalidates old sessions ----
  const cpUser = await jfetch('http://localhost:3115/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'cpuser', password: 'password123' }) });
  const cpAuthOld = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cpUser.token };
  await fetch('http://localhost:3115/api/collection', { method: 'PUT', headers: cpAuthOld, body: JSON.stringify({ collection: { 'base1-4': { holo: 3 } } }) });
  const cpChange = await jfetch('http://localhost:3115/api/change-password', { method: 'POST', headers: cpAuthOld, body: JSON.stringify({ currentPassword: 'password123', newPassword: 'newpassword123' }) });
  const oldTokStatus = (await fetch('http://localhost:3115/api/me', { headers: { Authorization: 'Bearer ' + cpUser.token } })).status;
  const newTokStatus = (await fetch('http://localhost:3115/api/me', { headers: { Authorization: 'Bearer ' + cpChange.token } })).status;
  const cpColl = await jfetch('http://localhost:3115/api/collection', { headers: { Authorization: 'Bearer ' + cpChange.token } });
  check('change-password kills old sessions, keeps new one', cpChange.ok === true && oldTokStatus === 401 && newTokStatus === 200);
  check('collection survives a password change', cpColl.collection['base1-4'] && cpColl.collection['base1-4'].holo === 3);

  // ---- binders API: create (fill-from-set), checklist, move, delete ----
  const buReg = await jfetch('http://localhost:3115/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'binderuser', password: 'password123' }) });
  const buAuth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + buReg.token };
  const bCreate = await jfetch('http://localhost:3115/api/binders', { method: 'POST', headers: buAuth, body: JSON.stringify({ name: 'Base Set Binder', size: 2, color: 'blue', fillFromSet: 'base1', lang: 'en' }) });
  const bd = bCreate.binder || {};
  check('binder: create + fill-from-set places every card of the set',
    bCreate.ok === true && bd.size === 2 && bd.color === 'blue' &&
    Object.keys(bd.slots).length === 5 && bd.pages === 2 && bd.slots['0'] && CARD_OK(bd.slots['0'].card));
  // toggle have on pocket 0 + swap pockets 0 and 4 (across pages)
  const slots2 = { ...bd.slots };
  slots2['0'] = { ...slots2['0'], have: 1 };
  const tmpSwap = slots2['4']; slots2['4'] = slots2['0']; slots2['0'] = tmpSwap;
  const bPut = await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { method: 'PUT', headers: buAuth, body: JSON.stringify({ slots: slots2 }) });
  const bGet = await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { headers: buAuth });
  check('binder: checklist + cross-page move persist',
    bPut.ok === true && bGet.binder.slots['4'].have === 1 && bGet.binder.slots['0'].have === 0 &&
    bGet.binder.slots['4'].card === bd.slots['0'].card);
  const bList = await jfetch('http://localhost:3115/api/binders', { headers: buAuth });
  check('binder: list reports progress', bList.binders.length === 1 && bList.binders[0].filled === 5 && bList.binders[0].have === 1);
  const bAnon = (await fetch('http://localhost:3115/api/binders')).status;
  const bOther = (await fetch(`http://localhost:3115/api/binders/${bd.id}`, { headers: { Authorization: 'Bearer ' + cpChange.token } })).status;
  check('binder: auth required and binders are private per account', bAnon === 401 && bOther === 404);
  // uploaded art spanning pockets: upload -> place {img,w,h} -> excluded from progress
  const pngBuf = fs.readFileSync(path.join(__dirname, 'fixtures', 'base1-4.png'));
  const upRes = await fetch('http://localhost:3115/api/binder-image', { method: 'POST', headers: { Authorization: 'Bearer ' + buReg.token, 'Content-Type': 'image/png' }, body: pngBuf });
  const up = await upRes.json();
  const artSlots = { ...bGet.binder.slots, '6': { img: up.url, w: 2, h: 1 } };
  await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { method: 'PUT', headers: buAuth, body: JSON.stringify({ slots: artSlots }) });
  const bArt = await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { headers: buAuth });
  const bList2 = await jfetch('http://localhost:3115/api/binders', { headers: buAuth });
  const upAnon = (await fetch('http://localhost:3115/api/binder-image', { method: 'POST', body: pngBuf })).status;
  check('binder: image upload + art span persists, art excluded from progress',
    upRes.status === 200 && /^\/bimg\/[a-f0-9-]+\.webp$/.test(up.url || '') &&
    bArt.binder.slots['6'] && bArt.binder.slots['6'].img === up.url && bArt.binder.slots['6'].w === 2 &&
    bList2.binders[0].filled === 5 && upAnon === 401);
  const imgServe = await fetch('http://localhost:3115' + up.url);
  check('binder: uploaded art is served immutably', imgServe.status === 200 && /immutable/.test(imgServe.headers.get('cache-control') || ''));
  // cells-based art: arbitrary pockets + pan/zoom view + cut mode
  const artSlots2 = { ...bArt.binder.slots, '6': { img: up.url, cells: [6, 7], view: { x: -10.5, y: 4, s: 200 }, gaps: 'without' } };
  await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { method: 'PUT', headers: buAuth, body: JSON.stringify({ slots: artSlots2 }) });
  const bArt2 = await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { headers: buAuth });
  const e6 = bArt2.binder.slots['6'] || {};
  check('binder: cells-based art (arbitrary pockets + view + cut mode) persists',
    Array.isArray(e6.cells) && e6.cells.join(',') === '6,7' && e6.gaps === 'without' &&
    e6.view && Math.round(e6.view.s) === 200 && Math.round(e6.view.x * 2) === -21);
  // an art cover can carry its placement (drag/resize view, cover-units)
  const cvPut = await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { method: 'PUT', headers: buAuth, body: JSON.stringify({ cover: { type: 'art', img: up.url, view: { x: -20.5, y: 5, s: 180 } } }) });
  const cvGet = await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { headers: buAuth });
  check('binder: adjustable art cover placement persists',
    cvPut.ok === true && cvGet.binder.cover && cvGet.binder.cover.type === 'art' &&
    cvGet.binder.cover.view && cvGet.binder.cover.view.s === 180 && Math.round(cvGet.binder.cover.view.x * 2) === -41);

  // copy counts ride along on card entries (clamped; ×1 stays implicit)
  const nSlots = { ...bArt2.binder.slots };
  nSlots['4'] = { ...nSlots['4'], n: 3 };
  nSlots['1'] = { ...nSlots['1'], n: 1 };
  await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { method: 'PUT', headers: buAuth, body: JSON.stringify({ slots: nSlots }) });
  const bN = await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { headers: buAuth });
  check('binder: copy counts persist (and ×1 stays implicit)',
    bN.binder.slots['4'].n === 3 && bN.binder.slots['4'].have === 1 && bN.binder.slots['1'].n === undefined);

  // resizing re-lays the pockets, so size changes must bring remapped slots
  const sizeBare = (await fetch(`http://localhost:3115/api/binders/${bd.id}`, { method: 'PUT', headers: buAuth, body: JSON.stringify({ size: 3 }) })).status;
  const remap = (i) => { const p = Math.floor(i / 4), q = i % 4; return p * 9 + Math.floor(q / 2) * 3 + (q % 2); };
  const rmSlots = {};
  for (const [k, v] of Object.entries(bN.binder.slots)) {
    const cells = v.cells ? v.cells.map(remap).sort((a, b) => a - b) : null;
    rmSlots[cells ? cells[0] : remap(parseInt(k, 10))] = cells ? { ...v, cells } : v;
  }
  await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { method: 'PUT', headers: buAuth, body: JSON.stringify({ size: 3, pages: 2, slots: rmSlots }) });
  const bRe = await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { headers: buAuth });
  check('binder: size change persists — cards keep page + position, art cells remap',
    sizeBare === 400 && bRe.binder.size === 3 &&
    bRe.binder.slots['9'] && bRe.binder.slots['9'].n === 3 && bRe.binder.slots['9'].have === 1 &&
    bRe.binder.slots['12'] && (bRe.binder.slots['12'].cells || []).join(',') === '12,13' &&
    bRe.binder.slots['4'] && typeof bRe.binder.slots['4'].card === 'string');

  const bDel = await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { method: 'DELETE', headers: buAuth });
  const bGone = (await fetch(`http://localhost:3115/api/binders/${bd.id}`, { headers: buAuth })).status;
  check('binder: delete removes it', bDel.ok === true && bGone === 404);

  // ---- SQLite migration: a pre-SQLite JSON install imports on first boot ----
  const migDir = path.join(ROOT, '.test-data-mig');
  fs.rmSync(migDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(migDir, 'collections'), { recursive: true });
  const migId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const migSalt = 'abcd', migHash = require('crypto').scryptSync('password123', migSalt, 64).toString('hex');
  fs.writeFileSync(path.join(migDir, 'users.json'), JSON.stringify({ olduser: { id: migId, display: 'olduser', salt: migSalt, hash: migHash, created: '2020-01-01T00:00:00Z', admin: true } }));
  fs.writeFileSync(path.join(migDir, 'collections', migId + '.json'), JSON.stringify({ collection: { 'base1-58': { normal: 5 } }, updatedAt: 42 }));
  start('node', ['server.js'], { PORT: '3116', DATA_DIR: migDir });
  await waitForPort(3116).catch((e) => fail(e.message));
  const migLogin = await jfetch('http://localhost:3116/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'olduser', password: 'password123' }) });
  const migAuth = { Authorization: 'Bearer ' + (migLogin.token || '') };
  const migColl = migLogin.token ? await jfetch('http://localhost:3116/api/collection', { headers: migAuth }) : {};
  const migMe = migLogin.token ? await jfetch('http://localhost:3116/api/me', { headers: migAuth }) : {};
  check('JSON→SQLite migration: old password still logs in', !!migLogin.token);
  check('JSON→SQLite migration: collection + admin flag preserved',
    migColl.collection && migColl.collection['base1-58'] && migColl.collection['base1-58'].normal === 5 && migMe.admin === true);
  check('JSON→SQLite migration: db created, old files archived',
    fs.existsSync(path.join(migDir, 'ptcg.db')) && fs.existsSync(path.join(migDir, 'users.json.migrated')));

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

  console.log('=== 8/8 master catalog.db publish → pull round-trip (against mock S3) ===');
  const os = require('os');
  start('node', ['tests/mock-s3.js']);
  await waitForPort(3998).catch((e) => fail(e.message));
  const r2env = {
    R2_ENDPOINT: 'http://localhost:3998',
    R2_ACCESS_KEY_ID: 'testkey',
    R2_SECRET_ACCESS_KEY: 'testsecret',
    R2_BUCKET: 'cards',
    // build catalog.db from :3111's database (has an admin-added custom printing)
    // and rewrite image locations to the bucket's public URL
    DATA_DIR: path.join(ROOT, '.test-data'),
    PTCG_CDN_BASE: 'http://localhost:3998/cards',
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

  // ---- the master catalog.db exists on the bucket and is a real SQLite file ----
  const catRes = await fetch('http://localhost:3998/cards/catalog.db');
  const catBuf = Buffer.from(await catRes.arrayBuffer());
  check('publisher uploads a master catalog.db (a real SQLite database)',
    catRes.ok && catBuf.length > 1000 && catBuf.slice(0, 15).toString() === 'SQLite format 3');

  // ---- a fresh install (no local build) pulls the master catalog.db on boot ----
  // Copy the app to an isolated dir so dbExists() is false — the real
  // non-Proxmox / Proxmox-LXC situation. It points at the bucket's public URL.
  const pullRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ptcg-pull-'));
  for (const item of ['server.js', 'public', 'scripts', 'package.json']) {
    fs.cpSync(path.join(ROOT, item), path.join(pullRoot, item), {
      recursive: true,
      filter: (s) => !/[/\\](cdn|node_modules|\.git|\.test-data)/.test(s),
    });
  }
  // ---- installer step: `node server.js --pull-master` loads the DB and exits
  //      (what the LXC installer runs so a fresh install comes up with cards)
  const cliPull = spawnSync('node', ['server.js', '--pull-master'], {
    cwd: pullRoot, encoding: 'utf8',
    env: { ...process.env, DATA_DIR: path.join(pullRoot, 'data-cli'), PTCG_CDN_BASE: 'http://localhost:3998/cards' },
  });
  check('installer CLI: --pull-master loads the database and exits cleanly',
    cliPull.status === 0 && /Card database loaded: \d+ cards/.test((cliPull.stdout || '') + (cliPull.stderr || '')));

  // The boot server reads its master location from config.js — written here
  // the way the REAL committed file looks, comment examples included. (An
  // unanchored regex once matched `cdnBase: 'cdn'` inside the comment and
  // silently disabled the remote master on every install.)
  fs.writeFileSync(path.join(pullRoot, 'public', 'config.js'),
    "/* example:\n *   cdnBase: 'cdn'\n *   cdnBase: 'https://cards.example.com/cdn'\n */\n" +
    "self.PTCG_CONFIG = {\n  cdnBase: 'http://localhost:3998/cards',\n  defaultLanguage: 'en',\n  imageBase: null,\n};\n");
  // the installer writes the deployed release tag next to the app
  fs.writeFileSync(path.join(pullRoot, 'version.txt'), '9.9.9\n');
  const pullChild = spawn('node', ['server.js'], {
    cwd: pullRoot,
    env: { ...process.env, PORT: '3117', DATA_DIR: path.join(pullRoot, 'data') },
    stdio: 'inherit',
  });
  children.push(pullChild);
  await waitForPort(3117).catch((e) => fail(e.message));
  let pullStats = { cards: 0, sets: 0 };
  for (let i = 0; i < 240 && pullStats.cards === 0; i++) {
    const st = await jfetch('http://localhost:3117/api/build-status').catch(() => ({}));
    pullStats = await jfetch('http://localhost:3117/api/catalog/stats').catch(() => pullStats);
    if (pullStats.cards === 0 && st && !st.running && st.error) fail('catalog pull errored: ' + st.error);
    if (pullStats.cards === 0) await new Promise((r) => setTimeout(r, 300));
  }
  const pullCfg = await jfetch('http://localhost:3117/api/app-config');
  const pullSet = await jfetch('http://localhost:3117/api/catalog/set?lang=en&id=base1');
  const pullCard = (pullSet.cards || []).find((c) => c.id === 'base1-4');
  check('pull: fresh install reports its remote database', pullCfg.remoteCatalog === 'http://localhost:3998/cards');
  check('app-config reports the deployed release tag (version.txt)', pullCfg.release === '9.9.9');
  check('pull: boot auto-loads the master catalog', pullStats.cards > 10 && pullStats.sets >= 2);
  check('pull: card images point at the bucket (R2), not a local /cdn path',
    pullCard && pullCard.img && /^http:\/\/localhost:3998\/cards\//.test(pullCard.img.low || ''));
  check('pull: the admin’s custom printing propagated through the master',
    pullCard && pullCard.printings && pullCard.printings['cracked-ice-holo'] === 'Cracked Ice Holo' &&
    pullCard.variantImages && /^http:\/\/localhost:3998\/cards\//.test((pullCard.variantImages['cracked-ice-holo'] || {}).low || ''));

  // ---- versioning: install recorded v1, update-check agrees it's current ----
  const catManifest = await jfetch('http://localhost:3998/cards/catalog.json');
  check('publisher writes catalog.json manifest (version 1)', catManifest.version === 1 && !!catManifest.contentHash);
  check('pull: install recorded the master version', pullCfg.masterVersion === 1);
  const chk1 = await jfetch('http://localhost:3117/api/catalog/update-check');
  check('update-check: up to date after the pull', chk1.configured && chk1.reachable && chk1.behind === false && chk1.localVersion === 1);

  // ---- scanner works on a pulled-only install (index fetched from bucket) ----
  const pulledScan = await jfetch('http://localhost:3117/api/catalog/scan-index?lang=en');
  check('pull: scanner index served from the bucket on a pulled-only install',
    Array.isArray(pulledScan.cards) && pulledScan.cards.length > 0);

  // ---- master v2: local edit survives, master deletion propagates ----
  // the pulled install makes a LOCAL edit (its own printing on base1-58)…
  const pReg = await jfetch('http://localhost:3117/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pulladmin', password: 'password123' }) });
  const pAuth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + pReg.token };
  await jfetch('http://localhost:3117/api/custom-variant', { method: 'POST', headers: pAuth, body: JSON.stringify({ cardId: 'base1-58', label: 'My Local Promo' }) });
  // …meanwhile the MASTER hides one card (a deletion) and republishes
  {
    const { DatabaseSync } = require('node:sqlite');
    const mdb = new DatabaseSync(path.join(ROOT, '.test-data', 'ptcg.db'));
    mdb.exec("UPDATE cards SET hidden = 1 WHERE lang = 'en' AND id = 'base1-102'");
    mdb.close();
  }
  const pub5 = spawnSync('node', ['scripts/publish-images.js'], { cwd: ROOT, env: { ...process.env, ...r2env }, encoding: 'utf8' });
  const out5 = (pub5.stdout || '') + (pub5.stderr || '');
  check('publisher bumps the version when master content changes', pub5.status === 0 && /version 2/.test(out5));
  const chk2 = await jfetch('http://localhost:3117/api/catalog/update-check');
  check('update-check: install reports it is behind (v1 → v2)', chk2.behind === true && chk2.remoteVersion === 2);
  // the install updates via the admin endpoint (what the app button calls)
  await jfetch('http://localhost:3117/api/catalog/pull', { method: 'POST', headers: pAuth, body: '{}' });
  let upDone = null;
  for (let i = 0; i < 120 && !upDone; i++) {
    const st = await jfetch('http://localhost:3117/api/build-status');
    if (!st.running) upDone = st; else await new Promise((r) => setTimeout(r, 300));
  }
  const pullCfg2 = await jfetch('http://localhost:3117/api/app-config');
  const pullSet2 = await jfetch('http://localhost:3117/api/catalog/set?lang=en&id=base1');
  const gone = (pullSet2.cards || []).find((c) => c.id === 'base1-102');
  const pika = (pullSet2.cards || []).find((c) => c.id === 'base1-58');
  const chk3 = await jfetch('http://localhost:3117/api/catalog/update-check');
  check('update: install moved to master v2', pullCfg2.masterVersion === 2 && chk3.behind === false);
  check('update: master deletion propagated (hidden card disappeared)', upDone && !upDone.error && !gone);
  check('update: the install’s own local printing SURVIVED the master update',
    pika && pika.printings && pika.printings['my-local-promo'] === 'My Local Promo');

  // ---- reviewed updates: the master ADDS a set, a card, and a variant;
  //      the install's admin previews, takes some, soft-bypasses the rest ----
  {
    const { DatabaseSync } = require('node:sqlite');
    const mdb = new DatabaseSync(path.join(ROOT, '.test-data', 'ptcg.db'));
    mdb.exec("INSERT INTO sets (lang,id,name,official_count,position,source,hidden) VALUES ('en','promo-z','Promo Z',1,999,'master',0)");
    mdb.exec("INSERT INTO cards (lang,id,set_id,local_id,name,variants_csv,position,source,hidden) VALUES ('en','promo-z-1','promo-z','1','Zapdos Promo','normal',0,'master',0)");
    mdb.exec("INSERT INTO cards (lang,id,set_id,local_id,name,variants_csv,position,source,hidden) VALUES ('en','base1-200','base1','200','Extra Card','normal',9000,'master',0)");
    mdb.exec("UPDATE cards SET variants_csv = variants_csv || ',reverse' WHERE lang='en' AND id='base1-58'");
    mdb.close();
  }
  const pub6 = spawnSync('node', ['scripts/publish-images.js'], { cwd: ROOT, env: { ...process.env, ...r2env }, encoding: 'utf8' });
  if (pub6.status !== 0) fail('v3 publish failed: ' + (pub6.stdout || '') + (pub6.stderr || ''));
  const rvPrev = await jfetch('http://localhost:3117/api/catalog/preview', { method: 'POST', headers: pAuth, body: '{}' });
  check('review: preview lists the master’s new set, new card, and new printing',
    (rvPrev.newSets || []).some((x) => x.id === 'promo-z' && x.cards === 1) &&
    (rvPrev.newCards || []).some((g) => g.set === 'base1' && g.cards.some((c) => c.id === 'base1-200')) &&
    (rvPrev.newVariants || []).some((v) => v.card === 'base1-58' && v.variant === 'reverse') &&
    rvPrev.additions >= 3);
  // take the new card; bypass the new set and the new printing
  await jfetch('http://localhost:3117/api/catalog/pull', { method: 'POST', headers: pAuth, body: JSON.stringify({
    bypass: { sets: [{ lang: 'en', id: 'promo-z' }], cards: [], variants: [{ lang: 'en', card: 'base1-58', variant: 'reverse' }] },
  }) });
  let rvDone = null;
  for (let i = 0; i < 120 && !rvDone; i++) {
    const st = await jfetch('http://localhost:3117/api/build-status');
    if (!st.running) rvDone = st; else await new Promise((r) => setTimeout(r, 300));
  }
  const rvIdx = await jfetch('http://localhost:3117/api/catalog/index?lang=en');
  const rvBase = await jfetch('http://localhost:3117/api/catalog/set?lang=en&id=base1');
  const rvNew = (rvBase.cards || []).find((c) => c.id === 'base1-200');
  const rvPika = (rvBase.cards || []).find((c) => c.id === 'base1-58');
  check('review: accepted card arrived; bypassed set and printing stay invisible',
    rvDone && !rvDone.error && !!rvNew &&
    !(rvIdx.sets || []).some((x) => x.id === 'promo-z') &&
    rvPika && rvPika.variants && !rvPika.variants.reverse);
  {
    const { DatabaseSync } = require('node:sqlite');
    const idb = new DatabaseSync(path.join(pullRoot, 'data', 'ptcg.db'));
    const zs = idb.prepare("SELECT hidden, source FROM sets WHERE lang='en' AND id='promo-z'").get();
    const zc = idb.prepare("SELECT hidden FROM cards WHERE lang='en' AND id='promo-z-1'").get();
    const rv = idb.prepare("SELECT hidden, source FROM printings WHERE lang='en' AND card_id='base1-58' AND variant='reverse'").get();
    idb.close();
    check('review: bypassed items are stored hidden (soft), not dropped',
      zs && zs.hidden === 1 && zs.source === 'local' &&
      zc && zc.hidden === 1 &&
      rv && rv.hidden === 1 && rv.source === 'local');
  }
  const rvPrev2 = await jfetch('http://localhost:3117/api/catalog/preview', { method: 'POST', headers: pAuth, body: '{}' });
  check('review: a later preview does not re-offer bypassed items',
    !(rvPrev2.newSets || []).some((x) => x.id === 'promo-z') &&
    !(rvPrev2.newVariants || []).some((v) => v.card === 'base1-58' && v.variant === 'reverse') &&
    !(rvPrev2.newCards || []).some((g) => g.cards.some((c) => c.id === 'base1-200')));
  // a bypassed set can be restored later — cards come back with it
  const hsList = await jfetch('http://localhost:3117/api/hidden-sets?lang=en', { headers: pAuth });
  await jfetch('http://localhost:3117/api/set-hide', { method: 'POST', headers: pAuth, body: JSON.stringify({ id: 'promo-z', hidden: false, lang: 'en' }) });
  const rvIdx2 = await jfetch('http://localhost:3117/api/catalog/index?lang=en');
  const rvZ = await jfetch('http://localhost:3117/api/catalog/set?lang=en&id=promo-z');
  check('review: a bypassed set restores later, cards included',
    (hsList.sets || []).some((x) => x.id === 'promo-z') &&
    (rvIdx2.sets || []).some((x) => x.id === 'promo-z') &&
    ((rvZ && rvZ.cards) || []).some((c) => c.id === 'promo-z-1'));

  // ---- a workspace seeded by PULLING the master (no local image tree)
  //      can still publish — catalog only, images stay on the bucket ----
  // (the scan-index fallback caches into public/cdn, so clear it to get the
  //  true "just pulled, never built" state — and --prune must refuse even
  //  when a stray cached file exists, since there are no local images)
  const wsPrune = spawnSync('node', ['scripts/publish-images.js', '--prune'], {
    cwd: pullRoot, encoding: 'utf8',
    env: { ...process.env, ...r2env, DATA_DIR: path.join(pullRoot, 'data') },
  });
  check('image-less workspace refuses --prune (would delete every bucket image)', wsPrune.status === 1);
  fs.rmSync(path.join(pullRoot, 'public', 'cdn'), { recursive: true, force: true });
  const wsPub = spawnSync('node', ['scripts/publish-images.js'], {
    cwd: pullRoot, encoding: 'utf8',
    env: { ...process.env, ...r2env, DATA_DIR: path.join(pullRoot, 'data'), PTCG_CDN_BASE: 'http://localhost:3998/cards' },
  });
  const wsOut = (wsPub.stdout || '') + (wsPub.stderr || '');
  check('image-less workspace publishes the master catalog (no public/cdn needed)',
    wsPub.status === 0 && /publishing the master catalog only/.test(wsOut) && /version 4/.test(wsOut));   // v3 was the reviewed-additions publish above

  const pullOk = catRes.ok && pullCfg.remoteCatalog === 'http://localhost:3998/cards' && pullStats.cards > 10 &&
    pullCard && pullCard.printings && pullCard.printings['cracked-ice-holo'] === 'Cracked Ice Holo' &&
    catManifest.version === 1 && chk2.behind === true && pullCfg2.masterVersion === 2 && !gone &&
    !!(pika && pika.printings && pika.printings['my-local-promo']);
  try { pullChild.kill(); } catch { /* gone */ }
  try { fs.rmSync(pullRoot, { recursive: true, force: true }); } catch { /* best effort */ }

  cleanup();
  for (const d of ['.test-data', '.test-data-ro', '.test-data-mirror', '.test-data-ov', '.test-data-mig']) {
    fs.rmSync(path.join(ROOT, d), { recursive: true, force: true });
  }
  if (suite.status !== 0) { console.error('\nBrowser suite failed.'); process.exit(1); }
  if (!publishOk) { console.error('\nPublisher checks failed.'); process.exit(1); }
  if (!pullOk) { console.error('\nMaster catalog.db pull round-trip failed.'); process.exit(1); }
  if (stageFails) { console.error(`\n${stageFails} importer/read-only/mirror check(s) failed.`); process.exit(1); }

  console.log('\nAll stages completed.');
})().catch((e) => fail(e.stack || e.message));
