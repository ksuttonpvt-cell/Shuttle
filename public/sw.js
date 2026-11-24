// Runs in the background on phones and computers that open the shuttle site.
//  1. Keeps the site's screens on the device, so they open instantly, even while the
//     phone is still finding and connecting to the server (slow Wi-Fi, slow DNS).
//     The live information (rides, vans, tracking) always comes fresh from the server;
//     no customer details are saved on the device by this.
//  2. Keeps map images of the area, so maps fill in right away.
//  3. Shows shuttle notifications on drivers' phones, even when the app is closed.
const VERSION = '__VERSION__'; // filled in by the server; a new version replaces the saved screens
const SCREENS = `screens-${VERSION}`;
const FILES = 'files-v1';
const TILES = 'map-tiles-v2'; // v1 could hold "Access blocked" pictures; it's thrown away
const MAX_FILES = 120;
const MAX_TILES = 600;
const TILE_DAYS = 7; // the map server allows keeping its images about a week

// Screens that can open from the device. Customer tracking links all share one screen.
// Under a path (turaslubtha.com/pinevalley/), the business's pages are below it.
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, '');
const underBase = (u) => (typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') && BASE && !u.startsWith(`${BASE}/`) ? BASE + u : u);
function screenKey(url) {
  let path = url.pathname.toLowerCase(); // QR codes use capitals (/T/K7M2Q9XA, /REQUEST)
  if (BASE) { if (!path.startsWith(`${BASE.toLowerCase()}/`)) return null; path = path.slice(BASE.length); }
  // Saved screens are kept apart per business (they share one web address).
  if (['/admin', '/advisor', '/bdc', '/driver', '/login', '/request'].includes(path)) return url.origin + BASE + path;
  if (/^\/t\/[^/]+$/.test(path)) return `${url.origin}${BASE}/t/`;
  if (/^\/s\/[^/]+$/.test(path)) return `${url.origin}${BASE}/s/`;
  return null;
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const name of await caches.keys()) {
    if ((name.startsWith('screens-') && name !== SCREENS) || (name.startsWith('map-tiles-') && name !== TILES)) await caches.delete(name);
  }
  await self.clients.claim();
})()));

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]); // oldest first
}

// Screens: show the saved copy right away and fetch a fresh one in the background.
// If the fresh one is different (an update), tell the page so it can offer "Reload".
const updates = new Map(); // screen -> promise of "was it updated?" (the page asks once it has loaded)
async function screen(event, key) {
  const cache = await caches.open(SCREENS);
  const saved = await cache.match(key);
  const savedText = saved ? saved.clone().text() : Promise.resolve(null); // read now: the saved copy itself goes to the page
  let changed = false;
  const fresh = fetch(event.request).then(async (res) => {
    if (res.ok && !res.redirected && (res.headers.get('content-type') || '').includes('text/html')) {
      const text = await res.clone().text();
      const before = await savedText.catch(() => null);
      await cache.put(key, res.clone());
      if (before !== null && strip(before) !== strip(text)) {
        changed = true;
        const client = await self.clients.get(event.resultingClientId || event.clientId);
        const all = client ? [client] : await self.clients.matchAll({ type: 'window' });
        for (const c of all) c.postMessage({ type: 'shuttle-updated' });
      }
    }
    return res;
  });
  updates.set(key, fresh.then(() => changed, () => false));
  if (saved) { event.waitUntil(fresh.catch(() => {})); return saved; }
  return fresh;
}
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'shuttle-check' || !event.ports[0]) return;
  const key = screenKey(new URL(event.data.url));
  const pending = key && updates.get(key);
  event.waitUntil((pending || Promise.resolve(false)).then((changed) => {
    if (changed) updates.delete(key);
    event.ports[0].postMessage({ updated: !!changed });
  }));
});
// Settings like the brand color are written into each page; small changes there don't count as an update.
const strip = (html) => html.replace(/<html[^>]*>/, '');

// Scripts, styles, fonts and icons: their addresses change when they change, so a saved copy is always right.
async function file(request) {
  const cache = await caches.open(FILES);
  const saved = await cache.match(request);
  if (saved) return saved;
  const res = await fetch(request);
  if (res.ok) { await cache.put(request, res.clone()); trim(FILES, MAX_FILES).catch(() => {}); }
  return res;
}

// Map images: use the saved copy if it's less than two weeks old.
async function tile(request) {
  const cache = await caches.open(TILES);
  const saved = await cache.match(request);
  if (saved) {
    const at = Number(saved.headers.get('x-saved-at')) || 0;
    if (Date.now() - at < TILE_DAYS * 86400000) return saved;
  }
  try {
    const res = await fetch(request);
    // When the map server refuses, it still answers OK, with an "Access blocked" picture
    // marked no-cache. Real map pictures can be kept; that one never is.
    const noKeep = /no-cache|no-store/i.test(res.headers.get('cache-control') || '');
    if (res.ok && res.type !== 'opaque' && !noKeep) {
      const headers = new Headers(res.headers); headers.set('x-saved-at', String(Date.now()));
      const copy = new Response(await res.clone().blob(), { status: res.status, statusText: res.statusText, headers });
      await cache.put(request, copy);
      trim(TILES, MAX_TILES).catch(() => {});
    }
    return res;
  } catch (e) {
    if (saved) return saved; // offline: an older map is better than none
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      const key = screenKey(url);
      if (key) event.respondWith(screen(event, key).catch(() => fetch(req)));
      return;
    }
    const own = BASE ? (url.pathname.startsWith(`${BASE}/`) ? url.pathname.slice(BASE.length) : '') : url.pathname;
    if (/^\/(js|css|vendor|icons)\//.test(own)) event.respondWith(file(req).catch(() => fetch(req)));
    return; // everything else (rides, tracking, sign-in…) always goes to the server
  }
  if (url.hostname === 'tile.openstreetmap.org') event.respondWith(tile(req).catch(() => fetch(req)));
});

// ---------- notifications (drivers) ----------
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'Shuttle';
  const offer = data.offer_id ? { actions: [{ action: 'accept', title: '✅ Take it' }, { action: 'decline', title: 'No thanks' }], requireInteraction: true } : {};
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'You have a shuttle update.',
    tag: data.tag || 'shuttle',
    renotify: true,
    icon: underBase('/brand/icon-192.png'),
    badge: underBase('/icons/badge-96.png'),
    vibrate: data.offer_id ? [300, 150, 300, 150, 300] : [250, 120, 250],
    data: { url: data.url || '/driver', offer_id: data.offer_id || null },
    ...offer,
  }));
});

// Tapping a notification opens the driver app (or brings it to the front).
// Ride offers: "Take it" / "No thanks" buttons answer right from the notification (Android).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = new URL(underBase(data.url || '/driver'), self.location.origin).href;
  event.waitUntil((async () => {
    if (data.offer_id && (event.action === 'accept' || event.action === 'decline')) {
      await fetch(underBase(`/api/offers/${data.offer_id}/${event.action}`), { method: 'POST', credentials: 'same-origin' }).catch(() => {});
      if (event.action === 'decline') return;
    }
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.location.origin + BASE + '/')) { await w.focus(); if ('navigate' in w) await w.navigate(url).catch(() => {}); return; }
    }
    await self.clients.openWindow(url);
  })());
});
