#!/usr/bin/env node
/**
 * Masterlist importer — ingests a pokemasterlist.vercel.app CSV export and
 * folds its printings into the app's custom-printings overlay (custom.json).
 *
 * pokemasterlist is a hand-curated, per-Pokémon list of every English
 * printing — including many the TCGdex-derived database doesn't model:
 * Parallel/Cosmos/Cracked-Ice holos, EX-era edition dot codes (FXE-WTF-G7Z),
 * promo stamps ("STAFF", "Pokémon Day 2025" Logo), Jumbo, alternate arts.
 *
 * For each CSV row this script matches the Expansion + Set Number to a card
 * in the local database, then classifies the printing:
 *   - COVERED   the card already has this printing (base / 1st ed / unlimited,
 *               or a Parallel/Reverse Holo where the card has a reverse variant)
 *   - ADD       the card exists but this printing is new  → written to custom.json
 *   - NEED-CARD the card itself isn't in the database      → reported, not written
 *               (TCGdex lacks it — needs custom-card support, a separate feature)
 *   - NO-SET    the expansion didn't match any local set   → reported
 *
 * The merge is additive: existing custom printings (including admin-named ones)
 * are never renamed or removed.
 *
 * Usage (from the repo root, after build-data has produced public/cdn):
 *   node scripts/import-masterlist.js eevee.csv --report   # classify, write nothing
 *   node scripts/import-masterlist.js eevee.csv            # write custom.json
 *   node scripts/import-masterlist.js *.csv                # several at once
 *   node scripts/import-masterlist.js eevee.csv --analyze  # CSV only, no DB needed
 *
 * Options:
 *   --lang <code>   database language to match against (default: en)
 *   --out <dir>     database folder                    (default: public/cdn)
 *   --report        classify against the DB, print a gap report, write nothing
 *   --dry-run       alias for --report
 *   --analyze       parse the CSV and tally printings only (no DB required)
 *   --aliases <f>   JSON file of { "masterlist expansion": "localSetId" } to
 *                   resolve names the importer can't match automatically
 */
'use strict';

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const files = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && ['lang', 'out', 'aliases'].includes(argv[i - 1].slice(2))));

const LANG = opt('lang', 'en');
const OUT = path.resolve(opt('out', path.join(__dirname, '..', 'public', 'cdn')));
const REPORT = flag('report') || flag('dry-run');
const ANALYZE = flag('analyze');
const CUSTOM_FILE = path.join(OUT, 'custom.json');

if (!files.length) {
  console.error('Usage: node scripts/import-masterlist.js <export.csv> [--report|--analyze]');
  process.exit(1);
}

// Printings TCGdex already models as base card variants — never imported.
const STANDARD = new Set(['', '1st edition', 'unlimited', '1st edition holo', 'unlimited holo', 'holo', 'holofoil']);
// Printings that mean "reverse holo" — covered when the card has a reverse variant.
const REVERSE_RE = /^(parallel holo|reverse holo(foil)?)$/i;

// ---------- CSV ----------
function parseCSV(text) {
  const rows = [];
  let field = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ';') { field.push(cur); cur = ''; }
    else if (c === '\n') { field.push(cur); rows.push(field); field = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur.length || field.length) { field.push(cur); rows.push(field); }
  return rows;
}

/** Strip Excel's text-forcing wrapper: ="51/64" -> 51/64 */
const unExcel = (v) => String(v).replace(/^="?/, '').replace(/"$/, '').trim();

function readMasterlist(file) {
  const rows = parseCSV(fs.readFileSync(file, 'utf8'));
  const head = rows.shift().map((h) => h.trim());
  const idx = (n) => head.indexOf(n);
  const iExp = idx('Expansion'), iNum = idx('Set Number'), iVar = idx('Variant'),
    iName = idx('Card Name'), iNotes = idx('Notes'), iRel = idx('Release');
  const out = [];
  for (const r of rows) {
    if (!r.length || !(r[iName] || '').trim()) continue;
    out.push({
      expansion: (r[iExp] || '').trim(),
      number: unExcel(r[iNum] || ''),
      variant: (r[iVar] || '').trim(),
      name: (r[iName] || '').trim(),
      notes: (r[iNotes] || '').trim(),
      release: (r[iRel] || '').trim(),
    });
  }
  return out;
}

