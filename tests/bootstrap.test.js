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

  // sign the admin out so the main suite's fresh user is a clean non-admin test
  await page.click('#account-status button:has-text("Sign out")');
  await page.evaluate(() => localStorage.clear());

  console.log(errors.length ? 'JS ERRORS:\n' + errors.join('\n') : 'No JS errors.');
  if (failCount) console.log(failCount + ' check(s) FAILED');
  await browser.close();
  process.exit(errors.length || failCount ? 1 : 0);
})();
