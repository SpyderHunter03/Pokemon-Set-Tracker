/* Pokémon TCG Tracker — app logic (vanilla JS, no build step) */
'use strict';

const APP_VERSION = '3.8.0';

/* ============================================================
 * Storage helpers
 * ============================================================ */
function lsGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function lsSet(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

/* ============================================================
 * Card data provider — self-hosted static database
 * Reads the folder produced by scripts/build-data.js from the
 * location configured in config.js (same server or your own CDN).
 * No third-party APIs are called at runtime.
 * ============================================================ */
let CDN = ((self.PTCG_CONFIG && self.PTCG_CONFIG.cdnBase) || 'cdn').replace(/\/+$/, '');
const IMAGE_BASE = ((self.PTCG_CONFIG && self.PTCG_CONFIG.imageBase) || '').replace(/\/+$/, '');
const isRemoteCdn = () => /^https?:\/\//i.test(CDN);
let lang = lsGet('ptcg.lang') || (self.PTCG_CONFIG && self.PTCG_CONFIG.defaultLanguage) || 'en';

const DB = () => `${CDN}/${lang}`;
/** Images may live on a separately controlled CDN (config.imageBase). */
const IMGDB = () => (IMAGE_BASE ? `${IMAGE_BASE}/${lang}` : DB());

async function cdnGet(url) {
  let res;
  try {
    res = await fetch(url);
  } catch {
    const e = new Error(`Could not reach the card database (${url}). Check cdnBase in config.js.`);
    e.dbError = true;
    throw e;
  }
  if (res.status === 404) {
    const e = new Error(`Missing data file: ${url}`);
    e.dbError = true;
    e.notFound = true;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`Card database error ${res.status} for ${url}`);
    e.dbError = true;
    throw e;
  }
  return res.json();
}

/** Unregister service workers, wipe caches, reload — fixes stale-version problems. */
async function repairApp() {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
  } catch { /* no SW */ }
  try {
    for (const k of await caches.keys()) await caches.delete(k);
  } catch { /* no cache API */ }
  location.reload();
}

/** Standard error view for data problems, with self-repair options. */
function dbErrorView(title, err, retry) {
  return h('div', { class: 'center' },
    h('p', {}, title),
    h('p', { class: 'small' }, err.message),
    h('p', { class: 'small' }, err.notFound
      ? 'If you already ran build-data.js, this usually means the app or its cached files are out of date, or the data was downloaded with an older version. "Repair & reload" fixes cached-version problems; re-running "node scripts/build-data.js" upgrades old data (your images are kept).'
      : ''),
    h('div', { class: 'row', style: 'justify-content:center; margin-top:10px' },
      retry ? h('button', { class: 'btn', onclick: retry }, 'Retry') : null,
      h('button', { class: 'btn ghost', onclick: repairApp }, 'Repair & reload'),
      h('a', { class: 'btn ghost', href: '#/debug' }, 'Debug info'),
    ),
  );
}

let _indexCache = null;
let _searchCache = null;
const _setDetailCache = new Map();
let _scanIndexCache = null;
let _languagesCache = null;
let _customVariants = null; // { cardId: { variants: { key: label } } }

function clearDataCaches() {
  _indexCache = null;
  _searchCache = null;
  _setDetailCache.clear();
  _scanIndexCache = null;
  _customVariants = null;
}

/** Admin-defined printings (e.g. "Cracked Ice Holo") — global, language-independent. */
async function getCustomVariants() {
  if (_customVariants) return _customVariants;
  try {
    const data = await cdnGet(`${CDN}/custom.json`);
    _customVariants = data.cards || {};
  } catch {
    _customVariants = {}; // none defined yet
  }
  return _customVariants;
}

function customVariantsOf(cardId) {
  return (_customVariants && _customVariants[cardId] && _customVariants[cardId].variants) || {};
}

async function getIndex() {
  if (_indexCache) return _indexCache;
  try {
    _indexCache = await cdnGet(`${DB()}/index.json`);
  } catch (e) {
    // configured remote CDN unreachable or missing this language — fall back
    // to a locally built database when one exists (self-hosting still works)
    if (isRemoteCdn()) {
      const remote = CDN;
      try {
        const res = await fetch(`cdn/${lang}/index.json`);
        if (!res.ok) throw e;
        const local = await res.json();
        CDN = 'cdn';
        clearDataCaches();
        _indexCache = local;
        toast('Card CDN unreachable — using the local database');
      } catch {
        CDN = remote;
        throw e;
      }
    } else {
      throw e;
    }
  }
  return _indexCache;
}

async function getSets() {
  return (await getIndex()).sets;
}

async function getSet(id) {
  if (_setDetailCache.has(id)) return _setDetailCache.get(id);
  const set = await cdnGet(`${DB()}/sets/${encodeURIComponent(id)}.json`);
  _setDetailCache.set(id, set);
  return set;
}

async function getCard(id) {
  const set = await getSet(setIdOf(id));
  return (set.cards || []).find((c) => c.id === id) || { id, name: id };
}

async function getLanguages() {
  if (_languagesCache) return _languagesCache;
  try {
    const data = await cdnGet(`${CDN}/languages.json`);
    _languagesCache = data.languages || [];
  } catch {
    _languagesCache = [{ code: lang, name: lang }];
  }
  return _languagesCache;
}

function localIdOf(cardId) {
  const i = cardId.lastIndexOf('-');
  return i > 0 ? cardId.slice(i + 1) : cardId;
}

function setIdOf(cardId) {
  const i = cardId.lastIndexOf('-');
  return i > 0 ? cardId.slice(0, i) : cardId;
}

/** search-index rows: [id, name, rarity, typesCsv, hasImg, dexCsv, category] */
async function getSearchIndex() {
  if (_searchCache) return _searchCache;
  const raw = await cdnGet(`${DB()}/search-index.json`);
  const rarities = new Set(), types = new Set();
  const species = new Map(); // dexId -> {dex, name, cards: [briefRow]}
  for (const row of raw.cards) {
    const [, name, rarity, typesCsv, , dexCsv] = row;
    if (rarity) rarities.add(rarity);
    if (typesCsv) typesCsv.split(',').forEach((t) => t && types.add(t));
    if (dexCsv) {
      const dex = parseInt(dexCsv.split(',')[0], 10);
      if (dex) {
        if (!species.has(dex)) species.set(dex, { dex, name, cards: [] });
        const sp = species.get(dex);
        sp.cards.push(row);
        if (name.length < sp.name.length) sp.name = name; // shortest name ≈ species name
      }
    }
  }
  _searchCache = {
    cards: raw.cards,
    rarities: [...rarities].sort(),
    types: [...types].sort(),
    species: [...species.values()].sort((a, b) => a.dex - b.dex),
  };
  return _searchCache;
}

function briefFromRow(row) {
  const [id, name, , , hasImg, , , variantsCsv] = row;
  const variants = {};
  (variantsCsv ? variantsCsv.split(',') : ['normal']).forEach((v) => { if (v) variants[v] = true; });
  return { id, name, localId: localIdOf(id), image: hasImg ? `images/${setIdOf(id)}/${localIdOf(id)}` : null, variants };
}

async function searchCards({ name, rarity, type, sort, page = 1, perPage = 100 }) {
  const idx = await getSearchIndex();
  await getIndex(); // set order needed for release-date sorting
  const q = (name || '').toLowerCase();
  let matches = [];
  for (const row of idx.cards) {
    const [, cardName, cardRarity, typesCsv] = row;
    if (q && !cardName.toLowerCase().includes(q)) continue;
    if (rarity && cardRarity !== rarity) continue;
    if (type && !typesCsv.split(',').includes(type)) continue;
    matches.push(row);
  }
  if (sort) matches = sortCards(matches, sort, (row) => row[0], (row) => row[1]);
  return matches.slice((page - 1) * perPage, page * perPage).map(briefFromRow);
}

