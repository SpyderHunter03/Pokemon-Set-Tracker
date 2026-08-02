/* Pokémon TCG Tracker — app logic (vanilla JS, no build step) */
'use strict';

const APP_VERSION = '3.52.0';

/* ============================================================
 * Storage helpers
 * ============================================================ */
function lsGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function lsSet(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

/* ============================================================
 * Card data provider — reads the catalog from the bundled server,
 * which serves it from its SQLite database. Each card carries its
 * image locations as full URLs (a remote CDN like R2, or a local
 * path this server serves once images are downloaded/uploaded).
 * ============================================================ */
let appConfig = {};
async function loadAppConfig() {
  try {
    const res = await fetch('api/app-config', { cache: 'no-store' });
    if (res.ok) appConfig = await res.json();
  } catch { /* no server reachable */ }
}
let lang = lsGet('ptcg.lang') || (self.PTCG_CONFIG && self.PTCG_CONFIG.defaultLanguage) || 'en';

/** Fetch a catalog resource from the server (served from its database). */
async function catGet(pathAndQuery) {
  let res;
  try {
    res = await fetch('api/catalog/' + pathAndQuery, { cache: 'no-store' });
  } catch {
    const e = new Error('Could not reach the card database server.');
    e.dbError = true;
    throw e;
  }
  if (res.status === 404) {
    const e = new Error('Not found: ' + pathAndQuery);
    e.dbError = true; e.notFound = true;
    throw e;
  }
  if (!res.ok) {
    const e = new Error('Card database error ' + res.status);
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

function clearDataCaches() {
  _indexCache = null;
  _searchCache = null;
  _setDetailCache.clear();
  _scanIndexCache = null;
}

async function getIndex() {
  if (_indexCache) return _indexCache;
  _indexCache = await catGet('index?lang=' + encodeURIComponent(lang));
  return _indexCache;
}

async function getSets() {
  return (await getIndex()).sets;
}

async function getSet(id) {
  if (_setDetailCache.has(id)) return _setDetailCache.get(id);
  const set = await catGet('set?lang=' + encodeURIComponent(lang) + '&id=' + encodeURIComponent(id));
  _setDetailCache.set(id, set);
  return set;
}

const _nat = new Map();   // img url -> natural size
const natSize = (src) => _nat.get(src) || null;
function loadNat(src) {
  if (_nat.has(src)) return Promise.resolve(_nat.get(src));
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => { _nat.set(src, { w: im.naturalWidth || 1, h: im.naturalHeight || 1 }); resolve(_nat.get(src)); };
    im.onerror = () => { _nat.set(src, { w: 1, h: 1 }); resolve(_nat.get(src)); };
    im.src = src;
  });
}

/** paint an adjusted cover picture: view is in cover-units (100 = element
 * width), so the same placement scales to the book page and the list tile */
function coverArtCss(el, img, v, flip) {
  loadNat(img).then((nat) => requestAnimationFrame(() => {
    const pw = (el.clientWidth || 300) / 100;
    const frameH = 100 * (el.clientHeight && el.clientWidth ? el.clientHeight / el.clientWidth : 4 / 3);
    const { fx, fy } = flipParts(flip);
    const sH = v.s * (nat.h / nat.w);
    const bx = fx ? (100 - v.s - v.x) : v.x;
    const by = fy ? (frameH - sH - v.y) : v.y;
    const layer = artBgLayer(el);
    layer.style.transform = (fx || fy) ? `scale(${fx ? -1 : 1}, ${fy ? -1 : 1})` : '';
    layer.style.backgroundImage = `url("${img}")`;
    layer.style.backgroundRepeat = 'no-repeat';
    layer.style.backgroundSize = (v.s * pw) + 'px auto';
    layer.style.backgroundPosition = (bx * pw) + 'px ' + (by * pw) + 'px';
  }));
}

/** flip helpers: 'x' | 'y' | 'xy' — mirrored images are treated as the source
 * picture, so all placement math applies to the mirrored picture directly */
const flipParts = (flip) => ({ fx: flip === 'x' || flip === 'xy', fy: flip === 'y' || flip === 'xy' });
const flipOf = (fx, fy) => (fx && fy ? 'xy' : fx ? 'x' : fy ? 'y' : undefined);
/** background layer inside el that can mirror without flipping el's children */
function artBgLayer(el) {
  let layer = el.querySelector(':scope > .art-bg');
  if (!layer) { layer = h('div', { class: 'art-bg' }); el.prepend(layer); }
  return layer;
}

/** Render an unbounded result list in batches of 40 as the panel scrolls —
 * EVERY scrollable list offers every value, loaded incrementally (no caps). */
function chunkedList(results, hits, rowOf, emptyMsg) {
  results.replaceChildren();
  if (!hits.length) { results.append(h('p', { class: 'muted small' }, emptyMsg)); return; }
  results.append(h('p', { class: 'muted small' }, `${hits.length} card${hits.length === 1 ? '' : 's'}`));
  let shown = 0;
  const CHUNK = 40;
  const renderMore = () => {
    const upto = Math.min(shown + CHUNK, hits.length);
    for (; shown < upto; shown++) results.append(rowOf(hits[shown]));
  };
  renderMore();
  results.onscroll = () => {
    if (shown < hits.length && results.scrollTop + results.clientHeight > results.scrollHeight - 300) renderMore();
  };
}

async function getCard(id) {
  const set = await getSet(setIdOf(id));
  return (set.cards || []).find((c) => c.id === id) || { id, name: id };
}

async function getLanguages() {
  if (_languagesCache) return _languagesCache;
  try {
    _languagesCache = (await catGet('languages')).languages || [];
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

/** Search index: card objects (id, name, rarity, types, dexId, category,
 * variants, img, printings, variantImages) served from the DB. */
async function getSearchIndex() {
  if (_searchCache) return _searchCache;
  const raw = await catGet('search?lang=' + encodeURIComponent(lang));
  const rarities = new Set(), types = new Set();
  const species = new Map(); // dexId -> {dex, name, cards: [cardObj]}
  // A card that lists several Pokémon is named after all of them — "Entei &
  // Raikou LEGEND" is not what either of them is called. So a shared name may
  // never name a species while a single-Pokémon card is there to do it. A
  // species holding nothing but shared cards keeps the shared name until a
  // printing of its own turns up: an odd-looking name still beats a blank one.
  const soloNamed = new Set(); // dex numbers named by a one-Pokémon card
  for (const c of raw.cards) {
    if (c.rarity) rarities.add(c.rarity);
    (c.types || []).forEach((t) => t && types.add(t));
    // Every Pokémon the card names, not just the first one listed. A card is
    // filed under each of its Pokédex numbers, so "Celebi & Venusaur-GX" is on
    // Celebi's page and on Venusaur's — which is what the server has always
    // done when filling a binder from a species. Deduplicated, because the
    // same number twice on one card would otherwise count it twice.
    const dexList = [...new Set((c.dexId || []).filter((d) => d))];
    const solo = dexList.length < 2;
    for (const dex of dexList) {
      if (!species.has(dex)) species.set(dex, { dex, name: c.name, cards: [] });
      const sp = species.get(dex);
      sp.cards.push(c);
      if (solo) {
        // any single-Pokémon name beats a shared one; among them, shortest wins
        if (!soloNamed.has(dex) || c.name.length < sp.name.length) sp.name = c.name;
        soloNamed.add(dex);
      } else if (!soloNamed.has(dex) && c.name.length < sp.name.length) {
        sp.name = c.name; // nothing better on offer yet
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

async function searchCards({ name, rarity, type, sort, page = 1, perPage = 100 }) {
  const idx = await getSearchIndex();
  await getIndex(); // set order needed for release-date sorting
  const q = (name || '').toLowerCase();
  let matches = idx.cards.filter((c) =>
    (!q || c.name.toLowerCase().includes(q)) &&
    (!rarity || c.rarity === rarity) &&
    (!type || (c.types || []).includes(type)));
  if (sort) matches = sortCards(matches, sort, (c) => c.id, (c) => c.name);
  // `more` is the honest answer to "is there another page?" — a Load more
  // button that appears and then adds nothing is a button that lied
  const start = (page - 1) * perPage;
  return { cards: matches.slice(start, start + perPage), more: matches.length > start + perPage };
}

/** Image URL for a printing. Each card/printing carries explicit low/high
 * URLs from the database (a remote CDN, or a local path this server serves). */
function cardImg(card, quality = 'low', variant = null) {
  const vi = variant && card.variantImages && card.variantImages[variant];
  if (vi) return vi[quality] || vi.low || vi.high || null;
  if (!card.img) return null;
  return card.img[quality] || card.img.low || card.img.high || null;
}

/** Readable set name from whatever is already in memory — the set page's own
 * detail record first, then the index. Falls back to the raw set id, which
 * ensureSetNames() below comes back and fixes. */
let _setNameMap = null, _setNameFrom = null;
function setNameById(sid) {
  const detail = _setDetailCache.get(sid);
  if (detail && detail.name) return detail.name;
  // `!_setNameMap` matters: before anything loads, _setNameFrom and _indexCache
  // are both null, so the freshness test alone would never build the map
  if (!_setNameMap || _setNameFrom !== _indexCache) {
    _setNameFrom = _indexCache;
    _setNameMap = new Map((((_indexCache && _indexCache.sets) || [])).map((s) => [s.id, s.name]));
  }
  return _setNameMap.get(sid) || sid;
}
function setNameOf(cardId) { return setNameById(setIdOf(cardId)); }

/** Some pages that show cards never need the set index for anything else — a
 * Pokémon's printings, search results — so their captions would sit on the raw
 * "base1" forever. Fetch it once and repaint the captions already on screen. */
let _setNamesPending = false;
function ensureSetNames() {
  if (_indexCache || _setNamesPending) return;
  _setNamesPending = true;
  getIndex()
    .then(() => { for (const el of document.querySelectorAll('.cap-set[data-set]')) el.textContent = setNameById(el.dataset.set); })
    .catch(() => { /* offline — the set id still identifies the card */ })
    .finally(() => { _setNamesPending = false; });
}

/** The "Base Set · #58" strip along the bottom of a card. A collection mixes
 * sets and reprints freely, so the picture alone often can't tell two
 * printings apart — every card that shows a picture says which one it is.
 * @param cls swap in 'print-cap' so the printed version can size itself in mm */
function cardCaption(cid, card, cls = 'pocket-cap') {
  const sid = setIdOf(cid);
  ensureSetNames();
  return h('div', { class: cls },
    h('span', { class: 'cap-set', 'data-set': sid }, setNameById(sid)),
    h('span', { class: 'cap-no' }, '#' + ((card && card.localId) || localIdOf(cid) || '?')),
  );
}

/* ---- card pictures that survive a flaky phone link ----
   A page of results asks for dozens of pictures at once, and over a phone
   connection some of those requests simply never land. The old code replaced
   the tile with a grey placeholder on the FIRST error and never tried again —
   so a moment's bad signal left a wall of grey that only cleared when some
   other page happened to warm the cache. Now a picture gets a few retries with
   backoff, falls back to the other quality, re-tries when the tab or the
   network comes back, and the placeholder can be tapped to try once more. */
const IMG_RETRIES = 3;
const _stalledImages = new Set();

function retryStalledImages() {
  for (const again of [..._stalledImages]) { _stalledImages.delete(again); again(); }
}
window.addEventListener('online', retryStalledImages);
document.addEventListener('visibilitychange', () => { if (!document.hidden) retryStalledImages(); });

/**
 * @param host element that wears the .img-loading spinner while a fetch is in flight
 * @param fallback () => Element shown once the retries are spent (tap to re-arm)
 * @returns the <img>, or null when this printing has no picture at all
 */
function cardImageEl(card, variant, { alt, host, quality = 'low', fallback, lazy = true } = {}) {
  const first = cardImg(card, quality, variant);
  if (!first) return null;
  const second = cardImg(card, quality === 'low' ? 'high' : 'low', variant);
  const urls = second && second !== first ? [first, second] : [first];
  const img = h('img', Object.assign({ src: urls[0], alt: alt || card.name || '', decoding: 'async' },
    lazy ? { loading: 'lazy' } : {}));
  let tries = 0;
  const spin = (on) => { if (host) host.classList.toggle('img-loading', on); };
  const load = () => { spin(true); img.src = urls[tries % urls.length]; };
  img.addEventListener('load', () => { tries = 0; spin(false); });
  img.addEventListener('error', () => {
    spin(false);
    if (++tries <= IMG_RETRIES) {
      setTimeout(() => { if (img.isConnected) load(); }, 250 * tries * tries);
      return;
    }
    if (!fallback) return;                    // nothing better to show than a broken picture
    const ph = fallback();
    ph.classList.add('stalled');
    ph.title = 'Tap to load the picture again';
    const again = (e) => {
      if (e) e.stopPropagation();
      _stalledImages.delete(again);
      tries = 0;
      ph.replaceWith(img);                    // a no-op if the page moved on
      if (img.isConnected) load();
    };
    ph.addEventListener('click', again);
    _stalledImages.add(again);
    img.replaceWith(ph);
  });
  // no loader flash for a picture the browser already has in hand
  requestAnimationFrame(() => { if (!img.complete) spin(true); });
  return img;
}

/** Printing look when no dedicated scan exists: the closest image — the
 * card's base scan (same set, same number) — with the printing's name
 * written across it. The card's primary printing is what the base scan
 * depicts, so it stays clean; real uploaded scans always win. */
/** The printing's name, written diagonally across the card — on EVERY
 * printing, base image and dedicated scans included (uniform labeling). */
function variantFxEl(card, variant) {
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
  // Two promos in the same set both parse to Infinity, and Infinity minus
  // Infinity is NaN — a comparator that answers "neither comes first" scrambles
  // the very order it was asked to fix. Every tie falls through to the printed
  // number as text, which two different cards can never share.
  const byNumber = (a, b) => (numericLocalId(getId(a)) - numericLocalId(getId(b)))
    || String(localIdOf(getId(a))).localeCompare(String(localIdOf(getId(b))));
  const bySet = (a, b, dir) => {
    const d = ((order.get(setIdOf(getId(a))) ?? 0) - (order.get(setIdOf(getId(b))) ?? 0)) * dir;
    return d !== 0 ? d : byNumber(a, b);
  };
  const cmp = {
    name: (a, b) => getName(a).localeCompare(getName(b)) || byNumber(a, b),
    number: byNumber,
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
  return set.logo || null;   // explicit URL from the database
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
  const pr = card && card.printings;   // custom printings carried on the card
  if (pr) for (const key of Object.keys(pr)) {
    if (!avail.includes(key)) avail.push(key);
  }
  // only assume "normal" when the card has no printings at all — a card whose
  // normal printing was removed but keeps a custom one must not resurrect it
  if (!avail.length) avail.push('normal');
  return avail;
}

/** Variants offered in the card detail view: every real printing + the "other/stamped" bucket. */
function availableVariants(card) {
  return [...realVariants(card), 'other'];
}

/** Display label for a variant of a specific card. A "normal" printing of a
 * card that also has a 1st Edition printing is what collectors call "Unlimited". */
function variantLabel(card, vk) {
  const custom = card && card.printings && card.printings[vk];
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
        if (serverAvailable) lsSet('ptcg.serverSeen', true); // remember this is a server-backed install
      } catch { serverAvailable = false; }
      updateAccountButton();
    })();
  }
  return _serverCheckPromise;
}

/** Tracking (ownership, stats, badges, filters) requires a signed-in account.
 * Signing in requires the server, so this is false for logged-out visitors. */
function canTrack() { return !!auth; }

/** The app is meant to run with its bundled server. A bare copy of the files
 * with no server behind it (and no memory of ever having one) can do nothing. */
function serverEverSeen() { return !!lsGet('ptcg.serverSeen'); }

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

/** "Are you sure?" as a panel of the app rather than the browser's own dialog.
 * Every path that throws something away comes through here, so the warning
 * always looks the same and always says what specifically is about to go.
 * Native confirm() couldn't do that job: it's suppressed outright in some
 * standalone PWAs, and where it does appear it reads as a browser warning
 * rather than as part of the app.
 * Cancel holds the focus, and Escape and the backdrop both mean no — the safe
 * answer should be the effortless one.
 * @returns {Promise<boolean>} */
function confirmDestructive({ title, body, confirmLabel = 'Delete', cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (yes) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
      resolve(yes);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(false); } };
    const noBtn = h('button', { class: 'btn ghost', onclick: () => finish(false) }, cancelLabel);
    const ov = h('div', { class: 'picker-overlay confirm-overlay', onclick: (e) => { if (e.target === ov) finish(false); } },
      h('div', { class: 'picker-panel confirm-panel' },
        h('h3', {}, title),
        // the lines are already written as sentences; keep the author's breaks
        ...String(body || '').split('\n').filter((p) => p.trim())
          .map((p) => h('p', { class: 'muted small', style: 'margin:0' }, p)),
        h('div', { class: 'row', style: 'justify-content:flex-end; gap:8px; margin-top:2px' },
          noBtn,
          h('button', { class: 'btn danger', 'data-confirm': '', onclick: () => finish(true) }, confirmLabel))));
    document.addEventListener('keydown', onKey, true);
    // A <dialog> opened with showModal() sits in the browser's top layer, above
    // everything in the document however you stack it — so a confirmation
    // appended to <body> would be drawn *behind* the card modal that asked for
    // it, visible but unclickable. Going inside the dialog puts it back on top.
    const modals = document.querySelectorAll('dialog[open]');
    (modals[modals.length - 1] || document.body).append(ov);
    noBtn.focus();
  });
}

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
      if (!canTrack()) { openCardModal(card, { variant, onOwnershipChange }); return; } // browse-only until signed in
      const result = quickToggle(card, variant);
      if (result === 'complex') { openCardModal(card, { variant, onOwnershipChange }); return; }
      decorateTile(tile, card);
      if (onOwnershipChange) onOwnershipChange();
    },
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tile.click(); } },
  });
  tile.dataset.cardId = card.id;
  tile.dataset.variant = variant;
  const imgEl = cardImageEl(card, variant, { host: tile, fallback: () => placeholderContent(card) });
  tile.append(imgEl || placeholderContent(card));
  tile.append(variantFxEl(card, variant));   // every tile banners its printing
  // which printing this actually is — same strip the binder shows, now on
  // every card everywhere, because a picture alone doesn't say which set
  tile.classList.add('capped');
  tile.append(cardCaption(card.id, card, 'card-cap'));
  tile.append(h('button', {
    class: 'info-btn', title: 'Card details', 'aria-label': 'Card details',
    onclick: (e) => { e.stopPropagation(); openCardModal(card, { variant, onOwnershipChange }); },
  }, 'ⓘ'));
  decorateTile(tile, card);
  return tile;
}

