// Lineage marker: prestart-fleet-torque-source remains part of this driver build.
const CACHE_NAME = 'pmg-driver-live-v20260702-carter-washed-labels-v65';
const APP_SHELL = [
  '/',
  '/index.html',
  '/john',
  '/richard',
  '/andrew',
  '/neil',
  '/ian',
  '/plant',
  '/tony',
  '/plant-seed.json',
  '/app-version.json',
  '/manifest.json',
  '/plant-manifest.json',
  '/icon.png',
  '/icon-192.png',
  '/icon-512.png',
];

// Install — warm the new app shell before replacing the previous worker/cache.
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Activate — claim all clients immediately; the page decides when a reload is safe.
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => {
        return self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(client => client.postMessage({ type: 'PMG_SW_UPDATED' }));
        });
      })
  );
});

// Network-first for everything — always try to get latest from server
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Don't cache API calls
  if (e.request.url.includes('pmg-driver-sync') || e.request.url.includes('httms.azurewebsites.net')) return;
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        if (resp && resp.status === 200) {
          const clone = resp.clone();
          const cacheWrite = caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          e.waitUntil(cacheWrite.catch(() => {}));
        }
        return resp;
      })
      .catch(() => caches.match(e.request).then(cached => {
        if (cached) return cached;
        if (e.request.mode === 'navigate') return caches.match('/').then(root => root || caches.match('/index.html'));
        return undefined;
      }))
  );
});

self.addEventListener('push', e => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {}
  const title = data.title || 'Plant service alert';
  const body = data.body || 'Open Tony app to see the plant that needs attention.';
  e.waitUntil(self.registration.showNotification(title, {
    body,
    tag: 'pmg-plant-service-alert',
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/tony?source=push' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const targetUrl = new URL(e.notification.data?.url || '/tony?source=push', self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(client => client.url.includes('/plant') || client.url.includes('/tony'));
      if (existing) return existing.focus();
      return self.clients.openWindow(targetUrl);
    })
  );
});
