#!/usr/bin/env node
/**
 * Scan-index builder — powers the in-app card scanner.
 *
 * Computes a perceptual hash (dHash, horizontal + vertical, 128 bits) for
 * every downloaded card image and writes cdn/<lang>/scan-index.json.
 * The app compares a photo/camera capture against these hashes entirely
 * on-device — no cloud service involved.
 *
 * Requires the `sharp` image library (the only optional dependency in this
 * project):   npm install sharp
 *
 * Usage:
 *   node scripts/build-hashes.js                 # all languages found in cdn/
 *   node scripts/build-hashes.js --langs en      # specific language(s)
 *   node scripts/build-hashes.js --out <dir>     # if your cdn folder is elsewhere
 *
 * Resumable/fast: re-run any time after downloading new sets (it recomputes
 * from local files only — a full run over ~25k images takes a few minutes).
 */
'use strict';

const fs = require('fs');
const path = require('path');

let sharp;
try {
  sharp = require('sharp');
} catch {
  console.error('This script needs the sharp image library. Install it with:\n\n  npm install sharp\n');
  process.exit(1);
}

const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}

const OUT = path.resolve(opt('out', path.join(__dirname, '..', 'public', 'cdn')));
const LANGS = opt('langs', '')
  ? opt('langs', '').split(',').map((s) => s.trim()).filter(Boolean)
  : fs.readdirSync(OUT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

function bitsToHex(bits) {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4).join(''), 2).toString(16);
  }
  return hex;
}

/* IMPORTANT: this box-average + dHash algorithm is duplicated in
 * public/app.js (computeCardHash). The two implementations must stay
 * byte-identical in behavior — no library resizing in the hash path,
 * exact area averages over the full-resolution pixels — so that hashes
 * computed here match hashes computed in the browser. */
function boxGrid(rgba, W, H, gw, gh) {
  const g = new Float64Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    const y0 = Math.floor((j * H) / gh), y1 = Math.floor(((j + 1) * H) / gh);
    for (let i = 0; i < gw; i++) {
      const x0 = Math.floor((i * W) / gw), x1 = Math.floor(((i + 1) * W) / gw);
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = (y * W + x) * 4;
          sum += 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
          n++;
        }
      }
      g[j * gw + i] = n ? sum / n : 0;
    }
  }
  return g;
}

function hashFromPixels(rgba, W, H) {
  const gx = boxGrid(rgba, W, H, 9, 8);
  const bx = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bx.push(gx[y * 9 + x] < gx[y * 9 + x + 1] ? 1 : 0);
  const gy = boxGrid(rgba, W, H, 8, 9);
  const by = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) by.push(gy[y * 8 + x] < gy[(y + 1) * 8 + x] ? 1 : 0);
  return bitsToHex(bx) + bitsToHex(by);
}

async function hashImage(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return hashFromPixels(data, info.width, info.height);
}

(async () => {
  for (const lang of LANGS) {
    const langOut = path.join(OUT, lang);
    const indexFile = path.join(langOut, 'index.json');
    if (!fs.existsSync(indexFile)) continue;
    console.log(`Language: ${lang}`);
    const setsDir = path.join(langOut, 'sets');
    const rows = [];
    let missing = 0;
    const setFiles = fs.readdirSync(setsDir).filter((f) => f.endsWith('.json'));
    for (const sf of setFiles) {
      const set = JSON.parse(fs.readFileSync(path.join(setsDir, sf), 'utf8'));
      for (const c of set.cards) {
        if (!c.image) continue;
        const img = path.join(langOut, c.image, 'low.webp');
        if (!fs.existsSync(img)) { missing++; continue; }
        try {
          rows.push([c.id, await hashImage(img)]);
        } catch (e) {
          console.warn(`  ! could not hash ${c.id}: ${e.message}`);
        }
      }
      process.stdout.write(`\r  hashed ${rows.length} cards…`);
    }
    fs.writeFileSync(path.join(langOut, 'scan-index.json'), JSON.stringify({ algo: 'boxdhash2-9x8', cards: rows }));
    console.log(`\r  ${rows.length} cards hashed${missing ? ` (${missing} without local images skipped)` : ''} → scan-index.json`);
  }
  console.log('Done.');
})().catch((e) => {
  console.error('Failed: ' + e.message);
  process.exit(1);
});