function cardImg(card, quality = 'low', variant = null) {
  if (!card.image) return null;
  // a real per-variant scan (user-supplied, detected by build-data) wins
  if (variant && card.variantImages && card.variantImages[variant]) {
    const avail = card.variantImages[variant];
    const q = avail.includes(quality) ? quality : avail[0];
    return `${IMGDB()}/${card.image}/${variant}-${q}.webp`;
  }
  const qualities = (_indexCache && _indexCache.qualities) || ['low'];
  const q = quality === 'high' && qualities.includes('high') ? 'high' : 'low';
  if (!qualities.includes(q)) return null; // data-only install
  return `${IMGDB()}/${card.image}/${q}.webp`;
}

/** Printing look when no dedicated scan exists: the closest image — the
 * card's base scan (same set, same number) — with the printing's name
 * written across it. The card's primary printing is what the base scan
 * depicts, so it stays clean; real uploaded scans always win. */
function variantFxEl(card, variant) {
  if (card.variantImages && card.variantImages[variant]) return null; // real scan of this printing
  if (realVariants(card)[0] === variant) return null; // the base scan depicts this printing
  return h('div', { class: 'fx fx-label', 'aria-hidden': 'true' },
    h('span', {}, variantLabel(card, variant)));
}

/** Sorting helpers — set release order comes from the index (oldest → newest). */
function setOrderMap() {
  return new Map(((_indexCache && _indexCache.sets) || []).map((s, i) => [s.id, i]));
}

function numericLocalId(id) {
  const n = parseInt(localIdOf(id), 10);
  return Number.isNaN(n) ? Infinity : n;
}

function sortCards(rows, mode, getId, getName) {
  const order = setOrderMap();
  const bySet = (a, b, dir) => {
    const d = ((order.get(setIdOf(getId(a))) ?? 0) - (order.get(setIdOf(getId(b))) ?? 0)) * dir;
    return d !== 0 ? d : numericLocalId(getId(a)) - numericLocalId(getId(b));
  };
  const cmp = {
    name: (a, b) => getName(a).localeCompare(getName(b)) || numericLocalId(getId(a)) - numericLocalId(getId(b)),
    number: (a, b) => numericLocalId(getId(a)) - numericLocalId(getId(b)) || String(localIdOf(getId(a))).localeCompare(String(localIdOf(getId(b)))),
    newest: (a, b) => bySet(a, b, -1),
    oldest: (a, b) => bySet(a, b, 1),
  }[mode];
  return cmp ? [...rows].sort(cmp) : rows;
}

function sortSelect(options, current, onchange) {
  return h('select', { class: 'chip', 'aria-label': 'Sort', onchange: (e) => onchange(e.target.value) },
    ...options.map(([val, label]) => {
      const o = h('option', { value: val }, 'Sort: ' + label);
      if (val === current) o.setAttribute('selected', '');
      return o;
    }));
}

function setLogo(set) {
  return set.logo ? `${IMGDB()}/${set.logo}` : null;
}

/* ============================================================
 * Local collection store — per-variant quantities
 * Format v2: { cardId: { normal: 1, reverse: 2, holo: 0, ... } }
 * ============================================================ */
const VARIANT_DEFS = [
  ['normal', 'Normal'],
  ['holo', 'Holo'],
  ['reverse', 'Reverse Holo'],
  ['firstEdition', '1st Edition'],
  ['wPromo', 'W Promo'],
  ['other', 'Other / Stamped'],
];
const VARIANT_LABELS = Object.fromEntries(VARIANT_DEFS);

function normalizeEntry(val) {
  if (typeof val === 'number') return val > 0 ? { normal: val } : {};
  if (val && typeof val === 'object') {
    const out = {};
    for (const [k, q] of Object.entries(val)) {
      const qq = Math.max(0, Math.min(9999, parseInt(q, 10) || 0));
      if (qq > 0) out[k] = qq;
    }
    return out;
  }
  return {};
}

function loadCollection() {
  const v2 = lsGet('ptcg.collection.v2');
  if (v2) return v2;
  const v1 = lsGet('ptcg.collection.v1'); // migrate old single-quantity data
  const migrated = {};
  if (v1) {
    for (const [id, qty] of Object.entries(v1)) {
      const e = normalizeEntry(qty);
      if (Object.keys(e).length) migrated[id] = e;
    }
    lsSet('ptcg.collection.v2', migrated);
  }
  return migrated;
}

let collection = loadCollection();

function saveCollection() {
  lsSet('ptcg.collection.v2', collection);
  lsSet('ptcg.updatedAt', Date.now());
  scheduleSyncPush();
}

function variantQty(cardId, variant) {
  return (collection[cardId] && collection[cardId][variant]) || 0;
}

function totalQty(cardId) {
  const e = collection[cardId];
  if (!e) return 0;
  return Object.values(e).reduce((a, b) => a + b, 0);
}

function ownedAny(cardId) { return totalQty(cardId) > 0; }

function setVariantQty(cardId, variant, qty) {
  qty = Math.max(0, Math.min(9999, qty | 0));
  if (!collection[cardId]) collection[cardId] = {};
  if (qty === 0) delete collection[cardId][variant];
  else collection[cardId][variant] = qty;
  if (!Object.keys(collection[cardId]).length) delete collection[cardId];
  saveCollection();
  updateStatsBanner();
}

/** The real printings of a card: from the data, plus any admin-defined
 * custom printings ("Cracked Ice Holo" etc.). No "other" — that lives in
 * the detail view. */
function realVariants(card) {
  const avail = [];
  const v = card && card.variants;
  for (const [key] of VARIANT_DEFS) {
    if (key === 'other') continue;
    if (v && v[key]) avail.push(key);
  }
  if (!avail.length) avail.push('normal');
  for (const key of Object.keys(customVariantsOf(card.id))) {
    if (!avail.includes(key)) avail.push(key);
  }
  return avail;
}

/** Variants offered in the card detail view: every real printing + the "other/stamped" bucket. */
function availableVariants(card) {
  return [...realVariants(card), 'other'];
}

/** Display label for a variant of a specific card. A "normal" printing of a
 * card that also has a 1st Edition printing is what collectors call "Unlimited". */
function variantLabel(card, vk) {
  const custom = customVariantsOf(card.id)[vk];
  if (custom) return custom;
  if (vk === 'normal') {
    return card && card.variants && card.variants.firstEdition ? 'Unlimited' : 'Normal';
  }
  return VARIANT_LABELS[vk] || vk;
}

/** Quick tap on a variant tile: 0 → 1 → 0. Multiple copies open details instead of wiping. */
function quickToggle(card, variant) {
  const qty = variantQty(card.id, variant);
  if (qty === 0) { setVariantQty(card.id, variant, 1); return 'added'; }
  if (qty === 1) { setVariantQty(card.id, variant, 0); return 'removed'; }
  return 'complex';
}

function ownedCountsBySet() {
  const counts = {};
  for (const id of Object.keys(collection)) {
    if (!ownedAny(id)) continue;
    const sid = setIdOf(id);
    counts[sid] = (counts[sid] || 0) + 1;
  }
  return counts;
}

function mergeCollections(a, b) {
  const out = {};
  for (const [id, val] of Object.entries(a || {})) {
    const e = normalizeEntry(val);
    if (Object.keys(e).length) out[id] = e;
  }
  for (const [id, val] of Object.entries(b || {})) {
    const e = normalizeEntry(val);
    if (!Object.keys(e).length) continue;
    if (!out[id]) { out[id] = e; continue; }
    for (const [vk, q] of Object.entries(e)) {
      out[id][vk] = Math.max(out[id][vk] || 0, q);
    }
  }
  return out;
}

/* ============================================================
 * Cloud sync (only when hosted with the bundled server)
 * ============================================================ */
let serverAvailable = false;
let auth = lsGet('ptcg.auth'); // { token, username }
let syncTimer = null;
let syncState = 'off'; // off | idle | syncing | error

