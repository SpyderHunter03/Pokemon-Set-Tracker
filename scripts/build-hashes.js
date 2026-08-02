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

/* The fingerprint itself lives in scripts/card-hash.js so the server can
 * reuse it for a single freshly uploaded image without a third copy of
 * the algorithm drifting away from the other two. */
const { ALGO, hashFromPixels } = require('./card-hash');

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
    fs.writeFileSync(path.join(langOut, 'scan-index.json'), JSON.stringify({ algo: ALGO, cards: rows }));
    console.log(`\r  ${rows.length} cards hashed${missing ? ` (${missing} without local images skipped)` : ''} → scan-index.json`);
  }
  console.log('Done.');
})().catch((e) => {
  console.error('Failed: ' + e.message);
  process.exit(1);
});
