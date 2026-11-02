const assert = require('node:assert/strict');
const {webcrypto} = require('node:crypto');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const ctx = vm.createContext({console, crypto:webcrypto});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../driver-storage.js'),'utf8'),ctx);
const api=ctx.PmgDriverStorage, today='2026-11-02';
const old='pmg_local_jobs_2026-10-01', current='pmg_local_jobs_'+today;
const rows=JSON.stringify([{id:'11111111-1111-4111-8111-111111111111',customer:'fixture',notes:'x'.repeat(1200),_driverAdded:false}]);
function store(entries, extra=100) {
 const map=new Map(entries); const capacity=[...map].reduce((sum,[k,v])=>sum+k.length+v.length,0)+extra;
 return {map, get length(){return map.size},key:i=>[...map.keys()][i]??null,getItem:k=>map.get(k)??null,removeItem:k=>map.delete(k),
 setItem(k,v){v=String(v);const size=[...map].filter(([key])=>key!==k).reduce((n,[key,value])=>n+key.length+value.length,0)+k.length+v.length;
 if(size>capacity){const e=new Error("Failed to execute 'setItem' on 'Storage': quota exceeded");e.name='QuotaExceededError';throw e;}map.set(k,v);}};
}
function archive() {const map=new Map();return {map,put:async r=>map.set(r.id,structuredClone(r)),get:async id=>map.get(id),close(){}};}
const cases=[];function test(name,run){cases.push({name,run});}
test('quota reproduced; lossless archive verified then completion space available',async()=>{
 const s=store([[old,rows],[current,'[]'],['pmg_walkaround_draft_v1','PHOTO-PRESERVE']]), a=archive();
 assert.throws(()=>s.setItem('new-proof','x'.repeat(300)),/quota/);
 const r=await api.ensureSpace({storage:s,today,reserveChars:300,archiveFactory:async()=>a});
 assert.equal(r.archivedCaches,1);assert.equal(s.getItem(old),null);assert.equal([...a.map.values()][0].raw,rows);
 assert.equal(s.getItem(current),'[]');assert.equal(s.getItem('pmg_walkaround_draft_v1'),'PHOTO-PRESERVE');s.setItem('new-proof','x'.repeat(300));
});
test('healthy storage never opens archive or changes existing bytes',async()=>{
 const s=store([[old,rows]],10000), before=[...s.map];
 await api.ensureSpace({storage:s,today,reserveChars:300,archiveFactory:()=>{throw Error('unexpected');}});assert.deepEqual([...s.map],before);
});
test('pending queues, journals, today, future and unknown data never eligible',()=>{
 for(const [key,value] of [
  ['pmg_writeback_queue_2026-10-01',JSON.stringify([{state:'failed'}])],
  ['pmg_retry_queue',JSON.stringify([{date:'2026-10-01',jobs:[{}]}])],
  ['pmg_backup_operation_2026-10-01_fixture','{}'],['pmg_backup_problem_2026-10-01','review'],
  ['pmg_writeback_queue_2026-10-01','broken'],['pmg_retry_queue','broken']
 ]) {const s=store([[old,rows],[key,value]]);assert.equal(api.eligible(s,old,today),false,key);}
 const s=store([[current,rows],['pmg_local_jobs_2026-11-03',rows],['pmg_walkaround_draft_v1',rows]]);
 for(const k of s.map.keys())assert.equal(api.eligible(s,k,today),false,k);
});
test('driver-added, proof-bearing, uncertain rows and malformed caches retained',()=>{
 for(const row of [{id:'driver-one'},{id:'11111111-1111-4111-8111-111111111111',_driverAdded:true},
 {id:'11111111-1111-4111-8111-111111111111',proofReceipt:{ok:true}},
 {id:'11111111-1111-4111-8111-111111111111',haultechWriteState:'pending Haultech'},null,{}]) {
 assert.equal(api.eligible(store([[old,JSON.stringify([row])]]),old,today),false);
 } assert.equal(api.eligible(store([[old,'broken']]),old,today),false);
});
test('archive commit failure keeps original and surfaces actionable error',async()=>{
 const s=store([[old,rows]]);await assert.rejects(api.ensureSpace({storage:s,today,reserveChars:300,archiveFactory:async()=>({put:async()=>{throw Error('disk full')},close(){}})}),/Keep this form open/);assert.equal(s.getItem(old),rows);
});
test('readback mismatch and read failure never delete original',async()=>{
 for(const fail of [false,true]) {
 const s=store([[old,rows]]),a=archive();a.get=async()=>{if(fail)throw Error('read failed');return {raw:'wrong'};};
 await assert.rejects(api.ensureSpace({storage:s,today,reserveChars:300,archiveFactory:async()=>a}),/storage/);assert.equal(s.getItem(old),rows);
 }
});
test('newer edit during archive is retained, old revision remains in archive',async()=>{
 const s=store([[old,rows]],2000),a=archive(),put=a.put;a.put=async r=>{await put(r);s.setItem(old,'[]');};
 assert.equal(await api.archiveOne(s,a,old,today),0);assert.equal(s.getItem(old),'[]');assert.equal([...a.map.values()][0].raw,rows);
});
test('pending write arriving during archive blocks removal',async()=>{
 const s=store([[old,rows]],2000),a=archive(),put=a.put;a.put=async r=>{await put(r);s.setItem('pmg_writeback_queue_2026-10-01','[{"state":"pending Haultech"}]');};
 assert.equal(await api.archiveOne(s,a,old,today),0);assert.equal(s.getItem(old),rows);
});
test('only pending or current data means explicit failure, no clearing',async()=>{
 const s=store([[current,rows],['pmg_retry_queue','[]']]),before=[...s.map];
 await assert.rejects(api.ensureSpace({storage:s,today,reserveChars:300}),/Do not clear app data/);assert.deepEqual([...s.map],before);
});
test('non-quota storage errors do not archive anything',async()=>{
 const s=store([[old,rows]]);s.setItem=()=>{throw Object.assign(Error('blocked'),{name:'SecurityError'})};
 await assert.rejects(api.ensureSpace({storage:s,today,reserveChars:300,archiveFactory:()=>{throw Error('must not open')}}),/storage/);assert.equal(s.getItem(old),rows);
});
test('interrupted committed copy does not overwrite earlier archive revision',async()=>{
 const s=store([[old,rows]],100),a=archive(),remove=s.removeItem;let interrupt=true;
 s.removeItem=k=>{if(k===old&&interrupt){interrupt=false;throw Error('interrupted')}return remove(k)};
 await assert.rejects(api.archiveOne(s,a,old,today),/interrupted/);assert.equal(s.getItem(old),rows);
 await api.archiveOne(s,a,old,today);assert.equal(a.map.size,2);assert.equal(s.getItem(old),null);
});
(async()=>{for(const {name,run} of cases){await run();console.log('PASS',name);}console.log(`${cases.length} storage recovery tests passed`);})().catch(e=>{console.error(e);process.exitCode=1});
