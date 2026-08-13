/* Pokémon TCG Tracker — app logic (vanilla JS, no build step) */
'use strict';

const APP_VERSION = '3.68.0';

/* ============================================================
 * Storage helpers
 * ============================================================ */
function lsGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function lsSet(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

/* Brand-new visitors get the front door (/home — what this is, what it
 * costs); everyone else goes straight into the app. "New" means: never been
 * here, not signed in, nothing tracked, and not following a deep link — a
 * shared binder URL must open the binder, never a sales page. */
(() => {
  try {
    const deepLink = location.hash && location.hash !== '#' && location.hash !== '#/';
    const seen = lsGet('ptcg.visited') || lsGet('ptcg.auth')
      || Object.keys(lsGet('ptcg.collection.v2') || {}).length > 0;
    lsSet('ptcg.visited', true);
    if (!deepLink && !seen) location.replace((self.PTCG_CONFIG && self.PTCG_CONFIG.homeUrl) || '/home');
  } catch { /* storage blocked — just show the app */ }
})();

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
/* ============================================================
 * The header that stays
 *
 * On a listing page the useful furniture all lives above the cards: where you
 * came from, what you are looking at, how far through it you are, and the
 * controls that change what is shown. Scrolling used to take all of it away
 * at once — which is how somebody reached the bottom of a set with no way
 * back and no way to switch to Missing without travelling to the top first.
 *
 * So it sticks, under the search bar. And because that whole block is most of
 * a phone screen, it condenses once you are past the top: the title, the
 * progress bars and the in-page search fold away, leaving the way out and the
 * filters — the two things you reach for while reading a list. The name of
 * what you are looking at moves up next to the back link so it is still on
 * screen, just smaller.
 * ============================================================ */

/** The top bar is sticky and its height moves with the phone's safe-area
 * inset, so the block below it cannot hard-code where to stop. */
function trackTopbarHeight() {
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  const set = () => document.documentElement.style.setProperty('--topbar-h', bar.offsetHeight + 'px');
  set();
  if (window.ResizeObserver) new ResizeObserver(set).observe(bar);
  else window.addEventListener('resize', set);
}

let _stickyHeads = [];

/* Hysteresis, not a single threshold. Condensing removes ~120px from above
 * the reader, so the page shifts up under them; with one threshold a scroll
 * that lands near it can shrink the header, get clamped back below the line,
 * expand, and flap. Condense late, expand early, and there is no value the
 * page can settle at where it disagrees with itself. */
function updateStickyHeads() {
  const y = window.scrollY;
  for (const el of _stickyHeads) {
    if (!el.isConnected) continue;
    const on = el.classList.contains('condensed');
    if (!on && y > 80) el.classList.add('condensed');
    else if (on && y < 24) el.classList.remove('condensed');
  }
}
window.addEventListener('scroll', updateStickyHeads, { passive: true });

/** Everything from the filters up, kept on screen. One per page. */
function stickyHead(...kids) {
  const el = h('div', { class: 'page-sticky' }, ...kids.filter(Boolean));
  _stickyHeads = [el];          // a page replaces the whole view, so one at a time
  updateStickyHeads();
  return el;
}

/** The first row of it: the way out, and — once condensed — the name of the
 * thing whose title has just folded away. */
function stickyTop(href, label, title) {
  return h('div', { class: 'sticky-top' },
    href ? h('a', { class: 'back-link', href }, label) : null,
    title ? h('span', { class: 'sticky-title' }, title) : null,
  );
}

/** The way out, repeated at the end of the page.
 *
 * The bottom bar is fixed, so Sets / Pokémon / Binders / Scan are always
 * within reach — but the link that says where you came FROM lives at the top
 * and scrolls away, and a hundred-card set is a long way back up to it. A
 * tester found this in about a minute: reaching the last card of a set left
 * them with no way back to the set they had opened it from, short of
 * scrolling the whole list again.
 *
 * So every page that has a back link at the top says the same thing again at
 * the bottom, next to a way to the top for anyone who wanted the top rather
 * than the way out. */
function pageFooter(href, label) {
  return h('div', { class: 'page-foot' },
    h('a', { class: 'back-link', href }, label),
    h('button', {
      class: 'btn ghost small', type: 'button',
      onclick: () => window.scrollTo({ top: 0, behavior: 'smooth' }),
    }, '\u2191 Top'),
  );
}

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
  // your own scan of a printing beats the shared picture — it IS your copy
  const mine = variant && card && card.id ? myPrintingsFor(card.id) : null;
  const mi = mine && mine[variant] && mine[variant].img;
  if (mi) return mi[quality] || mi.low || mi.high || null;
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

/** A filter chip. Was local to the set page until the same three words —
 * All, Owned, Missing — turned out to be wanted everywhere cards are listed. */
function chip(label, isActive, onClick) {
  return h('button', { class: 'chip' + (isActive ? ' active' : ''), onclick: onClick }, label);
}

/** Owned/missing filtering, in the one place that decides what those mean.
 * Signed out there is no ownership to filter on, so everything passes. */
function passesOwnFilter(filter, cardId, variant) {
  if (filter === 'all' || !canTrack()) return true;
  const owned = variantQty(cardId, variant) > 0;
  return filter === 'owned' ? owned : !owned;
}

/** The All / Owned / Missing row, wherever printings are listed. Only shown
 * when signed in: the words mean nothing about a collection nobody has. */
function ownFilterChips(filter, onPick) {
  if (!canTrack()) return [];
  return [
    chip('All', filter === 'all', () => onPick('all')),
    chip('Owned', filter === 'owned', () => onPick('owned')),
    chip('Missing', filter === 'missing', () => onPick('missing')),
  ];
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
  // …then YOUR printings, which exist only for you and never resurrect anything
  const mine = card && card.id ? myPrintingsFor(card.id) : null;
  if (mine) for (const key of Object.keys(mine)) if (mine[key].label && !avail.includes(key)) avail.push(key);
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
  const mine = card && card.id ? myPrintingsFor(card.id) : null;
  if (mine && mine[vk] && mine[vk].label) return mine[vk].label;
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

/* The session now rides in an httpOnly cookie the browser attaches by itself,
 * so there is nothing here to send — and nothing here for a stray script to
 * steal. A token is still accepted in the header for anything that is not a
 * browser; older sign-ins that kept one carry on working until they lapse. */
function authHeaders() {
  return auth && auth.token ? { Authorization: 'Bearer ' + auth.token } : {};
}

let _meCache = null;
async function ensureMe() {
  if (!auth || !serverAvailable) return null;
  if (_meCache && _meCache.username === auth.username) return _meCache;
  try { _meCache = await apiCall('me'); } catch { _meCache = null; }
  return _meCache;
}

/* ---------- personal printings (your own layer over the catalog) ----------
 * Loaded once per account+language and merged into every place printings
 * render. Strictly yours: other accounts never see these, and the master
 * database never carries them. */
let _myPrints = {};            // cardId -> variant -> { label, img }
let _myPrintsKey = null;       // "username|lang" the map belongs to
let _myPrintsLoading = null;
function myPrintingsFor(cardId) {
  return (_myPrintsKey === `${auth && auth.username}|${lang}` && _myPrints[cardId]) || null;
}
async function loadMyPrintings() {
  const key = auth && serverAvailable ? `${auth.username}|${lang}` : null;
  if (!key) { _myPrints = {}; _myPrintsKey = null; return; }
  if (_myPrintsKey === key || _myPrintsLoading === key) return;
  _myPrintsLoading = key;
  try {
    const d = await apiCall('my/printings?lang=' + encodeURIComponent(lang));
    _myPrints = {};
    for (const p of d.printings || []) {
      (_myPrints[p.card] = _myPrints[p.card] || {})[p.variant] = { label: p.label, img: p.img };
    }
    _myPrintsKey = key;
  } catch { /* offline — the overlay simply waits for the next chance */ }
  finally { _myPrintsLoading = null; }
}

async function apiCall(path, options = {}) {
  const res = await fetch('api/' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && auth) { auth = null; lsSet('ptcg.auth', null); updateAccountButton(); }
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.premiumRequired = !!data.premiumRequired;
    err.locked = !!data.locked;
    throw err;
  }
  return data;
}

async function doAuth(kind, username, password, email) {
  const data = await apiCall(kind, { method: 'POST', body: JSON.stringify({ username, password, ...(email ? { email } : {}) }) });
  // the password was one of two things asked for
  if (data.needTotp) return { needTotp: true, ticket: data.ticket, username: data.username };
  // Only who we are, never the token: that came back in a cookie this page is
  // not allowed to read, which is the whole point of putting it there.
  auth = { username: data.username };
  lsSet('ptcg.auth', auth);
  await pullAndMerge();
  updateAccountButton();
  return { needTotp: false };
}

/** Finish a sign-in that wants a second factor. */
async function finishTotpSignIn(ticket) {
  const codeIn = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
    placeholder: '6-digit code', maxlength: '7' });
  const recIn = h('input', { type: 'text', placeholder: 'or a recovery code' });
  const recRow = h('div', { class: 'field' }, recIn);
  recRow.hidden = true;
  const err = h('p', { class: 'muted small', style: 'color:var(--accent); margin:0' });
  const go = h('button', { class: 'btn small' }, 'Sign in');
  const ov = h('div', { class: 'picker-overlay' },
    h('div', { class: 'picker-panel' },
      h('h3', { style: 'margin:0' }, 'Two-factor'),
      h('p', { class: 'muted small', style: 'margin:0' }, 'Enter the code from your authenticator app.'),
      h('div', { class: 'field' }, codeIn),
      recRow,
      h('button', { type: 'button', class: 'btn ghost small', onclick: () => { recRow.hidden = !recRow.hidden; codeIn.value = ''; } },
        'Lost your authenticator?'),
      err,
      h('div', { class: 'row', style: 'justify-content:flex-end; gap:8px' },
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => ov.remove() }, 'Cancel'),
        go),
    ));
  const submit = async () => {
    err.textContent = '';
    go.disabled = true;
    try {
      const body = recRow.hidden ? { ticket, code: codeIn.value.trim() } : { ticket, recoveryCode: recIn.value.trim() };
      const d = await apiCall('login/totp', { method: 'POST', body: JSON.stringify(body) });
      auth = { username: d.username };
      lsSet('ptcg.auth', auth);
      ov.remove();
      await pullAndMerge();
      updateAccountButton();
      returnFromSignIn();
      toast('Signed in \u2014 collection synced');
    } catch (ex) {
      err.textContent = ex.message;
      go.disabled = false;
    }
  };
  go.addEventListener('click', submit);
  codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  (document.querySelector('dialog[open]') || document.body).append(ov);
  codeIn.focus();
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
  // the cookie is httpOnly, so signing out has to be asked for — forgetting it
  // here would leave the session alive on the server
  if (auth && serverAvailable) apiCall('logout', { method: 'POST', body: '{}' }).catch(() => { /* leaving anyway */ });
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
  loadMyPrintings();   // called on every auth change — the personal layer follows the account
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
 * `danger: false` for the rare confirmation that is not a warning — something
 * bulk and additive, where the question is "is this the number you expected?"
 * rather than "do you understand what you are about to lose?". Red on a button
 * that only ever adds teaches people to ignore red.
 * @returns {Promise<boolean>} */
function confirmDestructive({ title, body, confirmLabel = 'Delete', cancelLabel = 'Cancel', danger = true }) {
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
          h('button', { class: danger ? 'btn danger' : 'btn', 'data-confirm': '', onclick: () => finish(true) }, confirmLabel))));
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

/* ============================================================
 * How a page draws its cards
 *
 * A set is a hundred pictures, and "which of these am I still missing" is a
 * question about names and numbers, not artwork. Three ways to look at the
 * same printings:
 *
 *   Cards  the grid — the picture is the point (browsing, spotting art)
 *   List   rows with a thumbnail — recognisable, about three times as dense
 *   Text   rows with no pictures at all — a checklist, and nothing to wait for
 *
 * Deliberately not remembered between pages. The choice belongs to the job in
 * front of you: you browse a set in Cards and audit it in Text, often minutes
 * apart, and a preference that followed you around would be wrong about half
 * the time in each direction.
 * ============================================================ */
const CARD_VIEWS = [['grid', 'Cards'], ['list', 'List'], ['text', 'Text']];

function viewSelect(current, onchange) {
  return h('select', { class: 'chip', 'aria-label': 'How to show these cards', onchange: (e) => onchange(e.target.value) },
    ...CARD_VIEWS.map(([v, label]) => {
      const o = h('option', { value: v }, 'View: ' + label);
      if (v === current) o.setAttribute('selected', '');
      return o;
    }));
}

/** The container wears the layout, so switching views is a class swap plus a
 * repaint rather than two parallel trees. */
function applyCardView(container, view) {
  container.className = view === 'grid' ? 'card-grid' : 'card-list' + (view === 'text' ? ' bare' : '');
}

/** One printing, drawn however this page is currently set to draw them. */
function cardEntry(view, card, variant, opts) {
  return view === 'grid' ? cardTile(card, variant, opts)
    : cardRow(card, variant, { ...opts, thumb: view === 'list' });
}

/** One printing as a row: everything a tile says, in a line of text.
 * Same click contract as the tile — tap toggles, complex cards open, ⓘ always
 * opens — so the two views are the same page in different clothes rather than
 * two different pages. */
function cardRow(card, variant, { onOwnershipChange, thumb } = {}) {
  const row = h('div', {
    class: 'card-row',
    role: 'button',
    tabindex: '0',
    onclick: () => {
      if (!canTrack()) { openCardModal(card, { variant, onOwnershipChange }); return; }
      const result = quickToggle(card, variant);
      if (result === 'complex') { openCardModal(card, { variant, onOwnershipChange }); return; }
      decorateRow(row, card);
      if (onOwnershipChange) onOwnershipChange();
    },
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); } },
  });
  row.dataset.cardId = card.id;
  row.dataset.variant = variant;

  if (thumb) {
    const holder = h('div', { class: 'row-thumb' });
    const im = cardImageEl(card, variant, { host: holder, alt: '',
      fallback: () => h('div', { class: 'row-noimg' }, '🃏') });
    holder.append(im || h('div', { class: 'row-noimg' }, '🃏'));
    row.append(holder);
  }
  row.append(h('div', { class: 'row-main' },
    h('div', { class: 'row-name' },
      h('span', {}, card.name || card.id),
      h('span', { class: 'row-variant' }, variantLabel(card, variant)),
    ),
    h('div', { class: 'row-meta muted small' }, `${setNameOf(card.id)} · #${card.localId || localIdOf(card.id)}`),
  ));
  row.append(h('div', { class: 'row-mark' }));
  row.append(h('button', {
    class: 'info-btn', title: 'Card details', 'aria-label': 'Card details',
    onclick: (e) => { e.stopPropagation(); openCardModal(card, { variant, onOwnershipChange }); },
  }, 'ⓘ'));
  decorateRow(row, card);
  return row;
}

