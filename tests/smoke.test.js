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
  /** the binder-create fill picker: open it, type, take the named hit */
  const pickFill = async (pg, query, label) => {
    await pg.click('.binder-create [data-fill]');
    await pg.waitForSelector('.picker-panel h3:has-text("Fill the binder with")');
    await pg.fill('.picker-overlay input[type=text]', query);
    await pg.click(`.picker-overlay .picker-row:has-text("${label}") >> nth=0`);
    await pg.waitForSelector('.picker-overlay', { state: 'detached' });
  };
  /** say yes to the app's own are-you-sure panel */
  const confirmYes = async (pg) => {
    await pg.waitForSelector('.confirm-panel');
    await pg.click('.confirm-panel .btn.danger');
    await pg.waitForSelector('.confirm-panel', { state: 'detached' });
  };

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
  // the binder's set + number strip, now on every card everywhere
  check('set page tiles carry the set + number caption',
    (await page.locator('.tcg-card .card-cap').count()) === 8 &&
    (await page.textContent('.tcg-card .card-cap .cap-set >> nth=0')) === 'Base Set' &&
    /#\d+/.test(await page.textContent('.tcg-card .card-cap .cap-no >> nth=0')));

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
  // a Pokémon page mixes sets, so the caption is the only thing telling them apart
  check('pokemon page tiles name their set, and the sets differ',
    (await page.locator('.tcg-card .card-cap').count()) === 4 &&
    new Set(await page.locator('.tcg-card .card-cap .cap-set').allTextContents()).size === 2);
  check('pokemon page shows a printings bar too', (await page.textContent('.page-head .prog-row >> nth=1')).includes('printings'));
  await page.selectOption('.chips select', 'oldest');
  check('pokemon page sorts oldest-set first', (await page.locator('.tcg-card >> nth=0').getAttribute('data-card-id')) === 'base1-4');
  await page.selectOption('.chips select', 'newest');

  // ---- binders: create (fill from set), checklist, picker ----
  await page.goto('http://localhost:3111/#/binders');
  await page.waitForSelector('.binder-create');
  await page.fill('.binder-create input[type=text]', 'My Binder');
  await page.selectOption('.binder-create select >> nth=0', '2');       // 2×2 pockets
  check('binder: the fill picker starts on "Start empty"',
    (await page.textContent('.binder-create [data-fill]')) === 'Start empty');
  await pickFill(page, 'base set', 'Base Set');                        // fill from Base Set
  check('binder: the picker reports what it will fill from',
    (await page.textContent('.binder-create [data-fill]')) === 'Fill from: Base Set');
  check('binder: the New binder form offers no-color as a swatch of its own',
    (await page.locator('.binder-create .swatch.b-none').count()) === 1 &&
    (await page.locator('.binder-create .swatch').count()) === 6);
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
  check('binder: every card pocket is captioned with its set name and number',
    (await page.locator('.binder-grid .pocket.filled .pocket-cap').count()) === 4 &&
    (await page.textContent('.binder-grid .pocket.filled .pocket-cap >> nth=0')).includes('Base Set') &&
    /#\d+/.test(await page.textContent('.binder-grid .pocket.filled .pocket-cap .cap-no >> nth=0')));
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
  check('proxies: printed cards carry the same set + number caption',
    (await page.locator('#print-area .print-cap').count()) === 3 &&      // the text fallbacks already say it in their body
    (await page.textContent('#print-area .print-cap >> nth=0')).includes('Base Set') &&
    /#\d+/.test(await page.textContent('#print-area .print-cap .cap-no >> nth=0')));
  // butted by default: neighbours share one cut line, so you cut once per seam
  check('proxies: no gap between cards unless you ask for one',
    await page.evaluate(() => [...document.head.querySelectorAll('style')].some((st) => /#print-area \{ gap: 0mm; \}/.test(st.textContent))));
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
  await page.click('.picker-panel .chip:has-text("Custom") >> nth=0');   // nth=0: Spacing has a Custom… too
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

  // spacing: a preset and a custom millimetre entry both drive the page gap
  await page.evaluate(() => { delete document.body.dataset.printed; });
  await page.click('button:has-text("Print proxies")');
  await page.waitForSelector('.picker-panel h3:has-text("Print proxies")');
  await page.click('.picker-panel .chip:has-text("2 mm")');
  await page.click('.picker-panel .btn:has-text("Print")');
  await page.waitForFunction(() => document.body.dataset.printed === '1');
  check('proxies: a chosen spacing preset lands on the sheet',
    await page.evaluate(() => [...document.head.querySelectorAll('style')].some((st) => /#print-area \{ gap: 2mm; \}/.test(st.textContent))));
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await page.evaluate(() => { delete document.body.dataset.printed; });
  await page.click('button:has-text("Print proxies")');
  await page.waitForSelector('.picker-panel h3:has-text("Print proxies")');
  // the Spacing row's Custom… is the second one in the panel (Size owns the first)
  await page.click('.picker-panel .chip:has-text("Custom") >> nth=1');
  check('proxies: choosing Custom spacing reveals the mm box',
    await page.isVisible('.picker-panel input[type=number] >> nth=2'));
  await page.fill('.picker-panel input[type=number] >> nth=2', '1.5');
  await page.click('.picker-panel .btn:has-text("Print")');
  await page.waitForFunction(() => document.body.dataset.printed === '1');
  check('proxies: custom spacing prints exactly as entered',
    await page.evaluate(() => [...document.head.querySelectorAll('style')].some((st) => /#print-area \{ gap: 1\.5mm; \}/.test(st.textContent))));
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  // and back to butted, so nothing downstream inherits the spacing choice
  await page.evaluate(() => localStorage.setItem('ptcg.proxy.gap', '0'));

  // caption: the set + number strip is optional on the printed sheet
  await page.evaluate(() => { delete document.body.dataset.printed; });
  await page.click('button:has-text("Print proxies")');
  await page.waitForSelector('.picker-panel h3:has-text("Print proxies")');
  await page.click('.picker-panel .chip:has-text("None") >> nth=1');   // nth=0 is Spacing's None
  await page.click('.picker-panel .btn:has-text("Print")');
  await page.waitForFunction(() => document.body.dataset.printed === '1');
  check('proxies: turning the caption off strips it from every printed card',
    (await page.locator('#print-area .print-cap').count()) === 0 &&
    (await page.locator('#print-area .print-cell').count()) > 0);
  // the imageless fallback still names its set — nothing else identifies it
  check('proxies: imageless proxies still say what they are without the caption',
    (await page.textContent('#print-area .pf-meta >> nth=0')).includes('Base Set'));
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await page.evaluate(() => { delete document.body.dataset.printed; });
  await page.click('button:has-text("Print proxies")');
  await page.waitForSelector('.picker-panel h3:has-text("Print proxies")');
  check('proxies: the caption choice is remembered next time', await page.evaluate(() =>
    [...document.querySelectorAll('.picker-panel .chip.active')].some((c) => c.textContent === 'None' &&
      c.parentElement.textContent.startsWith('Caption'))));
  await page.click('.picker-panel .chip:has-text("Set + number")');
  await page.click('.picker-panel .btn:has-text("Print")');
  await page.waitForFunction(() => document.body.dataset.printed === '1');
  check('proxies: turning it back on captions every pictured card',
    (await page.locator('#print-area .print-cap').count()) ===
    (await page.locator('#print-area .print-cell img').count()));
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));

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

  // ---- the front holds ONE thing: color is a cover choice, and it can be off ----
  const headBtnText = async () => (await page.locator('#view .row .btn').allTextContents()).join(' | ');
  check('binder: the standalone color button is gone from the toolbar',
    !(await headBtnText()).includes('Color'));
  await page.click('button:has-text("Cover")');
  await page.waitForSelector('.picker-panel h3:has-text("Binder cover")');
  check('binder: the cover panel opens on what the binder is already wearing',
    (await page.locator('.picker-panel .picker-row:has-text("Base Set")').count()) > 0);
  await page.click('.picker-panel .chip:has-text("Color")');
  await page.waitForSelector('.swatch-pick');
  check('binder: color is one of the cover choices, no-color among them',
    (await page.locator('.swatch-pick').count()) === 6 &&
    (await page.locator('.swatch-pick[data-color=none]').count()) === 1 &&
    (await page.textContent('.swatch-pick[data-color=none]')).includes('No color'));
  // a color takes the whole front, so the picture on it has to go — and is asked about
  await page.click('.swatch-pick[data-color=green]');
  await page.waitForSelector('.confirm-panel');
  check('binder: swapping a picture for a color warns that the picture comes off',
    /picture on it now comes off/i.test(await page.textContent('.confirm-panel')));
  await page.click('.confirm-panel .btn.ghost');
  await page.waitForSelector('.confirm-panel', { state: 'detached' });
  check('binder: cancelling keeps the picture on the front',
    (await page.locator('.binder-cover-page .art-bg').count()) === 1);
  await page.click('.swatch-pick[data-color=green]');
  await confirmYes(page);
  await page.waitForSelector('.binder-cover-page.b-green');
  check('binder: a color on the front replaces the picture',
    (await page.locator('.binder-cover-page .art-bg').count()) === 0 &&
    (await page.locator('.binder-cover-page img').count()) === 0);
  check('binder: the header dot follows the color', (await page.locator('.page-head .binder-dot.b-green').count()) === 1);
  await page.click('button:has-text("Cover")');
  await page.waitForSelector('.swatch-pick');
  check('binder: with no picture the panel opens on Color, showing the current one',
    (await page.locator('.swatch-pick .swatch.b-green.active').count()) === 1);
  await page.click('.swatch-pick[data-color=none]');                    // nothing to discard: no confirm
  await page.waitForSelector('.binder-cover-page.b-none');
  check('binder: the color can be turned off altogether',
    (await page.locator('.page-head .binder-dot.b-none').count()) === 1 &&
    (await page.locator('.binder-cover-page img').count()) === 0);

  // pick a set logo as the binder cover
  await page.click('button:has-text("Cover")');
  await page.click('.picker-panel .chip:has-text("Set logo")');
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

  // ---- select to print: hand-pick pockets across pages, print just those ----
  await page.click('button:has-text("Done")');                           // leave edit mode
  await page.waitForSelector('button:has-text("Select to print")');
  await page.click('button:has-text("Select to print")');
  await page.waitForSelector('.pick-bar');
  check('binder: picking starts empty and takes over the pockets',
    (await page.textContent('.pick-bar')).includes('Nothing selected') &&
    (await page.locator('.binder-grid .pocket-edit').count()) === 0);
  // pocket 0 is the ×2 in-hand card — "Missing only" would never print it
  await page.click('.pocket[data-pocket="0"]');
  await page.waitForSelector('.pocket[data-pocket="0"].picked');
  check('binder: tapping a pocket picks it and leaves what’s in hand alone',
    (await page.locator('.pick-badge').count()) === 1 &&
    (await page.textContent('#view')).includes('1 / 7 in hand'));
  await page.click('button:has-text("›")');                             // pages 2–3
  await page.waitForFunction(() => (document.querySelector('#view').textContent || '').includes('Pages 2–3 of 3'));
  await page.waitForFunction(() => !document.querySelector('.flip-sheet'));
  check('binder: the selection survives a page turn',
    (await page.textContent('.pick-bar')).includes('1 selected'));
  await page.click('.pocket[data-pocket="10"]');                        // a card on page 2
  await page.waitForSelector('.pocket[data-pocket="10"].picked');
  await page.click('.pocket[data-pocket="18"]');                        // a slice of the picture on page 3
  await page.waitForFunction(() => document.querySelectorAll('.pocket.art.picked').length === 2);
  check('binder: picking any slice takes the whole picture, across pages',
    (await page.textContent('.pick-bar')).includes('3 selected'));
  await page.evaluate(() => { delete document.body.dataset.printed; });
  await page.click('.pick-bar button:has-text("Print selected")');
  await page.waitForSelector('.picker-panel h3:has-text("Print selected proxies")');
  check('proxies: an explicit selection drops the scope choices',
    (await page.locator('.picker-panel .chip:has-text("Missing only")').count()) === 0 &&
    (await page.locator('.picker-panel .chip:has-text("Cards only")').count()) === 0);
  await page.click('.picker-panel .btn:has-text("Print")');
  await page.waitForFunction(() => document.body.dataset.printed === '1');
  check('proxies: selected pockets print together — an in-hand card included (2 cards + 2 art)',
    (await page.locator('#print-area .print-cell').count()) === 4 &&
    (await page.locator('#print-area .print-cell.print-art').count()) === 2);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  check('proxies: printing clears the selection for the next batch',
    (await page.textContent('.pick-bar')).includes('Nothing selected') &&
    (await page.locator('.pocket.picked').count()) === 0);
  await page.click('.pick-bar button:has-text("Done")');
  await page.waitForFunction(() => !document.querySelector('.pick-bar'));
  check('binder: leaving pick mode gives the pockets back',
    (await page.locator('.binder-grid .pocket-edit').count()) > 0 &&
    (await page.locator('button:has-text("Select to print")').count()) === 1);

  await page.goto('http://localhost:3111/#/binders');
  await page.waitForSelector('.binder-cover');
  check('binder: cover shows live progress (art not counted)', (await page.textContent('.binder-cover')).includes('1 / 7 in hand'));
  check('binder: list cover carries the chosen image', (await page.locator('.binder-cover .binder-cover-img').count()) === 1);

  // ---- removing pages: ⊟ pulls a whole sheet, later pages slide forward ----
  await page.click('.binder-cover');
  await page.waitForSelector('.binder-cover-page');
  await page.click('.binder-cover-page');
  await page.waitForSelector('.binder-grid .pocket');
  check('binder: view mode shows no page-remove buttons', (await page.locator('.page-remove').count()) === 0);
  await page.click('button:has-text("Edit binder")');
  await page.waitForSelector('.page-remove');
  await page.click('button:has-text("›")');                             // pages 2–3
  await page.waitForFunction(() => (document.querySelector('#view').textContent || '').includes('Pages 2–3 of 3'));
  await page.waitForFunction(() => !document.querySelector('.flip-sheet'));   // let the turn finish

  // ---- jumping to either end of the binder ----
  check('binder: nav carries first/prev/next/last around the label',
    (await page.locator('.binder-nav button').count()) === 4 &&
    (await page.getAttribute('.binder-nav button >> nth=0', 'aria-label')) === 'First page' &&
    (await page.getAttribute('.binder-nav button >> nth=3', 'aria-label')) === 'Last page');
  check('binder: on the last spread, the forward jumps are greyed out',
    (await page.locator('.binder-nav button[disabled] >> nth=0').getAttribute('aria-label')) === 'Next page' &&
    (await page.locator('.binder-nav button[disabled]').count()) === 2);
  await page.click('.binder-nav button[aria-label="First page"]');
  await page.waitForFunction(() => (document.querySelector('#view').textContent || '').includes('Cover'));
  check('binder: « goes straight to the cover from anywhere', true);
  check('binder: at the cover it is the backward jumps that are greyed out',
    (await page.locator('.binder-nav button[disabled]').count()) === 2 &&
    (await page.locator('.binder-nav button[disabled] >> nth=0').getAttribute('aria-label')) === 'First page');
  await page.click('.binder-nav button[aria-label="Last page"]');
  await page.waitForFunction(() => (document.querySelector('#view').textContent || '').includes('Pages 2–3 of 3'));
  await page.waitForFunction(() => !document.querySelector('.flip-sheet'));
  check('binder: » goes straight to the far end', true);

  check('binder: every visible page gets its own remove button, named in words',
    (await page.locator('.page-remove').count()) === 2 &&
    (await page.textContent('.page-remove[data-page="2"]')).includes('Remove page 3'));
  await page.click('.page-remove[data-page="2"]');
  check('binder: removing a page says what is on it before it goes',
    (await page.textContent('.confirm-panel')).includes('Pull page 3 out') &&
    /1 picture/.test(await page.textContent('.confirm-panel')));
  await page.click('.confirm-panel .btn.ghost');                        // …and backing out changes nothing
  await page.waitForSelector('.confirm-panel', { state: 'detached' });
  check('binder: cancelling the confirmation keeps the page',
    (await page.textContent('#view')).includes('of 3'));
  await page.click('.page-remove[data-page="2"]');
  await confirmYes(page);
  await page.waitForFunction(() => (document.querySelector('#view').textContent || '').includes('of 2'));
  check('binder: removing a page takes its contents out with it',
    (await page.locator('.binder-grid .pocket.art').count()) === 0 &&
    (await page.textContent('#view')).includes('1 / 7 in hand'));

  await page.click('button:has-text("‹")');
  await page.waitForFunction(() => (document.querySelector('#view').textContent || '').includes('Page 1 of 2'));
  await page.click('.page-remove[data-page="0"]');
  await confirmYes(page);
  await page.waitForFunction(() => (document.querySelector('#view').textContent || '').includes('of 1'));
  check('binder: later pages slide forward onto the removed sheet',
    (await page.locator('.binder-grid .pocket.filled').count()) === 3 &&
    (await page.locator('.pocket[data-pocket="1"].filled').count()) === 1 &&
    (await page.locator('.pocket[data-pocket="4"].filled').count()) === 1 &&
    (await page.locator('.pocket[data-pocket="0"].filled').count()) === 0);
  check('binder: the removed sheet’s cards left the binder (7 → 3)',
    (await page.textContent('#view')).includes('0 / 3 in hand'));
  await page.click('.page-remove[data-page="0"]');                      // the last sheet is refused
  await page.waitForTimeout(250);
  check('binder: a binder always keeps at least one page',
    (await page.textContent('#view')).includes('of 1') && (await page.locator('.binder-grid').count()) === 1);

  // ---- a binder filled from one Pokémon, then deleted on purpose ----
  await page.goto('http://localhost:3111/#/binders');
  await page.waitForSelector('.binder-create');
  await page.fill('.binder-create input[type=text]', 'Charizards');
  await page.selectOption('.binder-create select >> nth=0', '2');
  await page.click('.binder-create [data-fill]');
  await page.waitForSelector('.picker-panel h3:has-text("Fill the binder with")');
  const allFillRows = await page.locator('.picker-overlay .picker-row').count();
  await page.fill('.picker-overlay input[type=text]', 'chariz');
  await page.waitForFunction(() => document.querySelectorAll('.picker-overlay .picker-row').length < 6);
  check('binder: the fill box filters the long list down to what you typed',
    allFillRows > 3 && (await page.locator('.picker-overlay .picker-row').count()) < allFillRows &&
    (await page.textContent('.picker-overlay .picker-row >> nth=0')).includes('Charizard'));
  check('binder: species entries say they are Pokémon, and how many cards',
    /Pok[ée]mon #006/.test(await page.textContent('.picker-overlay .picker-row:has-text("Charizard") >> nth=0')));
  await page.click('.picker-overlay .picker-row:has-text("Charizard") >> nth=0');
  await page.waitForSelector('.picker-overlay', { state: 'detached' });
  await page.click('button:has-text("Create binder")');
  await page.waitForSelector('.binder-cover-page');
  await page.click('.binder-cover-page');
  await page.waitForSelector('.binder-grid .pocket.filled');
  check('binder: filling from a Pokémon gathers its printings across sets',
    (await page.locator('.binder-grid .pocket.filled').count()) === 2 &&
    new Set(await page.locator('.pocket.filled .pocket-cap .cap-set').allTextContents()).size === 2);

  await page.click('button:has-text("Edit binder")');
  await page.waitForSelector('.page-remove');
  await page.click('button:has-text("Delete")');
  await page.waitForSelector('.confirm-panel');
  check('binder: deleting one names it and says the collection is safe',
    (await page.textContent('.confirm-panel')).includes('"Charizards"') &&
    (await page.textContent('.confirm-panel')).includes('collection counts are not touched'));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.confirm-panel', { state: 'detached' });
  check('binder: Escape means no — the binder is still open', (await page.locator('.binder-book').count()) === 1);
  await page.click('button:has-text("Delete")');
  await confirmYes(page);
  await page.waitForSelector('.binder-create');
  check('binder: confirming really does delete it',
    !(await page.textContent('#view')).includes('Charizards'));

  // ---- emptying a pocket asks first ----
  await page.goto('http://localhost:3111/#/binders');
  await page.click('.binder-cover');
  await page.waitForSelector('.binder-cover-page');
  await page.click('.binder-cover-page');
  await page.waitForSelector('.binder-grid .pocket.filled');
  await page.click('button:has-text("Edit binder")');
  await page.waitForSelector('.pocket.filled .pocket-edit');
  const beforeEmpty = await page.locator('.binder-grid .pocket.filled').count();
  await page.click('.pocket.filled .pocket-edit >> nth=0');
  await page.click('.pocket-actions button:has-text("Remove")');
  await page.waitForSelector('.confirm-panel');
  check('binder: emptying a pocket says which card and that counts are safe',
    (await page.textContent('.confirm-panel')).includes('Empty pocket') &&
    (await page.textContent('.confirm-panel')).includes('How many you own does not change'));
  await page.click('.confirm-panel .btn.ghost');
  await page.waitForSelector('.confirm-panel', { state: 'detached' });
  check('binder: backing out leaves the pocket alone',
    (await page.locator('.binder-grid .pocket.filled').count()) === beforeEmpty);
  await page.click('.pocket-actions button:has-text("Remove")');
  await confirmYes(page);
  await page.waitForFunction((n) => document.querySelectorAll('.binder-grid .pocket.filled').length === n - 1, beforeEmpty);
  check('binder: confirming empties it', true);
  await page.click('button:has-text("Done")');

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

  // ---- a dropped image request is retried, not written off ----
  // the phone bug: one failed fetch used to replace the tile with the grey
  // placeholder for good, so a moment's bad signal left a wall of 🃏
  {
    const flakyCtx = await browser.newContext({ serviceWorkers: 'block' });
    const flakyPage = await flakyCtx.newPage();
    const failed = new Set();
    await flakyPage.route('**/*.webp', async (route) => {
      const url = route.request().url();
      if (!failed.has(url)) { failed.add(url); await route.abort('failed'); return; }
      await route.continue();   // second time's the charm, as a flaky link would be
    });
    await flakyPage.goto('http://localhost:3111/#/set/base1');
    await flakyPage.waitForSelector('.tcg-card');
    check('a dropped image request is actually seen as dropped', failed.size > 0);
    await flakyPage.waitForFunction(() => {
      const imgs = [...document.querySelectorAll('.tcg-card img')];
      return imgs.length >= 6 && imgs.every((i) => i.complete && i.naturalWidth > 0);
    }, null, { timeout: 15000 });
    check('every picture comes back after a failed first attempt', true);
    check('no tile got stuck on the grey placeholder',
      (await flakyPage.locator('.tcg-card .noimg').count()) === 2);   // the two genuinely imageless cards
    await flakyCtx.close();
  }

  // ---- a picture that never arrives leaves a placeholder you can tap ----
  {
    const deadCtx = await browser.newContext({ serviceWorkers: 'block' });
    const deadPage = await deadCtx.newPage();
    let allow = false;
    await deadPage.route('**/*.webp', async (route) => {
      if (allow) { await route.continue(); return; }
      await route.abort('failed');
    });
    await deadPage.goto('http://localhost:3111/#/set/base1');
    await deadPage.waitForSelector('.tcg-card .noimg.stalled', { timeout: 20000 });
    check('a picture that never lands falls back to a tappable placeholder',
      (await deadPage.locator('.tcg-card .noimg.stalled').count()) > 0);
    allow = true;
    await deadPage.click('.tcg-card .noimg.stalled >> nth=0');
    await deadPage.waitForFunction(() => {
      const i = document.querySelector('.tcg-card img');
      return i && i.complete && i.naturalWidth > 0;
    }, null, { timeout: 15000 });
    check('tapping the placeholder loads the picture', true);
    await deadCtx.close();
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

  // ---- signing in closes the modal it was asked for ----
  {
    const actx = await browser.newContext({ serviceWorkers: 'block' });
    const ap = await actx.newPage();
    await ap.goto('http://localhost:3111/');
    await ap.waitForSelector('.set-card');
    await ap.click('#account-btn');
    await ap.waitForSelector('#account-modal[open]');
    await ap.click('#account-modal .tabs button:has-text("Create account")');
    await ap.fill('#ptcg-username', 'smokelogin' + Math.floor(Math.random() * 1e6));
    await ap.fill('#ptcg-password', 'password123');
    await ap.click('#account-modal form .btn');
    await ap.waitForFunction(() => !document.getElementById('account-modal').open, null, { timeout: 8000 })
      .catch(() => {});
    check('sign-in closes the account modal', (await ap.locator('#account-modal[open]').count()) === 0);
    // route() repaints after the sync round-trip, so give the banner a moment
    await ap.waitForSelector('#stats-banner', { timeout: 8000 }).catch(() => {});
    check('sign-in still switches the app into tracking mode', (await ap.locator('#stats-banner').count()) === 1);
    await ap.click('#account-btn');
    await ap.waitForSelector('#account-modal[open]');
    check('reopening the modal shows the signed-in panel',
      (await ap.textContent('#account-modal')).includes('Sign out'));
    await actx.close();
  }

  // ---- editing a card from a binder leaves the binder exactly where it was ----
  {
    const ectx = await browser.newContext({ serviceWorkers: 'block' });
    const ep = await ectx.newPage();
    await ep.goto('http://localhost:3111/');
    await ep.evaluate(async () => {
      const r = await fetch('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ptcgadmin', password: 'password123' }) });
      const d = await r.json();
      localStorage.setItem('ptcg.auth', JSON.stringify({ token: d.token, username: d.username }));
    });
    await ep.reload();                                                  // the app reads the token at start-up
    await ep.waitForSelector('.set-card');
    await ep.goto('http://localhost:3111/#/binders');
    await ep.waitForSelector('.binder-create');
    await ep.fill('.binder-create input[type=text]', 'Admin Binder');
    await ep.selectOption('.binder-create select >> nth=0', '2');       // 2×2 → base1's 5 cards need 2 pages
    await pickFill(ep, 'base set', 'Base Set');
    await ep.click('button:has-text("Create binder")');
    await ep.waitForSelector('.binder-cover-page');
    await ep.click('.binder-cover-page');
    await ep.waitForSelector('.binder-grid .pocket');
    await ep.click('button:has-text("Edit binder")');
    await ep.waitForSelector('.page-remove');
    await ep.click('button:has-text("›")');                            // move off page 1
    await ep.waitForFunction(() => (document.querySelector('#view').textContent || '').includes('Page 2 of 2'));
    await ep.waitForFunction(() => !document.querySelector('.flip-sheet'));
    await ep.click('.binder-grid .pocket.filled .pocket-edit >> nth=0');
    await ep.waitForSelector('.pocket-actions');
    await ep.click('.pocket-actions button:has-text("Details")');
    await ep.waitForSelector('#card-modal[open] button:has-text("Add printing")');
    const printing = 'Smoke Keepstate';
    ep.once('dialog', (d) => d.accept(printing));
    await ep.click('#card-modal button:has-text("Add printing")');
    await ep.waitForSelector(`#card-modal .chip:has-text("${printing}")`);
    check('binder: adding a printing keeps edit mode on',
      (await ep.locator('.page-remove').count()) > 0);
    check('binder: adding a printing does not slam the book shut',
      (await ep.textContent('#view')).includes('Page 2 of 2'));
    await ep.evaluate(() => document.getElementById('card-modal').close());
    check('binder: the pages are still there once the modal closes',
      (await ep.locator('.binder-grid .pocket.filled').count()) > 0 &&
      (await ep.locator('.page-remove').count()) > 0);
    await ectx.close();
  }

  // ---- phone width: the app fits, so there is nothing to scroll sideways ----
  // 320 is the narrowest phone still in circulation (SE-class), 390 a current
  // iPhone. Anything that fits both fits everything in between.
  for (const vw of [320, 390]) {
    const pctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: vw, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const pp = await pctx.newPage();
    await pp.goto('http://localhost:3111/');
    await pp.evaluate(async () => {
      const r = await fetch('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ptcgadmin', password: 'password123' }) });
      const d = await r.json();
      localStorage.setItem('ptcg.auth', JSON.stringify({ token: d.token, username: d.username }));
    });
    await pp.reload();
    await pp.waitForSelector('.set-card');
    /** @returns {{over:number, worst:string[]}} how far past the viewport the page runs */
    const overflow = async (label, url, ready) => {
      await pp.goto(url);
      await pp.waitForSelector(ready);
      await pp.waitForTimeout(250);
      const r = await pp.evaluate(() => {
        const doc = document.documentElement;
        const w = doc.clientWidth, worst = [];
        for (const el of document.querySelectorAll('body *')) {
          const b = el.getBoundingClientRect();
          if (b.width > 0 && b.height > 0 && (b.right > w + 1 || b.left < -1)) {
            worst.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ').join('.')} [${Math.round(b.left)}→${Math.round(b.right)}]`);
          }
        }
        return { over: Math.max(doc.scrollWidth - w, document.body.scrollWidth - w), worst: worst.slice(0, 6) };
      });
      if (r.over > 1) console.log(`  overflow on ${label}: +${r.over}px — ${r.worst.join(' | ')}`);
      return r;
    };
    const pages = [
      ['home', 'http://localhost:3111/#/', '.set-card'],
      ['set page', 'http://localhost:3111/#/set/base1', '.tcg-card'],
      ['pokémon list', 'http://localhost:3111/#/pokemon', '.set-grid .set-card'],
      ['search results', 'http://localhost:3111/#/search/char', '#view'],
      ['scan', 'http://localhost:3111/#/scan', '#view'],
      ['binder list', 'http://localhost:3111/#/binders', '.binder-create'],
    ];
    for (const [label, url, ready] of pages) {
      const r = await overflow(label, url, ready);
      check(`phone (${vw}px): ${label} does not scroll sideways`, r.over <= 1);
    }
    // ...and inside a binder, where a whole page grid has to fit the screen
    await pp.click('.binder-cover');
    await pp.waitForSelector('.binder-cover-page');
    const cOver = await pp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`phone (${vw}px): a binder cover does not scroll sideways`, cOver <= 1);
    await pp.click('.binder-cover-page');
    await pp.waitForSelector('.binder-grid .pocket');
    const bOver = await pp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`phone (${vw}px): an open binder page does not scroll sideways`, bOver <= 1);
    check(`phone (${vw}px): a phone shows one binder page at a time`,
      (await pp.locator('.book-page').count()) <= 1);
    // the page grid has to fit the screen too, not just the document
    const gridFits = await pp.evaluate(() => {
      const g = document.querySelector('.binder-grid');
      return !g || g.getBoundingClientRect().right <= document.documentElement.clientWidth + 1;
    });
    check(`phone (${vw}px): the binder page grid fits inside the screen`, gridFits);
    await pp.click('button:has-text("Edit binder")');
    await pp.waitForSelector('.page-remove');
    const eOver = await pp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`phone (${vw}px): the edit toolbar wraps instead of widening the page`, eOver <= 1);
    // a page turn rotates a sheet in 3D — that must not leave the page wider either
    await pp.click('button:has-text("›")').catch(() => {});
    await pp.waitForTimeout(120);                                       // mid-flip, sheet rotated
    const fOver = await pp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`phone (${vw}px): a page turn does not widen the page mid-flip`, fOver <= 1);
    await pp.waitForFunction(() => !document.querySelector('.flip-sheet')).catch(() => {});
    await pctx.close();
  }

  console.log(errors.length ? 'JS ERRORS:\n' + errors.join('\n') : 'No JS errors, zero external requests.');
  await browser.close();
  if (failCount) console.log(failCount + ' check(s) FAILED');
  process.exit(errors.length || failCount ? 1 : 0);
})();
