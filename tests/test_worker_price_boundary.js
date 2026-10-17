// Execute the actual Worker request handler with the existing entirely offline
// supplier fixture. No source helper is reimplemented and no network is allowed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = fs.readFileSync(path.join(__dirname, 'test_worker_upsert_admin_gate.js'), 'utf8');
const prefix = fixture.slice(0, fixture.indexOf('\n(async () => {'));
assert(prefix.length > 1000, 'expected fixture boundary');
const { upsertRequest, workerRequest, sandbox } = new Function('require', '__dirname',
  prefix + '\nreturn {upsertRequest,workerRequest,sandbox};')(require, __dirname);
let checks = 0;
async function send(body, raw = false, admin = true) {
  sandbox.__fetches.length = 0;
  sandbox.__haultechJobs = [];
  const headers = admin ? { 'X-PMG-Admin-Key': 'admin-key' } : {};
  return raw ? workerRequest('/ht/upsert', { method: 'POST', headers, body }) : upsertRequest(headers, body);
}
async function rejected(body, error, raw = false) {
  const response = await send(body, raw);
  assert(response.status === 400 || response.status === 422, `${JSON.stringify(body)} was accepted`);
  assert.equal((await response.json()).error, error);
  assert.equal(sandbox.__fetches.length, 0, 'blocked writes must not contact the supplier');
  checks++;
}
async function accepted(body, amount) {
  const response = await send(body);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(sandbox.__fetches.length, 1);
  const saved = JSON.parse(sandbox.__fetches[0].options.body);
  assert.equal(saved.quotedPrice, amount);
  assert.equal(saved.totalPrice, amount);
  assert.equal(saved.useQuotedPrice, amount !== 0);
  if (body.consignments) assert.deepEqual(saved.consignments, body.consignments);
  if (body.accountNotes) assert.equal(saved.accountNotes, body.accountNotes);
  checks++;
}
(async () => {
  for (const body of [
    { quotedPrice: 0, totalPrice: 180 }, { quotedPrice: '0', totalPrice: '180' },
    { quotedPrice: -0, price: -25 }, { totalPrice: 0, price: 180 },
    { quotedPrice: 180, totalPrice: 181 }, { quotedPrice: 180, price: 181 },
    { quotedPrice: 180, totalPrice: -180 }, { totalPrice: 180, price: 181 },
  ]) await rejected(body, 'conflicting_upsert_prices');
  for (const field of ['quotedPrice', 'totalPrice', 'price']) {
    for (const value of ['', ' ', 'bad', true, false, [], {}, '0x10', 'NaN', 'Infinity', '1e9999', '1e-9999']) {
      await rejected({ quotedPrice: 180, [field]: value }, 'invalid_upsert_price');
    }
  }
  for (const field of ['QuotedPrice', 'QUOTEDPRICE', 'TotalPrice', 'TOTALPRICE', 'Price', 'PRICE', 'UseQuotedPrice', 'USEQUOTEDPRICE']) {
    await rejected({ quotedPrice: 180, useQuotedPrice: true, [field]: field.toLowerCase() === 'usequotedprice' ? false : 0 }, 'noncanonical_upsert_price_field');
  }
  for (const useQuotedPrice of [null, '', 'false', 'true', 0, 1, {}, []]) {
    await rejected({ quotedPrice: 180, useQuotedPrice }, 'invalid_upsert_quote_flag');
  }
  for (const body of [{}, { id: 'existing', accountNotes: 'Do not default the price' }, { quotedPrice: null, totalPrice: null }]) {
    await rejected(body, 'upsert_price_required');
  }
  for (const body of ['invalid', '{', '', 'null', '[]', '123', '"180"']) {
    await rejected(body, ['invalid', '{', ''].includes(body) ? 'invalid_upsert_json' : 'invalid_upsert_object', true);
  }
  for (const body of [
    '{"quotedPrice":180,"quotedPrice":0}',
    '{"quotedPrice":180,"quoted\\u0050rice":0}',
    '{"quotedPrice":180,"consignments":[{"quantity":2,"quantity":0}]}',
  ]) await rejected(body, 'duplicate_upsert_key', true);
  await rejected('{"quotedPrice":1e9999}', 'nonfinite_upsert_value', true);
  await rejected('{"quotedPrice":180,"quantity":1e9999}', 'nonfinite_upsert_value', true);
  await rejected('{"quotedPrice":1e-9999}', 'invalid_upsert_numeric_value', true);
  await accepted({ quotedPrice: 180, totalPrice: 0, useQuotedPrice: false }, 180);
  await accepted({ quotedPrice: '180.00', totalPrice: 180, price: '180', useQuotedPrice: true }, 180);
  await accepted({ totalPrice: 180 }, 180);
  await accepted({ price: '180.50' }, 180.5);
  await accepted({ quotedPrice: null, totalPrice: 180 }, 180);
  await accepted({ quotedPrice: -25, totalPrice: 0, useQuotedPrice: false }, -25);
  await accepted({ quotedPrice: 0, totalPrice: 0, price: 0, useQuotedPrice: false }, 0);
  await accepted({ quotedPrice: '0e-9999', totalPrice: '-0.00', useQuotedPrice: true }, 0);
  await accepted({ quotedPrice: ' 180.50 ', accountNotes: 'same source note', consignments: [
    { quantity: 2, goodsDescription: 'MOT, [literal] {colon: quotedPrice}', reference: 'a' },
    { quantity: 3, reference: 'b' },
  ] }, 180.5);
  const denied = await send('{"quotedPrice":180,"quotedPrice":0}', true, false);
  assert.equal(denied.status, 403, 'admin authentication still precedes price parsing');
  assert.equal(sandbox.__fetches.length, 0);
  checks++;
  console.log(`PASS: ${checks} actual-route price-boundary cases; all rejected bodies make zero upstream calls`);
})().catch(error => { console.error(error); process.exitCode = 1; });
