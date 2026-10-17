const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../worker/index.js'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const customers = [
  { id: 'account-a', name: 'Same Trading Ltd', active: true },
  { id: 'account-b', name: 'Same Trading Ltd', code: 'ST2', aliases: ['Second account'], active: true },
  { id: 'cash-account', name: 'A1', active: true },
  { id: 'closed-account', name: 'Closed Ltd', active: false },
];
const context = {
  cleanText: (v, max = 9999) => String(v ?? '').trim().slice(0, max),
  normalisedLookupText: v => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' '),
  safeArray: v => Array.isArray(v) ? v : [],
  maybeIsoDate: v => v,
  driverAddedQuantityAndUnit: () => ({ quantity: 1, unit: 't' }),
  collectedConcreteQuote: () => null,
  normaliseStructuredAddress: (_body, _mode, line1) => ({ line1 }),
  cleanDriverAddedReference: v => String(v ?? ''),
  cleanDriverNote: v => String(v ?? ''),
  isA1CustomerName: v => v === 'A1',
  normaliseA1PaymentStatus: () => '',
  getKvJson: async () => customers,
  HAULTECH_CUSTOMERS_KEY: 'test-customers',
  driverAddedFallbackReference: () => 'test-reference',
  driverAddedCustomerReference: ref => ref,
  driverAddedQuotedPrice: async () => ({ quotedPrice: 0, useQuotedPrice: false }),
  driverAddedSourceNote: () => '',
  normaliseDriverAddedMaterialLabel: v => v,
  normaliseConcreteType: () => '',
  normaliseDriverAddedUpsertPayload: v => v,
  YARD_ADDRESS: { line1: 'Test Yard' }, JOB_TYPE_STD: 'test-type', SERVICE_LEVEL_STD: 'test-service',
};
vm.createContext(context);
vm.runInContext(section('function findCustomerMatch(', 'function firstConsignment('), context);
vm.runInContext(section('async function buildDriverAddedHaultechPayload(', 'function cleanMultiline('), context);
let cases = 0;
function run(name, fn) { fn(); cases++; }
const pick = (id, name = 'Same Trading Ltd', rows = customers) =>
  context.resolveDriverAddedCustomer(rows, { customerId: id }, name);
run('same-name accounts use exact selected ID', () => assert.equal(pick('account-b').customerLookup.customer.id, 'account-b'));
run('canonical ID retained after case-insensitive comparison', () => assert.equal(pick('ACCOUNT-B').customerLookup.customer.id, 'account-b'));
run('known alias allowed', () => assert.equal(pick('account-b', 'Second account').customerLookup.customer.id, 'account-b'));
run('known code allowed', () => assert.equal(pick('account-b', 'ST2').customerLookup.customer.id, 'account-b'));
run('name changed after selecting cannot reroute silently', () => assert.equal(pick('account-b', 'Different Ltd').error, 'customer_selection_conflict'));
run('unknown selection cannot fall back to A1', () => assert.equal(pick('missing').error, 'customer_selection_unavailable'));
run('inactive account rejected', () => assert.equal(pick('closed-account', 'Closed Ltd').error, 'customer_selection_unavailable'));
run('unknown active status rejected for selection', () => assert.equal(pick('account-b', 'Same Trading Ltd', [{ id: 'account-b', name: 'Same Trading Ltd' }]).error, 'customer_selection_unavailable'));
run('duplicate IDs rejected', () => assert.equal(pick('account-b', 'Same Trading Ltd', customers.concat(customers[1])).error, 'customer_selection_unavailable'));
for (const bad of [5, {}, [], '   ', 'x'.repeat(81)]) {
  run('invalid selected ID rejected', () => assert.equal(pick(bad).error, 'invalid_customer_selection'));
}
run('name-only legacy match retained', () => assert.equal(pick(undefined).customerLookup.customer.id, 'account-a'));
run('unselected unknown name retains A1 policy', () => assert.equal(pick('', 'New unlisted person').useA1Fallback, true));
run('selected A1 is not typed-name fallback', () => assert.equal(pick('cash-account', 'A1').useA1Fallback, false));
run('unavailable list cannot create job', () => assert.equal(pick('account-b', 'Same Trading Ltd', []).status, 409));
(async () => {
  const body = { date: '2026-10-17', customer: 'Same Trading Ltd', customerId: 'account-b', material: 'Stone', reference: 'Test' };
  const payload = await context.buildDriverAddedHaultechPayload({}, body);
  assert.equal(payload.payload.customerId, 'account-b'); cases++;
  const blocked = await context.buildDriverAddedHaultechPayload({}, { ...body, customerId: 'missing' });
  assert.equal(blocked.error, 'customer_selection_unavailable');
  assert.equal(blocked.payload, undefined); cases++;
  console.log(`PASS ${cases} worker customer identity cases; no network or live writes`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