// ---------- name / number matching ----------
function stripDiacritics(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, ''); }
/** Normalize an expansion/set name; drop pokemasterlist's "(E)/(P)/(WC)…" suffix. */
function normName(name) {
  return stripDiacritics(String(name).toLowerCase())
    .replace(/\s*\([^)]*\)\s*$/, '')     // trailing "(Shiny Vault)", "(E)", "(P)"…
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
/** "51/64" | "020/189" | "SWSH042" | "RC14/RC25" -> canonical local id. */
function normNumber(num) {
  const first = String(num).split('/')[0].trim().toLowerCase();
  return first.replace(/^0+(?=.)/, '');
}
function slugifyVariant(label) {
  return stripDiacritics(label.toLowerCase()).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

// ---------- analyze mode (no DB) ----------
function analyze(all) {
  const exps = new Set(), variants = {};
  let extras = 0;
  for (const r of all) {
    exps.add(r.expansion);
    const key = r.variant || '(base)';
    variants[key] = (variants[key] || 0) + 1;
    if (!STANDARD.has(r.variant.toLowerCase())) extras++;
  }
  console.log(`Printings: ${all.length} · expansions: ${exps.size} · non-standard printings: ${extras}`);
  console.log('\nVariant values:');
  Object.entries(variants).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}  ${k}`));
}

// ---------- main ----------
(function main() {
  const all = files.flatMap(readMasterlist);
  console.log(`Loaded ${all.length} printings from ${files.length} file(s).`);

  if (ANALYZE) { analyze(all); return; }

  const indexFile = path.join(OUT, LANG, 'index.json');
  if (!fs.existsSync(indexFile)) {
    console.error(`\nNo card database at ${indexFile} — run scripts/build-data.js first, or use --analyze.`);
    process.exit(1);
  }
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const aliases = opt('aliases', '') && fs.existsSync(opt('aliases', ''))
    ? JSON.parse(fs.readFileSync(opt('aliases', ''), 'utf8')) : {};
  const aliasByNorm = new Map(Object.entries(aliases).map(([k, v]) => [normName(k), v]));

  const setByNorm = new Map();
  for (const s of index.sets || []) if (!setByNorm.has(normName(s.name))) setByNorm.set(normName(s.name), s.id);

  const setCache = new Map();
  const loadSet = (id) => {
    if (setCache.has(id)) return setCache.get(id);
    const f = path.join(OUT, LANG, 'sets', id + '.json');
    const data = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    const byNum = new Map();
    if (data) for (const c of data.cards || []) byNum.set(normNumber(c.localId), c);
    const entry = { data, byNum };
    setCache.set(id, entry);
    return entry;
  };

  const custom = fs.existsSync(CUSTOM_FILE) ? JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8')) : { cards: {} };
  custom.cards = custom.cards || {};

  const tally = { covered: 0, added: 0, already: 0, needCard: 0, noSet: 0 };
  const noSet = new Map(), needCard = [], addedList = [];

  for (const r of all) {
    const setId = aliasByNorm.get(normName(r.expansion)) || setByNorm.get(normName(r.expansion));
    if (!setId) { tally.noSet++; noSet.set(r.expansion, (noSet.get(r.expansion) || 0) + 1); continue; }
    const { byNum } = loadSet(setId);
    const card = byNum.get(normNumber(r.number));
    if (!card) { tally.needCard++; needCard.push(`${r.expansion} ${r.number} — ${r.name}${r.variant ? ` (${r.variant})` : ''}`); continue; }

    const vlow = r.variant.toLowerCase();
    if (STANDARD.has(vlow)) { tally.covered++; continue; }
    if (REVERSE_RE.test(r.variant) && card.variants && card.variants.reverse) { tally.covered++; continue; }

    const key = slugifyVariant(r.variant);
    if (!key || key.length < 2) { tally.covered++; continue; }
    const label = r.variant.slice(0, 40);
    const entry = custom.cards[card.id] = custom.cards[card.id] || { variants: {} };
    if (entry.variants[key]) { tally.already++; continue; }
    entry.variants[key] = label;
    tally.added++;
    addedList.push(`${card.id} (${card.name}): ${label}`);
  }

  console.log(`\nAlready covered by the database: ${tally.covered}`);
  console.log(`New printings to add:            ${tally.added} (${tally.already} already in custom.json)`);
  console.log(`Cards not in the database:       ${tally.needCard}  (need custom-card support)`);
  console.log(`Expansions with no matching set: ${tally.noSet}`);

  if (addedList.length) {
    console.log('\nWould add:');
    addedList.slice(0, 40).forEach((l) => console.log('  + ' + l));
    if (addedList.length > 40) console.log(`  … and ${addedList.length - 40} more`);
  }
  if (noSet.size) {
    console.log('\nUnmatched expansions (add to --aliases as { "name": "setId" }):');
    [...noSet.entries()].sort((a, b) => b[1] - a[1]).forEach(([n, c]) => console.log(`  ${String(c).padStart(3)}  ${n}`));
  }
  if (needCard.length) {
    console.log(`\nCards the database doesn't have (${needCard.length}):`);
    needCard.slice(0, 30).forEach((l) => console.log('  · ' + l));
    if (needCard.length > 30) console.log(`  … and ${needCard.length - 30} more`);
  }

  if (REPORT) { console.log('\nReport only — nothing written.'); return; }
  fs.mkdirSync(path.dirname(CUSTOM_FILE), { recursive: true });
  fs.writeFileSync(CUSTOM_FILE, JSON.stringify(custom));
  console.log(`\nWrote ${tally.added} new printing(s) to ${CUSTOM_FILE}`);
  console.log('Publish with scripts/publish-images.js so every install sees them.');
})();
