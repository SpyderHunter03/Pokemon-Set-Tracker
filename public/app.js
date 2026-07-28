/* Pokémon TCG Tracker — app logic (vanilla JS, no build step) */
'use strict';

const APP_VERSION = '3.17.2';

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
  for (const c of raw.cards) {
    if (c.rarity) rarities.add(c.rarity);
    (c.types || []).forEach((t) => t && types.add(t));
    const dex = c.dexId && c.dexId[0];
    if (dex) {
      if (!species.has(dex)) species.set(dex, { dex, name: c.name, cards: [] });
      const sp = species.get(dex);
      sp.cards.push(c);
      if (c.name.length < sp.name.length) sp.name = c.name; // shortest name ≈ species name
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
  return matches.slice((page - 1) * perPage, page * perPage);
}

/** Image URL for a printing. Each card/printing carries explicit low/high
 * URLs from the database (a remote CDN, or a local path this server serves). */
function cardImg(card, quality = 'low', variant = null) {
  const vi = variant && card.variantImages && card.variantImages[variant];
  if (vi) return vi[quality] || vi.low || vi.high || null;
  if (!card.img) return null;
  return card.img[quality] || card.img.low || card.img.high || null;
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
  if (!avail.length) avail.push('normal');
  const pr = card && card.printings;   // custom printings carried on the card
  if (pr) for (const key of Object.keys(pr)) {
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

/* Spinning-pokeball loader: shown on `host` (via CSS ::after) until the
 * image finishes loading — or fails, in which case other handlers take over. */
function trackImageLoad(imgEl, host) {
  if (imgEl.complete) return; // already in the browser cache — no flash
  host.classList.add('img-loading');
  const done = () => host.classList.remove('img-loading');
  imgEl.addEventListener('load', done, { once: true });
  imgEl.addEventListener('error', done, { once: true });
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
  const variantSrc = cardImg(card, 'low', variant);
  if (variantSrc) {
    const imgEl = h('img', { src: variantSrc, alt: card.name, loading: 'lazy' });
    imgEl.addEventListener('error', () => imgEl.replaceWith(placeholderContent(card)));
    tile.append(imgEl);
    trackImageLoad(imgEl, tile);
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

async function openCardModal(brief, { variant, onOwnershipChange } = {}) {
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
    const src = cardImg(card, 'high', active) || cardImg(card, 'low', active);
    if (!src) return;
    const modalImg = h('img', { class: 'card-img', src, alt: card.name });
    imgWrap.append(modalImg);
    trackImageLoad(modalImg, imgWrap);
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
            clearDataCaches();
            card = await getCard(card.id);
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

// Pull the catalog from the configured remote database (R2) into this server's DB.
async function startCatalogPull() {
  return apiCall('catalog/pull', { method: 'POST', body: JSON.stringify({}) });
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
    // owned/missing filters only make sense when signed in and tracking
    const trackChips = canTrack()
      ? [chip('Owned', filter === 'owned', () => { filter = 'owned'; renderChips(); renderGrid(); }),
         chip('Missing', filter === 'missing', () => { filter = 'missing'; renderChips(); renderGrid(); })]
      : [];
    chipsWrap.replaceChildren(
      chip('All', filter === 'all', () => { filter = 'all'; renderChips(); renderGrid(); }),
      ...trackChips,
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
      ...(canTrack() ? [progressLabel, progressWrap] : []),
    ),
    h('div', { class: 'set-filter' }, searchInput),
    chipsWrap,
    grid,
  );
  renderChips();
  if (canTrack()) updateProgress();
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
      const owned = sp.cards.filter((c) => ownedAny(c.id)).length;
      const total = sp.cards.length;
      const done = owned >= total;
      const withImg = sp.cards.find((c) => c.img);
      const thumb = withImg ? cardImg(withImg) : null;
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
  const sp = idx.species.find((s) => s.dex === dex);
  if (!sp) {
    view.replaceChildren(h('div', { class: 'center' }, 'No cards found for this Pokémon.'));
    return;
  }

  const progressLabel = h('span', { class: 'muted' });
  function updateProgress() {
    if (!canTrack()) { progressLabel.textContent = ''; return; }
    progressLabel.textContent = `${sp.cards.filter((c) => ownedAny(c.id)).length} / ${sp.cards.length} owned`;
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
                try { await startCatalogPull(); renderControls(); }
                catch (err) { e.target.disabled = false; toast(err.message); }
              } }, `⬇️ Update cards from master (v${chk.localVersion} → v${chk.remoteVersion})`),
            ),
          );
        } else {
          updateArea.replaceChildren(h('p', { class: 'muted small' },
            `Card database is up to date with the master (v${chk.localVersion || chk.remoteVersion}).`));
        }
      })();
    }

    // NOTE: replaceChildren stringifies null into literal "null" text (unlike
    // h(), which filters it) — always filter the child list.
    content.replaceChildren(...[
      h('p', { class: 'muted small' }, `Database: ${stats.cards || 0} cards, ${stats.sets || 0} sets, ${stats.printings || 0} custom printings.`),
      updateArea,
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
        renderAccountModal();
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
