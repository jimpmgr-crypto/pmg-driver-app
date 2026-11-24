// Actual Worker routes and a persistent workerd/SQLite coordinator. The
// outbound mock is the only HaulTech endpoint used by these tests.
const { Miniflare } = require('./miniflare_compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const script = path.resolve(__dirname, '../worker/index.js');
const key = fs.readFileSync(script, 'utf8').match(/const API_KEY = '([^']+)'/)[1];
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pmg-driver-create-'));
const date = '2026-11-24';
const dates = Array.from({length: 12}, (_, i) => `2026-10-${String(i+1).padStart(2,'0')}`);
const rows = new Map();
const fixture = {
  customer: 'Fixture Customer', driver: 'John Bowman', vehicle: 'EY15BOV',
  material: 'MOT', quantity: 16, unit: 't', from: 'Fixture Yard',
  to: 'Fixture Delivery', reference: 'FIXTURE ONLY', notes: 'Synthetic only',
};
let runtime, writes = 0, lookupCount = 0, pendingReply, visibility = true, mode = '', coverage = '';
const persisted = day => rows.get(day) || [];

async function upstream(input) {
  const request = input;
  const url = new URL(request.url);
  assert.equal(url.hostname, 'httms.azurewebsites.net');
  if (url.pathname.endsWith('/GetJobsByDatePaginated')) {
    lookupCount++;
    const jobs = visibility ? persisted(url.searchParams.get('selectFromDate')) : [];
    if (coverage === 'next-page') return Response.json({ items: jobs }, {headers: {continuationtoken: 'fixture-next-page'}});
    if (coverage === 'count-mismatch') return Response.json({ items: jobs, totalCount: jobs.length + 1 });
    if (coverage === 'bad-envelope') return Response.json({ message: 'Missing rows' });
    if (coverage === 'bad-row') return Response.json({ items: [null] });
    if (coverage === 'cap') return Response.json({ items: Array.from({length:200}, (_, i) => ({id: `busy-${i}`})) });
    return Response.json({ items: jobs, totalCount: jobs.length });
  }
  assert.equal(url.pathname, '/api/Job/UpsertJob', 'unexpected outbound request');
  const inputRow = await request.json();
  writes++;
  const row = {...inputRow, id: `00000000-0000-4000-8000-${String(writes).padStart(12,'0')}`, jobId: 10000+writes };
  const workDate = row.deliveryDate.slice(0,10);
  rows.set(workDate, [...persisted(workDate), row]);
  if (pendingReply) await pendingReply;
  if (mode === '204') return new Response(null, {status: 204});
  if (mode === 'blank-200') return new Response('');
  if (mode === 'lost-reply') return Response.json({error:'fixture connection lost after write'}, {status:502});
  if (mode === 'partial-readback') coverage = 'next-page';
  return Response.json({id: row.id, jobId: row.jobId});
}
async function start() {
  runtime = new Miniflare({
    scriptPath: script, compatibilityDate: '2024-01-01', kvNamespaces: ['PMG_DATA'],
    kvPersist: path.join(folder,'kv'), durableObjectsPersist: path.join(folder,'do'),
    durableObjects: {PMG_APP_STORE: {className:'PmgAppStore',useSQLite:true}},
    outboundService: upstream,
  });
  const kv = await runtime.getKVNamespace('PMG_DATA');
  await kv.put('haultech-auth', JSON.stringify({token:'fixture',tmsId:'fixture'}));
  await kv.put('customers', JSON.stringify([{id:'fixture-customer',name:'Fixture Customer'}]));
}
async function add(day, movement, fields = {}) {
  const response = await runtime.dispatchFetch('https://fixture/ht/driver-add', {
    method: 'POST', headers:{'X-PMG-Key':key,'Origin':'https://pmg-driver-app.pages.dev'},
    body: JSON.stringify({...fixture,date:day,movementId:movement,...fields}),
  });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  return {status: response.status, body: await response.json()};
}
async function waitForWrite(expected) {
  for (let i=0; i<1000 && writes<expected; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(writes, expected);
}
async function main() {
  await start();
  const direct = await runtime.dispatchFetch('https://fixture/__driver_add/'+date, {method:'POST',headers:{'X-PMG-Key':key},body:'{}'});
  assert.equal(direct.status,404);
  const denied = await runtime.dispatchFetch('https://fixture/ht/driver-add', {method:'POST',body:'{}'});
  assert.equal(denied.status,401);

  for (const [day, simultaneous] of [[date,'same'],[dates[0],'matching']]) {
    const before = writes, readsBefore = lookupCount;
    let resume;
    pendingReply = new Promise(resolve => { resume = resolve; });
    const one = add(day,'driver-first');
    await Promise.race([waitForWrite(before+1), one.then(result => { throw new Error('Save completed before fixture write gate: ' + JSON.stringify(result)); })]);
    const two = add(day, simultaneous === 'same' ? 'driver-first' : 'driver-second');
    try {
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.equal(lookupCount,readsBefore+1,'second request must wait for first write and readback');
      assert.equal(writes,before+1);
    } finally { pendingReply = null; resume(); }
    const [original,other] = await Promise.all([one,two]);
    assert.equal(original.status,200);
    assert.equal(writes,before+1);
    if (simultaneous==='same') {
      assert.equal(other.status,200);
      assert.equal(other.body.jobId,original.body.jobId);
      assert.equal(other.body.alreadyPresent,true);
    } else {
      assert.equal(other.status,409);
      assert.equal(other.body.error,'driver_trip_already_recorded');
      const distinct = await add(day,'driver-second',{confirmedSeparateTrip:true});
      assert.equal(distinct.status,200);
      assert.notEqual(distinct.body.jobId, original.body.jobId);
      assert.equal(writes,before+2);
    }
  }
  console.log('PASS overlapping same movement, matching trip confirmation, and legitimate separate load');

  for (const partial of ['next-page','count-mismatch','bad-envelope','bad-row','cap']) {
    const before = writes;
    coverage = partial;
    const result = await add(dates[1],'driver-incomplete');
    assert.equal(result.status,503);
    assert.equal(result.body.error,'haultech_lookup_incomplete');
    assert.equal(writes,before);
  }
  coverage = '';
  assert.equal((await add(dates[1],'driver-incomplete')).status,200);
  console.log('PASS five incomplete or malformed lookup cases block creation and retry after recovery');

  for (const [day, response] of [[dates[2],'blank-200'],[dates[3],'204'],[dates[4],'204']]) {
    mode = response;
    const movement = day===dates[4] ? undefined : 'driver-empty-response';
    const saved = await add(day,movement);
    assert.equal(saved.status,200);
    assert.equal(saved.body.jobId,persisted(day)[0].id);
    const repeated = await add(day,movement);
    assert.equal(repeated.body.jobId,saved.body.jobId);
    assert.equal(persisted(day).length,1);
  }
  console.log('PASS blank 200, HTTP 204 and legacy save receipts return the verified job GUID');

  mode = 'lost-reply';
  const unknown = await add(dates[5],'driver-lost-response');
  assert.equal(unknown.status,503);
  assert.equal(unknown.body.error,'driver_create_unconfirmed');
  assert.equal(persisted(dates[5]).length,1);
  await runtime.dispose();
  runtime = null;
  await start();
  mode = '';
  visibility = false;
  const before = writes;
  assert.equal((await add(dates[5],'driver-lost-response')).body.error,'driver_create_unconfirmed');
  assert.equal((await add(dates[5],'driver-other',{confirmedSeparateTrip:true})).body.error,'driver_create_unconfirmed');
  assert.equal(writes,before);
  // Unrelated jobs on the same date do not inherit the uncertain trip hold.
  assert.equal((await add(dates[5],'driver-unrelated',{to:'Different destination'})).status,503);
  assert.equal(writes,before+1);
  visibility = true;
  const recovered = await add(dates[5],'driver-lost-response');
  assert.equal(recovered.status,200);
  assert.equal(recovered.body.jobId,persisted(dates[5])[0].id);
  assert.equal(writes,before+1);
  console.log('PASS lost reply survives restart and stale lookup without a second write');

  mode = 'partial-readback';
  const partialAfterWrite = await add(dates[6],'driver-partial-readback');
  assert.equal(partialAfterWrite.body.error,'driver_create_unconfirmed');
  const writesAfterPartial = writes;
  mode = coverage = '';
  assert.equal((await add(dates[6],'driver-partial-readback')).body.jobId,persisted(dates[6])[0].id);
  assert.equal(writes,writesAfterPartial);
  visibility = false;
  assert.equal((await add(dates[6],'driver-partial-readback')).body.error,'driver_create_unconfirmed');
  assert.equal(writes,writesAfterPartial);
  console.log('PASS partial post-save readback and a later stale list cannot replay an existing create');
}
main().catch(error => { console.error(error); process.exitCode=1; }).finally(async () => {
  if (runtime) await runtime.dispose();
  fs.rmSync(folder,{recursive:true,force:true});
});
