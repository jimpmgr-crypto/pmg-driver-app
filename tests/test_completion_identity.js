const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const html = fs.readFileSync(process.env.PMG_TEST_INDEX || path.join(__dirname, '../index.html'), 'utf8');
function fn(name) {
 const start=html.search(new RegExp('(?:async )?function '+name+'\\('));
 assert(start>=0,name);
 const next=html.slice(start+1).search(/\n(?:async )?function /);
 return html.slice(start,next<0?undefined:start+1+next).split('\n// ═')[0];
}
const ctx={console,Set,allJobs:[],getJobConsignment:j=>j?.consignments?.[0],getJobStatus:j=>j.status||'scheduled',toast:()=>{},activeJob:null};
vm.createContext(ctx);
for(const n of ['isGuidId','getHaultechJobId','driverMovementId','sameDriverAddedMovement','findMatchingLiveDriverJob'])vm.runInContext(fn(n),ctx);
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
const one={id:a,movementId:'driver-one',material:'6f2',quantity:20},two={...one,id:b,movementId:'driver-two'};
assert.equal(ctx.sameDriverAddedMovement(one,two),false,'two identical loads distinct');
assert.equal(ctx.sameDriverAddedMovement(one,{...two,movementId:'driver-one'}),false,'different live IDs never coalesce');
assert.equal(ctx.findMatchingLiveDriverJob(one,[two]),null,'real row cannot redirect');
assert.equal(ctx.findMatchingLiveDriverJob({id:'driver-one'},[one,two]),one,'temp resolves exact movement');
assert.equal(ctx.findMatchingLiveDriverJob({id:'driver-one'},[one,{...two,movementId:'driver-one'}]),null,'ambiguous movement holds');
assert.equal(ctx.findMatchingLiveDriverJob({id:'driver-legacy'},[{id:a,material:'6f2',quantity:20}]),null,'no fuzzy fallback');
assert.equal(ctx.getHaultechJobId({_haultechJobId:a,id:'driver-one'}),a,'cached real identity');
assert.equal(ctx.getHaultechJobId({consignments:[{id:b,jobId:a}]}),a,'consignment GUID is not job GUID');
assert.equal(ctx.getHaultechJobId({consignments:[{id:b}]}),null,'unknown job does not use consignment identity');
let queued=0,calls=0,release;
Object.assign(ctx,{
 activeJob:{...one},allJobs:[one,two],LIVE_WRITE:true,
 $:()=>({value:'',focus(){}}),getJobConsignmentId:()=>null,
 jobRequiresConcreteSource:()=>false,setSignCompleteBusy:()=>{},
 composeDriverHaultechNote:()=>'',applyDriverCompletionNote:()=>'',getSignSigData:()=> 'data:fixture',getJobWasteTransferNote:()=>null,
 queueTrialEvent:()=>{queued++;return {eventId:'proof-fixture'};},setQueueState:()=>{},signPhotoFile:null,
 fetch:async()=>({arrayBuffer:async()=>new ArrayBuffer(0)}),uploadProofAsset:async()=>({haultechUploaded:true,fallbackSaved:true}),summarizeProofResults:()=>'',
 getHaultechJobDate:()=> '2026-10-12',driverNoteLookupDates:()=>[],getJobRef:()=>'',
 api:async url=>{assert.equal(url,'/ht/complete/'+a);calls++;await new Promise(r=>release=r);return {ok:true,clone:()=>({json:async()=>({})})};},
 verifyHaultechCompletion:async()=>({ok:true}),POD_CODES:{success:'success'},currentUser:{name:'Fixture'},WORKER_URL:'fixture',API_KEY:'fixture',
 updateJobStatusLocal:(j,s)=>{j.status=s},saveJobsToCloud:async()=>{},todayISO:()=> '2026-10-12',showJobList:()=>{},renderJobs:()=>{},reloadForPendingServiceWorkerUpdate:()=>{}
});
const start=html.indexOf('async function handleSignComplete()');
const end=html.indexOf("$('sign-save-btn').addEventListener",start);
vm.runInContext('let signCompletionInFlight=false;\n'+html.slice(start,end),ctx);
(async()=>{
 const first=ctx.handleSignComplete();
 await ctx.handleSignComplete();
 while(!release)await new Promise(r=>setImmediate(r));
 assert.equal(queued,1);assert.equal(calls,1,'double tap only sends once');
 release();await first;await ctx.handleSignComplete();
 assert.equal(calls,1,'completed row cannot submit again');assert.equal(two.status,undefined,'other identical load unaffected');
 ctx.activeJob={id:'driver-one'};ctx.allJobs=[one,{...two,movementId:'driver-one'}];
 await ctx.handleSignComplete();assert.equal(calls,1,'ambiguous target no write');
 console.log('PASS identity, separate loads, cached ID, consignment ID, ambiguity, concurrent and repeated completion');
})().catch(e=>{console.error(e);process.exitCode=1});
