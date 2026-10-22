const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(process.env.PMG_TEST_INDEX || path.join(__dirname, '../index.html'), 'utf8');
function fn(name) {
  const start = html.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert(start >= 0, name);
  const end = html.indexOf('\n}', start);
  assert(end > start, name + ' closing brace');
  return html.slice(start, end + 2);
}
function context(values, names) {
  const ctx = vm.createContext({ console, Date, Set, Map, ...values });
  for (const name of names) vm.runInContext(fn(name), ctx);
  return ctx;
}
const ack = (ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => ({ ok }), text: async () => '' });
const tick = () => new Promise(resolve => setImmediate(resolve));
const cases = [];
function test(name, run) { cases.push({ name, run }); }

test('previous-day pending rows are retained without replaying historical writes', async () => {
  let queue = [{ date: '2026-10-16', jobs: [{ id: 'driver-old', movementId: 'driver-old', haultechWriteState: 'pending Haultech' }] }];
  let writes = 0;
  const ctx = context({ todayISO: () => '2026-10-17', getRetryQueue: () => JSON.parse(JSON.stringify(queue)),
    setRetryQueue: q => { queue = q; }, cloudPutJobs: async () => { writes++; }, submitDriverAddedRow: async () => { writes++; },
    toast() {}, updateSyncUI() {}, localStorage: { setItem() {} } }, ['pruneRetryQueue', 'flushRetryQueue']);
  ctx.pruneRetryQueue();
  assert.equal(queue.length, 1, 'midnight must not erase unresolved work');
  await ctx.flushRetryQueue();
  assert.equal(queue.length, 1);
  assert.equal(writes, 0, 'historic rows require office review, not new automatic writes');
});

test('failed local storage is surfaced rather than claiming a saved copy', () => {
  const ctx = context({ localStorage: { setItem() { throw new Error('QuotaExceededError'); } }, jobToLocal: j => j }, ['localSaveJobs']);
  assert.throws(() => ctx.localSaveJobs('2026-10-17', [{ id: 'fixture' }]), /QuotaExceeded/);
});

test('live reassignment outranks the person who added the row', () => {
  const ctx = context({ getJobAddedBy: () => 'Original driver', DRIVER_IDS: { newdriver: 'Assigned driver' } }, ['getJobDriver']);
  assert.equal(ctx.getJobDriver({ deliveryDriverId: 'newdriver', addedBy: 'Original driver' }), 'Assigned driver');
});

test('invalid customer response cannot replace the usable customer list', async () => {
  const original = [{ id: 'customer-fixture', name: 'Fixture' }];
  const ctx = context({ customers: original, api: async () => ({ ok: true, json: async () => ({ error: 'temporarily unavailable' }) }) }, ['loadCustomers']);
  await ctx.loadCustomers({ force: true });
  assert.equal(ctx.customers, original);
});

test('known torque checks remain visible when verification fails', () => {
  const task = { taskId: 'due-fixture', vehicle: 'AB12 CDE' };
  const ctx = context({ getSelectedDriverVehicle: () => 'AB12 CDE', normaliseVehicleRef: s => s.replace(/ /g, ''),
    torqueCheckState: { vehicle: 'AB12CDE', error: 'offline', tasks: [task] }, safeList: x => Array.isArray(x) ? x : [], readCachedTorqueTasks: () => [task] }, ['currentTorqueTasks']);
  assert.equal(ctx.currentTorqueTasks().length, 1);
});

test('unknown torque verification cannot be treated as confirmed clear', () => {
  const ctx = context({ getLocalWalkaroundRecord: () => ({ completed: true }), pendingTorqueTasksForSelectedVehicle: () => [],
    getSelectedDriverVehicle: () => 'AB12CDE', normaliseVehicleRef: x => x,
    torqueCheckState: { vehicle: 'AB12CDE', error: 'offline', loading: false, loadedAt: Date.now() }, TORQUE_REFRESH_MS: 60000 }, ['hasSelectedWalkaroundComplete']);
  assert.equal(ctx.hasSelectedWalkaroundComplete(), false);
});