function decorateTile(tile, card) {
  tile.querySelectorAll('.badge, .qty-badge').forEach((n) => n.remove());
  // browse-only until signed in: no ownership styling or badges
  if (!canTrack()) {
    tile.classList.remove('missing');
    tile.setAttribute('aria-label', card.name || tile.dataset.cardId);
    return;
  }
  const variant = tile.dataset.variant;
  const qty = variantQty(tile.dataset.cardId, variant);
  tile.classList.toggle('missing', qty === 0);
  tile.setAttribute('aria-label', `${card.name || tile.dataset.cardId} — ${qty ? 'owned' : 'not owned'}`);
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

/** @param onCardChanged how the page behind should repaint when an admin edit
 * changes the card itself (new printing, removed printing, new image, edited
 * card). Default is a full route() re-render; callers that hold their own state
 * — the binder holds edit mode and which pages are open — pass a narrower
 * refresh so opening a card never throws that state away. */
async function openCardModal(brief, { variant, onOwnershipChange, onCardChanged } = {}) {
  const refreshBehind = onCardChanged || route;
  const body = document.getElementById('card-modal-body');
  body.replaceChildren(spinner());
  cardModal.showModal();
  let card = brief, set = null;
  try {
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
    // the big picture retries too, and drops to the low-res scan if the
    // full-size one won't come down
    const modalImg = cardImageEl(card, active, { host: imgWrap, quality: 'high', lazy: false });
    if (!modalImg) return;
    modalImg.classList.add('card-img');
    imgWrap.append(modalImg);
    const fx = variantFxEl(card, active);
    if (fx) imgWrap.append(fx);
  }

  function renderVariantUI() {
    renderModalImage(); // the picture reflects the selected printing
    const track = canTrack();
    chipsWrap.replaceChildren(...avail().map((vk) => {
      const qty = track ? variantQty(card.id, vk) : 0;
      return h('button', {
        type: 'button',
        class: 'chip' + (vk === active ? ' active' : ''),
        onclick: () => { active = vk; renderVariantUI(); },
      }, variantLabel(card, vk) + (qty ? ` ✓${qty > 1 ? '×' + qty : ''}` : ''));
    }));
    if (!track) {
      // browse-only: offer sign-in instead of ownership controls
      counterWrap.replaceChildren(
        h('div', { class: 'row', style: 'justify-content:center; margin-top:6px' },
          h('button', { class: 'btn small', onclick: () => { cardModal.close(); renderAccountModal(); accountModal.showModal(); } },
            serverAvailable ? '🔑 Sign in to track your collection' : 'Tracking needs the server')),
      );
      renderAdminControls();
      return;
    }
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
    // editing writes to the server's database (this install's own copy)
    if (!isAdmin || appConfig.readonly) return;
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
        clearDataCaches(); // pick up the new image from the database
        card = await getCard(card.id);
        renderVariantUI();
        refreshBehind(); // the page behind picks up the new image
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
            clearDataCaches();
            card = await getCard(card.id);
            active = res.key;
            toast(`Added printing: ${res.label}`);
            renderVariantUI();
            refreshBehind(); // the new printing shows up on the page behind
          } catch (err) {
            toast(err.message);
          }
        } }, '＋ Add printing'),
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => fileInput.click() }, `⬆ Upload ${variantLabel(card, active)} image`),
        (realVariants(card).includes(active) && realVariants(card).length > 1)
          ? h('button', { type: 'button', class: 'btn ghost small', onclick: async () => {
              if (!await confirmDestructive({
                title: `Remove the ${variantLabel(card, active)} printing?`,
                body: `${card.name} keeps its other printings — only ${variantLabel(card, active)} goes.\n` +
                  (appConfig.master
                    ? 'This is the master workspace: publishing afterwards removes it from every install.'
                    : 'Only this install is affected; master updates will not bring it back. Restore it any time: re-tick it in \u270e Edit card, or re-add a printing with the same name.'),
                confirmLabel: 'Remove printing',
              })) return;
              try {
                await apiCall('variant-remove', { method: 'POST', body: JSON.stringify({ cardId: card.id, variant: active, lang }) });
                clearDataCaches();
                card = await getCard(card.id);
                active = avail()[0];
                toast('Printing removed');
                renderVariantUI();
                refreshBehind(); // it disappears from the page behind
              } catch (err) { toast(err.message); }
            } }, `✕ Remove ${variantLabel(card, active)}`)
          : null,
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => {
          cardModal.close();   // dialogs sit in the browser's top layer — the editor overlay must replace it
          openCardEditor({ card, onSaved: () => { clearDataCaches(); refreshBehind(); } });
        } }, '✎ Edit card'),
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => {
          cardModal.close();
          openCardEditor({ duplicateOf: card, onSaved: () => { clearDataCaches(); refreshBehind(); } });
        } }, '⧉ Duplicate'),
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
    h('div', { class: 'row', style: 'margin-top:14px; justify-content:flex-end; gap:8px' },
      auth ? h('button', { class: 'btn ghost', onclick: async (e) => {
        const btn = e.target;
        btn.disabled = true;
        try {
          const list = (await apiCall('binders')).binders;
          if (!list.length) { toast('No binders yet — create one in the Binders tab'); return; }
          const addTo = async (b) => {
            const full = (await apiCall('binders/' + b.id)).binder;
            const per = full.size * full.size;
            const cap = full.pages * per;
            let slot = -1;
            for (let i = 0; i < cap; i++) if (!full.slots[i]) { slot = i; break; }
            if (slot === -1) { full.pages += 1; slot = cap; }   // binder full → new page
            full.slots[slot] = { card: card.id, variant: active, have: 0 };
            await apiCall('binders/' + b.id, { method: 'PUT', body: JSON.stringify({ pages: full.pages, slots: full.slots }) });
            toast(`Added to ${b.name} (page ${Math.floor(slot / per) + 1})`);
          };
          if (list.length === 1) await addTo(list[0]);
          else {
            const chooser = h('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px; margin-top:8px' },
              h('span', { class: 'muted small' }, 'Add to binder:'),
              ...list.map((b) => h('button', { class: 'chip', onclick: async () => {
                try { await addTo(b); } catch (err) { toast(err.message); }
                chooser.remove();
              } }, b.name)),
              h('button', { class: 'chip', onclick: () => chooser.remove() }, 'Cancel'));
            btn.parentElement.before(chooser);
          }
        } catch (err) { toast(err.message); }
        finally { btn.disabled = false; }
      } }, '📒 Add to binder') : null,
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

// Pull the catalog from the configured remote database (R2) into this server's DB.
async function startCatalogPull(bypass) {
  return apiCall('catalog/pull', { method: 'POST', body: JSON.stringify(bypass ? { bypass } : {}) });
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
      } else if (status.phase === 'import') {
        line1.textContent = `Loading cards from your database: ${p.setsDone || 0} / ${p.setTotal || '…'} sets`;
        line2.textContent = p.setName ? `now: ${p.setName}` : 'images stay on your CDN — this is quick';
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
  } else if (appConfig.remoteCatalog) {
    // A shared card database (CDN) is configured — the fast path is to pull the
    // catalog from it (card data into this DB; images stay on the CDN). No need
    // to download hundreds of MB from TCGdex.
    const buildFromSource = h('button', { class: 'btn ghost small', style: 'margin-top:10px', onclick: async (e) => {
      e.target.disabled = true;
      try { await startDatabaseBuild(); showProgress(); }
      catch (err) { e.target.disabled = false; toast(err.message); }
    } }, 'Or build a full local database from TCGdex');
    panel.replaceChildren(
      h('h2', {}, 'Welcome! Let’s load your cards'),
      h('p', { class: 'muted' }, 'This tracker reads its cards from a shared card database. Load the catalog into this server and you’re ready — card images are served straight from that database.'),
      h('button', { class: 'btn', style: 'margin-top:8px', onclick: async (e) => {
        e.target.disabled = true;
        try {
          await startCatalogPull();
          showProgress();
        } catch (err) {
          e.target.disabled = false;
          toast(err.message);
        }
      } }, '⬇️ Load cards from the database'),
      h('p', { class: 'muted small', style: 'margin-top:16px' }, 'Prefer to host every image on this server instead? You can download the full database later from the Administration panel.'),
      buildFromSource,
    );
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
    view.replaceChildren(dbErrorView('Could not load the card database.', e, renderHome));
    return;
  }
  // empty database → offer the in-app download (populates the catalog)
  if (!sets.length) {
    await detectServer();
    if (serverAvailable) { renderBootstrap(); return; }
    view.replaceChildren(dbErrorView('The card database is empty.', { message: 'No cards have been loaded yet.' }, renderHome));
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

  // printings tallies per set (for the second bar on each tile) — the search
  // index is cached, so this is one fetch at most
  let printBySet = null;
  try {
    const sx = await getSearchIndex();
    printBySet = {};
    for (const c of sx.cards) {
      const sid = setIdOf(c.id);
      const t = printBySet[sid] || (printBySet[sid] = { owned: 0, total: 0 });
      const avail = realVariants(c);
      t.total += avail.length;
      t.owned += avail.filter((v) => variantQty(c.id, v) > 0).length;
    }
  } catch { /* tiles just skip the printings bar */ }

  const counts = ownedCountsBySet();
  let setSort = lsGet('ptcg.sort.sets') || 'newest';
  const orderedSets = () => {
    if (setSort === 'name') return [...sets].sort((a, b) => a.name.localeCompare(b.name));
    if (setSort === 'most-owned' || setSort === 'least-owned') {
      const dir = setSort === 'most-owned' ? -1 : 1;
      const pctOf = (x) => { const t = (x.cardCount && (x.cardCount.official || x.cardCount.total)) || 0; return t ? (counts[x.id] || 0) / t : 0; };
      return [...sets].sort((a, b) =>
        dir * ((counts[a.id] || 0) - (counts[b.id] || 0)) || dir * (pctOf(a) - pctOf(b)) || a.name.localeCompare(b.name));
    }
    if (setSort === 'oldest') return [...sets]; // index order = release order
    return [...sets].reverse(); // newest first
  };
  let ordered = orderedSets();

  const totalOwned = Object.keys(collection).filter(ownedAny).length;
  const completeSets = ordered.filter((s) => {
    const total = s.cardCount && (s.cardCount.official || s.cardCount.total);
    return total && (counts[s.id] || 0) >= total;
  }).length;

  const banner = canTrack()
    ? h('div', { class: 'stats-banner', id: 'stats-banner' },
        h('div', { class: 'stat' }, h('div', { class: 'num', id: 'stat-owned' }, String(totalOwned)), h('div', { class: 'lbl' }, 'cards owned')),
        h('div', { class: 'stat' }, h('div', { class: 'num', id: 'stat-complete' }, String(completeSets)), h('div', { class: 'lbl' }, 'sets completed')),
        h('div', { class: 'stat' }, h('div', { class: 'num' }, String(ordered.length)), h('div', { class: 'lbl' }, 'sets total')),
      )
    : h('div', { class: 'signin-banner' },
        h('div', {},
          h('strong', {}, serverAvailable ? 'Sign in to track your collection' : 'Browsing all cards'),
          h('div', { class: 'muted small' }, serverAvailable
            ? 'Create a free account to mark which cards you own and sync across devices.'
            : 'Every set and card is here to explore.')),
        serverAvailable
          ? h('button', { class: 'btn small', onclick: () => { renderAccountModal(); accountModal.showModal(); } }, 'Sign in')
          : null,
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
      const pt = printBySet && printBySet[s.id];
      const vPct = pt && pt.total ? Math.min(100, Math.round((pt.owned / pt.total) * 100)) : 0;
      grid.append(h('a', { class: 'set-card' + (done ? ' complete' : ''), href: '#/set/' + encodeURIComponent(s.id) },
        logo
          ? h('img', { class: 'logo', src: logo, alt: '', loading: 'lazy', onerror: (e) => { e.target.outerHTML = '<div class="logo placeholder">🎴</div>'; } })
          : h('div', { class: 'logo placeholder' }, '🎴'),
        h('div', { class: 'info' },
          h('div', { class: 'name' }, s.name),
          h('div', { class: 'count' }, `${owned} / ${total || '?'}${done ? ' ✓ complete' : ''}` +
            (pt ? ` · ${pt.owned} / ${pt.total} printings` : '')),
          h('div', { class: 'progress' + (done ? ' done' : '') }, h('div', { style: `width:${pct}%` })),
          pt ? h('div', { class: 'progress' + (pt.total > 0 && pt.owned >= pt.total ? ' done' : ''), style: 'margin-top:3px' }, h('div', { style: `width:${vPct}%` })) : null,
        ),
      ));
    }
    if (!grid.children.length) grid.append(h('div', { class: 'center' }, 'No sets match.'));
  }
  renderSetCards('');

  const sortCtl = sortSelect(
    [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['name', 'Name A–Z'], ['most-owned', 'Most owned'], ['least-owned', 'Least owned']],
    setSort,
    (v) => { setSort = v; lsSet('ptcg.sort.sets', v); ordered = orderedSets(); renderSetCards(filterInput.value.trim().toLowerCase()); },
  );

  const homeMe = await ensureMe();
  const homeAdmin = !!(homeMe && homeMe.admin) && !appConfig.readonly;
  const newSetBtn = homeAdmin
    ? h('button', { class: 'chip', onclick: () => openSetCreator(() => renderHome()) }, '＋ New set')
    : null;

  // admins can see and restore hidden (bypassed) sets
  const hiddenSetsWrap = h('div', {});
  if (homeAdmin) {
    (async () => {
      let hs;
      try { hs = await apiCall('hidden-sets?lang=' + encodeURIComponent(lang)); } catch { return; }
      if (!hs.sets || !hs.sets.length) return;
      hiddenSetsWrap.append(
        h('h3', { class: 'muted', style: 'margin:20px 0 6px' }, `Hidden sets (${hs.sets.length})`),
        ...hs.sets.map((x) => h('div', { class: 'row', style: 'gap:10px; align-items:center; margin:4px 0' },
          h('span', {}, x.name),
          h('button', { class: 'btn ghost small', onclick: async () => {
            try {
              await apiCall('set-hide', { method: 'POST', body: JSON.stringify({ id: x.id, hidden: false, lang }) });
              clearDataCaches();
              toast(`${x.name} restored`);
              renderHome();
            } catch (e) { toast(e.message); }
          } }, 'Restore'))));
    })();
  }

  view.replaceChildren(...(runningBanner ? [runningBanner] : []), banner,
    h('div', { class: 'set-filter' }, filterInput),
    h('div', { class: 'chips' }, ...[sortCtl, newSetBtn].filter(Boolean)),
    grid,
    hiddenSetsWrap);
}

function updateStatsBanner() {
  const el = document.getElementById('stat-owned');
  if (el) el.textContent = String(Object.keys(collection).filter(ownedAny).length);
}

/* ============================================================
 * Admin — whole-card editor (create / edit / hide) + new sets
 * ============================================================ */

/** Create a brand-new card ({ set, nextNumber }) or edit any card ({ card }).
 * Writes to this server's database: on the master workspace the change
 * publishes to every install; on a personal install it stays local and
 * survives master updates. opts.onSaved() re-renders the caller. */
async function openCardEditor(opts) {
  const editing = opts.card || null;
  const dup = opts.duplicateOf || null;
  const src = editing || dup;
  const homeSet = editing ? setIdOf(editing.id) : (opts.set || (dup ? setIdOf(dup.id) : null));
  let allSets = [];
  try { allSets = (await getIndex()).sets; } catch { /* editor still opens */ }
  const txt = (value, placeholder) => h('input', { type: 'text', value: value || '', placeholder: placeholder || '' });
  const nameIn = txt(src && src.name, 'e.g. Eevee');
  const numIn = txt(editing ? String(editing.localId) : (opts.nextNumber || ''), dup ? 'pick a free number' : 'e.g. 51 or SWSH087');
  const rarityIn = txt(src && src.rarity, 'e.g. Rare Holo');
  const catSel = h('select', {}, ...['', 'Pokemon', 'Trainer', 'Energy'].map((c) => h('option', { value: c }, c || '\u2014 none \u2014')));
  if (src && src.category) catSel.value = src.category;
  const hpIn = h('input', { type: 'number', min: '0', max: '9999', value: src && src.hp ? String(src.hp) : '' });
  const typesIn = txt(src && src.types ? src.types.join(', ') : '', 'e.g. Lightning');
  // one number for most cards, several for a card that is more than one Pokémon
  const dexIn = txt(src && src.dexId ? src.dexId.join(', ') : '', 'e.g. 133, or 244, 243 for a pair');
  const illusIn = txt(src && src.illustrator, '');
  // new cards (and duplicates) can land in any set
  const setSel = editing ? null : h('select', {}, ...allSets.map((x) => h('option', { value: x.id }, x.name)));
  if (setSel && homeSet) setSel.value = homeSet;
  const varBoxes = VARIANT_DEFS.filter(([k]) => k !== 'other').map(([k, lbl]) => {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = src ? !!(src.variants && src.variants[k]) : k === 'normal';
    return { k, cb, el: h('label', { class: 'ce-var' }, cb, ' ' + lbl) };
  });

  // your own printings, right in the form: pending additions + existing ones
  const customPend = dup && dup.printings ? Object.values(dup.printings).slice() : [];
  const customRemove = new Set();
  const existingCustom = editing && editing.printings ? Object.entries(editing.printings) : [];
  const cvList = h('div', { class: 'ce-vars' });
  const cvInput = h('input', { type: 'text', placeholder: 'e.g. Cracked Ice Holo' });
  function renderCustom() {
    cvList.replaceChildren(
      ...existingCustom.filter(([k]) => !customRemove.has(k)).map(([k, lbl]) =>
        // staged, not gone — but the only way back is to cancel the whole edit,
        // so it gets the same "are you sure" as anything else that throws work away
        h('span', { class: 'chip' }, lbl + ' ', h('button', { type: 'button', class: 'chip-x', onclick: async () => {
          if (!await confirmDestructive({
            title: `Remove the "${lbl}" printing?`,
            body: 'It goes when you save this card. Cancel the edit instead if you change your mind before then.',
            confirmLabel: 'Remove printing',
          })) return;
          customRemove.add(k); renderCustom();
        } }, '\u2715'))),
      ...customPend.map((lbl, i) =>
        h('span', { class: 'chip' }, lbl + ' ', h('button', { type: 'button', class: 'chip-x', onclick: () => { customPend.splice(i, 1); renderCustom(); } }, '\u2715'))),
    );
  }
  renderCustom();
  const addCustom = () => {
    const v = cvInput.value.trim();
    if (v.length < 2) { toast('Give the printing a name (2+ characters)'); return; }
    customPend.push(v);
    cvInput.value = '';
    renderCustom();
  };
  cvInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } });

  // picture: upload a file, or reuse one from a card already in the system
  let imageFrom = dup ? dup.id : null;
  let imageFromLabel = dup ? `${dup.name} (#${dup.localId})` : '';
  const fileIn = h('input', { type: 'file', accept: 'image/*' });
  const picChoice = h('div', { class: 'muted small' });
  function renderPicChoice() {
    picChoice.replaceChildren(...(imageFrom
      ? [h('span', {}, `Using the picture of ${imageFromLabel} `),
         h('button', { type: 'button', class: 'chip-x', onclick: () => { imageFrom = null; renderPicChoice(); } }, '\u2715')]
      : []));
  }
  renderPicChoice();
  fileIn.addEventListener('change', () => { if (fileIn.files && fileIn.files[0]) { imageFrom = null; renderPicChoice(); } });

  /** searchable card picker used for "reuse a picture" and "copy from a card" */
  async function openCardPicker(withImagesOnly, onPick) {
    let cards = [], setNames = new Map();
    try {
      const [sx, ix] = await Promise.all([getSearchIndex(), getIndex()]);
      cards = (withImagesOnly ? sx.cards.filter((c) => cardImg(c, 'low')) : sx.cards.slice())
        .sort((a, b) => a.name.localeCompare(b.name) || String(a.localId).localeCompare(String(b.localId), undefined, { numeric: true }));
      setNames = new Map(ix.sets.map((x) => [x.id, x.name]));
    } catch { toast('Could not load the card list'); return; }
    const input = h('input', { type: 'text', placeholder: 'Search cards by name\u2026' });
    const results = h('div', { class: 'picker-results' });
    const rowOf = (c) => h('div', { class: 'picker-row', onclick: () => { ov.remove(); onPick(c); } },
      cardImg(c, 'low') ? h('img', { src: cardImg(c, 'low'), loading: 'lazy' }) : h('div', { class: 'picker-thumb' }, '\ud83c\udccf'),
      h('div', { class: 'picker-info' }, h('div', {}, c.name),
        h('div', { class: 'muted small' }, (setNames.get(setIdOf(c.id)) || setIdOf(c.id)) + ' \u00b7 #' + c.localId)));
    const render = () => {
      const q = input.value.trim().toLowerCase();
      chunkedList(results, q ? cards.filter((c) => c.name.toLowerCase().includes(q)) : cards, rowOf, 'No cards match.');
    };
    input.addEventListener('input', render);
    const ov = h('div', { class: 'picker-overlay' },
      h('div', { class: 'picker-panel' },
        h('div', { class: 'row', style: 'gap:8px' }, input,
          h('button', { class: 'btn ghost small', onclick: () => ov.remove() }, 'Close')),
        results,
      ));
    render();
    view.append(ov);
    input.focus();
  }
  const openImagePicker = () => openCardPicker(true, (c) => {
    imageFrom = c.id;
    imageFromLabel = `${c.name} (#${c.localId})`;
    fileIn.value = '';
    renderPicChoice();
  });

  /** fill the whole form from an existing card (any set) — same as Duplicate,
   * but reachable from ＋ New card too */
  async function copyFromCard(brief) {
    let c = brief;
    try { c = await getCard(brief.id); } catch { /* fall back to the index row */ }
    nameIn.value = c.name || '';
    rarityIn.value = c.rarity || '';
    catSel.value = c.category || '';
    hpIn.value = c.hp ? String(c.hp) : '';
    typesIn.value = (c.types || []).join(', ');
    dexIn.value = (c.dexId || []).join(', ');
    illusIn.value = c.illustrator || '';
    for (const b of varBoxes) b.cb.checked = !!(c.variants && c.variants[b.k]);
    customPend.length = 0;
    if (c.printings) customPend.push(...Object.values(c.printings));
    renderCustom();
    if (cardImg(c, 'low')) {
      imageFrom = c.id;
      imageFromLabel = `${c.name} (#${c.localId})`;
      fileIn.value = '';
    } else { imageFrom = null; }
    renderPicChoice();
    toast(`Copied everything from ${c.name} \u2014 pick a number and save`);
  }

  const status = h('div', { class: 'muted small' });
  const field = (label, input) => h('label', { class: 'ce-field' }, h('span', { class: 'muted small' }, label), input);

  const listOf = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  async function saveCard() {
    if (!nameIn.value.trim()) { toast('The card needs a name'); return; }
    if (!editing && !numIn.value.trim()) { toast('The card needs a number'); return; }
    // a custom printing typed but not yet ＋Added still counts — don't lose it
    const cvLeft = cvInput.value.trim();
    if (cvLeft.length >= 2 && !customPend.includes(cvLeft)) { customPend.push(cvLeft); cvInput.value = ''; renderCustom(); }
    const anyBase = varBoxes.some((b) => b.cb.checked);
    const anyCustom = customPend.length > 0 || existingCustom.some(([k]) => !customRemove.has(k));
    if (!anyBase && !anyCustom) { toast('Pick at least one printing, or add your own'); return; }
    const hasFile = !!(fileIn.files && fileIn.files[0]);
    const payload = {
      lang,
      name: nameIn.value.trim(), localId: numIn.value.trim(),
      rarity: rarityIn.value.trim(), category: catSel.value,
      hp: hpIn.value === '' ? null : parseInt(hpIn.value, 10),
      types: listOf(typesIn.value), dexId: listOf(dexIn.value).map((d) => parseInt(d, 10)).filter((d) => d > 0),
      illustrator: illusIn.value.trim(),
      variants: Object.fromEntries(varBoxes.map((b) => [b.k, b.cb.checked])),
      ...(editing ? { cardId: editing.id } : { new: true, set: setSel ? setSel.value : homeSet }),
      ...(imageFrom && !hasFile ? { imageFrom } : {}),
    };
    try {
      status.textContent = 'Saving\u2026';
      const res = await apiCall('card', { method: 'POST', body: JSON.stringify(payload) });
      for (const lbl of customPend) {
        await apiCall('custom-variant', { method: 'POST', body: JSON.stringify({ cardId: res.cardId, label: lbl, lang }) });
      }
      for (const k of customRemove) {
        await apiCall('variant-remove', { method: 'POST', body: JSON.stringify({ cardId: res.cardId, variant: k, lang }) });
      }
      if (hasFile) {
        status.textContent = 'Uploading picture\u2026';
        const up = await fetch(`api/card-image?cardId=${encodeURIComponent(res.cardId)}&lang=${encodeURIComponent(lang)}`, {
          method: 'POST', headers: { ...authHeaders(), 'Content-Type': fileIn.files[0].type || 'application/octet-stream' }, body: fileIn.files[0],
        });
        const upData = await up.json().catch(() => ({}));
        if (!up.ok) throw new Error(upData.error || 'The card saved, but the picture upload failed');
      }
      overlay.remove();
      clearDataCaches();
      toast(editing ? `${payload.name} updated` : `${payload.name} added`);
      if (opts.onSaved) opts.onSaved(res.cardId);
    } catch (e) { status.textContent = ''; toast(e.message); }
  }

  async function hideCard() {
    if (!await confirmDestructive({
      title: `Hide "${editing.name}" from the database?`,
      body: 'It stops appearing in sets, searches and the scanner. Binders that hold it keep their pocket.\n' +
        (appConfig.master ? 'This is the master workspace: publishing afterwards removes the card from every install.'
          : 'Only this install is affected; master updates will not bring it back. Restore it from the set page.'),
      confirmLabel: 'Hide card',
    })) return;
    try {
      await apiCall('card-hide', { method: 'POST', body: JSON.stringify({ cardId: editing.id, hidden: true, lang }) });
      overlay.remove();
      clearDataCaches();
      toast(`${editing.name} hidden \u2014 restore it from the set page`);
      if (opts.onSaved) opts.onSaved(editing.id);
    } catch (e) { toast(e.message); }
  }

  const overlay = h('div', { class: 'picker-overlay' },
    h('div', { class: 'picker-panel ce-panel' },
      h('h3', { style: 'margin:0' }, editing ? `Edit ${editing.name}` : dup ? `Duplicate ${dup.name}` : 'New card'),
      editing ? h('p', { class: 'muted small', style: 'margin:2px 0 0' }, `Card id: ${editing.id}`) : null,
      editing ? null : h('div', { class: 'row', style: 'gap:8px; align-items:center' },
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => openCardPicker(false, copyFromCard) }, '\u29c9 Copy from a card'),
        h('span', { class: 'muted small' }, 'fills the whole form from any existing card')),
      h('div', { class: 'ce-grid' },
        setSel ? field('Set *', setSel) : null,
        field('Name *', nameIn), field('Number *', numIn),
        field('Rarity', rarityIn), field('Category', catSel),
        field('HP', hpIn), field('Types (comma-separated)', typesIn),
        field('Pok\u00e9dex numbers (comma-separated)', dexIn), field('Illustrator', illusIn),
      ),
      h('div', { class: 'ce-field' }, h('span', { class: 'muted small' }, 'Printings this card exists in'),
        h('div', { class: 'ce-vars' }, ...varBoxes.map((b) => b.el))),
      h('div', { class: 'ce-field' }, h('span', { class: 'muted small' }, 'Your own printings (e.g. stamped promos)'),
        cvList,
        h('div', { class: 'row', style: 'gap:6px; align-items:center' }, cvInput,
          h('button', { type: 'button', class: 'btn ghost small', onclick: addCustom }, '\uff0b Add'))),
      h('div', { class: 'ce-field' }, h('span', { class: 'muted small' },
        editing ? 'Picture (optional \u2014 upload or reuse another card\u2019s)' : 'Picture (optional \u2014 a clean text tile is shown without one)'),
        h('div', { class: 'row', style: 'gap:8px; align-items:center; flex-wrap:wrap' }, fileIn,
          h('button', { type: 'button', class: 'btn ghost small', onclick: openImagePicker }, '\ud83c\udccf From another card')),
        picChoice),
      status,
      h('div', { class: 'row', style: 'justify-content:flex-end; gap:8px; margin-top:6px; flex-wrap:wrap' },
        editing ? h('button', { class: 'btn ghost small', style: 'margin-right:auto', onclick: hideCard }, '\ud83d\uddd1 Hide card') : null,
        h('button', { class: 'btn ghost small', onclick: () => overlay.remove() }, 'Cancel'),
        h('button', { class: 'btn small', onclick: saveCard }, editing ? 'Save changes' : 'Add card'),
      ),
    ));
  view.append(overlay);
  nameIn.focus();
}