/** The tick, the count, and the dimming — the row's half of decorateTile. */
function decorateRow(row, card) {
  const mark = row.querySelector('.row-mark');
  if (!canTrack()) {
    row.classList.remove('missing', 'owned');
    if (mark) mark.textContent = '';
    row.setAttribute('aria-label', (card && card.name) || row.dataset.cardId);
    return;
  }
  const qty = variantQty(row.dataset.cardId, row.dataset.variant);
  row.classList.toggle('missing', qty === 0);
  row.classList.toggle('owned', qty > 0);
  if (mark) mark.textContent = qty ? (qty > 1 ? `\u2713\u00d7${qty}` : '\u2713') : '\u25cb';
  row.setAttribute('aria-label',
    `${(card && card.name) || row.dataset.cardId} \u2014 ${qty ? `owned, ${qty}` : 'not owned'}`);
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
  // the same job for the same printings in their other clothes
  document.querySelectorAll('.card-row').forEach((row) => {
    if (row.dataset.cardId) decorateRow(row, { id: row.dataset.cardId });
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
  await loadMyPrintings();   // the personal layer must be in hand before printings render
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
  const mineWrap = h('div', {});
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
    const mineMap = myPrintingsFor(card.id) || {};
    chipsWrap.replaceChildren(...avail().map((vk) => {
      const qty = track ? variantQty(card.id, vk) : 0;
      // ☆ marks what is yours alone: a personal printing, or your own scan
      const yours = mineMap[vk] ? '☆ ' : '';
      return h('button', {
        type: 'button',
        class: 'chip' + (vk === active ? ' active' : ''),
        title: mineMap[vk] ? 'Personal — only you see this' : undefined,
        onclick: () => { active = vk; renderVariantUI(); },
      }, yours + variantLabel(card, vk) + (qty ? ` ✓${qty > 1 ? '×' + qty : ''}` : ''));
    }));
    if (!track) {
      // browse-only: offer sign-in instead of ownership controls
      counterWrap.replaceChildren(
        h('div', { class: 'row', style: 'justify-content:center; margin-top:6px' },
          h('button', { class: 'btn small', onclick: () => { cardModal.close(); goToAccount(); } },
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
    renderMineControls();
    renderAdminControls();
  }

  /* ---- yours alone: personal printings and your own scans ----
   * For every signed-in account (the admin included — this is how the curator
   * keeps their collector hat separate from the master database). */
  function renderMineControls() {
    mineWrap.replaceChildren();
    if (!auth || !serverAvailable) return;
    const mineMap = myPrintingsFor(card.id) || {};
    const mineRow = mineMap[active] || null;
    const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: '', 'data-mine-upload': '' });
    fileInput.addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const res = await fetch(`api/my/printing-image?cardId=${encodeURIComponent(card.id)}&variant=${encodeURIComponent(active)}&lang=${encodeURIComponent(lang)}`, {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': f.type || 'application/octet-stream' },
          body: f,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        const m = (_myPrints[card.id] = _myPrints[card.id] || {});
        m[active] = { label: (m[active] && m[active].label) || null, img: data.urls };
        toast(`Your scan is on ${variantLabel(card, active)} — only you see it`);
        renderVariantUI();
        refreshBehind();
      } catch (err) { toast(err.message); }
      e.target.value = '';
    });
    mineWrap.append(
      h('div', { class: 'row', style: 'justify-content:center; margin-top:10px' },
        h('button', { type: 'button', class: 'btn ghost small', onclick: async () => {
          const label = prompt('Name of your printing (e.g. "Graded PSA 9", "Shadowless misprint"):');
          if (!label || label.trim().length < 2) return;
          try {
            const r = await apiCall('my/printings', { method: 'POST', body: JSON.stringify({ cardId: card.id, label: label.trim(), lang }) });
            (_myPrints[card.id] = _myPrints[card.id] || {})[r.key] = { label: r.label, img: null };
            active = r.key;
            toast(`Added your printing: ${r.label}`);
            renderVariantUI();
            refreshBehind();
          } catch (err) { toast(err.message); }
        } }, '＋ Add printing (just for you)'),
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => fileInput.click() }, `⬆ Your scan of ${variantLabel(card, active)}`),
        mineRow ? h('button', { type: 'button', class: 'btn ghost small', onclick: async () => {
          try {
            await apiCall('my/printing-remove', { method: 'POST', body: JSON.stringify({ cardId: card.id, variant: active, lang }) });
            const m = _myPrints[card.id];
            if (m) { delete m[active]; if (!Object.keys(m).length) delete _myPrints[card.id]; }
            if (!avail().includes(active)) active = avail()[0];
            toast('Removed — it was only ever yours');
            renderVariantUI();
            refreshBehind();
          } catch (err) { toast(err.message); }
        } }, mineRow.label ? `✕ Remove ${mineRow.label}` : '✕ Remove your scan') : null,
        fileInput,
      ),
      h('p', { class: 'muted small', style: 'text-align:center; margin:6px 0 0' },
        '☆ Yours alone — personal printings and scans live on your account. Nobody else sees them, and publishing never touches them.'),
    );
  }

  // ---- admin: add custom printings & upload your own variant images ----
  function renderAdminControls() {
    adminWrap.replaceChildren();
    // editing writes to the server's database (this install's own copy)
    if (!isAdmin || appConfig.readonly) return;
    const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: '', 'data-master-upload': '' });
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
        } }, '＋ Add printing (master)'),
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => fileInput.click() }, `⬆ Master image for ${variantLabel(card, active)}`),
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
      h('p', { class: 'muted small', style: 'text-align:center; margin:6px 0 0' },
        'Admin — master database: these edits are for everyone' + (appConfig.master ? ', and reach every install when you publish.' : '.') +
        ' For things only you own, use "just for you" above.'),
    );
  }
  renderVariantUI();

  body.replaceChildren(
    h('h2', {}, card.name),
    imgWrap,
    ...rows,
    chipsWrap,
    counterWrap,
    mineWrap,
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
            ? 'Create a free account to mark which cards you own and sync across devices. '
            : 'Every set and card is here to explore.'),
          serverAvailable ? h('a', { class: 'small', href: '/home' }, 'What is this? About & pricing') : null),
        serverAvailable
          ? h('button', { class: 'btn small', onclick: () => goToAccount() }, 'Sign in')
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

  view.replaceChildren(...(runningBanner ? [runningBanner] : []),
    stickyHead(
      banner,
      h('div', { class: 'set-filter' }, filterInput),
      h('div', { class: 'chips' }, ...[sortCtl, newSetBtn].filter(Boolean)),
    ),
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
  // the review overlay lives inside `view`, so re-rendering the page is what
  // takes it away — and the admin page is where the pull's progress shows up
  const backToAdmin = () => { if (location.hash.startsWith('#/admin')) route(); else location.hash = '#/admin'; };
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
  // pictures or text — a per-visit choice, not a saved preference
  let cardView = 'grid';

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
    applyCardView(grid, cardView);
    grid.replaceChildren();
    const q = query.toLowerCase();
    const sorted = sortCards(cards, cardSort, (c) => c.id, (c) => c.name);
    for (const c of sorted) {
      if (q && !c.name.toLowerCase().includes(q) && String(c.localId) !== q) continue;
      for (const vk of realVariants(c)) { // each printing is its own tile
        if (!passesOwnFilter(filter, c.id, vk)) continue;
        grid.append(cardEntry(cardView, c, vk, { onOwnershipChange: updateProgress }));
      }
    }
    if (!grid.children.length) grid.append(h('div', { class: 'center' }, 'No cards match.'));
    // admins get a "new card" tile at the end of the plain set view
    if (isAdmin && filter === 'all' && !q) {
      const nums = cards.map((c) => parseInt(c.localId, 10)).filter(Number.isFinite);
      const next = nums.length ? String(Math.max(...nums) + 1) : '1';
      const addCard = () => openCardEditor({ set: setId, nextNumber: next, onSaved: () => renderSetPage(setId) });
      // a card-shaped tile among rows is a card-shaped hole: in the list views
      // the same door is a button the size of the thing it opens
      grid.append(cardView === 'grid'
        ? h('button', { class: 'add-card-tile', onclick: addCard },
          h('div', { class: 'act-plus' }, '＋'), h('div', { class: 'muted small' }, 'Add card'))
        : h('button', { class: 'btn ghost small add-card-row', onclick: addCard }, '＋ Add card'));
    }
  }

  const chipsWrap = h('div', { class: 'chips' });
  function renderChips() {
    chipsWrap.replaceChildren(
      ...ownFilterChips(filter, (f) => { filter = f; renderChips(); renderGrid(); }),
      sortSelect([['number', 'Card number'], ['name', 'Name A–Z']], cardSort,
        (v) => { cardSort = v; lsSet('ptcg.sort.cards', v); renderGrid(); }),
      viewSelect(cardView, (v) => { cardView = v; renderGrid(); }),
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
    stickyHead(
      stickyTop('#/', '\u2190 All sets', set.name),
      h('div', { class: 'page-head' },
        h('h1', {}, set.name),
        ...(canTrack() ? [h('div', { class: 'prog-stack' },
          h('div', { class: 'prog-row' }, progressLabel, progressWrap),
          h('div', { class: 'prog-row' }, printLabel, printWrap),
        )] : []),
      ),
      h('div', { class: 'set-filter' }, searchInput),
      chipsWrap,
    ),
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

/* ============================================================
 * Links that arrive by email, and the way back in
 * ============================================================ */

/** Landing page for a confirmation link. The token is spent on arrival. */
async function renderVerifyPage(token) {
  view.replaceChildren(spinner());
  const done = (msg, ok) => view.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, ok ? 'Email confirmed' : 'That link did not work')),
    h('p', { class: 'muted' }, msg),
    h('a', { class: 'btn', href: '#/' }, 'Back to your cards'),
  );
  try {
    const r = await apiCall('verify-email', { method: 'POST', body: JSON.stringify({ token }) });
    done(`Thanks, ${r.username} \u2014 this address can now be used to reset your password.`, true);
  } catch (e) {
    done(e.message, false);
  }
}

/** Landing page for a reset link: choose a new password, and be signed in. */
async function renderResetPage(token) {
  const passIn = h('input', { type: 'password', placeholder: `New password (${appConfig.minPassword || 10}+ characters)`, autocomplete: 'new-password' });
  const againIn = h('input', { type: 'password', placeholder: 'Type it again', autocomplete: 'new-password' });
  const err = h('p', { class: 'muted small', style: 'color:var(--accent)' });
  const submit = h('button', { class: 'btn' }, 'Set new password');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (passIn.value !== againIn.value) { err.textContent = 'Those two do not match.'; return; }
      submit.disabled = true;
      try {
        const r = await apiCall('reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword: passIn.value }) });
        auth = { username: r.username };
        lsSet('ptcg.auth', auth);
        updateAccountButton();
        toast('Password changed \u2014 you are signed in');
        location.hash = '#/';
      } catch (ex) {
        err.textContent = ex.message;
        submit.disabled = false;
      }
    },
  },
    h('div', { class: 'field' }, passIn),
    h('div', { class: 'field' }, againIn),
    err,
    submit,
  );
  view.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Choose a new password')),
    h('p', { class: 'muted' }, 'Setting a new password signs out every device that is currently signed in, including any you did not expect.'),
    form,
  );
}

/** Ask for a reset link. The answer is the same whether or not we know you. */
function openForgotPassword() {
  const mailIn = h('input', { type: 'email', placeholder: 'The address on your account', autocomplete: 'email' });
  const note = h('p', { class: 'muted small' });
  const send = h('button', { class: 'btn small' }, 'Send me a link');
  const ov = h('div', { class: 'picker-overlay' },
    h('div', { class: 'picker-panel' },
      h('h3', { style: 'margin:0' }, 'Forgotten password'),
      h('p', { class: 'muted small', style: 'margin:0' }, 'We will send a link that lets you choose a new one. It works once and lasts 45 minutes.'),
      h('div', { class: 'field' }, mailIn),
      note,
      h('div', { class: 'row', style: 'justify-content:flex-end; gap:8px' },
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => ov.remove() }, 'Close'),
        send),
    ));
  send.addEventListener('click', async () => {
    send.disabled = true;
    try {
      const r = await apiCall('forgot-password', { method: 'POST', body: JSON.stringify({ email: mailIn.value.trim() }) });
      note.textContent = r.message;
    } catch (e) {
      note.textContent = e.message;
    }
    send.disabled = false;
  });
  (document.querySelector('dialog[open]') || document.body).append(ov);
}

/* ---- coming back from the identity provider ----
 * The session is already in a cookie by the time the browser lands here; all
 * this has to do is notice, tidy the URL, and get out of the way.
 */
async function afterProviderSignIn(linked) {
  try {
    const me = await apiCall('me');
    auth = { username: me.username };
    lsSet('ptcg.auth', auth);
    await pullAndMerge();
  } catch { /* fall through to the normal page either way */ }
  updateAccountButton();
  toast(linked ? 'Linked \u2014 you can sign in that way now' : 'Signed in \u2014 collection synced');
  // linking was started from the account page, so that is where it belongs back
  location.hash = linked ? '#/account' : '#/';
}

function afterProviderFailure(hash) {
  const why = decodeURIComponent((hash.split('why=')[1] || '').replace(/\+/g, ' ')) || 'That sign-in did not complete.';
  view.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'That sign-in did not work')),
    h('p', { class: 'muted' }, why),
    h('a', { class: 'btn', href: '#/' }, 'Back to your cards'),
  );
}

function afterProviderTotp(hash) {
  const ticket = decodeURIComponent((hash.split('ticket=')[1] || ''));
  location.hash = '#/';
  if (ticket) finishTotpSignIn(ticket);
}

