/* Frontend smoke test — per-variant tiles, images, Pokémon view, languages, scanner, sync */
const { chromium } = require('playwright');

(async () => {
  const launchOpts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGE ERROR: ' + e.message));
  // ignored console errors: base1/98 (intentional broken image), ERR_FAILED
  // (requests aborted by test navigation), /nonexistent/ (intentional
  // dead-CDN fallback scenario — the app handles it and falls back)
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('base1/98') && !t.includes('net::ERR_FAILED') && !t.includes('/nonexistent/')) {
      errors.push('CONSOLE: ' + t);
    }
  });
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.hostname !== 'localhost') errors.push('EXTERNAL REQUEST: ' + r.url());
  });

  let failCount = 0;
  const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) failCount++; };
  const coll = () => page.evaluate(() => JSON.parse(localStorage.getItem('ptcg.collection.v2')));

  // ---- seed old v1 data to test migration ----
  await page.goto('http://localhost:3111/');
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('ptcg.collection.v1', JSON.stringify({ 'base1-58': 2 }));
  });
  await page.reload();
  await page.waitForSelector('.set-card');

  const migrated = await coll();
  check('v1 → v2 migration', migrated && migrated['base1-58'] && migrated['base1-58'].normal === 2);
  check('home shows sets', (await page.locator('.set-card').count()) === 2);
  check('stats count migrated card', (await page.textContent('#stat-owned')).trim() === '1');

  // home sorting: newest first by default, switchable to name
  check('sets newest first by default', (await page.locator('.set-card .name >> nth=0').textContent()).includes('Darkness'));
  await page.selectOption('.chips select', 'name');
  check('sets sortable by name', (await page.locator('.set-card .name >> nth=0').textContent()).includes('Base Set'));
  await page.selectOption('.chips select', 'newest');

  // ---- set page: one tile per printing ----
  await page.click('.set-card:has-text("Base Set")');
  await page.waitForSelector('.tcg-card');
  check('set page shows 8 printing tiles (incl. custom Cracked Ice Holo)', (await page.locator('.tcg-card').count()) === 8);
  check('progress counts unique cards', (await page.textContent('.page-head .muted')).trim() === '1 / 102');

  const badges = await page.locator('.tcg-card .variant-badge').allTextContents();
  check('variant labels incl. Unlimited, 1st Edition, custom printing',
    JSON.stringify(badges.slice(0, 4)) === JSON.stringify(['Holo', '1st Edition', 'Cracked Ice Holo', 'Unlimited']));

  check('imageless cards show clean placeholders', (await page.locator('.tcg-card .noimg').count()) === 2);
  check('high-only card got an image', (await page.locator('.tcg-card[data-card-id="base1-97"] img').count()) === 1);

  // tap the Holo printing of Charizard
  await page.click('.tcg-card >> nth=0');
  let c = await coll();
  check('tap owns only that printing', c['base1-4'] && c['base1-4'].holo === 1 && !c['base1-4'].firstEdition);
  check('progress updates to 2 / 102', (await page.textContent('.page-head .muted')).trim() === '2 / 102');

  // tap the 1st Edition printing separately
  await page.click('.tcg-card >> nth=1');
  c = await coll();
  check('1st Edition tracked independently', c['base1-4'].firstEdition === 1 && c['base1-4'].holo === 1);

  // modal: variant switcher, quantities
  await page.click('.tcg-card >> nth=0 >> .info-btn');
  await page.waitForSelector('#card-modal[open] .chips .chip');
  const chipTexts = await page.locator('#card-modal .chips .chip').allTextContents();
  check('modal chips show printings + custom + other',
    chipTexts.length === 4 && chipTexts[0].startsWith('Holo') && chipTexts[2].startsWith('Cracked Ice') && chipTexts[3].startsWith('Other'));
  check('modal shows set/number/rarity', (await page.textContent('#card-modal-body')).includes('4 / 102'));
  await page.click('#card-modal .qty-row button:last-child'); // + on active (Holo)
  c = await coll();
  check('modal + increments active printing', c['base1-4'].holo === 2);
  await page.click('#card-modal button:has-text("Close")');
  check('qty badge ×2 on holo tile', (await page.textContent('.tcg-card >> nth=0 >> .qty-badge')).trim() === '×2');

  // multi-copy tile: tap opens details instead of clearing
  await page.click('.tcg-card >> nth=0');
  await page.waitForSelector('#card-modal[open]');
  c = await coll();
  check('tap on multi-copy printing opens details, keeps data', c['base1-4'].holo === 2);
  await page.click('#card-modal button:has-text("Close")');

  // owned/missing filters act per printing
  await page.click('.chip:has-text("Owned")');
  check('owned filter shows 3 printings', (await page.locator('.tcg-card').count()) === 3);
  await page.click('.chip:has-text("Missing")');
  check('missing filter shows 5 printings', (await page.locator('.tcg-card').count()) === 5);
  await page.click('.chip:has-text("All")');

  // ---- synthetic variant looks + real variant scans ----
  check('holo printing gets holo sheen', (await page.locator('.tcg-card >> nth=0 >> .fx-holo').count()) === 1);
  check('1st Edition printing gets the stamp', (await page.locator('.tcg-card >> nth=1 >> .fx-stamp').count()) === 1);
  check('unlimited printing has neither', (await page.locator('.tcg-card[data-card-id="base1-58"][data-variant="normal"] >> .fx').count()) === 0);
  const customT = page.locator('.tcg-card[data-variant="cracked-ice-holo"]');
  check('custom printing survives database rebuild with its image', (await customT.locator('img').getAttribute('src')).includes('cracked-ice-holo-low.webp'));
  const pikaFirstEd = page.locator('.tcg-card[data-card-id="base1-58"][data-variant="firstEdition"]');
  check('real variant scan used when present', (await pikaFirstEd.locator('img').getAttribute('src')).includes('firstEdition-low.webp'));
  check('real variant scan suppresses synthetic stamp', (await pikaFirstEd.locator('.fx-stamp').count()) === 0);

  // modal image follows the selected printing
  await pikaFirstEd.locator('.info-btn').click();
  await page.waitForSelector('#card-modal[open] .card-img-wrap img');
  check('modal shows variant scan for 1st Edition', (await page.locator('#card-modal .card-img-wrap img').getAttribute('src')).includes('firstEdition'));
  await page.click('#card-modal .chips .chip:has-text("Unlimited")');
  check('modal swaps to base image for Unlimited', !(await page.locator('#card-modal .card-img-wrap img').getAttribute('src')).includes('firstEdition'));
  await page.click('#card-modal button:has-text("Close")');

  // ---- sorting ----
  await page.selectOption('.chips select', 'name');
  check('set page sorts by name', (await page.locator('.tcg-card >> nth=0').getAttribute('data-card-id')) === 'base1-98');
  await page.selectOption('.chips select', 'number');
  check('set page sorts by number', (await page.locator('.tcg-card >> nth=0').getAttribute('data-card-id')) === 'base1-4');

  // in-set search shows all printings of the match
  await page.fill('.set-filter input', 'pika');
  check('in-set search shows both Pikachu printings', (await page.locator('.tcg-card').count()) === 2);
  await page.fill('.set-filter input', '');

  // master set mode
  await page.click('.chip:has-text("Master set")');
  check('master set counts printings incl. custom', (await page.textContent('.page-head .muted')).trim() === '3 / 8 variants');
  await page.click('.chip:has-text("Master set")');

  // ---- Pokémon view ----
  await page.click('.bottomnav a[data-nav=pokemon]');
  await page.waitForSelector('.set-card');
  const speciesNames = await page.locator('.set-card .name').allTextContents();
  check('species list grouped by dex number', JSON.stringify(speciesNames) === JSON.stringify(['#006 Charizard', '#025 Pikachu', '#162 Furret']));
  check('charizard owned across sets', (await page.textContent('.set-card:has-text("Charizard") .count')).includes('1 / 2'));

  await page.click('.set-card:has-text("Charizard")');
  await page.waitForSelector('.tcg-card');
  check('charizard page: 4 printings across 2 sets, newest first',
    (await page.locator('.tcg-card').count()) === 4 &&
    (await page.locator('.tcg-card >> nth=0').getAttribute('data-card-id')) === 'swsh3-20');
  check('pokemon page progress', (await page.textContent('.page-head .muted')).trim() === '1 / 2 owned');
  await page.selectOption('.chips select', 'oldest');
  check('pokemon page sorts oldest-set first', (await page.locator('.tcg-card >> nth=0').getAttribute('data-card-id')) === 'base1-4');
  await page.selectOption('.chips select', 'newest');

  // ---- language switching ----
  await page.click('#account-btn');
  await page.waitForSelector('#language-area select');
  await page.selectOption('#language-area select', 'fr');
  await page.click('#account-modal .close-modal');
  await page.click('.bottomnav a[data-nav=sets]');
  await page.waitForSelector('.set-card:has-text("Set de Base")');
  check('sets render in French', true);
  check('collection persists across languages', (await page.textContent('#stat-owned')).trim() === '2');
  await page.click('#account-btn');
  await page.waitForSelector('#language-area select');
  await page.selectOption('#language-area select', 'en');
  await page.click('#account-modal .close-modal');
  await page.waitForSelector('.set-card:has-text("Base Set")');
  check('back to English', true);

  // ---- global search: printings expand there too ----
  await page.fill('#global-search-input', 'char');
  await page.press('#global-search-input', 'Enter');
  await page.waitForSelector('.card-grid .tcg-card');
  check('global search shows all Charizard printings', (await page.locator('.card-grid .tcg-card').count()) === 4);
  check('rarity dropdown from real data', (await page.locator('select >> nth=0 >> option').allTextContents()).includes('Ultra Rare'));

  // ---- scanner ----
  await page.click('.bottomnav a[data-nav=scan]');
  await page.waitForSelector('button:has-text("photo")');
  const scanResult = await page.evaluate(async () => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'cdn/en/images/base1/4/low.webp'; });
    const cv = document.createElement('canvas');
    cv.width = 300; cv.height = 420;
    cv.getContext('2d').drawImage(img, 6, 8, img.width - 12, img.height - 14, 0, 0, 300, 420);
    return window.__ptcgIdentify(cv, 3);
  });
  check('scanner identifies the right card', scanResult[0].id === 'base1-4');
  check('scanner match clearly separated', scanResult[0].distance < 35 && scanResult[1].distance - scanResult[0].distance > 10);

  // ---- debug page ----
  await page.goto('http://localhost:3111/#/debug');
  await page.waitForFunction(() => document.getElementById('view').textContent.includes('Data has variant/Pokédex info'));
  const debugText = await page.textContent('#view');
  check('debug probes all green', (debugText.match(/OK \(200\)/g) || []).length >= 5);
  check('debug confirms v3 data', debugText.includes('yes'));
  await page.goto('http://localhost:3111/');
  await page.waitForSelector('.set-card');

  // ---- account & variant-aware sync ----
  await page.click('#account-btn');
  await page.waitForSelector('#account-modal[open]');
  const uniq = 'smoke' + Math.floor(Math.random() * 1e6);
  await page.click('.tabs button:has-text("Create account")');
  await page.fill('#account-forms input[type=text]', uniq);
  await page.fill('#account-forms input[type=password]', 'password123');
  await page.click('#account-forms .btn');
  await page.waitForSelector('#account-status button:has-text("Sign out"), #account-forms button:has-text("Sign out")');
  await page.waitForTimeout(2500); // debounce push
  const remote = await page.evaluate(async () => {
    const auth = JSON.parse(localStorage.getItem('ptcg.auth'));
    const r = await fetch('api/collection', { headers: { Authorization: 'Bearer ' + auth.token } });
    return r.json();
  });
  check('per-printing collection synced to server',
    remote.collection && remote.collection['base1-4'] && remote.collection['base1-4'].holo === 2 &&
    remote.collection['base1-4'].firstEdition === 1 && remote.collection['base1-58'].normal === 2);

  // this user is NOT the first account (bootstrap test registered the admin);
  // the account modal is still open from registration — admin area renders async
  await page.waitForTimeout(800);
  check('non-admin sees no Administration section', (await page.locator('#admin-area button').count()) === 0);

  // ---- external image CDN (config.imageBase) ----
  await context.addInitScript(() => {
    const cfg = { cdnBase: 'cdn', defaultLanguage: 'en', imageBase: 'http://localhost:3999/imgcdn' };
    Object.defineProperty(self, 'PTCG_CONFIG', { configurable: true, get: () => cfg, set: () => {} });
  });
  await page.goto('http://localhost:3111/?extcdn=1#/set/base1'); // query change forces a real document load
  await page.waitForSelector('.tcg-card img');
  const extSrc = await page.locator('.tcg-card img >> nth=0').getAttribute('src');
  check('images come from the external CDN when imageBase is set', extSrc.startsWith('http://localhost:3999/imgcdn/en/images/'));
  await page.waitForFunction(() => {
    const img = document.querySelector('.tcg-card img');
    return img && img.complete && img.naturalWidth > 0;
  });
  check('external CDN images actually load', true);
  const dataReq = await page.evaluate(async () => (await fetch('cdn/en/index.json')).ok);
  check('card data still served locally alongside external images', dataReq === true);

  // ---- full-remote card database (cdnBase = external URL) ----
  await context.addInitScript(() => {
    const cfg = { cdnBase: 'http://localhost:3999/imgcdn', defaultLanguage: 'en', imageBase: null };
    Object.defineProperty(self, 'PTCG_CONFIG', { configurable: true, get: () => cfg, set: () => {} });
  });
  await page.goto('http://localhost:3111/?remotecdn=1#/');
  await page.waitForSelector('.set-card');
  const remoteIndexFetched = await page.evaluate(() =>
    performance.getEntriesByType('resource').some((r) => r.name.includes('localhost:3999/imgcdn/en/index.json')));
  check('sets load from the remote card database', remoteIndexFetched === true);
  check('no download button when database is remote', (await page.locator('button:has-text("Download card database")').count()) === 0);

  // ---- remote CDN unreachable → automatic local fallback ----
  await context.addInitScript(() => {
    const cfg = { cdnBase: 'http://localhost:3999/nonexistent', defaultLanguage: 'en', imageBase: null };
    Object.defineProperty(self, 'PTCG_CONFIG', { configurable: true, get: () => cfg, set: () => {} });
  });
  await page.goto('http://localhost:3111/?fallback=1#/');
  await page.waitForSelector('.set-card');
  check('unreachable remote CDN falls back to the local database', (await page.locator('.set-card').count()) >= 1);

  console.log(errors.length ? 'JS ERRORS:\n' + errors.join('\n') : 'No JS errors, zero external requests.');
  await browser.close();
  if (failCount) console.log(failCount + ' check(s) FAILED');
  process.exit(errors.length || failCount ? 1 : 0);
})();
