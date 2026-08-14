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
  await page.setInputFiles('#cur-sheet-file', require('path').join(__dirname, 'fixtures', 'consultant.csv'));
  await page.waitForSelector('#cur-sheet-analyze');
  check('sheet: columns are guessed from the headers',
    (await page.locator('select[data-col="0"]').inputValue()) === 'set' &&
    (await page.locator('select[data-col="1"]').inputValue()) === 'number' &&
    (await page.locator('select[data-col="3"]').inputValue()) === 'variant');
  await page.click('#cur-sheet-analyze');
  await page.waitForSelector('#cur-sheet-apply');
  const stageText = await page.textContent('#cur-sheet-stage');
  check('sheet: rows already in the database produce NO proposals (no duplicates)',
    stageText.includes('3 row(s) already match the database'));
  check('sheet: duplicate rows inside the sheet are collapsed', stageText.includes('1 duplicate row(s)'));
  check('sheet: a new set is proposed', stageText.includes('New sets (1)') && stageText.includes('Consultant Promos'));
  check('sheet: new cards are proposed with their printings',
    stageText.includes('New cards (2)') && stageText.includes('Brand New Mon') && stageText.includes('Sheetmon'));
  check('sheet: a standard variant is matched through its synonym (Reverse Foil)',
    stageText.includes('New printings (1)') && stageText.includes('Reverse Holo'));
  check('sheet: an unknown printing becomes a custom-printing proposal',
    stageText.includes('New custom printings (1)') && stageText.includes('Prerelease Stamp'));
  check('sheet: a differing field goes up for review, not silently applied',
    stageText.includes('Field differences (1)') && stageText.includes('Eevee Star Prime'));
  check('sheet: rows deleted from the sheet are reported, never auto-applied',
    stageText.includes('In the database but not in the sheet (3)') &&
    stageText.includes('Pika Promo') && stageText.includes('Solo Promo') && stageText.includes('Sparkle Foil is absent'));

  await page.click('#cur-sheet-apply');
  await page.waitForSelector('#cur-sheet-done', { timeout: 30000 });
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
  check('sheet: applied — unticked deletions were left alone', applied.unTickedSurvive);

  // the proof of idempotence: the same sheet again finds nothing to do
  await gotoCurate();
  await page.setInputFiles('#cur-sheet-file', require('path').join(__dirname, 'fixtures', 'consultant.csv'));
  await page.waitForSelector('#cur-sheet-analyze');
  await page.click('#cur-sheet-analyze');
  await page.waitForSelector('#cur-sheet-clean');
  check('sheet: uploading the same sheet again imports nothing (idempotent)', true);
  const cleanText = await page.textContent('#cur-sheet-stage');
  check('sheet: deleted rows are still reported alongside a clean import',
    cleanText.includes('In the database but not in the sheet (3)') && cleanText.includes('Pika Promo'));
  check('sheet: every deletion box starts unticked',
    (await page.locator('#cur-sheet-stage input[type=checkbox]:checked').count()) === 0);
  // acting on a deletion is an explicit tick: hide the whole absent card
  await page.check('#cur-sheet-stage label:has-text("Solo Promo") input');
  await page.click('#cur-sheet-apply');
  await page.waitForSelector('#cur-sheet-done');
  const soloGone = await page.evaluate(async () => {
    const d = await (await fetch('api/catalog/set?lang=en&id=test-promos')).json();
    return !(d.cards || []).some((c) => c.id === 'test-promos-4');
  });
  check('sheet: a ticked whole-card deletion hides the card', soloGone);

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
