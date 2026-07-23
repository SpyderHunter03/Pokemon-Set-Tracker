#!/usr/bin/env node
/**
 * Variant importer — bulk-imports card printings/variants from TCGplayer's
 * catalog (via the free daily mirror at tcgcsv.com) into the app's custom
 * printings overlay (public/cdn/custom.json).
 *
 * TCGplayer is the canonical source for physical-TCG printings: exotic
 * variants like "Cracked Ice Holo", "Staff", "Prerelease" or "Cosmos Holo"
 * exist there as separate products (parenthetical descriptors in the product
 * name). This script matches TCGplayer groups to the local card database's
 * sets, matches products to cards by card number, extracts the descriptors,
 * and merges them into custom.json — where the app already renders each one
 * as its own tile (with the printing's name across the closest image until a
 * dedicated scan is uploaded).
 *
 * Standard printings (Normal / Holofoil / Reverse Holofoil / 1st Edition)
 * are skipped — the TCGdex database already models those as variants.
 *
 * The merge is additive: existing custom printings are never renamed or
 * removed, so admin-added printings and their images always survive.
 *
 * Usage (after build-data has produced public/cdn):
 *   node scripts/import-variants.js --dry-run     # see what would be added
 *   node scripts/import-variants.js               # write custom.json
 *
 * Options:
 *   --api <url>       source API base   (default: https://tcgcsv.com/tcgplayer)
 *   --category <n>    TCGplayer category (default: 3 = Pokemon)
 *   --lang <code>     local database language to match against (default: en)
 *   --out <dir>       database folder   (default: public/cdn)
 *   --sets <ids>      only import for these local set ids
 *   --dry-run         report without writing
 */
'use strict';

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const API = opt('api', 'https://tcgcsv.com/tcgplayer').replace(/\/+$/, '');
const CATEGORY = opt('category', '3');
const LANG = opt('lang', 'en');
const OUT = path.resolve(opt('out', path.join(__dirname, '..', 'public', 'cdn')));
const ONLY_SETS = opt('sets', '') ? opt('sets', '').split(',').map((s) => s.trim()).filter(Boolean) : null;
const DRY = flag('dry-run');
const CUSTOM_FILE = path.join(OUT, 'custom.json');

// subtypes/descriptors the TCGdex variant booleans already cover — never imported
const STANDARD_RE = /^(normal|holo(foil)?|reverse holo(foil)?|unlimited( holo(foil)?)?|1st edition( holo(foil)?| normal)?)$/i;

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'pokemon-tcg-tracker-variant-import' } });
  if (!res.ok) { const e = new Error(`HTTP ${res.status} for ${url}`); e.status = res.status; throw e; }
  const data = await res.json();
  return Array.isArray(data) ? data : data.results || [];
}

/** Normalize a set/group name for matching: lowercase, fold punctuation,
 * drop TCGplayer's series prefixes ("SWSH07: Evolving Skies", "SM - Ultra
 * Prism", "XY - Evolutions"). */
