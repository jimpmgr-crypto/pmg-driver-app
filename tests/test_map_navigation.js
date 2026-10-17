// Synthetic, offline-only regression: no browser, network or operational writes.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(process.env.PMG_TEST_INDEX || path.join(__dirname, '../index.html'), 'utf8');

function fn(name) {
  const start = html.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert(start >= 0, `Missing ${name}`);
  const next = html.slice(start + 1).search(/\n(?:async )?function /);
  return html.slice(start, next < 0 ? undefined : start + 1 + next).split('\n// ═')[0];
}

const ctx = { console, URL, Map, Set, allJobs: [] };
vm.createContext(ctx);
for (const name of ['esc', 'getJobConsignment', 'getJobFrom', 'getJobTo',
  'jobAddressParts', 'getJobAddress', 'getDeliveryAddress', 'getCollectionAddress',
  'jobMapQuery', 'mapUrlForQuery', 'mapChoiceLinks', 'openJobMap']) {
  // The baseline lacks the shared helpers; still prove its actual omission.
  if (html.includes(`function ${name}(`)) vm.runInContext(fn(name), ctx);
}

const collection = {
  line1: 'Example Quarry', line2: 'Gate 2, Old Quarry Road', line3: 'Test Village',
  line4: 'Test Borough', line5: 'Example County', postcode: 'AB1 2CD',
};
const delivery = {
  line1: 'O’Neil & Sons "East" <Yard>', line2: '7 Six Mill Lane #2', line3: 'Other Village',
  line4: 'Other Borough', line5: 'Other County', postcode: 'XY9 8ZZ',
};
const consignment = {};
for (const [leg, address] of Object.entries({ collection, delivery })) {
  for (let i = 1; i <= 5; i++) consignment[`${leg}AddressLine${i}`] = address[`line${i}`];
  consignment[`${leg}Postcode`] = address.postcode;
}
const live = { id: '11111111-1111-4111-8111-111111111111', consignments: [consignment] };
const query = address => Object.values(address).join(', ');
const checkRoutes = job => {
  for (const [leg, address] of Object.entries({ collection, delivery })) {
    assert.equal(ctx.jobMapQuery(job, leg), query(address), `${leg}: all five lines and postcode retained`);
    for (const provider of ['apple', 'google']) {
      const url = new URL(ctx.mapUrlForQuery(ctx.jobMapQuery(job, leg), provider));
      assert.equal(url.hostname, provider === 'apple' ? 'maps.apple.com' : 'www.google.com');
      assert.equal(url.searchParams.get(provider === 'apple' ? 'daddr' : 'destination'), query(address));
      assert.equal(url.searchParams.get(provider === 'apple' ? 'dirflg' : 'travelmode'), provider === 'apple' ? 'd' : 'driving');
      assert.equal([...url.searchParams].length, provider === 'apple' ? 2 : 3, 'address characters cannot add URL parameters');
    }
  }
};

checkRoutes(live);
checkRoutes({ ...live, collectionAddress: { line1: 'Outdated saved origin' }, deliveryAddress: { line1: 'Outdated saved destination' } });
assert.equal(ctx.jobMapQuery(live), query(delivery), 'default route remains delivery');
assert.equal(ctx.jobMapQuery({ consignments: [{}], deliveryAddress: delivery, to: 'Outdated destination' }), '', 'empty live consignment must not route to stale saved destination');
assert.equal(ctx.jobMapQuery({ consignments: [{ deliveryAddressLine2: '  Side Gate  ', deliveryAddressLine5: '  County  ' }] }), 'Side Gate, County');
assert.equal(ctx.jobMapQuery({ consignments: [{ deliveryPostcode: '  AB1 2CD  ' }] }), 'AB1 2CD');
assert.equal(ctx.jobMapQuery({ _cached: true, _to: '  Legacy full address AB1 2CD  ', _from: 'Old quarry' }), 'Legacy full address AB1 2CD');
assert.equal(ctx.jobMapQuery({ _cached: true, _to: 'Delivery only' }, 'collection'), '', 'missing collection never borrows delivery');
assert.equal(ctx.jobMapQuery({ _cached: true, _from: 'Collection only' }), '', 'missing delivery never borrows collection');
for (const job of [null, {}, { consignments: [{}] }, { _cached: true, _to: '  ' }]) assert.equal(ctx.jobMapQuery(job), '');
assert.equal(ctx.mapChoiceLinks('   '), '', 'blank destination has no navigation links');
let opened = [], events = [], notices = [];
Object.assign(ctx, {
  window: { open: (...args) => opened.push(args) },
  trackMapRoute: (...args) => events.push(args), toast: text => notices.push(text),
});
ctx.openJobMap({ _cached: true, _to: '  ' });
assert.equal(opened.length, 0); assert.equal(events.length, 0); assert.equal(notices.length, 1);
ctx.openJobMap(live, 'collection', 'google');
assert.equal(new URL(opened[0][0]).searchParams.get('destination'), query(collection));
assert.equal(events[0][1], 'collection'); assert.equal(events[0][3], 'google');

