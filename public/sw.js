// Runs in the background on drivers' phones and shows shuttle notifications,
// even when the shuttle app is closed or the phone is locked.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'Shuttle';
  const offer = data.offer_id ? { actions: [{ action: 'accept', title: '✅ Take it' }, { action: 'decline', title: 'No thanks' }], requireInteraction: true } : {};
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'You have a shuttle update.',
    tag: data.tag || 'shuttle',
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
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
  const url = new URL(data.url || '/driver', self.location.origin).href;
  event.waitUntil((async () => {
    if (data.offer_id && (event.action === 'accept' || event.action === 'decline')) {
      await fetch(`/api/offers/${data.offer_id}/${event.action}`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
      if (event.action === 'decline') return;
    }
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.location.origin)) { await w.focus(); if ('navigate' in w) await w.navigate(url).catch(() => {}); return; }
    }
    await self.clients.openWindow(url);
  })());
});