/** Admin: create a brand-new set (e.g. a promo binder's home). */
function openSetCreator(onSaved) {
  const nameIn = h('input', { type: 'text', placeholder: 'e.g. Eevee Promos' });
  const idIn = h('input', { type: 'text', placeholder: 'auto from the name' });
  let idTouched = false;
  idIn.addEventListener('input', () => { idTouched = true; });
  nameIn.addEventListener('input', () => {
    if (!idTouched) idIn.value = nameIn.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  });
  const dateIn = h('input', { type: 'date' });
  const countIn = h('input', { type: 'number', min: '1', placeholder: 'optional' });
  const field = (label, input) => h('label', { class: 'ce-field' }, h('span', { class: 'muted small' }, label), input);
  const overlay = h('div', { class: 'picker-overlay' },
    h('div', { class: 'picker-panel' },
      h('h3', { style: 'margin:0' }, 'New set'),
      h('p', { class: 'muted small' }, 'A home for cards no existing set covers — promos, custom cards, and the like.'),
      h('div', { class: 'ce-grid' },
        field('Name *', nameIn), field('Set id *', idIn),
        field('Release date', dateIn), field('Printed size', countIn),
      ),
      h('div', { class: 'row', style: 'justify-content:flex-end; gap:8px; margin-top:6px' },
        h('button', { class: 'btn ghost small', onclick: () => overlay.remove() }, 'Cancel'),
        h('button', { class: 'btn small', onclick: async () => {
          try {
            const body = { lang, id: idIn.value.trim(), name: nameIn.value.trim() };
            if (dateIn.value) body.releaseDate = dateIn.value;
            if (countIn.value) body.officialCount = parseInt(countIn.value, 10);
            const res = await apiCall('set-create', { method: 'POST', body: JSON.stringify(body) });
            overlay.remove();
            clearDataCaches();
            toast(`Set "${res.set.name}" created — open it to add cards`);
            if (onSaved) onSaved(res.set.id);
          } catch (e) { toast(e.message); }
        } }, 'Create set'),
      ),
    ));
  view.append(overlay);
  nameIn.focus();
}

/** Review a master update's ADDITIONS before pulling. Everything defaults to
 * "add"; unchecking an item bypasses it — it still lands in the database,
 * just hidden, so future updates see it and leave it alone. */
function openPullReview(prev) {
  const boxes = [];
  const mk = (kind, payload, main, sub) => {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = true;
    boxes.push({ cb, kind, payload });
    return h('label', { class: 'pr-row' }, cb,
      h('span', {}, main), sub ? h('span', { class: 'muted small' }, sub) : null);
  };
  const secs = [];
  if ((prev.newSets || []).length) {
    secs.push(h('h4', { class: 'pr-head' }, `New sets (${prev.newSets.length})`));
    for (const x of prev.newSets) secs.push(mk('set', { lang: x.lang, id: x.id }, x.name, `${x.cards} card${x.cards === 1 ? '' : 's'} · ${x.lang}`));
  }
  for (const g of prev.newCards || []) {
    const rows = g.cards.map((c) => mk('card', { lang: g.lang, id: c.id }, `#${c.localId} ${c.name}`));
    const all = h('input', { type: 'checkbox' });
    all.checked = true;
    all.addEventListener('change', () => rows.forEach((r) => { r.querySelector('input').checked = all.checked; }));
    secs.push(h('h4', { class: 'pr-head' }, h('label', { class: 'pr-row', style: 'padding:0' }, all, `New cards in ${g.setName} (${g.cards.length})`)), ...rows);
  }
  if ((prev.newVariants || []).length) {
    secs.push(h('h4', { class: 'pr-head' }, `New printings of cards you already have (${prev.newVariants.length})`));
    for (const v of prev.newVariants) {
      secs.push(mk('variant', { lang: v.lang, card: v.card, variant: v.variant },
        `${v.name} #${v.localId} — ${v.label || VARIANT_LABELS[v.variant] || v.variant}`, v.set));
    }
  }
  const backToAdmin = () => { renderAccountModal(); accountModal.showModal(); };
  const overlay = h('div', { class: 'picker-overlay' },
    h('div', { class: 'picker-panel ce-panel' },
      h('h3', { style: 'margin:0' }, `Master update${prev.version ? ' (v' + prev.version + ')' : ''} — review additions`),
      h('p', { class: 'muted small' }, 'Choose what this install takes. Unchecked items are still recorded, just hidden — future updates leave them alone, and you can restore them any time (set page → Hidden cards, home → Hidden sets, or re-tick a printing in ✎ Edit card).'),
      h('div', { class: 'picker-results', style: 'max-height:50vh' }, ...secs),
      h('div', { class: 'row', style: 'justify-content:flex-end; gap:8px; margin-top:6px' },
        h('button', { class: 'btn ghost small', onclick: () => { overlay.remove(); backToAdmin(); } }, 'Cancel'),
        h('button', { class: 'btn small', onclick: async (e) => {
          e.target.disabled = true;
          const bypass = { sets: [], cards: [], variants: [] };
          for (const b of boxes) {
            if (b.cb.checked) continue;
            if (b.kind === 'set') bypass.sets.push(b.payload);
            else if (b.kind === 'card') bypass.cards.push(b.payload);
            else bypass.variants.push(b.payload);
          }
          try {
            await startCatalogPull(bypass);
            overlay.remove();
            backToAdmin();   // the admin panel shows the live pull progress
          } catch (err) { e.target.disabled = false; toast(err.message); }
        } }, '⬇️ Apply update'),
      ),
    ));
  view.append(overlay);
}

/* ============================================================
 * Pages — single set (with master-set mode)
 * ============================================================ */
async function renderSetPage(setId) {
  view.replaceChildren(spinner());
  let set;
  try {
    set = await getSet(setId);
  } catch (e) {
    view.replaceChildren(dbErrorView('Could not load this set.', e, () => renderSetPage(setId)));
    return;
  }

  const cards = set.cards || [];
  const officialTotal = (set.cardCount && (set.cardCount.official || set.cardCount.total)) || cards.length;
  const me = await ensureMe();
  const isAdmin = !!(me && me.admin) && !appConfig.readonly;
  let filter = 'all';
  let query = '';
  let cardSort = lsGet('ptcg.sort.cards') || 'number';

  const progressLabel = h('span', { class: 'muted' });
  const progressBar = h('div', {});
  const progressWrap = h('div', { class: 'progress', style: 'flex:1; min-width:140px' }, progressBar);
  // second bar: the master-set view — every printing counts separately
  const printLabel = h('span', { class: 'muted' });
  const printBar = h('div', {});
  const printWrap = h('div', { class: 'progress', style: 'flex:1; min-width:140px' }, printBar);

  function updateProgress() {
    const owned = cards.filter((c) => ownedAny(c.id)).length;
    const total = officialTotal;
    progressLabel.textContent = `${owned} / ${total}`;
    const pct = total ? Math.min(100, Math.round((owned / total) * 100)) : 0;
    progressBar.style.width = pct + '%';
    progressWrap.classList.toggle('done', total > 0 && owned >= total);
    let vOwned = 0, vTotal = 0;
    for (const c of cards) {
      const avail = realVariants(c);
      vTotal += avail.length;
      vOwned += avail.filter((v) => variantQty(c.id, v) > 0).length;
    }
    printLabel.textContent = `${vOwned} / ${vTotal} printings`;
    const vPct = vTotal ? Math.min(100, Math.round((vOwned / vTotal) * 100)) : 0;
    printBar.style.width = vPct + '%';
    printWrap.classList.toggle('done', vTotal > 0 && vOwned >= vTotal);
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
    // admins get a "new card" tile at the end of the plain set view
    if (isAdmin && filter === 'all' && !q) {
      const nums = cards.map((c) => parseInt(c.localId, 10)).filter(Number.isFinite);
      const next = nums.length ? String(Math.max(...nums) + 1) : '1';
      grid.append(h('button', {
        class: 'add-card-tile',
        onclick: () => openCardEditor({ set: setId, nextNumber: next, onSaved: () => renderSetPage(setId) }),
      }, h('div', { class: 'act-plus' }, '＋'), h('div', { class: 'muted small' }, 'Add card')));
    }
  }

  const chip = (label, isActive, onClick) => h('button', {
    class: 'chip' + (isActive ? ' active' : ''),
    onclick: onClick,
  }, label);

  const chipsWrap = h('div', { class: 'chips' });
  function renderChips() {
    // owned/missing filters only make sense when signed in and tracking
    const trackChips = canTrack()
      ? [chip('Owned', filter === 'owned', () => { filter = 'owned'; renderChips(); renderGrid(); }),
         chip('Missing', filter === 'missing', () => { filter = 'missing'; renderChips(); renderGrid(); })]
      : [];
    chipsWrap.replaceChildren(
      chip('All', filter === 'all', () => { filter = 'all'; renderChips(); renderGrid(); }),
      ...trackChips,
      sortSelect([['number', 'Card number'], ['name', 'Name A–Z']], cardSort,
        (v) => { cardSort = v; lsSet('ptcg.sort.cards', v); renderGrid(); }),
    );
  }

  const searchInput = h('input', {
    type: 'search', placeholder: `Search in ${set.name}…`, 'aria-label': 'Search in set',
    oninput: (e) => { query = e.target.value.trim(); renderGrid(); },
  });

  // admins can see and restore hidden (tombstoned) cards of this set
  const hiddenWrap = h('div', {});
  async function renderHiddenSection() {
    if (!isAdmin) return;
    let hid;
    try { hid = await apiCall(`hidden-cards?set=${encodeURIComponent(setId)}&lang=${encodeURIComponent(lang)}`); } catch { return; }
    if (!hid.cards || !hid.cards.length) { hiddenWrap.replaceChildren(); return; }
    hiddenWrap.replaceChildren(
      h('h3', { class: 'muted', style: 'margin:20px 0 6px' }, `Hidden cards (${hid.cards.length})`),
      ...hid.cards.map((c) => h('div', { class: 'row', style: 'gap:10px; align-items:center; margin:4px 0' },
        h('span', { class: 'muted small' }, `#${c.localId}`), h('span', {}, c.name),
        h('button', { class: 'btn ghost small', onclick: async () => {
          try {
            await apiCall('card-hide', { method: 'POST', body: JSON.stringify({ cardId: c.id, hidden: false, lang }) });
            clearDataCaches();
            toast(`${c.name} restored`);
            renderSetPage(setId);
          } catch (e) { toast(e.message); }
        } }, 'Restore'))),
    );
  }

  view.replaceChildren(
    h('a', { class: 'back-link', href: '#/' }, '← All sets'),
    h('div', { class: 'page-head' },
      h('h1', {}, set.name),
      ...(canTrack() ? [h('div', { class: 'prog-stack' },
        h('div', { class: 'prog-row' }, progressLabel, progressWrap),
        h('div', { class: 'prog-row' }, printLabel, printWrap),
      )] : []),
    ),
    h('div', { class: 'set-filter' }, searchInput),
    chipsWrap,
    grid,
    hiddenWrap,
  );
  renderChips();
  if (canTrack()) updateProgress();
  renderGrid();
  renderHiddenSection();
}

/* ============================================================
 * Pages — Pokémon (all printings of each species, via dex number)
 * ============================================================ */