let _serverCheckPromise = null;
function detectServer() {
  if (!_serverCheckPromise) {
    _serverCheckPromise = (async () => {
      try {
        const res = await fetch('api/health', { cache: 'no-store' });
        const data = await res.json();
        serverAvailable = !!data.ok;
      } catch { serverAvailable = false; }
      updateAccountButton();
    })();
  }
  return _serverCheckPromise;
}

function authHeaders() {
  return auth ? { Authorization: 'Bearer ' + auth.token } : {};
}

let _meCache = null;
async function ensureMe() {
  if (!auth || !serverAvailable) return null;
  if (_meCache && _meCache.username === auth.username) return _meCache;
  try { _meCache = await apiCall('me'); } catch { _meCache = null; }
  return _meCache;
}

async function apiCall(path, options = {}) {
  const res = await fetch('api/' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && auth) { auth = null; lsSet('ptcg.auth', null); updateAccountButton(); }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

async function doAuth(kind, username, password) {
  const data = await apiCall(kind, { method: 'POST', body: JSON.stringify({ username, password }) });
  auth = { token: data.token, username: data.username };
  lsSet('ptcg.auth', auth);
  await pullAndMerge();
  updateAccountButton();
}

async function pullAndMerge() {
  if (!auth) return;
  syncState = 'syncing';
  const remote = await apiCall('collection');
  collection = mergeCollections(collection, remote.collection);
  lsSet('ptcg.collection.v2', collection);
  await pushNow();
  updateStatsBanner();
  rerenderCards();
}

async function pushNow() {
  if (!auth || !serverAvailable) return;
  syncState = 'syncing';
  updateAccountButton();
  try {
    await apiCall('collection', { method: 'PUT', body: JSON.stringify({ collection }) });
    syncState = 'idle';
  } catch (e) {
    syncState = 'error';
    console.warn('Sync failed:', e.message);
  }
  updateAccountButton();
}

function scheduleSyncPush() {
  if (!auth || !serverAvailable) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(pushNow, 1500);
}

function logout() {
  auth = null;
  _meCache = null;
  lsSet('ptcg.auth', null);
  syncState = 'off';
  updateAccountButton();
}

function updateAccountButton() {
  const btn = document.getElementById('account-btn');
  btn.classList.toggle('synced', !!auth && syncState !== 'error');
  btn.textContent = auth ? (syncState === 'error' ? '⚠️' : '☁️') : '👤';
}

/* ============================================================
 * UI helpers
 * ============================================================ */
const view = document.getElementById('view');

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

let toastTimer = null;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function spinner() { return h('div', { class: 'spinner' }); }

/* ============================================================
 * Card grid rendering (shared by set, search, pokémon, scan pages)
 * ============================================================ */
function placeholderContent(card) {
  return h('div', { class: 'noimg' }, h('div', {}, '🃏'), h('div', {}, card.name), h('div', { class: 'small' }, card.localId || ''));
}

/** One tile = one printing (card × variant). */
function cardTile(card, variant, { onOwnershipChange } = {}) {
  const tile = h('div', {
    class: 'tcg-card',
    role: 'button',
    tabindex: '0',
    onclick: () => {
      const result = quickToggle(card, variant);
      if (result === 'complex') { openCardModal(card, { variant, onOwnershipChange }); return; }
      decorateTile(tile, card);
      if (onOwnershipChange) onOwnershipChange();
    },
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tile.click(); } },
  });
  tile.dataset.cardId = card.id;
  tile.dataset.variant = variant;
  const variantSrc = cardImg(card, 'low', variant);
  if (variantSrc) {
    const imgEl = h('img', { src: variantSrc, alt: card.name, loading: 'lazy' });
    imgEl.addEventListener('error', () => imgEl.replaceWith(placeholderContent(card)));
    tile.append(imgEl);
    const fx = variantFxEl(card, variant);
    if (fx) tile.append(fx);
  } else {
    tile.append(placeholderContent(card));
  }
  // label the printing when a card has several (or a notable one like 1st Edition)
  if (realVariants(card).length > 1 || variant !== 'normal') {
    tile.append(h('div', { class: 'variant-badge' }, variantLabel(card, variant)));
  }
  tile.append(h('button', {
    class: 'info-btn', title: 'Card details', 'aria-label': 'Card details',
    onclick: (e) => { e.stopPropagation(); openCardModal(card, { variant, onOwnershipChange }); },
  }, 'ⓘ'));
  decorateTile(tile, card);
  return tile;
}

function decorateTile(tile, card) {
  const variant = tile.dataset.variant;
  const qty = variantQty(tile.dataset.cardId, variant);
  tile.classList.toggle('missing', qty === 0);
  tile.setAttribute('aria-label', `${card.name || tile.dataset.cardId} — ${qty ? 'owned' : 'not owned'}`);
  tile.querySelectorAll('.badge, .qty-badge').forEach((n) => n.remove());
  if (qty) {
    tile.append(h('div', { class: 'badge' }, '✓'));
    if (qty > 1) tile.append(h('div', { class: 'qty-badge' }, `×${qty}`));
  }
}

function rerenderCards() {
  document.querySelectorAll('.tcg-card').forEach((tile) => {
    if (tile.dataset.cardId) decorateTile(tile, { id: tile.dataset.cardId });
  });
}

/* ============================================================
 * Card detail modal — per-variant tracking
 * ============================================================ */
const cardModal = document.getElementById('card-modal');

