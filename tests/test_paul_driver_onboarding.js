const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const index = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(projectRoot, 'worker/index.js'), 'utf8');
const redirects = fs.readFileSync(path.join(projectRoot, '_redirects'), 'utf8');

const paulId = '2b5eab8a-0602-47b8-b242-28ef37eb6c2d';

assert(
  index.includes(`paul:    { pin: '2580', driverId: '${paulId}', name: 'Paul Locket' }`),
  'Paul must have the agreed PIN and exact live Haultech driver identity'
);
assert(
  worker.includes(`'paul locket': '${paulId}'`),
  'worker driver mapping must match the frontend and live Haultech record'
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
  'Paul must retain the shared all-rounder vehicle list rather than a fixed wagon'
);

console.log('Paul driver onboarding regression checks passed');
