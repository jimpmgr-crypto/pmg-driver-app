const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectRoot = path.resolve(__dirname, '..');
const workerPath = path.join(projectRoot, 'worker', 'index.js');
const workerSource = fs.readFileSync(workerPath, 'utf8');

const sandbox = {
  TextEncoder,
  TextDecoder,
  Request,
  Response,
  URL,
  URLSearchParams,
  console,
  Date,
  btoa: value => Buffer.from(value, 'binary').toString('base64'),
  atob: value => Buffer.from(value, 'base64').toString('binary'),
  crypto: {
    randomUUID: () => '00000000-0000-4000-8000-000000000000',
    subtle: {
      digest: async () => new Uint8Array(32),
    },
  },
  fetch: async (url, options = {}) => {
    sandbox.__fetches.push({ url: String(url), options });
    if (String(url).includes('/api/Display/GetJobsByDatePaginated')) {
      return new Response(JSON.stringify({ items: sandbox.__haultechJobs || [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ jobId: 'JOB-ADMIN-1' }), { status: 200 });
  },
  __fetches: [],
  __haultechJobs: [],
};

vm.runInNewContext(
  workerSource.replace('export default {', 'globalThis.__worker = {'),
  sandbox
);

const worker = sandbox.__worker;

function env(adminKey = 'admin-key') {
  const store = new Map([
    ['haultech-auth', JSON.stringify({ token: 'token-1', tmsId: 'tms-1', refreshToken: 'refresh-1' })],
    ['customers', JSON.stringify([
      { id: 'c1', name: 'Customer One', defaultServiceLevelId: 'svc-1' },
      { id: 'a1', name: 'A1', defaultServiceLevelId: 'svc-a1' },
    ])],
  ]);
  return {
    PMG_DRIVER_SYNC_ADMIN_KEY: adminKey,
    PMG_DATA: {
      get: async key => {
        return store.has(key) ? store.get(key) : null;
      },
      put: async (key, value) => {
        store.set(key, value);
      },
      list: async () => ({ keys: [], list_complete: true }),
    },
    __store: store,
  };
}

async function upsertRequest(headers = {}, body = {}, adminKey = 'admin-key') {
  return worker.fetch(new Request('https://pmg-driver-sync.test/ht/upsert', {
    method: 'POST',
    headers: { 'X-PMG-Key': 'pmg2026driver', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }), env(adminKey));
}

async function workerRequest(pathname, options = {}, testEnv = env()) {
  return worker.fetch(new Request(`https://pmg-driver-sync.test${pathname}`, {
    method: options.method || 'GET',
    headers: { 'X-PMG-Key': 'pmg2026driver', 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body,
  }), testEnv);
}

(async () => {
  let resp = await upsertRequest({}, { customerReference: 'PUBLIC-ONLY' });
  assert.strictEqual(resp.status, 403);
  assert.deepStrictEqual(await resp.json(), { error: 'admin_key_required' });
  assert.strictEqual(sandbox.__fetches.length, 0, 'public key must not reach Haultech');

  resp = await worker.fetch(new Request('https://pmg-driver-sync.test/ht/upsert', {
    method: 'POST',
    headers: { 'X-PMG-Key': 'pmg2026driver', 'X-PMG-Admin-Key': 'admin-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerReference: 'MISSING-ENV' }),
  }), env(''));
  assert.strictEqual(resp.status, 403);
  assert.deepStrictEqual(await resp.json(), { error: 'admin_key_required' });
  assert.strictEqual(sandbox.__fetches.length, 0, 'missing env admin key must fail closed');

  resp = await upsertRequest({ 'X-PMG-Admin-Key': 'admin-key' }, { customerReference: 'ADMIN-OK' });
  assert.strictEqual(resp.status, 200);
  assert.deepStrictEqual(await resp.json(), { jobId: 'JOB-ADMIN-1' });
  assert.strictEqual(sandbox.__fetches.length, 1, 'admin key should reach mocked Haultech once');
  assert(sandbox.__fetches[0].url.endsWith('/api/Job/UpsertJob?formId='));

  sandbox.__fetches.length = 0;
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({
      id: 'driver-test-1',
      date: '2026-06-09',
      customer: 'Customer One',
      driver: 'Richard Whittaker',
      vehicle: 'EY15BOV',
      material: '6F2 Crushed Concrete',
      quantity: 6,
      unit: 't',
      from: 'PMG Yard',
      to: 'Pilling Lane',
      ticketNo: 'local-1781192248955',
      notes: '6 ton tipped',
    }),
  });
  assert.strictEqual(resp.status, 200);
  const driverAdd = await resp.json();
  assert.strictEqual(driverAdd.ok, true);
  assert.strictEqual(driverAdd.alreadyPresent, false);
  assert.strictEqual(sandbox.__fetches.length, 2, 'driver add should check existing jobs then upsert');
  assert(sandbox.__fetches[0].url.includes('/api/Display/GetJobsByDatePaginated'));
  assert(sandbox.__fetches[1].url.endsWith('/api/Job/UpsertJob?formId='));
  const driverPayload = JSON.parse(sandbox.__fetches[1].options.body);
  assert.strictEqual(driverPayload.customerId, 'c1');
  assert.strictEqual(driverPayload.customerReference, 'CUSTOMER ONE st-1');
  assert(!driverPayload.customerReference.toLowerCase().includes('local-'), 'driver add must not use local phone ids as customer references');
  assert.strictEqual(driverPayload.consignments[0].goodsDescription, '6F2 Crushed Concrete');
  assert.strictEqual(driverPayload.quotedPrice, 0);
  assert.strictEqual(driverPayload.useQuotedPrice, false);
  assert(driverPayload.accountNotes.includes('Driver app source: Richard Whittaker / EY15BOV / 6t / PMG Yard to Pilling Lane'), 'driver add should keep driver/route detail in account notes');
  assert(driverPayload.accountNotes.includes('Driver note: 6 ton tipped'), 'driver add should preserve notes in account notes');
  assert.strictEqual(driverPayload.trafficNotes, '6 ton tipped', 'traffic notes should contain the plain driver note only');
  assert(!driverPayload.trafficNotes.includes('Driver app source:'), 'traffic notes must not include source/audit jargon');

  sandbox.__fetches.length = 0;
  sandbox.__haultechJobs = [{
    jobId: 8708,
    id: '8fa30d53-5770-43a6-8e20-d4f618034c7d',
    customerReference: 'Wyre Drives - Cedar Close Garstang',
    deliveryStatus: 'Scheduled',
    consignments: [{ consignmentId: 8708, jobId: '8fa30d53-5770-43a6-8e20-d4f618034c7d' }],
  }];
  resp = await workerRequest('/ht/complete/8708', {
    method: 'PATCH',
    body: JSON.stringify({ date: '2026-06-11' }),
  });
  assert.strictEqual(resp.status, 200);
  assert(sandbox.__fetches.some(call => call.url.includes('/api/Display/GetJobsByDatePaginated')), 'complete must look up the hidden Haultech GUID');
  assert(sandbox.__fetches.some(call => call.url.includes('/api/Job/QuickCompleteJob?id=8fa30d53-5770-43a6-8e20-d4f618034c7d')), 'complete must call QuickCompleteJob with the Haultech GUID, not the visible job number');
  sandbox.__haultechJobs = [];

  sandbox.__fetches.length = 0;
  sandbox.__haultechJobs = [{
    jobId: 8708,
    id: '8fa30d53-5770-43a6-8e20-d4f618034c7d',
    customerReference: 'Wyre Drives - Cedar Close Garstang',
    deliveryStatus: 'Scheduled',
    accountNotes: 'Existing account note',
    trafficNotes: 'Existing traffic note',
    consignments: [{ consignmentId: 8708, jobId: '8fa30d53-5770-43a6-8e20-d4f618034c7d' }],
  }];
  resp = await workerRequest('/ht/note/8708', {
    method: 'PATCH',
    body: JSON.stringify({ date: '2026-06-11', driverNotes: 'Leave cones by the gate' }),
  });
  assert.strictEqual(resp.status, 200);
  const noteUpsert = sandbox.__fetches.find(call => call.url.endsWith('/api/Job/UpsertJob?formId='));
  assert(noteUpsert, 'driver note should upsert the matched Haultech job');
  const notePayload = JSON.parse(noteUpsert.options.body);
  assert.strictEqual(notePayload.accountNotes, 'Existing account note', 'driver notes must not be hidden in account notes');
  assert(notePayload.trafficNotes.includes('Existing traffic note'), 'existing traffic notes should be preserved');
  assert(notePayload.trafficNotes.includes('Leave cones by the gate'), 'driver notes should be written to Haultech traffic notes');
  assert(!notePayload.trafficNotes.includes('Driver note:'), 'traffic notes should stay plain and not gain a Driver note prefix');
  sandbox.__haultechJobs = [];

  sandbox.__fetches.length = 0;
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({
      ticketNo: 'local-1781192374242',
      date: '2026-06-09',
      customer: 'Customer One',
      driver: 'John Bowman',
      vehicle: 'EY15BOV',
      material: 'Rubble Tip',
      quantity: 16,
      unit: 't',
      from: 'Cedar Close Garstang',
      to: 'Yard',
      notes: 'grab load away concrete rubble',
    }),
  });
  assert.strictEqual(resp.status, 200);
  const localOnlyPayload = JSON.parse(sandbox.__fetches[1].options.body);
  assert(!JSON.stringify(localOnlyPayload).toLowerCase().includes('local-1781192374242'), 'local phone ids must not leak into Haultech payloads');
  assert(localOnlyPayload.customerReference.includes('CUSTOMER ONE'), 'local-only references must fall back to a readable customer/site reference');

  const overrideEnv = env();
  sandbox.__fetches.length = 0;
  sandbox.__haultechJobs = [{
    jobId: 9117,
    id: 'b6d1cabd-13c3-4b42-b7f9-f07071c3db78',
    deliveryStatus: 'Completed',
    collectionStatus: 'None',
    consignments: [{ id: 'consignment-9117' }],
  }];
  resp = await workerRequest('/job-status/9117', {
    method: 'POST',
    body: JSON.stringify({
      date: '2026-06-29',
      status: 'scheduled',
      reason: 'office repair: premature completion',
    }),
  }, overrideEnv);
  assert.strictEqual(resp.status, 200);
  resp = await workerRequest('/ht/jobs?date=2026-06-29', {}, overrideEnv);
  assert.strictEqual(resp.status, 200);
  const overriddenJobs = await resp.json();
  assert.strictEqual(overriddenJobs.items[0].status, 'scheduled');
  assert.strictEqual(overriddenJobs.items[0].deliveryStatus, 'Scheduled');
  assert.strictEqual(overriddenJobs.items[0].collectionStatus, 'None');
  resp = await workerRequest('/ht/jobs?date=2026-06-29&raw=true', {}, overrideEnv);
  assert.strictEqual(resp.status, 200);
  const rawJobs = await resp.json();
  assert.strictEqual(rawJobs.items[0].deliveryStatus, 'Completed', 'raw Haultech reads must not be masked for verification');
  sandbox.__haultechJobs = [];

  sandbox.__fetches.length = 0;
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({
      id: 'driver-fallback-1',
      date: '2026-06-09',
      customer: 'Unknown Site Name',
      driver: 'Richard Whittaker',
      vehicle: 'DX12RFN',
      material: '6F2',
      quantity: 1,
      unit: 't',
      notes: 'fallback test note',
    }),
  });
  assert.strictEqual(resp.status, 200);
  const fallbackAdd = await resp.json();
  assert.strictEqual(fallbackAdd.ok, true);
  assert.strictEqual(fallbackAdd.ref, 'UNKNOWN SITE NAME ck-1');
  const fallbackPayload = JSON.parse(sandbox.__fetches[1].options.body);
  assert.strictEqual(fallbackPayload.customerId, 'a1');
  assert.strictEqual(fallbackPayload.customerReference, 'UNKNOWN SITE NAME ck-1');
  assert(fallbackPayload.accountNotes.includes('Phone source: driver-fallback-1'));
  assert(fallbackPayload.accountNotes.includes('Typed customer/site: Unknown Site Name'));
  assert.strictEqual(fallbackPayload.trafficNotes, 'fallback test note');
  assert(!fallbackPayload.trafficNotes.includes('Typed customer/site:'), 'traffic notes should not carry customer/reference repair labels');
  assert.strictEqual(fallbackPayload.consignments[0].goodsDescription, '6F2');

  sandbox.__fetches.length = 0;
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({
      id: 'driver-a1-ref-1',
      date: '2026-06-15',
      customer: 'Phil Smith',
      driver: 'Ian Slater',
      vehicle: 'PN25FLF',
      material: 'C35pmg Qu',
      quantity: 0.91,
      unit: 'm3',
      from: 'Yard',
      to: 'Nottend',
      ticketNo: '1736',
    }),
  });
  assert.strictEqual(resp.status, 200);
  const a1NamedPayload = JSON.parse(sandbox.__fetches[1].options.body);
  assert.strictEqual(a1NamedPayload.customerId, 'a1');
  assert.strictEqual(a1NamedPayload.customerReference, 'Phil Smith - 1736');
  assert.strictEqual(a1NamedPayload.consignments[0].consignmentReference, 'Phil Smith - 1736');
  assert.strictEqual(a1NamedPayload.consignments[0].goodsDescription, 'C35pmg Qu');
  assert(a1NamedPayload.accountNotes.includes('Typed customer/site: Phil Smith'));
  assert.strictEqual(a1NamedPayload.trafficNotes, '', 'typed customer/site must go through the reference, not clutter traffic notes');

  sandbox.__fetches.length = 0;
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({
      id: 'driver-a1-missing-ref-1',
      date: '2026-06-15',
      customer: 'A1',
      driver: 'Ian Slater',
      vehicle: 'PN25FLF',
      material: 'C35pmg Qu',
      quantity: 0.91,
      unit: 'm3',
      from: 'Yard',
      to: 'Nottend',
    }),
  });
  assert.strictEqual(resp.status, 400);
  assert.deepStrictEqual(await resp.json(), {
    error: 'a1_reference_required',
    message: 'A1 rows need a customer name/reference',
  });
  assert.strictEqual(sandbox.__fetches.length, 0, 'A1 rows without a name/reference must not reach Haultech');

  sandbox.__fetches.length = 0;
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({
      id: 'driver-a1-name-ref-1',
      date: '2026-06-15',
      customer: 'A1',
      driver: 'Ian Slater',
      vehicle: 'PN25FLF',
      material: 'C35pmg Qu',
      quantity: 0.91,
      unit: 'm3',
      from: 'Yard',
      to: 'Nottend',
      reference: 'Phil Smith',
      a1PaymentStatus: 'paid',
      notes: 'Leave cones by the gate',
    }),
  });
  assert.strictEqual(resp.status, 200);
  const a1ReferenceNameResult = await resp.json();
  assert.strictEqual(a1ReferenceNameResult.a1PaymentStatus, 'Paid');
  const a1ReferenceNamePayload = JSON.parse(sandbox.__fetches[1].options.body);
  assert.strictEqual(a1ReferenceNamePayload.customerId, 'a1');
  assert.strictEqual(a1ReferenceNamePayload.customerReference, 'Phil Smith');
  assert.strictEqual(a1ReferenceNamePayload.consignments[0].consignmentReference, 'Phil Smith');
  assert(a1ReferenceNamePayload.accountNotes.includes('A1 payment: Paid'));
  assert(a1ReferenceNamePayload.accountNotes.includes('Driver note: Leave cones by the gate'));
  assert.strictEqual(a1ReferenceNamePayload.trafficNotes, 'Paid | Leave cones by the gate', 'A1 payment and driver note should be plain invoicing-visible traffic notes');
  assert(!a1ReferenceNamePayload.trafficNotes.includes('Driver note:'), 'traffic notes should contain the note text, not the Driver note label');
  assert(!a1ReferenceNamePayload.trafficNotes.includes('A1 payment:'), 'traffic notes should contain Paid/Not paid, not the account-note label');

  const referenceRepair = sandbox.applyTypedCustomerToDriverAddedReference({
    customerReference: '1736',
    accountNotes: 'Added by Ian Slater / PN25FLF | Phone source: driver-1781544594949',
    trafficNotes: 'Leave at gate',
    consignments: [{ consignmentReference: '1736', goodsDescription: 'C35 PMG QU' }],
  }, 'Phil smith', '1736');
  assert.strictEqual(referenceRepair.changed, true);
  assert.strictEqual(referenceRepair.reference, 'Phil Smith - 1736');
  assert.strictEqual(referenceRepair.job.customerReference, 'Phil Smith - 1736');
  assert.strictEqual(referenceRepair.job.consignments[0].consignmentReference, 'Phil Smith - 1736');
  assert(referenceRepair.job.accountNotes.includes('Typed customer/site: Phil Smith'));
  assert.strictEqual(referenceRepair.job.trafficNotes, 'Leave at gate', 'reference repair must preserve existing plain traffic notes without adding labels');

  sandbox.__fetches.length = 0;
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({
      id: 'driver-priced-1',
      date: '2026-06-09',
      customer: 'Customer One',
      driver: 'Richard Whittaker',
      vehicle: 'EY15BOV',
      material: 'MOT',
      quantity: 10,
      unit: 't',
      priceMode: 'rate',
      priceInput: 21.5,
      price: 215,
    }),
  });
  assert.strictEqual(resp.status, 200);
  const pricedPayload = JSON.parse(sandbox.__fetches[1].options.body);
  assert.strictEqual(pricedPayload.quotedPrice, 215);
  assert.strictEqual(pricedPayload.useQuotedPrice, true);
  assert(pricedPayload.accountNotes.includes('Priced by Richard: £21.50/t = £215.00'));

  sandbox.__fetches.length = 0;
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({
      id: 'driver-priced-denied-1',
      date: '2026-06-09',
      customer: 'Customer One',
      driver: 'John Bowman',
      vehicle: 'EY15BOV',
      material: 'MOT',
      quantity: 10,
      unit: 't',
      priceMode: 'rate',
      priceInput: 21.5,
      price: 215,
    }),
  });
  assert.strictEqual(resp.status, 200);
  const deniedPricePayload = JSON.parse(sandbox.__fetches[1].options.body);
  assert.strictEqual(deniedPricePayload.quotedPrice, 0);
  assert.strictEqual(deniedPricePayload.useQuotedPrice, false);
  assert(!deniedPricePayload.accountNotes.includes('Priced by Richard'));

  sandbox.__fetches.length = 0;
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({
      id: 'driver-concrete-1',
      date: '2026-06-15',
      customer: 'Customer One',
      driver: 'Ian Slater',
      vehicle: 'PN25FLF',
      material: 'C35pmg Qu',
      quantity: 0.91,
      unit: 'm3',
      from: 'Yard',
      to: 'Nottend',
      ticketNo: '1736',
    }),
  });
  assert.strictEqual(resp.status, 200);
  const concretePayload = JSON.parse(sandbox.__fetches[1].options.body);
  assert.strictEqual(concretePayload.quotedPrice, 150.15);
  assert.strictEqual(concretePayload.useQuotedPrice, true);
  assert.strictEqual(concretePayload.consignments[0].goodsDescription, 'C35pmg Qu');
  assert(concretePayload.accountNotes.includes('Driver app source: Ian Slater / PN25FLF / 0.91m3 / Yard to Nottend'));
  assert(concretePayload.accountNotes.includes('Auto-priced PMG quarried concrete: 3.5m3 or under @ £165.00/m3 = £150.15'));

  sandbox.__fetches.length = 0;
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({
      id: 'driver-concrete-note-qty',
      date: '2026-06-29',
      customer: 'Customer One',
      driver: 'Ian Slater',
      vehicle: 'PN25FLF',
      material: 'CONCRETE',
      notes: 'QUARRIED\n4M3\nRING WITH ETA',
      from: 'Yard',
      to: 'Customer site',
      ticketNo: 'NOTE-QTY',
    }),
  });
  assert.strictEqual(resp.status, 200);
  const noteQtyPayload = JSON.parse(sandbox.__fetches[1].options.body);
  assert.strictEqual(noteQtyPayload.quantity, 4);
  assert.strictEqual(noteQtyPayload.consignments[0].quantity, 4);
  assert.strictEqual(noteQtyPayload.quotedPrice, 580);
  assert.strictEqual(noteQtyPayload.useQuotedPrice, true);
  assert(noteQtyPayload.accountNotes.includes('Driver app source: Ian Slater / PN25FLF / 4m3 / Yard to Customer site'));
  assert(noteQtyPayload.accountNotes.includes('Auto-priced PMG quarried concrete: over 3.5m3 @ £145.00/m3 = £580.00'));

  sandbox.__fetches.length = 0;
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({
      id: 'driver-concrete-m-shorthand',
      date: '2026-06-29',
      customer: 'Customer One',
      driver: 'Ian Slater',
      vehicle: 'PN25FLF',
      material: 'C30pmg Recycled paid',
      notes: 'Driver note: 5.8m c30pmg Recycled',
      from: 'Yard',
      to: 'Customer site',
      ticketNo: 'M-SHORTHAND',
    }),
  });
  assert.strictEqual(resp.status, 200);
  const mShorthandPayload = JSON.parse(sandbox.__fetches[1].options.body);
  assert.strictEqual(mShorthandPayload.quantity, 5.8);
  assert.strictEqual(mShorthandPayload.quotedPrice, 783);
  assert(mShorthandPayload.accountNotes.includes('Auto-priced PMG recycled concrete: over 3.5m3 @ £135.00/m3 = £783.00'));

  sandbox.__fetches.length = 0;
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({
      id: 'driver-concrete-3-49',
      date: '2026-07-01',
      customer: 'Customer One',
      driver: 'Ian Slater',
      vehicle: 'PN25FLF',
      material: 'C30pmg Qu',
      quantity: 3.49,
      unit: 'm3',
      from: 'Yard',
      to: 'Customer site',
      ticketNo: 'THRESH-UNDER',
    }),
  });
  assert.strictEqual(resp.status, 200);
  const underThresholdPayload = JSON.parse(sandbox.__fetches[1].options.body);
  assert.strictEqual(underThresholdPayload.quotedPrice, 575.85);
  assert(underThresholdPayload.accountNotes.includes('Auto-priced PMG quarried concrete: 3.5m3 or under @ £165.00/m3 = £575.85'));

  sandbox.__fetches.length = 0;
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({
      id: 'driver-concrete-3-5',
      date: '2026-07-01',
      customer: 'Customer One',
      driver: 'Ian Slater',
      vehicle: 'PN25FLF',
      material: 'C30pmg Qu',
      quantity: 3.5,
      unit: 'm3',
      from: 'Yard',
      to: 'Customer site',
      ticketNo: 'THRESH-EXACT',
    }),
  });
  assert.strictEqual(resp.status, 200);
  const exactThresholdPayload = JSON.parse(sandbox.__fetches[1].options.body);
  assert.strictEqual(exactThresholdPayload.quotedPrice, 577.5);
  assert(exactThresholdPayload.accountNotes.includes('Auto-priced PMG quarried concrete: 3.5m3 or under @ £165.00/m3 = £577.50'));

  sandbox.__fetches.length = 0;
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({
      id: 'driver-concrete-any-reg',
      date: '2026-06-29',
      customer: 'Customer One',
      driver: 'John Bowman',
      vehicle: 'YJ13GRF',
      material: 'C30 PMG QU',
      notes: '4M3 supplied',
      from: 'Yard',
      to: 'Customer site',
      ticketNo: 'ANY-REG-M3',
    }),
  });
  assert.strictEqual(resp.status, 200);
  const anyRegConcretePayload = JSON.parse(sandbox.__fetches[1].options.body);
  assert.strictEqual(anyRegConcretePayload.quantity, 4);
  assert.strictEqual(anyRegConcretePayload.quotedPrice, 580);
  assert.strictEqual(anyRegConcretePayload.useQuotedPrice, true);
  assert(anyRegConcretePayload.accountNotes.includes('Driver app source: John Bowman / YJ13GRF / 4m3 / Yard to Customer site'));

  sandbox.__fetches.length = 0;
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({
      id: 'driver-concrete-untyped',
      date: '2026-06-29',
      customer: 'Customer One',
      driver: 'John Bowman',
      vehicle: 'YJ13GRF',
      material: 'Concrete',
      notes: '2M3 supplied',
      from: 'Yard',
      to: 'Customer site',
      ticketNo: 'UNTYPED-M3',
    }),
  });
  assert.strictEqual(resp.status, 200);
  const untypedConcretePayload = JSON.parse(sandbox.__fetches[1].options.body);
  assert.strictEqual(untypedConcretePayload.quantity, 2);
  assert.strictEqual(untypedConcretePayload.quotedPrice, 0);
  assert.strictEqual(untypedConcretePayload.useQuotedPrice, false);
  assert(!untypedConcretePayload.accountNotes.includes('Auto-priced PMG recycled concrete'));

  sandbox.__fetches.length = 0;
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({
      id: 'driver-internal-pmg-eight',
      date: '2026-06-29',
      customer: 'A1',
      driver: 'John Bowman',
      vehicle: 'PN25AMU',
      material: 'Equestrian sand',
      quantity: 19.6,
      unit: 't',
      from: 'Arclid Sandbach',
      to: 'Yard',
      ticketNo: 'PM GROUNDWORKS 7542',
    }),
  });
  assert.strictEqual(resp.status, 200);
  const internalEightPayload = JSON.parse(sandbox.__fetches[1].options.body);
  assert.strictEqual(internalEightPayload.quotedPrice, 100);
  assert.strictEqual(internalEightPayload.useQuotedPrice, true);
  assert(internalEightPayload.accountNotes.includes('Auto-priced internal PM Groundworks eight-wheeler: £100.00'));

  sandbox.__fetches.length = 0;
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({
      id: 'driver-internal-pmg-artic',
      date: '2026-06-29',
      customer: 'A1',
      driver: 'Richard Whittaker',
      vehicle: 'BT66ZJO',
      material: 'Internal move',
      quantity: 1,
      unit: 'load',
      from: 'Site',
      to: 'Yard',
      ticketNo: 'PMG INTERNAL 1',
    }),
  });
  assert.strictEqual(resp.status, 200);
  const internalArticPayload = JSON.parse(sandbox.__fetches[1].options.body);
  assert.strictEqual(internalArticPayload.quotedPrice, 150);
  assert.strictEqual(internalArticPayload.useQuotedPrice, true);
  assert(internalArticPayload.accountNotes.includes('Auto-priced internal PM Groundworks artic: £150.00'));

  for (const denied of [
    { path: '/haultech-auth', method: 'PUT', body: JSON.stringify({ token: 'public-overwrite' }) },
    { path: '/haultech-auth-admin', method: 'GET' },
    { path: '/haultech-refresh', method: 'POST', body: '{}' },
    { path: '/customers', method: 'PUT', body: '[]' },
    { path: '/customers/refresh', method: 'POST', body: '{}' },
    { path: '/haultech-diary/2026-06-08', method: 'PUT', body: '[]' },
  ]) {
    resp = await workerRequest(denied.path, { method: denied.method, body: denied.body });
    assert.strictEqual(resp.status, 403, `${denied.method} ${denied.path} should require admin key`);
    assert.deepStrictEqual(await resp.json(), { error: 'admin_key_required' });
  }

  const authEnv = env();
  resp = await workerRequest('/haultech-auth', {
    method: 'PUT',
    headers: { 'X-PMG-Admin-Key': 'admin-key' },
    body: JSON.stringify({ token: 'admin-token', tmsId: 'admin-tms', refreshToken: 'admin-refresh' }),
  }, authEnv);
  assert.strictEqual(resp.status, 200);
  assert.strictEqual(JSON.parse(authEnv.__store.get('haultech-auth')).token, 'admin-token');

  resp = await workerRequest('/haultech-auth-admin', {
    headers: { 'X-PMG-Admin-Key': 'admin-key' },
  }, authEnv);
  assert.strictEqual(resp.status, 200);
  assert.strictEqual((await resp.json()).refreshToken, 'admin-refresh');

  resp = await workerRequest('/haultech-auth-status');
  assert.strictEqual(resp.status, 200, 'public driver key should still read token diagnostics');
  assert.strictEqual((await resp.json()).hasToken, true);

  const mileageEnv = env();
  mileageEnv.__store.set('plant:snapshot:v1', JSON.stringify({
    schema: 'pmg-plant-snapshot-v1',
    stats: {},
    sharePointEvidenceRoot: 'SHARED/Haulage and Vehicle Checks',
    assets: [{
      id: 'BT15LFB',
      plantNumber: 'BT15LFB',
      registration: 'BT15LFB',
      assetType: 'vehicle',
      displayName: 'BT15 LFB - Ford Transit',
      machineType: 'Ford Transit',
      scheduleNotes: [],
      sources: [],
    }],
    history: [],
    filterParts: {},
    reviewItems: [],
  }));
  resp = await workerRequest('/plant/service-events', {
    method: 'POST',
    body: JSON.stringify({
      assetId: 'BT15LFB',
      plantNumber: 'BT15LFB',
      registration: 'BT15LFB',
      assetType: 'vehicle',
      date: '2026-06-10',
      category: 'service',
      serviceType: 'Pre-MOT service',
      mileage: 74200,
      nextDueDate: '2027-06-10',
      nextDueDateBasis: '12_month_service_rule',
      nextDueMileage: 84200,
      nextServiceIntervalMiles: 10000,
      createdBy: 'Gary',
    }),
  }, mileageEnv);
  assert.strictEqual(resp.status, 200);
  const mileageEvent = await resp.json();
  assert.strictEqual(mileageEvent.event.mileage, 74200);
  assert.strictEqual(mileageEvent.event.nextDueMileage, 84200);

  resp = await workerRequest('/plant/assets/BT15LFB?role=gary', {}, mileageEnv);
  assert.strictEqual(resp.status, 200);
  const mileageRecord = await resp.json();
  assert.strictEqual(mileageRecord.asset.lastKnownMileage, 74200);
  assert.strictEqual(mileageRecord.asset.lastServiceMileage, 74200);
  assert.strictEqual(mileageRecord.asset.nextServiceDueMileage, 84200);
  assert.strictEqual(mileageRecord.history[0].createdBy, 'Gary');

  console.log('worker admin gate regression checks passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
