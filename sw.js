const CACHE_NAME = 'pmg-driver-live-v20260521-map-labels';
const APP_SHELL = [
  './',
  'index.html',
  'manifest.json',
  'icon.png',
  'icon-192.png',
  'icon-512.png',
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
        if (e.request.mode === 'navigate') return caches.match('./').then(root => root || caches.match('index.html'));
        return undefined;
      }))
  );
});
