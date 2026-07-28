/* Pokémon TCG Tracker — app logic (vanilla JS, no build step) */
'use strict';

const APP_VERSION = '3.22.0';

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
/* ============================================================
 * Pages — Binders (physical binders, tracked pocket by pocket)
 * ============================================================ */
const BINDER_COLORS = ['red', 'blue', 'green', 'purple', 'black'];
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
    grid.append(h('a', { class: `binder-cover b-${b.color}`, href: '#/binder/' + b.id },
      src ? h('img', { class: 'binder-cover-img' + (b.cover.type === 'set' ? ' logo' : ''), src, loading: 'lazy', alt: '' }) : null,
      h('div', { class: 'binder-name' }, b.name),
      h('div', { class: 'binder-meta' }, `${b.size}\u00d7${b.size} \u00b7 ${b.pages} page${b.pages === 1 ? '' : 's'}`),
      h('div', { class: 'binder-meta' }, b.filled ? `${b.have} / ${b.filled} in hand` : 'empty'),
    ));
  }

  let color = BINDER_COLORS[0];
  const nameIn = h('input', { type: 'text', placeholder: 'Binder name', maxlength: '40' });
  const sizeSel = h('select', {}, ...BINDER_SIZES.map((s) => h('option', { value: String(s) }, `${s}\u00d7${s} pockets`)));
  sizeSel.value = '3';
  const swatches = h('div', { class: 'row', style: 'gap:8px; margin:10px 0' }, ...BINDER_COLORS.map((c) =>
    h('button', { class: 'swatch b-' + c + (c === color ? ' active' : ''), title: c, onclick: (e) => {
      color = c;
      swatches.querySelectorAll('.swatch').forEach((el) => el.classList.toggle('active', el === e.target));
    } })));
  const setSel = h('select', {}, h('option', { value: '' }, 'Start empty'));
  try {
    const idx = await getIndex();
    for (const s of [...idx.sets].reverse()) setSel.append(h('option', { value: s.id }, 'Fill from: ' + s.name));
  } catch { /* empty-start only */ }
  const createBtn = h('button', { class: 'btn', onclick: async () => {
    const name = nameIn.value.trim();
    if (!name) { toast('Give the binder a name'); return; }
    createBtn.disabled = true;
    try {
      const r = await apiCall('binders', { method: 'POST', body: JSON.stringify({
        name, size: parseInt(sizeSel.value, 10), color, fillFromSet: setSel.value || undefined, lang,
      }) });
      location.hash = '#/binder/' + r.binder.id;
    } catch (e) { createBtn.disabled = false; toast(e.message); }
  } }, '\uff0b Create binder');

  view.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Binders'),
      h('div', { class: 'muted' }, list.length ? `${list.length} binder${list.length === 1 ? '' : 's'}` : 'No binders yet')),
    grid,
    h('div', { class: 'binder-create' },
      h('h3', {}, 'New binder'),
      h('div', { class: 'row', style: 'flex-wrap:wrap; gap:8px' }, nameIn, sizeSel, setSel),
      swatches,
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

  const per = binder.size * binder.size;
  let moveFrom = null;

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
    loadNat(entry.img).then(() => {
      const geo = artGeo(entry);
      const v = artView(entry, geo);
      const pc = geo.pos.find((q) => q.c === cellIdx);
      if (!pc) return;
      const ox = (pc.col - geo.minC) * (CARD_W + geo.gap);
      const oy = (pc.row - geo.minR) * (CARD_H + geo.gap);
      el.style.backgroundImage = `url("${entry.img}")`;
      el.style.backgroundRepeat = 'no-repeat';
      el.style.backgroundSize = (v.s * perMm) + unit + ' auto';
      el.style.backgroundPosition = ((v.x - ox) * perMm) + unit + ' ' + ((v.y - oy) * perMm) + unit;
    });
  }

  const save = async (extra = {}) => {
    try { await apiCall('binders/' + id, { method: 'PUT', body: JSON.stringify({ slots: binder.slots, pages: binder.pages, ...extra }) }); }
    catch (e) { toast('Save failed: ' + e.message); }
  };
  const filledCount = () => Object.values(binder.slots).filter((e) => e.card).length;
  const haveCount = () => Object.values(binder.slots).filter((e) => e.card && e.have).length;

  const head = h('div', {});
  const nav = h('div', { class: 'row', style: 'justify-content:center; align-items:center; gap:12px; margin:10px 0' });
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
    const el = h('div', { class: 'binder-cover-page b-' + binder.color },
      src ? h('img', { src, alt: '', class: binder.cover.type === 'set' ? 'cover-logo' : 'cover-photo' }) : null,
      h('div', { class: 'cover-name' }, binder.name),
      h('div', { class: 'cover-hint muted small' }, 'Open \u2192'),
    );
    el.addEventListener('click', () => navTo(1, 1));
    return el;
  }
  const blankPanel = (inside) => h('div', { class: 'book-blank' + (inside ? ' inside' : '') });
  function sideContent(pIdx, insideBlank) {
    if (pIdx !== null) return renderPageGrid(pIdx);
    return blankPanel(insideBlank);
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
    nav.replaceChildren(
      h('button', { class: 'btn ghost small', onclick: () => navTo(viewIdx - 1, -1) }, '\u2039'),
      h('span', { class: 'muted', style: 'min-width:130px; text-align:center' }, navLabel()),
      h('button', { class: 'btn ghost small', onclick: () => navTo(viewIdx + 1, 1) }, '\u203a'),
    );
  }
  spreadMq.addEventListener('change', () => { viewIdx = Math.min(viewIdx, maxView()); renderNav(); renderBook(); });

  function renderHead() {
    const total = filledCount(), got = haveCount();
    head.replaceChildren(...[
      h('a', { class: 'back-link', href: '#/binders' }, '\u2190 Binders'),
      h('div', { class: 'page-head' },
        h('h1', {}, h('span', { class: 'binder-dot b-' + binder.color }), ' ' + binder.name),
        h('div', { class: 'muted' }, `${binder.size}\u00d7${binder.size} \u00b7 ${got} / ${total} in hand`),
      ),
      total ? h('div', { class: 'progress', style: 'height:8px; margin-bottom:10px' },
        h('div', { style: `width:${Math.round((got / total) * 100)}%` })) : null,
      h('div', { class: 'row', style: 'gap:8px; flex-wrap:wrap' },
        h('button', { class: 'btn ghost small', onclick: async () => {
          const name = prompt('Binder name', binder.name);
          if (!name || !name.trim()) return;
          binder.name = name.trim().slice(0, 40);
          try { await apiCall('binders/' + id, { method: 'PUT', body: JSON.stringify({ name: binder.name }) }); } catch (e) { toast(e.message); }
          renderHead();
        } }, '\u270e Rename'),
        h('button', { class: 'btn ghost small', onclick: async () => {
          binder.color = BINDER_COLORS[(BINDER_COLORS.indexOf(binder.color) + 1) % BINDER_COLORS.length];
          try { await apiCall('binders/' + id, { method: 'PUT', body: JSON.stringify({ color: binder.color }) }); } catch (e) { toast(e.message); }
          renderHead();
        } }, '\ud83c\udfa8 Color'),
        h('button', { class: 'btn ghost small', onclick: async () => {
          binder.pages += 1; await save(); renderNav(); renderBook();
        } }, '\uff0b Add page'),
        h('button', { class: 'btn ghost small', onclick: openCoverPicker }, '\ud83d\uddbc Cover'),
        h('button', { class: 'btn ghost small', onclick: openProxyPrintDialog }, '\ud83d\udda8 Print proxies'),
        h('button', { class: 'btn ghost small', onclick: async () => {
          if (!confirm(`Delete "${binder.name}"? This cannot be undone.`)) return;
          try { await apiCall('binders/' + id, { method: 'DELETE' }); location.hash = '#/binders'; }
          catch (e) { toast(e.message); }
        } }, '\ud83d\uddd1 Delete'),
      ),
    ].filter(Boolean));
  }

  function pocketActions(i) {
    const s = binder.slots[i];
    if (s && s.img) {
      actions.replaceChildren(h('div', { class: 'pocket-actions' },
        h('span', { class: 'muted small' }, `Your image \u2014 ${s.cells.length} pocket${s.cells.length === 1 ? '' : 's'}`),
        h('button', { class: 'btn small', onclick: () => openArtEditor(i) }, '\u270e Adjust'),
        h('button', { class: 'btn small', onclick: async () => {
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
      card ? h('button', { class: 'btn small', onclick: () => openCardModal(card, { variant: s.variant }) }, '\u24d8 Details') : null,
      h('button', { class: 'btn small', onclick: async () => {
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
        // one slice of a placed picture
        const entry = binder.slots[anchor];
        pocket = h('div', { class: 'pocket art', 'data-pocket': String(i) },
          h('button', { class: 'pocket-edit', onclick: (e) => { e.stopPropagation(); pocketActions(anchor); } }, '\u22ef'));
        pocket.addEventListener('click', () => {
          if (moveFrom !== null) { moveFrom = null; actions.replaceChildren(); renderBook(); return; }
          pocketActions(anchor);
        });
        requestAnimationFrame(() => artPieceCss(pocket, entry, i, pocket.clientWidth / CARD_W, 'px'));
        grid.append(pocket);
        continue;
      }
      if (s) {
        const card = cardsById.get(s.card);
        const img = card && cardImg(card, 'low', s.variant);
        pocket = h('div', { class: 'pocket filled' + (s.have ? ' have' : '') + (moveFrom === i ? ' moving' : ''), 'data-pocket': String(i), draggable: 'true' },
          img ? h('img', { src: img, loading: 'lazy', alt: (card && card.name) || s.card })
              : h('div', { class: 'pocket-name' }, (card && card.name) || s.card),
          s.have ? h('div', { class: 'pocket-badge' }, '\u2713') : null,
          h('button', { class: 'pocket-edit', onclick: (e) => { e.stopPropagation(); pocketActions(i); } }, '\u22ef'),
        );
        // drag & drop between pockets (desktop; mobile keeps \u2194 Move)
        pocket.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', String(i));
          e.dataTransfer.effectAllowed = 'move';
          pocket.classList.add('dragging');
        });
        pocket.addEventListener('dragend', () => {
          grid.querySelectorAll('.drag-over, .dragging').forEach((el) => el.classList.remove('drag-over', 'dragging'));
        });
      } else {
        pocket = h('div', { class: 'pocket' + (moveFrom === i ? ' moving' : ''), 'data-pocket': String(i) },
          h('div', { class: 'pocket-plus' }, '\uff0b'));
      }
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
      pocket.addEventListener('click', async () => {
        if (moveFrom !== null) {
          await moveEntry(moveFrom, i);
          moveFrom = null;
          actions.replaceChildren();
          renderBook(); renderHead();
          return;
        }
        if (s) {
          s.have = s.have ? 0 : 1;
          await save();
          renderBook(); renderHead();
        } else {
          openPocketPicker(i);
        }
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
    const renderResults = () => {
      const q = input.value.trim().toLowerCase();
      results.replaceChildren();
      if (q.length < 2) { results.append(h('p', { class: 'muted small' }, 'Type at least 2 letters.')); return; }
      const hits = [];
      for (const c of cardsById.values()) {
        if (c.name.toLowerCase().includes(q)) { hits.push(c); if (hits.length >= 40) break; }
      }
      if (!hits.length) { results.append(h('p', { class: 'muted small' }, 'No cards match.')); return; }
      for (const c of hits) {
        const chips = realVariants(c).map((vk) => h('button', { class: 'chip', onclick: async () => {
          binder.slots[i] = { card: c.id, variant: vk, have: 0 };
          overlay.remove();
          await save();
          renderHead(); renderBook();
        } }, variantLabel(c, vk)));
        const img = cardImg(c, 'low');
        results.append(h('div', { class: 'picker-row' },
          img ? h('img', { src: img, loading: 'lazy' }) : h('div', { class: 'picker-thumb' }, '\ud83c\udccf'),
          h('div', { class: 'picker-info' },
            h('div', {}, c.name),
            h('div', { class: 'muted small' }, setIdOf(c.id) + ' \u00b7 #' + c.localId),
            h('div', { class: 'row', style: 'flex-wrap:wrap; gap:4px' }, ...chips)),
        ));
      }
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
    const gapBtn = h('button', { class: 'btn ghost small' });
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

    const overlay = h('div', { class: 'picker-overlay' },
      h('div', { class: 'picker-panel art-editor' },
        h('h3', {}, 'Place your image'),
        board,
        h('div', { class: 'row', style: 'gap:8px; align-items:center' }, h('span', { class: 'muted small' }, 'Size'), scale),
        h('div', { class: 'row', style: 'gap:8px; flex-wrap:wrap; align-items:center' }, gapBtn,
          h('span', { class: 'muted small' }, 'With: the picture flows continuously across the binder. Without: slices are cut edge-to-edge.')),
        status,
        h('div', { class: 'row', style: 'justify-content:flex-end; gap:8px; margin-top:6px' },
          h('button', { class: 'btn ghost small', onclick: () => overlay.remove() }, 'Cancel'),
          h('button', { class: 'btn small', onclick: async () => {
            if (!selected.size) { toast('Pick at least one pocket'); return; }
            const cells = [...selected].sort((a, b) => a - b);
            const geo = artGeo({ img: entry.img, cells, gaps });
            binder.slots[cells[0]] = { img: entry.img, cells,
              view: { x: imgX - geo.minC * (CARD_W + gapMm()), y: imgY - geo.minR * (CARD_H + gapMm()), s: imgW }, gaps };
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

  /** choose the binder's cover: a set logo, a card's picture, or your own art */
  function openCoverPicker() {
    const content = h('div', { class: 'picker-results' });
    const setCover = async (cover) => {
      binder.cover = cover;
      try { await apiCall('binders/' + id, { method: 'PUT', body: JSON.stringify({ cover }) }); } catch (e) { toast(e.message); }
      overlay.remove();
      viewIdx = 0;
      renderNav(); renderBook();
      toast(cover ? 'Cover updated' : 'Cover cleared');
    };
    const modes = h('div', { class: 'row', style: 'gap:6px; flex-wrap:wrap' });
    const mode = (label, fn) => h('button', { class: 'chip', onclick: fn }, label);
    const showSets = () => {
      content.replaceChildren(...[...setsById.values()].reverse().map((st) =>
        h('div', { class: 'picker-row', onclick: () => setCover({ type: 'set', set: st.id, lang }) },
          st.logo ? h('img', { src: st.logo, loading: 'lazy', style: 'object-fit:contain' }) : h('div', { class: 'picker-thumb' }, '\ud83d\uddc2'),
          h('div', { class: 'picker-info' }, h('div', {}, st.name)))));
    };
    const showCards = () => {
      const input = h('input', { type: 'text', placeholder: 'Search Pok\u00e9mon / cards by name\u2026' });
      const results = h('div', { class: 'picker-results' });
      const rr = () => {
        const q = input.value.trim().toLowerCase();
        results.replaceChildren();
        if (q.length < 2) { results.append(h('p', { class: 'muted small' }, 'Type at least 2 letters.')); return; }
        const hits = [];
        for (const c of cardsById.values()) {
          if (c.name.toLowerCase().includes(q) && cardImg(c, 'low')) { hits.push(c); if (hits.length >= 30) break; }
        }
        for (const c of hits) {
          results.append(h('div', { class: 'picker-row', onclick: () => setCover({ type: 'card', card: c.id }) },
            h('img', { src: cardImg(c, 'low'), loading: 'lazy' }),
            h('div', { class: 'picker-info' }, h('div', {}, c.name), h('div', { class: 'muted small' }, setIdOf(c.id) + ' \u00b7 #' + c.localId))));
        }
        if (!hits.length) results.append(h('p', { class: 'muted small' }, 'No cards match.'));
      };
      input.addEventListener('input', rr);
      content.replaceChildren(input, results);
      rr();
      input.focus();
    };
    const showUpload = () => {
      const fileIn = h('input', { type: 'file', accept: 'image/*', hidden: '' });
      fileIn.addEventListener('change', async (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        try {
          const res = await fetch('api/binder-image', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': f.type || 'application/octet-stream' }, body: f });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Upload failed');
          await setCover({ type: 'art', img: data.url });
        } catch (err) { toast(err.message); }
        e.target.value = '';
      });
      content.replaceChildren(
        h('p', { class: 'muted small' }, 'Use one of your own pictures as the cover.'),
        h('button', { class: 'btn small', onclick: () => fileIn.click() }, '\u2b06 Upload image'), fileIn);
    };
    modes.append(
      mode('Set logo', showSets),
      mode('Pok\u00e9mon card', showCards),
      mode('My image', showUpload),
      mode('Color only', () => setCover(null)),
    );
    const overlay = h('div', { class: 'picker-overlay' },
      h('div', { class: 'picker-panel' },
        h('div', { class: 'row', style: 'justify-content:space-between; align-items:center' },
          h('h3', { style: 'margin:0' }, 'Binder cover'),
          h('button', { class: 'btn ghost small', onclick: () => overlay.remove() }, 'Close')),
        modes,
        content,
      ));
    view.append(overlay);
    showSets();
  }

  function openProxyPrintDialog() {
    let which = 'missing', frame = 'color', paper = 'letter';
    const optRow = (label, opts, get, set) => h('div', { class: 'row', style: 'gap:6px; flex-wrap:wrap; align-items:center' },
      h('span', { class: 'muted small', style: 'min-width:64px' }, label),
      ...opts.map(([v, txt]) => h('button', { class: 'chip' + (v === get() ? ' active' : ''), onclick: (e) => {
        set(v);
        [...e.target.parentElement.querySelectorAll('.chip')].forEach((c) => c.classList.toggle('active', c === e.target));
      } }, txt)));
    const overlay = h('div', { class: 'picker-overlay' },
      h('div', { class: 'picker-panel' },
        h('h3', {}, 'Print proxies'),
        h('p', { class: 'muted small' }, 'Prints cards at real size (63\u2009\u00d7\u200988\u2009mm) with cut guides \u2014 stand-ins for your physical binder\u2019s pockets until the real card arrives. Artwork adds a decorative frame around each card.'),
        optRow('Cards', [['missing', 'Missing only'], ['all', 'All pockets']], () => which, (v) => which = v),
        optRow('Artwork', [['none', 'None'], ['color', 'Binder color'], ['gold', 'Gold'], ['pokeball', 'Pok\u00e9ball']], () => frame, (v) => frame = v),
        optRow('Paper', [['letter', 'Letter'], ['a4', 'A4']], () => paper, (v) => paper = v),
        h('div', { class: 'row', style: 'justify-content:flex-end; gap:8px; margin-top:6px' },
          h('button', { class: 'btn ghost small', onclick: () => overlay.remove() }, 'Cancel'),
          h('button', { class: 'btn small', onclick: () => { overlay.remove(); printProxies(which, frame, paper); } }, '\ud83d\udda8 Print'),
        ),
      ));
    view.append(overlay);
  }

  function printProxies(which, frame, paper) {
    const entries = Object.entries(binder.slots)
      .map(([k, v]) => [parseInt(k, 10), v])
      .sort((a, b) => a[0] - b[0])
      .filter(([, v]) => which === 'all' ? true : (v.card && !v.have));
    if (!entries.length) { toast('Nothing to print \u2014 every pocket is already in hand'); return; }
    const area = h('div', { id: 'print-area', class: 'frame-' + frame });
    for (const [, v] of entries) {
      if (v.img) {
        // your picture: one 63×88mm piece per chosen pocket, cut with or
        // without the between-pocket spacing (exactly as placed in the editor)
        for (const c of v.cells || []) {
          const cell = h('div', { class: 'print-cell print-art b-' + binder.color });
          area.append(cell);
          artPieceCss(cell, v, c, 1, 'mm');
        }
        continue;
      }
      const card = cardsById.get(v.card);
      const img = card && (cardImg(card, 'high', v.variant) || cardImg(card, 'low', v.variant));
      // same printing-name banner as the collection tiles: shown when this
      // printing has no dedicated scan and isn't what the base scan depicts
      const needsLabel = card && img &&
        !(card.variantImages && card.variantImages[v.variant]) &&
        realVariants(card)[0] !== v.variant;
      area.append(h('div', { class: 'print-cell b-' + binder.color },
        img ? h('img', { src: img, alt: (card && card.name) || v.card })
            : h('div', { class: 'print-fallback' },
                h('div', { class: 'pf-name' }, (card && card.name) || v.card),
                h('div', { class: 'pf-meta' }, setIdOf(v.card) + ' \u00b7 #' + ((card && card.localId) || '?') +
                  (card ? ' \u00b7 ' + variantLabel(card, v.variant) : '')),
              ),
        needsLabel ? h('div', { class: 'print-fx' }, variantLabel(card, v.variant)) : null,
      ));
    }
    const pageStyle = h('style', {}, `@page { size: ${paper === 'a4' ? 'A4' : 'letter'}; margin: 8mm; }`);
    document.head.append(pageStyle);
    document.body.append(area);
    document.body.classList.add('printing-proxies');
    const cleanup = () => {
      area.remove(); pageStyle.remove();
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

  renderHead(); renderNav(); renderBook();
  view.replaceChildren(head, nav, book, actions);
}

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
