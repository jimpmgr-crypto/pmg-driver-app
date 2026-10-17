// Offline mocked service-worker events: never contacts operational services.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const handlers = {};
let cacheReads = 0, cacheWrites = 0, cacheDeletes = 0;
const origin = 'https://driver.fixture.invalid';
const ctx = vm.createContext({ URL, console,
  self: { location: { origin }, addEventListener: (name, handler) => { handlers[name] = handler; } },
  fetch: async () => { throw new Error('offline'); },
  caches: { match: async () => { cacheReads++; return { stale: true, status: 200, headers: new Headers() }; }, open: async () => ({ put: async () => { cacheWrites++; }, delete: async () => { cacheDeletes++; } }) },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8'), ctx);
function event(url, options = {}) {
  let intercepted = false, result;
  const request = { url, method: 'GET', mode: 'cors', cache: 'default', headers: new Headers(), ...options };
  handlers.fetch({ request, respondWith: value => { intercepted = true; result = value; }, waitUntil() {} });
  return { intercepted, result };
}
(async () => {
  for (const [url, options] of [
    ['https://fleet.fixture.invalid/api/driver-torque?vehicle=AB12CDE', {}],
    ['https://old-sync.fixture.invalid/jobs/2026-10-17', {}],
    [origin + '/api/driver-torque', {}],
    [origin + '/api', {}],
    [origin + '/private', { headers: new Headers({ Authorization: 'fixture-only' }) }],
    [origin + '/private', { headers: new Headers({ 'X-PMG-Key': 'fixture-only' }) }],
    [origin + '/private', { headers: new Headers({ 'X-PMG-Role': 'driver' }) }],
    [origin + '/no-store', { cache: 'no-store' }],
    [origin + '/status', { method: 'POST' }],
    [origin + '/plant-seed.json', {}],
    [origin + '/private-customer-list', { credentials: 'include' }],
  ]) {
    assert.equal(event(url, options).intercepted, false, url + ': runtime data must use direct network, never cache');
  }
  assert.equal(cacheReads, 0, 'even an old cached Fleet response must remain unreachable');
  assert.equal(cacheWrites, 0);
  const shell = event(origin + '/index.html', { mode: 'navigate' });
  assert.equal(shell.intercepted, true); assert.equal((await shell.result).stale, true, 'public shell can still work offline');
  assert.equal(cacheReads, 1);
  for (const value of ['private', 'no-store', 'private, max-age=0, no-store']) {
    ctx.fetch = async () => ({ status: 200, headers: new Headers({ 'Cache-Control': value }), clone: () => ({}) });
    await event(origin + '/index.html', { credentials: 'include' }).result;
  }
  assert.equal(cacheWrites, 0, 'private/no-store responses cannot enter even the public shell cache');
  assert.equal(cacheDeletes, 3, 'previously cached copies are evicted when privacy is declared');
  ctx.fetch = async () => ({ status: 200, headers: new Headers({ 'Cache-Control': 'public, max-age=60' }), clone: () => ({}) });
  await event(origin + '/richard/index.html').result;
  assert.equal(cacheWrites, 1, 'allowlisted named-driver shell still caches');
  ctx.fetch = async () => { throw new Error('offline'); };
  ctx.caches.match = async key => key === '/' ? { status: 200, headers: new Headers(), root: true } : undefined;
  assert.equal((await event(origin + '/richard', { mode: 'navigate' }).result).root, true, 'uncached named route still falls back to a public root offline');
  ctx.caches.match = async () => ({ status: 200, headers: new Headers({ 'Cache-Control': 'private, no-store' }) });
  const before = cacheDeletes;
  assert.equal(await event(origin + '/index.html', { mode: 'navigate' }).result, undefined);
  assert.equal(cacheDeletes - before, 3, 'requested shell and both root fallbacks reject and evict private cached responses');
  let installDone;
  ctx.fetch = async () => ({ ok: true, status: 200, headers: new Headers({ 'Cache-Control': 'no-store' }) });
  ctx.self.skipWaiting = async () => {};
  handlers.install({ waitUntil: value => { installDone = value; } });
  await installDone;
  assert.equal(cacheWrites, 1, 'install cannot add private/no-store shell responses');
  console.log('PASS service-worker boundary: 11 runtime exclusions, network/cache/install private-no-store rejection, public named shell, offline shell retained');
})().catch(error => { console.error(error); process.exitCode = 1; });
