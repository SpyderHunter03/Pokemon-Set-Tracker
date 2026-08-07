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

/* `capture` pipes the child's output instead of inheriting it, keeps a copy on
 * child.log, and still echoes it so the run reads the same. Needed because the
 * first-run setup code is printed to the server's own log and reading it there
 * IS the mechanism under test — there is deliberately no other way to get it. */
function start(cmd, args, env = {}, capture = false) {
  const child = spawn(cmd, args, {
    cwd: ROOT, env: { ...process.env, ...env },
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (capture) {
    child.log = '';
    const tee = (d) => { child.log += d.toString(); process.stdout.write(d); };
    child.stdout.on('data', tee);
    child.stderr.on('data', tee);
  }
  children.push(child);
  return child;
}

/** Wait for something to show up in a captured child's log. */
async function waitForLog(child, re, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = re.exec(child.log || '');
    if (m) return m;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
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
  const mainServer = start('node', ['server.js'], {
    PORT: '3111',
    DATA_DIR: path.join(ROOT, '.test-data'),
    PTCG_SOURCE_API: 'http://localhost:3999/v2',
  }, true);
  await waitForPort(3111).catch((e) => fail(e.message));
  // the install is unclaimed, so it printed a code; the browser suite needs it
  const codeMatch = await waitForLog(mainServer, /\b([0-9a-f]{32})\b/);
  if (!codeMatch) fail('the server never printed a first-run setup code');

  console.log('=== 3/8 bootstrap suite (first-run setup + download button + admin update) ===');
  const bootstrap = spawnSync('node', ['tests/bootstrap.test.js'], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, SETUP_CODE: codeMatch[1] },
  });
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
  // Two things a bare "TypeError: fetch failed" gets wrong. It names neither
  // the URL nor the reason, which costs a whole run to work out. And after a
  // long gap between requests to the same server — the browser suite takes
  // minutes — the first call back can pick a pooled socket the server has
  // already timed out, which surfaces as UND_ERR_SOCKET and is a transport
  // flake, not a result. Retry that one exactly once, on a fresh connection.
  const SOCKET_FLAKE = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED']);
  const jfetch = async (url, opts) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetch(url, opts).then((r) => r.json());
      } catch (e) {
        const code = e.cause && (e.cause.code || e.cause.message);
        if (attempt === 0 && SOCKET_FLAKE.has(code)) { await new Promise((r) => setTimeout(r, 250)); continue; }
        throw new Error(`${(opts && opts.method) || 'GET'} ${url} failed: ${e.message}${code ? ` (${code})` : ''}`);
      }
    }
  };
  const CARD_OK = (id) => typeof id === 'string' && /^[a-zA-Z0-9.-]+$/.test(id);

  // ---- a card added here is scannable, even though no bulk build knows it ----
  // The bootstrap suite invented `test-promos-1` in the editor and uploaded a
  // picture for it. build-hashes.js has since run (stage 5) and could not have
  // seen it: it reads public/cdn/<lang>/sets/*.json, and a set created in the
  // editor has no file there. The fingerprint taken at upload time is what
  // puts the card in front of the scanner.
  {
    const si = await jfetch('http://localhost:3111/api/catalog/scan-index?lang=en');
    const rows = si.cards || [];
    const mine = rows.filter((r) => r[0] === 'test-promos-1');
    check('scan index: a card added in the editor is fingerprinted', mine.length === 1 && /^[0-9a-f]{32}$/.test(mine[0][1]));
    check('scan index: the bulk-built cards are still all there', rows.length > 5 && rows.some((r) => r[0] === 'base1-4'));
    check('scan index: no card is listed twice', new Set(rows.map((r) => r[0])).size === rows.length);
    check('scan index: reports which algorithm produced it', si.algo === 'boxdhash2-9x8');
    const sameHash = await jfetch('http://localhost:3111/api/catalog/scan-index?lang=en');
    check('scan index: merging is stable across requests',
      JSON.stringify(sameHash.cards) === JSON.stringify(rows));
    const noAuth = await fetch('http://localhost:3111/api/scan-index/rebuild', { method: 'POST', body: '{}' });
    check('scan index: rebuilding needs the administrator', noAuth.status === 403);
  }

  // ---- binder art that nothing points at is reclaimed ----
  // Uploads land on disk before any binder mentions them, so the sweep leaves
  // anything recent alone; only files old enough to be certainly abandoned go.
  {
    const reg = await jfetch('http://localhost:3111/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'binderart', password: 'password123' }) });
    const bAuth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + reg.token };
    const artDir = path.join(ROOT, '.test-data', 'binder-images');
    fs.mkdirSync(artDir, { recursive: true });
    const uuid = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
    const write = (name, ageMs) => {
      const f = path.join(artDir, name + '.webp');
      fs.writeFileSync(f, 'not really a webp, the sweep only reads names and dates');
      const t = (Date.now() - ageMs) / 1000;
      fs.utimesSync(f, t, t);
      return f;
    };
    const keptRef = write(uuid(1), 3 * 60 * 60 * 1000);   // old, but a binder uses it
    const orphanOld = write(uuid(2), 3 * 60 * 60 * 1000); // old and unreferenced
    const orphanNew = write(uuid(3), 0);                  // unreferenced, just uploaded
    const made = await jfetch('http://localhost:3111/api/binders', { method: 'POST', headers: bAuth, body: JSON.stringify({ name: 'Art Binder', size: 2 }) });
    const bid = made.binder && made.binder.id;
    await jfetch(`http://localhost:3111/api/binders/${bid}`, { method: 'PUT', headers: bAuth, body: JSON.stringify({
      cover: { type: 'art', img: `/bimg/${uuid(1)}.webp` },
      slots: { 0: { img: `/bimg/${uuid(2)}.webp`, cells: [0] } },
    }) });
    check('binder art: a save keeps every picture the binder points at',
      fs.existsSync(keptRef) && fs.existsSync(orphanOld));
    // now take the slot art away — that is what strands the file
    await jfetch(`http://localhost:3111/api/binders/${bid}`, { method: 'PUT', headers: bAuth, body: JSON.stringify({ slots: {} }) });
    check('binder art: art nothing points at any more is reclaimed', !fs.existsSync(orphanOld));
    check('binder art: the cover picture is still referenced, so it stays', fs.existsSync(keptRef));
    check('binder art: a picture uploaded moments ago is never swept', fs.existsSync(orphanNew));
    // deleting the binder strands the cover too
    await fetch(`http://localhost:3111/api/binders/${bid}`, { method: 'DELETE', headers: bAuth });
    check('binder art: deleting a binder reclaims its cover', !fs.existsSync(keptRef));
    check('binder art: the recent upload survives even a delete sweep', fs.existsSync(orphanNew));
    try { fs.unlinkSync(orphanNew); } catch { /* tidy */ }
  }

  // ---- the sixty-page ceiling ----
  // MAX_BINDER_PAGES clamps in three places and none of them was ever
  // exercised, because reaching it through the UI means sixty sheets. It does
  // not: every clamp is server-side, so a set too big to fit and a couple of
  // absurd page counts reach all three in a few requests.
  {
    const reg = await jfetch('http://localhost:3111/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'binderceiling', password: 'password123' }) });
    const cAuth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + reg.token };
    // a set far larger than any binder holds: 200 cards, two printings each
    {
      const { DatabaseSync } = require('node:sqlite');
      const cdb = new DatabaseSync(path.join(ROOT, '.test-data', 'ptcg.db'));
      cdb.exec("INSERT OR REPLACE INTO sets (lang,id,name,official_count,position,source,hidden) VALUES ('en','ceiling','Ceiling Set',200,997,'local',0)");
      const ins = cdb.prepare("INSERT OR REPLACE INTO cards (lang,id,set_id,local_id,name,variants_csv,position,source,hidden) VALUES ('en',?,'ceiling',?,?,'normal,holo',?,'local',0)");
      for (let i = 1; i <= 200; i++) ins.run('ceiling-' + i, String(i), 'Ceiling ' + i, i);
      cdb.close();
    }
    // 200 cards x 2 printings = 400 pockets wanted; a 2x2 binder holds 60 x 4 = 240
    const big = await jfetch('http://localhost:3111/api/binders', { method: 'POST', headers: cAuth, body: JSON.stringify({ name: 'Ceiling', size: 2, fillFromSet: 'ceiling' }) });
    check('binder ceiling: a fill bigger than the binder stops at sixty pages',
      big.binder && big.binder.pages === 60);
    check('binder ceiling: it fills what fits and says how much it left',
      big.filled === 240 && big.skipped === 160 && big.filled + big.skipped === 400);
    // and a page count typed past the ceiling comes back at the ceiling
    const bigId = big.binder.id;
    await jfetch(`http://localhost:3111/api/binders/${bigId}`, { method: 'PUT', headers: cAuth, body: JSON.stringify({ pages: 500 }) });
    const bigGot = await jfetch(`http://localhost:3111/api/binders/${bigId}`, { headers: cAuth });
    check('binder ceiling: asking for five hundred pages gets sixty',
      bigGot.binder && bigGot.binder.pages === 60 && Object.keys(bigGot.binder.slots).length === 240);
    // a pocket past the last page of a full-size binder is not a pocket
    const over = await jfetch('http://localhost:3111/api/binders', { method: 'POST', headers: cAuth, body: JSON.stringify({ name: 'Over', size: 2 }) });
    const overId = over.binder.id;
    await jfetch(`http://localhost:3111/api/binders/${overId}`, { method: 'PUT', headers: cAuth, body: JSON.stringify({
      pages: 61, slots: { 239: { card: 'base1-4', variant: 'normal' }, 240: { card: 'base1-58', variant: 'normal' } },
    }) });
    const overGot = await jfetch(`http://localhost:3111/api/binders/${overId}`, { headers: cAuth });
    check('binder ceiling: a pocket beyond the last page is dropped, the one inside kept',
      overGot.binder.pages === 60 &&
      Object.keys(overGot.binder.slots).length === 1 && !!overGot.binder.slots['239']);
    // the floor holds too — a binder cannot have no pages at all
    const tiny = await jfetch('http://localhost:3111/api/binders', { method: 'POST', headers: cAuth, body: JSON.stringify({ name: 'Tiny', size: 2 }) });
    await jfetch(`http://localhost:3111/api/binders/${tiny.binder.id}`, { method: 'PUT', headers: cAuth, body: JSON.stringify({ pages: 0 }) });
    const tinyGot = await jfetch(`http://localhost:3111/api/binders/${tiny.binder.id}`, { headers: cAuth });
    check('binder ceiling: zero pages is still one page', tinyGot.binder.pages === 1);
  }

  // ---- sign-in security ----
  // Its own pair of servers, because most of this is about what an install
  // was TOLD about its network, and because filling a rate-limit bucket on
  // purpose has no business happening on a server other stages still use.
  {
    const bare = path.join(ROOT, '.test-data-auth');
    const proxied = path.join(ROOT, '.test-data-auth-proxy');
    fs.rmSync(bare, { recursive: true, force: true });
    fs.rmSync(proxied, { recursive: true, force: true });
    start('node', ['server.js'], { PORT: '3118', DATA_DIR: bare });
    start('node', ['server.js'], { PORT: '3119', DATA_DIR: proxied, PTCG_TRUSTED_PROXY: 'loopback' });
    await waitForPort(3118).catch((e) => fail(e.message));
    await waitForPort(3119).catch((e) => fail(e.message));
    const A = 'http://localhost:3118', P = 'http://localhost:3119';
    const jbody = { 'Content-Type': 'application/json' };
    const login = (base, u, p, hdrs) => fetch(`${base}/api/login`, { method: 'POST', headers: { ...jbody, ...(hdrs || {}) }, body: JSON.stringify({ username: u, password: p }) });

    // ---- a header anyone can send is not an identity ----
    // Twenty-five attempts, each claiming to come from somewhere new, each
    // against a different account so the per-account lock cannot be what
    // stops them. Nothing is trusted here, so all of it is one address.
    let spoofed = [];
    for (let i = 1; i <= 25; i++) {
      spoofed.push((await login(A, 'ghost' + i, 'xxxxxxxxxx', { 'X-Forwarded-For': '10.9.9.' + i })).status);
    }
    check('forwarded-for: a spoofed address buys no extra attempts', spoofed.includes(429));
    // and the same run against an install that DOES sit behind a proxy: each
    // client it reports is counted on its own, which is the point of the flag
    let honoured = [];
    for (let i = 1; i <= 25; i++) {
      honoured.push((await login(P, 'ghost' + i, 'xxxxxxxxxx', { 'X-Forwarded-For': '10.9.9.' + i })).status);
    }
    check('forwarded-for: a trusted proxy is believed, so real clients are not lumped together',
      !honoured.includes(429));

    // ---- a proxy that SETS its own header beats a list anyone can prepend to ----
    // A third install, told to read CF-Connecting-IP the way a Cloudflare
    // origin would. The forwarded chain is left deliberately hostile: the
    // named header is the one that decides.
    const cfDir = path.join(ROOT, '.test-data-auth-cf');
    fs.rmSync(cfDir, { recursive: true, force: true });
    start('node', ['server.js'], { PORT: '3120', DATA_DIR: cfDir, PTCG_TRUSTED_PROXY: 'loopback', PTCG_CLIENT_IP_HEADER: 'CF-Connecting-IP' });
    await waitForPort(3120).catch((e) => fail(e.message));
    const C = 'http://localhost:3120';
    let cfSame = [];
    for (let i = 1; i <= 25; i++) {
      // one real client, pretending to be twenty-five by rewriting the chain
      cfSame.push((await login(C, 'ghost' + i, 'xxxxxxxxxx',
        { 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '10.4.4.' + i })).status);
    }
    check('client-ip header: one client cannot become many by rewriting the chain', cfSame.includes(429));
    let cfMany = [];
    for (let i = 1; i <= 10; i++) {
      cfMany.push((await login(C, 'other' + i, 'xxxxxxxxxx', { 'CF-Connecting-IP': '203.0.113.' + (100 + i) })).status);
    }
    check('client-ip header: and genuinely different clients are still counted apart',
      !cfMany.includes(429));

    // ---- the account is throttled, not just the address ----
    const reg = await jfetch(`${P}/api/register`, { method: 'POST', headers: jbody, body: JSON.stringify({ username: 'locky', password: 'correcthorsebattery' }) });
    check('sign-in: registering hands back a session', !!reg.token);
    let lockCodes = [];
    for (let i = 0; i < 11; i++) {
      lockCodes.push((await login(P, 'locky', 'wrongwrongwrong', { 'X-Forwarded-For': '10.8.8.' + i })).status);
    }
    check('sign-in: one account guessed from many addresses still gets locked', lockCodes.includes(429));
    check('sign-in: the lock holds even against the right password',
      (await login(P, 'locky', 'correcthorsebattery', { 'X-Forwarded-For': '10.8.8.200' })).status === 429);
    const other = await jfetch(`${P}/api/register`, { method: 'POST', headers: jbody, body: JSON.stringify({ username: 'bystander', password: 'correcthorsebattery' }) });
    check('sign-in: locking one account leaves the others alone',
      !!other.token && (await login(P, 'bystander', 'correcthorsebattery', { 'X-Forwarded-For': '10.8.8.201' })).status === 200);

    // ---- a password from the old scheme still opens the door, then moves on ----
    {
      const { DatabaseSync } = require('node:sqlite');
      const crypto = require('crypto');
      const db = new DatabaseSync(path.join(proxied, 'ptcg.db'));
      const salt = crypto.randomBytes(16).toString('hex');
      // exactly what the previous code wrote: bare hex, no parameters with it
      const legacy = crypto.scryptSync('oldpassword123', salt, 64).toString('hex');
      db.prepare('INSERT INTO users (id,username,display,salt,hash,created,admin) VALUES (?,?,?,?,?,?,0)')
        .run('legacy-user-id', 'oldtimer', 'Oldtimer', salt, legacy, new Date().toISOString());
      db.close();
      check('passwords: an old hash carries no parameters', !legacy.includes('$'));
    }
    check('passwords: an account made under the old scheme still signs in',
      (await login(P, 'oldtimer', 'oldpassword123', { 'X-Forwarded-For': '10.7.7.1' })).status === 200);
    {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(proxied, 'ptcg.db'), { readOnly: true });
      const row = db.prepare("SELECT hash FROM users WHERE username='oldtimer'").get();
      db.close();
      check('passwords: signing in quietly rewrites it at the new cost',
        row.hash.startsWith('scrypt$N=65536,r=8,p=1$'));
    }
    check('passwords: and it still opens the door after the rewrite',
      (await login(P, 'oldtimer', 'oldpassword123', { 'X-Forwarded-For': '10.7.7.2' })).status === 200);
    const shortPw = await fetch(`${P}/api/register`, { method: 'POST', headers: jbody, body: JSON.stringify({ username: 'shorty', password: '123456789' }) });
    check('passwords: nine characters is not enough', shortPw.status === 400);

    // ---- the session is a cookie the page cannot read ----
    const cookieOf = (res) => (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]).filter(Boolean);
    const regRes = await fetch(`${P}/api/register`, { method: 'POST', headers: jbody, body: JSON.stringify({ username: 'cookieuser', password: 'correcthorsebattery' }) });
    const setCookies = cookieOf(regRes);
    const session = setCookies.find((c) => c.startsWith('ptcg_session='));
    check('session: signing in sets a cookie script cannot read', !!session && /HttpOnly/i.test(session));
    check('session: and one a stranger cannot make the browser send', /SameSite=Strict/i.test(session));
    check('session: Secure is left off on a plain-http install, or the cookie would be dropped',
      !/;\s*Secure/i.test(session));
    const jar = session.split(';')[0];
    const me = await jfetch(`${P}/api/me`, { headers: { Cookie: jar } });
    check('session: the cookie alone identifies the account', me.username === 'cookieuser');

    // ---- a cookie travels by itself, so a write has to prove it meant to ----
    const write = (hdrs) => fetch(`${P}/api/collection`, { method: 'PUT', headers: { ...jbody, ...hdrs }, body: JSON.stringify({ collection: {} }) });
    check('session: a write from this site is fine',
      (await write({ Cookie: jar, 'Sec-Fetch-Site': 'same-origin' })).status === 200);
    check('session: the same write from somebody else’s page is refused',
      (await write({ Cookie: jar, 'Sec-Fetch-Site': 'cross-site' })).status === 403);
    check('session: an Origin from elsewhere is refused too',
      (await write({ Cookie: jar, Origin: 'https://evil.example' })).status === 403);
    const tok = (await jfetch(`${P}/api/login`, { method: 'POST', headers: { ...jbody, 'X-Forwarded-For': '10.6.6.1' }, body: JSON.stringify({ username: 'cookieuser', password: 'correcthorsebattery' }) })).token;
    check('session: a Bearer token is exempt — nothing attaches one by accident',
      (await write({ Authorization: 'Bearer ' + tok, Origin: 'https://evil.example' })).status === 200);
    const bye = await fetch(`${P}/api/logout`, { method: 'POST', headers: { Cookie: jar, 'Sec-Fetch-Site': 'same-origin' }, body: '{}' });
    check('session: signing out takes the cookie away rather than hoping the page forgets it',
      cookieOf(bye).some((c) => c.startsWith('ptcg_session=;') && /Max-Age=0/i.test(c)));

    // ---- who may make an account here ----
    // (on the proxied server, where the spoofing run has not already spent the
    //  per-address budget — a 429 would prove nothing about registration)
    {
      const f = path.join(proxied, 'settings.json');
      const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8') || '{}') : {};
      s.registration = 'closed';
      fs.writeFileSync(f, JSON.stringify(s));
    }
    const closed = await fetch(`${P}/api/register`, { method: 'POST', headers: { ...jbody, 'X-Forwarded-For': '10.5.5.1' }, body: JSON.stringify({ username: 'walkin', password: 'correcthorsebattery' }) });
    check('registration: a closed server turns away a new account', closed.status === 403);
    check('registration: and the account that was already there still signs in',
      (await login(P, 'bystander', 'correcthorsebattery', { 'X-Forwarded-For': '10.5.5.2' })).status === 200);
  }

  // ---- claiming an install, confirming an address, getting back in ----
  // A real mail server that only remembers, so the test can read the link the
  // app actually sent — a token that exists nowhere else by design.
  {
    const { startMockSmtp } = require('./mock-smtp');
    const mail = startMockSmtp({ smtpPort: 3997, httpPort: 3996 });
    const mailDir = path.join(ROOT, '.test-data-mail');
    fs.rmSync(mailDir, { recursive: true, force: true });

    // spawned with a pipe rather than start(): reading the setup code out of
    // the log IS the mechanism, so the test has to read it the same way
    const child = spawn('node', ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env, PORT: '3121', DATA_DIR: mailDir,
        PTCG_SMTP_HOST: 'localhost', PTCG_SMTP_PORT: '3997',
        PTCG_SMTP_FROM: 'cards@example.com',
        PTCG_PUBLIC_URL: 'https://cards.example.test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let log = '';
    child.stdout.on('data', (d) => { log += d.toString(); });
    child.stderr.on('data', (d) => { log += d.toString(); });
    await waitForPort(3121).catch((e) => fail(e.message));
    for (let i = 0; i < 40 && !/setup code/i.test(log); i++) await new Promise((r) => setTimeout(r, 100));

    const M = 'http://localhost:3121';
    const jbody2 = { 'Content-Type': 'application/json' };
    const inbox = () => jfetch('http://localhost:3996/messages');
    const emptyInbox = () => jfetch('http://localhost:3996/reset');
    const linkIn = (msg) => (/(https:\/\/\S+)/.exec(msg.text) || [])[1] || '';

    const code = (/([A-Za-z0-9_-]{32})/.exec(log) || [])[1];
    check('setup: a fresh install prints a code to its own log', !!code);
    const st0 = await jfetch(`${M}/api/setup/status`);
    check('setup: and says it is waiting to be claimed', st0.needed === true);

    const wrong = await fetch(`${M}/api/setup`, { method: 'POST', headers: jbody2, body: JSON.stringify({ token: 'x'.repeat(32), username: 'imposter', password: 'correcthorsebattery' }) });
    check('setup: the wrong code claims nothing', wrong.status === 403);
    check('setup: and the install is still unclaimed', (await jfetch(`${M}/api/setup/status`)).needed === true);

    const claimed = await fetch(`${M}/api/setup`, { method: 'POST', headers: jbody2, body: JSON.stringify({
      token: code, username: 'owner', password: 'correcthorsebattery', email: 'owner@example.test', registration: 'closed',
    }) });
    const claimedBody = await claimed.json();
    check('setup: the right code claims it, and signs you in', claimed.status === 200 && claimedBody.username === 'owner');
    check('setup: which closes setup for good', (await jfetch(`${M}/api/setup/status`)).needed === false);
    const again = await fetch(`${M}/api/setup`, { method: 'POST', headers: jbody2, body: JSON.stringify({ token: code, username: 'second', password: 'correcthorsebattery' }) });
    check('setup: the same code cannot be spent twice', again.status === 409);
    check('setup: the choices made during setup stuck',
      (await jfetch(`${M}/api/app-config`)).registration === 'closed');

    // ---- confirming the address ----
    for (let i = 0; i < 40 && !(await inbox()).length; i++) await new Promise((r) => setTimeout(r, 100));
    const box1 = await inbox();
    check('email: claiming the install sends a confirmation', box1.length === 1 && box1[0].to.includes('owner@example.test'));
    check('email: the link points at the address this install is reached by',
      linkIn(box1[0]).startsWith('https://cards.example.test/#/verify/'));
    const vTok = linkIn(box1[0]).split('/verify/')[1];
    const vOk = await jfetch(`${M}/api/verify-email`, { method: 'POST', headers: jbody2, body: JSON.stringify({ token: vTok }) });
    check('email: opening it confirms the address', vOk.ok === true && vOk.username === 'owner');
    const vTwice = await fetch(`${M}/api/verify-email`, { method: 'POST', headers: jbody2, body: JSON.stringify({ token: vTok }) });
    check('email: the same link cannot be opened twice', vTwice.status === 400);
    const vJunk = await fetch(`${M}/api/verify-email`, { method: 'POST', headers: jbody2, body: JSON.stringify({ token: 'not-a-real-token' }) });
    check('email: a made-up link confirms nothing', vJunk.status === 400);
    {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(mailDir, 'ptcg.db'), { readOnly: true });
      const rows = db.prepare('SELECT hash FROM auth_tokens').all();
      db.close();
      check('email: the database holds hashes, never a usable link',
        rows.every((r) => /^[0-9a-f]{64}$/.test(r.hash) && r.hash !== vTok));
    }

    // ---- forgetting the password ----
    await emptyInbox();
    const unknown = await jfetch(`${M}/api/forgot-password`, { method: 'POST', headers: jbody2, body: JSON.stringify({ email: 'stranger@example.test' }) });
    const known = await jfetch(`${M}/api/forgot-password`, { method: 'POST', headers: jbody2, body: JSON.stringify({ email: 'owner@example.test' }) });
    check('reset: the answer is the same whether or not we know the address',
      JSON.stringify(unknown) === JSON.stringify(known) && known.ok === true);
    for (let i = 0; i < 40 && !(await inbox()).length; i++) await new Promise((r) => setTimeout(r, 100));
    const box2 = await inbox();
    check('reset: only the address we actually know gets a letter',
      box2.length === 1 && box2[0].to.includes('owner@example.test'));
    const rTok = linkIn(box2[0]).split('/reset/')[1];
    check('reset: and it is a different link from the confirmation one', !!rTok && rTok !== vTok);
    const short = await fetch(`${M}/api/reset-password`, { method: 'POST', headers: jbody2, body: JSON.stringify({ token: rTok, newPassword: 'short' }) });
    check('reset: a too-short password is refused, and the link survives it', short.status === 400);
    const rOk = await jfetch(`${M}/api/reset-password`, { method: 'POST', headers: jbody2, body: JSON.stringify({ token: rTok, newPassword: 'a-brand-new-password' }) });
    check('reset: the link sets the new password and signs you in', rOk.ok === true && !!rOk.token);
    const oldPw = await fetch(`${M}/api/login`, { method: 'POST', headers: jbody2, body: JSON.stringify({ username: 'owner', password: 'correcthorsebattery' }) });
    const newPw = await fetch(`${M}/api/login`, { method: 'POST', headers: jbody2, body: JSON.stringify({ username: 'owner', password: 'a-brand-new-password' }) });
    check('reset: the old password stops working', oldPw.status === 401);
    check('reset: and the new one works', newPw.status === 200);
    const rTwice = await fetch(`${M}/api/reset-password`, { method: 'POST', headers: jbody2, body: JSON.stringify({ token: rTok, newPassword: 'yet-another-password' }) });
    check('reset: a spent link cannot be spent again', rTwice.status === 400);
    // a session cut before the reset must not survive it
    const stale = claimedBody.token;
    const staleUse = await fetch(`${M}/api/me`, { headers: { Authorization: 'Bearer ' + stale } });
    check('reset: every session from before the reset is dead', staleUse.status === 401);

    // ---- and the way back in when there is no mail server at all ----
    // Mail is optional, so this is the floor: whoever can run commands on the
    // machine can set a password, and nobody else can.
    const setPw = (user, pw) => {
      const r = spawnSync('node', ['server.js', '--set-password', user], {
        cwd: ROOT, encoding: 'utf8', input: pw,
        env: { ...process.env, DATA_DIR: mailDir },
      });
      return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
    };
    const tooShort = setPw('owner', 'short');
    check('set-password: a short password is refused', tooShort.status === 1 && /minimum is 10/.test(tooShort.out));
    const noSuch = setPw('nobody-here', 'a-perfectly-fine-password');
    check('set-password: an account that does not exist is refused', noSuch.status === 1 && /No account called/.test(noSuch.out));
    const ok = setPw('owner', 'set-from-the-console');
    check('set-password: it says what it did', ok.status === 0 && /signed out/.test(ok.out));
    const wasReset = await fetch(`${M}/api/login`, { method: 'POST', headers: jbody2, body: JSON.stringify({ username: 'owner', password: 'a-brand-new-password' }) });
    const isSet = await fetch(`${M}/api/login`, { method: 'POST', headers: jbody2, body: JSON.stringify({ username: 'owner', password: 'set-from-the-console' }) });
    check('set-password: the previous password stops working', wasReset.status === 401);
    check('set-password: and the console one works', isSet.status === 200);

    // ---- configuring mail after the install is already running ----
    // The setup screen asks once, which is no help to an install that was
    // already up when mail arrived — the state this very repo was in.
    {
      const adminTok = (await jfetch(`${M}/api/login`, { method: 'POST', headers: jbody2, body: JSON.stringify({ username: 'owner', password: 'set-from-the-console' }) })).token;
      const auth = { ...jbody2, Authorization: 'Bearer ' + adminTok };
      const before = await jfetch(`${M}/api/mail-settings`, { headers: auth });
      check('mail settings: an admin can read them, and the package is present',
        before.packageAvailable === true && typeof before.host === 'string');
      const anon = await fetch(`${M}/api/mail-settings`, { headers: jbody2 });
      check('mail settings: a stranger cannot', anon.status === 401 || anon.status === 403);

      await jfetch(`${M}/api/mail-settings`, { method: 'POST', headers: auth, body: JSON.stringify({
        host: 'localhost', port: '3997', user: 'bob', pass: 'the-smtp-password',
        from: 'cards@example.test', publicUrl: 'https://cards.example.test',
      }) });
      const after = await jfetch(`${M}/api/mail-settings`, { headers: auth });
      check('mail settings: the password goes in but never comes back out',
        after.passwordSet === true && after.pass === undefined);
      // the form cannot show the old password, so blank has to mean "keep it"
      await jfetch(`${M}/api/mail-settings`, { method: 'POST', headers: auth, body: JSON.stringify({
        host: 'localhost', port: '3997', user: 'bob', pass: '', from: 'cards@example.test',
      }) });
      const kept = JSON.parse(fs.readFileSync(path.join(mailDir, 'settings.json'), 'utf8'));
      check('mail settings: saving with a blank password keeps the saved one',
        kept.smtp.pass === 'the-smtp-password');

      await emptyInbox();
      const test = await jfetch(`${M}/api/mail-test`, { method: 'POST', headers: auth, body: JSON.stringify({ to: 'checkme@example.test' }) });
      for (let i = 0; i < 40 && !(await inbox()).length; i++) await new Promise((r) => setTimeout(r, 100));
      const testBox = await inbox();
      check('mail settings: a test message actually goes out',
        test.ok === true && testBox.length === 1 && testBox[0].to.includes('checkme@example.test'));

      // ---- putting an address on an account that never had one ----
      const wrongPw = await fetch(`${M}/api/email`, { method: 'POST', headers: auth, body: JSON.stringify({ password: 'nope', email: 'owner2@example.test' }) });
      check('address: changing it needs the current password', wrongPw.status === 401);
      await emptyInbox();
      const set = await jfetch(`${M}/api/email`, { method: 'POST', headers: auth, body: JSON.stringify({ password: 'set-from-the-console', email: 'owner2@example.test' }) });
      check('address: a new one arrives unconfirmed and asks to be confirmed',
        set.email === 'owner2@example.test' && set.emailVerified === false && set.sent === true);
      for (let i = 0; i < 40 && !(await inbox()).length; i++) await new Promise((r) => setTimeout(r, 100));
      const conf = await inbox();
      const link = (/(https:\/\/\S+)/.exec(conf[0].text) || [])[1] || '';
      check('address: the confirmation goes to the NEW address', conf[0].to.includes('owner2@example.test'));
      await jfetch(`${M}/api/verify-email`, { method: 'POST', headers: jbody2, body: JSON.stringify({ token: link.split('/verify/')[1] }) });
      const meConf = await jfetch(`${M}/api/me`, { headers: auth });
      check('address: confirming it sticks', meConf.email === 'owner2@example.test' && meConf.emailVerified === true);

      // an address that changes is an address nobody has proved they can read
      await jfetch(`${M}/api/email`, { method: 'POST', headers: auth, body: JSON.stringify({ password: 'set-from-the-console', email: 'owner3@example.test' }) });
      const meMoved = await jfetch(`${M}/api/me`, { headers: auth });
      check('address: changing it drops the confirmation with it',
        meMoved.email === 'owner3@example.test' && meMoved.emailVerified === false);
      const noReset = await jfetch(`${M}/api/forgot-password`, { method: 'POST', headers: jbody2, body: JSON.stringify({ email: 'owner2@example.test' }) });
      check('address: and the address it used to be stops resetting anything', noReset.ok === true);
      // put it back the way the two-factor block expects to find it
      await jfetch(`${M}/api/email`, { method: 'POST', headers: auth, body: JSON.stringify({ password: 'set-from-the-console', email: 'owner@example.test' }) });
    }

    // ---- the second factor ----
    // The codes are generated here independently of the server, from the
    // secret it hands out — if the two implementations ever disagree, no
    // authenticator app in the world would work with this either.
    {
      const crypto = require('crypto');
      const b32dec = (str) => {
        const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = 0, value = 0; const out = [];
        for (const ch of str.toUpperCase().replace(/[\s=]/g, '')) {
          value = (value << 5) | A.indexOf(ch); bits += 5;
          if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
        }
        return Buffer.from(out);
      };
      const totp = (secret, at = Date.now()) => {
        const c = Buffer.alloc(8);
        c.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
        const mac = crypto.createHmac('sha1', b32dec(secret)).update(c).digest();
        const o = mac[mac.length - 1] & 0x0f;
        const bin = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
        return String(bin % 1e6).padStart(6, '0');
      };

      const pw = 'set-from-the-console';       // where the reset tests left it
      const signIn = () => fetch(`${M}/api/login`, { method: 'POST', headers: jbody2, body: JSON.stringify({ username: 'owner', password: pw }) }).then((r) => r.json());
      const first = await signIn();
      const authed = { ...jbody2, Authorization: 'Bearer ' + first.token };

      const setup = await jfetch(`${M}/api/totp/setup`, { method: 'POST', headers: authed, body: '{}' });
      check('totp: setup hands over a secret and a link an app can open',
        /^[A-Z2-7]{32}$/.test(setup.secret || '') && setup.otpauth.startsWith('otpauth://totp/'));
      // The picture is a convenience, but a picture of the WRONG thing would
      // enrol somebody against a secret they cannot reproduce. Re-encode the
      // link here and require the same modules back: this checks what the
      // server fed the encoder, which is the part that can go wrong.
      check('totp: and a QR of exactly that link, not of something else', (() => {
        if (!setup.qrSvg) return false;
        let qrcode;
        try { qrcode = require('qrcode-generator'); } catch { return false; }
        const again = qrcode(0, 'L');
        again.addData(setup.otpauth, 'Byte');
        again.make();
        return setup.qrSvg === again.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
      })());
      const stillOff = await signIn();
      check('totp: handing over the secret does not turn it on yet', !stillOff.needTotp);

      const wrongEnable = await fetch(`${M}/api/totp/enable`, { method: 'POST', headers: authed, body: JSON.stringify({ code: '000000' }) });
      check('totp: a wrong code does not turn it on', wrongEnable.status === 400);
      const enabled = await jfetch(`${M}/api/totp/enable`, { method: 'POST', headers: authed, body: JSON.stringify({ code: totp(setup.secret) }) });
      check('totp: the right code turns it on and hands back recovery codes',
        enabled.ok === true && Array.isArray(enabled.recoveryCodes) && enabled.recoveryCodes.length === 10);

      const now = await signIn();
      check('totp: the password alone stops being a way in', now.needTotp === true && !!now.ticket);
      const ticketAsSession = await fetch(`${M}/api/me`, { headers: { Authorization: 'Bearer ' + now.ticket } });
      check('totp: and the half-way ticket is not a session', ticketAsSession.status === 401);

      const badCode = await fetch(`${M}/api/login/totp`, { method: 'POST', headers: jbody2, body: JSON.stringify({ ticket: now.ticket, code: '000000' }) });
      check('totp: a wrong code is refused', badCode.status === 401);
      const code = totp(setup.secret);
      const good = await jfetch(`${M}/api/login/totp`, { method: 'POST', headers: jbody2, body: JSON.stringify({ ticket: now.ticket, code }) });
      check('totp: the right code finishes the sign-in', !!good.token);
      const replay = await signIn();
      const replayed = await fetch(`${M}/api/login/totp`, { method: 'POST', headers: jbody2, body: JSON.stringify({ ticket: replay.ticket, code }) });
      check('totp: the same code cannot be used twice inside its 30 seconds', replayed.status === 401);
      // a code from well outside the window is not accepted either
      const stale = totp(setup.secret, Date.now() - 10 * 60 * 1000);
      const staleTry = await signIn();
      const staleRes = await fetch(`${M}/api/login/totp`, { method: 'POST', headers: jbody2, body: JSON.stringify({ ticket: staleTry.ticket, code: stale }) });
      check('totp: a code from ten minutes ago is too old', staleRes.status === 401);

      // recovery codes
      const rec = enabled.recoveryCodes[0];
      const recTry = await signIn();
      const recOk = await jfetch(`${M}/api/login/totp`, { method: 'POST', headers: jbody2, body: JSON.stringify({ ticket: recTry.ticket, recoveryCode: rec.toUpperCase() }) });
      check('totp: a recovery code signs in, and case does not matter', !!recOk.token);
      const recAgain = await signIn();
      const recTwice = await fetch(`${M}/api/login/totp`, { method: 'POST', headers: jbody2, body: JSON.stringify({ ticket: recAgain.ticket, recoveryCode: rec }) });
      check('totp: and it only works the once', recTwice.status === 401);
      const meNow = await jfetch(`${M}/api/me`, { headers: { Authorization: 'Bearer ' + recOk.token } });
      check('totp: the account says how many recovery codes are left',
        meNow.totpEnabled === true && meNow.recoveryLeft === 9);

      // turning it off is a password-protected act
      const offNoPw = await fetch(`${M}/api/totp/disable`, { method: 'POST', headers: { ...jbody2, Authorization: 'Bearer ' + recOk.token }, body: JSON.stringify({ password: 'not-the-password' }) });
      check('totp: a borrowed session cannot quietly turn it off', offNoPw.status === 401);

      // the console way out, for a lost authenticator on an install with no mail
      const cleared = spawnSync('node', ['server.js', '--clear-2fa', 'owner'], {
        cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATA_DIR: mailDir },
      });
      check('clear-2fa: the console can turn it off', cleared.status === 0 && /turned off/.test(cleared.stdout || ''));
      const afterClear = await signIn();
      check('clear-2fa: and the password alone signs in again', !afterClear.needTotp && !!afterClear.token);
    }

    mail.close();
  }

  // ---- every way of installing this app installs its optional packages ----
  // sharp, nodemailer and qrcode-generator are each the difference between a
  // feature working and quietly not existing. They were listed in one install
  // script and forgotten in four others and the Dockerfile, so the scanner
  // index worked and mail and the two-factor QR silently did not. Nothing in
  // the app can notice that, so the installers are checked instead.
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const optional = Object.keys(pkg.optionalDependencies || {});
    check('packaging: the optional extras are declared in one place', optional.length >= 3);
    const installers = [
      'Dockerfile',
      'install/pokemonsettracker-install.sh',
      'ct/pokemonsettracker.sh',
      'contrib/proxmox-ved/install/pokemonsettracker-install.sh',
      'contrib/proxmox-ved/ct/pokemonsettracker.sh',
    ];
    const misses = [];
    for (const f of installers) {
      const body = fs.readFileSync(path.join(ROOT, f), 'utf8');
      // naming packages one by one is how they drift apart; each installer has
      // to take the whole list from package.json
      const takesAll = /npm install[^\n]*--omit=dev/.test(body);
      const namesOne = optional.some((dep) => new RegExp(`npm install[^\\n]*\\b${dep}\\b`).test(body));
      if (!takesAll || namesOne) misses.push(f);
    }
    check('packaging: every installer takes the whole list, none names packages by hand',
      misses.length === 0 || !console.log('    installers out of step: ' + misses.join(', ')));
  }


  // ---- signing in through somebody else's identity provider ----
  // Its own install, deliberately: the redirect URI has to be somewhere the
  // browser can actually come back to, and the mail fixture above pins this
  // app's public address at a hostname that does not exist.
  {
    // A stale provider left listening by an earlier run would answer instead
    // of this one, quietly ignoring every knob the negative tests turn — which
    // reads as five mysterious failures rather than one obvious one.
    await new Promise((resolve) => {
      const probe = net.connect(3995, '127.0.0.1');
      probe.on('connect', () => { probe.destroy(); fail('something is already listening on :3995 — kill it and re-run'); });
      probe.on('error', () => { probe.destroy(); resolve(); });
    });
    const { startMockOidc } = require('./mock-oidc');
    const idp = startMockOidc({ port: 3995, clientId: 'ptcg-test' });
    const ssoDir = path.join(ROOT, '.test-data-sso');
    fs.rmSync(ssoDir, { recursive: true, force: true });
    const ssoChild = start('node', ['server.js'], { PORT: '3122', DATA_DIR: ssoDir }, true);
    await waitForPort(3122).catch((e) => fail(e.message));
    const ssoCode = await waitForLog(ssoChild, /\b([0-9a-f]{32})\b/);
    if (!ssoCode) fail('the sso test server never printed a setup code');
    const S = 'http://localhost:3122';
    const jbody2 = { 'Content-Type': 'application/json' };
    await jfetch(`${S}/api/setup`, { method: 'POST', headers: jbody2, body: JSON.stringify({
      token: ssoCode[1], username: 'ssoadmin', password: 'correcthorsebattery',
    }) });

    // A real provider: real discovery, a real JWKS, tokens signed with a real
    // key. Stubbing the signature check would leave a test that still passes
    // with the signature check deleted.
    const adminTok = (await jfetch(`${S}/api/login`, { method: 'POST', headers: jbody2, body: JSON.stringify({ username: 'ssoadmin', password: 'correcthorsebattery' }) })).token;
      const auth = { ...jbody2, Authorization: 'Bearer ' + adminTok };

      const settings = (over) => jfetch(`${S}/api/oidc-settings`, { method: 'POST', headers: auth, body: JSON.stringify({
        issuer: idp.origin, clientId: 'ptcg-test', clientSecret: 'shh', label: 'Test SSO', unknown: 'link', ...over,
      }) });
      await settings();
      const probe = await jfetch(`${S}/api/oidc-settings/probe`, { method: 'POST', headers: auth, body: '{}' });
      check('sso: the app can find the provider and its keys',
        probe.ok === true && probe.issuer === idp.origin && probe.keys === 1);
      check('sso: and the app advertises it to the sign-in page',
        (await jfetch(`${S}/api/app-config`)).oidc.label === 'Test SSO');

      /* Walk the redirects by hand, carrying cookies, because that IS the
       * flow: a cookie that does not survive the trip to the provider and
       * back is a sign-in that never completes. */
      const walk = async (startPath, cookies = {}) => {
        const jar = { ...cookies };
        const header = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
        let url = `${S}${startPath}`;
        for (let hop = 0; hop < 8; hop++) {
          const r = await fetch(url, { headers: { Cookie: header() }, redirect: 'manual' });
          for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) {
            const [pair] = c.split(';');
            const eq = pair.indexOf('=');
            const name = pair.slice(0, eq); const value = pair.slice(eq + 1);
            if (value === '') delete jar[name]; else jar[name] = value;
          }
          const next = r.headers.get('location');
          if (!next) return { url, jar, status: r.status };
          url = new URL(next, url).toString();
          if (url.startsWith('http') && url.includes('#')) return { url, jar, status: r.status };
        }
        return { url, jar, status: 0 };
      };

      const unknown = await walk('/api/oidc/start');
      check('sso: an identity nobody has claimed is turned away, not handed an account',
        /signin-failed/.test(unknown.url) && /not attached to any account/.test(decodeURIComponent(unknown.url)));

      // link it from an account that is already signed in
      const sessionCookie = (await (async () => {
        const r = await fetch(`${S}/api/login`, { method: 'POST', headers: jbody2, body: JSON.stringify({ username: 'ssoadmin', password: 'correcthorsebattery' }), redirect: 'manual' });
        const c = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).find((x) => x.startsWith('ptcg_session='));
        return c.split(';')[0].split('=').slice(1).join('=');
      })());
      const linked = await walk('/api/oidc/start?mode=link', { ptcg_session: sessionCookie });
      check('sso: linking from a signed-in account attaches it', /#\/linked/.test(linked.url));

      const signedIn = await walk('/api/oidc/start');
      check('sso: and then it signs that account in', /#\/signed-in/.test(signedIn.url));
      const who = await jfetch(`${S}/api/me`, { headers: { Cookie: `ptcg_session=${signedIn.jar.ptcg_session}` } });
      check('sso: as the right person, with the link recorded',
        who.username === 'ssoadmin' && who.oidcLinked === true);

      // ---- the parts that must not work ----
      const reject = async (knob, expect) => {
        idp.reset();
        if (knob) idp.options[knob] = true;
        const r = await walk('/api/oidc/start');
        idp.reset();
        return /signin-failed/.test(r.url) && new RegExp(expect, 'i').test(decodeURIComponent(r.url));
      };
      check('sso: a token signed with the wrong key is refused', await reject('badSignature', 'not signed by the provider'));
      check('sso: a token from another issuer is refused', await reject('badIssuer', 'issued by somebody else'));
      check('sso: a token for another application is refused', await reject('badAudience', 'different application'));
      check('sso: an expired token is refused', await reject('expired', 'expired'));
      check('sso: a token from a different sign-in is refused', await reject('wrongNonce', 'different sign-in'));

      // arriving at the callback without having started is not a sign-in
      const noFlow = await fetch(`${S}/api/oidc/callback?code=made-up&state=made-up`, { redirect: 'manual' });
      check('sso: a callback that started nowhere is refused',
        /signin-failed/.test(noFlow.headers.get('location') || ''));

      // unlinking needs the password, like every other change to how you get in
      const unlinkNoPw = await fetch(`${S}/api/oidc/unlink`, { method: 'POST', headers: auth, body: JSON.stringify({ password: 'nope' }) });
      check('sso: unlinking needs the current password', unlinkNoPw.status === 401);
      await jfetch(`${S}/api/oidc/unlink`, { method: 'POST', headers: auth, body: JSON.stringify({ password: 'correcthorsebattery' }) });
      const after = await walk('/api/oidc/start');
      check('sso: once unlinked, that identity is a stranger again', /signin-failed/.test(after.url));

      // the secret is write-only, same as the mail password
      const read = await jfetch(`${S}/api/oidc-settings`, { headers: auth });
      check('sso: the client secret goes in but never comes back out',
        read.secretSet === true && read.clientSecret === undefined);

      // and none of this disturbed the password that was already there
      const stillLocal = await fetch(`${S}/api/login`, { method: 'POST', headers: jbody2, body: JSON.stringify({ username: 'ssoadmin', password: 'correcthorsebattery' }) });
      check('sso: local accounts are untouched by any of it', stillLocal.status === 200);
      idp.close();
  }

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

  // an explicitly empty variant selection is honored — no phantom 'normal'
  await ovH('/api/card', { new: true, set: 'promo-x', localId: '4', name: 'No Base', variants: {}, lang: 'en' });
  await ovH('/api/custom-variant', { cardId: 'promo-x-4', label: 'Special Stamp', lang: 'en' });
  const nbSet = await jfetch('http://localhost:3115/api/catalog/set?lang=en&id=promo-x');
  const nbCard = (nbSet.cards || []).find((c) => c.id === 'promo-x-4');
  check('editor: a card can exist on custom printings alone (no phantom Normal)',
    nbCard && !(nbCard.variants && nbCard.variants.normal) &&
    nbCard.printings && nbCard.printings['special-stamp'] === 'Special Stamp');

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
  const nFill = Object.keys(bd.slots).length;
  check('binder: create + fill-from-set places every card of the set',
    bCreate.ok === true && bd.size === 2 && bd.color === 'blue' &&
    bd.slots['0'] && CARD_OK(bd.slots['0'].card));
  // A pocket per PRINTING, not per card — derived from the set the fill read, so
  // this keeps holding as the fixture's variants change. Printings stay adjacent
  // and the set's own order still runs front to back.
  const bSet = await jfetch('http://localhost:3115/api/catalog/set?lang=en&id=base1');
  const VORD = ['normal', 'holo', 'reverse', 'firstEdition', 'wPromo'];
  const printsOf = (c) => {
    const base = Object.keys(c.variants || {}).filter((k) => c.variants[k]);
    const out = VORD.filter((v) => base.includes(v));
    for (const v of base) if (!out.includes(v)) out.push(v);
    for (const v of Object.keys(c.printings || {})) if (!out.includes(v)) out.push(v);
    return out.length ? out : ['normal'];
  };
  const wantPockets = [];
  for (const c of bSet.cards) for (const v of printsOf(c)) wantPockets.push(c.id + ':' + v);
  const gotPockets = Object.keys(bd.slots).map(Number).sort((a, b) => a - b).map((k) => bd.slots[k].card + ':' + bd.slots[k].variant);
  check('binder: the fill makes a pocket for every printing, printings together, set order kept',
    wantPockets.length > bSet.cards.length && nFill === wantPockets.length &&
    gotPockets.join('|') === wantPockets.join('|'));
  check('binder: pages grow to hold the printings, not just the cards',
    bd.pages === Math.ceil(wantPockets.length / 4) && bd.pages >= 2 &&
    bCreate.filled === wantPockets.length && bCreate.skipped === 0);
  // the same card can hold several printings and they land side by side
  const multi = bSet.cards.find((c) => printsOf(c).length > 1);
  const multiAt = gotPockets.findIndex((p) => p.startsWith(multi.id + ':'));
  check('binder: a card with several printings gets consecutive pockets',
    multiAt >= 0 && gotPockets.slice(multiAt, multiAt + printsOf(multi).length)
      .every((p) => p.startsWith(multi.id + ':')) &&
    new Set(gotPockets.slice(multiAt, multiAt + printsOf(multi).length)).size === printsOf(multi).length);
  // 'none' is a real color the API has to accept; a bogus one still falls back
  const bNone = await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { method: 'PUT', headers: buAuth, body: JSON.stringify({ color: 'none' }) });
  const bNoneGet = await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { headers: buAuth });
  await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { method: 'PUT', headers: buAuth, body: JSON.stringify({ color: 'chartreuse' }) });
  const bBogus = await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { headers: buAuth });
  check('binder: "none" is an accepted color and a bogus one is ignored',
    bNone.ok === true && bNoneGet.binder.color === 'none' && bBogus.binder.color === 'none');
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
  check('binder: list reports progress', bList.binders.length === 1 && bList.binders[0].filled === nFill && bList.binders[0].have === 1);
  const bAnon = (await fetch('http://localhost:3115/api/binders')).status;
  const bOther = (await fetch(`http://localhost:3115/api/binders/${bd.id}`, { headers: { Authorization: 'Bearer ' + cpChange.token } })).status;
  check('binder: auth required and binders are private per account', bAnon === 401 && bOther === 404);
  // uploaded art spanning pockets: upload -> place {img,w,h} -> excluded from progress
  const pngBuf = fs.readFileSync(path.join(__dirname, 'fixtures', 'base1-4.png'));
  const upRes = await fetch('http://localhost:3115/api/binder-image', { method: 'POST', headers: { Authorization: 'Bearer ' + buReg.token, 'Content-Type': 'image/png' }, body: pngBuf });
  const up = await upRes.json();
  // art goes on a blank page added for it, since the fill now claims a pocket per
  // printing and pocket 6 is no longer reliably empty
  // the geometry checks below need pockets that are certainly empty, and the
  // fill's size now depends on how many printings the fixture cards carry — so
  // the binder grows by a known sheet and the art goes on that blank page
  const artPages = bd.pages + 1;
  const A = bd.pages * 4, B = A + 1;                      // first two pockets of the new page
  const artSlots = { ...bGet.binder.slots, [A]: { img: up.url, w: 2, h: 1 } };
  await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { method: 'PUT', headers: buAuth, body: JSON.stringify({ pages: artPages, slots: artSlots }) });
  const bArt = await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { headers: buAuth });
  const bList2 = await jfetch('http://localhost:3115/api/binders', { headers: buAuth });
  const upAnon = (await fetch('http://localhost:3115/api/binder-image', { method: 'POST', body: pngBuf })).status;
  check('binder: image upload + art span persists, art excluded from progress',
    upRes.status === 200 && /^\/bimg\/[a-f0-9-]+\.webp$/.test(up.url || '') &&
    bArt.binder.slots[A] && bArt.binder.slots[A].img === up.url && bArt.binder.slots[A].w === 2 &&
    bList2.binders[0].filled === nFill && upAnon === 401);
  const imgServe = await fetch('http://localhost:3115' + up.url);
  check('binder: uploaded art is served immutably', imgServe.status === 200 && /immutable/.test(imgServe.headers.get('cache-control') || ''));
  // cells-based art: arbitrary pockets + pan/zoom view + cut mode
  const artSlots2 = { ...bArt.binder.slots, [A]: { img: up.url, cells: [A, B], view: { x: -10.5, y: 4, s: 200 }, gaps: 'without' } };
  await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { method: 'PUT', headers: buAuth, body: JSON.stringify({ slots: artSlots2 }) });
  const bArt2 = await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { headers: buAuth });
  const e6 = bArt2.binder.slots[A] || {};
  check('binder: cells-based art (arbitrary pockets + view + cut mode) persists',
    Array.isArray(e6.cells) && e6.cells.join(',') === `${A},${B}` && e6.gaps === 'without' &&
    e6.view && Math.round(e6.view.s) === 200 && Math.round(e6.view.x * 2) === -21);
  // mirroring persists on art pieces and covers alike (invalid values dropped)
  const flSlots = { ...bArt2.binder.slots, [A]: { ...e6, flip: 'xy' } };
  await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { method: 'PUT', headers: buAuth, body: JSON.stringify({ slots: flSlots }) });
  await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { method: 'PUT', headers: buAuth, body: JSON.stringify({ cover: { type: 'art', img: up.url, view: { x: 0, y: 0, s: 150 }, flip: 'diagonal' } }) });
  const flGet = await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { headers: buAuth });
  await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { method: 'PUT', headers: buAuth, body: JSON.stringify({ cover: { type: 'art', img: up.url, view: { x: 0, y: 0, s: 150 }, flip: 'y' } }) });
  const flGet2 = await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { headers: buAuth });
  check('binder: mirror flags persist on art and covers (junk values dropped)',
    flGet.binder.slots[A].flip === 'xy' && flGet.binder.cover.flip === undefined && flGet2.binder.cover.flip === 'y');
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
  await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { method: 'PUT', headers: buAuth, body: JSON.stringify({ size: 3, pages: artPages, slots: rmSlots }) });
  const bRe = await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { headers: buAuth });
  const rA = remap(A), rB = remap(B);                     // where the art lands at the bigger size
  check('binder: size change persists — cards keep page + position, art cells remap',
    sizeBare === 400 && bRe.binder.size === 3 &&
    bRe.binder.slots['9'] && bRe.binder.slots['9'].n === 3 && bRe.binder.slots['9'].have === 1 &&
    bRe.binder.slots[rA] && (bRe.binder.slots[rA].cells || []).join(',') === `${rA},${rB}` &&
    bRe.binder.slots['4'] && typeof bRe.binder.slots['4'].card === 'string');

  // ⊟ remove page: a bare shrink must not orphan page-2 pockets, but a shrink
  // that ships the shifted-forward slots persists
  await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { method: 'PUT', headers: buAuth, body: JSON.stringify({ pages: 1 }) });
  const bKeep = await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { headers: buAuth });
  const shifted = {};
  for (const [k, v] of Object.entries(bRe.binder.slots)) {
    const i = parseInt(k, 10);
    if (i < 9) continue;                                  // page 1 comes out with the sheet
    if (v.cells) { const cells = v.cells.map((c) => c - 9).sort((a, b) => a - b); shifted[cells[0]] = { ...v, cells }; }
    else shifted[i - 9] = v;
  }
  await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { method: 'PUT', headers: buAuth, body: JSON.stringify({ pages: artPages - 1, slots: shifted }) });
  const bRm = await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { headers: buAuth });
  // every surviving pocket moved forward by exactly one sheet, and nothing that
  // was on the removed page came with it
  const shiftOK = Object.entries(shifted).every(([k, v]) => {
    const got = bRm.binder.slots[k];
    if (!got) return false;
    return v.cells ? (got.cells || []).join(',') === v.cells.join(',')
      : got.card === v.card && got.variant === v.variant;
  });
  check('binder: page removal persists — later pockets shift forward, orphaning refused',
    bKeep.binder.pages === artPages &&
    bRm.binder.pages === artPages - 1 &&
    Object.keys(bRm.binder.slots).length === Object.keys(shifted).length && shiftOK &&
    bRm.binder.slots['0'] && bRm.binder.slots['0'].n === 3 && bRm.binder.slots['0'].have === 1 &&
    bRm.binder.slots[rA - 9] && (bRm.binder.slots[rA - 9].cells || []).join(',') === `${rA - 9},${rB - 9}` &&
    !bRm.binder.slots[rA]);

  /* ---- handing a binder to somebody who has no account here ----
   * The token IS the credential, so what matters is that it works with no
   * session at all, that it stops working the moment it is withdrawn, and
   * that it never hands out anything the link-holder was not given. */
  const fakeToken = 'f'.repeat(20);
  const shNone = (await fetch(`http://localhost:3115/api/shared/${fakeToken}`)).status;
  check('share: a binder is private until it is shared, and an invented token leads nowhere',
    shNone === 404);
  const shOff = await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { headers: buAuth });
  check('share: the owner is told there is no link yet', shOff.binder.share === null);

  const shOn = await jfetch(`http://localhost:3115/api/binders/${bd.id}/share`,
    { method: 'POST', headers: buAuth, body: JSON.stringify({ on: true }) });
  const tok1 = shOn.share;
  // no Authorization header anywhere in this call: that is the whole point
  const pub = await jfetch(`http://localhost:3115/api/shared/${tok1}`);
  check('share: turning it on mints a token a stranger can use',
    /^[a-f0-9]{20}$/.test(tok1 || '') && pub.binder && pub.binder.name === bd.name &&
    Object.keys(pub.binder.slots).length === Object.keys(bRm.binder.slots).length);
  check('share: the shared page is told whose binder it is', pub.owner === buReg.username);
  // the real id is what the owner's own endpoints key on — publishing it would
  // hand every link-holder something to try against /api/binders/<id>
  check('share: the binder’s own id is not in what a link-holder receives',
    pub.binder.id === undefined && !JSON.stringify(pub).includes(bd.id));

  const shSteal = (await fetch(`http://localhost:3115/api/binders/${bd.id}/share`,
    { method: 'POST', headers: { Authorization: 'Bearer ' + cpChange.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) })).status;
  check('share: somebody else cannot publish your binder', shSteal === 404);

  // an ordinary edit must not quietly retire a link that is out in the world
  await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { method: 'PUT', headers: buAuth, body: JSON.stringify({ name: 'Still shared' }) });
  const afterEdit = await jfetch(`http://localhost:3115/api/shared/${tok1}`);
  check('share: editing the binder leaves the link alone', afterEdit.binder.name === 'Still shared');

  // asking again without rotate is idempotent — pressing Share twice must not
  // silently invalidate the address already pasted into somebody's message
  const shAgain = await jfetch(`http://localhost:3115/api/binders/${bd.id}/share`,
    { method: 'POST', headers: buAuth, body: JSON.stringify({ on: true }) });
  check('share: turning on an already-shared binder keeps the same link', shAgain.share === tok1);

  const shRot = await jfetch(`http://localhost:3115/api/binders/${bd.id}/share`,
    { method: 'POST', headers: buAuth, body: JSON.stringify({ on: true, rotate: true }) });
  const oldDead = (await fetch(`http://localhost:3115/api/shared/${tok1}`)).status;
  const newLive = (await fetch(`http://localhost:3115/api/shared/${shRot.share}`)).status;
  check('share: a new link works and kills the old one',
    shRot.share !== tok1 && /^[a-f0-9]{20}$/.test(shRot.share || '') && oldDead === 404 && newLive === 200);

  /* ---- a link that shows the layout without publishing the inventory ----
   * The counts have to be absent from the ANSWER, not merely undrawn: a page
   * is the visitor's to read the source of. */
  const shHide = await jfetch(`http://localhost:3115/api/binders/${bd.id}/share`,
    { method: 'POST', headers: buAuth, body: JSON.stringify({ on: true, showHave: false }) });
  const pubHidden = await jfetch(`http://localhost:3115/api/shared/${shRot.share}`);
  const hiddenSlots = Object.values(pubHidden.binder.slots).filter((e) => e.card);
  check('share: hiding the ticks keeps the layout and drops the tally',
    shHide.showHave === false && pubHidden.showHave === false &&
    hiddenSlots.length > 0 && hiddenSlots.every((e) => e.have === undefined && e.n === undefined) &&
    hiddenSlots.every((e) => typeof e.card === 'string' && typeof e.variant === 'string'));
  // the owner's own view of the binder is untouched by what the link shows
  const ownerStill = await jfetch(`http://localhost:3115/api/binders/${bd.id}`, { headers: buAuth });
  check('share: hiding them from visitors does not hide them from you',
    ownerStill.binder.shareHave === false &&
    Object.values(ownerStill.binder.slots).some((e) => e.have === 1));
  // and it is a setting, not a one-way door
  const shShow = await jfetch(`http://localhost:3115/api/binders/${bd.id}/share`,
    { method: 'POST', headers: buAuth, body: JSON.stringify({ on: true, showHave: true }) });
  const pubShown = await jfetch(`http://localhost:3115/api/shared/${shRot.share}`);
  check('share: showing them again puts the tally back, on the same link',
    shShow.share === shRot.share && shShow.showHave === true && pubShown.showHave === true &&
    Object.values(pubShown.binder.slots).some((e) => e.have === 1));

  const shListOn = await jfetch('http://localhost:3115/api/binders', { headers: buAuth });
  const shOffAgain = await jfetch(`http://localhost:3115/api/binders/${bd.id}/share`,
    { method: 'POST', headers: buAuth, body: JSON.stringify({ on: false }) });
  const nowDead = (await fetch(`http://localhost:3115/api/shared/${shRot.share}`)).status;
  const shListOff = await jfetch('http://localhost:3115/api/binders', { headers: buAuth });
  check('share: turning it off retires the link and the shelf stops saying it is out',
    shListOn.binders[0].shared === true && shOffAgain.share === null &&
    nowDead === 404 && shListOff.binders[0].shared === false);

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

  // ---- the same pull, as a CLIENT OF THE CARD API (token-gated) ----
  // The mock API fronts the mock bucket: 401 without a token, 403 revoked,
  // 402 when the allowance is spent (catalog.db only — the manifest is free).
  // PTCG_CDN_BASE points at a dead port on purpose: if the API config did not
  // take precedence, every one of these would fail loudly.
  start('node', ['tests/mock-card-api.js']);
  await waitForPort(3996).catch((e) => fail(e.message));
  const apiPull = (extraEnv, dir) => spawnSync('node', ['server.js', '--pull-master'], {
    cwd: pullRoot, encoding: 'utf8',
    env: { ...process.env, DATA_DIR: path.join(pullRoot, dir), PTCG_CDN_BASE: 'http://localhost:3990/nowhere',
      PTCG_API_BASE: 'http://localhost:3996', ...extraEnv },   // no /v1 — normalisation adds it
  });
  const gag = (r) => (r.stdout || '') + (r.stderr || '');
  const apiOk = apiPull({ PTCG_API_TOKEN: 'ptcg_live_' + 'a'.repeat(40) }, 'data-api');
  check('API client: a valid token pulls the catalog through the API (base given without /v1)',
    apiOk.status === 0 && /card API/.test(gag(apiOk)) && /Card database loaded: \d+ cards/.test(gag(apiOk)));
  const apiNone = apiPull({}, 'data-api-none');
  check('API client: no token is refused with a sentence that names PTCG_API_TOKEN',
    apiNone.status === 1 && /PTCG_API_TOKEN/.test(gag(apiNone)));
  const apiRev = apiPull({ PTCG_API_TOKEN: 'ptcg_live_' + 'b'.repeat(40) }, 'data-api-rev');
  check('API client: a revoked token is refused as revoked, not as a mystery HTTP code',
    apiRev.status === 1 && /revoked/.test(gag(apiRev)));
  const apiSpent = apiPull({ PTCG_API_TOKEN: 'ptcg_live_' + 'c'.repeat(40) }, 'data-api-spent');
  check('API client: a spent allowance says existing cards keep working and updates wait',
    apiSpent.status === 1 && /allowance is spent/.test(gag(apiSpent)) && /keep working/.test(gag(apiSpent)));

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

  // ---- how this install keeps up with the master ----
  // Checking is safe and happens on a timer; applying carries the master's
  // deletions and skips the review above, so it has to be asked for.
  {
    const cfg0 = await jfetch('http://localhost:3117/api/app-config');
    check('auto-update: an install checks but does not apply, unless told otherwise', cfg0.autoUpdate === 'check');
    const anon = await fetch('http://localhost:3117/api/auto-update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'apply' }) });
    check('auto-update: changing the mode needs the administrator', anon.status === 403);
    const bad = await fetch('http://localhost:3117/api/auto-update', { method: 'POST', headers: pAuth, body: JSON.stringify({ mode: 'whenever' }) });
    check('auto-update: nonsense modes are refused', bad.status === 400);
    await jfetch('http://localhost:3117/api/auto-update', { method: 'POST', headers: pAuth, body: JSON.stringify({ mode: 'apply' }) });
    const cfg1 = await jfetch('http://localhost:3117/api/app-config');
    check('auto-update: the chosen mode sticks', cfg1.autoUpdate === 'apply');
    await jfetch('http://localhost:3117/api/auto-update', { method: 'POST', headers: pAuth, body: JSON.stringify({ mode: 'check' }) });
    // and a check — scheduled or asked for — records WHEN, so "up to date"
    // carries a date rather than being a claim with nothing behind it
    await jfetch('http://localhost:3117/api/catalog/update-check');
    const cfg2 = await jfetch('http://localhost:3117/api/app-config');
    check('auto-update: a check records when it last succeeded',
      cfg2.autoUpdate === 'check' && !!cfg2.updateCheckedAt && !Number.isNaN(Date.parse(cfg2.updateCheckedAt)));
  }

  // ---- the review modal itself, in a real browser ----
  // The contract underneath it is proven above; this is the part that turns
  // checkboxes into the bypass list, which is where a mistake would quietly
  // hide something the admin meant to keep.
  {
    const { chromium } = require('playwright');
    const exe = process.env.CHROMIUM_PATH || undefined;
    const rbrowser = await chromium.launch(exe ? { executablePath: exe } : {});
    const rctx = await rbrowser.newContext({ serviceWorkers: 'block' });
    const rp = await rctx.newPage();
    // the master gains one more set, so there is something to review
    {
      const { DatabaseSync } = require('node:sqlite');
      const mdb = new DatabaseSync(path.join(ROOT, '.test-data', 'ptcg.db'));
      mdb.exec("INSERT INTO sets (lang,id,name,official_count,position,source,hidden) VALUES ('en','promo-y','Promo Y',1,998,'master',0)");
      mdb.exec("INSERT INTO cards (lang,id,set_id,local_id,name,variants_csv,position,source,hidden) VALUES ('en','promo-y-1','promo-y','1','Yveltal Promo','normal',0,'master',0)");
      mdb.close();
    }
    const pubY = spawnSync('node', ['scripts/publish-images.js'], { cwd: ROOT, env: { ...process.env, ...r2env }, encoding: 'utf8' });
    if (pubY.status !== 0) fail('review-modal publish failed: ' + (pubY.stdout || '') + (pubY.stderr || ''));

    await rp.goto('http://localhost:3117/');
    await rp.evaluate((t) => localStorage.setItem('ptcg.auth', JSON.stringify(t)),
      { token: pReg.token, username: 'pulladmin' });
    const pageErrors = [];
    rp.on('pageerror', (e) => pageErrors.push(e.message));
    await rp.reload();
    // Let the home route finish painting first. route() ends in
    // view.replaceChildren(), and the overlay is a child of view — open it
    // mid-render and the render that lands next wipes it off the page.
    await rp.waitForSelector('.set-card');
    const prev = await rp.evaluate(async (tok) => {
      const r = await fetch('api/catalog/preview', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: '{}' });
      return r.json();
    }, pReg.token);
    check('review UI: there is an addition to review', (prev.newSets || []).some((s) => s.id === 'promo-y'));
    await rp.evaluate((p) => openPullReview(p), prev);
    await rp.waitForSelector('.picker-overlay', { timeout: 15000 })
      .catch(() => fail('review modal never appeared' + (pageErrors.length ? ' — page errors: ' + pageErrors.join('; ') : '')));
    const panel = rp.locator('.picker-overlay').last();
    check('review UI: the panel names the new set',
      (await panel.textContent()).includes('Promo Y'));
    const boxes = panel.locator('input[type=checkbox]');
    const n = await boxes.count();
    check('review UI: every addition arrives already accepted',
      n > 0 && (await boxes.evaluateAll((els) => els.every((e) => e.checked))));
    // untick the set, confirm — that is the bypass path
    const yBox = panel.locator('.pr-row:has-text("Promo Y") input[type=checkbox]').first();
    await yBox.uncheck();
    check('review UI: unticking is what marks something to skip', (await yBox.isChecked()) === false);
    await panel.locator('button:has-text("Apply update")').first().click();
    let rvuDone = null;
    for (let i = 0; i < 150 && !rvuDone; i++) {
      const st = await jfetch('http://localhost:3117/api/build-status');
      if (!st.running) rvuDone = st; else await new Promise((r) => setTimeout(r, 300));
    }
    const idxY = await jfetch('http://localhost:3117/api/catalog/index?lang=en');
    check('review UI: the unticked set was bypassed, not installed',
      rvuDone && !rvuDone.error && !(idxY.sets || []).some((x) => x.id === 'promo-y'));
    {
      const { DatabaseSync } = require('node:sqlite');
      const idb = new DatabaseSync(path.join(pullRoot, 'data', 'ptcg.db'));
      const ys = idb.prepare("SELECT hidden, source FROM sets WHERE lang='en' AND id='promo-y'").get();
      idb.close();
      check('review UI: a bypass from the modal is soft, exactly like the API one',
        ys && ys.hidden === 1 && ys.source === 'local');
    }
    await rctx.close();
    await rbrowser.close();
  }

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
  // read the master's version rather than hard-coding it: every publish added
  // above this line shifts the number, and a hard-coded one fails somewhere
  // unrelated to whatever actually changed
  const wsBefore = Number((await jfetch('http://localhost:3998/cards/catalog.json')).version) || 0;
  const wsPub = spawnSync('node', ['scripts/publish-images.js'], {
    cwd: pullRoot, encoding: 'utf8',
    env: { ...process.env, ...r2env, DATA_DIR: path.join(pullRoot, 'data'), PTCG_CDN_BASE: 'http://localhost:3998/cards' },
  });
  const wsOut = (wsPub.stdout || '') + (wsPub.stderr || '');
  check('image-less workspace publishes the master catalog (no public/cdn needed)',
    wsPub.status === 0 && /publishing the master catalog only/.test(wsOut) &&
    new RegExp(`version ${wsBefore + 1}\\b`).test(wsOut));

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
