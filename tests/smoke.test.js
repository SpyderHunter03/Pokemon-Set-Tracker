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

  // ---- logged out: browse-only (tracking requires an account) ----
  await page.goto('http://localhost:3111/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('.set-card');
  check('logged out: no stats banner', (await page.locator('#stats-banner').count()) === 0);
  check('logged out: sign-in prompt shown', (await page.locator('.signin-banner').count()) === 1);
  await page.click('.set-card:has-text("Base Set")');
  await page.waitForSelector('.tcg-card');
  check('logged out: owned/missing filters hidden', (await page.locator('.chips .chip', { hasText: 'Owned' }).count()) === 0);
  await page.click('.tcg-card >> nth=0'); // a tap opens details, does NOT toggle ownership
  await page.waitForSelector('#card-modal[open]');
  const guestColl = await page.evaluate(() => JSON.parse(localStorage.getItem('ptcg.collection.v2') || '{}'));
  check('logged out: tapping a card does not track', Object.keys(guestColl).length === 0);
  check('logged out: modal offers sign-in', (await page.locator('#card-modal button', { hasText: 'Sign in' }).count()) >= 1);
  await page.click('#card-modal button:has-text("Close")');
  check('logged out: backup section hidden', await page.evaluate(() => {
    renderAccountModal();
    return document.getElementById('backup-area').style.display === 'none';
  }));

  // ---- sign in + old v1 data migration ----
  const uniq = 'smoke' + Math.floor(Math.random() * 1e6);
  await page.goto('http://localhost:3111/');
  await page.evaluate(async (u) => {
    localStorage.setItem('ptcg.collection.v1', JSON.stringify({ 'base1-58': 2 }));
    const r = await fetch('api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'password123' }) });
    const d = await r.json();
    localStorage.setItem('ptcg.auth', JSON.stringify({ token: d.token, username: d.username }));
  }, uniq);
  await page.reload();
  await page.waitForSelector('.set-card');

  const migrated = await coll();
  check('v1 → v2 migration', migrated && migrated['base1-58'] && migrated['base1-58'].normal === 2);
  check('signed in: stats banner shown', (await page.locator('#stats-banner').count()) === 1);
  check('signed in: backup section shown', await page.evaluate(() => {
    renderAccountModal();
    return document.getElementById('backup-area').style.display !== 'none';
  }));
  check('home shows sets', (await page.locator('.set-card').count()) === 3);   // base1 + Darkness Ablaze + admin-made Test Promos
  check('set tiles show a printings tally too',
    (await page.textContent('.set-card .count >> nth=0')).includes('printings') &&
    (await page.locator('.set-card >> nth=0 >> .progress').count()) === 2);
  check('TCG Pocket sets excluded from the database',
    !(await page.locator('.set-card').allTextContents()).join(' ').includes('Genetic Apex'));
  check('stats count migrated card', (await page.textContent('#stat-owned')).trim() === '1');

  // home sorting: newest first by default, switchable to name
  check('sets newest first by default', (await page.locator('.set-card .name >> nth=0').textContent()).includes('Test Promos'));   // the admin-made set from the bootstrap suite is newest
  await page.selectOption('.chips select', 'name');
  check('sets sortable by name', (await page.locator('.set-card .name >> nth=0').textContent()).includes('Base Set'));
  await page.selectOption('.chips select', 'most-owned');
  check('sets sortable by most owned', (await page.locator('.set-card .name >> nth=0').textContent()).includes('Base Set'));
  await page.selectOption('.chips select', 'least-owned');
  check('sets sortable by least owned', (await page.locator('.set-card .name >> nth=0').textContent()).includes('Darkness'));
  await page.selectOption('.chips select', 'newest');

  // ---- set page: one tile per printing ----
  await page.click('.set-card:has-text("Base Set")');
  await page.waitForSelector('.tcg-card');
  check('set page shows 8 printing tiles (incl. custom Cracked Ice Holo)', (await page.locator('.tcg-card').count()) === 8);
  check('progress counts unique cards', (await page.textContent('.page-head .muted')).trim() === '1 / 102');

  const badges = await page.locator('.tcg-card .fx-label').allTextContents();
  check('variant labels incl. Unlimited, 1st Edition, custom printing',
    JSON.stringify(badges.slice(0, 4)) === JSON.stringify(['Holo', '1st Edition', 'Cracked Ice Holo', 'Unlimited']));

  check('imageless cards show clean placeholders', (await page.locator('.tcg-card .noimg').count()) === 2);
  check('every tile banners its printing (no unlabeled cards)',
    (await page.locator('.tcg-card').count()) === (await page.locator('.tcg-card .fx-label').count()));
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

  // ---- printing looks: name banner on non-primary printings + real variant scans ----
  check('primary printing banners its name too now', (await page.locator('.tcg-card >> nth=0 >> .fx-label').textContent()) === 'Holo');
  check('1st Edition printing shows its name across the base scan', (await page.locator('.tcg-card >> nth=1 >> .fx-label').textContent()) === '1st Edition');
  check('unlimited (primary) printing banners "Unlimited"', (await page.locator('.tcg-card[data-card-id="base1-58"][data-variant="normal"] >> .fx-label').textContent()) === 'Unlimited');
  const customT = page.locator('.tcg-card[data-variant="cracked-ice-holo"]');
  check('custom printing survives database rebuild with its image', (await customT.locator('img').getAttribute('src')).includes('cracked-ice-holo-low.webp'));
  const pikaFirstEd = page.locator('.tcg-card[data-card-id="base1-58"][data-variant="firstEdition"]');
  check('real variant scan used when present', (await pikaFirstEd.locator('img').getAttribute('src')).includes('firstEdition-low.webp'));
  check('real variant scan still banners its name (uniform labeling)', (await pikaFirstEd.locator('.fx-label').textContent()) === '1st Edition');

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

  // the printings bar always shows the master-set tally (incl. custom)
  check('master set counts printings incl. custom', (await page.textContent('.page-head .prog-row >> nth=1')).includes('3 / 8 printings'));

  // ---- Pokémon view ----
  await page.click('.bottomnav a[data-nav=pokemon]');
  await page.waitForSelector('.set-card');
  const speciesNames = await page.locator('.set-card .name').allTextContents();
  check('species list grouped by dex number', JSON.stringify(speciesNames) === JSON.stringify(['#006 Charizard', '#025 Pikachu', '#133 Eevee Star EX', '#162 Furret']));
  check('species tiles show a printings tally too',
    (await page.textContent('.set-card .count >> nth=0')).includes('printings') &&
    (await page.locator('.set-card >> nth=0 >> .progress').count()) === 2);
  await page.selectOption('.chips select', 'most-owned');
  check('species sortable by most owned', (await page.locator('.set-card .name >> nth=0').textContent()).includes('Charizard'));
  await page.selectOption('.chips select', 'least-owned');
  check('species sortable by least owned', (await page.locator('.set-card .name >> nth=0').textContent()).includes('Eevee'));
  await page.selectOption('.chips select', 'dex');
  check('charizard owned across sets', (await page.textContent('.set-card:has-text("Charizard") .count')).includes('1 / 2'));

  await page.click('.set-card:has-text("Charizard")');
  await page.waitForSelector('.tcg-card');
  check('charizard page: 4 printings across 2 sets, newest first',
    (await page.locator('.tcg-card').count()) === 4 &&
    (await page.locator('.tcg-card >> nth=0').getAttribute('data-card-id')) === 'swsh3-20');
  check('pokemon page progress', (await page.textContent('.page-head .muted')).trim() === '1 / 2 owned');
  check('pokemon page shows a printings bar too', (await page.textContent('.page-head .prog-row >> nth=1')).includes('printings'));
  await page.selectOption('.chips select', 'oldest');
  check('pokemon page sorts oldest-set first', (await page.locator('.tcg-card >> nth=0').getAttribute('data-card-id')) === 'base1-4');
  await page.selectOption('.chips select', 'newest');

  // ---- binders: create (fill from set), checklist, picker ----
  await page.goto('http://localhost:3111/#/binders');
  await page.waitForSelector('.binder-create');
  await page.fill('.binder-create input[type=text]', 'My Binder');
  await page.selectOption('.binder-create select >> nth=0', '2');       // 2×2 pockets
  await page.selectOption('.binder-create select >> nth=1', 'base1');   // fill from Base Set
  await page.click('.binder-create .swatch.b-green');
  await page.click('button:has-text("Create binder")');
  await page.waitForSelector('.binder-cover-page');                     // the binder opens on its COVER
  check('binder: cover shows first with the binder name', (await page.textContent('.binder-cover-page')).includes('My Binder'));
  check('binder: nav starts at Cover', (await page.textContent('#view')).includes('Cover'));
  await page.click('.binder-cover-page');                               // open the binder
  await page.waitForSelector('.binder-grid .pocket');
  check('binder: 2×2 page shows 4 pockets', (await page.locator('.binder-grid .pocket').count()) === 4);
  check('binder: fill-from-set filled page 1', (await page.locator('.binder-grid .pocket.filled').count()) === 4);
  check('binder: pockets carry the collection-style printing labels',
    (await page.locator('.binder-grid .pocket.filled .fx-label').count()) === 4);
  check('binder: 5 cards → 2 pages', (await page.textContent('#view')).includes('Page 1 of 2'));
  check('binder: starts with none in hand', (await page.textContent('#view')).includes('0 / 5 in hand'));
  await page.click('.binder-grid .pocket >> nth=0');                    // tap = "I have this one"
  await page.waitForSelector('.binder-grid .pocket.have');
  check('binder: tap marks a pocket as in hand', (await page.textContent('#view')).includes('1 / 5 in hand'));

  // view mode tracks copy counts: ⋯ on the in-hand pocket → ＋ → small ×2
  await page.click('.binder-grid .pocket.have .pocket-edit');
  await page.waitForSelector('.pocket-actions');
  await page.click('.pocket-actions button:has-text("＋")');
  await page.waitForSelector('.binder-grid .pocket.have .pocket-qty');
  check('binder: copy count shows as a small ×2 on the pocket',
    (await page.textContent('.binder-grid .pocket.have .pocket-qty')) === '×2');
  await page.click('.pocket-actions button:has-text("Close")');

  await page.click('button:has-text("›")');                             // page 2: 1 filled, 3 empty
  await page.waitForFunction(() => document.querySelectorAll('.binder-grid .pocket.filled').length === 1);

  // view mode is for tracking only — empty pockets are inert until you Edit
  await page.click('.binder-grid .pocket:not(.filled):not(.art) >> nth=0');
  await page.waitForTimeout(300);
  check('binder: view mode does not open the picker on empty pockets',
    (await page.locator('.picker-overlay').count()) === 0);
  await page.click('button:has-text("Edit binder")');
  await page.waitForSelector('button:has-text("✓ Done")');
  check('binder: edit mode unlocks the layout tools',
    (await page.locator('button:has-text("Size")').count()) === 1);

  await page.click('.binder-grid .pocket:not(.filled) >> nth=0');       // empty pocket → picker
  await page.waitForSelector('.picker-overlay input');
  await page.fill('.picker-overlay input', 'Pikachu');
  await page.waitForSelector('.picker-row .chip');
  check('binder picker shows the set NAME and card number, not the set code',
    (await page.textContent('.picker-row >> nth=0')).includes('Base Set · #58'));
  await page.click('.picker-row .chip >> nth=0');
  await page.waitForFunction(() => document.querySelectorAll('.binder-grid .pocket.filled').length === 2);
  check('binder: picker places a card into the chosen pocket', (await page.textContent('#view')).includes('1 / 6 in hand'));
  // proxy printing: missing-only sheet at real card size
  await page.evaluate(() => { window.print = () => { document.body.dataset.printed = '1'; }; });
  await page.click('button:has-text("Print proxies")');
  await page.waitForSelector('.picker-panel h3:has-text("Print proxies")');
  check('proxies: the framing option is gone', (await page.locator('.picker-panel .chip:has-text("Pokéball")').count()) === 0);
  await page.click('.picker-panel .btn:has-text("Print")');
  await page.waitForFunction(() => document.body.dataset.printed === '1');
  check('proxies: prints only the missing pockets (6 filled, 1 in hand → 5)',
    (await page.locator('#print-area .print-cell').count()) === 5);
  check('proxies: card images + text fallbacks for imageless cards',
    (await page.locator('#print-area .print-cell img').count()) === 3 &&
    (await page.locator('#print-area .print-fallback').count()) === 2);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  check('proxies: sheet cleans up after printing', (await page.locator('#print-area').count()) === 0);

  // a NON-primary printing gets the collection-style name banner on its proxy
  await page.click('.binder-grid .pocket:not(.filled) >> nth=0');       // empty pocket idx6
  await page.waitForSelector('.picker-overlay input[type=text]');
  await page.fill('.picker-overlay input[type=text]', 'Charizard');
  await page.waitForSelector('.picker-row .chip');
  await page.click('.picker-row .chip >> nth=1');                       // 1st Edition (no dedicated scan)
  await page.waitForFunction(() => document.querySelectorAll('.binder-grid .pocket.filled').length === 3);
  await page.evaluate(() => { delete document.body.dataset.printed; });
  await page.click('button:has-text("Print proxies")');
  await page.waitForSelector('.picker-panel h3:has-text("Print proxies")');
  await page.click('.picker-panel .btn:has-text("Print")');
  await page.waitForFunction(() => document.body.dataset.printed === '1');
  check('proxies: every card proxy carries its collection-style printing banner',
    (await page.locator('#print-area .print-fx').count()) === 6 &&
    (await page.locator('#print-area .print-fx').allTextContents()).some((t) => t.includes('1st Edition')));
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));

  // proxy sizes: a preset and a custom entry both drive the printed cell size
  await page.evaluate(() => { delete document.body.dataset.printed; });
  await page.click('button:has-text("Print proxies")');
  await page.waitForSelector('.picker-panel h3:has-text("Print proxies")');
  await page.click('.picker-panel .chip:has-text("Jumbo")');
  await page.click('.picker-panel .btn:has-text("Print")');
  await page.waitForFunction(() => document.body.dataset.printed === '1');
  check('proxies: Jumbo preset prints 89×127mm cells',
    await page.evaluate(() => [...document.head.querySelectorAll('style')].some((st) => st.textContent.includes('width: 89mm; height: 127mm'))));
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await page.evaluate(() => { delete document.body.dataset.printed; });
  await page.click('button:has-text("Print proxies")');
  await page.waitForSelector('.picker-panel h3:has-text("Print proxies")');
  await page.click('.picker-panel .chip:has-text("Custom")');
  // ratio lock: with 🔒 3:4 on, editing width drives height (75 → 100)
  await page.click('.picker-panel button:has-text("3:4")');
  await page.fill('.picker-panel input[type=number] >> nth=0', '75');
  check('proxies: ratio lock keeps the custom boxes at 3:4',
    (await page.locator('.picker-panel input[type=number] >> nth=1').inputValue()) === '100');
  await page.click('.picker-panel button:has-text("3:4")');   // unlock again
  await page.fill('.picker-panel input[type=number] >> nth=0', '70');
  await page.fill('.picker-panel input[type=number] >> nth=1', '95');
  await page.click('.picker-panel .btn:has-text("Print")');
  await page.waitForFunction(() => document.body.dataset.printed === '1');
  check('proxies: custom size prints exactly as entered',
    await page.evaluate(() => [...document.head.querySelectorAll('style')].some((st) => st.textContent.includes('width: 70mm; height: 95mm'))));
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  check('proxies: size style cleans up after printing',
    await page.evaluate(() => ![...document.head.querySelectorAll('style')].some((st) => st.textContent.includes('width: 70mm'))));
  // back to standard so nothing downstream inherits the custom choice
  await page.evaluate(() => localStorage.setItem('ptcg.proxy.size', 'std'));

  // drag & drop a card between pockets (idx4 -> empty idx7) — dispatch the
  // HTML5 drag events directly (headless mouse-drag doesn't start native DnD)
  await page.evaluate(() => {
    const src = document.querySelector('.pocket[data-pocket="4"]');
    const dst = document.querySelector('.pocket[data-pocket="7"]');
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  });
  await page.waitForSelector('.pocket[data-pocket="7"].filled');
  check('binder: drag & drop moves a card to an empty pocket',
    (await page.locator('.pocket[data-pocket="7"].filled').count()) === 1 &&
    (await page.locator('.pocket[data-pocket="4"].filled').count()) === 0);

  // upload an image and place it across chosen pockets via the editor.
  // adding a page turns this spread into [page 2 | page 3] — both sides visible
  await page.click('button:has-text("Add page")');
  await page.waitForSelector('.pocket[data-pocket="8"]');
  check('binder: desktop spread shows both sides of the sheet', (await page.textContent('#view')).includes('Pages 2\u20133 of 3'));
  await page.click('.pocket[data-pocket="8"]');
  await page.waitForSelector('.picker-overlay input[type=file]', { state: 'attached' });
  await page.setInputFiles('.picker-overlay input[type=file]', require('path').join(__dirname, 'fixtures', 'base1-4.png'));
  await page.waitForSelector('.art-editor .art-board img');
  check('binder: placement editor shows the page grid overlay', (await page.locator('.art-editor .art-cell').count()) === 4);
  check('binder: the tapped pocket starts selected', (await page.locator('.art-cell.sel').count()) === 1);
  await page.click('.art-cell[data-cell="9"]');                         // include a second pocket
  await page.waitForFunction(() => document.querySelectorAll('.art-cell.sel').length === 2);
  // exact numbers: type a position and the picture lands precisely there
  await page.fill('.art-editor input.num-x', '0');
  await page.fill('.art-editor input.num-y', '0');
  check('binder: typed X/Y place the picture exactly (0,0 → top-left corner)',
    (await page.locator('.art-editor .art-board img').getAttribute('style')).includes('left: 0px') &&
    (await page.locator('.art-editor .art-board img').getAttribute('style')).includes('top: 0px'));
  await page.click('button:has-text("Cut: with pocket spacing")');      // toggle cut mode
  await page.waitForSelector('button:has-text("Cut: without spacing")');
  await page.click('.art-editor button:has-text("Mirror X: off")');     // mirror it too
  await page.waitForSelector('.art-editor button:has-text("Mirror X: on")');
  await page.click('.art-editor button:has-text("Save")');
  await page.waitForFunction(() => {
    const els = [...document.querySelectorAll('.binder-grid .pocket.art .art-bg')];
    return els.length === 2 && els.every((el) => (el.style.backgroundImage || '').includes('/bimg/'));
  });
  check('binder: picture sliced across the chosen pockets (each piece its own slice)', true);
  check('binder: mirrored pieces render flipped',
    (await page.locator('.binder-grid .pocket.art .art-bg >> nth=0').getAttribute('style')).includes('scale(-1, 1)'));

  // print scope: "Missing only" narrows the CARDS and never drops your pictures,
  // and either half can be printed on its own
  await page.evaluate(() => { delete document.body.dataset.printed; });
  await page.click('button:has-text("Print proxies")');
  await page.waitForSelector('.picker-panel h3:has-text("Print proxies")');
  await page.click('.picker-panel .btn:has-text("Print")');
  await page.waitForFunction(() => document.body.dataset.printed === '1');
  check('proxies: missing-only still prints the pictures you placed (6 cards + 2 art)',
    (await page.locator('#print-area .print-cell').count()) === 8 &&
    (await page.locator('#print-area .print-cell.print-art').count()) === 2);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));

  await page.evaluate(() => { delete document.body.dataset.printed; });
  await page.click('button:has-text("Print proxies")');
  await page.waitForSelector('.picker-panel h3:has-text("Print proxies")');
  await page.click('.picker-panel .chip:has-text("Pictures only")');
  check('proxies: Pictures only hides the missing/all card filter',
    await page.evaluate(() => [...document.querySelectorAll('.picker-panel .row')]
      .some((r) => r.textContent.includes('Missing only') && r.style.display === 'none')));
  await page.click('.picker-panel .btn:has-text("Print")');
  await page.waitForFunction(() => document.body.dataset.printed === '1');
  check('proxies: Pictures only prints just the art pieces',
    (await page.locator('#print-area .print-cell').count()) === 2 &&
    (await page.locator('#print-area .print-cell.print-art').count()) === 2);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));

  await page.evaluate(() => { delete document.body.dataset.printed; });
  await page.click('button:has-text("Print proxies")');
  await page.waitForSelector('.picker-panel h3:has-text("Print proxies")');
  await page.click('.picker-panel .chip:has-text("Cards only")');
  await page.click('.picker-panel .btn:has-text("Print")');
  await page.waitForFunction(() => document.body.dataset.printed === '1');
  check('proxies: Cards only leaves the pictures out',
    (await page.locator('#print-area .print-cell').count()) === 6 &&
    (await page.locator('#print-area .print-cell.print-art').count()) === 0);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await page.evaluate(() => localStorage.setItem('ptcg.proxy.include', 'both'));

  // own cover picture: upload → place it with the drag/resize editor
  await page.click('button:has-text("Cover")');
  await page.waitForSelector('.picker-panel h3:has-text("Binder cover")');
  await page.click('.picker-panel .chip:has-text("My image")');
  await page.waitForSelector('.picker-overlay input[type=file]', { state: 'attached' });
  await page.setInputFiles('.picker-overlay input[type=file]', require('path').join(__dirname, 'fixtures', 'base1-4.png'));
  await page.waitForSelector('.cover-adjust .art-board img');
  check('binder: cover picture opens the placement editor', true);
  check('binder: cover editor shows exact X/Y/Size fields',
    (await page.locator('.cover-adjust input.num-x').count()) === 1 &&
    (await page.locator('.cover-adjust input.num-s').inputValue()) !== '');
  await page.click('.cover-adjust button:has-text("Mirror Y: off")');
  await page.waitForSelector('.cover-adjust button:has-text("Mirror Y: on")');
  await page.click('.cover-adjust button:has-text("Save")');
  await page.waitForFunction(() => {
    const el = document.querySelector('.binder-cover-page .art-bg');
    return el && (el.style.backgroundImage || '').includes('/bimg/');
  });
  check('binder: adjusted cover picture painted on the cover page', true);
  check('binder: mirrored cover renders flipped',
    (await page.locator('.binder-cover-page .art-bg').getAttribute('style')).includes('scale(1, -1)'));

  // pick a set logo as the binder cover
  await page.click('button:has-text("Cover")');
  await page.waitForSelector('.picker-row:has-text("Base Set")');
  await page.click('.picker-row:has-text("Base Set")');
  await page.waitForSelector('.binder-cover-page img.cover-logo');
  check('binder: set-logo cover applied and shown on the cover page', true);

  // resize 2×2 → 3×3: cards keep their page + row/column, counts survive
  await page.click('button:has-text("Size")');
  await page.waitForSelector('.picker-panel h3:has-text("Binder size")');
  await page.click('.picker-panel .chip:has-text("3×3")');
  await page.waitForFunction(() => (document.querySelector('#view').textContent || '').includes('3×3'));
  check('binder: resize keeps the in-hand tally', (await page.textContent('#view')).includes('1 / 7 in hand'));
  await page.click('.binder-cover-page');                               // open page 1 in the new size
  await page.waitForSelector('.binder-grid .pocket');
  check('binder: resized page shows 9 pockets', (await page.locator('.binder-grid .pocket').count()) === 9);
  check('binder: cards kept their row/column (4 filled, top row + start of row 2)',
    (await page.locator('.binder-grid .pocket.filled').count()) === 4 &&
    (await page.locator('.pocket[data-pocket="0"].filled').count()) === 1 &&
    (await page.locator('.pocket[data-pocket="3"].filled').count()) === 1 &&
    (await page.locator('.pocket[data-pocket="2"].filled').count()) === 0);
  check('binder: the ×2 copy count survived the resize',
    (await page.textContent('.pocket[data-pocket="0"] .pocket-qty')) === '×2');

  await page.goto('http://localhost:3111/#/binders');
  await page.waitForSelector('.binder-cover');
  check('binder: cover shows live progress (art not counted)', (await page.textContent('.binder-cover')).includes('1 / 7 in hand'));
  check('binder: list cover carries the chosen image', (await page.locator('.binder-cover .binder-cover-img').count()) === 1);

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
  await page.waitForFunction(() => document.getElementById('view').textContent.includes('Cards in database'));
  // the endpoint probes render asynchronously after the stats line — wait for them
  await page.waitForFunction(() => (document.getElementById('view').textContent.match(/OK \(200\)/g) || []).length >= 3);
  const debugText = await page.textContent('#view');
  check('debug probes all green', (debugText.match(/OK \(200\)/g) || []).length >= 3);
  check('debug reports cards in the database', /Cards in database/.test(debugText) && !/Cards in database\D*\b0\b/.test(debugText));
  await page.goto('http://localhost:3111/');
  await page.waitForSelector('.set-card');

  // ---- variant-aware sync (using the account signed in at the start) ----
  await page.waitForTimeout(2500); // debounce push
  const remote = await page.evaluate(async () => {
    const auth = JSON.parse(localStorage.getItem('ptcg.auth'));
    const r = await fetch('api/collection', { headers: { Authorization: 'Bearer ' + auth.token } });
    return r.json();
  });
  check('per-printing collection synced to server',
    remote.collection && remote.collection['base1-4'] && remote.collection['base1-4'].holo === 2 &&
    remote.collection['base1-4'].firstEdition === 1 && remote.collection['base1-58'].normal === 2);

  // this user is NOT the first account (bootstrap test registered the admin)
  await page.click('#account-btn');
  await page.waitForSelector('#account-modal[open]');
  await page.waitForTimeout(800); // admin area renders async
  check('non-admin sees no Administration section', (await page.locator('#admin-area button').count()) === 0);
  await page.keyboard.press('Escape');

  // ---- card data comes from the server's database (not R2/static JSON) ----
  await page.goto('http://localhost:3111/#/set/base1');
  await page.waitForSelector('.tcg-card img');
  const usedCatalogApi = await page.evaluate(() =>
    performance.getEntriesByType('resource').some((r) => r.name.includes('/api/catalog/')));
  check('app loads the catalog from the server database API', usedCatalogApi === true);

  // ---- spinning-pokeball image loader ----
  {
    const slowCtx = await browser.newContext({ serviceWorkers: 'block' });
    const slowPage = await slowCtx.newPage();
    await slowPage.route('**/*.webp', async (route) => {
      await new Promise((r) => setTimeout(r, 600)); // simulate a slow CDN
      await route.continue();
    });
    await slowPage.goto('http://localhost:3111/#/set/base1');
    await slowPage.waitForSelector('.tcg-card img');
    check('pokeball spinner shows while card images load',
      (await slowPage.locator('.tcg-card.img-loading').count()) > 0);
    await slowPage.waitForFunction(() => {
      const t = document.querySelector('.tcg-card');
      return t && !t.classList.contains('img-loading');
    });
    check('pokeball spinner clears once the image arrives', true);
    await slowCtx.close();
  }

  // ---- copied files with no server behind them → the app does nothing ----
  {
    const gctx = await browser.newContext({ serviceWorkers: 'block' });
    const gp = await gctx.newPage();
    await gp.route('**/api/**', (r) => r.abort()); // simulate: no server at all
    await gp.goto('http://localhost:3111/');
    await gp.waitForSelector('h2:has-text("Server required")');
    check('no-server copy is gated (server required)', (await gp.locator('.set-card').count()) === 0);
    await gctx.close();
  }

  console.log(errors.length ? 'JS ERRORS:\n' + errors.join('\n') : 'No JS errors, zero external requests.');
  await browser.close();
  if (failCount) console.log(failCount + ' check(s) FAILED');
  process.exit(errors.length || failCount ? 1 : 0);
})();
