/* Pokémon TCG Tracker — service worker (offline support) */
importScripts('config.js');

const SHELL_CACHE = 'ptcg-shell-v14';
const DATA_CACHE = 'ptcg-data-v2';
const IMG_CACHE = 'ptcg-img-v1';

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'config.js',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

// Resolve the configured card-database location against the app's URL.
const CDN_URL = new URL(
  (((self.PTCG_CONFIG && self.PTCG_CONFIG.cdnBase) || 'cdn').replace(/\/+$/, '')) + '/',
  self.registration.scope
).href;
// Optional separately controlled image CDN (config.imageBase)
const IMAGE_URL = (self.PTCG_CONFIG && self.PTCG_CONFIG.imageBase)
  ? new URL(self.PTCG_CONFIG.imageBase.replace(/\/+$/, '') + '/', self.registration.scope).href
  : null;
// Locally mirrored database: even when config points at a remote CDN, the
// admin may have downloaded a local copy — same-origin cdn/ requests get the
// same cache treatment as the configured CDN.
const LOCAL_CDN_URL = new URL('cdn/', self.registration.scope).href;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => ![SHELL_CACHE, DATA_CACHE, IMG_CACHE].includes(k)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length > max) {
    await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
  }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Never cache the sync API — always live.
  if (url.pathname.includes('/api/')) return;

  // external image CDN: cache first (card images never change)
  if (IMAGE_URL && e.request.url.startsWith(IMAGE_URL)) {
    e.respondWith(
      caches.match(e.request).then((hit) =>
        hit ||
        fetch(e.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(IMG_CACHE).then((c) => { c.put(e.request, copy); trimCache(IMG_CACHE, 4000); });
          }
          return res;
        })
      )
    );
    return;
  }

  if (e.request.url.startsWith(CDN_URL) || e.request.url.startsWith(LOCAL_CDN_URL)) {
    // Card images & set logos: cache first (they never change).
    if (url.pathname.includes('/images/')) {
      e.respondWith(
        caches.match(e.request).then((hit) =>
          hit ||
          fetch(e.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(IMG_CACHE).then((c) => { c.put(e.request, copy); trimCache(IMG_CACHE, 4000); });
            }
            return res;
          })
        )
      );
    } else {
      // Set data / indexes: network first, fall back to cache (works offline).
      e.respondWith(
        fetch(e.request)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(DATA_CACHE).then((c) => c.put(e.request, copy));
            }
            return res;
          })
          .catch(() => caches.match(e.request))
      );
    }
    return;
  }

  // App shell: NETWORK FIRST so a new version is picked up immediately after
  // an upgrade; the cache is only used when offline. (An earlier cache-first
  // strategy could serve a stale app version forever — never again.)
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(async () => {
          const hit = await caches.match(e.request);
          if (hit) return hit;
          if (e.request.mode === 'navigate') return caches.match('./');
          return Response.error();
        })
    );
  }
});
