const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../worker/plant-transaction.js'),'utf8');
const worker=fs.readFileSync(path.join(__dirname,'../worker/index.js'),'utf8');
const modulePromise=import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const eventKey='plant:manual-events:v1';
let sequence=0;const id=()=>`10000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;
const cases=[];const test=(name,run)=>cases.push({name,run});
function context(db) {
  let tail=Promise.resolve();
  return {storage:{sql:{exec(sql,...bindings){const stmt=db.prepare(sql);return stmt.columns().length?stmt.all(...bindings):(stmt.run(...bindings),[])}},
    transactionSync(run){db.exec('BEGIN');try{const value=run();db.exec('COMMIT');return value}catch(error){db.exec('ROLLBACK');throw error}}},
    blockConcurrencyWhile(run){const next=tail.then(run);tail=next.catch(()=>{});return next}};
}
function setup(file=':memory:') {
  const db=new DatabaseSync(file),ctx=context(db),values=new Map(),writes=[];
  const env={PMG_DATA:{async get(key){return values.get(key)??null},async put(key,value){writes.push(key);values.set(key,value)},async delete(key){values.delete(key)}}};
  const helpers=vm.createContext({PLANT_MANUAL_EVENTS_KEY:eventKey,safeArray:v=>Array.isArray(v)?v:[],cloneValue:v=>JSON.parse(JSON.stringify(v)),safeJsonParse:v=>{try{return JSON.parse(v)}catch{return null}}});
  for(const name of ['getKvJson','putKvJson','appendPlantEvent']){
    const start=worker.indexOf('async function '+name+'(');const next=worker.slice(start+1).search(/\n(?:async )?function /);
    vm.runInContext(worker.slice(start,start+1+next),helpers);
  }
  let calls=0;
  const execute=async(request,txEnv)=>{calls++;const body=await request.json();const event={id:'server-event-'+calls,assetId:body.assetId,date:body.date,description:body.workDone,sharePointWriteState:'queued_for_sharepoint_evidence'};await helpers.appendPlantEvent(txEnv,event);return Response.json({ok:true,event})};
  return {db,ctx,env,values,writes,execute,get calls(){return calls}};
}
const body=(requestId,extra={})=>({requestId,assetId:'plant-a',date:'2026-10-17',workDone:'Synthetic repair',...extra});
const request=value=>new Request('https://example.invalid/plant/service-events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
test('happy path atomically saves actual append function event and receipt',async()=>{
  const {handlePlantTransaction}=await modulePromise,f=setup(),key=id();const reply=await handlePlantTransaction(f.ctx,f.env,request(body(key)),f.execute);const result=await reply.json();
  assert.equal(result.requestId,key);assert.equal(result.ok,true);assert.equal(JSON.parse(f.values.get(eventKey)).length,1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM plant_receipts').get().n,1);f.db.close();
});
test('response loss and coordinator restart return original receipt without another SharePoint event',async()=>{
  const {handlePlantTransaction}=await modulePromise,dir=fs.mkdtempSync(path.join(os.tmpdir(),'plant-receipt-')),file=path.join(dir,'db.sqlite'),f=setup(file),key=id();
  const original=await (await handlePlantTransaction(f.ctx,f.env,request(body(key)),f.execute)).text();f.db.close();
  const restarted=setup(file);const replay=await (await handlePlantTransaction(restarted.ctx,restarted.env,request(body(key)),restarted.execute)).text();assert.equal(replay,original);assert.equal(restarted.calls,0);
  const stored=JSON.parse(restarted.db.prepare('SELECT value FROM plant_documents WHERE key=?').get(eventKey).value);assert.equal(stored.length,1);assert.equal(stored[0].sharePointWriteState,'queued_for_sharepoint_evidence');restarted.db.close();fs.rmSync(dir,{recursive:true,force:true});
});
test('concurrent exact repeats execute once and return same receipt',async()=>{
  const {handlePlantTransaction}=await modulePromise,f=setup(),key=id();const replies=await Promise.all(Array.from({length:8},()=>handlePlantTransaction(f.ctx,f.env,request(body(key)),f.execute)));const results=await Promise.all(replies.map(r=>r.text()));
  assert.equal(new Set(results).size,1);assert.equal(f.calls,1);assert.equal(JSON.parse(f.values.get(eventKey)).length,1);f.db.close();
});
test('concurrent different requests retain both shared-array events',async()=>{
  const {handlePlantTransaction}=await modulePromise,f=setup();await Promise.all([handlePlantTransaction(f.ctx,f.env,request(body(id())),f.execute),handlePlantTransaction(f.ctx,f.env,request(body(id(),{assetId:'plant-b'})),f.execute)]);
  assert.equal(JSON.parse(f.values.get(eventKey)).length,2);assert.equal(f.calls,2);f.db.close();
});
test('same ID and changed payload conflicts without mutation; JSON key order may differ',async()=>{
  const {handlePlantTransaction}=await modulePromise,f=setup(),key=id();const original=body(key);await handlePlantTransaction(f.ctx,f.env,request(original),f.execute);
  const ordered=Object.fromEntries(Object.entries(original).reverse());assert.equal((await handlePlantTransaction(f.ctx,f.env,request(ordered),f.execute)).status,200);
  const conflict=await handlePlantTransaction(f.ctx,f.env,request(body(key,{workDone:'Changed'})),f.execute);assert.equal(conflict.status,409);assert.equal((await conflict.json()).error,'plant_request_payload_conflict');assert.equal(f.calls,1);f.db.close();
});
test('handler failure discards all buffered documents and has no receipt',async()=>{
  const {handlePlantTransaction}=await modulePromise,f=setup(),key=id();const failure=await handlePlantTransaction(f.ctx,f.env,request(body(key)),async(req,env)=>{await env.PMG_DATA.put('plant:asset-overrides:v1','{"partial":true}');await env.PMG_DATA.put(eventKey,'[]');throw Error('Injected failure')});
  assert.equal(failure.status,503);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM plant_documents').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM plant_receipts').get().n,0);assert.equal(f.writes.length,0);
  assert.equal((await handlePlantTransaction(f.ctx,f.env,request(body(key)),f.execute)).status,200);f.db.close();
});
test('SQL commit failure rolls back both document and receipt, original request can retry',async()=>{
  const {handlePlantTransaction}=await modulePromise,f=setup(),key=id(),original=f.ctx.storage.sql.exec;let fail=true;
  f.ctx.storage.sql.exec=(sql,...args)=>{if(fail&&sql.startsWith('INSERT INTO plant_receipts')){fail=false;throw Error('Injected receipt failure')}return original(sql,...args)};
  assert.equal((await handlePlantTransaction(f.ctx,f.env,request(body(key)),f.execute)).status,503);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM plant_documents').get().n,0);assert.equal(f.writes.length,0);
  assert.equal((await handlePlantTransaction(f.ctx,f.env,request(body(key)),f.execute)).status,200);assert.equal(JSON.parse(f.values.get(eventKey)).length,1);f.db.close();
});
test('mirror failure cannot undo commit or duplicate event on retry',async()=>{
  const {handlePlantTransaction}=await modulePromise,f=setup(),key=id();f.env.PMG_DATA.put=async()=>{throw Error('KV down')};const first=await handlePlantTransaction(f.ctx,f.env,request(body(key)),f.execute);
  assert.equal(first.status,200);assert.equal((await handlePlantTransaction(f.ctx,f.env,request(body(key)),f.execute)).status,200);assert.equal(f.calls,1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM plant_documents').get().n,1);f.db.close();
});
test('authoritative reads ignore stale KV and tombstones prevent resurrection',async()=>{
  const {handlePlantTransaction}=await modulePromise,f=setup();f.values.set(eventKey,'[{"id":"old"}]');await handlePlantTransaction(f.ctx,f.env,new Request('https://internal/plant/test',{method:'DELETE'}),async(req,env)=>{await env.PMG_DATA.delete(eventKey);return Response.json({ok:true})});f.values.set(eventKey,'[{"id":"stale"}]');
  const read=await handlePlantTransaction(f.ctx,f.env,new Request('https://internal/__plant_document?key='+encodeURIComponent(eventKey)),f.execute);assert.deepEqual(await read.json(),{value:null});assert.equal(f.calls,0);f.db.close();
});
test('legacy clients missing request identity fail closed before mutation',async()=>{
  const {handlePlantTransaction}=await modulePromise,f=setup();const value=body(id());delete value.requestId;const reply=await handlePlantTransaction(f.ctx,f.env,request(value),f.execute);assert.equal(reply.status,409);assert.equal((await reply.json()).error,'plant_update_required_reload');assert.equal(f.calls,0);f.db.close();
});
test('internal scheduler state uses same authority without a UI identity',async()=>{
  const {handlePlantTransaction}=await modulePromise,f=setup();const reply=await handlePlantTransaction(f.ctx,f.env,new Request('https://internal/__plant_schedule',{method:'POST'}),async(req,env)=>{await env.PMG_DATA.put('plant:push-last-run:v1','{"status":"synthetic-no-send"}');return Response.json({ok:true})});
  assert.equal(reply.status,200);assert.equal(f.db.prepare('SELECT value FROM plant_documents WHERE key=?').get('plant:push-last-run:v1').value,'{"status":"synthetic-no-send"}');f.db.close();
});
test('Plant torque read retains ticket listing and bulk-read adapter compatibility',async()=>{
  const {handlePlantTransaction}=await modulePromise,f=setup();f.env.PMG_DATA.list=async()=>({keys:[{name:'ticket:synthetic'}],list_complete:true});f.env.PMG_DATA.get=async keys=>new Map(keys.map(key=>[key,'{"type":"driver_walkaround"}']));
  const reply=await handlePlantTransaction(f.ctx,f.env,new Request('https://internal/plant/driver-torque?vehicle=SYNTHETIC'),async(req,env)=>{const list=await env.PMG_DATA.list({prefix:'ticket:'});const values=await env.PMG_DATA.get(list.keys.map(key=>key.name));return Response.json({ticket:JSON.parse(values.get('ticket:synthetic'))})});
  assert.deepEqual(await reply.json(),{ticket:{type:'driver_walkaround'}});f.db.close();
});
(async()=>{const results=[];for(const {name,run} of cases){try{await run();results.push({name,passed:true})}catch(e){results.push({name,passed:false,error:e.stack})}}for(const r of results)console.log(`${r.passed?'PASS':'FAIL'} ${r.name}${r.passed?'':': '+r.error}`);console.log(`${results.filter(r=>r.passed).length}/${results.length} Plant transaction checks passed`);if(process.env.PMG_PLANT_TRANSACTION_REPORT)fs.writeFileSync(process.env.PMG_PLANT_TRANSACTION_REPORT,JSON.stringify(results,null,2)+'\n');if(results.some(r=>!r.passed))process.exitCode=1})().catch(error=>{console.error(error);process.exitCode=1});