/** Whether this account can also be reached through the provider. */
function providerSection() {
  const wrap = h('div', {});
  if (!appConfig.oidc) return wrap;
  const label = appConfig.oidc.label || 'single sign-on';
  const refresh = async () => { _meCache = null; try { show(await apiCall('me')); } catch { wrap.replaceChildren(); } };
  const show = (me) => {
    const rows = [h('h3', { style: 'margin:0 0 6px' }, label)];
    if (me.oidcLinked) {
      const off = h('button', { class: 'btn ghost small' }, 'Unlink');
      off.addEventListener('click', () => askPassword(`Unlink ${label}`,
        'You will sign in with your password again.', async (pw) => {
          await apiCall('oidc/unlink', { method: 'POST', body: JSON.stringify({ password: pw }) });
          toast('Unlinked'); refresh();
        }));
      rows.push(
        h('p', { class: 'muted small' }, `This account can be reached through ${label}.`),
        h('div', { class: 'row', style: 'gap:8px' }, off),
      );
    } else {
      rows.push(
        h('p', { class: 'muted small' }, `Link this account to ${label} and you can sign in that way instead of typing a password.`),
        h('a', { class: 'btn ghost small', href: 'api/oidc/start?mode=link' }, `Link ${label}`),
      );
    }
    wrap.replaceChildren(...rows.filter(Boolean));
  };
  refresh();
  return wrap;
}

/** Provider settings, for the administrator. */
function providerSettingsSection() {
  const wrap = h('div', {});
  (async () => {
    let cfg;
    try { cfg = await apiCall('oidc-settings'); } catch { return; }
    const f = (label, input, hint) => h('label', { class: 'ce-field' },
      h('span', { class: 'muted small' }, label), input,
      hint ? h('span', { class: 'muted small' }, hint) : null);
    const t = (v, ph, type) => { const i = h('input', { type: type || 'text', placeholder: ph || '' }); i.value = v || ''; return i; };
    const issuer = t(cfg.issuer, 'https://auth.example.com/application/o/cards/');
    const clientId = t(cfg.clientId, 'client id');
    const secret = t('', cfg.secretSet ? 'unchanged' : 'client secret (blank for a public client)', 'password');
    const label = t(cfg.label, 'Single sign-on');
    const unknown = h('select', {},
      h('option', { value: 'link' }, 'Turn away anyone not already linked'),
      h('option', { value: 'create' }, 'Give them a new account'));
    unknown.value = cfg.unknown || 'link';
    const note = h('p', { class: 'muted small', style: 'margin:0' });

    const save = h('button', { class: 'btn small' }, 'Save');
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await apiCall('oidc-settings', { method: 'POST', body: JSON.stringify({
          issuer: issuer.value.trim(), clientId: clientId.value.trim(), clientSecret: secret.value,
          label: label.value.trim(), unknown: unknown.value,
        }) });
        secret.value = '';
        await loadAppConfig();
        note.textContent = 'Saved.';
      } catch (e) { note.textContent = e.message; }
      save.disabled = false;
    });
    const probe = h('button', { class: 'btn ghost small' }, 'Check the provider');
    probe.addEventListener('click', async () => {
      probe.disabled = true;
      note.textContent = 'Asking\u2026';
      try {
        const d = await apiCall('oidc-settings/probe', { method: 'POST', body: '{}' });
        note.textContent = `Answered as ${d.issuer}, publishing ${d.keys} signing key${d.keys === 1 ? '' : 's'}.`;
      } catch (e) { note.textContent = 'Failed: ' + e.message; }
      probe.disabled = false;
    });

    wrap.replaceChildren(...[
      h('h3', { style: 'margin:0 0 6px' }, 'Single sign-on (optional)'),
      h('p', { class: 'muted small', style: 'margin:0' },
        'Point this at any OpenID Connect provider \u2014 Authentik, Keycloak, Zitadel, Pocket ID, Auth0, Okta. Local accounts keep working either way.'),
      cfg.fromEnvironment ? h('p', { class: 'muted small', style: 'color:var(--accent); margin:0' },
        'Some of these come from this server\u2019s environment, which wins over anything saved here.') : null,
      f('Issuer URL', issuer, 'The base the provider serves /.well-known/openid-configuration from.'),
      f('Client ID', clientId),
      f('Client secret', secret, cfg.secretSet ? 'A secret is saved. Leave blank to keep it.' : null),
      f('Name to show on the button', label),
      f('Somebody signs in who is not linked yet', unknown),
      h('p', { class: 'muted small', style: 'margin:0' }, 'Give the provider this redirect URL:'),
      h('pre', { style: 'user-select:all; white-space:pre-wrap; margin:0; font-size:13px' }, cfg.redirectUri),
      h('div', { class: 'row', style: 'gap:8px' }, save, probe),
      note,
    ].filter(Boolean));
  })();
  return wrap;
}

/** The address on this account: add one, change it, confirm it. */
function emailSection() {
  const wrap = h('div', {});
  const refresh = async () => { _meCache = null; try { show(await apiCall('me')); } catch { wrap.replaceChildren(); } };
  const show = (me) => {
    const rows = [h('h3', { style: 'margin:0 0 6px' }, 'Email')];
    if (!appConfig.mailConfigured) {
      rows.push(h('p', { class: 'muted small' }, me.email
        ? `${me.email} \u2014 this server cannot send mail, so it cannot be confirmed or used to reset your password.`
        : 'This server has no mail server configured, so password resets are not available.'));
    } else if (!me.email) {
      rows.push(h('p', { class: 'muted small' }, 'No address on this account. Without one there is no way to reset a forgotten password.'));
    } else if (me.emailVerified) {
      rows.push(h('p', { class: 'muted small' }, `${me.email} \u2014 confirmed. This is where a reset link would go.`));
    } else {
      const resend = h('button', { class: 'btn ghost small' }, 'Send it again');
      resend.addEventListener('click', async () => {
        resend.disabled = true;
        try { await apiCall('email/resend', { method: 'POST', body: '{}' }); toast('Confirmation sent'); }
        catch (e) { toast(e.message); }
        resend.disabled = false;
      });
      rows.push(
        h('p', { class: 'muted small', style: 'color:var(--accent)' },
          `${me.email} \u2014 not confirmed yet. Until it is, it cannot be used to reset your password.`),
        resend,
      );
    }
    const change = h('button', { class: 'btn ghost small' }, me.email ? 'Change address' : 'Add an address');
    change.addEventListener('click', () => {
      const addrIn = h('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'email' });
      addrIn.value = me.email || '';
      askPassword(me.email ? 'Change your address' : 'Add an address',
        'A new address has to be confirmed before it can reset anything.',
        async (pw) => {
          const d = await apiCall('email', { method: 'POST', body: JSON.stringify({ password: pw, email: addrIn.value.trim() }) });
          toast(d.sent ? 'Check your inbox for the confirmation' : 'Saved');
          refresh();
        }, addrIn);
    });
    rows.push(h('div', { class: 'row', style: 'gap:8px; margin-top:6px' }, change));
    wrap.replaceChildren(...rows.filter(Boolean));
  };
  refresh();
  return wrap;
}

/** Mail settings, for an install that was already running when mail arrived. */
function mailSettingsSection() {
  const wrap = h('div', {});
  (async () => {
    let cfg;
    try { cfg = await apiCall('mail-settings'); } catch { return; }
    const f = (label, input, hint) => h('label', { class: 'ce-field' },
      h('span', { class: 'muted small' }, label), input,
      hint ? h('span', { class: 'muted small' }, hint) : null);
    const t = (v, ph, type) => { const i = h('input', { type: type || 'text', placeholder: ph || '' }); i.value = v || ''; return i; };
    const host = t(cfg.host, 'smtp.example.com');
    const port = t(String(cfg.port || 587), '587');
    const userIn = t(cfg.user, 'SMTP username');
    const pass = t('', cfg.passwordSet ? 'unchanged' : 'SMTP password', 'password');
    const from = t(cfg.from, 'Pokemon Tracker <cards@example.com>');
    const pub = t(cfg.publicUrl, 'https://cards.example.com');
    const testTo = t('', 'address to send a test to');
    const note = h('p', { class: 'muted small', style: 'margin:0' });

    const save = h('button', { class: 'btn small' }, 'Save');
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await apiCall('mail-settings', { method: 'POST', body: JSON.stringify({
          host: host.value.trim(), port: port.value.trim(), user: userIn.value.trim(),
          pass: pass.value, from: from.value.trim(), publicUrl: pub.value.trim(),
        }) });
        pass.value = '';
        await loadAppConfig();
        note.textContent = 'Saved.';
      } catch (e) { note.textContent = e.message; }
      save.disabled = false;
    });
    const send = h('button', { class: 'btn ghost small' }, 'Send a test');
    send.addEventListener('click', async () => {
      send.disabled = true;
      note.textContent = 'Sending\u2026';
      try {
        const d = await apiCall('mail-test', { method: 'POST', body: JSON.stringify({ to: testTo.value.trim() }) });
        note.textContent = `Sent to ${d.to}. If it does not arrive, look in the spam folder before changing anything.`;
      } catch (e) { note.textContent = 'Failed: ' + e.message; }
      send.disabled = false;
    });

    wrap.replaceChildren(...[
      h('h3', { style: 'margin:0 0 6px' }, 'Sending mail'),
      h('p', { class: 'muted small', style: 'margin:0' }, cfg.packageAvailable
        ? 'With a mail server, this install can confirm addresses and send password resets. Any provider that gives you SMTP credentials will do.'
        : 'The nodemailer package is not installed on this server, so nothing can be sent yet. Run npm install --omit=dev in the app folder.'),
      cfg.fromEnvironment ? h('p', { class: 'muted small', style: 'color:var(--accent); margin:0' },
        'Some of these come from this server\u2019s environment, which wins over anything saved here.') : null,
      f('SMTP host', host), f('Port', port, '587 upgrades with STARTTLS; 465 is TLS from the start'),
      f('Username', userIn),
      f('Password', pass, cfg.passwordSet ? 'A password is saved. Leave blank to keep it.' : null),
      f('From address', from),
      f('Public address of this app', pub, 'Used to build the links inside emails.'),
      h('div', { class: 'row', style: 'gap:8px' }, save),
      h('hr'),
      f('Send a test message to', testTo, 'Blank sends it to your own address.'),
      h('div', { class: 'row', style: 'gap:8px' }, send),
      note,
    ].filter(Boolean));
  })();
  return wrap;
}

/** The two-factor block in the account panel: turn it on, turn it off, and
 * get a fresh set of recovery codes. */
function twoFactorSection() {
  const wrap = h('div', {});
  const show = (me) => {
    wrap.replaceChildren(h('h3', { style: 'margin:0 0 6px' }, 'Two-factor'));
    if (!me.totpEnabled) {
      wrap.append(
        h('p', { class: 'muted small' }, 'A code from an authenticator app, on top of your password. Nothing to sign up for and nothing to pay \u2014 it works offline, on your phone.'),
        h('button', { class: 'btn small', onclick: () => startTotpEnrolment(() => refresh()) }, 'Turn on two-factor'),
      );
      return;
    }
    const codesBtn = h('button', { class: 'btn ghost small' }, 'New recovery codes');
    codesBtn.addEventListener('click', () => askPassword('New recovery codes',
      'The set you have now stops working.', async (pw) => {
        const d = await apiCall('totp/recovery-codes', { method: 'POST', body: JSON.stringify({ password: pw }) });
        showRecoveryCodes(d.recoveryCodes); refresh();
      }));
    const offBtn = h('button', { class: 'btn ghost small' }, 'Turn off');
    offBtn.addEventListener('click', () => askPassword('Turn off two-factor',
      'Your password alone will sign you in again.', async (pw) => {
        await apiCall('totp/disable', { method: 'POST', body: JSON.stringify({ password: pw }) });
        toast('Two-factor is off'); refresh();
      }));
    // append(), like replaceChildren(), stringifies a null child into the
    // literal text "null" — only h() filters them out. Filter the list.
    wrap.append(...[
      h('p', { class: 'muted small' }, `On. ${me.recoveryLeft} recovery code${me.recoveryLeft === 1 ? '' : 's'} left.`),
      me.recoveryLeft <= 2 ? h('p', { class: 'muted small', style: 'color:var(--accent)' },
        'Running low \u2014 make a fresh set while you can still sign in.') : null,
      h('div', { class: 'row', style: 'gap:8px' }, codesBtn, offBtn),
    ].filter(Boolean));
  };
  const refresh = async () => { _meCache = null; try { show(await apiCall('me')); } catch { wrap.replaceChildren(); } };
  refresh();
  return wrap;
}

/** Ask for the current password before something that weakens the account. */
function askPassword(title, why, andThen, extraInput) {
  const pwIn = h('input', { type: 'password', placeholder: 'Your password', autocomplete: 'current-password' });
  const err = h('p', { class: 'muted small', style: 'color:var(--accent); margin:0' });
  const go = h('button', { class: 'btn small' }, 'Continue');
  const ov = h('div', { class: 'picker-overlay' },
    h('div', { class: 'picker-panel' },
      h('h3', { style: 'margin:0' }, title),
      h('p', { class: 'muted small', style: 'margin:0' }, why),
      extraInput ? h('div', { class: 'field' }, extraInput) : null,
      h('div', { class: 'field' }, pwIn), err,
      h('div', { class: 'row', style: 'justify-content:flex-end; gap:8px' },
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => ov.remove() }, 'Cancel'), go),
    ));
  go.addEventListener('click', async () => {
    err.textContent = ''; go.disabled = true;
    try { await andThen(pwIn.value); ov.remove(); }
    catch (e) { err.textContent = e.message; go.disabled = false; }
  });
  (document.querySelector('dialog[open]') || document.body).append(ov);
  pwIn.focus();
}

