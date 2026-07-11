const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectRoot = path.resolve(__dirname, '..');
const workerPath = path.join(projectRoot, 'worker', 'index.js');
const workerSource = fs.readFileSync(workerPath, 'utf8');
const exportIndex = workerSource.indexOf('export default');

assert(exportIndex > 0, 'worker export default block not found');

const sandbox = {
  TextEncoder,
  TextDecoder,
  btoa: value => Buffer.from(value, 'binary').toString('base64'),
  atob: value => Buffer.from(value, 'base64').toString('binary'),
  console,
  Date,
  URL,
  URLSearchParams,
};

vm.runInNewContext(
  `${workerSource.slice(0, exportIndex)}
globalThis.__plantTest = {
  categoryFromPlantServiceType,
  mergePlantData,
  plantEventHasScheduleUpdate,
  isWheelTorqueRequiredEvent,
  torqueNmFromEvent,
  isVehicleAsset,
};`,
  sandbox
);

const { categoryFromPlantServiceType, mergePlantData, plantEventHasScheduleUpdate, isWheelTorqueRequiredEvent, torqueNmFromEvent, isVehicleAsset } = sandbox.__plantTest;

function plant79(overrides = {}) {
  return {
    id: 'plant-79',
    plantNumber: '79',
    displayName: 'Plant 79 - Kubota K008-3',
    machineType: 'Kubota K008-3',
    lastServiceDate: '2025-01-12',
    lastServiceHours: 2156,
    lastKnownHours: 2156,
    nextServiceDueDate: '2026-01-12',
    nextServiceDueBasis: '12_month_service_rule',
    nextServiceDueHours: 2656,
    scheduleNotes: [],
    sources: [],
    ...overrides,
  };
}

function snapshot(asset = plant79()) {
  return {
    schema: 'pmg-plant-state-v1',
    stats: {},
    assets: [asset],
    history: [],
    reviewItems: [],
    filterParts: {},
  };
}

function mergedPlant(event, asset = plant79()) {
  return mergePlantData(snapshot(asset), [event], {}, {}).assets.find(item => item.id === 'plant-79');
}

assert.strictEqual(categoryFromPlantServiceType('Service schedule review'), 'inspection');
assert.strictEqual(categoryFromPlantServiceType('Wheel off - torque re-check required'), 'inspection');
assert.strictEqual(
  plantEventHasScheduleUpdate({ nextDueDate: '2026-10-19', nextDueHours: 2988 }),
  true
);
assert.strictEqual(plantEventHasScheduleUpdate({ nextDueMileage: 84200 }), true);
assert.strictEqual(isWheelTorqueRequiredEvent({ serviceType: 'Wheel off - torque re-check required' }), true);
assert.strictEqual(torqueNmFromEvent({ serviceType: 'Wheel off - torque re-check required', torqueNm: 625 }), 625);
assert.strictEqual(isVehicleAsset({ registration: 'BT15 LFB', machineType: 'Ford Transit' }), true);

const scheduleReview = mergedPlant({
  id: 'manual-test-schedule-review',
  assetId: 'plant-79',
  plantNumber: '79',
  date: '2026-06-08',
  category: 'inspection',
  serviceType: 'Service schedule review',
  hours: 2660,
  nextDueDate: '2026-10-19',
  nextDueDateBasis: 'manual',
  nextDueHours: 2988,
  createdAt: '2026-06-08T15:17:00Z',
});

assert.strictEqual(scheduleReview.lastServiceDate, '2025-01-12');
assert.strictEqual(scheduleReview.lastInspectionDate, '2026-06-08');
assert.strictEqual(scheduleReview.lastServiceScheduleReviewDate, '2026-06-08');
assert.strictEqual(scheduleReview.lastKnownHours, 2660);
assert.strictEqual(scheduleReview.nextServiceDueDate, '2026-10-19');
assert.strictEqual(scheduleReview.nextServiceDueBasis, 'manual');
assert.strictEqual(scheduleReview.nextServiceDueHours, 2988);
assert.notStrictEqual(scheduleReview.dueStatus, 'overdue');

