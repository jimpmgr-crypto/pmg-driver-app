const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const index = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(projectRoot, 'worker/index.js'), 'utf8');
const redirects = fs.readFileSync(path.join(projectRoot, '_redirects'), 'utf8');
const postChangeCheck = fs.readFileSync(path.join(projectRoot, 'tools/driver_app_post_change_check.py'), 'utf8');

const paulId = '2b5eab8a-0602-47b8-b242-28ef37eb6c2d';

assert(!index.includes(paulId), 'Paul must not be listed as an active driver');
assert(index.includes("routeDriver === 'paul'") && index.includes("savedUser === 'paul'"),
  'Retired links and saved sessions must stop before app startup');
assert(
  worker.includes(`'paul locket': '${paulId}'`),
  'Historical Worker mapping must remain available for reconciliation'
);
assert(
  redirects.includes('/paul/app-version.json /app-version.json 200'),
  'Paul nested route must resolve version metadata without losing his route'
);
assert(
  index.includes("const VOLUMETRIC_CONCRETE_VEHICLES = new Set(['LL21HJJ', 'PN25FLF'])"),
  'both concrete wagons must remain selectable and receive the concrete workflow'
);
assert(
  index.includes('const DRIVER_VEHICLE_OPTIONS = Object.values(VEHICLES);'),
  'Active drivers retain the shared vehicle list'
);
assert(
  postChangeCheck.includes('"paul locket"'),
  'post-change reconciliation must recognise Paul as a Driver App user'
);

console.log('Retired driver and historical reconciliation checks passed');