/** printings tally of a card list (master-set style, custom incl.) */
function printingTally(cards) {
  let owned = 0, total = 0;
  for (const c of cards) {
    const avail = realVariants(c);
    total += avail.length;
    owned += avail.filter((v) => variantQty(c.id, v) > 0).length;
  }
  return { owned, total };
}

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

  let spSort = lsGet('ptcg.sort.species') || 'dex';
  const orderedSpecies = () => {
    if (spSort === 'most-owned' || spSort === 'least-owned') {
      const dir = spSort === 'most-owned' ? -1 : 1;
      const key = (sp) => { const o = sp.cards.filter((c) => ownedAny(c.id)).length; return [o, sp.cards.length ? o / sp.cards.length : 0]; };
      return [...idx.species].sort((a, b) => {
        const ka = key(a), kb = key(b);
        return dir * (ka[0] - kb[0]) || dir * (ka[1] - kb[1]) || a.dex - b.dex;
      });
    }
    return idx.species;   // already in dex order
  };

  function renderList(filter) {
    list.replaceChildren();
    for (const sp of orderedSpecies()) {
      if (filter && !sp.name.toLowerCase().includes(filter) && String(sp.dex) !== filter) continue;
      const owned = sp.cards.filter((c) => ownedAny(c.id)).length;
      const total = sp.cards.length;
      const done = owned >= total;
      const withImg = sp.cards.find((c) => c.img);
      const thumb = withImg ? cardImg(withImg) : null;
      const pct = total ? Math.round((owned / total) * 100) : 0;
      const pt = printingTally(sp.cards);
      const vPct = pt.total ? Math.round((pt.owned / pt.total) * 100) : 0;
      list.append(h('a', { class: 'set-card' + (done ? ' complete' : ''), href: '#/pokemon/' + sp.dex },
        thumb
          ? h('img', { class: 'logo poke-thumb', src: thumb, alt: '', loading: 'lazy' })
          : h('div', { class: 'logo placeholder' }, '❔'),
        h('div', { class: 'info' },
          h('div', { class: 'name' }, `#${String(sp.dex).padStart(3, '0')} ${sp.name}`),
          h('div', { class: 'count' }, `${owned} / ${total} cards${done ? ' ✓' : ''} · ${pt.owned} / ${pt.total} printings`),
          h('div', { class: 'progress' + (done ? ' done' : '') }, h('div', { style: `width:${pct}%` })),
          h('div', { class: 'progress' + (pt.total > 0 && pt.owned >= pt.total ? ' done' : ''), style: 'margin-top:3px' }, h('div', { style: `width:${vPct}%` })),
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
    h('div', { class: 'chips' },
      sortSelect([['dex', 'Dex number'], ['most-owned', 'Most owned'], ['least-owned', 'Least owned']], spSort,
        (v) => { spSort = v; lsSet('ptcg.sort.species', v); renderList(filterInput.value.trim().toLowerCase()); }),
    ),
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
  const sp = idx.species.find((s) => s.dex === dex);
  if (!sp) {
    view.replaceChildren(h('div', { class: 'center' }, 'No cards found for this Pokémon.'));
    return;
  }

  const progressLabel = h('span', { class: 'muted' });
  const pBar = h('div', {});
  const pWrap = h('div', { class: 'progress', style: 'flex:1; min-width:120px' }, pBar);
  const vLabel = h('span', { class: 'muted' });
  const vBar = h('div', {});
  const vWrap = h('div', { class: 'progress', style: 'flex:1; min-width:120px' }, vBar);
  function updateProgress() {
    if (!canTrack()) return;
    const owned = sp.cards.filter((c) => ownedAny(c.id)).length;
    progressLabel.textContent = `${owned} / ${sp.cards.length} owned`;
    pBar.style.width = (sp.cards.length ? Math.min(100, Math.round((owned / sp.cards.length) * 100)) : 0) + '%';
    pWrap.classList.toggle('done', sp.cards.length > 0 && owned >= sp.cards.length);
    let vOwned = 0, vTotal = 0;
    for (const c of sp.cards) {
      const avail = realVariants(c);
      vTotal += avail.length;
      vOwned += avail.filter((v) => variantQty(c.id, v) > 0).length;
    }
    vLabel.textContent = `${vOwned} / ${vTotal} printings`;
    vBar.style.width = (vTotal ? Math.min(100, Math.round((vOwned / vTotal) * 100)) : 0) + '%';
    vWrap.classList.toggle('done', vTotal > 0 && vOwned >= vTotal);
  }

  const grid = h('div', { class: 'card-grid' });
  let pokeSort = lsGet('ptcg.sort.pokemon') || 'newest';

  function renderGrid() {
    grid.replaceChildren();
    const cards = sortCards(sp.cards, pokeSort, (c) => c.id, (c) => c.name);
    for (const c of cards) {
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
      ...(canTrack() ? [h('div', { class: 'prog-stack' },
        h('div', { class: 'prog-row' }, progressLabel, pWrap),
        h('div', { class: 'prog-row' }, vLabel, vWrap),
      )] : []),
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
  } catch (e) {
    view.replaceChildren(dbErrorView('Could not load the card database.', e, route));
    return;
  }
  let rarity = '', type = '', page = 1;
  let searchSort = lsGet('ptcg.sort.search') || 'newest';
  const shown = new Set();   // card ids already on the page — a card belongs here once
  let loadSeq = 0;           // only the newest request may touch the grid
  const results = h('div', { class: 'card-grid' });
  const status = h('div', { class: 'center' });
  const moreBtn = h('button', { class: 'btn ghost load-more', onclick: () => load(false) }, 'Load more');
  moreBtn.hidden = true;

  const select = (label, options, onchange) => h('select', { class: 'chip', 'aria-label': label, onchange: (e) => onchange(e.target.value) },
    h('option', { value: '' }, label),
    ...options.map((o) => h('option', { value: o }, o)));

  async function load(reset) {
    const seq = ++loadSeq;   // a filter changed mid-flight belongs to the newer request
    if (reset) { page = 1; results.replaceChildren(); shown.clear(); }
    status.replaceChildren(spinner());
    moreBtn.hidden = true;
    try {
      let added = 0, more = true;
      // "Load more" has to actually add more. A page that turns out to hold
      // nothing new keeps reading ahead rather than handing back a button
      // press that changes nothing on screen.
      while (added === 0 && more) {
        const res = await searchCards({ name: query, rarity, type, sort: searchSort, page, perPage: 100 });
        if (seq !== loadSeq) return;
        more = res.more;
        if (more) page++;
        for (const c of res.cards) {
          if (shown.has(c.id)) continue;   // never the same card twice
          shown.add(c.id);
          for (const vk of realVariants(c)) results.append(cardTile(c, vk));
          added++;
        }
      }
      status.replaceChildren();
      if (!shown.size) status.textContent = 'No cards found.';
      moreBtn.hidden = !more;
    } catch (e) {
      if (seq !== loadSeq) return;
      status.replaceChildren();
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
  if (!_scanIndexCache) {
    try { _scanIndexCache = await catGet('scan-index?lang=' + encodeURIComponent(lang)); }
    catch { _scanIndexCache = { cards: [] }; }
  }
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
      matches = await identifyCard(source, 5);
      idxRows = new Map((await getSearchIndex()).cards.map((c) => [c.id, c]));
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
          const brief = idxRows.get(id) || { id, name: id, localId: localIdOf(id) };
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

  if (appConfig.release) line('Release', 'v' + appConfig.release);
  line('App version', APP_VERSION);
  line('Card source', 'server database');
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

  try {
    const stats = await catGet('stats');
    line('Cards in database', stats.cards, stats.cards > 0);
    line('Sets in database', stats.sets, stats.sets > 0);
    line('Custom printings', stats.printings);
  } catch { line('Catalog stats', 'unreachable', false); }
  const idxRes = await probe(`catalog/index (${lang})`, `api/catalog/index?lang=${encodeURIComponent(lang)}`);
  await probe(`catalog/search (${lang})`, `api/catalog/search?lang=${encodeURIComponent(lang)}`);
  await probe('catalog/scan-index (scanner)', `api/catalog/scan-index?lang=${encodeURIComponent(lang)}`);

  if (idxRes && idxRes.ok) {
    try {
      const idx = await idxRes.json();
      line('Sets in index', idx.sets.length, idx.sets.length > 0);
      if (idx.sets[0]) {
        const first = idx.sets[0].id;
        const setRes = await probe(`first set (${first})`, `api/catalog/set?lang=${encodeURIComponent(lang)}&id=${encodeURIComponent(first)}`);
        if (setRes && setRes.ok) {
          const setData = await setRes.json();
          const withImg = (setData.cards || []).filter((c) => c.img).length;
          line('Cards with an image (first set)', `${withImg} / ${(setData.cards || []).length}`);
        }
      }
    } catch { line('index parse', 'failed', false); }
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

  if (appConfig.master) {
    area.insertBefore(h('p', { class: 'muted small', style: 'border:1px solid var(--owned); border-radius:8px; padding:8px 10px' },
      '🛠️ Master curation workspace — edits made here become the master database when you publish (scripts/publish-images.js). This is not a personal install.'), content);
  }

  if (appConfig.readonly) {
    content.replaceChildren(h('p', { class: 'muted small' },
      'This server runs in read-only mode (PTCG_READONLY): the card database is managed centrally and cannot be changed from the app.'));
    return;
  }

  async function renderControls() {
    const status = await getBuildStatus();
    if (status && status.running) {
      const msg = status.phase === 'images' ? 'Downloading card images to this server:'
        : status.phase === 'mirror' ? 'Copying the card database:'
          : 'Working on the card database:';
      content.replaceChildren(
        h('p', { class: 'muted small' }, msg),
        buildProgressView(async () => { await loadAppConfig(); clearDataCaches(); toast('Done'); renderControls(); }),
      );
      return;
    }
    let stats = {};
    try { stats = await catGet('stats'); } catch { /* ignore */ }
    const img = appConfig.images || {};   // { local, remote }

    // master update check: ping the tiny catalog.json manifest and offer a
    // data-only update when this install is behind (no images move — they
    // stay wherever they are, on the CDN or already downloaded locally).
    // Not in the maintainer workspace: it PRODUCES the master — pulling its
    // own published output back would be circular.
    const updateArea = h('div', {});
    if (appConfig.remoteCatalog && !appConfig.master) {
      updateArea.append(h('p', { class: 'muted small' }, 'Checking the master database for updates…'));
      (async () => {
        let chk = null;
        try { chk = await catGet('update-check'); } catch { /* offline */ }
        if (!chk || !chk.configured) { updateArea.replaceChildren(); return; }
        if (!chk.reachable) {
          updateArea.replaceChildren(h('p', { class: 'muted small' }, 'Master database not reachable right now — update check skipped.'));
        } else if (chk.behind) {
          updateArea.replaceChildren(
            h('p', { class: 'muted small' }, `A newer master database is available (you have v${chk.localVersion}, master is v${chk.remoteVersion}).`),
            h('div', { class: 'row', style: 'margin-bottom:12px' },
              h('button', { class: 'btn small', onclick: async (e) => {
                e.target.disabled = true;
                try {
                  // review first: anything the master would ADD is the admin's
                  // call — skipped items are stored hidden (soft-bypassed)
                  const prev = await apiCall('catalog/preview', { method: 'POST', body: '{}' });
                  if (!prev.additions) { await startCatalogPull(); renderControls(); }
                  else { accountModal.close(); openPullReview(prev); }
                } catch (err) { e.target.disabled = false; toast(err.message); }
              } }, `⬇️ Update cards from master (v${chk.localVersion} → v${chk.remoteVersion})`),
            ),
          );
        } else {
          updateArea.replaceChildren(h('p', { class: 'muted small' },
            `Card database is up to date with the master (v${chk.localVersion || chk.remoteVersion}).`));
        }
        // the check above now also happens on its own, six-hourly — say when it
        // last ran, so "up to date" carries a date rather than just a claim
        if (appConfig.updateCheckedAt) {
          updateArea.append(h('p', { class: 'muted small', style: 'margin-top:-6px' },
            `Checked automatically ${new Date(appConfig.updateCheckedAt).toLocaleString()}.`));
        }
      })();
    }

    // What this install does when the master moves on. Knowing is safe, so it
    // is the default; applying is not, because a pull carries the master's
    // deletions and skips the review of its additions — so it is opt-in and
    // says so in words.
    const autoArea = h('div', { class: 'ce-field', style: 'margin-bottom:12px' });
    if (appConfig.remoteCatalog && !appConfig.master && !appConfig.readonly) {
      const modes = [
        ['check', 'Check for updates, tell me'],
        ['apply', 'Check and update by itself'],
        ['off', "Don't check"],
      ];
      const note = h('p', { class: 'muted small', style: 'margin:0' });
      const say = (m) => { note.textContent = m === 'apply'
        ? 'Updating by itself accepts every addition without the review step, and carries the master\u2019s deletions through. Your own cards and printings are never touched.'
        : m === 'off' ? 'This install will not look for newer card data. You can still update it by hand above.'
          : 'Checked every six hours. Nothing changes until you press the update button.'; };
      const sel = h('select', {}, ...modes.map(([v, lbl]) => h('option', { value: v }, lbl)));
      sel.value = appConfig.autoUpdate || 'check';
      say(sel.value);
      sel.addEventListener('change', async () => {
        const want = sel.value;
        sel.disabled = true;
        try {
          await apiCall('auto-update', { method: 'POST', body: JSON.stringify({ mode: want }) });
          appConfig.autoUpdate = want; say(want); toast('Saved');
        } catch (err) { sel.value = appConfig.autoUpdate || 'check'; say(sel.value); toast(err.message); }
        sel.disabled = false;
      });
      autoArea.append(h('span', { class: 'muted small' }, 'When the master database moves on'), sel, note);
    }

    // NOTE: replaceChildren stringifies null into literal "null" text (unlike
    // h(), which filters it) — always filter the child list.
    content.replaceChildren(...[
      h('p', { class: 'muted small' }, `Database: ${stats.cards || 0} cards, ${stats.sets || 0} sets, ${stats.printings || 0} custom printings.`),
      updateArea,
      autoArea.children.length ? autoArea : null,
      // Update from TCGdex: only for installs WITHOUT a master (standalone)
      // and for the maintainer workspace — that's where new sets come from.
      // Consumer installs update via the master button above, which appears
      // exactly when the master version is ahead of this install's.
      (!appConfig.remoteCatalog || appConfig.master) ? h('div', { class: 'row', style: 'margin-bottom:12px' },
        h('button', { class: 'btn small', onclick: async (e) => {
          e.target.disabled = true;
          try { await startDatabaseBuild(); renderControls(); }
          catch (err) { e.target.disabled = false; toast(err.message); }
        } }, '🔄 Update cards from TCGdex'),
      ) : null,
      // Rebuild the scanner fingerprints from the images on this server. Cards
      // added here are fingerprinted as their picture is uploaded, so this is
      // for the bulk case — after a mirror, or a build that lost its index.
      appConfig.localDbExists ? h('div', { class: 'row', style: 'margin-bottom:12px' },
        h('button', { class: 'btn ghost small', onclick: async (e) => {
          e.target.disabled = true;
          try { await apiCall('scan-index/rebuild', { method: 'POST', body: '{}' }); toast('Rebuilding the scanner index…'); renderControls(); }
          catch (err) { e.target.disabled = false; toast(err.message); }
        } }, '🔍 Rebuild scanner index'),
      ) : null,
      // download images locally + repoint rows to the local copies
      h('hr'),
      h('p', { class: 'muted small' }, img.remote
        ? `${img.remote} image${img.remote === 1 ? '' : 's'} currently load from the online CDN. Download them to this server so it works fully offline — each card is repointed to its local copy.`
        : (img.local ? 'All card images are served locally from this server.' : 'No card images yet.')),
      img.remote ? h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: async (e) => {
          e.target.disabled = true;
          try { await apiCall('catalog/download-images', { method: 'POST', body: '{}' }); renderControls(); }
          catch (err) { e.target.disabled = false; toast(err.message); }
        } }, '⬇️ Download all images to this server'),
      ) : null,
    ].filter(Boolean));
  }
  renderControls();
}

function renderAccountModal() {
  const statusEl = document.getElementById('account-status');
  const formsEl = document.getElementById('account-forms');
  renderLanguageArea();
  renderAdminArea();
  // backup (export/import) only makes sense for a signed-in collection
  document.getElementById('backup-area').style.display = auth ? '' : 'none';
  // show the deployed release (the GitHub tag); the internal frontend build
  // number (APP_VERSION) lives on the Debug page, not here
  document.getElementById('app-version').textContent =
    appConfig.release ? `v${appConfig.release}` : APP_VERSION;

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
        h('button', { class: 'btn ghost small', onclick: () => { logout(); renderAccountModal(); route(); } }, 'Sign out'),
      ),
    );
    formsEl.replaceChildren();
    return;
  }

  statusEl.replaceChildren(h('p', { class: 'muted' }, 'Sign in to sync your collection across devices using this server.'));

  let mode = 'login';
  const err = h('div', { class: 'error-msg' });
  // stable name/id + correct autocomplete tokens so password managers (Bitwarden,
  // 1Password, browser built-ins) recognise the form cleanly instead of treating
  // it as suspicious and disabling their autofill overlay
  const userIn = h('input', {
    type: 'text', name: 'username', id: 'ptcg-username', placeholder: 'Username',
    autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
  });
  const passIn = h('input', {
    type: 'password', name: 'password', id: 'ptcg-password', placeholder: 'Password (8+ characters)',
    autocomplete: 'current-password',
  });
  const submit = h('button', { class: 'btn', style: 'width:100%' }, 'Sign in');

  const tabs = h('div', { class: 'tabs' },
    h('button', { type: 'button', class: 'active', onclick: (e) => switchMode('login', e.target) }, 'Sign in'),
    h('button', { type: 'button', onclick: (e) => switchMode('register', e.target) }, 'Create account'),
  );

  function switchMode(m, btn) {
    mode = m;
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    submit.textContent = m === 'login' ? 'Sign in' : 'Create account';
    // "new-password" tells the password manager this is a sign-up field (offer to
    // generate/save), "current-password" that it's an existing login (offer to fill)
    passIn.setAttribute('autocomplete', m === 'login' ? 'current-password' : 'new-password');
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
        // signing in was the whole reason this modal was open — get out of the way
        accountModal.close();
        renderAccountModal(); // so it shows the signed-in panel next time it opens
        route(); // tracking UI (toggles, stats, filters) appears now that we're signed in
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
/* ============================================================
 * Pages — Binders (physical binders, tracked pocket by pocket)
 * ============================================================ */
// the front of a binder holds ONE thing: a color, or a picture. 'none' is the
// color you pick when you want neither, or when a picture should stand alone.
const BINDER_COLORS = ['red', 'blue', 'green', 'purple', 'black', 'none'];
const MAX_BINDER_PAGES = 60;   // matches the server's cap; only used to say so out loud
const COLOR_LABELS = { red: 'Red', blue: 'Blue', green: 'Green', purple: 'Purple', black: 'Black', none: 'No color' };
const BINDER_SIZES = [2, 3, 4, 5];

function binderGate() {
  view.replaceChildren(h('div', { class: 'center', style: 'max-width:440px; margin:40px auto' },
    h('h2', {}, 'Binders'),
    h('p', { class: 'muted' }, 'Build digital versions of your real binders — pick a pocket size and color, place cards pocket by pocket, and track which ones you have.'),
    serverAvailable
      ? h('button', { class: 'btn', onclick: () => { renderAccountModal(); accountModal.showModal(); } }, 'Sign in to start')
      : h('p', { class: 'muted small' }, 'Binders need an account on the bundled server.'),
  ));
}

async function renderBindersPage() {
  if (!auth) return binderGate();
  view.replaceChildren(spinner());
  let list;
  try { list = (await apiCall('binders')).binders; }
  catch (e) { view.replaceChildren(dbErrorView('Could not load your binders.', e, renderBindersPage)); return; }

  // covers may reference set logos or card pictures — resolve them if needed
  let coverIdx = null, coverCards = null;
  if (list.some((b) => b.cover && (b.cover.type === 'set' || b.cover.type === 'card'))) {
    try {
      const [ix, sx] = await Promise.all([getIndex(), getSearchIndex()]);
      coverIdx = new Map(ix.sets.map((x) => [x.id, x]));
      coverCards = new Map(sx.cards.map((c) => [c.id, c]));
    } catch { /* color covers still render */ }
  }
  const coverSrcOf = (b) => {
    const c = b.cover;
    if (!c) return null;
    if (c.type === 'art') return c.img;
    if (c.type === 'set' && coverIdx) { const st = coverIdx.get(c.set); return st && st.logo; }
    if (c.type === 'card' && coverCards) { const cd = coverCards.get(c.card); return cd && cardImg(cd, 'low'); }
    return null;
  };
  const grid = h('div', { class: 'binder-list' });
  for (const b of list) {
    const src = coverSrcOf(b);
    const artV = b.cover && b.cover.type === 'art' && b.cover.view && b.cover.view.s ? b.cover.view : null;
    const tile = h('a', { class: `binder-cover b-${b.color}${src ? ' has-art' : ''}`, href: '#/binder/' + b.id },
      src && !artV ? h('img', { class: 'binder-cover-img' + (b.cover.type === 'set' ? ' logo' : ''), src, loading: 'lazy', alt: '' }) : null,
      h('div', { class: 'binder-name' }, b.name),
      h('div', { class: 'binder-meta' }, `${b.size}\u00d7${b.size} \u00b7 ${b.pages} page${b.pages === 1 ? '' : 's'}`),
      h('div', { class: 'binder-meta' }, b.filled ? `${b.have} / ${b.filled} in hand` : 'empty'),
    );
    if (src && artV) {
      const bg = h('div', { class: 'binder-cover-img' });
      tile.prepend(bg);
      coverArtCss(bg, src, artV, b.cover.flip);
    }
    grid.append(tile);
  }

  let color = BINDER_COLORS[0];
  const nameIn = h('input', { type: 'text', placeholder: 'Binder name', maxlength: '40' });
  const sizeSel = h('select', {}, ...BINDER_SIZES.map((s) => h('option', { value: String(s) }, `${s}\u00d7${s} pockets`)));
  sizeSel.value = '3';
  const swatches = h('div', { class: 'row', style: 'gap:8px; margin:10px 0; align-items:center' }, ...BINDER_COLORS.map((c) =>
    h('button', { type: 'button', class: 'swatch b-' + c + (c === color ? ' active' : ''),
      title: COLOR_LABELS[c], 'aria-label': COLOR_LABELS[c], onclick: (e) => {
        color = c;
        swatches.querySelectorAll('.swatch').forEach((el) => el.classList.toggle('active', el === e.target));
      } })));
  /* ---- what goes in it: nothing, a whole set, or every card of one Pok\u00e9mon ----
     There were 150-odd sets in one dropdown already and a species list is far
     longer still, so this is a searchable picker rather than a scroll. */
  let fill = null;   // { kind: 'set'|'dex', id, label }
  const fillBtn = h('button', { type: 'button', class: 'btn ghost', 'data-fill': '' });
  const syncFill = () => { fillBtn.textContent = fill ? 'Fill from: ' + fill.label : 'Start empty'; };
  syncFill();
  fillBtn.addEventListener('click', async () => {
    let sets = [], species = [];
    try {
      const [idx, sx] = await Promise.all([getIndex(), getSearchIndex()]);
      sets = [...idx.sets].reverse().map((s) => ({ kind: 'set', id: s.id, label: s.name, sub: 'Set' }));
      // a pocket is made for every printing, so the printing count is the number
      // that actually predicts the size of the binder \u2014 say it where they differ
      species = sx.species.map((sp) => {
        const prints = sp.cards.reduce((n, c) => n + realVariants(c).length, 0);
        return { kind: 'dex', id: String(sp.dex), label: sp.name,
          sub: `Pok\u00e9mon #${String(sp.dex).padStart(3, '0')} \u00b7 ${sp.cards.length} card${sp.cards.length === 1 ? '' : 's'}`
            + (prints === sp.cards.length ? '' : ` \u00b7 ${prints} printings`) };
      });
    } catch { toast('Could not load the card list'); return; }
    const all = [{ kind: null, id: '', label: 'Start empty', sub: 'Add cards yourself' }, ...sets, ...species];
    const input = h('input', { type: 'text', placeholder: 'Search sets and Pok\u00e9mon\u2026' });
    const results = h('div', { class: 'picker-results' });
    const pick = (o) => { fill = o.kind ? o : null; syncFill(); ov.remove(); };
    const render = () => {
      const q = input.value.trim().toLowerCase();
      const hits = q ? all.filter((o) => o.label.toLowerCase().includes(q) || o.id.toLowerCase() === q) : all;
      results.replaceChildren();
      if (!hits.length) { results.append(h('p', { class: 'muted small' }, 'Nothing matches.')); return; }
      // long lists render in chunks so typing stays instant on a phone
      let shown = 0;
      const more = () => { for (const o of hits.slice(shown, shown + 40)) results.append(
        h('div', { class: 'picker-row', onclick: () => pick(o) },
          h('div', { class: 'picker-info' }, h('div', {}, o.label), h('div', { class: 'muted small' }, o.sub)))); shown = Math.min(shown + 40, hits.length); };
      more();
      results.onscroll = () => { if (shown < hits.length && results.scrollTop + results.clientHeight > results.scrollHeight - 300) more(); };
    };
    input.addEventListener('input', render);
    const ov = h('div', { class: 'picker-overlay' },
      h('div', { class: 'picker-panel' },
        h('h3', {}, 'Fill the binder with'),
        // the pocket count stopped matching the card count the moment printings
        // got their own pockets, so the panel says so before you commit to one
        h('p', { class: 'muted small', style: 'margin:0 0 8px' },
          'Every printing gets its own pocket — a card with a holo and a reverse takes three.'),
        input, results,
        h('div', { class: 'row', style: 'justify-content:flex-end; margin-top:6px' },
          h('button', { class: 'btn ghost small', onclick: () => ov.remove() }, 'Cancel'))));
    view.append(ov);
    render();
    input.focus();
  });
  const createBtn = h('button', { class: 'btn', onclick: async () => {
    const name = nameIn.value.trim();
    if (!name) { toast('Give the binder a name'); return; }
    createBtn.disabled = true;
    try {
      const r = await apiCall('binders', { method: 'POST', body: JSON.stringify({
        name, size: parseInt(sizeSel.value, 10), color, lang,
        fillFromSet: fill && fill.kind === 'set' ? fill.id : undefined,
        fillFromPokemon: fill && fill.kind === 'dex' ? fill.id : undefined,
      }) });
      // what it made, in pockets — and if the binder ran out of sheets before the
      // cards ran out, that gets said plainly rather than left to be discovered
      if (r.skipped) toast(`Filled ${r.filled} pockets — ${r.skipped} more printing${r.skipped === 1 ? '' : 's'} did not fit in ${MAX_BINDER_PAGES} pages`);
      else if (r.filled) toast(`Filled ${r.filled} pocket${r.filled === 1 ? '' : 's'}`);
      location.hash = '#/binder/' + r.binder.id;
    } catch (e) { createBtn.disabled = false; toast(e.message); }
  } }, '\uff0b Create binder');

  view.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Binders'),
      h('div', { class: 'muted' }, list.length ? `${list.length} binder${list.length === 1 ? '' : 's'}` : 'No binders yet')),
    grid,
    h('div', { class: 'binder-create' },
      h('h3', {}, 'New binder'),
      h('div', { class: 'row', style: 'flex-wrap:wrap; gap:8px' }, nameIn, sizeSel, fillBtn),
      swatches,
      // the last swatch is \u201cno color at all\u201d, which is easy to miss as a
      // gap in a row of colors \u2014 so say out loud that it is a choice
      h('p', { class: 'muted small', style: 'margin:0 0 10px' },
        'Pick a color for the front, or the last swatch for none. A picture can go there instead \u2014 \u270e Edit \u2192 Cover.'),
      createBtn,
    ),
  );
}

async function renderBinderPage(id) {
  if (!auth) return binderGate();
  view.replaceChildren(spinner());
  let binder, cardsById, setsById;
  try {
    const [bRes, idx, setIdx] = await Promise.all([apiCall('binders/' + id), getSearchIndex(), getIndex()]);
    binder = bRes.binder;
    cardsById = new Map(idx.cards.map((c) => [c.id, c]));
    setsById = new Map(setIdx.sets.map((x) => [x.id, x]));
  } catch (e) { view.replaceChildren(dbErrorView('Could not load that binder.', e, () => renderBinderPage(id))); return; }

  // pickers & proxies show the readable set NAME, not the internal set code
  const setNameOf = (cid) => { const st = setsById.get(setIdOf(cid)); return (st && st.name) || setIdOf(cid); };
  let per = binder.size * binder.size;
  let moveFrom = null;
  let movePageFrom = null;   // a whole sheet picked up, waiting for somewhere to land
  // the binder opens in VIEW mode (flip pages, tap pockets you've gotten);
  // layout work — moving cards, resizing, covers — lives behind ✎ Edit
  let editMode = false;
  // "select to print": pick individual pockets, carry the choice across page
  // turns, then print just those so one card never wastes a whole sheet.
  // Keys are pocket indexes; a placed picture is keyed by its anchor pocket.
  let pickMode = false;
  const picked = new Set();

  // ---- art entries: your own picture across an arbitrary set of pockets ----
  const GAP_MM = 4, CARD_W = 63, CARD_H = 88;   // physical card + pocket spacing
  // migrate legacy rectangular spans {img,w,h} into the cells form
  for (const [k, e] of Object.entries(binder.slots)) {
    if (e.img && !e.cells) {
      const a = parseInt(k, 10);
      const col = (a % per) % binder.size, row = Math.floor((a % per) / binder.size);
      const cells = [];
      for (let dy = 0; dy < (e.h || 1) && row + dy < binder.size; dy++)
        for (let dx = 0; dx < (e.w || 1) && col + dx < binder.size; dx++)
          cells.push(a + dy * binder.size + dx);
      binder.slots[k] = { img: e.img, cells, view: null, gaps: 'with' };
    }
  }
  /** geometry of an art entry in card-mm space (gap depends on its cut mode) */
  function artGeo(entry) {
    const gap = entry.gaps === 'without' ? 0 : GAP_MM;
    const pos = entry.cells.map((c) => ({ c, col: (c % per) % binder.size, row: Math.floor((c % per) / binder.size) }));
    const minC = Math.min(...pos.map((q) => q.col)), minR = Math.min(...pos.map((q) => q.row));
    const maxC = Math.max(...pos.map((q) => q.col)), maxR = Math.max(...pos.map((q) => q.row));
    return { gap, pos, minC, minR,
      bw: (maxC - minC + 1) * CARD_W + (maxC - minC) * gap,
      bh: (maxR - minR + 1) * CARD_H + (maxR - minR) * gap };
  }
  /** the stored view, or a centered cover of the selection's bounding box */
  function artView(entry, geo) {
    if (entry.view && entry.view.s) return entry.view;
    const nat = natSize(entry.img) || { w: 1, h: 1 };
    const sCover = Math.max(geo.bw, geo.bh * (nat.w / nat.h));
    return { x: (geo.bw - sCover) / 2, y: (geo.bh - sCover * (nat.h / nat.w)) / 2, s: sCover };
  }
  /** paint one pocket's slice of the picture (unit: 'px' on screen, 'mm' in print) */
  function artPieceCss(el, entry, cellIdx, perMm, unit) {
    loadNat(entry.img).then((nat) => {
      const geo = artGeo(entry);
      const v = artView(entry, geo);
      const pc = geo.pos.find((q) => q.c === cellIdx);
      if (!pc) return;
      const ox = (pc.col - geo.minC) * (CARD_W + geo.gap);
      const oy = (pc.row - geo.minR) * (CARD_H + geo.gap);
      const { fx, fy } = flipParts(entry.flip);
      const sH = v.s * (nat.h / nat.w);
      // a mirrored slice: flip the piece element, sample the source at the
      // mirrored offset — together they render the mirrored composed picture
      const bx = fx ? (ox - v.x) + CARD_W - v.s : (v.x - ox);
      const by = fy ? (oy - v.y) + CARD_H - sH : (v.y - oy);
      const layer = artBgLayer(el);
      layer.style.transform = (fx || fy) ? `scale(${fx ? -1 : 1}, ${fy ? -1 : 1})` : '';
      layer.style.backgroundImage = `url("${entry.img}")`;
      layer.style.backgroundRepeat = 'no-repeat';
      layer.style.backgroundSize = (v.s * perMm) + unit + ' auto';
      layer.style.backgroundPosition = (bx * perMm) + unit + ' ' + (by * perMm) + unit;
    });
  }

  const save = async (extra = {}) => {
    try { await apiCall('binders/' + id, { method: 'PUT', body: JSON.stringify({ slots: binder.slots, pages: binder.pages, ...extra }) }); }
    catch (e) { toast('Save failed: ' + e.message); }
  };
  /** an admin edit changed a card under us — reload the index and repaint the
   * pages in place. Deliberately NOT route(): every bit of binder state (edit
   * mode, the print selection, which pages are open) lives in this closure, so
   * a re-render from the router would slam the book shut on the cover. */
  async function reloadCards() {
    try { const idx = await getSearchIndex(); cardsById = new Map(idx.cards.map((c) => [c.id, c])); }
    catch { /* offline — keep the index we already have */ }
    renderHead(); renderBook();
  }
  const cardModalOpts = (s) => ({ variant: s.variant, onCardChanged: () => reloadCards() });
  const filledCount = () => Object.values(binder.slots).filter((e) => e.card).length;
  const haveCount = () => Object.values(binder.slots).filter((e) => e.card && e.have).length;

  const head = h('div', {});
  const pickBar = h('div', {});
  const nav = h('div', { class: 'row binder-nav', style: 'justify-content:center; align-items:center; gap:8px; margin:10px 0' });
  const book = h('div', { class: 'binder-book' });
  const actions = h('div', {});

  // ---- book state: view 0 = the cover; then spreads (desktop) or pages ----
  const spreadMq = window.matchMedia('(min-width: 700px)');
  const isSpread = () => spreadMq.matches;
  let viewIdx = 0;
  const maxView = () => (isSpread() ? Math.floor(binder.pages / 2) + 1 : binder.pages);
  /** pages shown by a view: [leftPageIdx|null, rightPageIdx|null] (0-based; null = blank/none) */
  function viewPages(v) {
    if (v === 0) return [null, null];
    if (!isSpread()) return [null, v - 1];
    const L = 2 * v - 3, R = 2 * v - 2;
    return [L >= 0 && L < binder.pages ? L : null, R < binder.pages ? R : null];
  }
  function navLabel() {
    const P = binder.pages;
    if (viewIdx === 0) return 'Cover';
    const [L, R] = viewPages(viewIdx);
    if (L !== null && R !== null) return `Pages ${L + 1}\u2013${R + 1} of ${P}`;
    return `Page ${(R !== null ? R : L) + 1} of ${P}`;
  }
  function coverImgSrc() {
    const c = binder.cover;
    if (!c) return null;
    if (c.type === 'art') return c.img;
    if (c.type === 'set') { const st = setsById.get(c.set); return (st && st.logo) ? st.logo : null; }
    if (c.type === 'card') { const cd = cardsById.get(c.card); return cd ? (cardImg(cd, 'high', c.variant || null) || cardImg(cd, 'low', c.variant || null)) : null; }
    return null;
  }
  function coverFace() {
    const src = coverImgSrc();
    const av = binder.cover && binder.cover.type === 'art' && binder.cover.view && binder.cover.view.s ? binder.cover.view : null;
    const el = h('div', { class: 'binder-cover-page b-' + binder.color + (src ? ' has-art' : '') },
      src && !av ? h('img', { src, alt: '', class: binder.cover.type === 'set' ? 'cover-logo' : 'cover-photo' }) : null,
      h('div', { class: 'cover-name' }, binder.name),
      h('div', { class: 'cover-hint muted small' }, 'Open \u2192'),
    );
    if (src && av) coverArtCss(el, src, av, binder.cover.flip);
    el.addEventListener('click', () => navTo(1, 1));
    return el;
  }
  const blankPanel = (inside) => h('div', { class: 'book-blank' + (inside ? ' inside' : '') });
  function sideContent(pIdx, insideBlank) {
    if (pIdx === null) return blankPanel(insideBlank);
    const grid = renderPageGrid(pIdx);
    if (!editMode) return grid;
    // The sheet's own handle. Dragging the page itself would fight the pockets
    // for the same gesture, so the grab lives on a bar of its own — and because
    // a drag can't turn a page mid-flight, tapping the bar starts the same move
    // in a way a thumb can finish: pick up here, flip, tap where it should go.
    const carrying = movePageFrom !== null && movePageFrom !== pIdx;
    const handle = h('button', {
      class: 'page-move' + (movePageFrom === pIdx ? ' carrying' : '') + (carrying ? ' target' : ''),
      'data-page-move': String(pIdx), draggable: 'true',
      title: `Move page ${pIdx + 1} somewhere else in this binder`,
      onclick: (e) => {
        e.stopPropagation();
        if (movePageFrom === pIdx) { movePageFrom = null; actions.replaceChildren(); renderBook(); return; }
        if (movePageFrom !== null) { const from = movePageFrom; movePageFrom = null; actions.replaceChildren(); movePage(from, pIdx); return; }
        movePageFrom = pIdx;
        actions.replaceChildren(h('p', { class: 'muted small' },
          `Carrying page ${pIdx + 1} \u2014 turn to where you want it, then tap that page\u2019s bar. ` +
          'Tap this one again to put it back.'));
        renderBook();
      },
      ondragstart: (e) => {
        e.dataTransfer.setData('application/x-binder-page', String(pIdx));
        e.dataTransfer.setData('text/plain', 'page:' + pIdx);
        e.dataTransfer.effectAllowed = 'move';
        movePageFrom = pIdx;
      },
      ondragend: () => { movePageFrom = null; renderBook(); },
    }, h('span', { class: 'page-move-icon', 'aria-hidden': 'true' }, '\u2b0d'),
       h('span', {}, carrying ? `Put it here \u2014 becomes page ${pIdx + 1}`
         : movePageFrom === pIdx ? `Carrying page ${pIdx + 1} \u2014 tap to put back`
         : `Move page ${pIdx + 1}`));

    const wrap = h('div', { class: 'page-wrap' + (movePageFrom === pIdx ? ' carrying' : '') }, handle, grid,
      // opening a gap discards nothing, so it does not ask — it just says what it did
      h('button', {
        class: 'page-insert', 'data-page-insert': String(pIdx),
        title: `Put a blank sheet in front of page ${pIdx + 1}`,
        onclick: (e) => { e.stopPropagation(); insertPage(pIdx); },
      }, h('span', { class: 'page-insert-icon', 'aria-hidden': 'true' }, '\uff0b'),
         h('span', {}, 'Insert blank sheet here')),
      // A bare ⊟ in the corner used to sit here, and nobody should have to guess
      // what a glyph does before finding out by pressing it. It says what it is,
      // in words, under the page it belongs to — and it says which page, which
      // matters most in a two-page spread where the corners are ambiguous.
      h('button', {
        class: 'page-remove', 'data-page': String(pIdx),
        title: `Take page ${pIdx + 1} out of this binder`,
        onclick: (e) => { e.stopPropagation(); removePage(pIdx); },
      }, h('span', { class: 'page-remove-icon', 'aria-hidden': 'true' }, '\ud83d\uddd1'),
         h('span', {}, `Remove page ${pIdx + 1}`)));

    // the whole sheet is the drop target, not just its bar — you aim at the page
    wrap.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('application/x-binder-page')) return;   // a dragged card is not a sheet
      if (movePageFrom === pIdx) return;                                        // its own spot is not a destination
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      wrap.classList.add('drop-target');
    });
    wrap.addEventListener('dragleave', (e) => { if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('drop-target'); });
    wrap.addEventListener('drop', (e) => {
      const raw = e.dataTransfer.getData('application/x-binder-page');
      if (raw === '') return;
      e.preventDefault(); e.stopPropagation();
      wrap.classList.remove('drop-target');
      const from = parseInt(raw, 10);
      movePageFrom = null;
      if (Number.isInteger(from)) movePage(from, pIdx);
    });
    return wrap;
  }
  function renderBook() {
    book.classList.toggle('spread', isSpread() && viewIdx !== 0);
    book.replaceChildren();
    if (viewIdx === 0) { book.append(coverFace()); return; }
    const [L, R] = viewPages(viewIdx);
    if (isSpread()) {
      book.append(
        h('div', { class: 'book-page left' }, sideContent(L, true)),
        h('div', { class: 'book-page right' }, sideContent(R, true)),
      );
    } else {
      book.append(h('div', { class: 'book-page single' }, sideContent(R, true)));
    }
  }
  /** animated page turn between adjacent views; falls back to a plain render */
  function navTo(idx, dir) {
    idx = Math.max(0, Math.min(maxView(), idx));
    if (idx === viewIdx) return;
    const adjacent = Math.abs(idx - viewIdx) === 1;
    const from = viewIdx;
    viewIdx = idx;
    renderNav();
    if (!adjacent) { renderBook(); return; }
    flipAnimate(from, idx, dir || (idx > from ? 1 : -1));
  }
  function flipAnimate(from, to, dir) {
    const [fL, fR] = viewPages(from);
    const [tL, tR] = viewPages(to);
    const single = !isSpread();
    // the underlying book shows the NEW view's static side(s) immediately;
    // a 3D sheet carries the outgoing face and lands as the incoming one
    const sheet = h('div', { class: 'flip-sheet ' + (single ? 'single' : (dir > 0 ? 'right' : 'left')) });
    const face = (content) => h('div', { class: 'flip-face' }, content);
    let front, back;
    if (dir > 0) {
      front = from === 0 ? coverFace() : sideContent(single ? fR : fR, true);
      back = single ? sideContent(tR, true) : sideContent(tL, true);
    } else {
      front = single ? sideContent(fR, true) : sideContent(fL, true);
      back = to === 0 ? coverFace() : (single ? sideContent(tR, true) : sideContent(tR, true));
    }
    const f1 = face(front); const f2 = face(back); f2.classList.add('back');
    sheet.append(f1, f2);
    renderBook();
    book.append(sheet);
    let done = false;
    const finish = () => { if (done) return; done = true; sheet.remove(); renderBook(); };
    sheet.addEventListener('transitionend', finish);
    setTimeout(finish, 650);   // safety net if transitionend never fires
    requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.add('go')));
  }
  function renderNav() {
    // a full binder is 30+ views deep; jumping to either end beats 30 taps.
    // Clamping here and not just in navTo is what lets a button that can't go
    // anywhere look like it: greyed out rather than dead on arrival.
    const jump = (raw, dir, label, title) => {
      const idx = Math.max(0, Math.min(maxView(), raw));
      return h('button', {
        class: 'btn ghost small', title, 'aria-label': title,
        disabled: viewIdx === idx ? '' : null,
        onclick: () => navTo(idx, dir),
      }, label);
    };
    nav.replaceChildren(
      jump(0, -1, '\u00ab', 'First page'),
      jump(viewIdx - 1, -1, '\u2039', 'Previous page'),
      h('span', { class: 'muted', style: 'min-width:130px; text-align:center' }, navLabel()),
      jump(viewIdx + 1, 1, '\u203a', 'Next page'),
      jump(maxView(), 1, '\u00bb', 'Last page'),
    );
  }

  /* ---- swipe to turn the page ----
     Thumb on the page and drag, the way you'd flip a real binder. Only a
     clearly horizontal, clearly deliberate drag counts: a vertical scroll or a
     stray finger during a tap must never cost you your place. */
  let touch = null;
  book.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { touch = null; return; }   // a pinch is not a swipe
    const t = e.touches[0];
    touch = { x: t.clientX, y: t.clientY, t: Date.now(), live: true };
  }, { passive: true });
  book.addEventListener('touchmove', (e) => {
    if (!touch || !touch.live || e.touches.length !== 1) return;
    const t = e.touches[0];
    // once the finger commits to the vertical, this gesture is a scroll for good
    if (Math.abs(t.clientY - touch.y) > Math.abs(t.clientX - touch.x) && Math.abs(t.clientY - touch.y) > 12) touch.live = false;
  }, { passive: true });
  book.addEventListener('touchend', (e) => {
    const start = touch;
    touch = null;
    if (!start || !start.live || editMode || pickMode) return;   // editing/picking owns the touch
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - start.x, dy = t.clientY - start.y;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
    if (Date.now() - start.t > 800) return;                      // a slow drag is a fidget, not a flip
    navTo(viewIdx + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);         // drag left = forward, like a real book
  }, { passive: true });
  spreadMq.addEventListener('change', () => { viewIdx = Math.min(viewIdx, maxView()); renderNav(); renderBook(); });

  const setEditMode = (on) => {
    editMode = on;
    moveFrom = null; movePageFrom = null;
    // layout editing and print-picking are different jobs — never both at once
    pickMode = false; picked.clear();
    actions.replaceChildren();
    renderHead(); renderPickBar(); renderBook();
  };

  const setPickMode = (on) => {
    pickMode = on;
    if (!on) picked.clear();
    actions.replaceChildren();
    renderHead(); renderPickBar(); renderBook();
  };

  /** flip one pocket in or out of the print selection */
  function togglePick(key) {
    if (picked.has(key)) picked.delete(key); else picked.add(key);
    renderPickBar(); renderBook();
  }

  function renderPickBar() {
    if (!pickMode) { pickBar.replaceChildren(); return; }
    const n = picked.size;
    pickBar.replaceChildren(h('div', { class: 'pick-bar' },
      h('strong', {}, n ? `${n} selected` : 'Nothing selected yet'),
      h('button', {
        class: 'btn small' + (n ? '' : ' ghost'), 'data-pick-print': '',
        onclick: () => {
          if (!picked.size) { toast('Tap the pockets you want to print first'); return; }
          openProxyPrintDialog(new Set(picked));   // snapshot: printing clears the live set
        },
      }, '🖨 Print selected'),
      n ? h('button', { class: 'btn ghost small', onclick: () => { picked.clear(); renderPickBar(); renderBook(); } }, 'Clear') : null,
      h('button', { class: 'btn ghost small', onclick: () => setPickMode(false) }, '✓ Done'),
    ));
  }

  function renderHead() {
    const total = filledCount(), got = haveCount();
    const buttons = editMode ? [
      h('button', { class: 'btn ghost small', onclick: async () => {
        const name = prompt('Binder name', binder.name);
        if (!name || !name.trim()) return;
        binder.name = name.trim().slice(0, 40);
        try { await apiCall('binders/' + id, { method: 'PUT', body: JSON.stringify({ name: binder.name }) }); } catch (e) { toast(e.message); }
        renderHead();
      } }, '\u270e Rename'),
      h('button', { class: 'btn ghost small', onclick: openSizePicker }, '\u229e Size'),
      h('button', { class: 'btn ghost small', onclick: async () => {
        binder.pages += 1; await save(); renderNav(); renderBook();
      } }, '\uff0b Add page'),
      h('button', { class: 'btn ghost small', onclick: openCoverPicker }, '\ud83d\uddbc Cover'),
      // wrapped, not passed bare: the handler's Event must not land in `only`
      h('button', { class: 'btn ghost small', onclick: () => openProxyPrintDialog() }, '\ud83d\udda8 Print proxies'),
      h('button', { class: 'btn ghost small', onclick: async () => {
        if (!await confirmDestructive({
          title: `Delete the binder "${binder.name}"?`,
          body: `All ${binder.pages} page${binder.pages === 1 ? '' : 's'} and everything laid out in them go with it. ` +
            'Your collection counts are not touched — only this arrangement of them. This cannot be undone.',
          confirmLabel: 'Delete binder',
        })) return;
        try { await apiCall('binders/' + id, { method: 'DELETE' }); location.hash = '#/binders'; }
        catch (e) { toast(e.message); }
      } }, '\ud83d\uddd1 Delete'),
      h('button', { class: 'btn small', onclick: () => setEditMode(false) }, '\u2713 Done'),
    ] : pickMode ? [
      // one print button at a time: while picking, the bar below owns printing
      h('button', { class: 'btn small', onclick: () => setPickMode(false) }, '\u2713 Done selecting'),
    ] : [
      h('button', { class: 'btn ghost small', onclick: () => openProxyPrintDialog() }, '\ud83d\udda8 Print proxies'),
      h('button', { class: 'btn ghost small', onclick: () => setPickMode(true) }, '\u2611 Select to print'),
      h('button', { class: 'btn small', onclick: () => setEditMode(true) }, '\u270e Edit binder'),
    ];
    head.replaceChildren(...[
      h('a', { class: 'back-link', href: '#/binders' }, '\u2190 Binders'),
      h('div', { class: 'page-head' },
        h('h1', {}, h('span', { class: 'binder-dot b-' + binder.color }), ' ' + binder.name),
        h('div', { class: 'muted' }, `${binder.size}\u00d7${binder.size} \u00b7 ${got} / ${total} in hand`),
      ),
      total ? h('div', { class: 'progress', style: 'height:8px; margin-bottom:10px' },
        h('div', { style: `width:${Math.round((got / total) * 100)}%` })) : null,
      h('div', { class: 'row', style: 'gap:8px; flex-wrap:wrap' }, ...buttons),
      editMode ? h('p', { class: 'muted small', style: 'margin:6px 0 0' },
        'Editing \u2014 tap an empty pocket to add a card, drag or \u2194 Move to rearrange, \u22ef for pocket options. ' +
        'Each sheet has its own bar: drag \u201cMove page\u201d to reorder it (or tap it, turn the page, and tap where it ' +
        'should go), \u201cInsert blank sheet here\u201d to open a gap, \u201cRemove page\u201d to pull the sheet out.') : null,
      pickMode ? h('p', { class: 'muted small', style: 'margin:6px 0 0' },
        'Selecting \u2014 tap the pockets you want as proxies, then turn the page and keep going; they all print on the ' +
        'same sheets. Tapping will not change what\u2019s in hand while you\u2019re picking.') : null,
    ].filter(Boolean));
  }

  /** pull a whole sheet out of the binder: what sits on it comes out with it
   * (collection counts are untouched) and every later page slides forward. */
  async function removePage(pIdx) {
    if (binder.pages <= 1) { toast('A binder needs at least one page'); return; }
    const base = pIdx * per, end = base + per;
    const entries = Object.entries(binder.slots).map(([k, e]) => [parseInt(k, 10), e]);
    const onPage = (k, e) => (e.img && e.cells) ? e.cells.some((c) => c >= base && c < end) : (k >= base && k < end);
    let cards = 0, arts = 0;
    for (const [k, e] of entries) {
      if (!onPage(k, e)) continue;
      if (e.img && e.cells) arts++; else if (e.card) cards++;
    }
    const what = [cards ? `${cards} card${cards === 1 ? '' : 's'}` : null,
      arts ? `${arts} picture${arts === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ');
    // asked every time, empty page or not: pulling a sheet renumbers everything
    // after it, which is not a thing you want to discover by accident
    if (!await confirmDestructive({
      title: `Pull page ${pIdx + 1} out of the binder?`,
      body: (what ? `It still holds ${what}, which comes out with it. Your collection counts do not change.\n` : 'The page is empty.\n') +
        `Every later page slides forward, so the binder goes from ${binder.pages} pages to ${binder.pages - 1}.`,
      confirmLabel: `Remove page ${pIdx + 1}`,
    })) return;
    const slots = {};
    for (const [k, e] of entries) {
      if (onPage(k, e)) continue;                      // out with the sheet
      if (e.img && e.cells) {
        const cells = e.cells.map((c) => (c >= end ? c - per : c)).sort((a, b) => a - b);
        slots[cells[0]] = { ...e, cells };
      } else if (e.card) {
        slots[k >= end ? k - per : k] = e;
      }
    }
    const pages = binder.pages - 1;
    try {
      await apiCall('binders/' + id, { method: 'PUT', body: JSON.stringify({ pages, slots }) });
      binder.pages = pages; binder.slots = slots;
      viewIdx = Math.max(1, Math.min(viewIdx, maxView()));
      renderHead(); renderNav(); renderBook();
      toast(`Page ${pIdx + 1} removed`);
    } catch (e) { toast(e.message); }
  }

  /** re-lay the binder for a new pockets-per-side: cards keep their page and
   * row/column when that position still exists; everything else appends at
   * the end (carried pictures each get a fresh page, shape preserved). */
  function remapForSize(newSize) {
    const oldS = binder.size, oldPer = oldS * oldS, newPer = newSize * newSize;
    const mapIdx = (k) => {
      const p = Math.floor(k / oldPer), pos = k % oldPer;
      const row = Math.floor(pos / oldS), col = pos % oldS;
      return (row < newSize && col < newSize) ? p * newPer + row * newSize + col : null;
    };
    const slots = {};
    const overCards = [];
    const overArts = [];
    const entries = Object.entries(binder.slots).map(([k, e]) => [parseInt(k, 10), e]).sort((a, b) => a[0] - b[0]);
    for (const [k, e] of entries) {
      if (e.img && e.cells) {
        const mapped = e.cells.map(mapIdx);
        if (mapped.every((m) => m !== null)) {
          const cells = mapped.sort((a, b) => a - b);
          slots[cells[0]] = { ...e, cells };
        } else {
          // its position is gone — normalize the shape (cropped if it is now
          // too big for a page) and carry it to its own page at the end
          const pos = e.cells.map((c) => ({ col: (c % oldPer) % oldS, row: Math.floor((c % oldPer) / oldS) }));
          const minC = Math.min(...pos.map((q) => q.col)), minR = Math.min(...pos.map((q) => q.row));
          const cells0 = pos.map((q) => ({ col: q.col - minC, row: q.row - minR }))
            .filter((q) => q.col < newSize && q.row < newSize);
          overArts.push({ entry: e, cells0, cropped: cells0.length !== e.cells.length });
        }
      } else if (e.card) {
        const m = mapIdx(k);
        if (m !== null) slots[m] = e; else overCards.push(e);
      }
    }
    let cursor = Object.keys(slots).length ? Math.max(...Object.keys(slots).map(Number)) + 1 : 0;
    for (const e of overCards) slots[cursor++] = e;
    let pages = Math.max(binder.pages, Math.ceil(cursor / newPer) || 1);
    for (const { entry, cells0, cropped } of overArts) {
      if (!cells0.length) continue;
      const base = pages * newPer;
      const cells = cells0.map((q) => base + q.row * newSize + q.col).sort((a, b) => a - b);
      slots[cells[0]] = { img: entry.img, cells, view: cropped ? null : (entry.view || null), gaps: entry.gaps === 'without' ? 'without' : 'with' };
      pages += 1;
    }
    return { slots, pages };
  }

  function openSizePicker() {
    const overlay = h('div', { class: 'picker-overlay' },
      h('div', { class: 'picker-panel' },
        h('h3', {}, 'Binder size'),
        h('p', { class: 'muted small' }, 'Cards keep their page and position when it still exists in the new size; anything that no longer fits moves to the end.'),
        h('div', { class: 'row', style: 'gap:6px; flex-wrap:wrap' },
          ...BINDER_SIZES.map((s) => h('button', { class: 'chip' + (s === binder.size ? ' active' : ''), onclick: async () => {
            if (s === binder.size) { overlay.remove(); return; }
            const { slots, pages } = remapForSize(s);
            if (pages > 60) { toast('That size would need more than 60 pages'); return; }
            try {
              await apiCall('binders/' + id, { method: 'PUT', body: JSON.stringify({ size: s, pages, slots }) });
              binder.size = s; binder.pages = pages; binder.slots = slots;
              per = s * s;
              overlay.remove();
              viewIdx = Math.min(viewIdx, maxView());
              renderHead(); renderNav(); renderBook();
            } catch (e) { toast(e.message); }
          } }, `${s}×${s}`)),
        ),
        h('div', { class: 'row', style: 'justify-content:flex-end' },
          h('button', { class: 'btn ghost small', onclick: () => overlay.remove() }, 'Cancel')),
      ));
    view.append(overlay);
  }

  /** view mode's pocket sheet: copy counts + details, no layout changes */
  function viewPocketActions(i) {
    const s = binder.slots[i];
    if (!s || !s.card) return;
    const card = cardsById.get(s.card);
    const rerender = () => { renderHead(); renderBook(); render(); };
    const render = () => {
      actions.replaceChildren(h('div', { class: 'pocket-actions' },
        h('span', { class: 'muted small' }, card ? `${card.name} — ${variantLabel(card, s.variant)}` : s.card),
        s.have ? h('span', { class: 'row', style: 'gap:6px; align-items:center' },
          h('button', { class: 'btn small', onclick: async () => {
            const n = s.n || 1;
            if (n > 1) { if (n - 1 > 1) s.n = n - 1; else delete s.n; } else { s.have = 0; delete s.n; }
            await save(); rerender();
          } }, '−'),
          h('strong', {}, '×' + (s.n || 1)),
          h('button', { class: 'btn small', onclick: async () => {
            s.n = Math.min((s.n || 1) + 1, 99);
            await save(); rerender();
          } }, '＋'),
        ) : h('button', { class: 'btn small', onclick: async () => {
          s.have = 1; await save(); rerender();
        } }, 'Mark in hand'),
        card ? h('button', { class: 'btn small', onclick: () => openCardModal(card, cardModalOpts(s)) }, 'ⓘ Details') : null,
        h('button', { class: 'btn ghost small', onclick: () => actions.replaceChildren() }, 'Close'),
      ));
    };
    render();
  }

  function pocketActions(i) {
    if (!editMode) return viewPocketActions(i);
    const s = binder.slots[i];
    if (s && s.img) {
      actions.replaceChildren(h('div', { class: 'pocket-actions' },
        h('span', { class: 'muted small' }, `Your image \u2014 ${s.cells.length} pocket${s.cells.length === 1 ? '' : 's'}`),
        h('button', { class: 'btn small', onclick: () => openArtEditor(i) }, '\u270e Adjust'),
        h('button', { class: 'btn small', onclick: async () => {
          if (!await confirmDestructive({
            title: 'Take this picture out of the binder?',
            body: `It frees up the ${s.cells.length} pocket${s.cells.length === 1 ? '' : 's'} it covers. ` +
              'The image itself is gone from the binder — you would have to upload it again.',
            confirmLabel: 'Remove picture',
          })) return;
          delete binder.slots[i]; await save(); actions.replaceChildren(); renderHead(); renderBook();
        } }, '\u2715 Remove'),
        h('button', { class: 'btn ghost small', onclick: () => actions.replaceChildren() }, 'Cancel'),
      ));
      return;
    }
    const card = s && cardsById.get(s.card);
    actions.replaceChildren(h('div', { class: 'pocket-actions' },
      h('span', { class: 'muted small' }, card ? `${card.name} \u2014 ${variantLabel(card, s.variant)}` : 'Pocket ' + (i + 1)),
      h('button', { class: 'btn small', onclick: () => {
        moveFrom = i;
        actions.replaceChildren(h('p', { class: 'muted small' }, 'Tap the destination pocket (any page). Tap the same pocket to cancel.'));
        renderBook();
      } }, '\u2194 Move'),
      card ? h('button', { class: 'btn small', onclick: () => openCardModal(card, cardModalOpts(s)) }, '\u24d8 Details') : null,
      h('button', { class: 'btn small', onclick: async () => {
        if (s && !await confirmDestructive({
          title: `Empty pocket ${i + 1}?`,
          body: `${card ? card.name : s.card} comes out of the binder. How many you own does not change — ` +
            'this only clears the pocket.',
          confirmLabel: 'Empty pocket',
        })) return;
        delete binder.slots[i]; await save(); actions.replaceChildren(); renderHead(); renderBook();
      } }, '\u2715 Remove'),
      h('button', { class: 'btn ghost small', onclick: () => actions.replaceChildren() }, 'Cancel'),
    ));
  }

  async function moveEntry(from, to) {
    if (from === to) return;
    const a = binder.slots[from], b = binder.slots[to];
    if (!a) return;
    if (b) binder.slots[from] = b; else delete binder.slots[from];
    binder.slots[to] = a;
    await save();
  }

  /** Re-key every slot for a page shuffle. `newPageOf` maps an old page index
   * to its new one; a pocket keeps its position within its own sheet, so a page
   * that lands somewhere else arrives with its layout untouched. A placed
   * picture moves whole — every cell shifts by the same page delta, which is
   * what keeps it on one page and anchored at its lowest cell, the two things
   * the server insists on. */
  function remapPages(newPageOf) {
    const slots = {};
    for (const [k, e] of Object.entries(binder.slots)) {
      const key = parseInt(k, 10);
      if (e.img && e.cells) {
        const cells = e.cells.map((c) => newPageOf(Math.floor(c / per)) * per + (c % per)).sort((a, b) => a - b);
        slots[cells[0]] = { ...e, cells };
      } else if (e.card) {
        slots[newPageOf(Math.floor(key / per)) * per + (key % per)] = e;
      }
    }
    return slots;
  }

  /** Pull a sheet out and slide it back in somewhere else. Everything between
   * the two spots shuffles along by one, which is what your hands do to a real
   * binder — the sheets keep their order, they just close the gap behind and
   * open one ahead. Nothing leaves the binder, so there is nothing to confirm. */
  async function movePage(from, to) {
    if (!Number.isInteger(from) || !Number.isInteger(to)) return;
    if (from === to || from < 0 || to < 0 || from >= binder.pages || to >= binder.pages) { renderBook(); return; }
    const slots = remapPages((p) => {
      if (p === from) return to;
      if (from < to) return (p > from && p <= to) ? p - 1 : p;
      return (p >= to && p < from) ? p + 1 : p;
    });
    try {
      await apiCall('binders/' + id, { method: 'PUT', body: JSON.stringify({ pages: binder.pages, slots }) });
      binder.slots = slots;
      renderHead(); renderNav(); renderBook();
      toast(`Page ${from + 1} is now page ${to + 1}`);
    } catch (e) { toast(e.message); renderBook(); }
  }

  /** Open a gap in the middle: a blank sheet takes this page's number, and this
   * page along with everything after it slides back one. Adding never throws
   * anything away, so this one does not ask first — it just says what it did. */
  async function insertPage(at) {
    if (binder.pages >= MAX_BINDER_PAGES) { toast(`A binder holds at most ${MAX_BINDER_PAGES} pages`); return; }
    const slots = remapPages((p) => (p >= at ? p + 1 : p));
    const pages = binder.pages + 1;
    try {
      await apiCall('binders/' + id, { method: 'PUT', body: JSON.stringify({ pages, slots }) });
      binder.pages = pages; binder.slots = slots;
      viewIdx = Math.min(viewIdx, maxView());
      renderHead(); renderNav(); renderBook();
      toast(`Blank sheet added as page ${at + 1} — the binder now has ${pages} pages`);
    } catch (e) { toast(e.message); }
  }

  function renderPageGrid(pIdx) {
    const grid = h('div', { class: 'binder-grid' });
    grid.style.gridTemplateColumns = `repeat(${binder.size}, 1fr)`;
    const base = pIdx * per;
    const pieces = {};   // pocket idx -> art anchor idx
    for (const [k, e] of Object.entries(binder.slots)) {
      if (e.img && e.cells) for (const c of e.cells) pieces[c] = parseInt(k, 10);
    }
    for (let p = 0; p < per; p++) {
      const i = base + p;
      const anchor = pieces[i];
      const s = binder.slots[i];
      let pocket;
      if (anchor !== undefined) {
        // one slice of a placed picture \u2014 adjustable only while editing
        const entry = binder.slots[anchor];
        // a picture is picked as a whole \u2014 every slice shows the mark
        const artPicked = pickMode && picked.has(anchor);
        pocket = h('div', { class: 'pocket art' + (artPicked ? ' picked' : ''), 'data-pocket': String(i) },
          editMode ? h('button', { class: 'pocket-edit', onclick: (e) => { e.stopPropagation(); pocketActions(anchor); } }, '\u22ef') : null,
          artPicked ? h('div', { class: 'pick-badge' }, '\ud83d\udda8') : null);
        pocket.addEventListener('click', () => {
          if (pickMode) { togglePick(anchor); return; }
          if (!editMode) return;
          if (moveFrom !== null) { moveFrom = null; actions.replaceChildren(); renderBook(); return; }
          pocketActions(anchor);
        });
        requestAnimationFrame(() => artPieceCss(pocket, entry, i, pocket.clientWidth / CARD_W, 'px'));
        grid.append(pocket);
        continue;
      }
      if (s) {
        const card = cardsById.get(s.card);
        const label = (card && card.name) || s.card;
        pocket = h('div', { class: 'pocket filled capped' + (s.have ? ' have' : '') + (moveFrom === i ? ' moving' : '') +
          (pickMode && picked.has(i) ? ' picked' : ''), 'data-pocket': String(i) });
        // the picture retries a stalled download instead of giving up for good
        pocket.append((card && cardImageEl(card, s.variant, { alt: label, host: pocket,
          fallback: () => h('div', { class: 'pocket-name' }, label) })) || h('div', { class: 'pocket-name' }, label));
        pocket.append(...[
          card ? variantFxEl(card, s.variant) : null,   // same diagonal banner as the collection tiles
          // which card this actually is, in every mode: a binder mixes sets, so
          // the picture alone often isn't enough to tell two printings apart
          cardCaption(s.card, card),
          s.have ? h('div', { class: 'pocket-badge' }, '\u2713') : null,
          s.have && (s.n || 1) > 1 ? h('div', { class: 'pocket-qty' }, '\u00d7' + s.n) : null,
          pickMode && picked.has(i) ? h('div', { class: 'pick-badge' }, '\ud83d\udda8') : null,
          // while picking, the whole pocket is one big checkbox \u2014 no side doors
          pickMode ? null : h('button', { class: 'pocket-edit', onclick: (e) => { e.stopPropagation(); pocketActions(i); } }, '\u22ef'),
        ].filter(Boolean));
        if (editMode) {
          // drag & drop between pockets (desktop; mobile keeps \u2194 Move)
          pocket.setAttribute('draggable', 'true');
          pocket.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', String(i));
            e.dataTransfer.effectAllowed = 'move';
            pocket.classList.add('dragging');
          });
          pocket.addEventListener('dragend', () => {
            grid.querySelectorAll('.drag-over, .dragging').forEach((el) => el.classList.remove('drag-over', 'dragging'));
          });
        }
      } else {
        pocket = h('div', { class: 'pocket' + (moveFrom === i ? ' moving' : '') + (editMode ? '' : ' plain'), 'data-pocket': String(i) },
          editMode ? h('div', { class: 'pocket-plus' }, '\uff0b') : null);
      }
      if (editMode) {
        // any card/empty pocket accepts a dropped card
        pocket.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; pocket.classList.add('drag-over'); });
        pocket.addEventListener('dragleave', () => pocket.classList.remove('drag-over'));
        pocket.addEventListener('drop', async (e) => {
          e.preventDefault();
          const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
          if (!Number.isInteger(from) || !binder.slots[from] || binder.slots[from].img) return;
          await moveEntry(from, i);
          renderBook(); renderHead();
        });
      }
      pocket.addEventListener('click', async () => {
        // picking beats everything: an empty pocket has nothing to print
        if (pickMode) { if (s) togglePick(i); return; }
        if (editMode) {
          if (moveFrom !== null) {
            await moveEntry(moveFrom, i);
            moveFrom = null;
            actions.replaceChildren();
            renderBook(); renderHead();
            return;
          }
          if (s) pocketActions(i); else openPocketPicker(i);
          return;
        }
        // view mode: tap = got it / not yet
        if (!s) return;
        if (s.have) { s.have = 0; delete s.n; } else { s.have = 1; }
        await save();
        renderBook(); renderHead();
      });
      grid.append(pocket);
    }
    return grid;
  }

  function openPocketPicker(i) {
    const input = h('input', { type: 'text', placeholder: 'Search cards by name\u2026' });
    const results = h('div', { class: 'picker-results' });
    // upload your own image into this pocket \u2014 the placement editor opens next
    const fileIn = h('input', { type: 'file', accept: 'image/*', hidden: '' });
    fileIn.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const res = await fetch('api/binder-image', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': f.type || 'application/octet-stream' }, body: f });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        overlay.remove();
        openArtEditor(null, { img: data.url, cells: [i], view: null, gaps: 'with' });
      } catch (err) { toast(err.message); }
      e.target.value = '';
    });
    const overlay = h('div', { class: 'picker-overlay' },
      h('div', { class: 'picker-panel' },
        h('div', { class: 'row', style: 'gap:8px' }, input,
          h('button', { class: 'btn ghost small', onclick: () => overlay.remove() }, 'Close')),
        h('div', { class: 'row', style: 'gap:8px; align-items:center; flex-wrap:wrap' },
          h('span', { class: 'muted small' }, 'Or place your own image:'),
          h('button', { class: 'btn ghost small', onclick: () => fileIn.click() }, '\u2b06 Upload image'), fileIn),
        results,
      ));
    const allCards = [...cardsById.values()].sort((a, b) => a.name.localeCompare(b.name) || String(a.localId).localeCompare(String(b.localId), undefined, { numeric: true }));
    const rowOf = (c) => {
      const chips = realVariants(c).map((vk) => h('button', { class: 'chip', onclick: async () => {
        binder.slots[i] = { card: c.id, variant: vk, have: 0 };
        overlay.remove();
        await save();
        renderHead(); renderBook();
      } }, variantLabel(c, vk)));
      const img = cardImg(c, 'low');
      return h('div', { class: 'picker-row' },
        img ? h('img', { src: img, loading: 'lazy' }) : h('div', { class: 'picker-thumb' }, '\ud83c\udccf'),
        h('div', { class: 'picker-info' },
          h('div', {}, c.name),
          h('div', { class: 'muted small' }, setNameOf(c.id) + ' \u00b7 #' + c.localId),
          h('div', { class: 'row', style: 'flex-wrap:wrap; gap:4px' }, ...chips)),
      );
    };
    const renderResults = () => {
      const q = input.value.trim().toLowerCase();
      const hits = q ? allCards.filter((c) => c.name.toLowerCase().includes(q)) : allCards;
      chunkedList(results, hits, rowOf, 'No cards match.');
    };
    input.addEventListener('input', renderResults);
    renderResults();
    view.append(overlay);
    input.focus();
  }


  /** Interactive placement editor: the full picture with the page's pocket
   * grid overlaid. Drag to shift, slider to resize, tap pockets to choose
   * which slices exist, and pick whether cuts include the between-pocket
   * spacing (continuous across the binder) or not (nothing lost to gaps). */
  async function openArtEditor(anchor, draft) {
    const entry = draft || JSON.parse(JSON.stringify(binder.slots[anchor]));
    const pageIdx = Math.floor(entry.cells[0] / per);
    const base = pageIdx * per;
    const nat = await loadNat(entry.img);
    let gaps = entry.gaps === 'without' ? 'without' : 'with';
    const selected = new Set(entry.cells);
    const gapMm = () => (gaps === 'without' ? 0 : GAP_MM);
    const pageW = () => binder.size * CARD_W + (binder.size - 1) * gapMm();
    const pageH = () => binder.size * CARD_H + (binder.size - 1) * gapMm();
    // image placement in page-mm space (origin = top-left pocket corner)
    let imgW, imgX, imgY;
    {
      const geo = artGeo({ ...entry, gaps });
      const v = artView(entry, geo);
      imgW = v.s;
      imgX = v.x + geo.minC * (CARD_W + gapMm());
      imgY = v.y + geo.minR * (CARD_H + gapMm());
    }
    // pockets taken by cards or by OTHER pictures
    const blocked = new Set();
    for (const [k, e] of Object.entries(binder.slots)) {
      const ki = parseInt(k, 10);
      if (anchor !== null && ki === anchor) continue;
      if (e.img && e.cells) e.cells.forEach((c) => blocked.add(c));
      else if (e.card) blocked.add(ki);
    }

    const board = h('div', { class: 'art-board' });
    const im = h('img', { src: entry.img, draggable: 'false', alt: '' });
    const cellLayer = h('div', { class: 'art-cells' });
    board.append(im, cellLayer);
    const scale = h('input', { type: 'range', min: '25', max: '300', step: '1' });
    // exact numbers: read them off one page, type them on the next to match
    const numIn = (cls) => h('input', { type: 'number', step: '0.1', class: cls, style: 'flex:none; width:76px' });
    const xNum = numIn('num-x'), yNum = numIn('num-y'), sNum = numIn('num-s');
    const gapBtn = h('button', { class: 'btn ghost small' });
    let { fx: flipX, fy: flipY } = flipParts(entry.flip);
    const flipXBtn = h('button', { class: 'btn ghost small', onclick: () => { flipX = !flipX; layout(); } });
    const flipYBtn = h('button', { class: 'btn ghost small', onclick: () => { flipY = !flipY; layout(); } });
    const status = h('div', { class: 'muted small', style: 'margin-top:4px' });

    let pxPerMm = 1;
    function layout() {
      const bw = Math.min(430, Math.max(240, (view.clientWidth || 320) - 70));
      pxPerMm = bw / pageW();
      board.style.width = bw + 'px';
      board.style.height = (pageH() * pxPerMm) + 'px';
      im.style.width = (imgW * pxPerMm) + 'px';
      im.style.left = (imgX * pxPerMm) + 'px';
      im.style.top = (imgY * pxPerMm) + 'px';
      cellLayer.replaceChildren();
      for (let pp = 0; pp < per; pp++) {
        const abs = base + pp;
        const col = pp % binder.size, row = Math.floor(pp / binder.size);
        const cell = h('div', { class: 'art-cell' + (selected.has(abs) ? ' sel' : '') + (blocked.has(abs) ? ' blocked' : ''), 'data-cell': String(abs) });
        cell.style.left = (col * (CARD_W + gapMm()) * pxPerMm) + 'px';
        cell.style.top = (row * (CARD_H + gapMm()) * pxPerMm) + 'px';
        cell.style.width = (CARD_W * pxPerMm) + 'px';
        cell.style.height = (CARD_H * pxPerMm) + 'px';
        cellLayer.append(cell);
      }
      const r1 = (n) => Math.round(n * 10) / 10;
      if (document.activeElement !== xNum) xNum.value = String(r1(imgX));
      if (document.activeElement !== yNum) yNum.value = String(r1(imgY));
      if (document.activeElement !== sNum) sNum.value = String(r1((imgW / pageW()) * 100));
      im.style.transform = (flipX || flipY) ? `scale(${flipX ? -1 : 1}, ${flipY ? -1 : 1})` : '';
      flipXBtn.textContent = flipX ? '\u21cb Mirror X: on' : '\u21cb Mirror X: off';
      flipYBtn.textContent = flipY ? '\u21f5 Mirror Y: on' : '\u21f5 Mirror Y: off';
      gapBtn.textContent = gaps === 'with' ? '\u2702 Cut: with pocket spacing' : '\u2702 Cut: without spacing';
      status.textContent = `${selected.size} pocket${selected.size === 1 ? '' : 's'} selected \u2014 drag the picture to shift it, tap pockets to include them`;
      scale.value = String(Math.round((imgW / pageW()) * 100));
    }

    // drag = pan; a short press-without-movement toggles the pocket under it
    let drag = null;
    board.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, ix: imgX, iy: imgY, moved: false };
      try { board.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    });
    board.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
      if (drag.moved) { imgX = drag.ix + dx / pxPerMm; imgY = drag.iy + dy / pxPerMm; layout(); }
    });
    board.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const c = el && el.dataset && el.dataset.cell !== undefined ? parseInt(el.dataset.cell, 10) : null;
        if (c !== null && !blocked.has(c)) { if (selected.has(c)) selected.delete(c); else selected.add(c); layout(); }
        else if (c !== null) toast('That pocket is occupied');
      }
      drag = null;
    });
    scale.addEventListener('input', () => {
      const cx = imgX + imgW / 2, cy = imgY + (imgW * nat.h / nat.w) / 2;
      imgW = (parseInt(scale.value, 10) / 100) * pageW();
      imgX = cx - imgW / 2;
      imgY = cy - (imgW * nat.h / nat.w) / 2;
      layout();
    });
    gapBtn.addEventListener('click', () => { gaps = gaps === 'with' ? 'without' : 'with'; layout(); });
    // typed values apply as-is (size keeps X/Y anchored, unlike the slider)
    xNum.addEventListener('input', () => { const v = parseFloat(xNum.value); if (Number.isFinite(v)) { imgX = v; layout(); } });
    yNum.addEventListener('input', () => { const v = parseFloat(yNum.value); if (Number.isFinite(v)) { imgY = v; layout(); } });
    sNum.addEventListener('input', () => { const v = parseFloat(sNum.value); if (Number.isFinite(v) && v >= 5 && v <= 500) { imgW = (v / 100) * pageW(); layout(); } });

    const overlay = h('div', { class: 'picker-overlay' },
      h('div', { class: 'picker-panel art-editor' },
        h('h3', {}, 'Place your image'),
        board,
        h('div', { class: 'row', style: 'gap:8px; align-items:center' }, h('span', { class: 'muted small' }, 'Size'), scale),
        h('div', { class: 'row', style: 'gap:8px; flex-wrap:wrap; align-items:center' }, gapBtn,
          h('span', { class: 'muted small' }, 'With: the picture flows continuously across the binder. Without: slices are cut edge-to-edge.')),
        h('div', { class: 'row', style: 'gap:8px; flex-wrap:wrap; align-items:center' }, flipXBtn, flipYBtn),
        h('div', { class: 'row', style: 'gap:8px; flex-wrap:wrap; align-items:center' },
          h('span', { class: 'muted small' }, 'Exact:'),
          h('label', { class: 'ce-var' }, 'X ', xNum), h('label', { class: 'ce-var' }, 'Y ', yNum),
          h('label', { class: 'ce-var' }, 'Size % ', sNum),
          h('span', { class: 'muted small' }, 'mm from the page\u2019s top-left pocket \u2014 copy them to match another page exactly')),
        status,
        h('div', { class: 'row', style: 'justify-content:flex-end; gap:8px; margin-top:6px' },
          h('button', { class: 'btn ghost small', onclick: () => overlay.remove() }, 'Cancel'),
          h('button', { class: 'btn small', onclick: async () => {
            if (!selected.size) { toast('Pick at least one pocket'); return; }
            const cells = [...selected].sort((a, b) => a - b);
            const geo = artGeo({ img: entry.img, cells, gaps });
            binder.slots[cells[0]] = { img: entry.img, cells,
              view: { x: imgX - geo.minC * (CARD_W + gapMm()), y: imgY - geo.minR * (CARD_H + gapMm()), s: imgW }, gaps,
              ...(flipOf(flipX, flipY) ? { flip: flipOf(flipX, flipY) } : {}) };
            if (anchor !== null && anchor !== cells[0]) delete binder.slots[anchor];
            overlay.remove();
            await save();
            renderHead(); renderBook();
          } }, 'Save'),
        ),
      ));
    view.append(overlay);
    layout();
  }

  /** Choose what goes on the front: a color, a set logo, a card's picture, or
   * your own art. One thing at a time \u2014 a color and a picture competing for the
   * same face is what made this confusing, and it meant the color had no off
   * switch, since something always had to be showing. */
  function openCoverPicker() {
    const content = h('div', { class: 'picker-results' });
    /** Both halves of the front move together, in one PUT, so it can never be
     * caught half-changed \u2014 a picture with a stale color still behind it. */
    const setFront = async ({ cover = null, color = 'none' }) => {
      binder.cover = cover;
      binder.color = color;
      try { await apiCall('binders/' + id, { method: 'PUT', body: JSON.stringify({ cover, color }) }); } catch (e) { toast(e.message); }
      overlay.remove();
      viewIdx = 0;
      renderNav(); renderHead(); renderBook();
      toast(cover ? 'Cover updated' : (color === 'none' ? 'Cover cleared' : COLOR_LABELS[color] + ' cover'));
    };
    // every picture path goes through here, and a picture takes the whole front
    const setCover = (cover) => setFront({ cover, color: 'none' });
    const modes = h('div', { class: 'row', style: 'gap:6px; flex-wrap:wrap' });
    const mode = (label, fn) => h('button', { class: 'chip', onclick: fn }, label);
    const showColors = () => {
      const pick = async (c) => {
        // swapping in a color throws the picture away, and an uploaded one is
        // gone for good \u2014 so it asks first, like everything else that discards
        if (binder.cover && !await confirmDestructive({
          title: c === 'none' ? 'Take the picture off the front?' : `Put ${COLOR_LABELS[c].toLowerCase()} on the front instead?`,
          body: 'The front holds one thing at a time, so the picture on it now comes off. ' +
            'A set logo or a card you can put back any time; your own image you would have to upload again.',
          confirmLabel: c === 'none' ? 'Remove picture' : 'Replace the picture',
        })) return;
        await setFront({ cover: null, color: c });
      };
      content.replaceChildren(
        h('p', { class: 'muted small' }, 'A plain colored binder \u2014 or \u201cNo color\u201d for a bare one with nothing on the front.'),
        h('div', { class: 'row swatch-row', style: 'gap:12px; flex-wrap:wrap' }, ...BINDER_COLORS.map((c) =>
          h('button', { type: 'button', class: 'swatch-pick', 'data-color': c, title: COLOR_LABELS[c], onclick: () => pick(c) },
            h('span', { class: 'swatch b-' + c + (!binder.cover && binder.color === c ? ' active' : '') }),
            h('span', { class: 'muted small' }, COLOR_LABELS[c])))));
    };
    const showSets = () => {
      content.replaceChildren(...[...setsById.values()].reverse().map((st) =>
        h('div', { class: 'picker-row', onclick: () => setCover({ type: 'set', set: st.id, lang }) },
          st.logo ? h('img', { src: st.logo, loading: 'lazy', style: 'object-fit:contain' }) : h('div', { class: 'picker-thumb' }, '\ud83d\uddc2'),
          h('div', { class: 'picker-info' }, h('div', {}, st.name)))));
    };
    const showCards = () => {
      const input = h('input', { type: 'text', placeholder: 'Search Pok\u00e9mon / cards by name\u2026' });
      const results = h('div', { class: 'picker-results' });
      const allCards = [...cardsById.values()].filter((c) => cardImg(c, 'low'))
        .sort((a, b) => a.name.localeCompare(b.name) || String(a.localId).localeCompare(String(b.localId), undefined, { numeric: true }));
      const rowOf = (c) => h('div', { class: 'picker-row', onclick: () => setCover({ type: 'card', card: c.id }) },
        h('img', { src: cardImg(c, 'low'), loading: 'lazy' }),
        h('div', { class: 'picker-info' }, h('div', {}, c.name), h('div', { class: 'muted small' }, setNameOf(c.id) + ' \u00b7 #' + c.localId)));
      const rr = () => {
        const q = input.value.trim().toLowerCase();
        const hits = q ? allCards.filter((c) => c.name.toLowerCase().includes(q)) : allCards;
        chunkedList(results, hits, rowOf, 'No cards match.');
      };
      input.addEventListener('input', rr);
      content.replaceChildren(input, results);
      rr();
      input.focus();
    };
    /** Drag to shift, slider to resize — the pocket art editor's feel, for
     * the single cover frame (3:4). Saves the placement with the cover. */
    async function openCoverAdjust(img, existing, flip) {
      const nat = await loadNat(img);
      const CW = 100, CH = CW * (4 / 3);   // cover-units; the page is 3:4
      let vw, vx, vy;
      if (existing && existing.s) { vw = existing.s; vx = existing.x; vy = existing.y; }
      else {
        vw = Math.max(CW, CH * (nat.w / nat.h));   // centered, cover-filling
        vx = (CW - vw) / 2;
        vy = (CH - vw * (nat.h / nat.w)) / 2;
      }
      const board = h('div', { class: 'art-board' });
      const im = h('img', { src: img, draggable: 'false', alt: '' });
      board.append(im);
      const scale = h('input', { type: 'range', min: '25', max: '300', step: '1' });
      const numIn = (cls) => h('input', { type: 'number', step: '0.1', class: cls, style: 'flex:none; width:76px' });
      const xNum = numIn('num-x'), yNum = numIn('num-y'), sNum = numIn('num-s');
      let { fx: flipX, fy: flipY } = flipParts(flip);
      const flipXBtn = h('button', { class: 'btn ghost small', onclick: () => { flipX = !flipX; layout(); } });
      const flipYBtn = h('button', { class: 'btn ghost small', onclick: () => { flipY = !flipY; layout(); } });
      let pxPerU = 1;
      function layout() {
        const bw = Math.min(330, Math.max(220, (view.clientWidth || 320) - 90));
        pxPerU = bw / CW;
        board.style.width = bw + 'px';
        board.style.height = (CH * pxPerU) + 'px';
        im.style.width = (vw * pxPerU) + 'px';
        im.style.left = (vx * pxPerU) + 'px';
        im.style.top = (vy * pxPerU) + 'px';
        im.style.transform = (flipX || flipY) ? `scale(${flipX ? -1 : 1}, ${flipY ? -1 : 1})` : '';
        flipXBtn.textContent = flipX ? '\u21cb Mirror X: on' : '\u21cb Mirror X: off';
        flipYBtn.textContent = flipY ? '\u21f5 Mirror Y: on' : '\u21f5 Mirror Y: off';
        scale.value = String(Math.round((vw / CW) * 100));
        const r1 = (n) => Math.round(n * 10) / 10;
        if (document.activeElement !== xNum) xNum.value = String(r1(vx));
        if (document.activeElement !== yNum) yNum.value = String(r1(vy));
        if (document.activeElement !== sNum) sNum.value = String(r1((vw / CW) * 100));
      }
      xNum.addEventListener('input', () => { const v = parseFloat(xNum.value); if (Number.isFinite(v)) { vx = v; layout(); } });
      yNum.addEventListener('input', () => { const v = parseFloat(yNum.value); if (Number.isFinite(v)) { vy = v; layout(); } });
      sNum.addEventListener('input', () => { const v = parseFloat(sNum.value); if (Number.isFinite(v) && v >= 5 && v <= 500) { vw = (v / 100) * CW; layout(); } });
      let drag = null;
      board.addEventListener('pointerdown', (e) => {
        drag = { x: e.clientX, y: e.clientY, ix: vx, iy: vy };
        try { board.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      });
      board.addEventListener('pointermove', (e) => {
        if (!drag) return;
        vx = drag.ix + (e.clientX - drag.x) / pxPerU;
        vy = drag.iy + (e.clientY - drag.y) / pxPerU;
        layout();
      });
      board.addEventListener('pointerup', () => { drag = null; });
      scale.addEventListener('input', () => {
        const cx = vx + vw / 2, cy = vy + (vw * nat.h / nat.w) / 2;
        vw = (parseInt(scale.value, 10) / 100) * CW;
        vx = cx - vw / 2;
        vy = cy - (vw * nat.h / nat.w) / 2;
        layout();
      });
      const adj = h('div', { class: 'picker-overlay' },
        h('div', { class: 'picker-panel art-editor cover-adjust' },
          h('h3', {}, 'Place your cover picture'),
          board,
          h('div', { class: 'row', style: 'gap:8px; align-items:center' }, h('span', { class: 'muted small' }, 'Size'), scale),
          h('div', { class: 'row', style: 'gap:8px; flex-wrap:wrap; align-items:center' }, flipXBtn, flipYBtn),
          h('div', { class: 'row', style: 'gap:8px; flex-wrap:wrap; align-items:center' },
            h('span', { class: 'muted small' }, 'Exact:'),
            h('label', { class: 'ce-var' }, 'X ', xNum), h('label', { class: 'ce-var' }, 'Y ', yNum),
            h('label', { class: 'ce-var' }, 'Size % ', sNum),
            h('span', { class: 'muted small' }, 'cover-units (100 = cover width)')),
          h('div', { class: 'muted small' }, 'Drag the picture to shift it.'),
          h('div', { class: 'row', style: 'justify-content:flex-end; gap:8px; margin-top:6px' },
            h('button', { class: 'btn ghost small', onclick: () => adj.remove() }, 'Cancel'),
            h('button', { class: 'btn small', onclick: async () => {
              adj.remove();
              await setCover({ type: 'art', img, view: { x: vx, y: vy, s: vw },
                ...(flipOf(flipX, flipY) ? { flip: flipOf(flipX, flipY) } : {}) });
            } }, 'Save'),
          ),
        ));
      view.append(adj);
      layout();
    }
    const showUpload = () => {
      const fileIn = h('input', { type: 'file', accept: 'image/*', hidden: '' });
      fileIn.addEventListener('change', async (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        try {
          const res = await fetch('api/binder-image', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': f.type || 'application/octet-stream' }, body: f });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Upload failed');
          openCoverAdjust(data.url, null, null);   // place it before saving
        } catch (err) { toast(err.message); }
        e.target.value = '';
      });
      content.replaceChildren(
        h('p', { class: 'muted small' }, 'Use one of your own pictures as the cover \u2014 you place and size it next.'),
        h('button', { class: 'btn small', onclick: () => fileIn.click() }, '\u2b06 Upload image'), fileIn);
    };
    modes.append(
      mode('Color', showColors),
      mode('Set logo', showSets),
      mode('Pok\u00e9mon card', showCards),
      mode('My image', showUpload),
    );
    if (binder.cover && binder.cover.type === 'art') {
      modes.append(mode('\u270e Adjust picture', () => openCoverAdjust(binder.cover.img, binder.cover.view || null, binder.cover.flip)));
    }
    const overlay = h('div', { class: 'picker-overlay' },
      h('div', { class: 'picker-panel' },
        h('div', { class: 'row', style: 'justify-content:space-between; align-items:center' },
          h('h3', { style: 'margin:0' }, 'Binder cover'),
          h('button', { class: 'btn ghost small', onclick: () => overlay.remove() }, 'Close')),
        h('p', { class: 'muted small', style: 'margin:0' }, 'What goes on the front \u2014 one thing at a time.'),
        modes,
        content,
      ));
    view.append(overlay);
    // open on whatever the binder is wearing now, so the current choice is the
    // first thing you see rather than something you have to go find
    if (binder.cover) showSets(); else showColors();
  }

  /** @param only Set of pocket keys chosen in "select to print" — when present it
   * replaces every scope filter, because an explicit pick outranks a rule. */
  function openProxyPrintDialog(only) {
    let which = 'missing', paper = 'letter';
    // what goes on the page: the cards, the pictures you placed, or both.
    // "Missing only" filters the CARDS — it never hides your pictures.
    let include = lsGet('ptcg.proxy.include') || 'both';
    if (!['both', 'cards', 'art'].includes(include)) include = 'both';
    // pocket sizes vary between binders — offer presets and a custom entry
    const SIZES = { std: { w: 63, h: 88 }, small: { w: 59, h: 86 }, jumbo: { w: 89, h: 127 } };
    let sizeKey = lsGet('ptcg.proxy.size') || 'std';
    if (!SIZES[sizeKey] && sizeKey !== 'custom') sizeKey = 'std';
    const mmIn = (v) => h('input', { type: 'number', min: '20', max: '150', value: v, style: 'flex:none; width:72px' });
    const wIn = mmIn(lsGet('ptcg.proxy.customW') || '63');
    const hIn = mmIn(lsGet('ptcg.proxy.customH') || '88');
    // ratio lock: keep the custom boxes at 3:4 while editing either one
    let ratioLock = lsGet('ptcg.proxy.ratioLock') === '1';
    const r1 = (n) => Math.round(n * 10) / 10;
    const hFromW = () => { const w = parseFloat(wIn.value); if (Number.isFinite(w)) hIn.value = String(r1(w * 4 / 3)); };
    const wFromH = () => { const v = parseFloat(hIn.value); if (Number.isFinite(v)) wIn.value = String(r1(v * 3 / 4)); };
    const lockBtn = h('button', { type: 'button', class: 'chip', title: 'Keep a 3:4 ratio' });
    const syncLock = () => { lockBtn.textContent = (ratioLock ? '\ud83d\udd12' : '\ud83d\udd13') + ' 3:4'; lockBtn.classList.toggle('active', ratioLock); };
    lockBtn.addEventListener('click', () => {
      ratioLock = !ratioLock;
      lsSet('ptcg.proxy.ratioLock', ratioLock ? '1' : '0');
      syncLock();
      if (ratioLock) hFromW();
    });
    wIn.addEventListener('input', () => { if (ratioLock) hFromW(); });
    hIn.addEventListener('input', () => { if (ratioLock) wFromH(); });
    syncLock();
    const customRow = h('div', { class: 'row', style: 'gap:6px; align-items:center' },
      h('span', { class: 'muted small', style: 'min-width:64px' }, 'Custom'),
      wIn, lockBtn, hIn, h('span', { class: 'muted small' }, 'mm'));
    const syncCustomRow = () => { customRow.style.display = sizeKey === 'custom' ? '' : 'none'; };
    // spacing between the cut squares. Default NONE: a gap wastes paper and
    // makes you cut twice down every seam, where butted cells share one line.
    let gapKey = lsGet('ptcg.proxy.gap');
    if (!['0', '1', '2', '4', 'custom'].includes(gapKey)) gapKey = '0';
    const gapIn = h('input', { type: 'number', min: '0', max: '20', step: '0.5',
      value: lsGet('ptcg.proxy.customGap') || '2', style: 'flex:none; width:72px' });
    const gapRow = h('div', { class: 'row', style: 'gap:6px; align-items:center' },
      h('span', { class: 'muted small', style: 'min-width:64px' }, 'Custom'),
      gapIn, h('span', { class: 'muted small' }, 'mm between cards'));
    const syncGapRow = () => { gapRow.style.display = gapKey === 'custom' ? '' : 'none'; };
    // the set + number strip along the bottom of each printed card. On by
    // default — a proxy that doesn't say which printing it stands in for is
    // just a picture — but it eats ink and a sleeved proxy hides it anyway.
    let capKey = lsGet('ptcg.proxy.caption');
    if (!['1', '0'].includes(capKey)) capKey = '1';
    const optRow = (label, opts, get, set) => h('div', { class: 'row', style: 'gap:6px; flex-wrap:wrap; align-items:center' },
      h('span', { class: 'muted small', style: 'min-width:64px' }, label),
      ...opts.map(([v, txt]) => h('button', { class: 'chip' + (v === get() ? ' active' : ''), onclick: (e) => {
        set(v);
        [...e.target.parentElement.querySelectorAll('.chip')].forEach((c) => c.classList.toggle('active', c === e.target));
      } }, txt)));
    const cardsRow = optRow('Cards', [['missing', 'Missing only'], ['all', 'All pockets']], () => which, (v) => which = v);
    const syncCardsRow = () => { cardsRow.style.display = (only || include === 'art') ? 'none' : ''; };
    const n = only ? only.size : 0;
    const overlay = h('div', { class: 'picker-overlay' },
      h('div', { class: 'picker-panel' },
        h('h3', {}, only ? 'Print selected proxies' : 'Print proxies'),
        h('p', { class: 'muted small' }, only
          ? `Prints the ${n} pocket${n === 1 ? '' : 's'} you picked \u2014 packed onto as few sheets as they fit, with cut guides.`
          : 'Prints cards at pocket size with cut guides \u2014 stand-ins for your physical binder\u2019s pockets until the real card arrives.'),
        // an explicit selection already says what to print, so the scope rows go away
        only ? null : optRow('Print', [['both', 'Cards + pictures'], ['cards', 'Cards only'], ['art', 'Pictures only']],
          () => include, (v) => { include = v; syncCardsRow(); }),
        only ? null : cardsRow,
        optRow('Size', [['std', 'Standard 63\u00d788'], ['small', 'Small 59\u00d786'], ['jumbo', 'Jumbo 89\u00d7127'], ['custom', 'Custom\u2026']],
          () => sizeKey, (v) => { sizeKey = v; syncCustomRow(); }),
        customRow,
        optRow('Spacing', [['0', 'None'], ['1', '1 mm'], ['2', '2 mm'], ['4', '4 mm'], ['custom', 'Custom\u2026']],
          () => gapKey, (v) => { gapKey = v; syncGapRow(); }),
        gapRow,
        optRow('Caption', [['1', 'Set + number'], ['0', 'None']], () => capKey, (v) => capKey = v),
        optRow('Paper', [['letter', 'Letter'], ['a4', 'A4']], () => paper, (v) => paper = v),
        h('div', { class: 'row', style: 'justify-content:flex-end; gap:8px; margin-top:6px' },
          h('button', { class: 'btn ghost small', onclick: () => overlay.remove() }, 'Cancel'),
          h('button', { class: 'btn small', onclick: () => {
            const clamp = (el, dflt) => Math.min(150, Math.max(20, parseFloat(el.value) || dflt));
            const size = sizeKey === 'custom' ? { w: clamp(wIn, 63), h: clamp(hIn, 88) } : SIZES[sizeKey];
            const gap = gapKey === 'custom'
              ? Math.min(20, Math.max(0, parseFloat(gapIn.value) || 0))
              : parseFloat(gapKey);
            lsSet('ptcg.proxy.size', sizeKey);
            lsSet('ptcg.proxy.gap', gapKey);
            lsSet('ptcg.proxy.caption', capKey);
            if (gapKey === 'custom') lsSet('ptcg.proxy.customGap', String(gap));
            if (!only) lsSet('ptcg.proxy.include', include);
            if (sizeKey === 'custom') { lsSet('ptcg.proxy.customW', String(size.w)); lsSet('ptcg.proxy.customH', String(size.h)); }
            overlay.remove();
            printProxies(which, paper, size, include, only, gap, capKey === '1');
            // the picks have done their job \u2014 start the next batch clean
            if (only && picked.size) {
              picked.clear(); renderPickBar(); renderBook();
              toast(`Sent ${n} to print \u2014 selection cleared`);
            }
          } }, '\ud83d\udda8 Print'),
        ),
      ));
    view.append(overlay);
    syncCustomRow(); syncCardsRow(); syncGapRow();
  }

  /** @param gap millimetres of white space between printed cards; 0 butts them
   * edge to edge so neighbours share one cut line.
   * @param caption print the set + number strip along the bottom of each card */
  function printProxies(which, paper, size, include, only, gap, caption = true) {
    const pw = (size && size.w) || 63, ph = (size && size.h) || 88;
    const g = Number.isFinite(gap) ? Math.min(20, Math.max(0, gap)) : 0;
    const inc = include || 'both';
    const entries = Object.entries(binder.slots)
      .map(([k, v]) => [parseInt(k, 10), v])
      .sort((a, b) => a[0] - b[0])
      // your pictures ride along with whatever the card filter says \u2014 "Missing
      // only" narrows the CARDS, it never drops the art you placed
      .filter(([k, v]) => {
        if (only) return only.has(k);        // hand-picked pockets, whatever they hold
        if (v.img) return inc !== 'cards';
        if (!v.card || inc === 'art') return false;
        return which === 'all' ? true : !v.have;
      });
    if (!entries.length) {
      toast(only ? 'Nothing to print \u2014 nothing is selected'
        : inc === 'art' ? 'Nothing to print \u2014 this binder has no pictures placed'
        : which === 'missing' ? 'Nothing to print \u2014 every pocket is already in hand'
        : 'Nothing to print \u2014 this binder is empty');
      return;
    }
    const area = h('div', { id: 'print-area' });
    for (const [, v] of entries) {
      if (v.img) {
        // your picture: one 63×88mm piece per chosen pocket, cut with or
        // without the between-pocket spacing (exactly as placed in the editor)
        for (const c of v.cells || []) {
          const cell = h('div', { class: 'print-cell print-art' });
          area.append(cell);
          artPieceCss(cell, v, c, pw / CARD_W, 'mm');
        }
        continue;
      }
      const card = cardsById.get(v.card);
      const img = card && (cardImg(card, 'high', v.variant) || cardImg(card, 'low', v.variant));
      // the printing's name banners EVERY proxy, matching the collection look
      area.append(h('div', { class: 'print-cell' },
        img ? h('img', { src: img, alt: (card && card.name) || v.card })
            : h('div', { class: 'print-fallback' },
                h('div', { class: 'pf-name' }, (card && card.name) || v.card),
                h('div', { class: 'pf-meta' }, setNameOf(v.card) + ' \u00b7 #' + ((card && card.localId) || '?') +
                  (card ? ' \u00b7 ' + variantLabel(card, v.variant) : '')),
              ),
        card ? h('div', { class: 'print-fx' }, variantLabel(card, v.variant)) : null,
        // the fallback tile already spells out set and number in its own body,
        // so it keeps saying so even when the caption strip is switched off
        img && caption ? cardCaption(v.card, card, 'print-cap') : null,
      ));
    }
    const pageStyle = h('style', {}, `@page { size: ${paper === 'a4' ? 'A4' : 'letter'}; margin: 8mm; }`);
    const sizeStyle = h('style', {}, `
      body.printing-proxies #print-area { gap: ${g}mm; }
      body.printing-proxies #print-area .print-cell { width: ${pw}mm; height: ${ph}mm; }`);
    document.head.append(pageStyle, sizeStyle);
    document.body.append(area);
    document.body.classList.add('printing-proxies');
    const cleanup = () => {
      area.remove(); pageStyle.remove(); sizeStyle.remove();
      document.body.classList.remove('printing-proxies');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    // let the images land before the print dialog snapshots the page
    const imgs = [...area.querySelectorAll('img')];
    const natWaits = entries.filter(([, v]) => v.img).map(([, v]) => loadNat(v.img));
    Promise.all([...imgs.map((im) => im.complete ? null : new Promise((r) => { im.onload = im.onerror = r; })), ...natWaits])
      .then(() => setTimeout(() => window.print(), 120));
  }

  renderHead(); renderNav(); renderBook(); renderPickBar();
  view.replaceChildren(head, pickBar, nav, book, actions);
}

/* iOS keeps a zoom across in-app navigation — and it auto-zooms whenever you
 * focus a small field — so you land on the next page magnified, scrolled
 * sideways, with no obvious way back. Briefly pinning the viewport to scale 1
 * snaps it out; the pin is lifted straight after so you can still pinch in to
 * study a card's artwork. */
function resetZoom() {
  const meta = document.querySelector('meta[name=viewport]');
  if (!meta || meta.dataset.pinned) return;
  const original = meta.getAttribute('content');
  meta.dataset.pinned = '1';
  meta.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=0, viewport-fit=cover');
  setTimeout(() => { meta.setAttribute('content', original); delete meta.dataset.pinned; }, 300);
}

function route() {
  const hash = location.hash.slice(1) || '/';
  resetZoom();
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
  else if (hash === '/binders') { nav = 'binders'; renderBindersPage(); }
  else if (hash.startsWith('/binder/')) { nav = 'binders'; renderBinderPage(hash.slice('/binder/'.length)); }
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

/** Full-screen notice shown when the app is running with no server behind it
 * and has never seen one — i.e. someone copied just the files. */
function renderNoServerGate() {
  view.replaceChildren(h('div', { class: 'center', style: 'max-width:460px; margin:60px auto' },
    h('h2', {}, 'Server required'),
    h('p', { class: 'muted' }, 'This app needs its companion server to run. It looks like only the app files were copied, without the server that powers accounts and the card database.'),
    h('p', { class: 'muted small' }, 'Install it with the bundled server (see the project’s README) and open it from there.'),
  ));
  document.querySelector('.topbar')?.style.setProperty('pointer-events', 'none');
}

detectServer().then(() => {
  if (auth && serverAvailable) pullAndMerge().catch(() => {});
});
Promise.all([detectServer(), loadAppConfig()]).then(() => {
  if (!serverAvailable && !serverEverSeen()) { renderNoServerGate(); return; }
  route();
});