test('day review cancellation preserves a failed note write despite successful status', async () => {
  const states = [];
  const ctx = context({ window: { confirm: () => true }, getJobConsignmentId: () => 'cons',
    composeDriverHaultechNote: () => 'cancelled', queueTrialEvent: () => ({ eventId: 'cancel-fixture' }),
    persistTrialEventToWorker: async () => true, updateJobStatusLocal() {}, localSaveJobs() {}, todayISO: () => '2026-10-17', allJobs: [],
    writeHaultechDriverNoteForJob: async () => { throw new Error('note rejected'); }, api: async () => ack(),
    setQueueState: (...a) => states.push(a), saveJobsToCloud: async () => {}, toast() {}, renderJobs() {}, currentUser: { name: 'Fixture' },
    getJobStatus: () => 'scheduled', isTerminalJobStatus: () => false }, ['requireWorkerAcknowledgement', 'cancelDriverJob', 'handleDayReviewAction']);
  await ctx.handleDayReviewAction({ id: 'job-fixture' }, 'cancelled');
  assert.equal(states.at(-1)[1], 'failed');
});

test('retry accepts only the receipt revision for unchanged queued content', async () => {
  const row = { id: 'driver-one', movementId: 'driver-one', status: 'scheduled', haultechWriteState: 'pending Haultech', notes: 'Original' };
  let queue = [{ date: '2026-10-17', jobs: [{ ...row }] }];
  let local = JSON.stringify([{ ...row, _backupRevision: 3 }]);
  let uploaded;
  const ctx = context({ todayISO: () => '2026-10-17', getRetryQueue: () => JSON.parse(JSON.stringify(queue)),
    setRetryQueue: q => { queue = q; }, submitDriverAddedRow: async () => ({ jobId: 'real-job' }),
    cloudPutJobs: async (date, jobs) => { uploaded = jobs; },
    localStorage: { getItem: () => local, setItem: (key, value) => { local = value; } },
    toast() {}, updateSyncUI() {} }, ['pruneRetryQueue', 'flushRetryQueue']);
  await ctx.flushRetryQueue();
  assert.equal(JSON.parse(local)[0].haultechWriteState, 'written');
  assert.equal(JSON.parse(local)[0]._backupRevision, 3);
  assert.equal(uploaded[0]._backupRevision, 3);
  assert.equal(queue.length, 0);
});

test('concurrent refresh waits for the existing retry receipt without a second submission', async () => {
  let queue = [{ date: '2026-10-17', jobs: [{ id: 'driver-one', status: 'scheduled' }] }];
  let finish, writes = 0, joined = false;
  const ctx = context({ todayISO: () => '2026-10-17', getRetryQueue: () => JSON.parse(JSON.stringify(queue)),
    setRetryQueue: q => { queue = q; }, cloudPutJobs: () => { writes++; return new Promise(resolve => { finish = resolve; }); },
    localStorage: { getItem: () => JSON.stringify(queue[0]?.jobs || []), setItem() {} },
    toast() {}, updateSyncUI() {} }, ['pruneRetryQueue', 'flushRetryQueue']);
  const first = ctx.flushRetryQueue();
  while (!finish) await tick();
  const second = ctx.flushRetryQueue().then(() => { joined = true; });
  await tick();
  assert.equal(joined, false);
  finish(); await Promise.all([first, second]);
  assert.equal(writes, 1); assert.equal(joined, true);
});

