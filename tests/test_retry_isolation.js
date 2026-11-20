const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(__dirname+'/../index.html','utf8');
function fn(n){const s=html.indexOf('function '+n+'(');assert(s>=0,n);return html.slice(html.slice(s-6,s)==='async '?s-6:s,html.indexOf('\n}',s)+2);}
const clone=x=>JSON.parse(JSON.stringify(x));
async function run(){
 let q=[{date:'2026-11-16',jobs:[{id:'old',notes:'retain'}]},{date:'2026-11-17',jobs:[{id:'a',movementId:'driver-a',notes:'pending A'}],savedAt:'original'}];
 const c=vm.createContext({getRetryQueue:()=>clone(q),setRetryQueue:v=>q=clone(v),updateSyncUI(){},PmgJobBackup:{identity:r=>r.movementId||r.id},console});
 vm.runInContext(fn('addToRetryQueue'),c);
 c.withDriverJournal=async(keys,change)=>change({});
 await c.addToRetryQueue('2026-11-17',[{id:'b',movementId:'driver-b',notes:'pending B'}]);
 assert(q.some(e=>e.jobs.some(r=>r.id==='a')),'saving B must preserve exact unrelated pending A');
 assert.equal(q[0].jobs[0].notes,'retain');
 console.log('PASS saving a second row preserves previous pending work');
 const add=html.slice(html.indexOf("$('add-job-form').addEventListener('submit'"),html.indexOf('// PROBLEM / FEEDBACK'));
 assert(!add.includes('addToRetryQueue(localDate, existingLocal)'),'adding a row must not queue the full shared plan');
 assert(add.includes('addToRetryQueue(localDate, [localJob])'));
 console.log('PASS Add row only queues the new movement');
 let store=JSON.stringify([{id:'a',movementId:'driver-a',status:'scheduled',_backupRevision:1},{id:'b',notes:'other driver'}]);
 const original={id:'a',movementId:'driver-a',status:'scheduled',_backupRevision:1};
 const retried={...original,status:'complete',proofReceipt:{protected:true}};
 const m=vm.createContext({PmgJobBackup:{identity:r=>r.movementId||r.id,canonical:JSON.stringify,clean:r=>{const x={...r};delete x._backupRevision;return x;}},PmgDriverStorage:{readJobRaw:async()=>store,writeJobRaw:async(d,raw,expected)=>{if(store!==expected)return false;store=raw;return true;}}});
 vm.runInContext(fn('saveRetriedJobRows'),m);
 await m.saveRetriedJobRows('2026-11-17',[original],[retried]);
 assert.equal(JSON.parse(store).length,2,'partial retry must preserve full plan');assert.equal(JSON.parse(store)[0].status,'complete');
 store=JSON.stringify([{...original,status:'cancelled'},{id:'b',notes:'other driver'}]);
 await m.saveRetriedJobRows('2026-11-17',[original],[retried]);
 assert.equal(JSON.parse(store)[0].status,'cancelled','late retry must not replace newer cancellation');
 console.log('PASS partial retry preserves plan and newer edits');
 let releases; const hanging=new Promise(r=>releases=r);let loaded=false;
 const l=vm.createContext({document:{hidden:false},todayISO:()=> '2026-11-17',formatDate:x=>x,$:()=>({innerHTML:'',textContent:''}),showError(){},flushRetryQueue:()=>hanging,customers:[{}],api:async()=>{loaded=true;return {ok:true,json:async()=>({date:'2026-11-17',complete:true,state:'live',savedAt:'2026-11-17T10:00:00Z',jobs:[]})};},hydrateBackupRevisions:async(d,j)=>j,PmgDriverStorage:{readJobRaw:async()=> '[]'},mergeWithLocal:(d,j)=>j,renderJobs(){},saveRefreshedJobsLocally:async()=>{},console,updateSyncUI(){}});
 vm.runInContext(fn('loadJobs'),l);const loading=l.loadJobs({force:true});await new Promise(r=>setImmediate(r));assert(loaded,'a stuck old writeback must not hide the work plan');releases();await loading;
 console.log('PASS plan read is independent of a stuck retry');
}
run().catch(e=>{console.error(e);process.exitCode=1});
