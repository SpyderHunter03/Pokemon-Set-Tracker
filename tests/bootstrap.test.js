/* Bootstrap test — the in-app "Download card database" button + admin update.
 * Assumes: mock TCGdex on :3999, app server on :3111 started with
 * PTCG_SOURCE_API=http://localhost:3999/v2, and public/cdn NOT yet built. */
const { chromium } = require('playwright');

(async () => {
  const launchOpts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
  const browser = await chromium.launch(launchOpts);
  const _newContext = browser.newContext.bind(browser);
  browser.newContext = async (opts) => {
    const ctx = await _newContext(opts);
    // the app sends brand-new visitors to /home; these tests target the app
    // itself, so every context starts as a returning visitor
    await ctx.addInitScript(() => localStorage.setItem('ptcg.visited', 'true'));
    return ctx;
  };
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGE ERROR: ' + e.message));

  let failCount = 0;
  const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) failCount++; };
  /** say yes to the app's own are-you-sure panel */
  const confirmYes = async () => {
    await page.waitForSelector('.confirm-panel');
    await page.click('.confirm-panel .btn.danger');
    await page.waitForSelector('.confirm-panel', { state: 'detached' });
  };

  // Nobody owns this install yet, so the first thing it does is ask to be
  // claimed — with the code its own log printed. Only then is there an
  // administrator, and only then will it download anything: an unclaimed
  // server should not let a passer-by start a multi-gigabyte fetch either.
  await page.goto('http://localhost:3111/');
  await page.waitForSelector('h1:has-text("Set up this install")');
  check('a fresh install asks to be claimed before anything else', true);
  const setupCode = process.env.SETUP_CODE || '';
  check('the harness could read the setup code from the log', /^[0-9a-f]{32}$/.test(setupCode));
  const setupFields = page.locator('.ce-field input');
  await setupFields.nth(0).fill(setupCode);
  await setupFields.nth(1).fill('ptcgadmin');
  await setupFields.nth(2).fill('password123');
  await page.click('button:has-text("Claim this install")');

  // claimed → signed in as the administrator, and now the welcome appears
  await page.waitForSelector('button:has-text("Download card database")', { timeout: 30000 });
  check('claiming it signs you in and hands over to the normal welcome', true);
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

  // Re-running requires an admin. Asked from outside the browser: the page
  // has been signed in since setup, and a fetch made there carries the session
  // cookie by itself, so asking on the page proves nothing about strangers.
  const denied = (await fetch('http://localhost:3111/api/build-data', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })).status;
  check('unauthenticated re-run is rejected', denied === 403);

  // the account made during setup is the administrator (fixed creds so the
  // test runner can log in later to refresh the catalog)
  await page.click('#account-btn');
  await page.waitForSelector('#account-page button:has-text("Sign out")');
  // administration is its own page now, reached from a link only an admin gets
  await page.click('#account-page a:has-text("Administration")');
  await page.waitForSelector('#admin-page button:has-text("Update cards from TCGdex")');
  check('first account sees the Administration page', true);
  check('footer: the administration page offers the way back at the bottom too',
    (await page.textContent('#admin-page .page-foot .back-link')).includes('Account'));
  // A hidden child must vanish, not render as the literal text "null".
  // append() and replaceChildren() both stringify null; only h() filters it,
  // so any conditional child built outside h() is a candidate. This covered
  // only the admin panel, and the next one to get it wrong was the account
  // panel a few centimetres above it — so check both whole pages.
  check('the administration page renders no stray "null" text',
    !/\bnull\b/.test(await page.textContent('#admin-page')));
  await page.goto('http://localhost:3111/#/account');
  await page.waitForSelector('#account-page button:has-text("Sign out")');
  check('the account page renders no stray "null" text',
    !/\bnull\b/.test(await page.textContent('#account-page')));

  // The same check with two-factor ON, because that is the branch that had a
  // conditional child and therefore the one that printed "null" at a user.
  {
    const setup = await page.evaluate(async () =>
      (await fetch('api/totp/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json());
    const crypto = require('crypto');
    const b32 = (str) => {
      const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      let bits = 0, value = 0; const out = [];
      for (const ch of str) { value = (value << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
      return Buffer.from(out);
    };
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const mac = crypto.createHmac('sha1', b32(setup.secret)).update(counter).digest();
    const off = mac[mac.length - 1] & 0x0f;
    const num = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
    const code = String(num % 1e6).padStart(6, '0');
    const on = await page.evaluate(async (c) =>
      (await fetch('api/totp/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: c }) })).json(), code);
    check('two-factor can be turned on from the browser', on.ok === true);
    await page.goto('http://localhost:3111/#/account/security');
    await page.waitForSelector('#account-page:has-text("recovery code")');
    const withTotp = await page.textContent('#account-page');
    check('the two-factor panel renders no stray "null" text', !/\bnull\b/.test(withTotp));
    check('and it says how many recovery codes are left', /10 recovery codes left/.test(withTotp));
    await page.evaluate(async () =>
      fetch('api/totp/disable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'password123' }) }));
  }

  // admin re-run: starts, runs, completes (resume makes it quick)
  await page.goto('http://localhost:3111/#/admin/cards');
  await page.click('#admin-page button:has-text("Update cards from TCGdex")');
  await page.waitForSelector('#admin-page .build-progress');
  check('admin update shows progress', true);
  await page.waitForSelector('#admin-page button:has-text("Update cards from TCGdex")', { timeout: 120000 });
  check('admin update completes', true);

  // ---- no master tools outside Administration: ever, for anyone ----
  await page.goto('http://localhost:3111/#/set/base1');
  await page.waitForSelector('.tcg-card');
  const tilesBefore = await page.locator('.tcg-card').count();
  await page.click('.tcg-card[data-card-id="base1-4"] >> nth=0 >> .info-btn');
  await page.waitForSelector('#card-modal[open] button:has-text("just for you")');
  check('the card modal offers personal tools but never master ones',
    (await page.locator('#card-modal button:has-text("(master)")').count()) === 0 &&
    (await page.locator('#card-modal button:has-text("Edit card")').count()) === 0);
  check('no add-card tile in the set grid, admin or not',
    (await page.locator('.add-card-tile').count()) === 0);
  await page.evaluate(() => document.getElementById('card-modal').close());

  // the curation workbench: where ALL of the master tools now live
  const gotoCurate = async () => {
    await page.goto('http://localhost:3111/#/admin/curate');
    await page.waitForSelector('#cur-pick');
  };
  const curePick = async (query, rowText) => {
    await page.click('#cur-pick');
    await page.waitForSelector('.picker-overlay input[placeholder="Search cards by name…"]');
    await page.fill('.picker-overlay input[placeholder="Search cards by name…"]', query);
    await page.waitForSelector(`.picker-overlay .picker-row:has-text("${rowText}")`);
    await page.click(`.picker-overlay .picker-row:has-text("${rowText}") >> nth=0`);
    await page.waitForSelector('#cur-card h4');
  };

  // ---- custom printings + master images, from the workbench ----
  await gotoCurate();
  await curePick('Charizard', 'Charizard');
  page.once('dialog', (d) => d.accept('Cracked Ice Holo'));
  await page.click('#cur-add-printing');
  await page.waitForSelector('.cur-print-row:has-text("Cracked Ice Holo")');
  check('workbench: admin can add a custom printing', true);

  await page.setInputFiles('.cur-print-row:has-text("Cracked Ice Holo") input[data-master-upload]', require('path').join(__dirname, 'fixtures', 'base1-4.png'));
  await page.waitForSelector('.cur-print-row:has-text("Cracked Ice Holo"):has-text("own image")');
  check('workbench: master image lands on the printing', true);

  // the set grid shows the custom printing as its own tile, wearing the image
  await page.goto('http://localhost:3111/#/set/base1');
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

  // Non-admins cannot add printings or upload. Asked from outside the browser
  // on purpose: the session now lives in a cookie, so a fetch made ON the page
  // carries it whether or not a header is set, and asking there would only
  // prove the admin is still an admin.
  const denied2 = (await fetch('http://localhost:3111/api/custom-variant', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cardId: 'base1-4', label: 'Hax' }),
  })).status;
  check('unauthenticated custom-variant rejected', denied2 === 401 || denied2 === 403);

  // ---- removing a printing from the workbench, and bringing it back ----
  await gotoCurate();   // the workbench remembers the card on the table
  await page.waitForSelector('.cur-print-row:has-text("Cracked Ice Holo")');
  await page.click('.cur-print-row:has-text("Cracked Ice Holo") button:has-text("Remove")');
  check('workbench: removing a printing spells out what survives it',
    (await page.textContent('.confirm-panel')).includes('keeps its other printings'));
  await confirmYes();
  await page.waitForFunction(() => ![...document.querySelectorAll('.cur-print-row')].some((r) => r.textContent.includes('Cracked Ice Holo')));
  await page.goto('http://localhost:3111/#/set/base1');
  await page.waitForFunction((n) => document.querySelectorAll('.tcg-card').length === n, tilesBefore);
  check('workbench: removed printing drops its tile from the set', true);
  // re-adding a printing with the same name restores it, scan and all
  await gotoCurate();
  page.once('dialog', (d) => d.accept('Cracked Ice Holo'));
  await page.click('#cur-add-printing');
  await page.waitForSelector('.cur-print-row:has-text("Cracked Ice Holo")');
  await page.goto('http://localhost:3111/#/set/base1');
  await page.waitForFunction((n) => document.querySelectorAll('.tcg-card').length === n + 1, tilesBefore);
  check('workbench: re-adding the printing restores it (scan intact)',
    ((await page.locator('.tcg-card[data-variant="cracked-ice-holo"] img').getAttribute('src')) || '').includes('cracked-ice-holo-low.webp'));

  // ---- whole-card editor: new set → new card (with picture) → edit → hide → restore ----
  await gotoCurate();
  await page.click('#cur-new-set');
  await page.waitForSelector('.picker-panel input[placeholder="e.g. Eevee Promos"]');
  await page.fill('.picker-panel input[placeholder="e.g. Eevee Promos"]', 'Test Promos');
  await page.click('.picker-panel button:has-text("Create set")');
  await page.waitForFunction(() => {
    const sel = document.querySelector('#cur-set-select');
    return sel && sel.value === 'test-promos';
  });
  check('workbench: brand-new set lands selected in the set list', true);
  await page.goto('http://localhost:3111/#/');
  await page.waitForSelector('.set-card:has-text("Test Promos")');
  check('editor: brand-new set appears on the home page', true);

  await gotoCurate();
  await page.selectOption('#cur-set-select', 'test-promos');
  await page.click('#cur-add-card');
  await page.waitForSelector('.ce-panel');
  check('editor: card number pre-filled with the next free number',
    (await page.locator('.ce-panel input[placeholder="e.g. 51 or SWSH087"]').inputValue()) === '1');
  await page.fill('.ce-panel input[placeholder="e.g. Eevee"]', 'Eevee Star');
  await page.fill('.ce-panel input[placeholder="e.g. Rare Holo"]', 'Rare');
  await page.fill('.ce-panel input[placeholder="e.g. Lightning"]', 'Colorless');
  // the field takes a list, and now says so on both the label and the hint
  check('editor: the Pokedex field says it takes a list',
    (await page.textContent('.ce-panel .ce-field:has(input[placeholder^="e.g. 133"]) span')).includes('comma-separated'));
  await page.fill('.ce-panel input[placeholder^="e.g. 133"]', '133');
  // a picture no real card in the fixture set has. It used to be base1-4.png,
  // which was harmless while nothing fingerprinted editor uploads — now that
  // they land in the scan index, giving two cards the identical artwork would
  // make the scanner's own separation check measure the fixture, not the code.
  await page.setInputFiles('.ce-panel input[type=file]', require('path').join(__dirname, 'fixtures', 'promo-star.png'));
  await page.click('.ce-panel button:has-text("Add card")');
  await page.waitForFunction(() => !document.querySelector('.ce-panel'));
  await page.goto('http://localhost:3111/#/set/test-promos');
  await page.waitForSelector('.tcg-card[data-card-id="test-promos-1"]');
  check('editor: brand-new card appears in its set', true);
  check('editor: the card uses the uploaded picture',
    ((await page.locator('.tcg-card[data-card-id="test-promos-1"] img').getAttribute('src')) || '').includes('card-low.webp'));

  // edit it through the workbench's Edit button
  await gotoCurate();
  await curePick('Eevee Star', 'Eevee Star');
  await page.click('#cur-card button:has-text("Edit card")');
  await page.waitForSelector('.ce-panel');
  await page.fill('.ce-panel input[placeholder="e.g. Eevee"]', 'Eevee Star EX');
  await page.click('.ce-panel button:has-text("Save changes")');
  await page.waitForFunction(async () => {
    const d = await (await fetch('api/catalog/set?lang=en&id=test-promos')).json();
    const c = (d.cards || []).find((x) => x.id === 'test-promos-1');
    return !!c && c.name === 'Eevee Star EX' && c.rarity === 'Rare';
  });
  check('editor: renaming keeps the other fields', true);

  // hide it (tombstone), then restore it from the workbench's hidden list
  await page.waitForSelector('#cur-card button:has-text("Edit card")');
  await page.click('#cur-card button:has-text("Edit card")');
  await page.waitForSelector('.ce-panel button:has-text("Hide card")');
  await page.click('.ce-panel button:has-text("Hide card")');
  check('editor: hiding a card asks first, by name',
    /Hide "[^"]+" from the database/.test(await page.textContent('.confirm-panel')));
  await confirmYes();
  await page.waitForSelector('#cur-hidden h4:has-text("Hidden cards (1)")');
  check('workbench: hidden card lists under Hidden cards', true);
  await page.goto('http://localhost:3111/#/set/test-promos');
  await page.waitForFunction(() => !document.querySelector('.tcg-card[data-card-id="test-promos-1"]'));
  check('editor: hidden card leaves the grid', true);
  await gotoCurate();
  await page.waitForSelector('#cur-hidden button:has-text("Restore")');
  await page.click('#cur-hidden button:has-text("Restore")');
  await page.waitForFunction(() => !document.querySelector('#cur-hidden h4'));
  await page.goto('http://localhost:3111/#/set/test-promos');
  await page.waitForSelector('.tcg-card[data-card-id="test-promos-1"]');
  check('editor: restoring brings it back', true);

  // ---- editor: your own printings in the form + duplicating a card ----
  await gotoCurate();
  await page.waitForSelector('#cur-card button:has-text("Edit card")');
  await page.click('#cur-card button:has-text("Edit card")');
  await page.waitForSelector('.ce-panel');
  await page.fill('.ce-panel input[placeholder="e.g. Cracked Ice Holo"]', 'Sparkle Foil');
  await page.click('.ce-panel button:has-text("＋ Add")');
  await page.waitForSelector('.ce-panel .chip:has-text("Sparkle Foil")');
  await page.click('.ce-panel button:has-text("Save changes")');
  await page.waitForFunction(() => !document.querySelector('.ce-panel'));
  await page.goto('http://localhost:3111/#/set/test-promos');
  await page.waitForSelector('.tcg-card[data-variant="sparkle-foil"]');
  check('editor: a printing added right in the card form', true);

  // duplicate it — details, printings, and the picture come along
  await gotoCurate();
  await page.waitForSelector('#cur-card button:has-text("Duplicate")');
  await page.click('#cur-card button:has-text("Duplicate")');
  await page.waitForSelector('.ce-panel h3:has-text("Duplicate")');
  check('editor: duplicate pre-fills from the source card',
    (await page.locator('.ce-panel input[placeholder="e.g. Eevee"]').inputValue()) === 'Eevee Star EX' &&
    (await page.textContent('.ce-panel')).includes('Using the picture of'));
  await page.fill('.ce-panel input[placeholder="pick a free number"]', '2');
  await page.click('.ce-panel button:has-text("Add card")');
  await page.waitForFunction(() => !document.querySelector('.ce-panel'));
  await page.goto('http://localhost:3111/#/set/test-promos');
  await page.waitForSelector('.tcg-card[data-card-id="test-promos-2"]');
  check('editor: duplicated card reuses the source picture and printings',
    ((await page.locator('.tcg-card[data-card-id="test-promos-2"] >> nth=0 >> img').getAttribute('src')) || '').includes('test-promos/1/card-low.webp') &&
    (await page.locator('.tcg-card[data-card-id="test-promos-2"][data-variant="sparkle-foil"]').count()) === 1);

  // ---- ＋ Add card can copy everything from a card in ANOTHER set ----
  await gotoCurate();
  await page.selectOption('#cur-set-select', 'test-promos');
  await page.click('#cur-add-card');
  await page.waitForSelector('.ce-panel');
  await page.click('.ce-panel button:has-text("Copy from a card")');
  await page.waitForSelector('.picker-overlay .picker-row');
  check('editor: copy-from picker offers every card (chunked, no cap)',
    !(await page.textContent('.picker-overlay .picker-results')).includes('showing 60'));
  await page.fill('.picker-overlay input[placeholder="Search cards by name…"]', 'Pikachu');
  await page.waitForSelector('.picker-row:has-text("Pikachu")');
  await page.click('.picker-row:has-text("Pikachu") >> nth=0');
  await page.waitForFunction(() => {
    const n = document.querySelector('.ce-panel input[placeholder="e.g. Eevee"]');
    return n && n.value === 'Pikachu';
  });
  check('editor: ＋ Add card copies the whole form from a card in another set',
    (await page.textContent('.ce-panel')).includes('Using the picture of Pikachu'));
  await page.fill('.ce-panel input[placeholder="e.g. Eevee"]', 'Pika Promo');   // renamed copy
  await page.fill('.ce-panel input[placeholder="e.g. 51 or SWSH087"]', '3');
  await page.click('.ce-panel button:has-text("Add card")');
  await page.waitForFunction(() => !document.querySelector('.ce-panel'));
  await page.goto('http://localhost:3111/#/set/test-promos');
  await page.waitForSelector('.tcg-card[data-card-id="test-promos-3"]');
  check('editor: copied card lands in THIS set with the source picture',
    ((await page.locator('.tcg-card[data-card-id="test-promos-3"] >> nth=0 >> img').getAttribute('src')) || '').includes('base1/58/'));

  // ---- ⬆ From another card: borrow a picture for a card that already exists ----
  // Same picker as Copy-from, but it takes only the image, and it offers only
  // cards that HAVE one — an empty tile would be a picture you cannot borrow.
  await gotoCurate();
  await curePick('Pika Promo', 'Pika Promo');
  await page.click('#cur-card button:has-text("Edit card")');
  await page.waitForSelector('.ce-panel');
  await page.click('.ce-panel button:has-text("From another card")');
  await page.waitForSelector('.picker-overlay .picker-row');
  const picked = await page.$$eval('.picker-overlay .picker-row', (els) => els.map((e) => e.textContent));
  check('editor: the image picker offers only cards that have a picture',
    picked.length > 0 && !picked.some((t) => t.includes('No Image Card')));
  await page.fill('.picker-overlay input[placeholder="Search cards by name…"]', 'Charizard');
  await page.waitForSelector('.picker-row:has-text("Charizard")');
  await page.click('.picker-row:has-text("Charizard") >> nth=0');
  await page.waitForFunction(() => {
    const p = document.querySelector('.ce-panel');
    return p && p.textContent.includes('Using the picture of Charizard');
  });
  check('editor: picking a card borrows its picture and says whose it is', true);
  await page.click('.ce-panel button:has-text("Save changes")');
  await page.waitForFunction(() => !document.querySelector('.ce-panel'));
  await page.goto('http://localhost:3111/#/set/test-promos');
  await page.waitForSelector('.tcg-card[data-card-id="test-promos-3"]');
  check('editor: the borrowed picture is the one the card now shows',
    ((await page.locator('.tcg-card[data-card-id="test-promos-3"] >> nth=0 >> img').getAttribute('src')) || '').includes('base1/4/'));

  // ---- his bug: uncheck every default variant + type a custom name WITHOUT
  //      clicking ＋Add — the card must save with ONLY the custom printing ----
  await gotoCurate();
  await page.selectOption('#cur-set-select', 'test-promos');
  await page.click('#cur-add-card');
  await page.waitForSelector('.ce-panel');
  await page.fill('.ce-panel input[placeholder="e.g. Eevee"]', 'Solo Promo');
  await page.fill('.ce-panel input[placeholder="e.g. 51 or SWSH087"]', '4');
  await page.uncheck('.ce-panel label.ce-var:has-text("Normal") input');
  await page.fill('.ce-panel input[placeholder="e.g. Cracked Ice Holo"]', 'Gold Stamp');
  await page.click('.ce-panel button:has-text("Add card")');   // note: no ＋Add first
  await page.waitForFunction(() => !document.querySelector('.ce-panel'));
  await page.goto('http://localhost:3111/#/set/test-promos');
  await page.waitForSelector('.tcg-card[data-card-id="test-promos-4"]');
  check('editor: unchecking every default variant sticks (no phantom Normal)',
    (await page.locator('.tcg-card[data-card-id="test-promos-4"]').count()) === 1 &&
    (await page.locator('.tcg-card[data-card-id="test-promos-4"][data-variant="gold-stamp"]').count()) === 1);
  check('editor: a typed-but-not-added custom printing still saves',
    (await page.locator('.tcg-card[data-card-id="test-promos-4"] .fx-label').textContent()) === 'Gold Stamp');

  // ---- the consultant sheet: CSV in, cross-referenced, nothing duplicated ----
  await gotoCurate();
  await page.fill('#cur-sheet-url', 'https://docs.google.com/spreadsheets/d/EXAMPLE/edit');
  check('sheet card: the link button points at the sheet',
    await page.locator('#cur-sheet-open').isVisible() &&
    (await page.locator('#cur-sheet-open').getAttribute('href')).includes('docs.google.com'));
  const fixture = (name) => require('path').join(__dirname, 'fixtures', name);
  const uploadAndCheck = async (name) => {
    await page.setInputFiles('#cur-sheet-file', fixture(name));
    await page.waitForSelector('#cur-sheet-analyze');
    await page.click('#cur-sheet-analyze');
    await page.waitForSelector('#cur-sheet-totals', { timeout: 30000 });
  };
  const openSet = async (id) => {
    if (await page.locator('#cur-set-back').isVisible()) await page.click('#cur-set-back');
    await page.click(`.cur-set-row[data-set="${id}"]`);
    await page.waitForSelector('#cur-set-apply');
  };
  /** the apply of a set re-reads the mirror; the stage counts its applies */
  const applySet = async () => {
    const n = parseInt(await page.getAttribute('#cur-sheet-stage', 'data-applied') || '0', 10);
    await page.click('#cur-set-apply');
    await page.waitForFunction((want) => parseInt(document.querySelector('#cur-sheet-stage').dataset.applied || '0', 10) >= want, n + 1, { timeout: 30000 });
    await page.waitForSelector('#cur-sheet-totals');
  };
  const setRows = async () => page.locator('.cur-set-row').allTextContents();

  await page.setInputFiles('#cur-sheet-file', fixture('consultant.csv'));
  await page.waitForSelector('#cur-sheet-analyze');
  check('sheet: columns guessed right, including the treacherous ones',
    (await page.locator('select[data-col="0"]').inputValue()) === '' &&          // Series is a grouping, not the set
    (await page.locator('select[data-col="1"]').inputValue()) === 'set' &&       // Expansion IS the set
    (await page.locator('select[data-col="3"]').inputValue()) === 'number' &&    // "Set number" is a number
    (await page.locator('select[data-col="4"]').inputValue()) === 'setsize' &&   // "Set si[ze]" is the /102 column
    (await page.locator('select[data-col="7"]').inputValue()) === 'types' &&
    (await page.locator('select[data-col="8"]').inputValue()) === 'variant');
  await page.click('#cur-sheet-analyze');
  await page.waitForSelector('#cur-sheet-sets');
  check('sheet: the review is a list of sets — no card lists until a set is opened',
    (await page.locator('.cur-card').count()) === 0 &&
    (await page.textContent('#cur-sheet-totals')).includes('3 to add') &&
    (await page.textContent('#cur-sheet-totals')).includes('3 absent'));

  // ---- the highest level first: unknown sheet sets are matched, not guessed ----
  await page.waitForSelector('#cur-sheet-match');
  const matchText = await page.textContent('#cur-sheet-match');
  check('sheet: unknown set names park in a match-first step, rows excluded until resolved',
    matchText.includes('Basic Set') && matchText.includes('Consultant Promos'));
  check('sheet: a suffixed set name resolves by itself — (E) never needed matching',
    !matchText.includes('Test Promos (E)'));
  // "Basic Set" IS Base Set — match it; the pairing is remembered server-side
  await page.selectOption('select[data-alias="Basic Set"]', 'base1');
  await page.waitForFunction(() => (document.querySelector('#cur-sheet-totals') || {}).textContent?.includes('6 matched'));
  check('sheet: an aliased set folds its rows into the matched set (6 matched now)', true);
  // "Consultant Promos" is genuinely new — create it
  await page.selectOption('select[data-alias="Consultant Promos"]', '::create');
  await page.waitForFunction(() => (document.querySelector('#cur-sheet-totals') || {}).textContent?.includes('5 to add'));
  check('sheet: choosing create turns the unknown set into a reviewed proposal', true);
  const rows1 = await setRows();
  check('sheet: the set list names every set with a decision, new sets marked as such',
    rows1.some((t) => t.startsWith('Test Promos')) && rows1.some((t) => t.includes('Consultant Promos') && t.includes('(new set)')) &&
    rows1.some((t) => t.startsWith('Base Set') && t.includes('absent')));
  const stageText0 = await page.textContent('#cur-sheet-stage');
  check('sheet: duplicate rows inside the sheet are collapsed', stageText0.includes('1 duplicate row(s)'));

  await openSet('test-promos');
  const stageText = await page.textContent('#cur-set-detail');
  check('sheet: a set shows its cards with the database\'s printings beside the sheet\'s rows',
    (await page.locator('.cur-card').count()) >= 3 && stageText.includes('Database has:'));
  check('sheet: rows already in the database produce NO proposals (no duplicates)',
    !stageText.includes('"Sparkle Foil"') && !stageText.includes('Sheet says "Normal"'));
  check('sheet: "Holo Rare"/"Pokémon"/"Fire" match "Rare Holo"/"Pokemon"/["Fire"] — no phantom differences',
    !stageText.includes('Charizard'));
  check('sheet: a standard variant is matched through its synonym (Reverse Foil) and proposed as the standard printing',
    stageText.includes('Sheet says "Reverse Foil"') && stageText.includes('sheet row 7'));
  check('sheet: an unknown printing becomes a custom-printing proposal',
    stageText.includes('Sheet says "Prerelease Stamp"'));
  check('sheet: a differing field goes up for review, not silently applied',
    stageText.includes('name: "Eevee Star Prime"') === false && /name: ".*" → "Eevee Star Prime"/.test(stageText));
  check('sheet: new cards are proposed inside their set, with their printings',
    stageText.includes('New card: #9 Brand New Mon') && stageText.includes('Holo'));
  check('sheet: rows deleted from the sheet are reported, never auto-applied',
    stageText.includes('absent from the sheet') && stageText.includes('Pika Promo'));
  await page.click('#cur-set-back');
  await openSet('base1');
  const baseText = await page.textContent('#cur-set-detail');
  await page.click('#cur-set-back');
  await openSet('test-promos');
  check('sheet: the skipped 1st Edition row surfaces by name (the Pikachu case)',
    baseText.includes('Pikachu') && baseText.includes('1st Edition is absent'));
  check('sheet: printings outside the sheet\'s vocabulary are NOT flagged as deleted',
    !stageText.includes('Gold Stamp is absent'));
  check('sheet: every proposal offers add / this-is / ignore, and absences start as keep',
    (await page.locator('.cur-item[data-kind="custom"] select.cur-choice option:has-text("This is →")').count()) >= 1 &&
    (await page.locator('.cur-item[data-kind="missing"] select.cur-choice').evaluateAll((els) => els.every((e) => e.value === 'keep'))));
  await applySet();
  await openSet('consultant-promos');
  await applySet();
  const applied = await page.evaluate(async () => {
    const tp = await (await fetch('api/catalog/set?lang=en&id=test-promos')).json();
    const cp = await (await fetch('api/catalog/set?lang=en&id=consultant-promos')).json();
    const c1 = (tp.cards || []).find((c) => c.id === 'test-promos-1');
    const c2 = (tp.cards || []).find((c) => c.id === 'test-promos-2');
    const c9 = (tp.cards || []).find((c) => c.id === 'test-promos-9');
    const s1 = (cp.cards || []).find((c) => c.id === 'consultant-promos-1');
    return {
      reverse: !!(c1 && c1.variants && c1.variants.reverse),
      stamp: !!(c1 && c1.printings && Object.values(c1.printings).includes('Prerelease Stamp')),
      renamed: c2 && c2.name,
      newCard: !!(c9 && c9.variants && c9.variants.holo && c9.rarity === 'Rare Holo'),
      newSetCard: !!(s1 && s1.name === 'Sheetmon' && s1.variants && s1.variants.firstEdition),
      unTickedSurvive: (tp.cards || []).some((c) => c.id === 'test-promos-3') && (tp.cards || []).some((c) => c.id === 'test-promos-4'),
    };
  });
  check('sheet: applied — the synonym variant landed on the card', applied.reverse);
  check('sheet: applied — the custom printing landed with its label', applied.stamp);
  check('sheet: applied — the reviewed field difference was written', applied.renamed === 'Eevee Star Prime');
  check('sheet: applied — the new card exists with its printing and rarity', applied.newCard);
  check('sheet: applied — the new set exists and holds its card', applied.newSetCard);
  check('sheet: applied — untouched absences were left alone', applied.unTickedSurvive);
  check('sheet: applied sets leave the list; only absences remain',
    (await setRows()).every((t) => /absent/.test(t) && !/to decide/.test(t)));

  // the proof of idempotence: the same sheet again finds nothing to do
  await gotoCurate();
  await uploadAndCheck('consultant.csv');
  await page.waitForSelector('#cur-sheet-clean');
  check('sheet: uploading the same sheet again imports nothing (idempotent)', true);
  check('sheet: deleted rows are still reported alongside a clean import',
    (await page.textContent('#cur-sheet-totals')).includes('3 absent'));
  check('sheet: the saved match resolves "Basic Set" by itself next time',
    (await page.locator('#cur-sheet-match').count()) === 0);
  await page.click('#cur-sheet-aliases summary');
  await page.waitForSelector('#cur-sheet-aliases .row');
  check('sheet: the saved match is listed and forgettable',
    (await page.textContent('#cur-sheet-aliases')).includes('"Basic Set" → base1'));
  await openSet('test-promos');
  check('sheet: every absence starts as keep',
    await page.locator('.cur-item[data-kind="missing"] select.cur-choice').evaluateAll((els) => els.length > 0 && els.every((e) => e.value === 'keep')));
  // acting on a deletion is an explicit choice — and surgical: Pika Promo also
  // has a 1st Edition printing the sheet says nothing about, so what's on
  // offer is removing its Normal printing, not hiding the card
  await page.selectOption('.cur-card[data-card="test-promos-3"] .cur-item[data-kind="missing"] select.cur-choice', 'remove');
  await applySet();
  const pika = await page.evaluate(async () => {
    const d = await (await fetch('api/catalog/set?lang=en&id=test-promos')).json();
    const c = (d.cards || []).find((x) => x.id === 'test-promos-3');
    return { exists: !!c, normal: !!(c && c.variants && c.variants.normal) };
  });
  check('sheet: a chosen deletion removes exactly that printing, and the card survives',
    pika.exists && !pika.normal);

  // ---- the mirror: the second sheet is a DIFF against the first ----
  // consultant-v2.csv = the same sheet with a row inserted at the top (every
  // row below it shifts down one), one variant rewritten in place ("Reverse
  // Foil" -> "Reverse Holo") and one row deleted (Eevee Star Prime).
  const mirrorBefore = await page.evaluate(async () => (await (await fetch('api/masterlist/status?lang=en')).json()));
  check('mirror: the first upload recorded every sheet row, each linked to a printing',
    mirrorBefore.total === 11 && mirrorBefore.linked === 11 && mirrorBefore.gone === 0);
  await gotoCurate();
  await uploadAndCheck('consultant-v2.csv');
  const v2Text = await page.textContent('#cur-sheet-stage');
  check('mirror: an inserted row shifts everything below it, and NOTHING reads as changed',
    /Mirror: 11 rows in the sheet — 1 new, 1 edited in place, 0 with changed details, 1 left the sheet, 7 moved, 9 unchanged/.test(v2Text));
  check('mirror: only the new row is proposed — moved rows are not re-imported',
    (await page.textContent('#cur-sheet-totals')).includes('1 to add') && (await setRows()).some((t) => t.startsWith('Test Promos') && t.includes('1 to decide')));
  check('mirror: a rewritten variant is shown as an edit, from -> to',
    (await page.locator('#cur-sheet-edited').count()) === 1 && v2Text.includes('"Reverse Foil"') && v2Text.includes('"Reverse Holo"'));
  await openSet('test-promos');
  const v2Open = await page.textContent('#cur-set-detail');
  check('mirror: a deleted row names the printing it was, with the row it sat on',
    v2Open.includes('Eevee Star Prime') && v2Open.includes('Sheet says "Jumbo"') && v2Open.includes('(was row 10, "Normal")'));
  // the curator's call: the sheet's "Jumbo" IS this card's Holo — and remembered for every card
  await page.selectOption('.cur-card[data-card="test-promos-9"] .cur-item[data-kind="custom"] select.cur-choice', 'match:holo');
  check('mirror: choosing "this is" reveals the remember-for-every-card choice',
    await page.locator('.cur-card[data-card="test-promos-9"] .cur-remember').isVisible());
  await page.check('.cur-card[data-card="test-promos-9"] .cur-remember');
  check('mirror: the deletion is a report — it starts as keep',
    await page.locator('.cur-card[data-card="test-promos-2"] .cur-item[data-kind="missing"] select.cur-choice').evaluate((e) => e.value === 'keep'));
  await applySet();
  const mirrorAfter = await page.evaluate(async () => {
    const st = await (await fetch('api/masterlist/status?lang=en')).json();
    const l9 = (await (await fetch('api/masterlist/links?lang=en&cardId=test-promos-9')).json()).links;
    const l1 = (await (await fetch('api/masterlist/links?lang=en&cardId=test-promos-1')).json()).links;
    const l2 = (await (await fetch('api/masterlist/links?lang=en&cardId=test-promos-2')).json()).links;
    const va = (await (await fetch('api/import-variant-aliases?lang=en')).json()).aliases;
    const c9 = ((await (await fetch('api/catalog/set?lang=en&id=test-promos')).json()).cards || []).find((c) => c.id === 'test-promos-9');
    return { st, l9, l1, l2, va, c9 };
  });
  check('mirror: rows that left are kept as gone, never deleted (13 on record: 11 live + the deleted row + the edit\'s old wording)',
    mirrorAfter.st.total === 13 && mirrorAfter.st.gone === 2);
  check('mirror: a manual match links the sheet row to the existing printing and creates nothing (Jumbo = row 2 → Holo)',
    mirrorAfter.l9.some((l) => l.variant === 'holo' && l.rowNo === 2 && !l.gone) && mirrorAfter.l9.some((l) => l.variant === 'holo' && l.rowNo === 11) &&
    !(mirrorAfter.c9.printings && Object.values(mirrorAfter.c9.printings).includes('Jumbo')));
  check('mirror: the remembered wording is saved as a variant alias',
    mirrorAfter.va.some((a) => a.raw === 'Jumbo' && a.variant === 'holo'));
  check('mirror: the rewritten row links to the same printing under its new wording',
    mirrorAfter.l1.some((l) => l.variant === 'reverse' && l.sheetVariant === 'Reverse Holo' && l.rowNo === 8));
  check('mirror: the untouched deletion keeps both its printing and its (gone) link',
    mirrorAfter.l2.some((l) => l.variant === 'normal' && l.gone === true && l.rowNo === 10));
  // the curator sees where a printing came from, on the card itself
  await page.goto('http://localhost:3111/#/set/test-promos');
  await page.waitForSelector('.tcg-card[data-card-id="test-promos-9"]');
  await page.click('.tcg-card[data-card-id="test-promos-9"] >> nth=0 >> .info-btn');
  await page.waitForSelector('#card-modal[open] #card-source');
  await page.waitForFunction(() => /Masterlist row/.test(document.querySelector('#card-source').textContent));
  check('card modal: the admin sees which masterlist row the printing is',
    /Masterlist row 11/.test(await page.textContent('#card-source')));
  await page.evaluate(() => document.getElementById('card-modal').close());

  // ---- remembered matches do the work next time: a wording, and a card the numbers miss ----
  // consultant-v3.csv = v2 + a "Jumbo" row on Eevee Star EX (the remembered
  // wording now means Holo everywhere) + a row for "Gold Star Eevee #77" that
  // is really card test-promos-4 under another number
  await gotoCurate();
  await uploadAndCheck('consultant-v3.csv');
  await openSet('test-promos');
  const v3Text = await page.textContent('#cur-set-detail');
  check('aliases: a remembered wording resolves on a different card without asking (Jumbo → Holo proposed as the standard printing)',
    /Sheet says "Jumbo"[^\n]*sheet row/.test(v3Text) && (await page.locator('.cur-card[data-card="test-promos-1"] .cur-item[data-kind="variant"]').count()) === 1);
  check('aliases: a card the numbers cannot find is proposed as new, with a this-is picker of the set\'s cards',
    v3Text.includes('New card: #77 Gold Star Eevee') &&
    (await page.locator('.cur-item[data-kind="card"] select.cur-choice option:has-text("This is → #4")').count()) === 1);
  await page.selectOption('.cur-item[data-kind="card"] select.cur-choice', 'match:test-promos-4');
  // the Jumbo-on-Eevee proposal is not wanted: ignore it this time
  await page.selectOption('.cur-card[data-card="test-promos-1"] .cur-item[data-kind="variant"] select.cur-choice', 'ignore');
  await applySet();
  await page.waitForSelector('#cur-set-apply');
  const v3After = await page.textContent('#cur-set-detail');
  const cardAliases = await page.evaluate(async () => (await (await fetch('api/import-card-aliases?lang=en')).json()).aliases);
  check('aliases: the card match is remembered, and the row now speaks for that card (#4) — proposed as its printing, no duplicate card',
    cardAliases.some((a) => a.cardId === 'test-promos-4' && /Gold Star Eevee/.test(a.raw)) &&
    !v3After.includes('New card: #77') && (await page.locator('.cur-card[data-card="test-promos-4"] .cur-item[data-kind="variant"]').count()) === 1);
  check('aliases: an ignored proposal comes back next time — ignore is for now, not forever',
    (await page.locator('.cur-card[data-card="test-promos-1"] .cur-item[data-kind="variant"]').count()) === 1);
  const noDupe = await page.evaluate(async () => ((await (await fetch('api/catalog/set?lang=en&id=test-promos')).json()).cards || []).filter((c) => /Gold Star Eevee/.test(c.name)).length);
  check('aliases: no card was created for the matched row', noDupe === 0);

  // ---- a settled row still has a say on its card's details, and "keep ours" is remembered ----
  // the catalog drifts (someone edits Brand New Mon's rarity); the sheet's row
  // for it was linked long ago — the difference must surface all the same
  await page.evaluate(async () => fetch('api/card', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: 'en', cardId: 'test-promos-9', rarity: 'Common' }) }));
  await gotoCurate();
  await page.waitForSelector('#cur-sheet-resume', { state: 'visible' });
  await page.click('#cur-sheet-resume');
  await page.waitForSelector('#cur-sheet-sets');
  check('resume: the review picks up from the mirror without an upload', (await setRows()).length >= 1);
  await page.fill('#cur-sheet-filter', 'test prom');
  check('set list: the filter narrows the list to the sets that match',
    (await page.locator('.cur-set-row:visible').count()) === 1 && (await page.locator('.cur-set-row[data-set="test-promos"]').isVisible()));
  await openSet('test-promos');
  const driftText = await page.textContent('.cur-card[data-card="test-promos-9"]');
  check('settled rows: a field difference on a long-linked row surfaces, spelled the database\'s way',
    /rarity: "Common" → "Rare Holo"/.test(driftText));
  await page.selectOption('.cur-card[data-card="test-promos-9"] .cur-item[data-kind="diff"] select.cur-choice', 'keep');
  await applySet();
  const kept = await page.evaluate(async () => {
    const l9 = (await (await fetch('api/masterlist/links?lang=en&cardId=test-promos-9')).json()).links;
    const c9 = ((await (await fetch('api/catalog/set?lang=en&id=test-promos')).json()).cards || []).find((c) => c.id === 'test-promos-9');
    return { keep: l9.filter((l) => l.keep.includes('rarity')).length, rarity: c9.rarity };
  });
  check('keep ours: nothing is written, and the ruling rides on the rows\' links',
    kept.rarity === 'Common' && kept.keep >= 1 &&
    !/rarity:/.test((await page.locator('.cur-card[data-card="test-promos-9"]').count()) ? await page.textContent('.cur-card[data-card="test-promos-9"]') : ''));
  // the ruling survives the next upload of the same sheet
  await gotoCurate();
  await uploadAndCheck('consultant-v3.csv');
  await openSet('test-promos');
  check('keep ours: a re-upload does not ask again',
    !/rarity: "Common"/.test(await page.textContent('#cur-set-detail')));

  // ---- a card's decisions agree with each other: "this is X" and "remove X" cannot both stand ----
  // consultant-v4.csv = v3 + a "Jumbo" row for Eevee Star Prime (#2), a card whose
  // Normal and Sparkle Foil the sheet no longer lists
  await gotoCurate();
  await uploadAndCheck('consultant-v4.csv');
  await openSet('test-promos');
  const c2 = '.cur-card[data-card="test-promos-2"]';
  check('agreement: the card shows both a proposal and its absences',
    (await page.locator(`${c2} .cur-item[data-kind="variant"]`).count()) === 1 &&
    (await page.locator(`${c2} .cur-item[data-kind="missing"]:visible`).count()) === 2);
  // "remember for every card" works on screen: Eevee Star EX's "Staff Stamp" row is
  // matched to its Sparkle Foil — Eevee Star Prime's "Staff Stamp" row follows to ITS Sparkle Foil
  const c1 = '.cur-card[data-card="test-promos-1"]';
  await page.selectOption(`${c1} .cur-item[data-kind="custom"] select.cur-choice`, 'match:sparkle-foil');
  await page.check(`${c1} .cur-remember`);
  check('remember: the other card with the same wording follows at once, and its absence line retires',
    (await page.locator(`${c2} .cur-item[data-kind="custom"] select.cur-choice`).inputValue()) === 'match:sparkle-foil' &&
    (await page.locator(`${c2} .cur-item[data-kind="missing"]:visible`).count()) === 1);
  await page.uncheck(`${c1} .cur-remember`);
  check('remember: unticking puts the followers back',
    (await page.locator(`${c2} .cur-item[data-kind="custom"] select.cur-choice`).inputValue()) === 'add' &&
    (await page.locator(`${c2} .cur-item[data-kind="missing"]:visible`).count()) === 2);
  await page.selectOption(`${c1} .cur-item[data-kind="custom"] select.cur-choice`, 'ignore');
  await page.selectOption(`${c2} .cur-item[data-kind="custom"] select.cur-choice`, 'ignore');
  await page.selectOption(`${c2} .cur-item[data-kind="variant"] select.cur-choice`, 'match:sparkle-foil');
  check('agreement: "this is → Sparkle Foil" makes the Sparkle Foil absence disappear',
    (await page.locator(`${c2} .cur-item[data-kind="missing"]:visible`).count()) === 1 &&
    !(await page.locator(`${c2} .cur-item[data-kind="missing"]:visible`).first().textContent()).includes('Sparkle Foil'));
  await page.selectOption(`${c2} .cur-item[data-kind="missing"]:visible select.cur-choice`, 'remove');
  check('agreement: "remove Normal" withdraws "this is → Normal" from the proposal',
    await page.locator(`${c2} .cur-item[data-kind="variant"] select.cur-choice option[value="match:normal"]`).evaluate((o) => o.disabled));
  await applySet();
  const agreed = await page.evaluate(async () => {
    const c = ((await (await fetch('api/catalog/set?lang=en&id=test-promos')).json()).cards || []).find((x) => x.id === 'test-promos-2');
    const l2 = (await (await fetch('api/masterlist/links?lang=en&cardId=test-promos-2')).json()).links;
    return { normal: !!(c.variants && c.variants.normal), sparkle: !!(c.printings && c.printings['sparkle-foil']), linked: l2.some((l) => l.variant === 'sparkle-foil' && l.sheetVariant === 'Jumbo' && !l.gone) };
  });
  check('agreement: applied — Normal removed, Sparkle Foil kept and now linked to the Jumbo row',
    !agreed.normal && agreed.sparkle && agreed.linked);

  // tidy the stage for the main suite: the consultant set proved its point —
  // hide it so the home page holds the sets the smoke checks expect
  await page.evaluate(async () => {
    await fetch('api/set-hide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'consultant-promos', hidden: true, lang: 'en' }) });
  });

  // sign the admin out so the main suite's fresh user is a clean non-admin test
  await page.click('#account-btn');
  await page.waitForSelector('#account-page button:has-text("Sign out")');
  await page.click('#account-page button:has-text("Sign out")');
  await page.evaluate(() => localStorage.clear());

  console.log(errors.length ? 'JS ERRORS:\n' + errors.join('\n') : 'No JS errors.');
  if (failCount) console.log(failCount + ' check(s) FAILED');
  await browser.close();
  process.exit(errors.length || failCount ? 1 : 0);
})();
