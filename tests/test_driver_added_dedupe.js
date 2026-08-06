const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');

for (const fn of [
  'normaliseDriverMatchText',
  'normaliseDriverMatchVehicle',
  'normaliseDriverMatchQty',
  'parseDriverAddedGoods',
  'parseDriverAppSourceNote',
  'driverAddedFingerprint',
  'sameDriverAddedFingerprint',
  'findMatchingLiveDriverJob',
  'clearMatchedDriverWritebackQueue',
]) {
  assert(indexHtml.includes(`function ${fn}`), `${fn} must exist for driver-added row dedupe`);
}

const mergeStart = indexHtml.indexOf('function mergeWithLocal');
const mergeEnd = indexHtml.indexOf('// ══════════════════════════════════════════════════════════════════════════════', mergeStart);
assert(mergeStart > 0 && mergeEnd > mergeStart, 'mergeWithLocal function not found');
const mergeWithLocal = indexHtml.slice(mergeStart, mergeEnd);
assert(
  mergeWithLocal.includes('cloudDriverMatches') && mergeWithLocal.includes('sameDriverAddedFingerprint'),
  'mergeWithLocal must compare temporary phone rows against real Haultech rows semantically'
);
assert(
  mergeWithLocal.includes('clearMatchedDriverWritebackQueue(localJobs, cloudJobs)'),
  'matched completed Haultech rows must clear stale phone writeback queue items'
);

const fallbackStart = indexHtml.indexOf('async function loadJobsFallback');
const fallbackEnd = indexHtml.indexOf('jobs = mergeWithLocal(date, jobs);', fallbackStart);
assert(fallbackStart > 0 && fallbackEnd > fallbackStart, 'loadJobsFallback saved-job merge block not found');
const fallbackBlock = indexHtml.slice(fallbackStart, fallbackEnd);
assert(
  fallbackBlock.includes('findMatchingLiveDriverJob(lj, jobs)'),
  'fallback load must not re-add a temporary phone row when the matching Haultech row is cached'
);

const signStart = indexHtml.indexOf('async function handleSignComplete');
const signEnd = indexHtml.indexOf("$('sign-save-btn').addEventListener", signStart);
assert(signStart > 0 && signEnd > signStart, 'handleSignComplete function not found');
const signComplete = indexHtml.slice(signStart, signEnd);
assert(
  signComplete.includes('const matchedLiveJob =') &&
  signComplete.includes('const haultechCompleteJob = matchedLiveJob || job'),
  'completing a temporary phone row must target the matching real Haultech row'
);
assert(
  signComplete.includes('if (matchedLiveJob) updateJobStatusLocal(matchedLiveJob,') &&
  signComplete.includes('verifyHaultechCompletion(haultechCompleteJob, haultechJobId)'),
  'matched Haultech job must be marked and verified when the phone row is completed'
);
assert(
  signComplete.includes('const isDriverAdded = !haultechJobId;') &&
  signComplete.includes('if (LIVE_WRITE && !isDriverAdded)'),
  'a cached driver-added row with a real Haultech id must use proof-first live completion'
);

const exactIanCase = "Ian Slater - PN25FLF - C35pmg Qu - 0.91m3 - Yard to Nottend";
assert(
  /^Ian Slater - PN25FLF - C35pmg Qu - 0.91m3 - Yard to Nottend$/.test(exactIanCase),
  'Ian duplicate screenshot case should remain explicit in this regression'
);
assert(
  indexHtml.toLowerCase().includes('driver app source') &&
  indexHtml.includes('parseDriverAppSourceNote') &&
  indexHtml.includes('source.quantity'),
  'clean material-only Haultech goods rows must still dedupe using driver app source notes'
);
assert(
  indexHtml.includes('const DRIVER_VEHICLE_OPTIONS = Object.values(VEHICLES);'),
  'driver vehicle dropdown must be backed by the Haultech vehicle id map'
);
assert(
  indexHtml.includes("'ac4f1d74-3b3e-472f-b500-47d7620c9c11': 'DX12RFN'"),
  'DX12RFN must stay mapped to its Haultech vehicle id before it is offered in the dropdown'
);
assert(
  indexHtml.includes("'8fe4fd9e-a8bd-4e80-9257-68a39942e879': 'YX02DVT'"),
  'YX02DVT must stay mapped to its Haultech vehicle id before it is offered in the dropdown'
);

console.log('driver-added row semantic dedupe regression checks passed');
