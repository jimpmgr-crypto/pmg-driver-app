const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
const swJs = fs.readFileSync(path.join(projectRoot, 'sw.js'), 'utf8');
const appVersion = JSON.parse(fs.readFileSync(path.join(projectRoot, 'app-version.json'), 'utf8'));

const addFormStart = indexHtml.indexOf("$('add-job-form').addEventListener('submit'");
const addFormEnd = indexHtml.indexOf('// ══════════════════════════════════════════════════════════════════════════════', addFormStart);
assert(addFormStart > 0, 'add-job form submit handler not found');
assert(addFormEnd > addFormStart, 'add-job form submit handler end not found');

const addFormHandler = indexHtml.slice(addFormStart, addFormEnd);
assert(
  !addFormHandler.includes("api('/ht/upsert'") && !addFormHandler.includes('api("/ht/upsert"'),
  'driver-created rows must not call /ht/upsert from the frontend'
);
assert(
  addFormHandler.includes("api('/ht/driver-add'") || addFormHandler.includes('api("/ht/driver-add"'),
  'driver-created rows should call the restricted /ht/driver-add worker endpoint'
);
assert(
  indexHtml.includes("const DRIVER_ADDED_LIVE_REASON = 'Driver-added row written to Haultech; PMG local copy kept as backup'"),
  'driver-created rows should define a live Haultech write reason'
);
assert(
  indexHtml.includes("const DRIVER_ADDED_BACKUP_REASON = 'Driver-added row saved locally; Haultech backup uploader will retry'"),
  'driver-created rows should define a backup retry reason'
);
assert(
  addFormHandler.includes('reason: haultechReason'),
  'driver-created rows should record the actual Haultech write or backup reason'
);
assert(
  addFormHandler.includes("toast(haultechWriteState === 'written' ? 'Row saved to Haultech'"),
  'driver-created rows should confirm live Haultech writes to the driver'
);
assert(
  !addFormHandler.includes('Select a customer from the list'),
  'office-review rows should not require a live Haultech customer-id match'
);

const cloudPutStart = indexHtml.indexOf('async function cloudPutJobs');
const cloudPutEnd = indexHtml.indexOf('function getRetryQueue', cloudPutStart);
assert(cloudPutStart > 0 && cloudPutEnd > cloudPutStart, 'cloudPutJobs function not found');
const cloudPutJobs = indexHtml.slice(cloudPutStart, cloudPutEnd);
assert(
  cloudPutJobs.includes("WORKER_URL + '/jobs/' + date"),
  'driver-created office-review rows must back up to the canonical /jobs/{date} route'
);
assert(
  !cloudPutJobs.includes("WORKER_URL + '/haultech-jobs/' + date"),
  'cloudPutJobs must not write to the read-only /haultech-jobs diary fallback route'
);
assert(
  indexHtml.includes('function driverReviewBackupJobs(jobs)'),
  'cloud backup should filter to driver-added office-review rows'
);

const buildMatch = indexHtml.match(/const APP_BUILD_ID = '([^']+)'/);
const cacheMatch = swJs.match(/const CACHE_NAME = 'pmg-driver-live-([^']+)'/);
assert(buildMatch, 'APP_BUILD_ID not found');
assert(cacheMatch, 'service-worker cache build id not found');
assert.strictEqual(buildMatch[1], appVersion.buildId, 'index build id must match app-version.json');
assert.strictEqual(cacheMatch[1], `v${appVersion.buildId}`, 'service-worker cache id must match app-version.json');
assert(
  indexHtml.includes('"843a4757-786b-4d67-bc3c-c3b1e563c2fa": "Andrews Paving and Landscaping Limited"'),
  'Andre business customer id must resolve to Andrews Paving and Landscaping Limited'
);
assert(
  indexHtml.includes('Array.isArray(c.aliases)'),
  'customer search must include worker-provided aliases such as Andre'
);
assert(
  indexHtml.includes('show-customer-list-btn') && indexHtml.includes('Show Haultech customers'),
  'driver add form must expose a visible Haultech customer picker button'
);
assert(
  indexHtml.includes('function renderCustomerDropdown') && indexHtml.includes('function findCustomerMatches'),
  'driver customer picker must support both browse and search'
);

console.log('driver-added row office-review regression checks passed');