async function openCardModal(brief, { variant, onOwnershipChange } = {}) {
  const body = document.getElementById('card-modal-body');
  body.replaceChildren(spinner());
  cardModal.showModal();
  let card = brief, set = null;
  try {
    await getCustomVariants();
    card = await getCard(brief.id);
    set = await getSet(setIdOf(brief.id));
  } catch { /* offline — show what we have */ }
  if (!card.variants && brief.variants) card.variants = brief.variants;
  const me = await ensureMe();
  const isAdmin = !!(me && me.admin);

  const rows = [];
  const kv = (k, v) => { if (v) rows.push(h('div', { class: 'kv' }, h('span', {}, k), h('span', {}, String(v)))); };
  kv('Set', set && set.name);
  kv('Number', card.localId && set && set.cardCount ? `${card.localId} / ${set.cardCount.official || set.cardCount.total}` : card.localId);
  kv('Rarity', card.rarity);
  kv('Category', card.category);
  kv('Types', card.types && card.types.join(', '));
  kv('HP', card.hp);
  kv('Illustrator', card.illustrator);

  const avail = () => availableVariants(card);
  let active = variant && avail().includes(variant) ? variant : avail()[0];

  const chipsWrap = h('div', { class: 'chips', style: 'margin:12px 0 4px; justify-content:center' });
  const counterWrap = h('div', {});
  const adminWrap = h('div', {});
  const imgWrap = h('div', { class: 'card-img-wrap' });

  function renderModalImage() {
    imgWrap.replaceChildren();
    const src = cardImg(card, 'high', active) || cardImg(card, 'low', active);
    if (!src) return;
    imgWrap.append(h('img', { class: 'card-img', src, alt: card.name }));
    const fx = variantFxEl(card, active);
    if (fx) imgWrap.append(fx);
  }

  function renderVariantUI() {
    renderModalImage(); // the picture reflects the selected printing
    chipsWrap.replaceChildren(...avail().map((vk) => {
      const qty = variantQty(card.id, vk);
      return h('button', {
        type: 'button',
        class: 'chip' + (vk === active ? ' active' : ''),
        onclick: () => { active = vk; renderVariantUI(); },
      }, variantLabel(card, vk) + (qty ? ` ✓${qty > 1 ? '×' + qty : ''}` : ''));
    }));
    const qty = variantQty(card.id, active);
    const adjust = (d) => {
      setVariantQty(card.id, active, variantQty(card.id, active) + d);
      renderVariantUI();
      rerenderCards();
      if (onOwnershipChange) onOwnershipChange();
    };
    counterWrap.replaceChildren(
      h('div', { class: 'qty-row' },
        h('button', { onclick: () => adjust(-1), 'aria-label': `Remove one ${variantLabel(card, active)}` }, '−'),
        h('span', { class: 'qty' }, String(qty)),
        h('button', { onclick: () => adjust(1), 'aria-label': `Add one ${variantLabel(card, active)}` }, '+'),
      ),
      h('div', { class: 'muted small', style: 'text-align:center' }, `copies of ${variantLabel(card, active)}`),
    );
    renderAdminControls();
  }

  // ---- admin: add custom printings & upload your own variant images ----
  function renderAdminControls() {
    adminWrap.replaceChildren();
    if (!isAdmin) return;
    const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: '' });
    fileInput.addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const res = await fetch(`api/variant-image?cardId=${encodeURIComponent(card.id)}&variant=${encodeURIComponent(active)}&lang=${encodeURIComponent(lang)}`, {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': f.type || 'application/octet-stream' },
          body: f,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        toast(`Image saved for ${variantLabel(card, active)}`);
        _setDetailCache.delete(setIdOf(card.id)); // pick up the new variantImages
        card = await getCard(card.id);
        renderVariantUI();
        route(); // rebuild the grid behind the modal with the new image
      } catch (err) {
        toast(err.message);
      }
      e.target.value = '';
    });
    adminWrap.append(
      h('div', { class: 'row', style: 'justify-content:center; margin-top:10px' },
        h('button', { type: 'button', class: 'btn ghost small', onclick: async () => {
          const label = prompt('Name of the printing (e.g. "Cracked Ice Holo"):');
          if (!label || label.trim().length < 2) return;
          try {
            const res = await apiCall('custom-variant', { method: 'POST', body: JSON.stringify({ cardId: card.id, label: label.trim() }) });
            _customVariants = null;
            await getCustomVariants();
            active = res.key;
            toast(`Added printing: ${res.label}`);
            renderVariantUI();
            route(); // the new printing becomes its own tile in the grid behind
          } catch (err) {
            toast(err.message);
          }
        } }, '＋ Add printing'),
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => fileInput.click() }, `⬆ Upload ${variantLabel(card, active)} image`),
        fileInput,
      ),
      h('p', { class: 'muted small', style: 'text-align:center; margin:6px 0 0' }, 'Admin: custom printings apply to this card; uploaded images replace the synthetic look.'),
    );
  }
  renderVariantUI();

  body.replaceChildren(
    h('h2', {}, card.name),
    imgWrap,
    ...rows,
    chipsWrap,
    counterWrap,
    adminWrap,
    h('div', { class: 'row', style: 'margin-top:14px; justify-content:flex-end' },
      h('button', { class: 'btn ghost', onclick: () => cardModal.close() }, 'Close'),
    ),
  );
}

/* ============================================================
 * Card database download (button on main page + admin re-run)
 * ============================================================ */
let buildPollTimer = null;

function stopBuildPoll() {
  clearInterval(buildPollTimer);
  buildPollTimer = null;
}