/** Recovery codes are shown once. Say so, and make them easy to keep. */
function showRecoveryCodes(codes) {
  const ov = h('div', { class: 'picker-overlay' },
    h('div', { class: 'picker-panel' },
      h('h3', { style: 'margin:0' }, 'Your recovery codes'),
      h('p', { class: 'muted small', style: 'margin:0' }, 'Each one signs you in once if you lose your authenticator. This is the only time they are shown \u2014 the server keeps only their hashes.'),
      h('pre', { style: 'user-select:all; white-space:pre-wrap; font-size:15px; line-height:1.8; margin:0' }, codes.join('\n')),
      h('div', { class: 'row', style: 'justify-content:flex-end; gap:8px' },
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => {
          const blob = new Blob([codes.join('\n') + '\n'], { type: 'text/plain' });
          const a = h('a', { href: URL.createObjectURL(blob), download: 'ptcg-recovery-codes.txt' });
          a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        } }, 'Download'),
        h('button', { type: 'button', class: 'btn small', onclick: () => ov.remove() }, 'I have saved these')),
    ));
  (document.querySelector('dialog[open]') || document.body).append(ov);
}

/** Enrolment: hand over the secret, then prove the app really has it. */
async function startTotpEnrolment(done) {
  let setup;
  try { setup = await apiCall('totp/setup', { method: 'POST', body: '{}' }); }
  catch (e) { toast(e.message); return; }
  // grouped in fours: this is going to be typed by hand on a second device
  const pretty = setup.secret.replace(/(.{4})/g, '$1 ').trim();
  const codeIn = h('input', { type: 'text', inputmode: 'numeric', placeholder: '6-digit code', maxlength: '7' });
  const err = h('p', { class: 'muted small', style: 'color:var(--accent); margin:0' });
  const go = h('button', { class: 'btn small' }, 'Turn it on');
  // The picture is optional — an install without the QR package still enrols
  // perfectly well from the key below it, just with more typing.
  let qrBox = null;
  if (setup.qrSvg) {
    qrBox = h('div', { style: 'background:#fff; border-radius:8px; padding:8px; align-self:center; max-width:220px' });
    qrBox.innerHTML = setup.qrSvg;
  }
  const ov = h('div', { class: 'picker-overlay' },
    h('div', { class: 'picker-panel' },
      h('h3', { style: 'margin:0' }, 'Set up two-factor'),
      h('p', { class: 'muted small', style: 'margin:0' }, qrBox
        ? 'Scan this with your authenticator app. On this phone, open the link instead \u2014 or type the key by hand.'
        : 'On this phone, open the link. On a computer, type the key into the authenticator app on your phone.'),
      qrBox,
      h('p', { style: 'margin:0' }, h('a', { class: 'btn small', href: setup.otpauth }, 'Open in my authenticator app')),
      h('p', { class: 'muted small', style: 'margin:0' }, 'Setup key'),
      h('pre', { style: 'user-select:all; font-size:16px; letter-spacing:1px; white-space:pre-wrap; margin:0' }, pretty),
      h('p', { class: 'muted small', style: 'margin:0' }, 'Then enter the code it shows, to prove it arrived:'),
      h('div', { class: 'field' }, codeIn), err,
      h('div', { class: 'row', style: 'justify-content:flex-end; gap:8px' },
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => ov.remove() }, 'Cancel'), go),
    ));
  go.addEventListener('click', async () => {
    err.textContent = ''; go.disabled = true;
    try {
      const d = await apiCall('totp/enable', { method: 'POST', body: JSON.stringify({ code: codeIn.value.trim() }) });
      ov.remove();
      showRecoveryCodes(d.recoveryCodes);
      if (done) done();
    } catch (e) { err.textContent = e.message; go.disabled = false; }
  });
  (document.querySelector('dialog[open]') || document.body).append(ov);
  codeIn.focus();
}

/** First run: claim the install with the code printed in its own log. */
function renderSetupPage(status) {
  const f = (label, input, hint) => h('label', { class: 'ce-field' },
    h('span', { class: 'muted small' }, label), input,
    hint ? h('span', { class: 'muted small' }, hint) : null);
  const t = (ph, type) => h('input', { type: type || 'text', placeholder: ph || '' });

  const codeIn = t('Paste the setup code');
  const userIn = t('Username');
  const passIn = t('Password (10+ characters)', 'password');
  const mailIn = t('you@example.com', 'email');
  const urlIn = t('https://cards.example.com');
  const regSel = h('select', {},
    h('option', { value: 'open' }, 'Anyone may create an account'),
    h('option', { value: 'closed' }, 'Only me \u2014 no one else may sign up'));
  const smtpHost = t('smtp.example.com');
  const smtpPort = t('587');
  const smtpUser = t('SMTP username');
  const smtpPass = t('SMTP password', 'password');
  const smtpFrom = t('Pokemon Tracker <cards@example.com>');
  const err = h('p', { class: 'muted small', style: 'color:var(--accent)' });
  const go = h('button', { class: 'btn' }, 'Claim this install');

  const mailBlock = h('div', {},
    h('p', { class: 'muted small' }, status.mailPossible
      ? 'Optional. With a mail server the app can confirm addresses and send password resets. Any provider that gives you SMTP credentials will do \u2014 or your own mail server.'
      : 'The nodemailer package is not installed on this server, so mail is unavailable for now. You can add it later and fill this in from the Administration panel.'),
    f('SMTP host', smtpHost), f('Port', smtpPort), f('Username', smtpUser),
    f('Password', smtpPass), f('From address', smtpFrom),
  );

  go.addEventListener('click', async () => {
    err.textContent = '';
    go.disabled = true;
    try {
      const r = await fetch('api/setup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: codeIn.value.trim(),
          username: userIn.value.trim(),
          password: passIn.value,
          email: mailIn.value.trim(),
          registration: regSel.value,
          publicUrl: urlIn.value.trim(),
          smtp: smtpHost.value.trim() ? {
            host: smtpHost.value.trim(), port: smtpPort.value.trim() || '587',
            secure: (smtpPort.value.trim() || '587') === '465',
            user: smtpUser.value.trim(), pass: smtpPass.value, from: smtpFrom.value.trim(),
          } : undefined,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Setup failed (${r.status})`);
      auth = { username: d.username };
      lsSet('ptcg.auth', auth);
      await loadAppConfig();
      updateAccountButton();
      toast('This install is yours');
      location.hash = '#/';
      route();
    } catch (ex) {
      err.textContent = ex.message;
      go.disabled = false;
    }
  });

  view.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Set up this install')),
    h('p', { class: 'muted' },
      'Nobody owns this server yet. Its log printed a setup code when it started \u2014 on Proxmox that is the container console, under Docker it is `docker logs`. Paste it here to claim the install as its administrator.'),
    h('div', { class: 'ce-field' },
      f('Setup code', codeIn),
      h('hr'),
      f('Your username', userIn),
      f('Your password', passIn),
      f('Your email', mailIn, 'Used to confirm the address and to reset your password. Leave blank to skip.'),
      f('Public address', urlIn, 'Where people reach this app, used to build links in emails.'),
      f('Who may sign up', regSel),
      h('hr'),
      h('h3', { style: 'margin:0' }, 'Sending mail'),
      mailBlock,
      err,
      go,
    ),
  );
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
    stickyHead(
      stickyTop(null, null, 'Pok\u00e9mon'),
      h('div', { class: 'page-head' }, h('h1', {}, 'Pok\u00e9mon')),
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Every printing of each Pok\u00e9mon, across all sets.'),
      h('div', { class: 'set-filter' }, filterInput),
      h('div', { class: 'chips' },
        sortSelect([['dex', 'Dex number'], ['most-owned', 'Most owned'], ['least-owned', 'Least owned']], spSort,
          (v) => { spSort = v; lsSet('ptcg.sort.species', v); renderList(filterInput.value.trim().toLowerCase()); }),
      ),
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

  let cardView = 'grid';
  let filter = 'all';
  const chipsWrap = h('div', { class: 'chips' });
  function renderGrid() {
    applyCardView(grid, cardView);
    grid.replaceChildren();
    const cards = sortCards(sp.cards, pokeSort, (c) => c.id, (c) => c.name);
    for (const c of cards) {
      for (const vk of realVariants(c)) {
        if (!passesOwnFilter(filter, c.id, vk)) continue;
        grid.append(cardEntry(cardView, c, vk, { onOwnershipChange: updateProgress }));
      }
    }
    // a species you have finished, filtered to Missing, is an empty page that
    // should say why rather than looking broken
    if (!grid.children.length) {
      grid.append(h('div', { class: 'center' }, filter === 'missing'
        ? 'Nothing missing — you have every printing of this Pokémon.'
        : filter === 'owned' ? 'None of these yet.' : 'No cards.'));
    }
  }
  function renderChips() {
    chipsWrap.replaceChildren(
      ...ownFilterChips(filter, (f) => { filter = f; renderChips(); renderGrid(); }),
      sortSelect([['newest', 'Newest set'], ['oldest', 'Oldest set'], ['name', 'Name A–Z'], ['number', 'Card number']], pokeSort,
        (v) => { pokeSort = v; lsSet('ptcg.sort.pokemon', v); renderGrid(); }),
      viewSelect(cardView, (v) => { cardView = v; renderGrid(); }),
    );
  }
  renderChips();
  renderGrid();

  const spTitle = `#${String(sp.dex).padStart(3, '0')} ${sp.name}`;
  view.replaceChildren(
    stickyHead(
      stickyTop('#/pokemon', '\u2190 All Pok\u00e9mon', spTitle),
      h('div', { class: 'page-head' },
        h('h1', {}, spTitle),
        ...(canTrack() ? [h('div', { class: 'prog-stack' },
          h('div', { class: 'prog-row' }, progressLabel, pWrap),
          h('div', { class: 'prog-row' }, vLabel, vWrap),
        )] : []),
      ),
      chipsWrap,
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
  let cardView = 'grid';
  let filter = 'all';
  let searchSort = lsGet('ptcg.sort.search') || 'newest';
  const shown = new Set();   // card ids already on the page — a card belongs here once
  let loadSeq = 0;           // only the newest request may touch the grid
  const results = h('div', { class: 'card-grid' });
  const status = h('div', { class: 'center' });
  const moreBtn = h('button', { class: 'btn ghost load-more', onclick: () => load(false) }, 'Load more');
  moreBtn.hidden = true;

  // rebuilt whenever a chip changes, so it has to be told what it is currently
  // showing — a control that silently forgets its own value is worse than none
  const select = (label, options, current, onchange) => {
    const el = h('select', { class: 'chip', 'aria-label': label, onchange: (e) => onchange(e.target.value) },
      h('option', { value: '' }, label),
      ...options.map((o) => h('option', { value: o }, o)));
    el.value = current || '';
    return el;
  };

  const chipsWrap = h('div', { class: 'chips' });
  function renderChips() {
    chipsWrap.replaceChildren(
      ...ownFilterChips(filter, (f) => { filter = f; renderChips(); load(true); }),
      select('Rarity', idx.rarities, rarity, (v) => { rarity = v; load(true); }),
      select('Type', idx.types, type, (v) => { type = v; load(true); }),
      sortSelect([['newest', 'Newest set'], ['oldest', 'Oldest set'], ['name', 'Name A–Z'], ['number', 'Card number']], searchSort,
        (v) => { searchSort = v; lsSet('ptcg.sort.search', v); load(true); }),
      viewSelect(cardView, (v) => { cardView = v; load(true); }),
    );
  }

  async function load(reset) {
    const seq = ++loadSeq;   // a filter changed mid-flight belongs to the newer request
    if (reset) { page = 1; applyCardView(results, cardView); results.replaceChildren(); shown.clear(); }
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
          for (const vk of realVariants(c)) {
            if (!passesOwnFilter(filter, c.id, vk)) continue;
            results.append(cardEntry(cardView, c, vk));
            added++;                       // count what landed, not what was read
          }
        }
      }
      status.replaceChildren();
      if (!results.children.length) {
        status.textContent = filter === 'missing' ? 'Nothing missing in these results.'
          : filter === 'owned' ? 'None of these are in your collection yet.'
            : 'No cards found.';
      }
      moreBtn.hidden = !more;
    } catch (e) {
      if (seq !== loadSeq) return;
      status.replaceChildren();
      status.textContent = 'Search failed: ' + e.message;
    }
  }

  const seTitle = query ? `Search: \u201c${query}\u201d` : 'Browse cards';
  view.replaceChildren(
    stickyHead(
      stickyTop('#/', '\u2190 All sets', seTitle),
      h('div', { class: 'page-head' }, h('h1', {}, seTitle)),
      chipsWrap,
    ),
    results,
    status,
    moreBtn,
  );
  renderChips();
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
  // The scanner is a Premium feature (and still baking — "coming soon" is
  // the honest label). Admins see the working page for testing; everyone
  // else gets told what it will be, not a half-broken tool.
  if (serverAvailable) {
    let m = null;
    if (auth) { try { m = await ensureMe(); } catch { /* offline — fall through to the pitch */ } }
    if (!m || m.plan !== 'premium') {
      view.replaceChildren(h('div', { class: 'center', style: 'padding:40px 16px; max-width:420px; margin:0 auto' },
        h('div', { style: 'font-size:42px' }, '📷'),
        h('h1', { style: 'margin:10px 0 6px' }, 'Card scanner'),
        h('p', { class: 'muted', style: 'margin:0 0 14px' },
          'Point your camera at a card and find out on the spot whether you already have it. Coming soon, as part of Master Set Premium.'),
        auth
          ? (m && m.upgradeUrl
            ? h('a', { class: 'btn', href: m.upgradeUrl, target: '_blank', rel: 'noopener' }, '⭐ Get Master Set Premium — $2.99/mo')
            : h('p', { class: 'muted small', style: 'margin:0' }, 'Premium sign-ups open soon.'))
          : h('button', { class: 'btn', onclick: () => goToAccount() }, 'Sign in first'),
      ));
      return;
    }
  }
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
    pageFooter('#/', '\u2190 Back'),
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
 * Account & administration pages
 *
 * These were one dialog with fourteen unrelated things stacked inside it:
 * who you are, how you sign in, what language the cards are in, whether the
 * scanner index needs rebuilding, and the SMTP password. A dialog is the
 * wrong shape for that — it has no address, no back button, and no room.
 *
 * So: two pages. #/account is about the person signed in. #/admin is about
 * the server they are signed in to. Each carries its tab in the URL, which
 * means the back button works, a bookmark lands where you left it, and a
 * screenshot of a problem comes with the address of the screen it is on.
 * ============================================================ */

/** One bordered block. Sections that fill themselves in from the server get
 * their card immediately and their content when the answer arrives, so the
 * page settles rather than reflowing under the reader. */
function settingsCard(...kids) {
  return h('section', { class: 'settings-card' }, ...kids.filter(Boolean));
}

/** append() and replaceChildren() turn a null child into the literal text
 * "null" — only h() filters. Everything on these pages goes through here. */
function addTo(el, ...kids) {
  el.append(...kids.filter(Boolean));
  return el;
}

/** Tabs are links, not buttons: each one is an address. */
function settingsTabs(base, tabs, active) {
  return h('nav', { class: 'tabs' }, ...tabs.map(([id, label]) =>
    h('a', { class: id === active ? 'active' : '', href: `#/${base}/${id}` }, label)));
}

function settingsHead(title, ...extras) {
  return addTo(h('div', { class: 'page-head' }, h('h1', {}, title)), ...extras);
}

/* ---- pieces the account page is made of ---- */

/** Card language. Removes itself where only one language is installed —
 * a menu with one item in it is furniture, not a choice. */
function languageCard() {
  const card = settingsCard();
  (async () => {
    let langs = [];
    try { langs = await getLanguages(); } catch { /* offline: nothing to offer */ }
    if (langs.length <= 1) { card.remove(); return; }
    const sel = h('select', { class: 'chip', 'aria-label': 'Card language', onchange: (e) => {
      lang = e.target.value;
      lsSet('ptcg.lang', lang);
      clearDataCaches();
      _myPrints = {}; _myPrintsKey = null;   // the personal layer is per-language too
      loadMyPrintings();
      toast('Language switched');
      route();
    } }, ...langs.map((l) => {
      const o = h('option', { value: l.code }, l.name || l.code);
      if (l.code === lang) o.setAttribute('selected', '');
      return o;
    }));
    card.append(
      h('h3', { style: 'margin:0 0 6px' }, 'Card language'),
      h('p', { class: 'muted small', style: 'margin:0 0 10px' },
        'Your collection is shared across languages \u2014 only names and images change.'),
      sel,
    );
  })();
  return card;
}

/** Export and import. The file input lives in index.html rather than here,
 * because replaceChildren() on a page re-render would otherwise take it away
 * while the file picker was still open on top of it. */
function backupCard() {
  return settingsCard(
    h('h3', { style: 'margin:0 0 6px' }, 'Backup'),
    h('p', { class: 'muted small', style: 'margin:0 0 10px' },
      'Your collection is saved on this device, and on this server when you are signed in. Export a file any time \u2014 import it on another device, or keep it as insurance.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn small', onclick: () => exportCollection() }, 'Export collection'),
      h('button', { class: 'btn ghost small', onclick: () => document.getElementById('import-file').click() }, 'Import collection'),
    ),
  );
}

function aboutCard() {
  return settingsCard(
    h('h3', { style: 'margin:0 0 6px' }, 'About'),
    h('p', { class: 'muted small', style: 'margin:0 0 6px' },
      `Version ${appConfig.release ? 'v' + appConfig.release : APP_VERSION} \u00b7 app build ${APP_VERSION}`),
    h('p', { class: 'muted small', style: 'margin:0 0 10px' },
      'Card data and images are self-hosted (built with the included downloader). This app is not affiliated with Nintendo or The Pok\u00e9mon Company.'),
    h('div', { class: 'row' },
      h('a', { class: 'btn ghost small', href: '#/debug' }, 'Debug info'),
      h('button', { class: 'btn ghost small', onclick: () => repairApp() }, 'Repair & reload'),
    ),
  );
}

/** Change the password. The endpoint has been there all along; until now the
 * only way to reach it was to claim you had forgotten a password you had not,
 * and wait for an email about it. */
function passwordSection() {
  const min = appConfig.minPassword || 10;
  const cur = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Current password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', placeholder: `New password (${min}+ characters)` });
  const again = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Type the new one again' });
  const note = h('p', { class: 'muted small', style: 'margin:0' });
  const save = h('button', { class: 'btn small' }, 'Change password');
  const f = (label, input) => h('label', { class: 'ce-field' }, h('span', { class: 'muted small' }, label), input);
  const bad = (msg) => { note.style.color = 'var(--accent)'; note.textContent = msg; };

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      note.style.color = '';
      note.textContent = '';
      if (next.value !== again.value) return bad('Those two do not match.');
      save.disabled = true;
      try {
        await apiCall('change-password', { method: 'POST', body: JSON.stringify({
          currentPassword: cur.value, newPassword: next.value,
        }) });
        cur.value = next.value = again.value = '';
        note.textContent = 'Changed. Every other device that was signed in has been signed out; this one stays.';
      } catch (ex) { bad(ex.message); }
      save.disabled = false;
    },
  },
    f('Current password', cur),
    f('New password', next),
    f('Type it again', again),
    h('div', { class: 'row', style: 'gap:8px; margin-top:8px' }, save),
    note,
  );
  return h('div', {},
    h('h3', { style: 'margin:0 0 6px' }, 'Password'),
    h('p', { class: 'muted small', style: 'margin:0 0 8px' },
      'A new password ends every other session \u2014 useful on its own, if you think somebody else has one.'),
    form,
  );
}

