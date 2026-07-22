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

  // first registered account becomes the administrator
  await page.click('#account-btn');
  await page.waitForSelector('#account-modal[open]');
  await page.click('.tabs button:has-text("Create account")');
  await page.fill('#account-forms input[type=text]', 'admin' + Math.floor(Math.random() * 1e6));
  await page.fill('#account-forms input[type=password]', 'password123');
  await page.click('#account-forms .btn');
  await page.waitForSelector('#account-status button:has-text("Sign out")');
  await page.waitForSelector('#admin-area button:has-text("Update card database")');
  check('first account sees the Administration section', true);

  // admin re-run: starts, runs, completes (resume makes it quick)
  await page.click('#admin-area button:has-text("Update card database")');
  await page.waitForSelector('#admin-area .build-progress');
  check('admin update shows progress', true);
  await page.waitForSelector('#admin-area button:has-text("Update card database")', { timeout: 120000 });
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
  check('custom tile labeled correctly', (await customTile.locator('.variant-badge').textContent()) === 'Cracked Ice Holo');

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
