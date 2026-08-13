#!/usr/bin/env node
/* Builds the marketing assets in public/site/assets/ from the REAL app:
 * boots the tracker with demo data (no card artwork anywhere — imageless
 * demo cards render the app's own placeholder looks), then screenshots and
 * records it with a headless browser. Also renders the OG share image.
 *
 *   node scripts/build-assets.js        (needs: npm i --no-save playwright; ffmpeg)
 *
 * Deliberate policy: the demo catalog is invented (fake set names, fake
 * cards) so the sales pages never carry The Pokémon Company's artwork. */
'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'site', 'assets');
const PORT = 3123;
const BASE = `http://localhost:${PORT}`;
fs.mkdirSync(OUT, { recursive: true });

const CONFIG = path.join(ROOT, 'public', 'config.js');
const savedConfig = fs.readFileSync(CONFIG, 'utf8');

async function waitUp(url, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return; } catch { /* not yet */ }
    if (Date.now() - t0 > ms) throw new Error('server never came up');
    await new Promise((r) => setTimeout(r, 150));
  }
}

(async () => {
  // pin config so the app does NOT pull the real master catalog
  fs.writeFileSync(CONFIG, "self.PTCG_CONFIG = { cdnBase: 'cdn', defaultLanguage: 'en', imageBase: null };\n");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptcg-assets-'));
  const server = spawn('node', ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir }, stdio: 'ignore',
  });
  try {
    await waitUp(`${BASE}/api/app-config`);

    /* ---- demo catalog: three invented sets, no images anywhere ---- */
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'ptcg.db'));
    const sets = [
      ['emberwind', 'Emberwind', '2025-03-14', 24],
      ['tidalcrown', 'Tidal Crown', '2025-07-02', 18],
      ['verdantgrove', 'Verdant Grove', '2025-11-21', 21],
    ];
    const setIns = db.prepare("INSERT INTO sets (lang,id,name,release_date,logo,official_count,position,source,hidden) VALUES ('en',?,?,?,NULL,?,?,'local',0)");
    sets.forEach((s, i) => setIns.run(s[0], s[1], s[2], s[3], i));
    const names = ['Cindertail', 'Emberhound', 'Flarewisp', 'Ashmane', 'Pyrelark', 'Kindlefox', 'Scorchbat', 'Magmoth',
      'Wavelet', 'Tidebloom', 'Brinepup', 'Coralisk', 'Mistfin', 'Galeshell', 'Deepmaw', 'Pearlune',
      'Sproutle', 'Thornbud', 'Mossvale', 'Fernwhirl', 'Bloomkit', 'Verdanox', 'Petalisk', 'Grovemane'];
    const rarities = ['Common', 'Common', 'Uncommon', 'Rare', 'Rare Holo'];
    const cardIns = db.prepare("INSERT INTO cards (lang,id,set_id,local_id,name,rarity,category,types_csv,hp,variants_csv,img_low,img_high,position,source,hidden) VALUES ('en',?,?,?,?,?,'Pokemon',?,?,?,NULL,NULL,?,'local',0)");
    let n = 0;
    for (const [sid, , , count] of sets) {
      const type = sid === 'emberwind' ? 'Fire' : sid === 'tidalcrown' ? 'Water' : 'Grass';
      for (let i = 1; i <= count; i++) {
        const name = names[(n + i) % names.length] + (i > names.length ? ' ' + i : '');
        const variants = i % 5 === 0 ? 'normal,holo' : (i % 7 === 0 ? 'normal,reverse' : 'normal');
        cardIns.run(`${sid}-${i}`, sid, String(i), name, rarities[i % rarities.length], type, 30 + (i % 9) * 10, variants, i - 1);
      }
      n += count;
    }
    // leftover local-cdn fixtures (test residue) must not photobomb the demo
    db.prepare("UPDATE sets SET hidden = 1 WHERE id NOT IN ('emberwind','tidalcrown','verdantgrove')").run();
    db.close();

    /* ---- a demo collector, mid-collection ---- */
    const reg = await (await fetch(`${BASE}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ash_demo', password: 'demo-password-1' }) })).json();
    const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + reg.token };
    const collection = {};
    for (const [sid, , , count] of sets) {
      const share = sid === 'emberwind' ? 0.85 : sid === 'tidalcrown' ? 0.5 : 0.2;
      for (let i = 1; i <= count; i++) if ((i * 2654435761 % 100) / 100 < share) collection[`${sid}-${i}`] = { normal: 1 + (i % 3 === 0 ? 1 : 0) };
    }
    await fetch(`${BASE}/api/collection`, { method: 'PUT', headers: auth, body: JSON.stringify({ collection }) });
    await fetch(`${BASE}/api/binders`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Emberwind Master Set', size: 3, color: 'red', fillFromSet: 'emberwind', lang: 'en' }) });
    await fetch(`${BASE}/api/binders`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Trade Binder', size: 3, color: 'blue' }) });
    await fetch(`${BASE}/api/binders`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Chase Cards', size: 2, color: 'green' }) });

    /* ---- the camera ---- */
    const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    const mk = async (opts = {}) => {
      const ctx = await browser.newContext({
        viewport: { width: 1360, height: 850 }, deviceScaleFactor: 2, serviceWorkers: 'block', ...opts,
      });
      await ctx.addInitScript(([tok, user]) => {
        localStorage.setItem('ptcg.visited', 'true');
        localStorage.setItem('ptcg.auth', JSON.stringify({ token: tok, username: user }));
      }, [reg.token, 'ash_demo']);
      return ctx;
    };

    const ctx = await mk();
    const page = await ctx.newPage();

    // 1) home: sets + progress + stats banner
    await page.goto(`${BASE}/`);
    await page.waitForSelector('.set-card .progress');
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, 'shot-sets.png') });

    // 2) binder shelf
    await page.goto(`${BASE}/#/binders`);
    await page.waitForSelector('.binder-cover');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, 'shot-binders.png') });

    // 3) want-list: a set in Text view, Missing filter
    await page.goto(`${BASE}/#/set/tidalcrown`);
    await page.waitForSelector('.tcg-card, .cardrow, .textrow', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
    const viewSel = page.locator('select:has(option[value="text"])').first();
    if (await viewSel.count()) { await viewSel.selectOption('text'); await page.waitForTimeout(400); }
    const missing = page.locator('button:has-text("Missing"), .chip:has-text("Missing")').first();
    if (await missing.count()) { await missing.click(); await page.waitForTimeout(400); }
    await page.screenshot({ path: path.join(OUT, 'shot-wantlist.png') });
    await ctx.close();

    /* ---- the hero loop: ticking cards, progress climbing ---- */
    const vctx = await mk({ recordVideo: { dir: OUT, size: { width: 1360, height: 850 } }, deviceScaleFactor: 1 });
    const vp = await vctx.newPage();
    await vp.goto(`${BASE}/#/set/verdantgrove`);
    await vp.waitForSelector('.tcg-card');
    await vp.waitForTimeout(1200);
    const tiles = vp.locator('.tcg-card:not(.owned)');
    for (let i = 0; i < 6; i++) {
      const t = tiles.nth(i * 2);
      if (!(await t.count())) break;
      await t.click().catch(() => {});
      await vp.waitForTimeout(650);
    }
    await vp.waitForTimeout(1000);
    await vp.close();
    const video = await (await vctx.pages(), vctx).close().then(() => {
      const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.webm'));
      return files.length ? path.join(OUT, files[0]) : null;
    });
    if (video) {
      execSync(`ffmpeg -y -loglevel error -i "${video}" -an -vf "scale=1200:-2" -c:v libx264 -crf 26 -pix_fmt yuv420p "${path.join(OUT, 'hero.mp4')}"`);
      execSync(`ffmpeg -y -loglevel error -i "${video}" -an -vf "scale=1200:-2" -c:v libvpx-vp9 -crf 38 -b:v 0 "${path.join(OUT, 'hero.webm')}"`);
      execSync(`ffmpeg -y -loglevel error -ss 3 -i "${path.join(OUT, 'hero.mp4')}" -frames:v 1 "${path.join(OUT, 'hero-poster.png')}"`);
      fs.rmSync(video);
    }

    /* ---- OG share image (1200×630) ---- */
    const og = await browser.newContext({ viewport: { width: 1200, height: 630 } });
    const op = await og.newPage();
    await op.setContent(`<!doctype html><html><body style="margin:0"><div style="width:1200px;height:630px;display:flex;flex-direction:column;justify-content:center;padding:0 90px;box-sizing:border-box;
      background:#0d1020;background-image:radial-gradient(700px 400px at 78% 10%,rgba(77,143,224,0.25),transparent 65%),radial-gradient(520px 340px at 12% 95%,rgba(255,203,5,0.18),transparent 65%);
      font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#e9ebf8">
      <div style="font-size:26px;font-weight:800;margin-bottom:26px">🃏 Pkmn <span style="color:#ffcb05">Master Set</span></div>
      <div style="font-size:64px;font-weight:800;line-height:1.08;letter-spacing:-2px">Know <span style="color:#ffcb05">exactly</span> which<br>cards you own.</div>
      <div style="font-size:26px;color:#98a1c8;margin-top:24px">Per-printing tracking · digital binders · want-lists — and a card API for builders.</div>
      <div style="position:absolute;bottom:44px;left:90px;font-size:20px;color:#98a1c8">www.pkmnmasterset.com</div>
    </div></body></html>`);
    await op.screenshot({ path: path.join(OUT, 'og.png') });
    await og.close();
    await browser.close();

    console.log('assets written to public/site/assets/:');
    for (const f of fs.readdirSync(OUT)) console.log('  ' + f, Math.round(fs.statSync(path.join(OUT, f)).size / 1024) + 'kB');
  } finally {
    fs.writeFileSync(CONFIG, savedConfig);
    server.kill('SIGTERM');
  }
})();