// Exercise the actual cache serializer and each cache reconstruction path.
for (const name of ['getJobWasteTransferNote', 'getJobAddedBy', 'getJobDriver', 'getJobVehicle',
  'getJobCustomer', 'getJobMaterial', 'getJobWeight', 'getJobPrice', 'getJobStatus', 'getJobRef',
  'getJobNotes', 'getJobPaymentStatus', 'getJobRouteOrder', 'getJobLoadNumber', 'getJobHaultechOrder',
  'concreteSourceAlreadyShown']) ctx[name] = () => '';
Object.assign(ctx, {
  isDriverAddedJob: j => !!j._driverAdded, clearMatchedDriverWritebackQueue: () => {},
  driverAddedFingerprint: () => null, driverMovementId: j => j.movementId || j._movementId || '',
  isLocalDriverTempJob: j => !!j._driverAdded, findMatchingLiveDriverJob: () => null,
  cloudPutJobs: async () => {}, addToRetryQueue: () => {}, renderJobs: () => {},
  driverReviewBackupJobs: jobs => jobs, getHaultechJobId: j => j.haultechJobId || j._haultechJobId || '',
});
for (const name of ['cachedDriverFields', 'jobToLocal', 'mergeWithLocal', 'loadJobsFallback']) vm.runInContext(fn(name), ctx);
const cached = ctx.jobToLocal(live);
assert.equal(cached.id, live.id, 'cache keeps job identity');
ctx.localGetJobs = () => [cached];
checkRoutes(ctx.mergeWithLocal('2026-10-17', [], { allowOfficialCached: true })[0]);
const driverLocal = {
  id: 'driver-fixture', movementId: 'driver-fixture', _driverAdded: true,
  from: 'Summary quarry', to: 'Summary destination',
  collectionAddress: { ...collection, placeId: 'fixture-place', latitude: 53.9, longitude: -2.7 },
  deliveryAddress: delivery,
};
ctx.localGetJobs = () => [driverLocal];
const driverCached = ctx.mergeWithLocal('2026-10-17', [])[0];
checkRoutes(driverCached);
const resaved = ctx.jobToLocal(driverCached);
assert.equal(resaved.collectionAddress.placeId, 'fixture-place', 'selected address metadata survives re-save');
assert.equal(resaved.collectionAddress.latitude, 53.9);
assert.equal(resaved.movementId, 'driver-fixture', 'movement identity preserved');

// Both tab renderers must display and link the same full address, safely escaped.
Object.assign(ctx, {
  getJobContact: () => '', getJobSiteContact: () => '', getDeliveryWindow: () => '',
  isTerminalJobStatus: () => true, renderPaymentStatusPanel: () => '', renderWasteTransferPanel: () => '',
  statusBadge: () => '', LIVE_WRITE: false, $: () => null,
  attachMapChoiceListeners: () => {}, attachPaymentStatusListeners: () => {},
});
for (const name of ['renderDeliveryTab', 'renderCollectionTab']) vm.runInContext(fn(name), ctx);
for (const [name, address, leg] of [['renderDeliveryTab', delivery, 'delivery'], ['renderCollectionTab', collection, 'collection']]) {
  const container = { innerHTML: '' };
  ctx[name](container, live);
  for (const part of Object.values(address)) assert(container.innerHTML.includes(ctx.esc(part)), `${name}: display ${part}`);
  assert(!container.innerHTML.includes('<Yard>'), 'address HTML is escaped');
  const links = [...container.innerHTML.matchAll(/href="([^"]+)"[^>]+data-map-provider="([^"]+)"[^>]+data-map-mode="([^"]+)"/g)];
  assert.equal(links.length, 2);
  for (const [, href, provider, mode] of links) {
    assert.equal(mode, leg);
    assert.equal(new URL(href).searchParams.get(provider === 'apple' ? 'daddr' : 'destination'), query(address));
  }
}

(async () => {
  ctx.localGetJobs = () => [];
  ctx.api = async url => ({ ok: true, json: async () => url.startsWith('/haultech-jobs/') ? [cached] : [] });
  await ctx.loadJobsFallback('2026-10-17');
  checkRoutes(ctx.allJobs[0]);
  ctx.api = async url => ({ ok: true, json: async () => url.startsWith('/jobs/') ? [driverLocal] : [] });
  await ctx.loadJobsFallback('2026-10-17');
  checkRoutes(ctx.allJobs[0]);
  ctx.api = async () => { throw new Error('synthetic offline'); };
  ctx.localGetJobs = () => [driverLocal];
  await ctx.loadJobsFallback('2026-10-17');
  checkRoutes(ctx.allJobs[0]);

  // Immediate driver-created card before the next refresh uses the same address.
  const marker = html.indexOf('jobId: confirmedJobId, _cached: true, _driverAdded: true');
  const start = html.lastIndexOf('allJobs.push({', marker);
  const end = html.indexOf("$('add-job-modal').classList.add('hidden')", marker);
  assert(start > 0 && end > start);
  Object.assign(ctx, { allJobs: [], localJob: driverLocal, confirmedJobId: driverLocal.id, movementId: driverLocal.movementId });
  vm.runInContext(html.slice(start, end), ctx);
  checkRoutes(ctx.allJobs[0]);
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) new vm.Script(script[1]);
  console.log('PASS maps: full addresses, both legs/providers, escaping, blank guards, serialization, four cache paths, immediate driver card, source syntax');
})().catch(error => { console.error(error); process.exitCode = 1; });
