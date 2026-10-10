const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const repoRoot = path.resolve(__dirname, '..');
const consumers = [
  path.join(repoRoot, 'index.html'),
  path.join(repoRoot, 'worker/index.js'),
];
const marker = /\/\/ BEGIN GENERATED PMG_YARD_PRICES:COLLECTED_CONCRETE[\s\S]*?\/\/ END GENERATED PMG_YARD_PRICES:COLLECTED_CONCRETE/;

for (const file of consumers) {
  const source = fs.readFileSync(file, 'utf8');
  const block = source.match(marker);
  assert(block, `${path.relative(repoRoot, file)} is missing the collected-concrete pricing block`);

  const context = {};
  vm.createContext(context);
  vm.runInContext(block[0], context);

  for (const [name, half, one] of [['Quarried', 90, 130], ['Recycled', 80, 120]]) {
    const material = `Collected concrete - ${name}`;
    for (const [quantity, expected] of [
      [0.5, half],
      [0.6, half + 8],
      [0.75, (half + one) / 2],
      [0.9, half + 32],
      [1, one],
      [1.2, one * 1.2],
      [2.5, one * 2.5],
    ]) {
      assert.equal(context.collectedConcreteQuote(material, quantity, 'm3').amount, expected, `${file}: ${quantity} m³`);
    }
    for (const quantity of [0, 0.49, -1, NaN, Infinity]) {
      assert(context.collectedConcreteQuote(material, quantity, 'm3').error, `${file}: invalid quantity ${quantity}`);
    }
    assert(context.collectedConcreteQuote(material, 1, 'tonnes').error, `${file}: must reject tonne units`);
  }

  for (const material of ['Concrete', '6F2 Crushed Concrete', 'Quarried Concrete Aggregate (4/20)', 'ST1', 'Lego block - Full']) {
    assert.equal(context.collectedConcreteQuote(material, 1, 'm3'), null, `${file}: unrelated material ${material}`);
  }
}

const worker = fs.readFileSync(path.join(repoRoot, 'worker/index.js'), 'utf8');
assert(worker.includes("reason:'collected_concrete_intake_price_or_office_review'"));
assert(worker.includes("error:'collected_concrete_source_conflict'"));

console.log(`PASS collected-concrete pricing curve, minimum, units and material isolation in ${consumers.length} checked consumers`);
