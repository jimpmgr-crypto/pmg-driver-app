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

// Historical all-zero fallback evidence from Paul Locket's 10 August load: the Haultech API returns
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

// 27 October live loads: API positions run opposite to persisted drop order.
function deliveryJob(jobId, load, route, apiOrder) {
  return {jobId,deliveryLoadNumber:load,_haultechOrder:apiOrder,
    consignments:[{delivery:true,collection:false,deliveryDropNumber:route,collectionDropNumber:0}]};
}
const october = [deliveryJob(11834,2414,4,0),deliveryJob(11838,2414,3,4),deliveryJob(11839,2414,2,5),deliveryJob(11840,2414,1,6),deliveryJob(11841,2414,0,7)];
assert.deepStrictEqual(Array.from(sandbox.sortJobsForDriver(october),j=>j.jobId),[11841,11840,11839,11838,11834]);
const secondLoad = [deliveryJob(11835,2415,3,1),deliveryJob(11836,2415,2,2),deliveryJob(11837,2415,1,3),deliveryJob(11842,2415,0,8)];
assert.deepStrictEqual(Array.from(sandbox.sortJobsForDriver(secondLoad),j=>j.jobId),[11842,11837,11836,11835]);
const refreshed = october.map(j=>({...j,consignments:j.consignments.map(c=>({...c,deliveryDropNumber:4-c.deliveryDropNumber}))}));
assert.deepStrictEqual(Array.from(sandbox.sortJobsForDriver(refreshed),j=>j.jobId),[11834,11838,11839,11840,11841], 'new saved office drops must replace old order');
assert.deepStrictEqual(Array.from(sandbox.sortJobsForDriver([...secondLoad,...october]),j=>j.jobId),[11841,11840,11839,11838,11834,11842,11837,11836,11835]);
const cached = october.map(j=>JSON.parse(JSON.stringify({jobId:j.jobId,_cached:true,_loadNumber:sandbox.getJobLoadNumber(j),_routeOrder:sandbox.getJobRouteOrder(j),_haultechOrder:j._haultechOrder})));
assert.deepStrictEqual(Array.from(sandbox.sortJobsForDriver(cached),j=>j.jobId),[11841,11840,11839,11838,11834]);
for (const val of [null,undefined,'',false,-1,0.5]) assert.equal(sandbox.getJobRouteOrder({_cached:true,_routeOrder:val}),Infinity,'invalid cached drops must not become zero');
assert.equal(sandbox.getJobRouteOrder({_cached:true,_routeOrder:0}),0);
const collection = [2,0,1].map((n,i)=>({jobId:n,collectionLoadNumber:10,_haultechOrder:i,consignments:[{collection:true,delivery:false,collectionDropNumber:n,deliveryDropNumber:0}]}));
assert.deepStrictEqual(Array.from(sandbox.sortJobsForDriver(collection),j=>j.jobId),[0,1,2],'unused delivery zero must not override collection sequence');
assert.equal(sandbox.getJobRouteOrder({deliveryLoadNumber:1,consignments:[{delivery:true,deliveryDropNumber:3},{delivery:true,deliveryDropNumber:1}]}),1,'multi-consignment earliest active drop');
assert.deepStrictEqual(Array.from(sandbox.sortJobsForDriver([{jobId:99,_driverAdded:true},...october]),j=>j.jobId),[11841,11840,11839,11838,11834,99]);
assert(indexHtml.includes('_routeOrder: row.routeOrder ?? row._routeOrder'),'every cached projection must keep drop including zero');
assert(indexHtml.includes('_loadNumber: row.loadNumber ?? row._loadNumber'),'every cached projection must keep load');
console.log('PASS live 27 October reverse sequences, zero first, refresh, cache, invalid values, collection-only, multiple loads/consignments and driver-added rows');