/** The signed-out card: sign in, create an account, or go through a provider. */
function signInCard() {
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
    type: 'password', name: 'password', id: 'ptcg-password', placeholder: `Password (${appConfig.minPassword || 10}+ characters)`,
    autocomplete: 'current-password',
  });
  const submit = h('button', { class: 'btn', style: 'width:100%' }, 'Sign in');

  // An address is the only way back in if the password goes. Optional, because
  // an install with no mail server configured cannot do anything with one.
  const mailIn = h('input', {
    type: 'email', name: 'email', id: 'ptcg-email', placeholder: 'Email (for password resets)',
    autocomplete: 'email', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
  });
  const mailRow = h('div', { class: 'field' }, mailIn);
  mailRow.hidden = true;

  const tabs = h('div', { class: 'tabs' },
    h('button', { type: 'button', class: 'active', onclick: (e) => switchMode('login', e.target) }, 'Sign in'),
    h('button', { type: 'button', onclick: (e) => switchMode('register', e.target) }, 'Create account'),
  );

  const forgotRow = h('div', { style: 'text-align:right' },
    h('button', { type: 'button', class: 'btn ghost small', onclick: () => openForgotPassword() }, 'Forgot password?'));
  forgotRow.hidden = !appConfig.mailConfigured;

  function switchMode(m, btn) {
    mode = m;
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    submit.textContent = m === 'login' ? 'Sign in' : 'Create account';
    // "new-password" tells the password manager this is a sign-up field (offer to
    // generate/save), "current-password" that it's an existing login (offer to fill)
    passIn.setAttribute('autocomplete', m === 'login' ? 'current-password' : 'new-password');
    mailRow.hidden = !(m === 'register' && appConfig.mailConfigured);
    forgotRow.hidden = !(m === 'login' && appConfig.mailConfigured);
    err.textContent = '';
  }

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        const r = await doAuth(mode, userIn.value.trim(), passIn.value, mode === 'register' ? mailIn.value.trim() : null);
        if (r && r.needTotp) { submit.disabled = false; finishTotpSignIn(r.ticket); return; }
        toast(mode === 'login' ? 'Signed in \u2014 collection synced' : 'Account created \u2014 collection synced');
        returnFromSignIn();
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        submit.disabled = false;
      }
    },
  },
    tabs,
    h('div', { class: 'field' }, userIn),
    mailRow,
    h('div', { class: 'field' }, passIn),
    err,
    submit,
  );

  // deliberately outside the form: it opens a panel rather than submitting
  // anything, and inside it would be a second `.btn` for anything aiming at
  // the submit button to trip over
  const ssoRow = appConfig.oidc
    ? h('div', { style: 'margin-top:10px' },
      h('a', { class: 'btn', style: 'width:100%; display:block; text-align:center', href: 'api/oidc/start' },
        `Sign in with ${appConfig.oidc.label}`))
    : null;

  return settingsCard(
    h('p', { class: 'muted small', style: 'margin:0 0 12px' },
      'Sign in to mark which cards you own and keep them in step across every device.'),
    form, forgotRow, ssoRow,
  );
}

/* ---- where sign-in came from ----
 * A dialog could close and leave you where you were. A page cannot, so it
 * remembers instead: whoever sends somebody here to sign in says where they
 * were reading, and that is where they go back to. */
let signInReturn = null;

function goToAccount(returnTo) {
  signInReturn = returnTo || location.hash || '#/';
  location.hash = '#/account';
}

function returnFromSignIn() {
  const back = signInReturn || '#/';
  signInReturn = null;
  // an unchanged hash fires no hashchange, so re-render by hand
  if ((location.hash || '#/') === back) route();
  else location.hash = back;
}

/* ---- the account page ---- */
const ACCOUNT_TABS = [
  ['account', 'Account'],
  ['security', 'Security'],
  ['data', 'Data'],
  ['about', 'About'],
];

function renderAccountPage(tab) {
  if (!ACCOUNT_TABS.some(([id]) => id === tab)) tab = 'account';
  const page = h('div', { class: 'settings-page', id: 'account-page' });
  view.replaceChildren(page);

  // Standalone: no server, so no account — but the local collection is still
  // real, and a backup of it is the one thing worth offering.
  if (!serverAvailable) {
    addTo(page,
      settingsHead('Account'),
      settingsCard(
        h('h3', { style: 'margin:0 0 6px' }, 'No server behind this app'),
        h('p', { class: 'muted small', style: 'margin:0' },
          'Syncing needs the bundled server. Right now the app is running standalone, so your collection lives on this device alone \u2014 export a backup below.'),
      ),
      backupCard(), languageCard(), aboutCard(),
    );
    return;
  }

  // Signed out, two of the four tabs would be empty and one would be a lie.
  if (!auth) {
    addTo(page, settingsHead('Sign in'), signInCard(), languageCard(), aboutCard());
    return;
  }

  const head = settingsHead('Account');
  addTo(page, head, settingsTabs('account', ACCOUNT_TABS, tab));
  // administration is somewhere to go, not something to read here
  (async () => {
    try {
      const me = await apiCall('me');
      if (me.admin) head.append(h('a', { class: 'btn ghost small', href: '#/admin', style: 'margin-left:auto' }, 'Administration'));
    } catch { /* the cards below will say what went wrong */ }
  })();

  if (tab === 'account') {
    // Which tier, and the door to the other one. Filled in async — the plan
    // lives server-side and only the server may say it.
    const planCard = settingsCard(
      h('h3', { style: 'margin:0 0 6px' }, 'Plan'),
      h('p', { class: 'muted small', style: 'margin:0' }, 'Checking…'));
    (async () => {
      let m = null;
      try { m = await ensureMe(); } catch { /* leave the checking line */ }
      if (!m) return;
      planCard.replaceChildren(
        h('h3', { style: 'margin:0 0 6px' }, 'Plan'),
        m.plan === 'premium'
          ? h('div', {},
            h('p', { style: 'margin:0' + (m.portalUrl ? ' 0 10px' : '') }, '⭐ ', h('strong', {}, 'Master Set Premium'),
              m.admin ? ' (administrator accounts are always Premium).' : ' — unlimited binders, and the card scanner when it ships.'),
            m.portalApi
              ? h('button', { class: 'btn ghost small', onclick: async (e) => {
                e.target.disabled = true;
                // open the tab NOW, synchronously in the click — popup blockers
                // allow that, then we point it at the session once it exists
                const tab = window.open('', '_blank');
                try {
                  const r = await apiCall('billing/portal', { method: 'POST', body: '{}' });
                  if (tab) { tab.opener = null; tab.location = r.url; } else { location.href = r.url; }
                } catch (err) { if (tab) tab.close(); toast(err.message); }
                e.target.disabled = false;
              } }, '⚙ Manage subscription')
              : m.portalUrl
                ? h('div', {},
                  h('a', { class: 'btn ghost small', href: m.portalUrl, target: '_blank', rel: 'noopener' }, '⚙ Manage subscription'),
                  h('p', { class: 'muted small', style: 'margin:6px 0 0' }, 'Use the email from your purchase receipt to sign in.'))
                : null)
          : h('div', {},
            h('p', { style: 'margin:0 0 4px' }, h('strong', {}, 'Free'), ' — full collection tracking and one binder.'),
            h('p', { class: 'muted small', style: 'margin:0 0 10px' }, 'Master Set Premium adds unlimited binders, and the card scanner when it ships.'),
            m.upgradeUrl
              ? h('a', { class: 'btn small', href: m.upgradeUrl, target: '_blank', rel: 'noopener' }, '⭐ Upgrade to Master Set Premium — $2.99/mo')
              : h('p', { class: 'muted small', style: 'margin:0' }, 'Premium sign-ups open soon.')),
      );
    })();
    addTo(page,
      planCard,
      settingsCard(
        h('h3', { style: 'margin:0 0 6px' }, 'Your account'),
        h('p', { style: 'margin:0 0 4px' }, 'Signed in as ', h('strong', {}, auth.username), '.'),
        h('p', { class: 'muted small', style: 'margin:0' }, syncState === 'error'
          ? 'The last sync failed \u2014 your changes are saved on this device and will be retried.'
          : 'Your collection syncs to this server automatically.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn small', onclick: async (e) => {
            e.target.disabled = true;
            try { await pullAndMerge(); toast('Synced'); route(); }
            catch (ex) { e.target.disabled = false; toast('Sync failed: ' + ex.message); }
          } }, 'Sync now'),
          h('button', { class: 'btn ghost small', onclick: () => { logout(); location.hash = '#/'; } }, 'Sign out'),
        ),
      ),
      settingsCard(emailSection()),
      appConfig.oidc ? settingsCard(providerSection()) : null,
    );
  } else if (tab === 'security') {
    addTo(page, settingsCard(twoFactorSection()), settingsCard(passwordSection()));
  } else if (tab === 'data') {
    addTo(page, languageCard(), backupCard());
  } else {
    addTo(page, aboutCard());
  }
}

/* ---- the administration page ---- */
function adminTabList() {
  const tabs = [['cards', 'Card database']];
  // nothing to configure on an install whose data is managed elsewhere
  if (!appConfig.readonly) tabs.push(['mail', 'Mail'], ['signon', 'Sign-on']);
  tabs.push(['server', 'Server']);
  return tabs;
}

