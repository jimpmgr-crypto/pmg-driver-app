const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectRoot = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');

function extractFunction(name, nextName) {
  const start = indexHtml.indexOf(`function ${name}`);
  const end = indexHtml.indexOf(`function ${nextName}`, start + 1);
  assert(start >= 0 && end > start, `${name} function not found`);
  return indexHtml.slice(start, end);
}

const source = [
  extractFunction('numberOrInfinity', 'getJobRouteOrder'),
  extractFunction('getJobRouteOrder', 'getJobLoadNumber'),
  extractFunction('getJobLoadNumber', 'getJobSortTime'),
  extractFunction('getJobSortTime', 'getJobStableNumber'),
  extractFunction('getJobStableNumber', 'getJobHaultechOrder'),
  extractFunction('getJobHaultechOrder', 'sortJobsForDriver'),
  extractFunction('sortJobsForDriver', 'getJobPrice'),
].join('\n');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

function plannedJob(jobId, apiOrder, hiddenSeconds) {
  return {
    jobId,
    deliveryLoadNumber: 2095,
    deliveryStartTime: `2026-08-10T07:00:${hiddenSeconds}.000Z`,
    _haultechOrder: apiOrder,
    consignments: [{ deliveryDropNumber: 0, collectionDropNumber: 0 }],
  };
}

// Live evidence from Paul Locket's 10 August load: the Haultech API returns
// Richard's planned order, while the hidden timestamps run in the opposite
// direction and must not reshuffle the driver's work.
const paulLoad = [
  plannedJob(10015, 8, 40),
  plannedJob(10016, 9, 39),
  plannedJob(10017, 10, 26),
  plannedJob(10018, 11, 22),
  plannedJob(10020, 13, 12),
];
assert.deepStrictEqual(
  Array.from(sandbox.sortJobsForDriver(paulLoad), job => job.jobId),
  [10015, 10016, 10017, 10018, 10020],
  'driver order must preserve Haultech sequence rather than hidden timestamps'
);

const withDriverAdded = [
  { id: 'driver-1', _driverAdded: true, savedAt: '2026-08-10T06:00:00Z' },
  ...paulLoad,
];
assert.strictEqual(
  sandbox.sortJobsForDriver(withDriverAdded).at(-1).id,
  'driver-1',
  'phone-added rows must remain after the official Haultech plan'
);

const fallbackRows = [
  { jobId: 3, deliveryLoadNumber: 2, deliveryStartTime: '2026-08-10T09:00:00Z', consignments: [{}] },
  { jobId: 2, deliveryLoadNumber: 1, deliveryStartTime: '2026-08-10T08:00:00Z', consignments: [{}] },
];
assert.deepStrictEqual(
  Array.from(sandbox.sortJobsForDriver(fallbackRows), job => job.jobId),
  [2, 3],
  'legacy rows without source order must keep deterministic fallback sorting'
);

for (const required of [
  '_haultechOrder: haultechOrder',
  'haultechOrder: getJobHaultechOrder(j)',
  '_haultechOrder: lj.haultechOrder',
]) {
  assert(indexHtml.includes(required), `offline order persistence missing: ${required}`);
}

console.log('Haultech planned job order regression checks passed');
