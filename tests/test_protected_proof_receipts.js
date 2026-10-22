// Exact local worker route bodies with in-memory KV only; never network/live writes.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../worker/index.js'), 'utf8');
const ctx = vm.createContext({ console, Date, Set, Map, Promise, Uint8Array, TextDecoder, URL, crypto: require('crypto').webcrypto,
  corsResponse: (body, status = 200, headers = {}) => new Response(body, { status, headers }),
  safeJsonParse: text => { try { return JSON.parse(text); } catch { return null; } },
  safePathParam: value => /^[a-zA-Z0-9_-]+$/.test(value) ? value : '',
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../worker/ticket-index.js'), 'utf8').replace(/export /g, ''), ctx);
const listStart = source.indexOf('async function listStoredTickets(');
vm.runInContext(source.slice(listStart, source.indexOf('\n}', listStart) + 2), ctx);
vm.runInContext(source.slice(source.indexOf('// Protected completion proof:'), source.indexOf('export default {')), ctx);
const routeStart = source.indexOf('    // PUT /photos/{id}');
const routeEnd = source.indexOf('    // GET /haultech-jobs/{date}', routeStart);
vm.runInContext('async function route(request,env,path){' + source.slice(routeStart, routeEnd) + '\n}', ctx);
const store = new Map();
const env = { PMG_DATA: {
  get: async (key, options) => Array.isArray(key) ? new Map(key.map(k => [k, store.get(k) ?? null])) : store.has(key) ? store.get(key) : null,
  put: async (key, value) => { store.set(key, value); },
  list: async ({ prefix, cursor }) => {
    const keys = [...store.keys()].filter(key => key.startsWith(prefix)).sort();
    const start = Number(cursor || 0), page = keys.slice(start, start + 2);
    return { keys: page.map(name => ({ name })), list_complete: start + page.length >= keys.length, cursor: String(start + page.length) };
  },
} };
// This fixture supplies a completed date pointer view; bounded migration and
// eventual-read failures are covered by the actual runtime index regression.
env.PMG_APP_STORE = { idFromName: name => name, get: () => ({ fetch: async url => {
  const date = new URL(url).searchParams.get('date');
  return new Response(JSON.stringify({ ok: true, keys: [...store.keys()].filter(key => key.startsWith('ticket:') && JSON.parse(store.get(key)).date === date) }));
} }) };
async function call(path, method = 'GET', value) {
  const request = new Request('https://fixture.invalid' + path, { method, ...(value === undefined ? {} : { body: value instanceof Uint8Array ? value : JSON.stringify(value) }) });
  const response = await ctx.route(request, env, new URL(request.url).pathname);
  return { status: response.status, body: await response.json() };
}
const event = { type: 'proof_complete', eventId: 'proof-job-fixture-123', jobId: 'job-fixture', date: '2026-10-17', payload: { hasPhoto: true } };
const assetId = `proof-${event.eventId}-photo`;
const metadata = { eventId: event.eventId, jobId: event.jobId, date: event.date, proofAssets: [{ kind: 'photo', assetId }] };
const receiptPath = '/ticket/pod-fixture';
let count = 0;
async function check(name, run) { await run(); count++; console.log('PASS ' + name); }
(async () => {
  await check('audit intent cannot populate signed eligibility', async () => {
    await call('/ticket/trial-' + event.eventId, 'PUT', event);
    assert.equal((await call('/tickets')).body[0].protectedProof, null);
    assert.equal((await call('/proof-completions/' + event.date)).body.jobIds.length, 0);
  });
  await check('old flag-only cache is ignored', async () => {
    store.set('proof-completions:' + event.date, JSON.stringify({ date: event.date, jobIds: ['unsafe-old-id'] }));
    assert.equal((await call('/proof-completions/' + event.date)).body.jobIds.length, 0);
  });
  await check('client-provided protected flag is stripped', async () => {
    await call('/ticket/trial-' + event.eventId, 'PUT', { ...event, protectedProof: { protected: true, jobId: event.jobId } });
    assert.equal((await call('/tickets')).body[0].protectedProof, null);
  });
  for (const [name, value] of [
    ['wrong event', { ...metadata, eventId: 'absent' }], ['wrong job', { ...metadata, jobId: 'different-job' }],
    ['wrong date', { ...metadata, date: '2026-10-16' }], ['missing asset list', { ...metadata, proofAssets: [] }],
    ['wrong kind', { ...metadata, proofAssets: [{ kind: 'signature', assetId }] }],
    ['unrelated asset', { ...metadata, proofAssets: [{ kind: 'photo', assetId: 'some-old-photo' }] }],
    ['duplicate assets', { ...metadata, proofAssets: [metadata.proofAssets[0], metadata.proofAssets[0]] }],
    ['declared flag without stored bytes', metadata],
  ]) await check(name + ' rejects certification', async () => { assert.equal((await call(receiptPath, 'PUT', value)).status, 409); });
  await check('empty proof upload rejected', async () => {
    assert.equal((await call('/photos/' + assetId, 'PUT', new Uint8Array())).status, 400);
  });
  await check('actual stored bytes produce exact server-owned receipt', async () => {
    assert.equal((await call('/photos/' + assetId, 'PUT', new Uint8Array([1, 2, 3]))).status, 200);
    const result = await call(receiptPath, 'PUT', metadata);
    assert.equal(result.status, 200); const receipt = result.body.proofReceipt;
    assert.equal(receipt.eventId, event.eventId); assert.equal(receipt.jobId, event.jobId); assert.equal(receipt.date, event.date);
    assert.equal(receipt.assets[0].bytes, 3); assert.match(receipt.assets[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal((await call('/proof-completions/' + event.date)).body.jobIds[0], event.jobId);
  });
  await check('exact receipt replay is idempotent', async () => {
    const first = (await call(receiptPath, 'PUT', metadata)).body.proofReceipt;
    const second = (await call(receiptPath, 'PUT', metadata)).body.proofReceipt;
    assert.deepEqual(second, first);
    assert.equal((await call('/photos/' + assetId, 'PUT', new Uint8Array([1, 2, 3]))).status, 200);
  });
  await check('same asset ID cannot replace protected bytes', async () => {
    assert.equal((await call('/photos/' + assetId, 'PUT', new Uint8Array([9, 9, 9]))).status, 409);
    assert.equal(new Uint8Array(store.get('photo:' + assetId))[0], 1);
  });
  await check('stale receipt cannot certify missing or changed current bytes', async () => {
    const bytes = store.get('photo:' + assetId);
    store.delete('photo:' + assetId);
    assert.equal((await call('/proof-completions/' + event.date)).body.jobIds.length, 0);
    store.set('photo:' + assetId, new Uint8Array([9, 9, 9]).buffer);
    assert.equal((await call('/proof-completions/' + event.date)).body.jobIds.length, 0);
    store.set('photo:' + assetId, bytes);
  });
  await check('stale event metadata cannot inherit old receipt', async () => {
    await call('/ticket/trial-' + event.eventId, 'PUT', { ...event, jobId: 'other' });
    assert.equal((await call('/proof-completions/' + event.date)).body.jobIds.length, 0);
    assert.equal((await call(receiptPath, 'PUT', metadata)).status, 409);
    await call('/ticket/trial-' + event.eventId, 'PUT', event);
  });
  await check('every declared photo and signature must be stored', async () => {
    const combined = { ...event, eventId: 'proof-combined-456', payload: { hasPhoto: true, hasSignature: true } };
    await call('/ticket/trial-' + combined.eventId, 'PUT', combined);
    const photoId = `proof-${combined.eventId}-photo`, sigId = `proof-${combined.eventId}-signature`;
    await call('/photos/' + photoId, 'PUT', new Uint8Array([1]));
    const both = { eventId: combined.eventId, jobId: combined.jobId, date: combined.date,
      proofAssets: [{ kind: 'photo', assetId: photoId }, { kind: 'signature', assetId: sigId }] };
    assert.equal((await call('/ticket/pod-combined', 'PUT', both)).status, 409);
    await call('/photos/' + sigId, 'PUT', new Uint8Array([2]));
    assert.equal((await call('/ticket/pod-combined', 'PUT', both)).body.proofReceipt.assets.length, 2);
  });
  await check('day-review cancellation removes otherwise valid proof eligibility', async () => {
    await call('/ticket/cancellation-fixture', 'PUT', { type: 'day_review_cancelled', jobId: event.jobId, date: event.date });
    assert.equal((await call('/proof-completions/' + event.date)).body.jobIds.length, 0);
    assert((await call('/tickets')).body.filter(x => x.type === 'proof_complete').every(x => x.protectedProof === null));
  });
  await check('historic actual-work entries pass through unchanged', async () => {
    const actual = { type: 'day_sheet_row_added', date: '2026-10-16', jobId: 'driver-actual', liveWrite: true, state: 'written', payload: { quantity: 5 } };
    await call('/ticket/actual-fixture', 'PUT', actual);
    assert.deepEqual((await call('/tickets')).body.find(x => x.jobId === actual.jobId), actual);
    assert((await call('/tickets?date=2026-10-17')).body.every(x => x.date === '2026-10-17'));
    assert.equal((await call('/tickets?date=invalid')).status, 400);
  });
  await check('driver sign-off needs stored statement and exact driver/date/job receipt', async () => {
    const signoff = { version: 1, kind: 'driver-signoff', driver: 'Test Driver', signedAt: '2026-10-22T16:00:00Z', notes: 'Customer absent. Tipped in agreed place.' };
    const signedEvent = { type: 'proof_complete', eventId: 'driver-signoff-fixture', jobId: 'signoff-job', date: '2026-10-22', driver: signoff.driver,
      payload: { hasDriverSignoff: true, hasPhoto: false, hasSignature: false, driverSignoff: signoff } };
    const statementId = `proof-${signedEvent.eventId}-driver-signoff`;
    const meta = { eventId: signedEvent.eventId, jobId: signedEvent.jobId, date: signedEvent.date, proofAssets: [{ kind: 'driver-signoff', assetId: statementId }] };
    await call('/ticket/trial-' + signedEvent.eventId, 'PUT', signedEvent);
    assert.equal((await call('/ticket/pod-signoff', 'PUT', meta)).status, 409);
    const statement = { ...signoff, eventId: signedEvent.eventId, jobId: signedEvent.jobId, date: signedEvent.date };
    const bytes = new TextEncoder().encode(JSON.stringify(statement));
    await call('/photos/' + statementId, 'PUT', bytes);
    const result = await call('/ticket/pod-signoff', 'PUT', meta);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.proofReceipt.driverSignoff, signoff);
    assert.deepEqual(result.body.proofReceipt.assets.map(a => a.kind), ['driver-signoff']);
    assert.deepEqual((await call('/proof-completions/' + signedEvent.date)).body.jobIds, [signedEvent.jobId]);
    await call('/ticket/trial-' + signedEvent.eventId, 'PUT', { ...signedEvent, payload: { ...signedEvent.payload, driverSignoff: { ...signoff, notes: 'Changed' } } });
    assert.equal((await call('/proof-completions/' + signedEvent.date)).body.jobIds.length, 0);
    assert.equal((await call('/ticket/pod-signoff', 'PUT', meta)).status, 409);
    await call('/ticket/trial-' + signedEvent.eventId, 'PUT', signedEvent);
    store.set('photo:' + statementId, new TextEncoder().encode(JSON.stringify({ ...statement, driver: 'Someone else' })).buffer);
    assert.equal((await call('/proof-completions/' + signedEvent.date)).body.jobIds.length, 0);
    assert.equal((await call('/ticket/pod-signoff', 'PUT', meta)).status, 409);
    store.set('photo:' + statementId, bytes.buffer);
    assert.equal((await call('/proof-completions/' + signedEvent.date)).body.jobIds.length, 1);
  });
  console.log(`${count}/${count} protected-proof worker cases passed; no live writes`);
})().catch(error => { console.error(error); process.exitCode = 1; });