function renderAdminPage(tab) {
  const tabs = adminTabList();
  if (!tabs.some(([id]) => id === tab)) tab = 'cards';
  const backLink = () => h('a', { class: 'back-link', href: '#/account' }, '\u2190 Account');
  const page = h('div', { class: 'settings-page', id: 'admin-page' }, backLink(), settingsHead('Administration'), spinner());
  view.replaceChildren(page);

  (async () => {
    const only = (msg) => page.replaceChildren(backLink(), settingsHead('Administration'),
      settingsCard(h('p', { class: 'muted', style: 'margin:0' }, msg)),
      pageFooter('#/account', '\u2190 Account'));
    if (!serverAvailable || !auth) return only('Sign in with the account that set this install up.');
    let me;
    try { me = await apiCall('me'); }
    catch (e) { return only('Could not ask this server who you are: ' + e.message); }
    if (!me.admin) {
      return only('This page belongs to the account that set this install up. Yours is not it \u2014 which is exactly as it should be.');
    }
    page.replaceChildren(...[
      backLink(),
      settingsHead('Administration'),
      appConfig.master ? h('p', { class: 'muted small', style: 'border:1px solid var(--owned); border-radius:8px; padding:8px 10px' },
        '🛠️ Master curation workspace \u2014 edits made here become the master database when you publish (scripts/publish-images.js). This is not a personal install.') : null,
      settingsTabs('admin', tabs, tab),
      tab === 'mail' ? settingsCard(mailSettingsSection())
        : tab === 'signon' ? settingsCard(providerSettingsSection())
          : tab === 'server' ? adminServerTab()
            : adminCardsTab(),
      pageFooter('#/account', '\u2190 Account'),
    ].filter(Boolean));
  })();
}

/** Card database: what is here, whether the master has moved on, and the
 * jobs that rebuild the parts of it this server derives for itself. */
