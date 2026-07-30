const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'worker', 'index.js'), 'utf8');
const version = JSON.parse(fs.readFileSync(path.join(root, 'app-version.json'), 'utf8'));

assert(index.includes(`const APP_BUILD_ID = '${version.buildId}'`), 'index build id must match app-version.json');
assert(index.includes("const VOLUMETRIC_CONCRETE_VEHICLES = new Set(['LL21HJJ', 'PN25FLF'])"), 'driver app must still recognise the two volumetric concrete wagons');
assert(index.includes('function isConcreteEntryCandidate'), 'driver app must require concrete type for all concrete/m3/cube rows');
assert(index.includes('id="f-concrete-type"'), 'add-row form must include concrete type selector');
assert(index.includes('id="f-wagon-visits"'), 'driver concrete form must capture wagon visits');
assert(index.includes('id="f-waiting-minutes"'), 'driver concrete form must capture chargeable waiting');
assert(index.includes('id="f-special-access"'), 'driver concrete form must flag difficult/restricted access');
assert(index.includes("toast('Choose quarried or recycled')"), 'concrete rows must require a concrete type');
assert(index.includes('concreteType,'), 'driver app must save concreteType with local rows');
assert(index.includes('deliveryAddress: selectedAddresses.to'), 'driver app must save the selected structured delivery address');
assert(index.includes("api('/address/autocomplete'"), 'driver app must request server-side address suggestions');
assert(index.includes("api('/address/details'"), 'driver app must resolve the selected address and postcode');
assert(worker.includes('const CONCRETE_RATES = {'), 'worker must define concrete rate table');
assert(worker.includes('recycled: { over3: 135, under3: 155 }'), 'worker must use Jim confirmed recycled concrete rates');
assert(worker.includes('quarried: { over3: 145, under3: 165 }'), 'worker must use Jim confirmed quarried concrete rates');
assert(worker.includes('const CONCRETE_SMALL_LOAD_THRESHOLD_M3 = 3.5;'), 'worker must use Jim confirmed 3.5m3 small-load threshold');
assert(worker.includes('useQuotedPrice: true'), 'worker auto-priced concrete rows must write quoted price');
assert(worker.includes("return '';"), 'worker must not default untyped concrete to recycled');
assert(worker.includes('extractVehicleFromText'), 'worker must recover vehicle from old Added by notes');
assert(worker.includes("path === '/address/autocomplete'"), 'worker must expose authenticated address autocomplete');
assert(worker.includes("path === '/address/details'"), 'worker must expose authenticated place detail lookup');
assert(worker.includes('env.GOOGLE_PLACES_API_KEY'), 'Google API key must remain a server-side Worker secret');
assert(!index.includes('GOOGLE_PLACES_API_KEY'), 'Google API key must never be embedded in the driver app');
assert(worker.includes('const CONCRETE_PRICE_API'), 'postcode-aware pricing must reuse the shared concrete calculator API');

console.log('volumetric concrete pricing regression checks passed');