async function getBuildStatus() {
  try {
    const res = await fetch('api/build-status', { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

async function startDatabaseBuild() {
  return apiCall('build-data', { method: 'POST', body: JSON.stringify({}) });
}

/** Live progress element; polls until the build finishes, then calls onDone. */
function buildProgressView(onDone) {
  const barFill = h('div', {});
  const bar = h('div', { class: 'progress', style: 'height:10px; margin:12px 0 8px' }, barFill);
  const line1 = h('div', { class: 'muted', style: 'text-align:center' }, 'Starting download…');
  const line2 = h('div', { class: 'muted small', style: 'text-align:center' }, '');
  const wrap = h('div', { class: 'build-progress' }, bar, line1, line2);

  async function tick() {
    const status = await getBuildStatus();
    if (!status) return;
    const p = status.progress || {};
    if (status.running) {
      const pct = p.setTotal ? Math.round(((p.setsDone || 0) / p.setTotal) * 100) : 0;
      barFill.style.width = pct + '%';
      if (status.phase === 'hashes') {
        line1.textContent = 'Building the card scanner index…';
        line2.textContent = 'almost done';
      } else {
        line1.textContent = `Downloading sets: ${p.setsDone || 0} / ${p.setTotal || '…'}${p.langCount > 1 ? `  (language ${(p.langIndex || 0) + 1}/${p.langCount})` : ''}`;
        line2.textContent = `${(p.imagesDownloaded || 0).toLocaleString()} images downloaded${p.setName ? ` · now: ${p.setName}` : ''}`;
      }
    } else {
      stopBuildPoll();
      if (status.error || (p && p.error)) {
        line1.textContent = 'Download failed: ' + (status.error || p.error);
        line2.textContent = 'It is safe to retry — the download resumes where it stopped.';
      } else {
        barFill.style.width = '100%';
        line1.textContent = 'Card database ready!';
        line2.textContent = status.hashesOk === false ? 'Scanner index skipped (sharp not available) — everything else works.' : '';
        clearDataCaches();
        if (onDone) onDone();
      }
    }
  }
  stopBuildPoll();
  buildPollTimer = setInterval(tick, 2000);
  tick();
  return wrap;
}

/** Shown on the main page when the app has no card database yet. */
async function renderBootstrap() {
  const status = await getBuildStatus();
  const panel = h('div', { class: 'center', style: 'max-width:460px; margin:40px auto' });

  const showProgress = () => {
    panel.replaceChildren(
      h('h2', {}, 'Building your card database'),
      buildProgressView(() => { toast('Card database ready'); renderHome(); }),
      h('p', { class: 'muted small', style: 'margin-top:14px' }, 'Sets appear as they finish — you can start browsing before the download completes.'),
      h('button', { class: 'btn ghost small', onclick: () => renderHome() }, 'Browse what’s ready'),
    );
  };

  if (status && status.running) {
    showProgress();
  } else {
    panel.replaceChildren(
      h('h2', {}, 'Welcome! Let’s get your cards'),
      h('p', { class: 'muted' }, 'This tracker hosts its own card database. One download pulls every set and card image to this server — after that, no third-party services are ever contacted.'),
      h('p', { class: 'muted small' }, 'The full database is a few hundred MB of images and can take a while. It downloads in the background and resumes if interrupted.'),
      h('button', { class: 'btn', style: 'margin-top:8px', onclick: async (e) => {
        e.target.disabled = true;
        try {
          await startDatabaseBuild();
          showProgress();
        } catch (err) {
          e.target.disabled = false;
          toast(err.message);
        }
      } }, '⬇️ Download card database'),
    );
  }
  view.replaceChildren(panel);
}

/* ============================================================
 * Pages — Sets home
 * ============================================================ */
async function renderHome() {
  view.replaceChildren(spinner());
  let sets;
  try {
    sets = await getSets();
  } catch (e) {
    await detectServer(); // make sure we know whether a server is present
    if (e.notFound && serverAvailable && !isRemoteCdn()) {
      renderBootstrap(); // no local database yet — offer the in-app download
    } else {
      view.replaceChildren(dbErrorView('Could not load the card database.', e, renderHome));
    }
    return;
  }

  // a download may still be running (first build or admin update) — show it
  let runningBanner = null;
  if (serverAvailable) {
    const status = await getBuildStatus();
    if (status && status.running) {
      runningBanner = h('div', { class: 'stat', style: 'margin-bottom:14px; text-align:left; padding:10px 14px' },
        buildProgressView(() => { toast('Card database updated'); clearDataCaches(); renderHome(); }));
    }
  }

  let setSort = lsGet('ptcg.sort.sets') || 'newest';
  const orderedSets = () => {
    if (setSort === 'name') return [...sets].sort((a, b) => a.name.localeCompare(b.name));
    if (setSort === 'oldest') return [...sets]; // index order = release order
    return [...sets].reverse(); // newest first
  };
  let ordered = orderedSets();
  const counts = ownedCountsBySet();

  const totalOwned = Object.keys(collection).filter(ownedAny).length;
  const completeSets = ordered.filter((s) => {
    const total = s.cardCount && (s.cardCount.official || s.cardCount.total);
    return total && (counts[s.id] || 0) >= total;
  }).length;

  const banner = h('div', { class: 'stats-banner', id: 'stats-banner' },
    h('div', { class: 'stat' }, h('div', { class: 'num', id: 'stat-owned' }, String(totalOwned)), h('div', { class: 'lbl' }, 'cards owned')),
    h('div', { class: 'stat' }, h('div', { class: 'num', id: 'stat-complete' }, String(completeSets)), h('div', { class: 'lbl' }, 'sets completed')),
    h('div', { class: 'stat' }, h('div', { class: 'num' }, String(ordered.length)), h('div', { class: 'lbl' }, 'sets total')),
  );

  const grid = h('div', { class: 'set-grid' });
  const filterInput = h('input', {
    type: 'search', placeholder: 'Filter sets…', 'aria-label': 'Filter sets',
    oninput: () => renderSetCards(filterInput.value.trim().toLowerCase()),
  });

  function renderSetCards(filter) {
    grid.replaceChildren();
    for (const s of ordered) {
      if (filter && !s.name.toLowerCase().includes(filter)) continue;
      const total = (s.cardCount && (s.cardCount.official || s.cardCount.total)) || 0;
      const owned = counts[s.id] || 0;
      const pct = total ? Math.min(100, Math.round((owned / total) * 100)) : 0;
      const done = total > 0 && owned >= total;
      const logo = setLogo(s);
      grid.append(h('a', { class: 'set-card' + (done ? ' complete' : ''), href: '#/set/' + encodeURIComponent(s.id) },
        logo
          ? h('img', { class: 'logo', src: logo, alt: '', loading: 'lazy', onerror: (e) => { e.target.outerHTML = '<div class="logo placeholder">🎴</div>'; } })
          : h('div', { class: 'logo placeholder' }, '🎴'),
        h('div', { class: 'info' },
          h('div', { class: 'name' }, s.name),
          h('div', { class: 'count' }, `${owned} / ${total || '?'}${done ? ' ✓ complete' : ''}`),
          h('div', { class: 'progress' + (done ? ' done' : '') }, h('div', { style: `width:${pct}%` })),
        ),
      ));
    }
    if (!grid.children.length) grid.append(h('div', { class: 'center' }, 'No sets match.'));
  }
  renderSetCards('');

  const sortCtl = sortSelect(
    [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['name', 'Name A–Z']],
    setSort,
    (v) => { setSort = v; lsSet('ptcg.sort.sets', v); ordered = orderedSets(); renderSetCards(filterInput.value.trim().toLowerCase()); },
  );

  view.replaceChildren(...(runningBanner ? [runningBanner] : []), banner,
    h('div', { class: 'set-filter' }, filterInput),
    h('div', { class: 'chips' }, sortCtl),
    grid);
}

function updateStatsBanner() {
  const el = document.getElementById('stat-owned');
  if (el) el.textContent = String(Object.keys(collection).filter(ownedAny).length);
}

/* ============================================================
 * Pages — single set (with master-set mode)
 * ============================================================ */
async function renderSetPage(setId) {
  view.replaceChildren(spinner());
  let set;
  try {
    await getCustomVariants();
    set = await getSet(setId);
  } catch (e) {
    view.replaceChildren(dbErrorView('Could not load this set.', e, () => renderSetPage(setId)));
    return;
  }

  const cards = set.cards || [];
  const officialTotal = (set.cardCount && (set.cardCount.official || set.cardCount.total)) || cards.length;
  let filter = 'all';
  let master = false;
  let query = '';
  let cardSort = lsGet('ptcg.sort.cards') || 'number';

  const progressLabel = h('span', { class: 'muted' });
  const progressBar = h('div', {});
  const progressWrap = h('div', { class: 'progress', style: 'flex:1; min-width:140px' }, progressBar);

  function updateProgress() {
    let owned, total;
    if (master) {
      // master set: every printing of every card counts separately
      owned = 0; total = 0;
      for (const c of cards) {
        const avail = realVariants(c);
        total += avail.length;
        owned += avail.filter((v) => variantQty(c.id, v) > 0).length;
      }
    } else {
      owned = cards.filter((c) => ownedAny(c.id)).length;
      total = officialTotal;
    }
    progressLabel.textContent = `${owned} / ${total}${master ? ' variants' : ''}`;
    const pct = total ? Math.min(100, Math.round((owned / total) * 100)) : 0;
    progressBar.style.width = pct + '%';
    progressWrap.classList.toggle('done', total > 0 && owned >= total);
  }

  const grid = h('div', { class: 'card-grid' });

  function renderGrid() {
    grid.replaceChildren();
    const q = query.toLowerCase();
    const sorted = sortCards(cards, cardSort, (c) => c.id, (c) => c.name);
    for (const c of sorted) {
      if (q && !c.name.toLowerCase().includes(q) && String(c.localId) !== q) continue;
      for (const vk of realVariants(c)) { // each printing is its own tile
        const owned = variantQty(c.id, vk) > 0;
        if (filter === 'owned' && !owned) continue;
        if (filter === 'missing' && owned) continue;
        grid.append(cardTile(c, vk, { onOwnershipChange: updateProgress }));
      }
    }
    if (!grid.children.length) grid.append(h('div', { class: 'center' }, 'No cards match.'));
  }

  const chip = (label, isActive, onClick) => h('button', {
    class: 'chip' + (isActive ? ' active' : ''),
    onclick: onClick,
  }, label);

  const chipsWrap = h('div', { class: 'chips' });
  function renderChips() {
    chipsWrap.replaceChildren(
      chip('All', filter === 'all', () => { filter = 'all'; renderChips(); renderGrid(); }),
      chip('Owned', filter === 'owned', () => { filter = 'owned'; renderChips(); renderGrid(); }),
      chip('Missing', filter === 'missing', () => { filter = 'missing'; renderChips(); renderGrid(); }),
      chip('Master set', master, () => { master = !master; renderChips(); updateProgress(); }),
      sortSelect([['number', 'Card number'], ['name', 'Name A–Z']], cardSort,
        (v) => { cardSort = v; lsSet('ptcg.sort.cards', v); renderGrid(); }),
    );
  }

  const searchInput = h('input', {
    type: 'search', placeholder: `Search in ${set.name}…`, 'aria-label': 'Search in set',
    oninput: (e) => { query = e.target.value.trim(); renderGrid(); },
  });

  view.replaceChildren(
    h('a', { class: 'back-link', href: '#/' }, '← All sets'),
    h('div', { class: 'page-head' },
      h('h1', {}, set.name),
      progressLabel,
      progressWrap,
    ),
    h('div', { class: 'set-filter' }, searchInput),
    chipsWrap,
    grid,
  );
  renderChips();
  updateProgress();
  renderGrid();
}

/* ============================================================
 * Pages — Pokémon (all printings of each species, via dex number)
 * ============================================================ */
async function renderPokemonList() {
  view.replaceChildren(spinner());
  let idx;
  try {
    idx = await getSearchIndex();
  } catch (e) {
    view.replaceChildren(dbErrorView('Could not load the card database.', e, route));
    return;
  }

  const list = h('div', { class: 'set-grid' });
  const filterInput = h('input', {
    type: 'search', placeholder: 'Find a Pokémon…', 'aria-label': 'Find a Pokémon',
    oninput: () => renderList(filterInput.value.trim().toLowerCase()),
  });

  function renderList(filter) {
    list.replaceChildren();
    for (const sp of idx.species) {
      if (filter && !sp.name.toLowerCase().includes(filter) && String(sp.dex) !== filter) continue;
      const owned = sp.cards.filter(([id]) => ownedAny(id)).length;
      const total = sp.cards.length;
      const done = owned >= total;
      const withImg = sp.cards.find(([, , , , hasImg]) => hasImg);
      const thumb = withImg ? cardImg(briefFromRow(withImg)) : null;
      const pct = total ? Math.round((owned / total) * 100) : 0;
      list.append(h('a', { class: 'set-card' + (done ? ' complete' : ''), href: '#/pokemon/' + sp.dex },
        thumb
          ? h('img', { class: 'logo poke-thumb', src: thumb, alt: '', loading: 'lazy' })
          : h('div', { class: 'logo placeholder' }, '❔'),
        h('div', { class: 'info' },
          h('div', { class: 'name' }, `#${String(sp.dex).padStart(3, '0')} ${sp.name}`),
          h('div', { class: 'count' }, `${owned} / ${total} cards${done ? ' ✓' : ''}`),
          h('div', { class: 'progress' + (done ? ' done' : '') }, h('div', { style: `width:${pct}%` })),
        ),
      ));
    }
    if (!list.children.length) list.append(h('div', { class: 'center' }, 'No Pokémon match.'));
  }
  renderList('');

  view.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Pokémon')),
    h('p', { class: 'muted', style: 'margin-top:0' }, 'Every printing of each Pokémon, across all sets.'),
    h('div', { class: 'set-filter' }, filterInput),
    list,
  );
}

async function renderPokemonPage(dexStr) {
  view.replaceChildren(spinner());
  const dex = parseInt(dexStr, 10);
  let idx;
  try {
    idx = await getSearchIndex();
  } catch (e) {
    view.replaceChildren(dbErrorView('Could not load the card database.', e, route));
    return;
  }
  await getIndex(); // ensures set ordering/names are available
  await getCustomVariants();
  const sp = idx.species.find((s) => s.dex === dex);
  if (!sp) {
    view.replaceChildren(h('div', { class: 'center' }, 'No cards found for this Pokémon.'));
    return;
  }

  const progressLabel = h('span', { class: 'muted' });
  function updateProgress() {
    progressLabel.textContent = `${sp.cards.filter(([id]) => ownedAny(id)).length} / ${sp.cards.length} owned`;
  }

  const grid = h('div', { class: 'card-grid' });
  let pokeSort = lsGet('ptcg.sort.pokemon') || 'newest';

  function renderGrid() {
    grid.replaceChildren();
    const rows = sortCards(sp.cards, pokeSort, (row) => row[0], (row) => row[1]);
    for (const row of rows) {
      const c = briefFromRow(row);
      for (const vk of realVariants(c)) {
        grid.append(cardTile(c, vk, { onOwnershipChange: updateProgress }));
      }
    }
  }
  renderGrid();

  view.replaceChildren(
    h('a', { class: 'back-link', href: '#/pokemon' }, '← All Pokémon'),
    h('div', { class: 'page-head' },
      h('h1', {}, `#${String(sp.dex).padStart(3, '0')} ${sp.name}`),
      progressLabel,
    ),
    h('div', { class: 'chips' },
      sortSelect([['newest', 'Newest set'], ['oldest', 'Oldest set'], ['name', 'Name A–Z'], ['number', 'Card number']], pokeSort,
        (v) => { pokeSort = v; lsSet('ptcg.sort.pokemon', v); renderGrid(); }),
    ),
    grid,
  );
  updateProgress();
}

/* ============================================================
 * Pages — global search
 * ============================================================ */
async function renderSearchPage(rawQuery) {
  const query = decodeURIComponent(rawQuery || '');
  view.replaceChildren(spinner());
  let idx;
  try {
    idx = await getSearchIndex(); // provides real rarity/type lists from the data
    await getCustomVariants();
  } catch (e) {
    view.replaceChildren(dbErrorView('Could not load the card database.', e, route));
    return;
  }
  let rarity = '', type = '', page = 1;
  let searchSort = lsGet('ptcg.sort.search') || 'newest';
  const results = h('div', { class: 'card-grid' });
  const status = h('div', { class: 'center' });
  const moreBtn = h('button', { class: 'btn ghost load-more', onclick: () => load(false) }, 'Load more');
  moreBtn.hidden = true;

  const select = (label, options, onchange) => h('select', { class: 'chip', 'aria-label': label, onchange: (e) => onchange(e.target.value) },
    h('option', { value: '' }, label),
    ...options.map((o) => h('option', { value: o }, o)));

  async function load(reset) {
    if (reset) { page = 1; results.replaceChildren(); }
    status.replaceChildren(spinner());
    moreBtn.hidden = true;
    try {
      const cards = await searchCards({ name: query, rarity, type, sort: searchSort, page, perPage: 100 });
      status.replaceChildren();
      if (!cards.length && page === 1) {
        status.textContent = 'No cards found.';
      } else {
        for (const c of cards) {
          for (const vk of realVariants(c)) results.append(cardTile(c, vk));
        }
        if (cards.length === 100) { moreBtn.hidden = false; page++; }
      }
    } catch (e) {
      status.textContent = 'Search failed: ' + e.message;
    }
  }

  view.replaceChildren(
    h('a', { class: 'back-link', href: '#/' }, '← All sets'),
    h('div', { class: 'page-head' }, h('h1', {}, query ? `Search: “${query}”` : 'Browse cards')),
    h('div', { class: 'chips' },
      select('Rarity', idx.rarities, (v) => { rarity = v; load(true); }),
      select('Type', idx.types, (v) => { type = v; load(true); }),
      sortSelect([['newest', 'Newest set'], ['oldest', 'Oldest set'], ['name', 'Name A–Z'], ['number', 'Card number']], searchSort,
        (v) => { searchSort = v; lsSet('ptcg.sort.search', v); load(true); }),
    ),
    results,
    status,
    moreBtn,
  );
  load(true);
}

/* ============================================================
 * Pages — card scanner (offline perceptual-hash matching)
 * ============================================================ */
/* IMPORTANT: this box-average + dHash algorithm is duplicated in
 * scripts/build-hashes.js and must stay behavior-identical — exact area
 * averages over full-resolution pixels, no canvas/library resizing in
 * the hash path — so browser hashes match the prebuilt scan index. */
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

function bitsToHex(bits) {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16);
  }
  return hex;
}

function computeCardHash(source) {
  // horizontal dHash on 9x8 + vertical dHash on 8x9 → 128 bits / 32 hex chars
  const W = source.videoWidth || source.naturalWidth || source.width;
  const H = source.videoHeight || source.naturalHeight || source.height;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, W, H);
  const rgba = ctx.getImageData(0, 0, W, H).data;
  const gx = boxGrid(rgba, W, H, 9, 8);
  const bx = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bx.push(gx[y * 9 + x] < gx[y * 9 + x + 1] ? 1 : 0);
  const gy = boxGrid(rgba, W, H, 8, 9);
  const by = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) by.push(gy[y * 8 + x] < gy[(y + 1) * 8 + x] ? 1 : 0);
  return bitsToHex(bx) + bitsToHex(by);
}