function adminCardsTab() {
  const content = h('div', {});
  if (appConfig.readonly) {
    content.append(settingsCard(
      h('h3', { style: 'margin:0 0 6px' }, 'Card database'),
      h('p', { class: 'muted small', style: 'margin:0' },
        'This server runs in read-only mode (PTCG_READONLY): the card database is managed centrally and cannot be changed from the app.'),
    ));
    return content;
  }

  async function renderControls() {
    const status = await getBuildStatus();
    if (status && status.running) {
      const msg = status.phase === 'images' ? 'Downloading card images to this server:'
        : status.phase === 'mirror' ? 'Copying the card database:'
          : 'Working on the card database:';
      content.replaceChildren(settingsCard(
        h('h3', { style: 'margin:0 0 6px' }, 'Card database'),
        h('p', { class: 'muted small' }, msg),
        buildProgressView(async () => { await loadAppConfig(); clearDataCaches(); toast('Done'); renderControls(); }),
      ));
      return;
    }
    let stats = {};
    try { stats = await catGet('stats'); } catch { /* the counts are a nicety */ }
    const img = appConfig.images || {};   // { local, remote }

    // master update check: ping the tiny catalog.json manifest and offer a
    // data-only update when this install is behind (no images move — they
    // stay wherever they are, on the CDN or already downloaded locally).
    // Not in the maintainer workspace: it PRODUCES the master — pulling its
    // own published output back would be circular.
    const updateArea = h('div', {});
    if (appConfig.remoteCatalog && !appConfig.master) {
      updateArea.append(h('p', { class: 'muted small' }, 'Checking the master database for updates\u2026'));
      (async () => {
        let chk = null;
        try { chk = await catGet('update-check'); } catch { /* offline */ }
        if (!chk || !chk.configured) { updateArea.replaceChildren(); return; }
        if (!chk.reachable) {
          // an auth refusal from the card API names itself; plain unreachable stays vague on purpose
          updateArea.replaceChildren(h('p', { class: 'muted small' }, chk.refusal
            ? 'Update check refused: ' + chk.refusal + '.'
            : 'Master database not reachable right now \u2014 update check skipped.'));
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
                  else openPullReview(prev);
                } catch (err) { e.target.disabled = false; toast(err.message); }
              } }, `⬇️ Update cards from master (v${chk.localVersion} \u2192 v${chk.remoteVersion})`),
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
    const autoArea = h('div', { class: 'ce-field' });
    if (appConfig.remoteCatalog && !appConfig.master) {
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

    // Update from TCGdex: only for installs WITHOUT a master (standalone) and
    // for the maintainer workspace — that's where new sets come from. Consumer
    // installs update via the master button above, which appears exactly when
    // the master version is ahead of this install's.
    const jobs = [];
    if (!appConfig.remoteCatalog || appConfig.master) {
      jobs.push(h('button', { class: 'btn small', onclick: async (e) => {
        e.target.disabled = true;
        try { await startDatabaseBuild(); renderControls(); }
        catch (err) { e.target.disabled = false; toast(err.message); }
      } }, '🔄 Update cards from TCGdex'));
    }
    // Rebuild the scanner fingerprints from the images on this server. Cards
    // added here are fingerprinted as their picture is uploaded, so this is
    // for the bulk case — after a mirror, or a build that lost its index.
    if (appConfig.localDbExists) {
      jobs.push(h('button', { class: 'btn ghost small', onclick: async (e) => {
        e.target.disabled = true;
        try { await apiCall('scan-index/rebuild', { method: 'POST', body: '{}' }); toast('Rebuilding the scanner index\u2026'); renderControls(); }
        catch (err) { e.target.disabled = false; toast(err.message); }
      } }, '🔍 Rebuild scanner index'));
    }

    // The other half of the workspace: nothing edited here reaches anyone
    // until it is published. Preview is the review step — it lists exactly
    // what would move, and moves nothing.
    const publishCard = appConfig.master ? (() => {
      const logBox = h('pre', { style: 'display:none; max-height:240px; overflow:auto; margin:10px 0 0; padding:10px; font-size:11.5px; line-height:1.5; background:rgba(0,0,0,0.25); border:1px solid var(--line, rgba(255,255,255,0.12)); border-radius:8px; white-space:pre-wrap' });
      const btnPrev = h('button', { class: 'btn ghost small' }, '👀 Preview (changes nothing)');
      const btnPub = h('button', { class: 'btn small' }, '🚀 Publish to every install');
      const setBusy = (b) => { btnPrev.disabled = b; btnPub.disabled = b; };
      const poll = async () => {
        let st;
        try { st = await apiCall('catalog/publish-status'); } catch { setBusy(false); return; }
        if (st.log && st.log.length) { logBox.style.display = ''; logBox.textContent = st.log.join('\n'); logBox.scrollTop = logBox.scrollHeight; }
        if (st.running) { setTimeout(poll, 1000); return; }
        setBusy(false);
        if (st.error) toast(st.error);
        else if (st.finishedAt) toast(st.dryRun ? 'Preview finished — nothing was changed' : 'Published — other installs pick this up on their next check');
      };
      const run = (dryRun) => async () => {
        setBusy(true);
        logBox.style.display = 'none'; logBox.textContent = '';
        try { await apiCall('catalog/publish', { method: 'POST', body: JSON.stringify({ dryRun }) }); poll(); }
        catch (err) { setBusy(false); toast(err.message); }
      };
      btnPrev.addEventListener('click', run(true));
      btnPub.addEventListener('click', run(false));
      return settingsCard(
        h('h3', { style: 'margin:0 0 6px' }, 'Publish'),
        h('p', { class: 'muted small', style: 'margin:0 0 10px' }, appConfig.canPublish
          ? 'Sends this database — data, uploaded images, and the master catalog.db — to the bucket every other install reads. Preview first: it lists what would change without touching anything.'
          : 'Publishing is set up in the server environment (R2 credentials) — see DEPLOYMENT.md. Until then, edits stay on this server.'),
        appConfig.canPublish ? h('div', { class: 'row' }, btnPrev, btnPub) : null,
        logBox,
      );
    })() : null;

    content.replaceChildren(...[
      settingsCard(
        h('h3', { style: 'margin:0 0 6px' }, 'Card database'),
        h('p', { class: 'muted small' }, `${stats.cards || 0} cards, ${stats.sets || 0} sets, ${stats.printings || 0} custom printings.`),
        updateArea,
        autoArea.children.length ? autoArea : null,
      ),
      publishCard,
      jobs.length ? settingsCard(
        h('h3', { style: 'margin:0 0 6px' }, 'Jobs'),
        h('div', { class: 'row' }, ...jobs),
      ) : null,
      // where the catalog has holes — meant for the workspace, where the
      // editor that fixes them lives
      (() => {
        const out = h('div', {});
        const btn = h('button', { class: 'btn ghost small', onclick: async (e) => {
          e.target.disabled = true;
          out.replaceChildren(spinner());
          try {
            const d = await apiCall('catalog/data-health');
            const section = (title, box, render) => box.count === 0 ? null : h('details', { style: 'margin:6px 0' },
              h('summary', {}, `${title}: ${box.count}${box.count > box.sample.length ? ` (showing ${box.sample.length})` : ''}`),
              h('div', { class: 'muted small', style: 'max-height:220px; overflow:auto; margin-top:4px' },
                ...box.sample.map(render)));
            const rows = [
              section('Cards with no image at all', d.cardsNoImage, (c) => h('div', {}, `${c.name} — ${c.lang}/${c.id}`)),
              section('Cards missing the high-res scan', d.cardsNoHigh, (c) => h('div', {}, `${c.name} — ${c.lang}/${c.id}`)),
              section('Printings with no scan of their own', d.printingsNoImage, (p) => h('div', {}, `${p.name} — ${p.lang}/${p.card_id} · ${p.label || p.variant}`)),
              section('Cards missing data', d.missingData, (c) => h('div', {}, `${c.name} — ${c.lang}/${c.id} · missing ${c.missing.join(', ')}`)),
              section('Sets with issues', d.setIssues, (x) => h('div', {}, `${x.name} — ${x.lang}/${x.id} · ${x.missing.join(', ')}`)),
            ].filter(Boolean);
            out.replaceChildren(
              h('p', { class: 'muted small', style: 'margin:6px 0' },
                rows.length ? `${d.totalCards} visible cards checked.` : `All clean — ${d.totalCards} cards, no holes found.`),
              ...rows);
          } catch (err) { out.replaceChildren(); toast(err.message); }
          e.target.disabled = false;
        } }, '🩺 Check data health');
        return settingsCard(
          h('h3', { style: 'margin:0 0 6px' }, 'Data health'),
          h('p', { class: 'muted small', style: 'margin:0 0 8px' },
            'Which cards, printings and sets are missing images or data. Fix them here in the workspace — then publish.'),
          btn, out);
      })(),
      // download images locally + repoint rows to the local copies
      settingsCard(
        h('h3', { style: 'margin:0 0 6px' }, 'Images'),
        h('p', { class: 'muted small', style: 'margin:0 0 10px' }, img.remote
          ? `${img.remote} image${img.remote === 1 ? '' : 's'} currently load from the online CDN. Download them to this server so it works fully offline \u2014 each card is repointed to its local copy.`
          : (img.local ? 'All card images are served locally from this server.' : 'No card images yet.')),
        img.remote ? h('div', { class: 'row' },
          h('button', { class: 'btn small', onclick: async (e) => {
            e.target.disabled = true;
            try { await apiCall('catalog/download-images', { method: 'POST', body: '{}' }); renderControls(); }
            catch (err) { e.target.disabled = false; toast(err.message); }
          } }, '⬇️ Download all images to this server'),
        ) : null,
      ),
    ].filter(Boolean));
  }
  renderControls();
  return content;
}

/** What this server thinks it is, and who it thinks you are. */
function adminServerTab() {
  // Does this install know who is knocking? A wrong PTCG_TRUSTED_PROXY has no
  // symptom until strangers start locking each other out, so the answer belongs
  // on screen rather than in a lockout.
  const conn = settingsCard(
    h('h3', { style: 'margin:0 0 6px' }, 'This connection'),
    h('p', { class: 'muted small', style: 'margin:0' }, 'Checking\u2026'));
  (async () => {
    let c;
    try {
      c = await apiCall('connection');
    } catch (e) {
      // A block that vanishes when it fails teaches the reader nothing, and
      // "the setting is fine" and "the question was never asked" look
      // identical from the outside. Say which.
      conn.replaceChildren(h('h3', { style: 'margin:0 0 6px' }, 'This connection'),
        h('p', { class: 'muted small', style: 'margin:0' },
          `Could not ask this server where you are coming from: ${e.message}. If this install was just updated, the app may still be the old one \u2014 use Repair & reload on the account page.`));
      return;
    }
    const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1$|f[cd])/i.test(c.you || '');
    const verdict = !c.proxyConfigured
      ? (priv
        ? 'Nothing is trusted, and this looks like a local address \u2014 right for an app reached directly.'
        : 'Nothing is trusted: every visitor is counted by the address they connect from.')
      : c.proxyTrusted
        ? (priv
          ? 'A proxy is trusted, but you still look like a local address \u2014 the header is not arriving, so everyone behind the proxy is counted as one. Check PTCG_CLIENT_IP_HEADER or the proxy\u2019s forwarding.'
          : 'A proxy is trusted and you are being seen as yourself. This is right.')
        : 'A proxy list is set, but this connection did not come from one of them \u2014 its headers are being ignored.';
    conn.replaceChildren(
      h('h3', { style: 'margin:0 0 6px' }, 'This connection'),
      h('p', { class: 'muted small', style: 'margin:0' },
        `You look like ${c.you}${c.peer !== c.you ? ` (arriving via ${c.peer})` : ''}${c.secure ? ' over HTTPS' : ' over plain HTTP'}.`),
      h('p', { class: 'muted small', style: 'margin:0' }, verdict),
    );
  })();

  const kind = appConfig.master ? 'Master curation workspace \u2014 what it publishes becomes everyone else\u2019s card database.'
    : appConfig.readonly ? 'Read-only \u2014 the card database is managed centrally and cannot be changed from the app.'
      : appConfig.remoteCatalog ? 'A normal install, following a master database.'
        : 'Standalone \u2014 this install builds its own card database from TCGdex.';

  return h('div', {}, conn, settingsCard(
    h('h3', { style: 'margin:0 0 6px' }, 'This install'),
    h('p', { class: 'muted small', style: 'margin:0 0 6px' }, kind),
    appConfig.remoteCatalog ? h('p', { class: 'muted small', style: 'margin:0 0 6px' }, `Master database: ${appConfig.remoteCatalog}`) : null,
    h('p', { class: 'muted small', style: 'margin:0' },
      `Release ${appConfig.release ? 'v' + appConfig.release : 'unknown'} \u00b7 app build ${APP_VERSION}`),
  ));
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

/** Every pocket ticked "in hand", written into the collection.
 *
 * A binder's have/need list is deliberately its own thing: you lay a binder
 * out for cards you are hunting as much as for cards you hold, and ticking a
 * pocket is a statement about the plastic, not about the ledger. But once a
 * binder is genuinely full, re-entering forty cards one at a time on the set
 * pages is work a computer should be doing.
 *
 * Two rules make it safe to press:
 *
 * Within the binder, copies add up. The same printing in two pockets is two
 * sleeves with two cards in them — a binder is a physical object, and it
 * cannot hold the same piece of cardboard twice.
 *
 * Against the collection, counts only ever rise. A binder is one place your
 * cards live, not the whole of them, so a binder saying "1" is not evidence
 * that the other two on the shelf do not exist. Same rule sync already uses
 * when two devices disagree, and it makes pressing this twice a no-op.
 */
async function addBinderToCollection(binder) {
  // keyed, never parsed back apart: a custom printing's key is whatever the
  // administrator named it, and picking a separator is a bug waiting for the
  // day somebody puts that character in a name
  const held = new Map();   // card+variant -> { card, variant, n }
  for (const s of Object.values(binder.slots || {})) {
    if (!s || !s.card || !s.have) continue;
    const variant = s.variant || 'normal';
    const seen = held.get(s.card + ' ' + variant);
    if (seen) seen.n += (s.n || 1);
    else held.set(s.card + ' ' + variant, { card: s.card, variant, n: s.n || 1 });
  }
  if (!held.size) { toast('Nothing in this binder is ticked as in hand yet'); return; }

  const raises = [];
  let already = 0;
  for (const e of held.values()) {
    const have = variantQty(e.card, e.variant);
    if (e.n > have) raises.push({ ...e, have });
    else already++;
  }
  if (!raises.length) {
    toast(`Your collection already covers all ${held.size} of them`);
    return;
  }
  const copies = raises.reduce((t, r) => t + (r.n - r.have), 0);
  const ok = await confirmDestructive({
    title: `Add \u201c${binder.name}\u201d to your collection?`,
    body: [
      `${raises.length} printing${raises.length === 1 ? '' : 's'} would be added or raised \u2014 ${copies} card${copies === 1 ? '' : 's'} in all.`,
      already ? `${already} already match your collection, or it holds more, and those stay exactly as they are.` : '',
      'Counts are only ever raised, never lowered. Pressing this a second time changes nothing.',
    ].filter(Boolean).join('\n'),
    confirmLabel: 'Add to collection',
    danger: false,
  });
  if (!ok) return;

  for (const r of raises) setVariantQty(r.card, r.variant, r.n);
  updateStatsBanner();
  rerenderCards();
  toast(`Added \u2014 ${copies} card${copies === 1 ? '' : 's'} across ${raises.length} printing${raises.length === 1 ? '' : 's'}`);
}

function binderGate() {
  view.replaceChildren(h('div', { class: 'center', style: 'max-width:440px; margin:40px auto' },
    h('h2', {}, 'Binders'),
    h('p', { class: 'muted' }, 'Build digital versions of your real binders — pick a pocket size and color, place cards pocket by pocket, and track which ones you have.'),
    serverAvailable
      ? h('button', { class: 'btn', onclick: () => goToAccount() }, 'Sign in to start')
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
    const tile = h('a', { class: `binder-cover b-${b.color}${src ? ' has-art' : ''}${b.locked ? ' locked' : ''}`,
      href: '#/binder/' + b.id,
      style: b.locked ? 'filter:grayscale(0.7); opacity:0.75' : null },
      src && !artV ? h('img', { class: 'binder-cover-img' + (b.cover.type === 'set' ? ' logo' : ''), src, loading: 'lazy', alt: '' }) : null,
      h('div', { class: 'binder-name' }, b.name),
      h('div', { class: 'binder-meta' }, `${b.size}\u00d7${b.size} \u00b7 ${b.pages} page${b.pages === 1 ? '' : 's'}`),
      h('div', { class: 'binder-meta' }, b.locked ? '🔒 locked' : (b.filled ? `${b.have} / ${b.filled} in hand` : 'empty')),
      // a binder that is out in the world should say so from the shelf, not
      // only from inside its own share panel
      b.shared && !b.locked ? h('div', { class: 'binder-shared', title: 'Anyone with the link can see this binder' }, '🔗') : null,
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

/** One binder, opened either as its owner (`id`) or through a link somebody
 * was given (`shareToken`). The shared case is the same book with every
 * handle taken off: no edit mode, no print picking, no ticking pockets — the
 * visitor may not even have an account here, and nothing on this page is
 * theirs to change. What they can still do is tap a card and see it, which is
 * the whole reason to send somebody a binder. */
async function renderBinderPage(id, shareToken = null) {
  const shared = !!shareToken;
  if (!shared && !auth) return binderGate();
  view.replaceChildren(spinner());
  let binder, cardsById, setsById, owner = null, showHave = true;
  try {
    const [bRes, idx, setIdx] = await Promise.all([
      apiCall(shared ? 'shared/' + shareToken : 'binders/' + id), getSearchIndex(), getIndex()]);
    binder = bRes.binder;
    owner = bRes.owner || null;
    // a shared binder may be published without its ticks; the server strips
    // them, and this is how the page knows the zeroes are silence, not zero
    showHave = !shared || bRes.showHave !== false;
    cardsById = new Map(idx.cards.map((c) => [c.id, c]));
    setsById = new Map(setIdx.sets.map((x) => [x.id, x]));
  } catch (e) {
    if (e.locked) {
      // kept, not gone: the binder sits on the shelf with its cover showing,
      // and this is the door it opens instead of its pages
      let m = null;
      try { m = await ensureMe(); } catch { /* the pitch renders without the link */ }
      view.replaceChildren(h('div', { class: 'center', style: 'padding:40px 16px; max-width:440px; margin:0 auto' },
        h('div', { style: 'font-size:42px' }, '🔒'),
        h('h1', { style: 'margin:10px 0 6px' }, 'This binder is locked'),
        h('p', { class: 'muted', style: 'margin:0 0 14px' },
          'Your Master Set Premium plan ended, and free accounts include one binder. Everything in this one is exactly as you left it — upgrading unlocks it again.'),
        m && m.upgradeUrl
          ? h('a', { class: 'btn', href: m.upgradeUrl, target: '_blank', rel: 'noopener' }, '⭐ Upgrade to get back all your binders')
          : h('p', { class: 'muted small', style: 'margin:0' }, 'Upgrade from your Account page to open it again.'),
        h('div', { style: 'margin-top:14px' }, h('a', { class: 'back-link', href: '#/binders' }, '\u2190 Your binders')),
      ));
      return;
    }
    view.replaceChildren(dbErrorView(shared ? 'Could not open that binder.' : 'Could not load that binder.',
      e, () => renderBinderPage(id, shareToken)));
    return;
  }

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
  // the book, or the same pockets as a checklist. Not remembered: you open a
  // binder to look at it and open it again to audit it, and those want
  // different answers ten minutes apart.
  let bookView = 'book';

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
    // nothing on a shared page offers to save, but a binder that is not yours
    // should not be one bug away from being written to either
    if (shared) return;
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
  /* ---- the binder as a checklist ----
   * The book is the point of a binder: it is what the real object looks like.
   * But "which of these have I actually got" is a question the pictures make
   * slower, not faster, and a page you have to turn to thirty times is a poor
   * way to read a list. So: the same pockets, in the same order, as text —
   * with the page and pocket on every row, because the answer is only useful
   * if you can find the card it is about in the physical binder.
   */
  function renderBinderList() {
    const rows = [];
    for (let p = 0; p < binder.pages; p++) {
      const onThisPage = [];
      for (let q = 0; q < per; q++) {
        const idx = p * per + q;
        const slot = binder.slots[idx];
        if (!slot || !slot.card) continue;      // blanks and pictures are layout, not checklist
        onThisPage.push(binderRow(idx, slot));
      }
      if (!onThisPage.length) continue;         // an empty sheet is not worth a heading
      rows.push(h('div', { class: 'binder-page-label' }, `Page ${p + 1}`), ...onThisPage);
    }
    book.classList.remove('spread');
    book.classList.add('as-list');
    book.replaceChildren(...(rows.length ? rows
      : [h('p', { class: 'muted', style: 'padding:14px' }, 'Nothing has been placed in this binder yet.')]));
  }

  /** One pocket as a line. The tick is the BINDER's have/need list, not the
   * collection's — a binder tracks the cards in that binder. */
  function binderRow(idx, slot) {
    const card = cardsById.get(slot.card);
    const mark = h('div', { class: 'row-mark' });
    const row = h('div', { class: 'card-row binder-row', role: 'button', tabindex: '0' });
    const paint = () => {
      row.classList.toggle('missing', !slot.have);
      row.classList.toggle('owned', !!slot.have);
      mark.textContent = slot.have ? ((slot.n || 1) > 1 ? `\u2713\u00d7${slot.n}` : '\u2713') : '\u25cb';
    };
    row.addEventListener('click', async () => {
      // somebody else's binder is theirs to tick; a tap opens the card instead
      if (shared) { if (card) openCardModal(card, { variant: slot.variant }); return; }
      if (slot.have) { slot.have = 0; delete slot.n; } else { slot.have = 1; }
      await save();
      paint(); renderHead();
    });
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); } });
    row.append(...[
      h('div', { class: 'row-pocket' }, String((idx % per) + 1)),
      h('div', { class: 'row-main' },
        h('div', { class: 'row-name' },
          h('span', {}, (card && card.name) || slot.card),
          h('span', { class: 'row-variant' }, card ? variantLabel(card, slot.variant) : slot.variant)),
        h('div', { class: 'row-meta muted small' }, `${setNameOf(slot.card)} \u00b7 #${(card && card.localId) || localIdOf(slot.card)}`),
      ),
      mark,
      card ? h('button', {
        class: 'info-btn', title: 'Card details', 'aria-label': 'Card details',
        onclick: (e) => { e.stopPropagation(); openCardModal(card, shared ? { variant: slot.variant } : cardModalOpts(slot)); },
      }, '\u24d8') : null,
    ].filter(Boolean));
    paint();
    return row;
  }

  function renderBook() {
    // layout work needs the book: you cannot drag a card into a pocket that is
    // not drawn, and picking pockets to print is a thing you do to a page
    if (bookView === 'list' && !editMode && !pickMode) { renderBinderList(); return; }
    book.classList.remove('as-list');
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
    // no pages to turn when they are all on screen at once
    nav.hidden = bookView === 'list';
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
    if (on) bookView = 'book';   // you cannot drag a card into a pocket nobody drew
    moveFrom = null; movePageFrom = null;
    // layout editing and print-picking are different jobs — never both at once
    pickMode = false; picked.clear();
    actions.replaceChildren();
    renderHead(); renderPickBar(); renderBook();
  };

  const setPickMode = (on) => {
    pickMode = on;
    if (on) bookView = 'book';   // picking pockets to print is a thing you do to a page
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

  /* ---- handing this binder to somebody ----
   * Private is the default and private is the whole of it: with no token
   * there is no address the binder answers to, so there is nothing to leak.
   * Turning it on mints one; turning it off deletes it, which retires every
   * copy of the URL that ever left this machine at once. "New link" is the
   * same retirement with a replacement — the answer to a link that reached
   * somebody it should not have, without rebuilding the binder.
   */
  function openSharePanel() {
    const linkOf = (t) => new URL('#/b/' + t, location.href).href;
    const urlBox = h('input', { type: 'text', readonly: '', 'aria-label': 'Share link',
      style: 'width:100%; user-select:all' });
    const note = h('p', { class: 'muted small', style: 'margin:0' });
    const linkRow = h('div', { style: 'display:flex; flex-direction:column; gap:8px' });
    const sel = h('select', {},
      h('option', { value: 'private' }, 'Private — only me'),
      h('option', { value: 'public' }, 'Anyone with the link'));

    const copyBtn = h('button', { class: 'btn small', onclick: async () => {
      // clipboard access needs a secure context, which a plain-http install
      // on a home network is not — so falling back to selecting the text is
      // not a nicety, it is the path a lot of self-hosters are actually on
      try { await navigator.clipboard.writeText(urlBox.value); toast('Link copied'); }
      catch { urlBox.focus(); urlBox.select(); toast('Press Ctrl+C to copy'); }
    } }, '📋 Copy link');
    const rotateBtn = h('button', { class: 'btn ghost small', onclick: async () => {
      if (!await confirmDestructive({
        title: 'Replace the link?',
        body: 'The address you have handed out so far stops working immediately. Anybody still on the old one sees a binder that no longer exists.',
        confirmLabel: 'Replace it',
      })) return;
      await apply(true, { rotate: true });
      toast('New link — the old one is dead');
    } }, '↻ New link');

    /* What a link admits to. Showing the ticks is what "here is my binder"
     * usually means, so it is the default — but the same page is also a list
     * of valuable cardboard next to the name of whoever is holding it, which
     * is worth being able to withhold while still showing the layout. The
     * counts are stripped by the server rather than merely not drawn: a
     * browser is the visitor's to inspect, so anything the answer carries is
     * published whatever the page chooses to do with it. */
    const haveSel = h('select', {},
      h('option', { value: 'show' }, 'Show which ones I have'),
      h('option', { value: 'hide' }, 'Hide them — the layout only'));
    const haveRow = h('label', { class: 'ce-field' },
      h('span', { class: 'muted small' }, 'What the link shows'), haveSel);

    const paint = () => {
      sel.value = binder.share ? 'public' : 'private';
      haveSel.value = binder.shareHave === false ? 'hide' : 'show';
      if (!binder.share) {
        haveRow.hidden = true;
        linkRow.replaceChildren();
        note.textContent = 'Nobody but you can open this binder. There is no address for it to answer to.';
        return;
      }
      haveRow.hidden = false;
      urlBox.value = linkOf(binder.share);
      linkRow.replaceChildren(urlBox, h('div', { class: 'row', style: 'gap:8px' }, copyBtn, rotateBtn));
      note.textContent = binder.shareHave === false
        ? 'Anyone with this address can see the binder — its pages, the cards in them, and your username. Which ones you '
          + 'actually hold is not sent at all. They cannot change anything, and they do not need an account here.'
        : 'Anyone with this address can see the binder — its pages, the cards in them, which ones you have, and your '
          + 'username. They cannot change anything, and they do not need an account here.';
    };

    const apply = async (on, extra = {}) => {
      sel.disabled = haveSel.disabled = true;
      try {
        const r = await apiCall('binders/' + id + '/share', { method: 'POST', body: JSON.stringify({ on, ...extra }) });
        binder.share = r.share || null;
        binder.shareHave = r.showHave !== false;
        paint();
      } catch (e) { toast(e.message); paint(); }
      sel.disabled = haveSel.disabled = false;
    };
    sel.addEventListener('change', () => apply(sel.value === 'public'));
    haveSel.addEventListener('change', () => apply(true, { showHave: haveSel.value === 'show' }));

    const ov = h('div', { class: 'picker-overlay', onclick: (e) => { if (e.target === ov) ov.remove(); } },
      h('div', { class: 'picker-panel' },
        h('h3', { style: 'margin:0' }, 'Share this binder'),
        h('label', { class: 'ce-field' }, h('span', { class: 'muted small' }, 'Who can open it'), sel),
        haveRow,
        note,
        linkRow,
        h('div', { class: 'row', style: 'justify-content:flex-end' },
          h('button', { class: 'btn ghost small', onclick: () => ov.remove() }, 'Close')),
      ));
    paint();
    view.append(ov);
  }


  function renderHead() {
    const total = filledCount(), got = haveCount();
    const asList = bookView === 'list';
    // the one control a visitor gets: their reason for opening the link is
    // often exactly "what have they got", which is the list's question
    const viewBtn = h('button', {
      class: 'btn ghost small',
      onclick: () => { bookView = asList ? 'book' : 'list'; renderHead(); renderNav(); renderBook(); },
    }, asList ? '\ud83d\udcd6 Book' : '\u2630 List');
    const buttons = shared ? [viewBtn] : editMode ? [
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
      // only offered once there is something to offer — an empty binder's
      // button would do nothing and still have to be explained
      viewBtn,
      got ? h('button', { class: 'btn ghost small', onclick: () => addBinderToCollection(binder) },
        '📥 Add to collection') : null,
      h('button', { class: 'btn ghost small', onclick: () => openSharePanel() }, '🔗 Share'),
      h('button', { class: 'btn ghost small', onclick: () => openProxyPrintDialog() }, '🖨 Print proxies'),
      h('button', { class: 'btn ghost small', onclick: () => setPickMode(true) }, '☑ Select to print'),
      h('button', { class: 'btn small', onclick: () => setEditMode(true) }, '✎ Edit binder'),
    ].filter(Boolean);
    head.replaceChildren(...[
      // a visitor has no binder list to go back to, and may have no account
      shared ? h('a', { class: 'back-link', href: '#/' }, '← All cards')
        : h('a', { class: 'back-link', href: '#/binders' }, '← Binders'),
      h('div', { class: 'page-head' },
        h('h1', {}, h('span', { class: 'binder-dot b-' + binder.color }), ' ' + binder.name),
        h('div', { class: 'muted' }, showHave
          ? `${binder.size}×${binder.size} · ${got} / ${total} in hand`
          : `${binder.size}×${binder.size} · ${total} card${total === 1 ? '' : 's'}`),
      ),
      shared && owner ? h('p', { class: 'muted small', style: 'margin:-6px 0 10px' }, `Shared by ${owner}.`) : null,
      total && showHave ? h('div', { class: 'progress', style: 'height:8px; margin-bottom:10px' },
        h('div', { style: `width:${Math.round((got / total) * 100)}%` })) : null,
      buttons.length ? h('div', { class: 'row', style: 'gap:8px; flex-wrap:wrap' }, ...buttons) : null,
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
        actions.replaceChildren(h('p', { class: 'muted small' }, 'Tap the destination pocket \u2014 turn the page first if it is on another one. Tap the same pocket to cancel.'));
        renderBook();
      } }, '\u2194 Move'),
      // the other kind of move: the destination is nowhere near here
      s && s.card ? h('button', { class: 'btn small', onclick: () => openMoveToPage(i) }, '\u21e5 Move to page\u2026') : null,
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

  /** Which view of the book a given page is on — the spread puts two pages in
   * front of you at once, so a page index is not a view index. */
  const viewOfPage = (p) => (isSpread() ? Math.floor(p / 2) + 1 + (p % 2) : p + 1);

  /* ---- moving a card somewhere you cannot see from here ----
   * Dragging reaches the spread in front of you; carrying reaches whatever
   * you can turn to while holding the card. Neither is any use when the card
   * is on page 3 and it belongs on page 41, which is thirty-eight page turns
   * with a card in your hand. So this asks where instead of making you travel
   * there: pick the page, then pick the pocket on it.
   *
   * Same swap semantics as every other move, so a full binder can still be
   * rearranged without first making a hole. And because "farther down the
   * binder" often means past the end of it, a new sheet is one of the places
   * you can send a card to.
   */
  function openMoveToPage(from) {
    const s = binder.slots[from];
    if (!s || !s.card) return;
    const card = cardsById.get(s.card);
    const fromPage = Math.floor(from / per);
    const canGrow = binder.pages < MAX_BINDER_PAGES;
    let page = fromPage, makeNew = false;

    const freeOn = (p) => {
      let n = 0;
      for (let q = 0; q < per; q++) if (!binder.slots[p * per + q]) n++;
      return n;
    };
    const sel = h('select', {},
      ...Array.from({ length: binder.pages }, (_, p) => h('option', { value: String(p) },
        `Page ${p + 1} — ${freeOn(p)} free${p === fromPage ? ' (where it is now)' : ''}`)),
      canGrow ? h('option', { value: 'new' }, `＋ A new sheet at the end (page ${binder.pages + 1})`) : null);
    sel.value = String(page);

    const grid = h('div', { class: 'move-grid', style: `grid-template-columns: repeat(${binder.size}, 1fr)` });
    const hint = h('p', { class: 'muted small', style: 'margin:0' });

    const land = async (idx) => {
      // the sheet has to exist before anything can be put on it
      if (makeNew) binder.pages += 1;
      await moveEntry(from, idx);
      ov.remove();
      actions.replaceChildren();
      moveFrom = null;
      renderHead(); renderNav();
      // arrive where the card went: a move you cannot see is a move you have
      // to go and verify
      const want = viewOfPage(Math.floor(idx / per));
      if (want === viewIdx) renderBook(); else navTo(want);
      toast(`Moved to page ${Math.floor(idx / per) + 1}, pocket ${(idx % per) + 1}`);
    };

    const paint = () => {
      makeNew = sel.value === 'new';
      page = makeNew ? binder.pages : parseInt(sel.value, 10);
      grid.replaceChildren(...Array.from({ length: per }, (_, q) => {
        const idx = page * per + q;
        const e = makeNew ? null : binder.slots[idx];
        // a picture spans several pockets and is anchored at its lowest cell;
        // dropping a card into one of them would tear it
        const art = !!(e && e.img);
        const here = idx === from;
        const c = e && e.card ? cardsById.get(e.card) : null;
        return h('button', {
          class: 'move-cell' + (art ? ' art' : '') + (e && e.card ? ' filled' : '') + (here ? ' self' : ''),
          type: 'button',
          disabled: art || here ? '' : null,
          title: art ? 'A picture sits across this pocket' : here ? 'This is where it already is'
            : c ? `Swap with ${c.name}` : `Pocket ${q + 1}`,
          onclick: () => land(idx),
        }, art ? '🖼' : here ? '•' : c ? (c.name || e.card) : String(q + 1));
      }));
      hint.textContent = makeNew
        ? 'A new sheet is added at the end and the card goes on it.'
        : 'Tap a pocket. A pocket that already has a card swaps the two.';
    };
    sel.addEventListener('change', paint);

    const ov = h('div', { class: 'picker-overlay', onclick: (e) => { if (e.target === ov) ov.remove(); } },
      h('div', { class: 'picker-panel move-panel' },
        h('h3', { style: 'margin:0' }, card ? `Move ${card.name}` : 'Move this card'),
        card ? h('p', { class: 'muted small', style: 'margin:0' },
          `${variantLabel(card, s.variant)} · currently page ${fromPage + 1}, pocket ${(from % per) + 1}`) : null,
        h('label', { class: 'ce-field' }, h('span', { class: 'muted small' }, 'Send it to'), sel),
        grid,
        hint,
        h('div', { class: 'row', style: 'justify-content:flex-end' },
          h('button', { class: 'btn ghost small', onclick: () => ov.remove() }, 'Cancel')),
      ));
    paint();
    view.append(ov);
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
          // nothing behind it on a shared page: the sheet it opens is all
          // counts to change and layout to move, none of which is a visitor's
          pickMode || shared ? null : h('button', { class: 'pocket-edit', onclick: (e) => { e.stopPropagation(); pocketActions(i); } }, '\u22ef'),
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
        if (!s) return;
        // a shared binder is somebody else's ledger: a tap opens the card so
        // you can look at it (and, if you are signed in here, see whether you
        // have one) rather than editing a tally that is not yours
        if (shared) {
          const card = cardsById.get(s.card);
          if (card) openCardModal(card, { variant: s.variant });
          return;
        }
        // view mode: tap = got it / not yet
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
  view.replaceChildren(head, pickBar, nav, book, actions,
    shared ? pageFooter('#/', '\u2190 All cards') : pageFooter('#/binders', '\u2190 Binders'));
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
  // links that arrive by email — they carry a one-shot token in the URL
  const verifyMatch = hash.match(/^\/verify\/(.+)$/);
  const resetMatch = hash.match(/^\/reset\/(.+)$/);
  // a binder somebody was handed a link to — a token, never the binder's own id
  const sharedBinder = hash.match(/^\/b\/([a-f0-9]{20})$/);
  // settings pages carry their tab in the address, so a bookmark and the back
  // button both land on the panel they were left on
  const accountMatch = hash.match(/^\/account(?:\/([a-z-]+))?$/);
  const adminMatch = hash.match(/^\/admin(?:\/([a-z-]+))?$/);
  // where the identity provider hands the browser back
  if (hash.startsWith('/signed-in') || hash.startsWith('/linked')) { afterProviderSignIn(hash.startsWith('/linked')); return; }
  if (hash.startsWith('/signin-failed')) { afterProviderFailure(hash); return; }
  if (hash.startsWith('/signin-2fa')) { afterProviderTotp(hash); return; }
  let nav = 'sets';
  if (verifyMatch) renderVerifyPage(decodeURIComponent(verifyMatch[1]));
  else if (resetMatch) renderResetPage(decodeURIComponent(resetMatch[1]));
  else if (setMatch) renderSetPage(decodeURIComponent(setMatch[1]));
  else if (searchMatch) renderSearchPage(searchMatch[1]);
  else if (hash === '/pokemon') { nav = 'pokemon'; renderPokemonList(); }
  else if (pokeMatch) { nav = 'pokemon'; renderPokemonPage(pokeMatch[1]); }
  else if (hash === '/binders') { nav = 'binders'; renderBindersPage(); }
  else if (hash.startsWith('/binder/')) { nav = 'binders'; renderBinderPage(hash.slice('/binder/'.length)); }
  // a binder somebody was handed: short on purpose, because this one gets
  // pasted into messages, and it carries a token rather than the binder's id
  else if (sharedBinder) renderBinderPage(null, sharedBinder[1]);
  else if (hash === '/scan') { nav = 'scan'; renderScanPage(); }
  else if (accountMatch) { nav = 'account'; renderAccountPage(accountMatch[1] || 'account'); }
  else if (adminMatch) { nav = 'account'; renderAdminPage(adminMatch[1] || 'cards'); }
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

// reached deliberately rather than sent here mid-task, so there is nowhere
// particular to go back to afterwards
document.getElementById('account-btn').addEventListener('click', () => {
  signInReturn = null;
  if (location.hash.startsWith('#/account')) route();
  else location.hash = '#/account';
});

document.querySelectorAll('.close-modal').forEach((b) => b.addEventListener('click', (e) => e.target.closest('dialog').close()));

document.querySelectorAll('dialog').forEach((d) => {
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
});

// the picker itself is in index.html, outside the view, so a page re-render
// cannot pull it out from under an open file dialog
document.getElementById('import-file').addEventListener('change', (e) => {
  if (e.target.files[0]) importCollection(e.target.files[0]);
  e.target.value = '';
});

/* ---- the main menu, as a column ----
 * Wide enough and the bottom bar becomes a left sidebar; the toggle folds it
 * to an icon rail. Remembered, unlike the card view: this one is about the
 * window you are working in, not the job you are doing, and it does not change
 * from one page to the next.
 *
 * The class lives on <body> rather than the nav, because what changes is the
 * page's left gutter as much as the nav's width — one custom property, read
 * by both.
 */
function initSideNav() {
  const btn = document.getElementById('nav-toggle');
  if (!btn) return;
  const label = btn.querySelector('.nav-label');
  const icon = btn.querySelector('.nav-icon');
  const apply = () => {
    const rail = lsGet('ptcg.navRail') === true;
    document.body.classList.toggle('nav-rail', rail);
    if (icon) icon.textContent = rail ? '\u00bb' : '\u00ab';
    if (label) label.textContent = 'Collapse';
    btn.setAttribute('aria-expanded', rail ? 'false' : 'true');
    btn.title = rail ? 'Expand the menu' : 'Collapse the menu';
    btn.setAttribute('aria-label', rail ? 'Expand the menu' : 'Collapse the menu');
  };
  btn.addEventListener('click', () => { lsSet('ptcg.navRail', lsGet('ptcg.navRail') !== true); apply(); });
  apply();
}

initSideNav();
trackTopbarHeight();

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
Promise.all([detectServer(), loadAppConfig()]).then(async () => {
  if (!serverAvailable && !serverEverSeen()) { renderNoServerGate(); return; }
  // An install nobody owns yet asks to be claimed before it does anything
  // else. Whoever can read the server's log is the person entitled to do it.
  if (serverAvailable) {
    try {
      const st = await (await fetch('api/setup/status')).json();
      if (st && st.needed) { renderSetupPage(st); return; }
    } catch { /* not a fresh install, or not reachable — carry on */ }
  }
  route();
});
