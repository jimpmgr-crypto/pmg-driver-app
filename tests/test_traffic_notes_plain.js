const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
const workerSource = fs.readFileSync(path.join(projectRoot, 'worker', 'index.js'), 'utf8');

assert(
  indexHtml.includes('placeholder="Needed by the office for payment, e.g. Phil Smith"'),
  'reference field should make clear that a typed person/site name is valid'
);

const composeStart = indexHtml.indexOf('function composeDriverHaultechNote');
const composeEnd = indexHtml.indexOf('function formatDate', composeStart);
assert(composeStart > 0 && composeEnd > composeStart, 'composeDriverHaultechNote function not found');
const compose = indexHtml.slice(composeStart, composeEnd);
for (const forbidden of ['Driver note:', 'Reason:', 'Note:', 'Consignee/customer:', 'Qty:']) {
  assert(!compose.includes(forbidden), `frontend traffic note composer must not add ${forbidden}`);
}
assert(compose.includes('Signed by '), 'signature/customer text should stay human-readable when included');

const normaliseStart = workerSource.indexOf('function normaliseDriverAddedUpsertPayload');
const normaliseEnd = workerSource.indexOf('function normalisedLookupText', normaliseStart);
assert(normaliseStart > 0 && normaliseEnd > normaliseStart, 'normaliseDriverAddedUpsertPayload function not found');
const normalise = workerSource.slice(normaliseStart, normaliseEnd);
assert(
  !normalise.includes('cleaned.trafficNotes = trafficNotes ? `${stamp} | ${trafficNotes}` : stamp'),
  'worker must not stamp Added by/source text into traffic notes'
);

const referenceRepairStart = workerSource.indexOf('function applyTypedCustomerToDriverAddedReference');
const referenceRepairEnd = workerSource.indexOf('function applyDriverQuantityToHaultechJob', referenceRepairStart);
assert(referenceRepairStart > 0 && referenceRepairEnd > referenceRepairStart, 'reference repair function not found');
const referenceRepair = workerSource.slice(referenceRepairStart, referenceRepairEnd);
assert(
  !referenceRepair.includes('trafficNotes: mergePlainNoteText'),
  'typed customer/site should not be added to traffic notes by reference repair'
);

const driverAddStart = workerSource.indexOf('async function buildDriverAddedHaultechPayload');
const driverAddEnd = workerSource.indexOf('function cleanMultiline', driverAddStart);
assert(driverAddStart > 0 && driverAddEnd > driverAddStart, 'buildDriverAddedHaultechPayload function not found');
const driverAdd = workerSource.slice(driverAddStart, driverAddEnd);
assert(
  driverAdd.includes('trafficParts.push(a1PaymentStatus)'),
  'A1 paid/not-paid value should be included in invoicing-visible traffic notes'
);
assert(
  !driverAdd.includes('trafficParts.push(`A1 payment:'),
  'traffic notes should contain Paid/Not paid, not the A1 payment account-note label'
);

console.log('plain traffic-note, A1 payment and reference-label regression checks passed');
