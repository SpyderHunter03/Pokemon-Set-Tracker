/* Bootstrap test — the in-app "Download card database" button + admin update.
 * Assumes: mock TCGdex on :3999, app server on :3111 started with
 * PTCG_SOURCE_API=http://localhost:3999/v2, and public/cdn NOT yet built. */
const { chromium } = require('playwright');

(async () => {
  const launchOpts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGE ERROR: ' + e.message));

  let failCount = 0;
  const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) failCount++; };

  // no database yet → welcome panel with the download button
  await page.goto('http://localhost:3111/');
  await page.waitForSelector('button:has-text("Download card database")');
  check('main page offers database download when none exists', true);

  // trigger the download and watch the progress UI
  await page.click('button:has-text("Download card database")');
  await page.waitForSelector('.build-progress');
  check('progress bar appears', true);

  // mock source is fast; wait for completion → home renders sets
  await page.waitForSelector('.set-card', { timeout: 120000 });
  check('sets appear after download completes', (await page.locator('.set-card').count()) >= 1);

  const status = await page.evaluate(async () => (await fetch('api/build-status')).json());
  check('build reported done', status.running === false && status.dbExists === true && status.progress && status.progress.done === true);
  check('scanner index was built too', status.hashesOk === true);

  // re-running now requires an admin → unauthenticated POST must be rejected
  const denied = await page.evaluate(async () => (await fetch('api/build-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
  check('unauthenticated re-run is rejected', denied === 403);

  // first registered account becomes the administrator (fixed creds so the
  // test runner can log in later to refresh the catalog)
  await page.click('#account-btn');
  await page.waitForSelector('#account-modal[open]');
  await page.click('.tabs button:has-text("Create account")');
  await page.fill('#account-forms input[type=text]', 'ptcgadmin');
  await page.fill('#account-forms input[type=password]', 'password123');
  await page.click('#account-forms .btn');
  await page.waitForSelector('#account-status button:has-text("Sign out")');
  await page.waitForSelector('#admin-area button:has-text("Update cards from TCGdex")');
  check('first account sees the Administration section', true);
  // hidden buttons must vanish, not render as literal "null" text
  check('admin panel renders no stray "null" text',
    !/\bnull\b/.test(await page.textContent('#admin-area')));

  // admin re-run: starts, runs, completes (resume makes it quick)
  await page.click('#admin-area button:has-text("Update cards from TCGdex")');
  await page.waitForSelector('#admin-area .build-progress');
  check('admin update shows progress', true);
  await page.waitForSelector('#admin-area button:has-text("Update cards from TCGdex")', { timeout: 120000 });
  check('admin update completes', true);

  // ---- custom printings + own variant images (admin) ----
  await page.click('#account-modal .close-modal');
  await page.goto('http://localhost:3111/#/set/base1');
  await page.waitForSelector('.tcg-card');
  const tilesBefore = await page.locator('.tcg-card').count();

  // add a custom printing to Charizard via the modal
  page.once('dialog', (d) => d.accept('Cracked Ice Holo'));
  await page.click('.tcg-card[data-card-id="base1-4"] >> nth=0 >> .info-btn');
  await page.waitForSelector('#card-modal[open] button:has-text("Add printing")');
  await page.click('#card-modal button:has-text("Add printing")');
  await page.waitForSelector('#card-modal .chips .chip:has-text("Cracked Ice Holo")');
  check('admin can add a custom printing', true);

  // upload our own image for that printing
  await page.setInputFiles('#card-modal input[type=file]', require('path').join(__dirname, 'fixtures', 'base1-4.png'));
  await page.waitForFunction(() => {
    const img = document.querySelector('#card-modal .card-img-wrap img');
    return img && img.src.includes('cracked-ice-holo');
  });
  check('uploaded image is used for the custom printing', true);
  await page.click('#card-modal button:has-text("Close")');

  // the custom printing is now its own tile in the set grid
  await page.waitForFunction((n) => document.querySelectorAll('.tcg-card').length === n + 1, tilesBefore);
  const customTile = page.locator('.tcg-card[data-variant="cracked-ice-holo"]');
  check('custom printing appears as its own card tile', (await customTile.count()) === 1);
  check('custom tile shows uploaded image', (await customTile.locator('img').getAttribute('src')).includes('cracked-ice-holo-low.webp'));
  check('custom tile labeled correctly', (await customTile.locator('.fx-label').textContent()) === 'Cracked Ice Holo');

  // public image API lists it, CORS open
  const manifest = await page.evaluate(async () => {
    const r = await fetch('api/variant-images?lang=en');
    return { cors: r.headers.get('access-control-allow-origin'), body: await r.json() };
  });
  check('variant-image API lists the upload with URLs',
    manifest.cors === '*' &&
    manifest.body.images.some((i) => i.card === 'base1-4' && i.variant === 'cracked-ice-holo' && i.urls.low && i.urls.high));

  // non-admins cannot add printings or upload
  const denied2 = await page.evaluate(async () =>
    (await fetch('api/custom-variant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId: 'base1-4', label: 'Hax' }) })).status);
  check('unauthenticated custom-variant rejected', denied2 === 401 || denied2 === 403);

  // ---- removing a printing from the modal, and bringing it back ----
  await page.click('.tcg-card[data-variant="cracked-ice-holo"] .info-btn');
  await page.waitForSelector('#card-modal[open] button:has-text("Remove Cracked Ice Holo")');
  page.once('dialog', (d) => d.accept());
  await page.click('#card-modal button:has-text("Remove Cracked Ice Holo")');
  await page.waitForFunction((n) => document.querySelectorAll('.tcg-card').length === n, tilesBefore);
  check('editor: removed printing drops its tile from the set', true);
  // re-adding a printing with the same name restores it, scan and all
  page.once('dialog', (d) => d.accept('Cracked Ice Holo'));
  await page.click('#card-modal button:has-text("Add printing")');
  await page.waitForSelector('#card-modal .chips .chip:has-text("Cracked Ice Holo")');
  await page.click('#card-modal button:has-text("Close")');
  await page.waitForFunction((n) => document.querySelectorAll('.tcg-card').length === n + 1, tilesBefore);
  check('editor: re-adding the printing restores it (scan intact)',
    ((await page.locator('.tcg-card[data-variant="cracked-ice-holo"] img').getAttribute('src')) || '').includes('cracked-ice-holo-low.webp'));

  // ---- whole-card editor: new set → new card (with picture) → edit → hide → restore ----
  await page.goto('http://localhost:3111/#/');
  await page.waitForSelector('.chip:has-text("＋ New set")');
  await page.click('.chip:has-text("＋ New set")');
  await page.waitForSelector('.picker-panel input[placeholder="e.g. Eevee Promos"]');
  await page.fill('.picker-panel input[placeholder="e.g. Eevee Promos"]', 'Test Promos');
  await page.click('.picker-panel button:has-text("Create set")');
  await page.waitForSelector('.set-card:has-text("Test Promos")');
  check('editor: brand-new set appears on the home page', true);

  await page.goto('http://localhost:3111/#/set/test-promos');
  await page.waitForSelector('.add-card-tile');
  check('editor: empty new set offers the add-card tile', true);
  await page.click('.add-card-tile');
  await page.waitForSelector('.ce-panel');
  check('editor: card number pre-filled with the next free number',
    (await page.locator('.ce-panel input[placeholder="e.g. 51 or SWSH087"]').inputValue()) === '1');
  await page.fill('.ce-panel input[placeholder="e.g. Eevee"]', 'Eevee Star');
  await page.fill('.ce-panel input[placeholder="e.g. Rare Holo"]', 'Rare');
  await page.fill('.ce-panel input[placeholder="e.g. Lightning"]', 'Colorless');
  await page.fill('.ce-panel input[placeholder="e.g. 133"]', '133');
  await page.setInputFiles('.ce-panel input[type=file]', require('path').join(__dirname, 'fixtures', 'base1-4.png'));
  await page.click('.ce-panel button:has-text("Add card")');
  await page.waitForSelector('.tcg-card[data-card-id="test-promos-1"]');
  check('editor: brand-new card appears in its set', true);
  check('editor: the card uses the uploaded picture',
    ((await page.locator('.tcg-card[data-card-id="test-promos-1"] img').getAttribute('src')) || '').includes('card-low.webp'));

  // edit it through the card modal's Edit button
  await page.click('.tcg-card[data-card-id="test-promos-1"] .info-btn');
  await page.waitForSelector('#card-modal[open] button:has-text("Edit card")');
  await page.click('#card-modal button:has-text("Edit card")');
  await page.waitForSelector('.ce-panel');
  await page.fill('.ce-panel input[placeholder="e.g. Eevee"]', 'Eevee Star EX');
  await page.click('.ce-panel button:has-text("Save changes")');
  await page.waitForFunction(async () => {
    const d = await (await fetch('api/catalog/set?lang=en&id=test-promos')).json();
    const c = (d.cards || []).find((x) => x.id === 'test-promos-1');
    return !!c && c.name === 'Eevee Star EX' && c.rarity === 'Rare';
  });
  check('editor: renaming keeps the other fields', true);

  // hide it (tombstone), then restore it from the set page's hidden list
  await page.waitForSelector('.tcg-card[data-card-id="test-promos-1"] .info-btn');
  await page.click('.tcg-card[data-card-id="test-promos-1"] .info-btn');
  await page.waitForSelector('#card-modal[open] button:has-text("Edit card")');
  await page.click('#card-modal button:has-text("Edit card")');
  await page.waitForSelector('.ce-panel button:has-text("Hide card")');
  page.once('dialog', (d) => d.accept());
  await page.click('.ce-panel button:has-text("Hide card")');
  await page.waitForSelector('h3:has-text("Hidden cards (1)")');
  check('editor: hidden card leaves the grid and lists under Hidden cards',
    (await page.locator('.tcg-card[data-card-id="test-promos-1"]').count()) === 0);
  await page.click('button:has-text("Restore")');
  await page.waitForSelector('.tcg-card[data-card-id="test-promos-1"]');
  check('editor: restoring brings it back', true);

  // ---- editor: your own printings in the form + duplicating a card ----
  await page.click('.tcg-card[data-card-id="test-promos-1"] .info-btn');
  await page.waitForSelector('#card-modal[open] button:has-text("Edit card")');
  await page.click('#card-modal button:has-text("Edit card")');
  await page.waitForSelector('.ce-panel');
  await page.fill('.ce-panel input[placeholder="e.g. Cracked Ice Holo"]', 'Sparkle Foil');
  await page.click('.ce-panel button:has-text("＋ Add")');
  await page.waitForSelector('.ce-panel .chip:has-text("Sparkle Foil")');
  await page.click('.ce-panel button:has-text("Save changes")');
  await page.waitForSelector('.tcg-card[data-variant="sparkle-foil"]');
  check('editor: your own printing added right in the card form', true);

  // duplicate it — details, printings, and the picture come along
  await page.click('.tcg-card[data-card-id="test-promos-1"] >> nth=0 >> .info-btn');
  await page.waitForSelector('#card-modal[open] button:has-text("Duplicate")');
  await page.click('#card-modal button:has-text("Duplicate")');
  await page.waitForSelector('.ce-panel h3:has-text("Duplicate")');
  check('editor: duplicate pre-fills from the source card',
    (await page.locator('.ce-panel input[placeholder="e.g. Eevee"]').inputValue()) === 'Eevee Star EX' &&
    (await page.textContent('.ce-panel')).includes('Using the picture of'));
  await page.fill('.ce-panel input[placeholder="pick a free number"]', '2');
  await page.click('.ce-panel button:has-text("Add card")');
  await page.waitForSelector('.tcg-card[data-card-id="test-promos-2"]');
  check('editor: duplicated card reuses the source picture and printings',
    ((await page.locator('.tcg-card[data-card-id="test-promos-2"] >> nth=0 >> img').getAttribute('src')) || '').includes('test-promos/1/card-low.webp') &&
    (await page.locator('.tcg-card[data-card-id="test-promos-2"][data-variant="sparkle-foil"]').count()) === 1);

  // ---- ＋ New card can copy everything from a card in ANOTHER set ----
  await page.goto('http://localhost:3111/#/set/test-promos');
  await page.waitForSelector('.add-card-tile');
  await page.click('.add-card-tile');
  await page.waitForSelector('.ce-panel');
  await page.click('.ce-panel button:has-text("Copy from a card")');
  await page.waitForSelector('.picker-overlay .picker-row');
  await page.fill('.picker-overlay input[placeholder="Search cards by name…"]', 'Pikachu');
  await page.waitForSelector('.picker-row:has-text("Pikachu")');
  await page.click('.picker-row:has-text("Pikachu") >> nth=0');
  await page.waitForFunction(() => {
    const n = document.querySelector('.ce-panel input[placeholder="e.g. Eevee"]');
    return n && n.value === 'Pikachu';
  });
  check('editor: ＋ New card copies the whole form from a card in another set',
    (await page.textContent('.ce-panel')).includes('Using the picture of Pikachu'));
  await page.fill('.ce-panel input[placeholder="e.g. Eevee"]', 'Pika Promo');   // renamed copy
  await page.fill('.ce-panel input[placeholder="e.g. 51 or SWSH087"]', '3');
  await page.click('.ce-panel button:has-text("Add card")');
  await page.waitForSelector('.tcg-card[data-card-id="test-promos-3"]');
  check('editor: copied card lands in THIS set with the source picture',
    ((await page.locator('.tcg-card[data-card-id="test-promos-3"] >> nth=0 >> img').getAttribute('src')) || '').includes('base1/58/'));

  // sign the admin out so the main suite's fresh user is a clean non-admin test
  await page.click('#account-btn');
  await page.waitForSelector('#account-status button:has-text("Sign out")');
  await page.click('#account-status button:has-text("Sign out")');
  await page.evaluate(() => localStorage.clear());

  console.log(errors.length ? 'JS ERRORS:\n' + errors.join('\n') : 'No JS errors.');
  if (failCount) console.log(failCount + ' check(s) FAILED');
  await browser.close();
  process.exit(errors.length || failCount ? 1 : 0);
})();