const ordinaryInspection = mergedPlant({
  id: 'manual-test-inspection',
  assetId: 'plant-79',
  plantNumber: '79',
  date: '2026-06-08',
  category: 'inspection',
  serviceType: 'Inspection',
  hours: 2660,
  nextDueDate: '',
  nextDueHours: null,
  createdAt: '2026-06-08T15:17:00Z',
});

assert.strictEqual(ordinaryInspection.lastServiceDate, '2025-01-12');
assert.strictEqual(ordinaryInspection.nextServiceDueDate, '2026-01-12');
assert.strictEqual(ordinaryInspection.nextServiceDueHours, 2656);

const dateOnlyFullService = mergedPlant({
  id: 'manual-test-date-only-service',
  assetId: 'plant-79',
  plantNumber: '79',
  date: '2026-06-08',
  category: 'service',
  serviceType: 'Full service',
  hours: null,
  nextDueDate: '2027-06-08',
  nextDueDateBasis: '12_month_service_rule',
  nextDueHours: null,
  createdAt: '2026-06-08T15:17:00Z',
});

assert.strictEqual(dateOnlyFullService.lastServiceDate, '2026-06-08');
assert.strictEqual(dateOnlyFullService.nextServiceDueDate, '2027-06-08');
assert.strictEqual(Object.prototype.hasOwnProperty.call(dateOnlyFullService, 'nextServiceDueHours'), false);

const vehicleAsset = {
  id: 'vehicle-bt15lfb',
  plantNumber: 'BT15LFB',
  registration: 'BT15LFB',
  assetType: 'vehicle',
  displayName: 'BT15 LFB - Ford Transit',
  machineType: 'Ford Transit',
  scheduleNotes: [],
  sources: [],
};
const vehicleMerged = mergePlantData(snapshot(vehicleAsset), [{
  id: 'manual-test-vehicle-service',
  assetId: 'vehicle-bt15lfb',
  plantNumber: 'BT15LFB',
  registration: 'BT15LFB',
  date: '2026-06-10',
  category: 'service',
  serviceType: 'Pre-MOT service',
  mileage: 74200,
  nextDueDate: '2027-06-10',
  nextDueDateBasis: '12_month_service_rule',
  nextDueMileage: 84200,
  nextServiceIntervalMiles: 10000,
  createdAt: '2026-06-10T15:30:00Z',
}], {}, {}).assets.find(item => item.id === 'vehicle-bt15lfb');

assert.strictEqual(vehicleMerged.lastKnownMileage, 74200);
assert.strictEqual(vehicleMerged.lastServiceMileage, 74200);
assert.strictEqual(vehicleMerged.nextServiceDueMileage, 84200);
assert.strictEqual(Object.prototype.hasOwnProperty.call(vehicleMerged, 'lastServiceHours'), false);

const plantHtml = fs.readFileSync(path.join(projectRoot, 'plant.html'), 'utf8');
assert(plantHtml.includes('<option>Service schedule review</option>'));
assert(plantHtml.includes('<option>Wheel off - torque re-check required</option>'));
assert(plantHtml.includes('name="torqueNm"'));
assert(plantHtml.includes('Current hours at service'));
assert(plantHtml.includes('Current mileage / odometer'));
assert(plantHtml.includes('Used for the 500-hour reminder.'));
assert(plantHtml.includes('10,000-mile service reminder'));
assert(plantHtml.includes('Whichever comes first:'));
assert(plantHtml.includes('Save date-only service and skip the 500-hour reminder'));
assert(plantHtml.includes('Save date-only service and skip the 10,000-mile reminder'));
assert(plantHtml.includes('function eventHasScheduleUpdate'));

console.log('plant schedule review regression checks passed');
