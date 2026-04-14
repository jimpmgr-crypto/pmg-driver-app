const CACHE_NAME = 'pmg-driver-v9';

// Install — skip waiting immediately so new SW activates right away
self.addEventListener('install', e => {
  self.skipWaiting();
});

// Activate — claim all clients immediately, then tell them to reload
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => {
        // Tell all open tabs to reload so they get the new version instantly
        return self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(client => client.navigate(client.url));
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
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
