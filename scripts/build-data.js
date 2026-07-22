#!/usr/bin/env node
/**
 * Card data downloader — builds the self-hosted card database.
 *
 * Downloads card data and images from TCGdex ONCE, into a static folder
 * you host yourself (same server as the app, or any CDN / static host).
 * After that the app never talks to any third-party API.
 *
 * Usage:
 *   node scripts/build-data.js                     # English, everything, low-res images
 *   node scripts/build-data.js --langs en,ja       # multiple languages
 *   node scripts/build-data.js --sets base1,sv10   # only these sets
 *   node scripts/build-data.js --quality both      # low + high res images
 *   node scripts/build-data.js --no-images         # data only
 *
 * The script is resumable: re-run it and it skips anything already
 * downloaded. Run it again later to pick up newly released sets.
 *
 * Options:
 *   --out <dir>          output folder            (default: public/cdn)
 *   --langs <codes>      comma-separated languages(default: en)
 *                        e.g. en,fr,de,es,it,pt-br,ja,ko,zh-tw
 *   --sets <ids>         comma-separated set ids  (default: all sets)
 *   --quality <q>        low | high | both        (default: low)
 *   --no-images          skip image downloads
 *   --force              re-download data even if present
 *   --concurrency <n>    parallel requests        (default: 8)
 *   --api <url>          source API base          (default: https://api.tcgdex.net/v2)
 *
 * After downloading images, run  node scripts/build-hashes.js  to build the
 * scan index used by the in-app card scanner (requires: npm install sharp).
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ---------- args ----------
const argv = process.argv.slice(2);
function flag(name) { return argv.includes('--' + name); }
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}

const OUT = path.resolve(opt('out', path.join(__dirname, '..', 'public', 'cdn')));
const API = opt('api', 'https://api.tcgdex.net/v2').replace(/\/+$/, '');
const LANGS = opt('langs', opt('lang', 'en')).split(',').map((s) => s.trim()).filter(Boolean);
const ONLY_SETS = opt('sets', '') ? opt('sets', '').split(',').map((s) => s.trim()).filter(Boolean) : null;
const QUALITY = opt('quality', 'low');
const QUALITIES = QUALITY === 'both' ? ['low', 'high'] : [QUALITY];
const NO_IMAGES = flag('no-images');
const FORCE = flag('force');
const CONCURRENCY = Math.max(1, parseInt(opt('concurrency', '8'), 10) || 8);

const LANG_NAMES = {
  en: 'English', fr: 'Français', de: 'Deutsch', es: 'Español', it: 'Italiano',
  pt: 'Português', 'pt-br': 'Português (BR)', ja: '日本語', ko: '한국어',
  'zh-tw': '中文 (繁體)', 'zh-cn': '中文 (简体)', nl: 'Nederlands', pl: 'Polski',
  ru: 'Русский', id: 'Bahasa Indonesia', th: 'ไทย',
};

if (!['low', 'high', 'both'].includes(QUALITY)) {
  console.error('--quality must be low, high, or both');
  process.exit(1);
}

// ---------- helpers ----------
function localIdOf(cardId) {
  const i = cardId.lastIndexOf('-');
  return i > 0 ? cardId.slice(i + 1) : cardId;
}

async function fetchWithRetry(url, asJson, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'pokemon-tcg-tracker-downloader' } });
      if (res.status === 404) { const e = new Error('404'); e.notFound = true; throw e; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return asJson ? await res.json() : Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      if (e.notFound) throw e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1) ** 2));
    }
  }
  throw lastErr;
}
const getJSON = (url) => fetchWithRetry(url, true);
const getBin = (url) => fetchWithRetry(url, false);

async function pool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  return results;
}

function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

let imagesDownloaded = 0, imagesSkipped = 0, imageFailures = 0, cardFailures = 0;

// ---------- progress file (read by the app/server for the download UI) ----------
const PROGRESS_FILE = path.join(OUT, '.progress.json');
const progressState = {
  startedAt: new Date().toISOString(),
  langs: LANGS,
  langIndex: 0,
  langCount: LANGS.length,
  lang: null,
  setsDone: 0,
  setTotal: 0,
  setName: null,
  cardsEstimate: 0,
  done: false,
  error: null,
};
function writeProgress(extra = {}) {
  Object.assign(progressState, extra, {
    imagesDownloaded, imagesSkipped, imageFailures,
    updatedAt: new Date().toISOString(),
  });
  try { writeJSON(PROGRESS_FILE, progressState); } catch { /* disk hiccup — progress is cosmetic */ }
}

async function downloadFile(remoteUrl, dest) {
  if (fs.existsSync(dest)) { imagesSkipped++; return; }
  try {
    const buf = await getBin(remoteUrl);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    imagesDownloaded++;
  } catch (e) {
    imageFailures++;
    if (!e.notFound) console.warn(`  ! image failed: ${remoteUrl} (${e.message})`);
  }
}