test('pending retry additions survive an older in-flight flush', async () => {
  let queue = [{ date: '2026-10-17', savedAt: 'first', jobs: [{ id: 'driver-one', status: 'scheduled' }] }];
  const local = new Map([['pmg_local_jobs_2026-10-17', JSON.stringify(queue[0].jobs)]]);
  let finish;
  const ctx = context({ todayISO: () => '2026-10-17', getRetryQueue: () => JSON.parse(JSON.stringify(queue)),
    setRetryQueue: q => { queue = q; }, cloudPutJobs: () => new Promise(resolve => { finish = resolve; }),
    localStorage: { getItem: key => local.get(key), setItem: (key, value) => local.set(key, value) },
    toast() {}, updateSyncUI() {} }, ['pruneRetryQueue', 'flushRetryQueue']);
  const flush = ctx.flushRetryQueue();
  while (!finish) await tick();
  queue = [{ date: '2026-10-17', savedAt: 'second', jobs: [{ id: 'driver-one' }, { id: 'driver-two' }] }];
  local.set('pmg_local_jobs_2026-10-17', JSON.stringify(queue[0].jobs));
  finish(); await flush;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].jobs.length, 2);
  assert.equal(JSON.parse(local.get('pmg_local_jobs_2026-10-17')).length, 2);
});

test('unmapped completion never clears proof after worker upload rejection', async () => {
  let completed = false, leftForm = false;
  const ctx = context({ activeJob: { id: 'driver-fixture' }, allJobs: [], LIVE_WRITE: true,
    getJobStatus: () => 'scheduled', getHaultechJobId: () => null, findMatchingLiveDriverJob: () => null,
    driverMovementId: () => 'driver-fixture', getJobConsignmentId: () => null, jobRequiresConcreteSource: () => false,
    $: () => ({ value: '', focus() {} }), setSignCompleteBusy() {}, composeDriverHaultechNote: () => '',
    applyDriverCompletionNote: () => '', getSignSigData: () => 'data:fixture', getJobWasteTransferNote: () => null,
    queueTrialEvent: () => ({ eventId: 'proof-fixture' }), persistTrialEventToWorker: async () => true,
    setQueueState() {}, signPhotoFile: null,
    fetch: async url => url === 'data:fixture' ? { arrayBuffer: async () => new ArrayBuffer(1) } : ack(false),
    api: async () => ack(false), updateJobStatusLocal: () => { completed = true; }, saveJobsToCloud: async () => {},
    todayISO: () => '2026-10-17', showJobList: () => { leftForm = true; }, renderJobs() {}, reloadForPendingServiceWorkerUpdate() {},
    toast() {}, WORKER_URL: 'https://fixture.invalid', API_KEY: 'fixture', currentUser: { name: 'Fixture' }, POD_CODES: { success: 'success' } }, []);
  for (const name of ['requireWorkerAcknowledgement', 'saveWorkerProofAsset', 'saveProofMetadata']) {
    if (html.includes('function ' + name + '(')) vm.runInContext(fn(name), ctx);
  }
  vm.runInContext('let signCompletionInFlight=false;\n' + html.slice(html.indexOf('async function handleSignComplete()'), html.indexOf("$('sign-save-btn').addEventListener")), ctx);
  await ctx.handleSignComplete();
  assert.equal(completed, false, 'failed proof cannot mark complete');
  assert.equal(leftForm, false, 'original proof must remain on the form');
});

test('selected customer and pricing/proof fields survive backup and cached reload', () => {
  const ctx = context({ getCollectionAddress: j => j.collectionAddress, getDeliveryAddress: j => j.deliveryAddress }, ['jobToLocal', 'cachedDriverFields']);
  const saved = { id: 'driver-fixture', movementId: 'driver-fixture', customer: 'Fixture', customerId: 'customer-fixture',
    from: 'Quarry', to: 'Site', priceMode: 'rate', priceInput: 0, wagonVisits: 2, specialAccess: true, quantity: 20,
    proofReceipt: { protected: true }, attachments: { purpose: 'driver_added_attachment' }, unit: 't', concreteType: '', pourMinutes: 0 };
  assert.equal(ctx.jobToLocal(saved).customerId, 'customer-fixture');
  const cached = ctx.cachedDriverFields(saved);
  assert.equal(cached._customerId, 'customer-fixture');
  assert.equal(cached._priceInput, 0); assert.equal(cached._pourMinutes, 0);
  assert.equal(cached._proofReceipt.protected, true); assert.equal(cached._attachments.purpose, 'driver_added_attachment');
  assert(html.includes("$('f-customer-id').value = '';"), 'editing customer must clear selected identity');
  assert(html.includes("customerId: $('f-customer-id').value.trim()"), 'Add Row must include selected identity');
});