const POPCOUNT = new Uint8Array(16).map((_, i) => (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1));
function hammingHex(a, b) {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += POPCOUNT[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return d + Math.abs(a.length - b.length) * 4;
}

async function getScanIndex() {
  if (!_scanIndexCache) _scanIndexCache = await cdnGet(`${DB()}/scan-index.json`);
  return _scanIndexCache;
}

/** Identify a card from any drawable source. Returns top matches [{id, distance}]. */
async function identifyCard(source, topN = 5) {
  const idx = await getScanIndex();
  const hash = computeCardHash(source);
  const scored = [];
  for (const [id, cardHash] of idx.cards) {
    scored.push({ id, distance: hammingHex(hash, cardHash) });
  }
  scored.sort((a, b) => a.distance - b.distance);
  return scored.slice(0, topN);
}
window.__ptcgIdentify = identifyCard; // used by automated tests

let scanStream = null;
function stopScanner() {
  if (scanStream) {
    scanStream.getTracks().forEach((t) => t.stop());
    scanStream = null;
  }
}

async function renderScanPage() {
  stopScanner();
  const resultsEl = h('div', {});
  const statusEl = h('p', { class: 'muted', style: 'text-align:center' }, 'Point your camera at a card, line it up with the frame, and capture.');

  async function showMatches(source) {
    resultsEl.replaceChildren(spinner());
    let matches, idxRows;
    try {
      await getIndex(); // set names for the result list
      await getCustomVariants();
      matches = await identifyCard(source, 5);
      idxRows = new Map((await getSearchIndex()).cards.map((row) => [row[0], row]));
    } catch (e) {
      resultsEl.replaceChildren(h('div', { class: 'center' },
        h('p', {}, 'Scanning needs the scan index.'),
        h('p', { class: 'small' }, e.message + ' — run "node scripts/build-hashes.js" after downloading images.')));
      return;
    }
    const setNames = new Map((_indexCache ? _indexCache.sets : []).map((s) => [s.id, s.name]));
    const strong = matches.length && matches[0].distance <= 22;
    resultsEl.replaceChildren(
      h('h3', { style: 'margin:14px 0 8px' }, strong ? 'Best matches' : 'Closest matches (low confidence — try better lighting)'),
      h('div', { class: 'scan-results' },
        matches.map(({ id, distance }) => {
          const row = idxRows.get(id);
          const brief = row ? briefFromRow(row) : { id, name: id, localId: localIdOf(id) };
          const owned = ownedAny(id);
          const item = h('div', { class: 'scan-result' + (owned ? ' have' : ''), role: 'button', tabindex: '0',
            onclick: () => openCardModal(brief, { onOwnershipChange: () => decorate() }) },
            cardImg(brief) ? h('img', { src: cardImg(brief), alt: brief.name }) : h('div', { class: 'logo placeholder' }, '🃏'),
            h('div', { class: 'info' },
              h('div', { class: 'name' }, brief.name),
              h('div', { class: 'count' }, `${setNames.get(setIdOf(id)) || setIdOf(id)} · #${brief.localId}`),
              h('div', { class: 'own-status' }, owned ? `✓ You have this (×${totalQty(id)})` : 'Not in your collection'),
            ),
            h('div', { class: 'match-score' }, `${Math.max(0, Math.round(100 - (distance / 64) * 100))}%`),
          );
          function decorate() {
            const owned2 = ownedAny(id);
            item.classList.toggle('have', owned2);
            item.querySelector('.own-status').textContent = owned2 ? `✓ You have this (×${totalQty(id)})` : 'Not in your collection';
          }
          return item;
        }),
      ),
    );
  }

  // photo upload path (always available; on phones this can open the camera too)
  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true,
    onchange: (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const img = new Image();
      img.onload = () => { showMatches(img); URL.revokeObjectURL(img.src); };
      img.src = URL.createObjectURL(f);
      e.target.value = '';
    } });

  const container = h('div', {},
    h('div', { class: 'page-head' }, h('h1', {}, 'Scan a card')),
    statusEl,
  );

  // live camera path
  const video = h('video', { class: 'scan-video', autoplay: '', playsinline: '', muted: '' });
  const guide = h('div', { class: 'scan-guide' });
  const videoWrap = h('div', { class: 'scan-stage' }, video, guide);
  const captureBtn = h('button', { class: 'btn', style: 'width:100%; margin-top:10px', onclick: () => {
    if (!video.videoWidth) return;
    // crop the guide region (centered, card aspect 63:88, 70% of stage height)
    const vw = video.videoWidth, vh = video.videoHeight;
    const gh = vh * 0.7, gw = gh * (63 / 88);
    const gx = (vw - gw) / 2, gy = (vh - gh) / 2;
    const c = document.createElement('canvas');
    c.width = 300; c.height = 420;
    c.getContext('2d').drawImage(video, gx, gy, gw, gh, 0, 0, 300, 420);
    showMatches(c);
  } }, '📷 Capture');

  let cameraOk = false;
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = scanStream;
      cameraOk = true;
    } catch { /* denied or unavailable */ }
  }

  if (cameraOk) {
    container.append(videoWrap, captureBtn,
      h('button', { class: 'btn ghost', style: 'width:100%; margin-top:8px', onclick: () => fileInput.click() }, 'Use a photo instead'));
  } else {
    statusEl.textContent = 'Camera unavailable (needs HTTPS and permission) — you can still scan from a photo.';
    container.append(h('button', { class: 'btn', style: 'width:100%', onclick: () => fileInput.click() }, '📁 Choose / take a photo'));
  }
  container.append(fileInput, resultsEl);
  view.replaceChildren(container);
}

