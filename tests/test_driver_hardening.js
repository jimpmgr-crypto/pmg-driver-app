const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(__dirname+'/../index.html','utf8');
const fn=n=>{let s=html.indexOf('function '+n+'(');assert(s>=0,n);if(html.slice(s-6,s)==='async ')s-=6;return html.slice(s,html.indexOf('\n}',s)+2);};
const tick=()=>new Promise(r=>setImmediate(r));
async function main(){
 const failures=[];async function check(name,run){try{await run();console.log('PASS '+name);}catch(e){failures.push(name+': '+e.message);console.error('FAIL '+name+': '+e.message);}}
 await check('corrupt retry record cannot be silently replaced',async()=>{
  let raw='{broken original';const c=vm.createContext({localStorage:{getItem:()=>raw,setItem:(k,v)=>raw=v},PmgJobBackup:{identity:r=>r.id},updateSyncUI(){}});
  c.withDriverJournal=async(keys,change)=>change(c.localStorage);
  for(const n of ['getRetryQueue','setRetryQueue','addToRetryQueue'])vm.runInContext(fn(n),c);
  await assert.rejects(()=>c.addToRetryQueue('2026-11-17',[{id:'new'}]),/read|retained/i);assert.equal(raw,'{broken original');
 });
 await check('corrupt audit and pre-start queues are preserved and visibly require help',()=>{
  for(const bad of ['{broken original','{"unexpected":"object"}']){
   const data=new Map([['audit',bad]]);const c=vm.createContext({localStorage:{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)},localQueueKey:()=> 'audit',localEventKey:()=> 'events',walkaroundTicketQueueKey:()=> 'prestart'});
   c.driverJournalReadError='';c.readDriverJournalValue=key=>c.localStorage.getItem(key);
   vm.runInContext(fn('writeJSON')+'\n'+fn('pendingStoreReadProblem'),c);
   assert.match(c.pendingStoreReadProblem(),/Original data retained/);assert.throws(()=>c.writeJSON('audit',[]),/Original data retained/);assert.equal(data.get('audit'),bad);
   data.delete('audit');data.set('prestart',bad);assert.match(c.pendingStoreReadProblem(),/Original data retained/);assert.throws(()=>c.writeJSON('prestart',[]));assert.equal(data.get('prestart'),bad);
  }
 });
 function setup({lateFailure=false}={}){
  let raw=JSON.stringify([{id:'other',notes:'before'}]),calls=0,release,closed=false,notice='';
  const elements=new Map(),values={'f-customer':'Synthetic customer','f-qty':'20','f-unit':'t','f-material':'Synthetic aggregate','f-ref':'SYNTHETIC-ONLY','f-notes':'Synthetic test','f-from':'Yard','f-to':'Fixture','f-vehicle':'TEST'};
  const $=id=>{if(!elements.has(id))elements.set(id,{value:values[id]||'',disabled:false,classList:{add(){if(id==='add-job-modal')closed=true;}},reset(){},focus(){}});return elements.get(id);};
  const c=vm.createContext({console,crypto:{randomUUID:()=> 'one'},Math,Date,document:{querySelector:()=>null},$,todayISO:()=> '2026-11-17',isA1DriverCustomer:()=>false,collectedConcreteQuote:()=>null,isConcreteEntryCandidate:()=>false,driverEnteredPricePayload:()=>null,buildAddJobWasteTransferNote:()=>null,setSelectedDriverVehicle(){},LIVE_WRITE:true,currentUser:{name:'Fixture'},selectedAddresses:{},fSigCanvas:null,fSigCtx:null,fPhotoFile:null,saveAddedJobProof:async()=>null,localGetJobs:async()=>JSON.parse(raw),PmgDriverStorage:{readJobRaw:async()=>raw,writeJobRaw:async(d,v,expected)=>{if(expected!==undefined&&expected!==raw)return false;raw=v;return true;}},PmgJobBackup:{identity:r=>r.movementId||r.id,clean:r=>r,canonical:JSON.stringify},getRetryQueue:()=>[],addToRetryQueue(){},updateSyncUI(){},DRIVER_ADDED_BACKUP_REASON:'Waiting',DRIVER_ADDED_LIVE_REASON:'Confirmed',submitDriverAddedRow:async()=>{calls++;await new Promise(r=>release=r);return {jobId:'live-fixture'};},queueTrialEvent(){if(lateFailure)throw Error('late phone quota');},allJobs:[],cachedDriverFields:()=>({}),getCollectionAddress:()=>null,getDeliveryAddress:()=>null,updateA1PaymentFields(){},updateWasteFieldsVisibility(){},showJobConfirmation(){},renderJobs(){},loadJobs:async()=>{},showError:x=>notice=x,toast:x=>notice=x});
  for(const n of ['saveRetriedJobRows','saveNewDriverRow','finishAddedJobForm'])if(html.includes('function '+n+'('))vm.runInContext(fn(n),c);
  const start=html.indexOf("$('add-job-form').addEventListener('submit', async (e) => {");
  const end=html.indexOf('\n});',start);
  vm.runInContext('var submit = async (e) => {'+html.slice(start+"$('add-job-form').addEventListener('submit', async (e) => {".length,end)+'\n};',c);
  return {c,raw:()=>raw,replace:v=>raw=v,calls:()=>calls,closed:()=>closed,notice:()=>notice,release:()=>release?.(),ready:()=>!!release};
 }
 await check('late Add Job receipt preserves concurrently changed other work',async()=>{
  const x=setup(),pending=x.c.submit({preventDefault(){}});for(let i=0;i<30&&!x.ready();i++)await tick();assert(x.ready());
  const rows=JSON.parse(x.raw());rows[0].notes='newer completion';rows.push({id:'second',notes:'added elsewhere'});x.replace(JSON.stringify(rows));x.release();await pending;
  const saved=JSON.parse(x.raw());assert.equal(saved[0].notes,'newer completion');assert(saved.some(r=>r.id==='second'));assert.equal(saved.find(r=>r.id==='driver-one').haultechJobId,'live-fixture');
 });
 await check('row saved before a late error closes Add form with truthful warning',async()=>{
  const x=setup({lateFailure:true}),pending=x.c.submit({preventDefault(){}});for(let i=0;i<30&&!x.ready();i++)await tick();assert(x.ready());x.release();await pending;
  assert(x.closed(),'already saved movement must not leave an inviting resubmit form');assert.match(x.notice(),/saved.*office|saved.*check/i);assert.doesNotMatch(x.notice(),/Failed to save row/);assert.equal(x.calls(),1);assert.equal(JSON.parse(x.raw()).filter(r=>r.id==='driver-one').length,1);
 });
 if(failures.length)throw Error(failures.join('\n'));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
