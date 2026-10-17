const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Exercise the actual frontend functions, with no network, browser or live writes.
const html = fs.readFileSync(process.env.PMG_TEST_INDEX || path.join(__dirname, '../index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert(start >= 0, 'Missing function ' + name);
  const next = html.slice(start + 1).search(/\n(?:async )?function /);
  return html.slice(start, next < 0 ? undefined : start + 1 + next).split('\n// ═')[0];
}
const ack = (status = 200, body = { ok: true }) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => { if (body instanceof Error) throw body; return body; },
  text: async () => JSON.stringify(body),
});
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function fixture(overrides = {}) {
  const storage = new Map();
  const ctx = {
    console, LIVE_WRITE: true, WORKER_URL: 'https://fixture.invalid', API_KEY: 'fixture',
    todayISO: () => '2026-10-17', currentUser: { name: 'Fixture Driver' },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    fetch: async () => ack(), api: async () => ack(),
    updateSyncUI: () => {}, getJobNumber: job => job.id,
    requireWalkaroundBeforeDriverAction: () => true, getJobConsignmentId: () => 'fixture-consignment',
    updateJobStatusLocal: () => {}, localSaveJobs: () => {}, allJobs: [], currentScreen: 'detail',
    toast: () => {}, ...overrides,
  };
  vm.createContext(ctx);
  for (const name of ['localEventKey', 'localQueueKey', 'readJSON', 'writeJSON', 'getWritebackQueue',
    'setWritebackQueue', 'setQueueState', 'setQueueStateIfPending', 'queueTrialEvent',
    'persistTrialEventToWorker', 'departJob']) vm.runInContext(source(name), ctx);
  return ctx;
}
const tests = [];
function test(name, run) { tests.push({ name, run }); }
for (const [label, response] of [
  ['HTTP 503', () => ack(503, { error: 'unavailable' })],
  ['HTTP 403', () => ack(403, { error: 'forbidden' })],
  ['negative acknowledgement', () => ack(200, { ok: false })],
  ['missing acknowledgement', () => ack(200, {})],
  ['malformed acknowledgement', () => ack(200, new Error('invalid JSON'))],
]) {
  test('audit rejects ' + label, async () => {
    const ctx = fixture({ fetch: async () => response() });
    ctx.setWritebackQueue([{ eventId: 'audit-fixture', state: 'pending Haultech' }]);
    await ctx.persistTrialEventToWorker({ eventId: 'audit-fixture', state: 'written', haultechWriteState: 'written' });
    assert.equal(ctx.getWritebackQueue()[0].state, 'failed', 'Audit cannot claim written without a positive worker acknowledgement');
  });
  test('Start rejects ' + label, async () => {
    const ctx = fixture({ api: async () => response() });
    await ctx.departJob({ id: 'fixture-job' });
    await tick();
    assert.equal(ctx.getWritebackQueue()[0].state, 'failed', 'Start cannot claim worker status saved without a positive acknowledgement');
  });
}
test('audit accepts acknowledged success', async () => {
  const ctx = fixture();
  ctx.setWritebackQueue([{ eventId: 'audit-fixture', state: 'pending Haultech' }]);
  await ctx.persistTrialEventToWorker({ eventId: 'audit-fixture', state: 'written', haultechWriteState: 'written' });
  assert.equal(ctx.getWritebackQueue()[0].state, 'written');
});
test('audit network exception remains failed', async () => {
  const ctx = fixture({ fetch: async () => { throw new Error('offline'); } });
  ctx.setWritebackQueue([{ eventId: 'audit-fixture', state: 'written' }]);
  await ctx.persistTrialEventToWorker({ eventId: 'audit-fixture', state: 'written' });
  assert.equal(ctx.getWritebackQueue()[0].state, 'failed');
});
test('later Start success cannot hide earlier audit failure', async () => {
  const status = deferred();
  const ctx = fixture({ fetch: async () => ack(503), api: () => status.promise });
  const starting = ctx.departJob({ id: 'fixture-job' });
  await tick();
  status.resolve(ack());
  await starting;
  await tick();
  assert.equal(ctx.getWritebackQueue()[0].state, 'failed');
});
test('later audit success cannot hide earlier Start failure', async () => {
  const audit = deferred();
  const ctx = fixture({ fetch: () => audit.promise, api: async () => ack(403) });
  const starting = ctx.departJob({ id: 'fixture-job' });
  await tick();
  audit.resolve(ack());
  await starting;
  await tick();
  assert.equal(ctx.getWritebackQueue()[0].state, 'failed');
});
test('successful Start preserves event identity in the worker requests', async () => {
  const calls = [];
  const ctx = fixture({
    fetch: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return ack(); },
    api: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return ack(); },
  });
  await ctx.departJob({ id: 'fixture-job' });
  await tick();
  const event = ctx.getWritebackQueue()[0];
  assert.equal(event.state, 'written');
  const audit = calls.find(call => call.url.includes('/ticket/'));
  assert.equal(audit.body.eventId, event.eventId);
  assert(audit.url.endsWith('/ticket/trial-' + event.eventId));
  assert.equal(audit.body.jobId, 'fixture-job');
});
(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
  }
  console.log(`${tests.length - failed}/${tests.length} worker acknowledgement checks passed`);
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