/* ============================================================
 * Pages — debug / diagnostics
 * ============================================================ */
async function renderDebugPage() {
  const rows = h('div', {});
  view.replaceChildren(
    h('a', { class: 'back-link', href: '#/' }, '← Back'),
    h('div', { class: 'page-head' }, h('h1', {}, 'Debug info')),
    rows,
    h('div', { class: 'row', style: 'margin-top:16px' },
      h('button', { class: 'btn', onclick: repairApp }, 'Repair & reload (clear cached app + data)'),
    ),
  );

  const line = (label, value, ok) => rows.append(h('div', { class: 'kv' },
    h('span', {}, label),
    h('span', { style: ok === false ? 'color:#ff7b6b' : (ok === true ? 'color:var(--owned)' : '') }, String(value))));

  line('App version', APP_VERSION);
  line('Data location (cdnBase)', CDN);
  line('Language', lang);
  line('Service worker', 'serviceWorker' in navigator ? (navigator.serviceWorker.controller ? 'controlling this page' : 'registered, not controlling yet') : 'unsupported');

  const probe = async (label, url) => {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      line(label, res.ok ? `OK (${res.status})` : `HTTP ${res.status}`, res.ok);
      return res;
    } catch {
      line(label, 'unreachable', false);
      return null;
    }
  };

  await probe('languages.json', `${CDN}/languages.json`);
  const idxRes = await probe(`${lang}/index.json`, `${DB()}/index.json`);
  await probe(`${lang}/search-index.json`, `${DB()}/search-index.json`);
  await probe(`${lang}/scan-index.json (scanner)`, `${DB()}/scan-index.json`);

  if (idxRes && idxRes.ok) {
    try {
      const idx = await idxRes.json();
      line('Sets in index', idx.sets.length, idx.sets.length > 0);
      line('Image qualities', (idx.qualities || []).join(', ') || 'none (data-only)');
      if (idx.sets[0]) {
        const first = idx.sets[0].id;
        const setRes = await probe(`first set file (${first}.json)`, `${DB()}/sets/${encodeURIComponent(first)}.json`);
        if (setRes && setRes.ok) {
          const setData = await setRes.json();
          const hasV3 = (setData.cards || []).some((c) => c.variants || c.category || (c.dexId && c.dexId.length));
          line('Data has variant/Pokédex info', hasV3 ? 'yes' : 'NO — data is from an older version. Re-run "node scripts/build-data.js" (your images are kept).', hasV3);
        }
      }
    } catch { line('index.json parse', 'failed', false); }
  } else {
    // maybe the data is in the old flat layout?
    try {
      const old = await fetch(`${CDN}/index.json`, { cache: 'no-store' });
      if (old.ok) line('Old-format data detected', `found ${CDN}/index.json (pre-language layout). Re-run "node scripts/build-data.js" — it migrates automatically and keeps your images.`, false);
    } catch { /* nothing there either */ }
  }
}

/* ============================================================
 * Account modal + language
 * ============================================================ */
const accountModal = document.getElementById('account-modal');