test('Add Row protects optional attachments and keeps their stable movement reference', async () => {
  const calls = [];
  const ctx = context({ currentUser: { name: 'Fixture' }, fetch: async () => ({ arrayBuffer: async () => new ArrayBuffer(1) }),
    saveWorkerProofAsset: async id => { calls.push(id); return { protected: true, assetId: id }; },
    saveProofMetadata: async (key, metadata) => { calls.push({ key, metadata }); } }, ['saveAddedJobProof']);
  assert.equal(await ctx.saveAddedJobProof('driver-fixture', null, null), null); assert.equal(calls.length, 0);
  const receipt = await ctx.saveAddedJobProof('driver-fixture', 'data:fixture', { type: 'image/jpeg', arrayBuffer: async () => new ArrayBuffer(1) });
  assert.equal(receipt.assets.length, 2); assert.equal(calls[2].key, 'add-driver-fixture');
  assert.equal(calls[2].metadata.assets[0].assetId, 'add-sig-driver-fixture');
  ctx.saveWorkerProofAsset = async () => { throw new Error('offline'); };
  await assert.rejects(ctx.saveAddedJobProof('driver-fixture', 'data:fixture', null), /offline/);
  assert.equal(calls.length, 3, 'failed upload must not claim a protected metadata record');
});

test('HTTP 200 without a positive worker receipt cannot protect evidence', async () => {
  const ctx = context({}, ['requireWorkerAcknowledgement']);
  await assert.rejects(ctx.requireWorkerAcknowledgement({ ok: true, json: async () => ({ ok: false }) }, 'Proof'), /not confirmed/);
  await assert.rejects(ctx.requireWorkerAcknowledgement({ ok: true, json: async () => { throw new Error('invalid JSON'); } }, 'Proof'), /invalid JSON/);
  await assert.rejects(ctx.requireWorkerAcknowledgement(ack(false), 'Proof'), /503/);
  assert.equal((await ctx.requireWorkerAcknowledgement(ack(), 'Proof')).ok, true);
});

function mergeContext(localRows) {
  return context({ localGetJobs: () => localRows, getJobStatus: j => j.status || 'scheduled',
    getHaultechJobId: j => j.haultechJobId || j._haultechJobId || (/^[a-f0-9-]{36}$/.test(j.id || j.jobId || '') ? (j.id || j.jobId) : null),
    getJobConsignment: () => null, driverAddedFingerprint: () => null, isLocalDriverTempJob: j => !!j._driverAdded,
    clearMatchedDriverWritebackQueue() {}, getCollectionAddress: () => null, getDeliveryAddress: () => null,
    cloudPutJobs: async () => {}, addToRetryQueue() {} }, ['driverMovementId', 'sameDriverAddedMovement', 'findMatchingLiveDriverJob', 'cachedDriverFields', 'mergeWithLocal']);
}

test('same reference never moves local completion onto a different live GUID', () => {
  const ctx = mergeContext([{ id: '11111111-1111-4111-8111-111111111111', ticketNo: 'SAME-REF', status: 'complete' }]);
  const rows = ctx.mergeWithLocal('2026-10-17', [{ id: '22222222-2222-4222-8222-222222222222', ticketNo: 'SAME-REF', status: 'scheduled' }]);
  assert.equal(rows[0].status, 'scheduled');
});

test('authoritative refresh cannot resurrect removed official jobs as driver-created rows', () => {
  const ctx = mergeContext([{ id: '11111111-1111-4111-8111-111111111111', ticketNo: 'REF', status: 'scheduled' }]);
  assert.equal(ctx.mergeWithLocal('2026-10-17', []).length, 0);
  assert.equal(ctx.mergeWithLocal('2026-10-17', [], { allowOfficialCached: true }).length, 1, 'offline recovery retains original official cache');
});