function normName(name) {
  return String(name)
    .toLowerCase()
    .replace(/^(swsh|sm|sv|xy|bw|hgss|dp|ex|e|neo|gym)\s*\d*\s*[:-]\s*/i, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** "40/122" | "040/185" | "SWSH250" → canonical local id for card matching. */
function normNumber(num) {
  const first = String(num).split('/')[0].trim();
  return first.replace(/^0+(?=.)/, '').toLowerCase();
}

/** Parenthetical variant descriptors from a product name.
 * "Greninja (40/122) (Cracked Ice Holo)" → ["Cracked Ice Holo"] */
function descriptorsOf(productName) {
  const out = [];
  for (const m of String(productName).matchAll(/\(([^)]+)\)/g)) {
    const text = m[1].trim();
    if (!text) continue;
    if (/^[\w#-]*\d+[\w/-]*$/.test(text.replace(/\s+/g, ''))) continue; // a card number
    if (STANDARD_RE.test(text)) continue; // standard printing, already modeled
    out.push(text);
  }
  return out;
}

function slugifyVariant(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

(async () => {
  // ---- local database ----
  const indexFile = path.join(OUT, LANG, 'index.json');
  if (!fs.existsSync(indexFile)) {
    console.error(`No card database at ${indexFile} — run scripts/build-data.js first.`);
    process.exit(1);
  }
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const localSets = (index.sets || []).filter((s) => !ONLY_SETS || ONLY_SETS.includes(s.id));
  const setByNorm = new Map();
  for (const s of localSets) setByNorm.set(normName(s.name), s);

  // ---- remote groups ----
  console.log(`Source: ${API} (category ${CATEGORY})`);
  const groups = await getJSON(`${API}/${CATEGORY}/groups`);
  console.log(`TCGplayer groups: ${groups.length} · local sets: ${localSets.length}`);

  const matched = [];
  const unmatchedGroups = [];
  for (const g of groups) {
    const set = setByNorm.get(normName(g.name)) ||
      (g.abbreviation ? localSets.find((s) => s.id.toLowerCase() === String(g.abbreviation).toLowerCase()) : null);
    if (set) matched.push({ group: g, set });
    else unmatchedGroups.push(g.name);
  }
  console.log(`Matched ${matched.length} groups to local sets (${unmatchedGroups.length} groups unmatched).`);

  // ---- per group: products + prices → custom printings ----
  const custom = fs.existsSync(CUSTOM_FILE)
    ? JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8'))
    : { cards: {} };
  custom.cards = custom.cards || {};

  let added = 0, already = 0, cardsTouched = new Set(), productsMatched = 0, productsUnmatched = 0;

  for (const { group, set } of matched) {
    const setFile = path.join(OUT, LANG, 'sets', set.id + '.json');
    const setData = fs.existsSync(setFile) ? JSON.parse(fs.readFileSync(setFile, 'utf8')) : null;
    if (!setData) continue;
    const cardByNum = new Map();
    for (const c of setData.cards || []) cardByNum.set(normNumber(c.localId), c);

    let products = [], prices = [];
    try {
      products = await getJSON(`${API}/${CATEGORY}/${group.groupId}/products`);
      prices = await getJSON(`${API}/${CATEGORY}/${group.groupId}/prices`);
    } catch (e) {
      console.warn(`  ! ${group.name}: ${e.message}`);
      continue;
    }
    const subTypesByProduct = new Map();
    for (const p of prices) {
      if (!p.subTypeName) continue;
      if (!subTypesByProduct.has(p.productId)) subTypesByProduct.set(p.productId, []);
      subTypesByProduct.get(p.productId).push(p.subTypeName);
    }

    for (const prod of products) {
      const numEntry = (prod.extendedData || []).find((d) => /^(Number|No)$/i.test(d.name || ''));
      if (!numEntry) continue; // sealed product, not a single card
      const card = cardByNum.get(normNumber(numEntry.value));
      if (!card) { productsUnmatched++; continue; }
      productsMatched++;

      const labels = new Set(descriptorsOf(prod.name));
      for (const st of subTypesByProduct.get(prod.productId) || []) {
        if (!STANDARD_RE.test(st)) labels.add(st);
      }
      for (const label of labels) {
        const key = slugifyVariant(label);
        if (!key || key.length < 2) continue;
        const entry = custom.cards[card.id] = custom.cards[card.id] || { variants: {} };
        if (entry.variants[key]) { already++; continue; } // existing (possibly admin-named) wins
        entry.variants[key] = label;
        added++;
        cardsTouched.add(card.id);
        if (DRY && added <= 30) console.log(`  + ${card.id} (${card.name}): ${label}`);
      }
    }
  }

  console.log(`\nProducts matched to cards: ${productsMatched} (${productsUnmatched} unmatched by number)`);
  console.log(`Custom printings: ${added} new on ${cardsTouched.size} card(s), ${already} already present.`);
  if (unmatchedGroups.length) {
    console.log(`Unmatched groups (no local set): ${unmatchedGroups.slice(0, 15).join(' · ')}${unmatchedGroups.length > 15 ? ` · +${unmatchedGroups.length - 15} more` : ''}`);
  }

  if (DRY) { console.log('\nDry run — nothing written.'); return; }
  fs.mkdirSync(path.dirname(CUSTOM_FILE), { recursive: true });
  fs.writeFileSync(CUSTOM_FILE, JSON.stringify(custom));
  console.log(`Wrote ${CUSTOM_FILE}`);
  console.log('Publish it with scripts/publish-images.js so every install picks the printings up.');
})().catch((e) => {
  console.error('Failed: ' + e.message);
  process.exit(1);
});
