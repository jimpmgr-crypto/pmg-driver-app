// Lineage marker: prestart-fleet-torque-source remains part of this driver build.
const CACHE_NAME = 'pmg-driver-live-v20261027-driver-drop-order-r1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/app-version.json',
  '/job-backup-journal.js',
  '/manifest.json',
  '/icon.png',
  '/icon-192.png',
  '/icon-512.png',
];

// Install only the critical driver shell before replacing the previous cache.
// Named driver routes fall back to / offline. Plant/Tony remain network-first
// and no longer get a vote on whether a driver update can install.
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.all(APP_SHELL.map(async path => {
        const response = await fetch(path);
        if (!response.ok) throw new Error(`Shell fetch failed: ${path}`);
        if (isPublicShellResponse(response)) await cache.put(path, response);
        else await cache.delete(path);
      })))
      .then(() => self.skipWaiting())
  );
});

// Activate — claim all clients immediately; the page decides when a reload is safe.
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('pmg-driver-') && k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => {
        return self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(client => client.postMessage({ type: 'PMG_SW_UPDATED' }));
        });
      })
  );
});

// Cache only the public same-origin shell. Runtime/API and authenticated
// requests must fail visibly offline rather than replaying an old safety state.
function isPublicShellResponse(response) {
  return !!response && response.status === 200 && !/\b(no-store|private)\b/i.test(response.headers?.get('Cache-Control') || '');
}

async function readPublicShellCache(request) {
  const response = await caches.match(request);
  if (isPublicShellResponse(response)) return response;
  if (response) await caches.open(CACHE_NAME).then(cache => cache.delete(request)).catch(() => {});
  return undefined;
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || /^\/api(?:\/|$)/.test(url.pathname)) return;
  if (e.request.cache === 'no-store' || ['Authorization', 'X-PMG-Key', 'X-PMG-Role'].some(name => e.request.headers.has(name))) return;
  const publicPath = url.pathname.replace(/^\/(john|richard|andrew|neil|ian|paul)(?=\/|$)/, '') || '/';
  if (!APP_SHELL.includes(publicPath)) return;
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        if (!isPublicShellResponse(resp)) {
          e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.delete(e.request)).catch(() => {}));
          return resp;
        }
        if (isPublicShellResponse(resp)) {
          const clone = resp.clone();
          const cacheWrite = caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          e.waitUntil(cacheWrite.catch(() => {}));
        }
        return resp;
      })
      .catch(() => readPublicShellCache(e.request).then(async cached => {
        if (cached) return cached;
        if (e.request.mode === 'navigate') return await readPublicShellCache('/') || await readPublicShellCache('/index.html');
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