test('malformed successful diary response preserves the fallback route', async () => {
  let fellBack = false, saved = false;
  const ctx = context({ document: { hidden: false }, todayISO: () => '2026-10-17', $: () => ({}), showError() {},
    updateSyncUI() {}, customers: [1], api: async () => ({ ok: true, json: async () => ({ error: 'bad upstream payload' }) }),
    mergeWithLocal: (date, rows) => rows, renderJobs() {}, saveJobsToCloud: async () => { saved = true; },
    loadJobsFallback: async () => { fellBack = true; }, console: { error() {} } }, ['loadJobs']);
  await ctx.loadJobs();
  assert.equal(fellBack, true); assert.equal(saved, false);
});

test('driver list honours a live reassignment rather than Added by', () => {
  const job = { id: 'fixture', deliveryDriverId: 'new-driver', addedBy: 'Old driver' };
  const ctx = context({ allJobs: [job], getJobDriverId: j => j.deliveryDriverId, getJobDriver: () => 'New driver',
    getJobAddedBy: j => j.addedBy, sameDriverName: (a, b) => a === b, normaliseNoteText: x => x }, ['getDriverJobs']);
  assert.equal(ctx.getDriverJobs('old-driver', 'Old driver').length, 0);
  assert.equal(ctx.getDriverJobs('new-driver', 'New driver').length, 1);
});

test('cancelled pending row is retained and never automatically created', async () => {
  let queue = [{ date: '2026-10-17', jobs: [{ id: 'driver-cancel', movementId: 'driver-cancel', status: 'cancelled', haultechWriteState: 'pending Haultech' }] }];
  let created = 0;
  const ctx = context({ todayISO: () => '2026-10-17', getRetryQueue: () => JSON.parse(JSON.stringify(queue)),
    setRetryQueue: value => { queue = value; }, submitDriverAddedRow: async () => { created++; return {}; },
    cloudPutJobs: async () => {}, localStorage: { getItem: () => null, setItem() {} }, updateSyncUI() {}, toast() {} }, ['pruneRetryQueue', 'flushRetryQueue']);
  await ctx.flushRetryQueue();
  assert.equal(created, 0); assert.equal(queue.length, 1);
  assert.match(queue[0].jobs[0].haultechWriteError, /office review/);
});

test('walkaround retry preserves newer records added while an earlier upload awaits', async () => {
  let queue = [{ recordId: 'old', date: '2026-10-17' }], release, localWrites = 0;
  const ctx = context({ getPendingWalkaroundTickets: () => JSON.parse(JSON.stringify(queue)), setPendingWalkaroundTickets: value => { queue = value; },
    saveWalkaroundTicketRecord: () => new Promise(resolve => { release = resolve; }),
    readJSON: () => ({ recordId: 'new' }), walkaroundStorageKeyFor: () => 'fixture', setLocalWalkaroundRecord: () => { localWrites++; },
    currentScreen: 'detail', toast() {}, renderJobs() {} }, ['flushWalkaroundTicketQueue']);
  const flushing = ctx.flushWalkaroundTicketQueue();
  while (!release) await tick();
  queue.push({ recordId: 'new', date: '2026-10-17' });
  release(); await flushing;
  assert.deepEqual(queue.map(x => x.recordId), ['new']); assert.equal(localWrites, 0, 'older receipt cannot replace newer local walkaround');
});

test('live or pending driver row cannot be hidden by local-only deletion', () => {
  const ctx = context({ LIVE_WRITE: true, isDriverAddedJob: () => true, getHaultechJobId: j => j.haultechJobId || null }, ['canDeleteLocalDriverJob']);
  assert.equal(ctx.canDeleteLocalDriverJob({ id: 'driver-fixture' }), false);
  ctx.LIVE_WRITE = false;
  assert.equal(ctx.canDeleteLocalDriverJob({ id: 'driver-fixture', haultechWriteState: 'pending Haultech' }), false);
  assert.equal(ctx.canDeleteLocalDriverJob({ id: 'driver-fixture', haultechJobId: 'live-fixture' }), false);
  assert.equal(ctx.canDeleteLocalDriverJob({ id: 'driver-fixture' }), true);
});

