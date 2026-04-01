const CACHE_NAME = 'pmg-driver-v4';
const APP_URL = '/pmg-driver-app/index.html';

// Pre-cache the app on install so it always works from home screen
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.add(APP_URL)).catch(() => {})
  );
  self.skipWaiting();
});

// Clean up old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for HTML, cache-first for everything else
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // For the main app HTML — try network first, fall back to cache
  if (url.pathname.includes('pmg-driver-app') && (url.pathname.endsWith('/') || url.pathname.endsWith('index.html') || url.pathname.endsWith('pmg-driver-app'))) {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          if (resp && resp.status === 200) {
            caches.open(CACHE_NAME).then(c => c.put(e.request, resp.clone()));
          }
          return resp;
        })
        .catch(() => caches.match(APP_URL).then(cached => cached || caches.match(e.request)))
    );
    return;
  }

  // Cache-first for fonts/assets
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp && resp.status === 200 && e.request.method === 'GET') {
          caches.open(CACHE_NAME).then(c => c.put(e.request, resp.clone()));
        }
        return resp;
      }).catch(() => cached);
    })
  );
});