// ---------- migration from the old (single-language) layout ----------
/* Earlier versions of this project wrote data to cdn/sets + cdn/images
 * directly (English only, no variant/Pokédex info). Detect that layout and
 * migrate: keep the expensive images (moved under en/), drop the old JSON
 * data so it re-downloads with the new fields. */
function migrateFlatLayout() {
  const oldSets = path.join(OUT, 'sets');
  const oldImages = path.join(OUT, 'images');
  const enSets = path.join(OUT, 'en', 'sets');
  if ((!fs.existsSync(oldSets) && !fs.existsSync(oldImages)) || fs.existsSync(enSets)) return;
  console.log('\nOld data layout detected — migrating to the per-language layout…');
  fs.mkdirSync(path.join(OUT, 'en'), { recursive: true });
  if (fs.existsSync(oldImages)) {
    const dest = path.join(OUT, 'en', 'images');
    if (fs.existsSync(dest)) fs.rmSync(oldImages, { recursive: true, force: true });
    else fs.renameSync(oldImages, dest);
    console.log('  ✓ kept your downloaded images (moved to en/images)');
  }
  if (fs.existsSync(oldSets)) fs.rmSync(oldSets, { recursive: true, force: true });
  for (const f of ['index.json', 'search-index.json', 'scan-index.json']) {
    const p = path.join(OUT, f);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  console.log('  ✓ old card data removed — it will re-download with variant & Pokédex info (images are reused)');
}

// ---------- per-language build ----------
async function buildLanguage(lang) {
  const langApi = `${API}/${lang}`;
  const langOut = path.join(OUT, lang);
  console.log(`\n===== Language: ${lang} =====`);

  const allSets = await getJSON(langApi + '/sets');
  const sets = ONLY_SETS ? allSets.filter((s) => ONLY_SETS.includes(s.id)) : allSets;
  if (ONLY_SETS && sets.length !== ONLY_SETS.length) {
    const found = new Set(sets.map((s) => s.id));
    console.warn('Unknown set ids ignored: ' + ONLY_SETS.filter((id) => !found.has(id)).join(', '));
  }
  console.log(`Sets to process: ${sets.length} of ${allSets.length}`);
  writeProgress({
    lang,
    setTotal: sets.length,
    setsDone: 0,
    cardsEstimate: sets.reduce((a, s) => a + ((s.cardCount && s.cardCount.total) || 0), 0),
  });

  for (let si = 0; si < sets.length; si++) {
    const brief = sets[si];
    writeProgress({ setName: brief.name });
    const setFile = path.join(langOut, 'sets', brief.id + '.json');
    let setData;

    if (!FORCE && fs.existsSync(setFile)) {
      setData = JSON.parse(fs.readFileSync(setFile, 'utf8'));
      // set files written by older versions lack variant/Pokédex/category info — refresh them
      const stale = (setData.cards || []).length &&
        !setData.cards.some((c) => c.variants || c.category || (c.dexId && c.dexId.length));
      if (stale) {
        console.log(`[${si + 1}/${sets.length}] ${brief.name} — data is from an older version, refreshing…`);
        setData = null;
      } else {
        console.log(`[${si + 1}/${sets.length}] ${brief.name} — data already present (${setData.cards.length} cards)`);
      }
    }
    if (!setData) {
      console.log(`[${si + 1}/${sets.length}] ${brief.name} — fetching…`);
      const detail = await getJSON(`${langApi}/sets/${encodeURIComponent(brief.id)}`);
      const cards = await pool(detail.cards || [], CONCURRENCY, async (c) => {
        let full = c;
        try {
          full = await getJSON(`${langApi}/cards/${encodeURIComponent(c.id)}`);
        } catch {
          cardFailures++;
        }
        return {
          id: c.id,
          localId: String(full.localId ?? localIdOf(c.id)),
          name: full.name || c.name,
          rarity: full.rarity,
          category: full.category,
          dexId: full.dexId,
          types: full.types,
          hp: full.hp,
          illustrator: full.illustrator,
          variants: full.variants, // {normal, reverse, holo, firstEdition, wPromo…}
          image: full.image ? `images/${brief.id}/${localIdOf(c.id)}` : null,
          remoteImage: full.image || null,
        };
      });
      setData = {
        id: detail.id,
        name: detail.name,
        releaseDate: detail.releaseDate,
        cardCount: detail.cardCount || { total: cards.length, official: cards.length },
        logo: detail.logo ? `images/${brief.id}/logo.png` : null,
        remoteLogo: detail.logo || null,
        cards,
      };
      writeJSON(setFile, setData);
      console.log(`    saved ${cards.length} cards`);
    }

    if (!NO_IMAGES) {
      if (setData.remoteLogo) {
        await downloadFile(setData.remoteLogo + '.png', path.join(langOut, 'images', setData.id, 'logo.png'));
      }
      const withImages = setData.cards.filter((c) => c.remoteImage);
      await pool(withImages, CONCURRENCY, async (c, ci) => {
        if (ci % 10 === 0) writeProgress();
        const dir = path.join(langOut, 'images', setData.id, localIdOf(c.id));
        for (const q of QUALITIES) {
          await downloadFile(`${c.remoteImage}/${q}.webp`, path.join(dir, `${q}.webp`));
        }
        // some cards only exist at one quality at the source — substitute so the app always has something
        const low = path.join(dir, 'low.webp');
        const high = path.join(dir, 'high.webp');
        if (QUALITIES.includes('low') && !fs.existsSync(low)) {
          if (fs.existsSync(high)) fs.copyFileSync(high, low);
          else await downloadFile(`${c.remoteImage}/high.webp`, low);
        }
      });
      // make each card's image field reflect what actually exists on disk,
      // so cards without obtainable images get a clean placeholder in the app
      let corrected = 0;
      for (const c of setData.cards) {
        const dir = path.join(langOut, 'images', setData.id, localIdOf(c.id));
        const anyFile = ['low', 'high'].some((q) => fs.existsSync(path.join(dir, q + '.webp')));
        const want = anyFile ? `images/${setData.id}/${localIdOf(c.id)}` : null;
        if (c.image !== want) { c.image = want; corrected++; }
      }
      if (corrected) writeJSON(setFile, setData);
      process.stdout.write(`    images: ${imagesDownloaded} downloaded, ${imagesSkipped} already present${corrected ? `, ${corrected} card(s) marked imageless` : ''}\n`);
    }

    // publish indexes after every set so the app becomes usable while a long
    // first download is still running
    buildIndexes(lang, langOut, allSets);
    writeProgress({ setsDone: si + 1 });
  }

  // ---------- final index build ----------
  const counts = buildIndexes(lang, langOut, allSets);
  console.log(`${lang}: ${counts.sets} sets, ${counts.cards} cards.`);
}

/** Rebuild index.json + search-index.json from whatever set files are on disk.
 * Called after EVERY set during a download (cheap), so the app becomes usable
 * set-by-set while a long first download is still running. */
function buildIndexes(lang, langOut, allSets) {
  const indexSets = [];
  const searchRows = [];
  for (const s of allSets) {
    const setFile = path.join(langOut, 'sets', s.id + '.json');
    if (!fs.existsSync(setFile)) continue;
    const data = JSON.parse(fs.readFileSync(setFile, 'utf8'));
    indexSets.push({
      id: data.id,
      name: data.name,
      releaseDate: data.releaseDate,
      cardCount: data.cardCount,
      logo: data.logo && fs.existsSync(path.join(langOut, data.logo)) ? data.logo : null,
    });
    for (const c of data.cards) {
      const variants = c.variants
        ? Object.entries(c.variants).filter(([, v]) => v).map(([k]) => k)
        : [];
      searchRows.push([
        c.id,
        c.name,
        c.rarity || '',
        (c.types || []).join(','),
        c.image ? 1 : 0,
        (c.dexId || []).join(','),
        c.category || '',
        (variants.length ? variants : ['normal']).join(','),
      ]);
    }
  }
  writeJSON(path.join(langOut, 'index.json'), {
    generatedAt: new Date().toISOString(),
    language: lang,
    qualities: NO_IMAGES ? [] : QUALITIES,
    sets: indexSets,
  });
  writeJSON(path.join(langOut, 'search-index.json'), { cards: searchRows });
  return { sets: indexSets.length, cards: searchRows.length };
}

// ---------- main ----------
(async () => {
  console.log(`Output:  ${OUT}`);
  console.log(`Source:  ${API}`);
  console.log(`Langs:   ${LANGS.join(', ')}`);
  console.log(`Images:  ${NO_IMAGES ? 'skipped' : QUALITIES.join(' + ')}`);

  migrateFlatLayout();

  for (let li = 0; li < LANGS.length; li++) {
    writeProgress({ langIndex: li });
    await buildLanguage(LANGS[li]);
  }

  // languages.json lists every language folder present in the output
  const present = fs.readdirSync(OUT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(OUT, d.name, 'index.json')))
    .map((d) => d.name)
    .sort();
  writeJSON(path.join(OUT, 'languages.json'), {
    languages: present.map((code) => ({ code, name: LANG_NAMES[code] || code })),
  });

  console.log(`\nDone. Languages available: ${present.join(', ')}`);
  if (cardFailures) console.log(`Card detail fetches that fell back to basic info: ${cardFailures}`);
  if (imageFailures) console.log(`Images unavailable at source: ${imageFailures}`);
  console.log('Re-run this script any time — it resumes and picks up new sets.');
  console.log('For the in-app card scanner, also run: node scripts/build-hashes.js  (needs: npm install sharp)');
  writeProgress({ done: true, finishedAt: new Date().toISOString() });
})().catch((e) => {
  console.error('\nFailed: ' + e.message);
  writeProgress({ error: e.message });
  process.exit(1);
});
