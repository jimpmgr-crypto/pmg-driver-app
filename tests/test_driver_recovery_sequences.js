const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(__dirname+'/../index.html','utf8');
const fn=n=>{let s=html.indexOf('function '+n+'(');assert(s>=0,n);if(html.slice(s-6,s)==='async ')s-=6;return html.slice(s,html.indexOf('\n}',s)+2);};
async function main(){
 const failures=[];async function check(name,run){try{await run();console.log('PASS '+name);}catch(e){failures.push(name+': '+e.message);console.error('FAIL '+name+': '+e.message);}}
 await check('invalid audit shapes survive a full sync indicator update with visible help',()=>{
  for(const raw of ['null','{}','[null]','[42]']){
   let label='',state='',stored=raw;
   const c=vm.createContext({currentUser:{name:'Fixture'},localStorage:{getItem:k=>k==='audit'?stored:null,setItem:(k,v)=>{if(k==='audit')stored=v;}},localQueueKey:()=> 'audit',localEventKey:()=> 'events',walkaroundTicketQueueKey:()=> 'prestart',getRetryQueue:()=>[],todayISO:()=> '2026-11-17',needsWritebackAttention:()=>false,document:{body:{classList:{add(){},remove(){}}}},$:()=>({classList:{add(){},remove(){}},querySelector:()=>({set textContent(v){label=v;}})}),updateSyncDot:v=>state=v});
   c.driverJournalReadError='';c.readDriverJournalValue=key=>c.localStorage.getItem(key);
   for(const n of ['readJSON','writeJSON','pendingStoreReadProblem','getWritebackQueue','setWritebackQueue','markDriverFailedWritebacksSavedLocally','updateSyncUI'])vm.runInContext(fn(n),c);
   c.updateSyncUI();assert.equal(state,'red');assert.match(label,/Original data retained/);assert.equal(stored,raw);
   assert.throws(()=>c.setWritebackQueue([]),/Original data retained/);assert.equal(stored,raw);
  }
 });
 await check('receipt race retains the exact journal until durable acknowledgement',async()=>{
  let finished=false,problem='',raw=JSON.stringify([{id:'one',notes:'old'}]);
  const c=vm.createContext({localStorage:{},currentUser:{name:'Fixture'},WORKER_URL:'fixture',API_KEY:'fixture',allJobs:[],driverFetch:async()=>({ok:true,json:async()=>({ok:true})}),PmgJobBackup:{prepare:async()=>({operations:[{operationId:'same-on-retry'}]}),accept(){},finish:async()=>{finished=true;},problem:(s,d,p,v)=>problem=v},PmgDriverStorage:{readJobRaw:async()=>raw,writeJobRaw:async()=>{raw=JSON.stringify([{id:'one',notes:'newer'}]);return false;}}});
  c.withDriverJournal=async(keys,change)=>change(c.localStorage);c.saveBackupProblem=async(date,payload,message)=>{problem=message;};
  vm.runInContext(fn('cloudPutJobs'),c);
  await assert.rejects(c.cloudPutJobs('2026-11-17',[{id:'one'}]),/changed|receipt|retained/i);
  assert.equal(finished,false,'CAS rejection must not delete replay identity');assert.match(problem,/changed|receipt|retained/i);assert.equal(JSON.parse(raw)[0].notes,'newer');
 });
 if(failures.length)throw Error(failures.join('\n'));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