test('walkaround asset and ticket both require an acknowledged receipt', async () => {
  const ctx = context({ walkaroundAssetId: () => 'asset-fixture', walkaroundTicketId: x => x,
    WORKER_URL: 'https://fixture.invalid', API_KEY: 'fixture', fetch: async () => ({ ok: true, json: async () => ({ ok: false }) }),
    api: async () => ({ ok: true, json: async () => ({ ok: false }) }) }, ['requireWorkerAcknowledgement', 'uploadWalkaroundAsset', 'saveWalkaroundTicketRecord']);
  await assert.rejects(ctx.uploadWalkaroundAsset('fixture', 'front', { type: 'image/jpeg' }), /not confirmed/);
  await assert.rejects(ctx.saveWalkaroundTicketRecord({ recordId: 'fixture' }), /not confirmed/);
});

test('raw completion verification cannot match another GUID through shared display fields', () => {
  const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
  const ctx = context({ getHaultechJobId: j => j.id, getJobConsignment: () => null, isGuidId: x => /^[a-f0-9-]{36}$/.test(x) }, ['sameHaultechJob']);
  assert.equal(ctx.sameHaultechJob({ id: a, jobNumber: 'SHARED' }, { id: b, jobNumber: 'SHARED' }, b), false);
  assert.equal(ctx.sameHaultechJob({ id: a }, { id: a }, a), true);
});

test('native MPOD 2xx cannot replace confirmed PMG proof custody', async () => {
  let nativeCalls = 0;
  const ctx = context({ saveWorkerProofAsset: async () => { throw new Error('PMG offline'); },
    api: async () => { nativeCalls++; return { ok: true, json: async () => ({ ok: false }) }; },
    responseError: async () => 'native rejected' }, ['uploadProofAsset']);
  const failed = await ctx.uploadProofAsset('cons', 'job', 'photo', 'image/jpeg', new ArrayBuffer(1), 'event');
  assert.equal(failed.fallbackSaved, false); assert.equal(failed.haultechUploaded, false); assert.equal(nativeCalls, 0);
  ctx.saveWorkerProofAsset = async () => ({ protected: true });
  const protectedCopy = await ctx.uploadProofAsset('cons', 'job', 'photo', 'image/jpeg', new ArrayBuffer(1), 'event');
  assert.equal(protectedCopy.fallbackSaved, true); assert.equal(protectedCopy.haultechSubmitted, true);
  assert.equal(protectedCopy.haultechUploaded, false, 'undocumented MPOD body never becomes verified');
  assert.equal(protectedCopy.assetId, 'proof-event-photo');
});

test('proof details require exact server-owned event/job/date receipt', async () => {
  const metadata = { eventId: 'event', jobId: 'job', date: '2026-10-17' };
  let body = { ok: true };
  const ctx = context({ WORKER_URL: 'https://fixture.invalid', API_KEY: 'fixture', fetch: async () => ({ ok: true, json: async () => body }) },
    ['requireWorkerAcknowledgement', 'saveProofMetadata']);
  await assert.rejects(ctx.saveProofMetadata('job', metadata), /receipt not confirmed/);
  body = { ok: true, proofReceipt: { protected: true, ...metadata, jobId: 'other' } };
  await assert.rejects(ctx.saveProofMetadata('job', metadata), /receipt not confirmed/);
  body.proofReceipt.jobId = 'job';
  assert.equal((await ctx.saveProofMetadata('job', metadata)).jobId, 'job');
});

(async () => {
  let failures = 0;
  for (const { name, run } of cases) {
    try { await run(); console.log('PASS ' + name); }
    catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); }
  }
  console.log(`${cases.length - failures}/${cases.length} driver reliability cases passed`);
  if (failures) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
