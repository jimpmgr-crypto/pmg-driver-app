const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createJournal, canonical} = require('../plant-write-journal.js');
const html = fs.readFileSync(path.join(__dirname, '../plant.html'), 'utf8');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function durableStore() {
  const values = new Map();let tail = Promise.resolve();
  return {values,
    mutate(scope, change) {const operation=tail.then(()=>{const next=change(clone(values.get(scope)));values.set(scope,clone(next));return clone(next)});tail=operation.catch(()=>{});return operation},
    async list(){await tail;return [...values.values()].map(clone)}
  };
}
function load(ctx, name) {
  const start=html.search(new RegExp('(?:async )?function '+name+'\\('));assert(start>=0,name);
  const end=html.slice(start+1).search(/\n    (?:async )?function /);
  vm.runInContext(html.slice(start,end<0?html.indexOf('</script>',start):start+1+end),ctx);
}
const payload={assetId:'plant-a',date:'2026-10-17',workDone:'Synthetic repair',plantNumber:'A'};
let sequence=0;const uuid=()=>`00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;
function harness(store=durableStore()) {
  const journal=createJournal(store,uuid),messages=[];
  const ctx=vm.createContext({console,getPlantWriteJournal:()=>journal,renderPendingPlantWrites(){},
    api:async()=>{throw Error('No test response')},plantIdentityAcknowledged:()=>true,
    plantRetryScopes:new Set(),plantNewWriteIntents:new Map(),els:{serviceForm:{},assetForm:{},identityForm:{}},state:{workerOnline:true,selectedId:'plant-b'},toast:m=>messages.push(m)});
  for(const name of ['plantWriteReceiptMatches','submitPlantWrite','retryPendingPlantWrite'])load(ctx,name);
  return {ctx,journal,store,messages};
}
const serviceReply=body=>({ok:true,requestId:body.requestId,event:{id:'event-'+body.requestId,assetId:body.assetId,date:body.date}});
const cases=[];const test=(name,run)=>cases.push({name,run});
test('canonical identity preserves values and ignores object key order',()=>{
  assert.equal(canonical({b:2,a:{x:'A&B',y:[1,null]}}),canonical({a:{y:[1,null],x:'A&B'},b:2}));assert.notEqual(canonical({a:0}),canonical({a:null}));assert.throws(()=>canonical({a:Infinity}));
});
test('concurrent tabs share one durable pending request identity',async()=>{
  const store=durableStore(),a=createJournal(store,uuid),b=createJournal(store,uuid);
  const values=await Promise.all([a.prepare('service','/plant/service-events','POST',payload),b.prepare('service','/plant/service-events','POST',payload)]);
  assert.equal(values[0].requestId,values[1].requestId);assert.equal((await a.pending()).length,1);
});
test('reload recovers original request and changed pending data is blocked',async()=>{
  const store=durableStore();const first=await createJournal(store,uuid).prepare('service','/plant/service-events','POST',payload);
  const reloaded=createJournal(store,uuid);assert.equal((await reloaded.prepare('service','/plant/service-events','POST',clone(payload))).requestId,first.requestId);
  await assert.rejects(reloaded.prepare('service','/plant/service-events','POST',{...payload,workDone:'Changed'}),/previous save/);assert.equal((await reloaded.pending())[0].payload.workDone,payload.workDone);
});
test('a confirmed completed form does not suppress a later intentional identical save',async()=>{
  const h=harness();const first=await h.journal.prepare('service','/plant/service-events','POST',payload);await h.journal.confirm(first,serviceReply({...payload,requestId:first.requestId}));
  assert.equal((await h.journal.pending()).length,0);const replay=await h.journal.prepare('service','/plant/service-events','POST',payload);assert.equal(replay.requestId,first.requestId);const same=await h.journal.prepare('service','/plant/service-events','POST',payload,true);assert.notEqual(same.requestId,first.requestId);await h.journal.confirm(same,serviceReply({...payload,requestId:same.requestId}));
  const next=await h.journal.prepare('service','/plant/service-events','POST',{...payload,workDone:'Second repair'});assert.notEqual(next.requestId,first.requestId);
});
test('durability failure prevents any network write',async()=>{
  const h=harness({mutate:async()=>{throw Error('Storage failed')},list:async()=>[]});let calls=0;h.ctx.api=async()=>{calls++;return {}};
  await assert.rejects(h.ctx.submitPlantWrite('service','/plant/service-events','POST',payload),/Storage failed/);assert.equal(calls,0);
});
test('lost response then reload retries exact request without another server event',async()=>{
  const store=durableStore(),receipts=new Map(),bodies=[];let loseReply=true,events=0;
  const server=async(path,opts)=>{const body=JSON.parse(opts.body);bodies.push(body);if(!receipts.has(body.requestId)){events++;receipts.set(body.requestId,serviceReply(body))}if(loseReply){loseReply=false;throw Error('Response lost')}return clone(receipts.get(body.requestId))};
  const first=harness(store);first.ctx.api=server;await assert.rejects(first.ctx.submitPlantWrite('service','/plant/service-events','POST',payload),/Response lost/);
  const reloaded=harness(store);reloaded.ctx.api=server;const result=await reloaded.ctx.submitPlantWrite('service','/plant/service-events','POST',payload);
  assert.equal(events,1);assert.deepEqual(bodies[0],bodies[1]);assert.equal(result.requestId,bodies[0].requestId);assert.equal((await reloaded.journal.pending()).length,0);
});
for(const fault of ['requestId','assetId','date','missingEvent'])test('unbound receipt remains pending: '+fault,async()=>{
  const h=harness();h.ctx.api=async(path,opts)=>{const result=serviceReply(JSON.parse(opts.body));if(fault==='requestId')result.requestId='other';else if(fault==='missingEvent')delete result.event;else result.event[fault]='other';return result};
  await assert.rejects(h.ctx.submitPlantWrite('service','/plant/service-events','POST',payload),/not confirmed/);assert.equal((await h.journal.pending()).length,1);
});
test('local confirmation failure preserves durable identity but does not deny server save',async()=>{
  const store=durableStore(),original=store.mutate;store.mutate=(scope,change)=>original(scope,current=>{const next=change(current);if(next.status==='confirmed')throw Error('Receipt disk failure');return next});
  const h=harness(store),ids=[];h.ctx.api=async(path,opts)=>{const body=JSON.parse(opts.body);ids.push(body.requestId);return serviceReply(body)};
  await h.ctx.submitPlantWrite('service','/plant/service-events','POST',payload);await h.ctx.submitPlantWrite('service','/plant/service-events','POST',payload);
  assert.equal(ids[0],ids[1]);assert.equal((await h.journal.pending()).length,1);
});
test('manual recovery preserves newer selection and typed draft',async()=>{
  const h=harness();const entry=await h.journal.prepare('service','/plant/service-events','POST',payload);h.ctx.els={identityForm:{value:'New B draft'}};
  h.ctx.api=async(path,opts)=>serviceReply(JSON.parse(opts.body));await h.ctx.retryPendingPlantWrite(entry.scope);
  assert.equal(h.ctx.state.selectedId,'plant-b');assert.equal(h.ctx.els.identityForm.value,'New B draft');assert(h.messages.some(m=>m.includes('Original save confirmed')));assert.equal((await h.journal.pending()).length,0);
});
test('all three save handlers use durable transport',()=>{for(const kind of ['service','asset','identity'])assert(html.includes("await submitPlantWrite('"+kind+"'"));assert(html.includes('src="/plant-write-journal.js"'));assert(html.includes('data-plant-retry'))});
test('invalid journal routes and methods fail closed',async()=>{
  const h=harness();await assert.rejects(h.journal.prepare('service','/plant/service-events','DELETE',payload));await assert.rejects(h.journal.prepare('identity','/other','PATCH',{}));await assert.rejects(h.journal.prepare('service','/plant/service-events','POST',{}));
});
test('retry-original followed by unchanged form submit cannot create another event',async()=>{
  const h=harness(),ids=[];h.ctx.api=async(path,opts)=>{const body=JSON.parse(opts.body);ids.push(body.requestId);return serviceReply(body)};
  const entry=await h.journal.prepare('service','/plant/service-events','POST',payload,true,'intent-current');h.ctx.plantNewWriteIntents.set(h.ctx.els.serviceForm,'intent-current');await h.ctx.retryPendingPlantWrite(entry.scope);await h.ctx.submitPlantWrite('service','/plant/service-events','POST',payload);assert.equal(ids[0],ids[1]);
  h.ctx.plantNewWriteIntents.set(h.ctx.els.serviceForm,'intent-current');await h.ctx.submitPlantWrite('service','/plant/service-events','POST',payload);assert.notEqual(ids[2],ids[1]);
});
test('definite validation rejection permits corrected data without blocking safe retry',async()=>{
  const h=harness();h.ctx.api=async()=>{const error=Error('bad_date');error.status=400;throw error};await assert.rejects(h.ctx.submitPlantWrite('service','/plant/service-events','POST',payload),/bad_date/);assert.equal((await h.journal.pending()).length,0);
  h.ctx.api=async(path,opts)=>serviceReply(JSON.parse(opts.body));assert.equal((await h.ctx.submitPlantWrite('service','/plant/service-events','POST',{...payload,date:'2026-10-18'})).ok,true);
});
test('retry for A cannot consume a newer intentional identical B draft',async()=>{
  const h=harness(),b={...payload,assetId:'plant-b'},ids=[];h.ctx.api=async(path,opts)=>{const body=JSON.parse(opts.body);ids.push(body.requestId);return serviceReply(body)};
  const previousB=await h.journal.prepare('service','/plant/service-events','POST',b);await h.journal.confirm(previousB,serviceReply({...b,requestId:previousB.requestId}));
  const a=await h.journal.prepare('service','/plant/service-events','POST',payload,true,'intent-a');h.ctx.plantNewWriteIntents.set(h.ctx.els.serviceForm,'intent-new-b');await h.ctx.retryPendingPlantWrite(a.scope);
  assert.equal(h.ctx.plantNewWriteIntents.get(h.ctx.els.serviceForm),'intent-new-b');const result=await h.ctx.submitPlantWrite('service','/plant/service-events','POST',b);assert.notEqual(result.requestId,previousB.requestId);
});
test('normal async acknowledgement cannot consume an input token created later',async()=>{
  const h=harness();let release;h.ctx.api=(path,opts)=>new Promise(resolve=>{release=()=>resolve(serviceReply(JSON.parse(opts.body)))});h.ctx.plantNewWriteIntents.set(h.ctx.els.serviceForm,'before');const request=h.ctx.submitPlantWrite('service','/plant/service-events','POST',payload);
  await new Promise(resolve=>setImmediate(resolve));h.ctx.plantNewWriteIntents.set(h.ctx.els.serviceForm,'after');release();await request;assert.equal(h.ctx.plantNewWriteIntents.get(h.ctx.els.serviceForm),'after');
});
for(const replace of [false,true])test('recovery retains exact original after another tab '+(replace?'replaces':'confirms')+' its journal entry',async()=>{
  const h=harness(),ids=[];h.ctx.api=async(path,opts)=>{const body=JSON.parse(opts.body);ids.push(body.requestId);return serviceReply(body)};
  const original=await h.journal.prepare('service','/plant/service-events','POST',payload,true,'old');
  const pending=h.journal.pending.bind(h.journal);let newer;
  h.journal.pending=async()=>{const captured=await pending();await h.journal.confirm(original,serviceReply({...payload,requestId:original.requestId}));if(replace)newer=await h.journal.prepare('service','/plant/service-events','POST',payload,true,'other-tab');return captured};
  h.ctx.plantNewWriteIntents.set(h.ctx.els.serviceForm,'current-draft');await h.ctx.retryPendingPlantWrite(original.scope);
  assert.deepEqual(ids,[original.requestId]);assert.equal(h.ctx.plantNewWriteIntents.get(h.ctx.els.serviceForm),'current-draft');
  const remaining=await pending();assert.equal(remaining.length,replace?1:0);if(replace)assert.equal(remaining[0].requestId,newer.requestId);
});
(async()=>{const results=[];for(const {name,run} of cases){try{await run();results.push({name,passed:true})}catch(e){results.push({name,passed:false,error:e.stack})}}for(const r of results)console.log(`${r.passed?'PASS':'FAIL'} ${r.name}${r.passed?'':': '+r.error}`);console.log(`${results.filter(r=>r.passed).length}/${results.length} Plant idempotency checks passed`);if(process.env.PMG_PLANT_IDEMPOTENCY_REPORT)fs.writeFileSync(process.env.PMG_PLANT_IDEMPOTENCY_REPORT,JSON.stringify(results,null,2)+'\n');if(results.some(r=>!r.passed))process.exitCode=1})().catch(error=>{console.error(error);process.exitCode=1});
