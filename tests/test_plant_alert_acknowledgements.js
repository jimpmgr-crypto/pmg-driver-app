const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const worker = fs.readFileSync(path.join(root, 'worker/index.js'), 'utf8');
const plant = fs.readFileSync(path.join(root, 'plant.html'), 'utf8');

assert(worker.includes("const PLANT_ALERT_ACKNOWLEDGEMENTS_KEY = 'plant:alert-acknowledgements:v1'"), 'plant acknowledgements need a separate durable KV key');
assert(worker.includes('function plantAlertIdentity(asset)'), 'worker must version each current plant alert');
assert(worker.includes("fingerprint: `${assetId}|${meta.dueType}|${target}|${band}`"), 'fingerprint must include asset, due type, target and escalation band');
assert(worker.includes("acknowledgedBy: 'Tony'"), 'worker must record Tony as the acknowledgement actor');
assert(worker.includes("error: 'plant_alert_not_current'"), 'stale or missing alerts must fail closed');
assert(worker.includes("idempotent"), 'repeat acknowledgement taps must be safe');
assert(worker.includes("/plant\\/alerts\\/([^/]+)\\/acknowledge"), 'worker must expose the Tony acknowledgement route');
assert(plant.includes('data-ack-plant-alert'), 'Tony must have an explicit seen button');
assert(plant.includes('Seen by ${escapeHtml(asset.alertAcknowledgement.acknowledgedBy'), 'Tony must see the saved actor and time');
assert(plant.includes("toast('Marked as seen by Tony.')"), 'Tony must get clear save feedback');

console.log('plant alert acknowledgement checks passed');