async function renderLanguageArea() {
  const area = document.getElementById('language-area');
  const langs = await getLanguages();
  if (langs.length <= 1) { area.replaceChildren(); return; }
  area.replaceChildren(
    h('hr'),
    h('h3', {}, 'Card language'),
    h('p', { class: 'muted small' }, 'Your collection is shared across languages — only names and images change.'),
    h('select', { class: 'chip', 'aria-label': 'Card language', onchange: async (e) => {
      lang = e.target.value;
      lsSet('ptcg.lang', lang);
      clearDataCaches();
      toast('Language switched');
      route();
    } }, ...langs.map((l) => {
      const o = h('option', { value: l.code }, l.name || l.code);
      if (l.code === lang) o.setAttribute('selected', '');
      return o;
    })),
  );
}

/** Administration section (first registered account): update the card database. */
async function renderAdminArea() {
  const area = document.getElementById('admin-area');
  area.replaceChildren();
  if (!serverAvailable || !auth) return;
  let me;
  try { me = await apiCall('me'); } catch { return; }
  if (!me.admin) return;

  const content = h('div', {});
  area.append(h('hr'), h('h3', {}, 'Administration'), content);

  if (isRemoteCdn()) {
    content.replaceChildren(h('p', { class: 'muted small' },
      'This instance reads its card database from a CDN (', CDN, '). Update the database on the master instance and re-publish — nothing to manage here.'));
    return;
  }

  async function renderControls() {
    const status = await getBuildStatus();
    if (status && status.running) {
      content.replaceChildren(
        h('p', { class: 'muted small' }, 'Card database update in progress:'),
        buildProgressView(() => { toast('Card database updated'); renderControls(); }),
      );
      return;
    }
    content.replaceChildren(
      h('p', { class: 'muted small' }, 'Re-runs the card downloader: picks up newly released sets and missing images, then refreshes the scanner index. Existing files are skipped, so updates are quick.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: async (e) => {
          e.target.disabled = true;
          try {
            await startDatabaseBuild();
            renderControls();
          } catch (err) {
            e.target.disabled = false;
            toast(err.message);
          }
        } }, '🔄 Update card database'),
      ),
      status && status.progress && status.progress.finishedAt
        ? h('p', { class: 'muted small', style: 'margin-top:8px' }, 'Last completed: ' + new Date(status.progress.finishedAt).toLocaleString())
        : null,
    );
  }
  renderControls();
}

function renderAccountModal() {
  const statusEl = document.getElementById('account-status');
  const formsEl = document.getElementById('account-forms');
  renderLanguageArea();
  renderAdminArea();

  if (!serverAvailable) {
    statusEl.replaceChildren(h('p', { class: 'muted' },
      'Cloud sync is available when this app is hosted with its bundled server. Right now it’s running standalone, so your collection lives on this device — use Export below for backups.'));
    formsEl.replaceChildren();
    return;
  }

  if (auth) {
    statusEl.replaceChildren(
      h('p', {}, `Signed in as `, h('strong', {}, auth.username), '.'),
      h('p', { class: 'muted small' }, syncState === 'error' ? 'Last sync failed — changes are saved locally and will retry.' : 'Your collection syncs to this server automatically.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: async () => { try { await pullAndMerge(); toast('Synced'); renderAccountModal(); } catch (e) { toast('Sync failed: ' + e.message); } } }, 'Sync now'),
        h('button', { class: 'btn ghost small', onclick: () => { logout(); renderAccountModal(); } }, 'Sign out'),
      ),
    );
    formsEl.replaceChildren();
    return;
  }

  statusEl.replaceChildren(h('p', { class: 'muted' }, 'Sign in to sync your collection across devices using this server.'));

  let mode = 'login';
  const err = h('div', { class: 'error-msg' });
  const userIn = h('input', { type: 'text', placeholder: 'Username', autocomplete: 'username' });
  const passIn = h('input', { type: 'password', placeholder: 'Password (8+ characters)', autocomplete: 'current-password' });
  const submit = h('button', { class: 'btn', style: 'width:100%' }, 'Sign in');

  const tabs = h('div', { class: 'tabs' },
    h('button', { type: 'button', class: 'active', onclick: (e) => switchMode('login', e.target) }, 'Sign in'),
    h('button', { type: 'button', onclick: (e) => switchMode('register', e.target) }, 'Create account'),
  );

  function switchMode(m, btn) {
    mode = m;
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    submit.textContent = m === 'login' ? 'Sign in' : 'Create account';
    err.textContent = '';
  }

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        await doAuth(mode, userIn.value.trim(), passIn.value);
        toast(mode === 'login' ? 'Signed in — collection synced' : 'Account created — collection synced');
        renderAccountModal();
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        submit.disabled = false;
      }
    },
  },
    tabs,
    h('div', { class: 'field' }, userIn),
    h('div', { class: 'field' }, passIn),
    err,
    submit,
  );
  formsEl.replaceChildren(form);
}

/* ============================================================
 * Export / import
 * ============================================================ */
function exportCollection() {
  const blob = new Blob([JSON.stringify({
    app: 'pokemon-tcg-tracker',
    version: 2,
    exportedAt: new Date().toISOString(),
    collection,
  }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pokemon-collection-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Collection exported');
}

function importCollection(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const incoming = data.collection || data; // accept bare maps too
      if (typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('not a collection file');
      const before = Object.keys(collection).length;
      collection = mergeCollections(collection, incoming);
      saveCollection();
      updateStatsBanner();
      rerenderCards();
      toast(`Imported — ${Object.keys(collection).length - before} new cards added`);
      route(); // refresh current page counts
    } catch {
      toast('Import failed: that file doesn’t look like a collection backup');
    }
  };
  reader.readAsText(file);
}

/* ============================================================
 * Router & init
 * ============================================================ */
function route() {
  const hash = location.hash.slice(1) || '/';
  stopScanner(); // release the camera when leaving the scan page
  stopBuildPoll(); // pages restart their own progress polling if needed
  const setMatch = hash.match(/^\/set\/(.+)$/);
  const searchMatch = hash.match(/^\/search\/(.*)$/);
  const pokeMatch = hash.match(/^\/pokemon\/(\d+)$/);
  let nav = 'sets';
  if (setMatch) renderSetPage(decodeURIComponent(setMatch[1]));
  else if (searchMatch) renderSearchPage(searchMatch[1]);
  else if (hash === '/pokemon') { nav = 'pokemon'; renderPokemonList(); }
  else if (pokeMatch) { nav = 'pokemon'; renderPokemonPage(pokeMatch[1]); }
  else if (hash === '/scan') { nav = 'scan'; renderScanPage(); }
  else if (hash === '/debug') renderDebugPage();
  else renderHome();
  document.querySelectorAll('.bottomnav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);

document.getElementById('global-search').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = document.getElementById('global-search-input').value.trim();
  location.hash = '#/search/' + encodeURIComponent(q);
  document.getElementById('global-search-input').blur();
});

document.getElementById('account-btn').addEventListener('click', () => {
  renderAccountModal();
  accountModal.showModal();
});

document.querySelectorAll('.close-modal').forEach((b) => b.addEventListener('click', (e) => e.target.closest('dialog').close()));

document.querySelectorAll('dialog').forEach((d) => {
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
});

document.getElementById('app-version').textContent = APP_VERSION;
document.getElementById('repair-link').addEventListener('click', (e) => { e.preventDefault(); repairApp(); });
document.querySelectorAll('.close-modal-link').forEach((a) => a.addEventListener('click', () => a.closest('dialog').close()));

document.getElementById('export-btn').addEventListener('click', exportCollection);
document.getElementById('import-btn').addEventListener('click', () => document.getElementById('import-file').click());
document.getElementById('import-file').addEventListener('change', (e) => {
  if (e.target.files[0]) importCollection(e.target.files[0]);
  e.target.value = '';
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

detectServer().then(() => {
  if (auth && serverAvailable) pullAndMerge().catch(() => {});
});
route();
