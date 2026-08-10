const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectRoot = path.resolve(__dirname, '..');
const workerPath = path.join(projectRoot, 'worker', 'index.js');
const workerSource = fs.readFileSync(workerPath, 'utf8');

function mockCalculatorResponse() {
  const calculatorReply = sandbox.__calculatorReply || {
    postcode: 'FY6 9DJ',
    route: { oneWayMinutes: 8.2, oneWayMiles: 3.1 },
    pricingVersion: '29 July 2026',
    calculation: {
      deliveryBand: { label: '0-15 minutes', supplementPerVisit: -25 },
      totalExVat: 555,
      officeReviewRequired: false,
    },
  };
  return new Response(JSON.stringify(calculatorReply.body || calculatorReply), { status: calculatorReply.status || 200 });
}

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
    if (String(url).includes('api.geoapify.com/v1/geocode/autocomplete')) {
      return new Response(JSON.stringify({
        results: [{
          place_id: 'geo-test-place',
          name: 'High View',
          street: 'Sower Carr Lane',
          address_line1: 'High View',
          address_line2: 'Sower Carr Lane, Hambleton, FY6 9DJ',
          city: 'Hambleton',
          county: 'Lancashire',
          postcode: 'FY6 9DJ',
          country: 'United Kingdom',
          formatted: 'High View, Sower Carr Lane, Hambleton, Poulton-le-Fylde FY6 9DJ, United Kingdom',
          lat: 53.8854,
          lon: -2.9488,
        }],
      }), { status: 200 });
    }
    if (String(url).includes('pmg-concrete-price.jimpmgr.workers.dev/api/quote')) {
      return new Response(JSON.stringify({ error: 'public_worker_to_worker_404' }), { status: 404 });
    }
    if (String(url).includes('/api/Display/GetJobsByDatePaginated')) {
      return new Response(JSON.stringify({ items: sandbox.__haultechJobs || [] }), { status: 200 });
    }
    if (String(url).includes('/api/Customer/GetCustomerPaginated')) {
      return new Response(JSON.stringify(sandbox.__haultechCustomers || []), { status: 200 });
    }
    return new Response(JSON.stringify({ jobId: 'JOB-ADMIN-1' }), { status: 200 });
  },
  __fetches: [],
  __haultechJobs: [],
  __haultechCustomers: [],
  __calculatorReply: null,
  __serviceBindingCalls: 0,
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
    GEOAPIFY_API_KEY: 'test-geoapify-key',
    CONCRETE_PRICE_SERVICE: {
      fetch: async request => {
        sandbox.__serviceBindingCalls += 1;
        sandbox.__fetches.push({ url: request.url, options: {
          method: request.method,
          headers: request.headers,
          body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
        } });
        return mockCalculatorResponse();
      },
    },
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

async function completeJobFixture(job, quantity, extras = {}) {
  sandbox.__fetches.length = 0;
  const serviceBindingCallsBefore = sandbox.__serviceBindingCalls;
  sandbox.__haultechJobs = [job];
  const resp = await workerRequest(`/ht/complete/${job.jobId}`, {
    method: 'PATCH',
    body: JSON.stringify({ date: '2026-07-30', quantity, ...extras }),
  });
  const result = await resp.json();
  const upsertCall = sandbox.__fetches.find(call => call.url.endsWith('/api/Job/UpsertJob?formId='));
  const upsertPayload = upsertCall ? JSON.parse(upsertCall.options.body) : null;
  const calculatorCalls = sandbox.__fetches.filter(call => call.url.includes('/api/quote'));
  sandbox.__haultechJobs = [];
  return {
    resp,
    result,
    upsertPayload,
    calculatorCalls,
    serviceBindingCalls: sandbox.__serviceBindingCalls - serviceBindingCallsBefore,
  };
}

