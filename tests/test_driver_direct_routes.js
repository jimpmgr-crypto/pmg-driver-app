const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const redirects = fs.readFileSync(path.join(projectRoot, '_redirects'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(projectRoot, 'sw.js'), 'utf8');

const driverRoutes = ['john', 'andrew', 'neil', 'ian', 'richard', 'paul'];

for (const driver of driverRoutes) {
  assert(
    !redirects.includes(`/${driver} /index.html 200`),
    `/${driver} must not rewrite directly to /index.html; Cloudflare clean URLs turn that into a root redirect`
  );
  assert(
    !new RegExp(`/${driver}\\s+/\\s+30[1278]\\b`).test(redirects),
    `/${driver} must not redirect to root because that loses the typed driver path`
  );
  assert(
    !new RegExp(`/${driver}/?\\*?\\s+/index\\.html\\s+200`).test(redirects),
    `/${driver} wildcard rewrites to /index.html are ignored by Pages dev and should not be kept as fake coverage`
  );
  assert(
    !serviceWorker.includes(`'/${driver}'`),
    `/${driver} must not be a critical install dependency; offline navigation falls back to the cached root`
  );
}

assert(
  serviceWorker.includes("if (e.request.mode === 'navigate') return caches.match('/')"),
  'named driver shortcuts must retain an offline root fallback'
);

for (const driver of driverRoutes) {
  for (const asset of ['sw.js', 'manifest.json', 'app-version.json', 'icon-192.png']) {
    assert(
      redirects.includes(`/${driver}/${asset} /${asset} 200`),
      `/${driver} nested route must serve ${asset} from the app root`
    );
  }
}

console.log('driver direct-route regression checks passed');