(async () => {
  let resp = await worker.fetch(new Request('https://pmg-driver-sync.test/health'), env());
  assert.strictEqual(resp.status, 200, 'health check must be public and read-only');
  const health = await resp.json();
  assert.strictEqual(health.ok, true);
  assert.strictEqual(health.service, 'pmg-driver-sync');
  assert.strictEqual(health.driverApiContract, 'pmg-driver-api-v2');
  assert.match(health.workerBuildId, /^20260810-driver-movement-idempotency-worker-v11$/);

  const addressEnv = env();
  resp = await workerRequest('/address/autocomplete', {
    method: 'POST',
    body: JSON.stringify({ input: 'High View Sow' }),
  }, addressEnv);
  assert.strictEqual(resp.status, 200);
  const addressSuggestions = await resp.json();
  assert.strictEqual(addressSuggestions.suggestions[0].placeId, 'geo-test-place');
  assert.strictEqual(addressSuggestions.suggestions[0].mainText, 'High View');
  const selectedAddress = addressSuggestions.suggestions[0].address;
  assert.strictEqual(selectedAddress.line1, 'High View');
  assert.strictEqual(selectedAddress.line2, 'Sower Carr Lane');
  assert.strictEqual(selectedAddress.postcode, 'FY6 9DJ');
  sandbox.__fetches.length = 0;
  const noGeoapifyEnv = env();
  delete noGeoapifyEnv.GEOAPIFY_API_KEY;
  resp = await workerRequest('/address/autocomplete', {
    method: 'POST',
    body: JSON.stringify({ input: 'High View Sow' }),
  }, noGeoapifyEnv);
  assert.strictEqual(resp.status, 503);
  assert.strictEqual((await resp.json()).error, 'address_search_not_configured');
  assert.strictEqual(sandbox.__fetches.length, 0, 'missing Geoapify secret must fail before any external request');

  resp = await upsertRequest({}, { customerReference: 'PUBLIC-ONLY' });
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
    jobId: 9100,
    id: '11111111-1111-4111-8111-111111111111',
    customerReference: 'HONEYWELLS',
    quantity: 20,
    consignments: [{ goodsDescription: 'Type 1 MOT', quantity: 20 }],
  }];
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({
      id: 'driver-honeywells-second',
      date: '2026-08-04',
      customer: 'Customer One',
      driver: 'Neil Antony',
      vehicle: 'EY15BOV',
      material: 'Type 1 MOT plus grab spoil away',
      quantity: 20,
      unit: 't',
      from: 'PMG Yard',
      to: 'Honeywells',
      reference: 'HONEYWELLS',
      notes: 'Second physical movement; 15t spoil returned',
    }),
  });
  assert.strictEqual(resp.status, 200);
  const referenceCollisionAdd = await resp.json();
  assert.strictEqual(referenceCollisionAdd.alreadyPresent, false, 'same reference with different movement signature must be created');
  assert.strictEqual(referenceCollisionAdd.referenceCollision, true, 'reference collision should remain visible in the response');
  assert.strictEqual(sandbox.__fetches.length, 2, 'reference collision must still upsert the distinct movement');
  sandbox.__haultechJobs = [];

  const identicalSimonBody = {
    date: '2026-08-10',
    customer: 'Customer One',
    driver: 'Neil Antony',
    vehicle: 'EY15BOV',
    material: '6F2',
    quantity: 20,
    unit: 't',
    from: 'PMG Yard',
    to: 'Goosnargh Lodge Park',
    reference: 'SIMON WARD',
    notes: '20t 6F2',
  };
  sandbox.__haultechJobs = [{
    jobId: 10037,
    id: '11111111-2222-4333-8444-555555555557',
    customerReference: 'SIMON WARD',
    accountNotes: 'Driver movement: driver-simon-load-1 | Driver app source: Neil Antony / EY15BOV / 20t / PMG Yard to Goosnargh Lodge Park',
    consignments: [{ goodsDescription: '6F2', quantity: 20 }],
  }];
  sandbox.__fetches.length = 0;
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({ ...identicalSimonBody, id: 'driver-simon-load-1' }),
  });
  assert.strictEqual(resp.status, 200);
  const sameMovementRetry = await resp.json();
  assert.strictEqual(sameMovementRetry.alreadyPresent, true, 'retrying the same Android movement id must remain idempotent');
  assert.strictEqual(sandbox.__fetches.length, 1, 'same movement retry must not upsert a second Haultech job');

  sandbox.__fetches.length = 0;
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({ ...identicalSimonBody, id: 'driver-simon-load-2' }),
  });
  assert.strictEqual(resp.status, 200);
  const secondIdenticalMovement = await resp.json();
  assert.strictEqual(secondIdenticalMovement.alreadyPresent, false, 'a second genuine identical load with a distinct movement id must be created');
  assert.strictEqual(sandbox.__fetches.length, 2, 'distinct movement id must reach Haultech UpsertJob');
  const secondSimonPayload = JSON.parse(sandbox.__fetches[1].options.body);
  assert(secondSimonPayload.accountNotes.includes('Driver movement: driver-simon-load-2'));
  sandbox.__haultechJobs = [];

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

  let completionPricing = await completeJobFixture({
    jobId: 9801,
    id: '11111111-1111-4111-8111-111111111111',
    customerId: 'external-customer',
    customerName: 'External Customer',
    customerReference: 'External concrete delivery',
    quotedPrice: 0,
    totalPrice: 0,
    accountNotes: 'OFFICE PRICE REVIEW REQUIRED: prior calculator failure | QUARRIED concrete',
    consignments: [{
      consignmentId: 9801,
      goodsDescription: 'C35pmg Qu',
      deliveryAddressLine1: 'High View',
      deliveryPostcode: 'FY6 9DJ',
    }],
  }, 1.51);
  assert.strictEqual(completionPricing.resp.status, 200);
  assert.strictEqual(completionPricing.calculatorCalls.length, 1, 'external concrete completion must use the shared postcode calculator');
  assert.strictEqual(completionPricing.serviceBindingCalls, 1, 'completion pricing must use the calculator service binding, not public Worker fetch');
  assert.strictEqual(completionPricing.upsertPayload.quantity, 1.51);
  assert.strictEqual(completionPricing.upsertPayload.quotedPrice, 555);
  assert.strictEqual(completionPricing.upsertPayload.totalPrice, 555, 'completion must write quoted and total prices together');
  assert.strictEqual(completionPricing.upsertPayload.useQuotedPrice, true);
  assert(completionPricing.upsertPayload.accountNotes.includes('Auto-priced quarried concrete to FY6 9DJ'));
  assert(!completionPricing.upsertPayload.accountNotes.includes('OFFICE PRICE REVIEW REQUIRED'), 'successful retry must clear its stale office-review marker');

  completionPricing = await completeJobFixture({
    jobId: 9802,
    id: '22222222-2222-4222-8222-222222222222',
    customerId: 'external-customer',
    customerName: 'External Customer',
    customerReference: 'Existing manual price',
    quotedPrice: 123.45,
    totalPrice: 123.45,
    accountNotes: 'QUARRIED concrete',
    consignments: [{ consignmentId: 9802, goodsDescription: 'C35pmg Qu', deliveryPostcode: 'FY6 9DJ' }],
  }, 1.71);
  assert.strictEqual(completionPricing.upsertPayload.quotedPrice, 123.45, 'completion must never overwrite a non-zero price');
  assert.strictEqual(completionPricing.calculatorCalls.length, 0, 'existing prices must bypass automatic pricing');

  completionPricing = await completeJobFixture({
    jobId: 9803,
    id: '33333333-3333-4333-8333-333333333333',
    customerId: 'external-customer',
    customerName: 'External Customer',
    customerReference: 'No postcode concrete',
    quotedPrice: 0,
    accountNotes: 'RECYCLED concrete',
    consignments: [{ consignmentId: 9803, goodsDescription: 'C25pmg Rec', deliveryAddressLine1: 'Poulton-le-Fylde' }],
  }, 0.89);
  assert.strictEqual(completionPricing.upsertPayload.quotedPrice, 0, 'missing postcode must leave external concrete for office review');
  assert.strictEqual(completionPricing.calculatorCalls.length, 0);
  assert(completionPricing.upsertPayload.accountNotes.includes('OFFICE PRICE REVIEW REQUIRED'), 'unpriced completion must leave a durable office-review marker');
  assert(sandbox.__fetches.some(call => call.url.includes('/api/Job/QuickCompleteJob')), 'review-marked rows may complete without blocking the driver');

  completionPricing = await completeJobFixture({
    jobId: 9804,
    id: '44444444-4444-4444-8444-444444444444',
    customerId: '6861767c-4418-45ec-ac56-a0673ecce127',
    customerName: 'PM Groundworks',
    customerReference: 'PMG Carnforth',
    quotedPrice: 0,
    consignments: [{ consignmentId: 9804, goodsDescription: 'C35pmg Qu' }],
  }, 4.69);
  assert.strictEqual(completionPricing.upsertPayload.quotedPrice, 187.6, 'internal PMG concrete must use the £40/m3 saving rate');
  assert.strictEqual(completionPricing.calculatorCalls.length, 0);

  completionPricing = await completeJobFixture({
    jobId: 9810,
    id: '10101010-1010-4010-8010-101010101010',
    customerId: 'external-customer',
    customerName: 'External Customer',
    customerReference: 'External concrete to PMG site',
    quotedPrice: 0,
    accountNotes: 'QUARRIED concrete for PMG',
    consignments: [{
      consignmentId: 9810,
      goodsDescription: 'C35pmg Qu',
      deliveryAddressLine1: 'PMG Carnforth',
      deliveryPostcode: 'LA5 9RQ',
    }],
  }, 2);
  assert.strictEqual(completionPricing.upsertPayload.quotedPrice, 555, 'external concrete must use the postcode calculator even when delivered to a PMG-named site');
  assert.strictEqual(completionPricing.calculatorCalls.length, 1);

  completionPricing = await completeJobFixture({
    jobId: 9805,
    id: '55555555-5555-4555-8555-555555555555',
    customerId: '650fea1c-aa1d-47f5-891e-77300886eef4',
    customerName: 'Wyre Building Supplies Limited',
    customerReference: 'Wyre stone',
    quotedPrice: 0,
    consignments: [{ consignmentId: 9805, goodsDescription: '6MM S/S' }],
  }, 27.36);
  assert.strictEqual(completionPricing.upsertPayload.quotedPrice, 921.48, 'Wyre 6mm/20mm clean stone family must use £33.68/t');

  completionPricing = await completeJobFixture({
    jobId: 9817,
    id: '17171717-1717-4717-8717-171717171717',
    customerId: '650fea1c-aa1d-47f5-891e-77300886eef4',
    customerName: 'Wyre Building Supplies Limited',
    customerReference: 'Wyre 10mm stone',
    quotedPrice: 0,
    consignments: [{ consignmentId: 9817, goodsDescription: '10MM S/S' }],
  }, 27.16);
  assert.strictEqual(completionPricing.upsertPayload.quotedPrice, 914.75, 'Wyre 10MM S/S must use the proven clean-stone family rate of £33.68/t');

  completionPricing = await completeJobFixture({
    jobId: 9818,
    id: '18181818-1818-4818-8818-181818181818',
    customerId: '650fea1c-aa1d-47f5-891e-77300886eef4',
    customerName: 'Wyre Building Supplies Limited',
    customerReference: 'Wyre unsupported longer alias',
    quotedPrice: 0,
    consignments: [{ consignmentId: 9818, goodsDescription: '10MM S/S Decorative' }],
  }, 27.16);
  assert.strictEqual(completionPricing.upsertPayload.quotedPrice, 0, 'longer unsupported 10MM S/S descriptions must not inherit the clean-stone rate');
  assert(completionPricing.upsertPayload.accountNotes.includes('OFFICE PRICE REVIEW REQUIRED'));

  completionPricing = await completeJobFixture({
    jobId: 9806,
    id: '66666666-6666-4666-8666-666666666666',
    customerId: '650fea1c-aa1d-47f5-891e-77300886eef4',
    customerName: 'Wyre Building Supplies Limited',
    customerReference: 'Wyre recycled',
    quotedPrice: 0,
    consignments: [{ consignmentId: 9806, goodsDescription: '6F2 Crushed Concrete' }],
  }, 20);
  assert.strictEqual(completionPricing.upsertPayload.quotedPrice, 240, 'Wyre 6F2/crush must use £12/t');
  assert.strictEqual(completionPricing.calculatorCalls.length, 0, '6F2 crushed concrete must not be mistaken for volumetric concrete');

  completionPricing = await completeJobFixture({
    jobId: 9811,
    id: '11111111-aaaa-4111-8111-111111111111',
    customerId: '650fea1c-aa1d-47f5-891e-77300886eef4',
    customerName: 'Wyre Building Supplies Limited',
    customerReference: 'Wyre unsupported crushed material',
    quotedPrice: 0,
    consignments: [{ consignmentId: 9811, goodsDescription: 'Crushed Limestone' }],
  }, 20);
  assert.strictEqual(completionPricing.upsertPayload.quotedPrice, 0, 'generic crushed materials must not inherit the proven Wyre 6F2 rate');

  completionPricing = await completeJobFixture({
    jobId: 9812,
    id: '12121212-1212-4212-8212-121212121212',
    customerId: 'external-customer',
    customerName: 'External Customer',
    customerReference: 'Plot C35',
    quotedPrice: 0,
    accountNotes: 'quarried material',
    consignments: [{ consignmentId: 9812, goodsDescription: '20mm Clean Stone' }],
  }, 20);
  assert.strictEqual(completionPricing.upsertPayload.quotedPrice, 0, 'plot/reference grade text must not turn an aggregate job into concrete');
  assert.strictEqual(completionPricing.calculatorCalls.length, 0);

  completionPricing = await completeJobFixture({
    jobId: 9807,
    id: '77777777-7777-4777-8777-777777777777',
    customerId: '650fea1c-aa1d-47f5-891e-77300886eef4',
    customerName: 'Wyre Building Supplies Limited',
    customerReference: 'Wyre unsupported',
    quotedPrice: 0,
    consignments: [{ consignmentId: 9807, goodsDescription: 'Unknown special stone' }],
  }, 20);
  assert.strictEqual(completionPricing.upsertPayload.quotedPrice, 0, 'unsupported Wyre materials must remain unpriced');
  assert(completionPricing.upsertPayload.accountNotes.includes('OFFICE PRICE REVIEW REQUIRED'));

  completionPricing = await completeJobFixture({
    jobId: 9808,
    id: '88888888-8888-4888-8888-888888888888',
    customerId: '650fea1c-aa1d-47f5-891e-77300886eef4',
    customerName: 'Wyre Building Supplies Limited',
    customerReference: 'Wyre concrete manual',
    quotedPrice: 0,
    accountNotes: 'QUARRIED concrete',
    consignments: [{ consignmentId: 9808, goodsDescription: 'C35pmg Qu', deliveryPostcode: 'FY6 9DJ' }],
  }, 2.61);
  assert.strictEqual(completionPricing.upsertPayload.quotedPrice, 0, 'Wyre concrete must remain manual because its historical rates vary');
  assert.strictEqual(completionPricing.calculatorCalls.length, 0);
  assert(completionPricing.upsertPayload.accountNotes.includes('OFFICE PRICE REVIEW REQUIRED'));

  completionPricing = await completeJobFixture({
    jobId: 9813,
    id: '13131313-1313-4313-8313-131313131313',
    customerId: 'external-customer',
    customerName: 'External Customer',
    customerReference: 'Negative manual correction',
    quotedPrice: -50,
    totalPrice: -50,
    accountNotes: 'QUARRIED concrete',
    consignments: [{ consignmentId: 9813, goodsDescription: 'C35pmg Qu', deliveryPostcode: 'FY6 9DJ' }],
  }, 1.2);
  assert.strictEqual(completionPricing.upsertPayload.quotedPrice, -50, 'negative manual price corrections must never be overwritten');
  assert.strictEqual(completionPricing.calculatorCalls.length, 0);

  sandbox.__calculatorReply = {
    calculation: {
      deliveryBand: { label: 'Office review' },
      totalExVat: 0,
      officeReviewRequired: true,
    },
    pricingVersion: 'review-test',
  };
  completionPricing = await completeJobFixture({
    jobId: 9814,
    id: '14141414-1414-4414-8414-141414141414',
    customerId: 'external-customer',
    customerName: 'External Customer',
    customerReference: 'Calculator review',
    quotedPrice: 0,
    accountNotes: 'QUARRIED concrete',
    consignments: [{ consignmentId: 9814, goodsDescription: 'C35pmg Qu', deliveryPostcode: 'FY6 9DJ' }],
  }, 1.2);
  sandbox.__calculatorReply = null;
  assert.strictEqual(completionPricing.upsertPayload.quotedPrice, 0);
  assert(completionPricing.upsertPayload.accountNotes.includes('OFFICE PRICE REVIEW REQUIRED'), 'calculator review responses must be made durable in Haultech');

  completionPricing = await completeJobFixture({
    jobId: 9815,
    id: '15151515-1515-4515-8515-151515151515',
    customerId: 'external-customer',
    customerName: 'External Customer',
    customerReference: 'Unknown concrete source',
    quotedPrice: 0,
    consignments: [{ consignmentId: 9815, goodsDescription: 'Concrete', deliveryPostcode: 'FY6 9DJ' }],
  }, 1.2);
  assert.strictEqual(completionPricing.resp.status, 422, 'missing concrete type must block completion');
  assert.strictEqual(completionPricing.result.error, 'concrete_type_required');
  assert.strictEqual(completionPricing.calculatorCalls.length, 0);
  assert.strictEqual(completionPricing.upsertPayload, null, 'missing concrete type must not write or complete the job');

  completionPricing = await completeJobFixture({
    jobId: 9819,
    id: '19191919-1919-4919-8919-191919191919',
    customerId: 'external-customer',
    customerName: 'External Customer',
    customerReference: 'ST1 concrete with missing source',
    quotedPrice: 0,
    consignments: [{ consignmentId: 9819, goodsDescription: 'ST1 CONCRETE', deliveryPostcode: 'FY6 8AR' }],
  }, 2);
  assert.strictEqual(completionPricing.resp.status, 422, 'ST concrete descriptions must use the concrete source gate');
  assert.strictEqual(completionPricing.result.error, 'concrete_type_required');
  assert(!sandbox.__fetches.some(call => call.url.includes('/api/Job/QuickCompleteJob')), 'blocked ST concrete must not reach QuickCompleteJob');

  completionPricing = await completeJobFixture({
    jobId: 9820,
    id: '20202020-2020-4020-8020-202020202020',
    customerId: 'external-customer',
    customerName: 'External Customer',
    customerReference: 'ST1 concrete with driver source',
    quotedPrice: 0,
    consignments: [{ consignmentId: 9820, goodsDescription: 'ST1 CONCRETE', deliveryPostcode: 'FY6 8AR' }],
  }, 2, { concreteType: 'quarried' });
  assert.strictEqual(completionPricing.resp.status, 200, 'explicit ST concrete source must allow completion');
  assert(completionPricing.upsertPayload.accountNotes.includes('Driver confirmed QUARRIED concrete source'));
  assert(sandbox.__fetches.some(call => call.url.includes('/api/Job/QuickCompleteJob')), 'typed ST concrete may reach QuickCompleteJob');

  sandbox.__calculatorReply = { status: 503, body: { error: 'pricing unavailable' } };
  completionPricing = await completeJobFixture({
    jobId: 9816,
    id: '16161616-1616-4616-8616-161616161616',
    customerId: 'external-customer',
    customerName: 'External Customer',
    customerReference: 'Calculator unavailable',
    quotedPrice: 0,
    accountNotes: 'QUARRIED concrete',
    consignments: [{ consignmentId: 9816, goodsDescription: 'C35pmg Qu', deliveryPostcode: 'FY6 9DJ' }],
  }, 1.2);
  sandbox.__calculatorReply = null;
  assert.strictEqual(completionPricing.upsertPayload.quotedPrice, 0);
  assert(completionPricing.upsertPayload.accountNotes.includes('OFFICE PRICE REVIEW REQUIRED'), 'calculator HTTP failures must be visibly held for review');

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

  const paymentEnv = env();
  paymentEnv.__store.set('jobs:2026-07-20', JSON.stringify([
    {
      id: '8549ee7f-4def-466e-84d3-3267d2b9fe5c',
      reference: 'Cleveleys landscapes',
      notes: 'Not paid | 10mm no fines Paid £355 cash',
      paymentStatus: 'not_paid',
      a1PaymentStatus: 'not_paid',
      _driverAdded: true,
    },
    {
      id: '979a47c0-2c41-466f-8245-c65c975d356b',
      reference: 'Hosk',
      notes: 'Not paid | Hosk resin 10mm no fines not paid',
      paymentStatus: 'not_paid',
      a1PaymentStatus: 'not_paid',
      _driverAdded: true,
    },
  ]));
  sandbox.__fetches.length = 0;
  sandbox.__haultechJobs = [{
    jobId: 9555,
    id: '8549ee7f-4def-466e-84d3-3267d2b9fe5c',
    customerReference: 'Cleveleys landscapes',
    trafficNotes: 'Not paid | 10mm no fines Paid £355 cash',
    accountNotes: 'Added by Richard Whittaker / PN25FLF | Driver app source: Richard Whittaker / PN25FLF / 2.8m3 / Yard to Thornton | A1 payment: Not paid',
    consignments: [{ consignmentId: 9550, jobId: '8549ee7f-4def-466e-84d3-3267d2b9fe5c' }],
  }];
  resp = await workerRequest('/ht/payment/8549ee7f-4def-466e-84d3-3267d2b9fe5c', {
    method: 'PATCH',
    body: JSON.stringify({ date: '2026-07-20', paymentStatus: 'paid' }),
  }, paymentEnv);
  assert.strictEqual(resp.status, 200);
  const paymentResult = await resp.json();
  assert.strictEqual(paymentResult.paymentStatus, 'Paid');
  assert.strictEqual(paymentResult.storedUpdated, true);
  const paymentUpsert = sandbox.__fetches.find(call => call.url.endsWith('/api/Job/UpsertJob?formId='));
  assert(paymentUpsert, 'payment update should upsert the exact matched Haultech job');
  const paymentPayload = JSON.parse(paymentUpsert.options.body);
  assert.strictEqual(paymentPayload.trafficNotes, 'Paid | 10mm no fines Paid £355 cash', 'free text containing Paid must be preserved');
  assert(paymentPayload.accountNotes.includes('A1 payment: Paid'));
  const storedPaymentRows = JSON.parse(paymentEnv.__store.get('jobs:2026-07-20'));
  assert.strictEqual(storedPaymentRows[0].paymentStatus, 'paid');
  assert.strictEqual(storedPaymentRows[0].a1PaymentStatus, 'paid');
  assert.strictEqual(storedPaymentRows[0].notes, 'Paid | 10mm no fines Paid £355 cash');
  assert.strictEqual(storedPaymentRows[1].paymentStatus, 'not_paid', 'another 10mm no-fines job must not be changed');
  assert.strictEqual(storedPaymentRows[1].notes, 'Not paid | Hosk resin 10mm no fines not paid');

  sandbox.__fetches.length = 0;
  sandbox.__haultechJobs = [{
    jobId: 9556,
    id: '11111111-2222-4333-8444-555555555555',
    customerReference: 'Office-created job',
    trafficNotes: 'Not paid',
    accountNotes: 'Office entry',
    consignments: [{ consignmentId: 9556, jobId: '11111111-2222-4333-8444-555555555555' }],
  }];
  resp = await workerRequest('/ht/payment/11111111-2222-4333-8444-555555555555', {
    method: 'PATCH',
    body: JSON.stringify({ date: '2026-07-20', paymentStatus: 'paid' }),
  }, paymentEnv);
  assert.strictEqual(resp.status, 403, 'payment endpoint must reject office-created jobs');
  assert.strictEqual((await resp.json()).error, 'payment_update_not_driver_added');
  assert(!sandbox.__fetches.some(call => call.url.endsWith('/api/Job/UpsertJob?formId=')), 'rejected job must not be upserted');
  sandbox.__haultechJobs = [];

  const yardPaymentJob = {
    jobId: 9641,
    id: '22222222-3333-4444-8555-666666666666',
    customerReference: 'Paul Wright',
    trafficNotes: 'Internal Yard ticket ref: YARD-20260723-080146-D5E9 | Existing note',
    accountNotes: 'Office entry',
    quotedPrice: 153.2,
    totalPrice: 153.2,
    status: 'Completed',
    consignments: [{ consignmentId: 9641, jobId: '22222222-3333-4444-8555-666666666666' }],
  };
  sandbox.__fetches.length = 0;
  sandbox.__haultechJobs = [yardPaymentJob];
  resp = await workerRequest('/ht/yard-payment', {
    method: 'PATCH',
    headers: { 'X-PMG-Admin-Key': 'admin-key' },
    body: JSON.stringify({
      date: '2026-07-23',
      ticketRef: 'YARD-20260723-080146-D5E9',
      paymentStatus: 'paid',
    }),
  }, paymentEnv);
  assert.strictEqual(resp.status, 200);
  const yardPaymentResult = await resp.json();
  assert.strictEqual(yardPaymentResult.matches, 1);
  const yardPaymentUpsert = sandbox.__fetches.find(call => call.url.endsWith('/api/Job/UpsertJob?formId='));
  assert(yardPaymentUpsert, 'retrospective Yard payment should upsert the exact internal ticket match');
  const yardPaymentPayload = JSON.parse(yardPaymentUpsert.options.body);
  assert.strictEqual(yardPaymentPayload.trafficNotes, 'Paid | Internal Yard ticket ref: YARD-20260723-080146-D5E9 | Existing note');
  assert.strictEqual(yardPaymentPayload.accountNotes, 'Office entry | Yard payment: Paid');
  assert.strictEqual(yardPaymentPayload.quotedPrice, 153.2, 'Yard payment must preserve quoted price');
  assert.strictEqual(yardPaymentPayload.totalPrice, 153.2, 'Yard payment must preserve total price');
  assert.strictEqual(yardPaymentPayload.status, 'Completed', 'Yard payment must preserve job status');

  sandbox.__fetches.length = 0;
  resp = await workerRequest('/ht/yard-payment', {
    method: 'PATCH',
    headers: { 'X-PMG-Admin-Key': 'admin-key' },
    body: JSON.stringify({
      date: '2026-07-23',
      ticketRef: 'YARD-20260723-NOT-THERE',
      paymentStatus: 'paid',
    }),
  }, paymentEnv);
  assert.strictEqual(resp.status, 404, 'missing exact Yard ticket reference must fail closed');
  assert(!sandbox.__fetches.some(call => call.url.endsWith('/api/Job/UpsertJob?formId=')), 'missing match must not upsert any Haultech job');

  resp = await workerRequest('/ht/yard-payment', {
    method: 'PATCH',
    body: JSON.stringify({date: '2026-07-23', ticketRef: 'YARD-20260723-080146-D5E9', paymentStatus: 'paid'}),
  }, paymentEnv);
  assert.strictEqual(resp.status, 403, 'Yard payment route must require the admin key');
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
  assert(!JSON.stringify(localOnlyPayload).toLowerCase().includes('local-1781192374242'), 'a legacy ticket number alone must not be treated as a durable movement id');
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
  assert(fallbackPayload.accountNotes.includes('Driver movement: driver-fallback-1'));
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
  const addressedServiceBindingCallsBefore = sandbox.__serviceBindingCalls;
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({
      id: 'driver-concrete-addressed-1',
      date: '2026-07-30',
      customer: 'Customer One',
      driver: 'Ian Slater',
      vehicle: 'PN25FLF',
      material: 'Concrete',
      concreteType: 'quarried',
      quantity: 4,
      unit: 'm3',
      from: 'PM Groundworks Yard',
      to: 'High View, Hambleton',
      deliveryAddress: {
        line1: 'High View',
        line2: 'Sower Carr Lane',
        line3: 'Hambleton',
        line4: 'Lancashire',
        postcode: 'fy69dj',
        country: 'United Kingdom',
        formattedAddress: 'High View, Sower Carr Lane, Hambleton, FY6 9DJ',
        placeId: 'ChIJ-test-place',
      },
      wagonVisits: 1,
      chargeableWaitingMinutes: 0,
      specialAccess: false,
      ticketNo: 'ROUTE-PRICE',
    }),
  });
  assert.strictEqual(resp.status, 200);
  const routePriceCall = sandbox.__fetches.find(call => call.url.includes('/api/quote'));
  assert(routePriceCall, 'structured concrete delivery must use the shared concrete pricing API');
  assert.strictEqual(sandbox.__serviceBindingCalls - addressedServiceBindingCallsBefore, 1, 'driver-added postcode pricing must use the calculator service binding');
  const routePriceInput = JSON.parse(routePriceCall.options.body);
  assert.strictEqual(routePriceInput.postcode, 'FY6 9DJ');
  assert.strictEqual(routePriceInput.concreteSource, 'quarried');
  const addressedPayloadCall = sandbox.__fetches.find(call => call.url.endsWith('/api/Job/UpsertJob?formId='));
  const addressedPayload = JSON.parse(addressedPayloadCall.options.body);
  assert.strictEqual(addressedPayload.quotedPrice, 555);
  assert.strictEqual(addressedPayload.consignments[0].deliveryAddressLine1, 'High View');
  assert.strictEqual(addressedPayload.consignments[0].deliveryAddressLine2, 'Sower Carr Lane');
  assert.strictEqual(addressedPayload.consignments[0].deliveryPostcode, 'FY6 9DJ');
  assert(addressedPayload.accountNotes.includes('Auto-priced quarried concrete to FY6 9DJ'));

  sandbox.__fetches.length = 0;
  resp = await workerRequest('/ht/driver-add', {
    method: 'POST',
    body: JSON.stringify({
      id: 'driver-concrete-internal-pmg',
      date: '2026-07-30',
      customer: 'Customer One',
      driver: 'Richard Whittaker',
      vehicle: 'PN25FLF',
      material: 'Concrete',
      concreteType: 'recycled',
      quantity: 4,
      unit: 'm3',
      to: 'PMG Bispham site',
      reference: 'PMG INTERNAL BISPHAM',
    }),
  });
  assert.strictEqual(resp.status, 200);
  const internalConcretePayloadCall = sandbox.__fetches.find(call => call.url.endsWith('/api/Job/UpsertJob?formId='));
  const internalConcretePayload = JSON.parse(internalConcretePayloadCall.options.body);
  assert.strictEqual(internalConcretePayload.quotedPrice, 160);
  assert.strictEqual(internalConcretePayload.useQuotedPrice, true);
  assert(internalConcretePayload.accountNotes.includes('internal PM Groundworks concrete saving'));
  assert(!sandbox.__fetches.some(call => call.url.includes('/api/quote')), 'PMG own-site concrete must not use external route pricing');

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

  sandbox.__haultechCustomers = [
    { id: '529827d7-2caf-414e-8ced-101832aafdd7', companyName: 'Garstang Ground Services Ltd', customerCode: 'GGSLTD', active: true },
    { id: 'f3504eff-30f2-48f8-a10b-87ffc9923cea', companyName: 'P. Baker Groundworks', customerCode: 'PB Groundworks', active: true },
    { id: 'a1d6a399-4dda-4205-9383-f459669c381c', companyName: 'Resource Recycling Solutions', customerCode: 'Duncan Clitheroe', active: true },
  ];
  const aliasedCustomers = await sandbox.fetchLiveHaultechCustomers(env());
  const aliasesByName = Object.fromEntries(aliasedCustomers.map(customer => [customer.name, customer.aliases]));
  assert(aliasesByName['Garstang Ground Services Ltd'].includes('Garstang Grab'));
  assert(aliasesByName['P. Baker Groundworks'].includes('PB Groundworks'));
  assert(aliasesByName['Resource Recycling Solutions'].includes('RRS'));
  assert(aliasesByName['Resource Recycling Solutions'].includes('Duncan'));

  console.log('worker admin gate regression checks passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
