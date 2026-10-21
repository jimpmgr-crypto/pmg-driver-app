const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function fn(name) {
  const start=source.indexOf(`function ${name}(`);
  assert(start>=0, name);
  const next=source.indexOf('\nfunction ',start+1);
  return source.slice(start,next<0?undefined:next).replace(/\n(?:async )?$/, '');
}
function setup() {
 const data=new Map(), timers=[];
 const c={console,Date,JSON,Map, Object, Array, String, Number, currentUser:{driverId:'richard-test',name:'Richard test'}, currentScreen:'jobs',isManager:false,
 WALKAROUND_DRAFT_KEY:'pmg_walkaround_draft_v1',walkaroundUnitSelectorsOpen:false,TORQUE_REFRESH_MS:60000,
 localStorage:{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)},
 todayISO:()=> '2026-10-21',readJSON:(k,d)=>data.has(k)?JSON.parse(data.get(k)):d,writeJSON:(k,v)=>data.set(k,JSON.stringify(v)),
 isWalkaroundVisible:()=>true,esc:String,vehicleOptionsHTML:()=>'<option>LL21HJJ</option><option>YJ13GRF</option>',trailerOptionsHTML:()=>'',
 torqueCheckState:{vehicle:'LL21HJJ',loadedAt:Date.now(),tasks:[],loading:false,error:''},
 renderJobs:()=>{},toast:()=>{},focusWalkaroundGate:()=>{},setTimeout:f=>timers.push(f),showWalkaroundScreen:()=>c.opened=true,
 walkaroundState:{checks:{brakes:'yes'},photos:{},photoDataUrls:{},defectNotes:'LL draft'},
 };
 vm.createContext(c);
 const names=['driverVehicleStorageKey','getSelectedDriverVehicle','setSelectedDriverVehicle','driverTrailerStorageKey','getSelectedDriverTrailer','setSelectedDriverTrailer','safeIdPart','walkaroundStorageKeyFor','walkaroundStorageKey','getLocalWalkaroundRecord','setLocalWalkaroundRecord','normaliseVehicleRef','safeList','torqueCacheKey','torqueTaskId','readCachedTorqueTasks','writeCachedTorqueTasks','currentTorqueTasks','torqueConfirmationsFromRecord','recordConfirmsTorqueTask','pendingTorqueTasksForSelectedVehicle','renderTorqueGateStatus','hasSelectedWalkaroundComplete','selectedWalkaroundLabel','walkaroundDraftIdentity','walkaroundDraftMatches','walkaroundDraftStorageKey','migrateLegacyWalkaroundDraft','getSelectedWalkaroundDraft','saveWalkaroundDraft','clearWalkaroundDraft','renderWalkaroundPanel','attachWalkaroundPanelListeners','resumeWalkaroundDraftAfterEnter'];
 names.forEach(n=>vm.runInContext(fn(n),c));
 c.ensureTorqueChecksForSelectedVehicle=()=>{};
 c.setSelectedDriverVehicle('LL21HJJ');c.setSelectedDriverTrailer('');
 return {c,data,timers};
}
let count=0;
function test(name,f){f();count++;console.log('PASS '+name)}
const record={date:'2026-10-21',driverId:'richard-test',vehicle:'LL21HJJ',trailer:'',completedAt:'2026-10-21T05:27:13Z',syncState:'saved_to_worker'};
test('completed truck keeps change action and compact selectors; open state survives rerender',()=>{
 const {c}=setup();c.setLocalWalkaroundRecord(record);
 assert(c.hasSelectedWalkaroundComplete());
 assert(c.renderWalkaroundPanel().includes('id="change-walkaround-vehicle-btn"'));
 assert(c.renderWalkaroundPanel().includes('class="form-row hidden" id="walkaround-unit-selectors"'));
 c.walkaroundUnitSelectorsOpen=true;
 assert(c.renderWalkaroundPanel().includes('class="form-row " id="walkaround-unit-selectors"'));
 assert(c.renderWalkaroundPanel().includes('aria-expanded="true"'));
});
test('LL clearance does not clear YJ; switching back reuses LL only after torque verification',()=>{
 const {c}=setup();c.setLocalWalkaroundRecord(record);c.setSelectedDriverVehicle('YJ13GRF');
 assert(!c.hasSelectedWalkaroundComplete());assert.equal(c.getLocalWalkaroundRecord(),null);
 c.setSelectedDriverVehicle('LL21HJJ');c.torqueCheckState.loading=true;assert(!c.hasSelectedWalkaroundComplete());
 c.torqueCheckState.loading=false;assert(c.hasSelectedWalkaroundComplete());
 c.torqueCheckState.error='offline';assert(!c.hasSelectedWalkaroundComplete());
});
test('trailer change requires separate evidence; delayed no-trailer retry cannot clear attached trailer',()=>{
 const {c,data}=setup();c.setLocalWalkaroundRecord(record);c.setSelectedDriverTrailer('C552979');
 c.setLocalWalkaroundRecord(record);assert.equal(c.getLocalWalkaroundRecord(),null);
 data.set(c.walkaroundStorageKey(),JSON.stringify(record));assert.equal(c.getLocalWalkaroundRecord(),null);
 c.setSelectedDriverTrailer('');assert(c.hasSelectedWalkaroundComplete());
});
test('old-day record cannot clear selected unit even in wrong key',()=>{
 const {c,data}=setup();data.set(c.walkaroundStorageKey(),JSON.stringify({...record,date:'2026-10-20'}));assert(!c.hasSelectedWalkaroundComplete());
});
test('separate truck and trailer drafts survive switching and clear only their own unit',()=>{
 const {c}=setup();c.saveWalkaroundDraft();const llKey=c.walkaroundDraftStorageKey();
 c.setSelectedDriverVehicle('YJ13GRF');assert.equal(c.getSelectedWalkaroundDraft(),null);c.walkaroundState.defectNotes='YJ draft';c.saveWalkaroundDraft();
 c.setSelectedDriverTrailer('C552979');assert.equal(c.getSelectedWalkaroundDraft(),null);c.walkaroundState.defectNotes='Trailer draft';c.saveWalkaroundDraft();c.clearWalkaroundDraft();
 c.setSelectedDriverTrailer('');assert.equal(c.getSelectedWalkaroundDraft().defectNotes,'YJ draft');c.clearWalkaroundDraft();
 c.setSelectedDriverVehicle('LL21HJJ');assert.equal(c.getSelectedWalkaroundDraft().defectNotes,'LL draft');assert.equal(c.walkaroundDraftStorageKey(),llKey);
});
test('legacy draft migrates without reselecting the old vehicle on reopen',()=>{
 const {c,data,timers}=setup();data.set(c.WALKAROUND_DRAFT_KEY,JSON.stringify({...c.walkaroundDraftIdentity(),active:true,defectNotes:'legacy'}));
 c.setSelectedDriverVehicle('YJ13GRF');c.resumeWalkaroundDraftAfterEnter();assert.equal(timers.length,0);assert.equal(c.getSelectedDriverVehicle(),'YJ13GRF');
 c.setSelectedDriverVehicle('LL21HJJ');assert.equal(c.getSelectedWalkaroundDraft().defectNotes,'legacy');c.resumeWalkaroundDraftAfterEnter();assert.equal(timers.length,1);
 c.setSelectedDriverVehicle('YJ13GRF');timers[0]();assert(!c.opened);
});
test('failed legacy migration preserves original photos and draft',()=>{
 const {c,data}=setup();data.set(c.WALKAROUND_DRAFT_KEY,JSON.stringify({...c.walkaroundDraftIdentity(),active:true,photoDataUrls:{front:'image'}}));
 c.localStorage.setItem=()=>{throw Error('QuotaExceededError')};assert.equal(c.getSelectedWalkaroundDraft().photoDataUrls.front,'image');assert(data.has(c.WALKAROUND_DRAFT_KEY));
});
test('late completion clears only its original unit draft and preserves a newer attempt',()=>{
 const {c}=setup();c.walkaroundState.startedAt='attempt-1';c.saveWalkaroundDraft();const identity={...c.walkaroundDraftIdentity(),startedAt:'attempt-1'};
 c.setSelectedDriverVehicle('YJ13GRF');c.walkaroundState.startedAt='attempt-yj';c.saveWalkaroundDraft();c.clearWalkaroundDraft(identity);assert.equal(c.getSelectedWalkaroundDraft().startedAt,'attempt-yj');
 c.setSelectedDriverVehicle('LL21HJJ');assert.equal(c.getSelectedWalkaroundDraft(),null);c.walkaroundState.startedAt='attempt-2';c.saveWalkaroundDraft();c.clearWalkaroundDraft(identity);assert.equal(c.getSelectedWalkaroundDraft().startedAt,'attempt-2');
});
test('sync summary cannot claim everything sent while any retained work needs attention',()=>{
 const {c,data}=setup();vm.runInContext(fn('renderQueueSummary'),c);c.queueCounts=()=>({});c.getRetryQueue=()=>[];c.getPendingWalkaroundTickets=()=>[];
 assert(c.renderQueueSummary().includes('Everything sent'));
 data.set('pmg_backup_problem_2026-10-21','Retained conflict');assert(c.renderQueueSummary().includes('Saved work needs an office check'));
 data.delete('pmg_backup_problem_2026-10-21');c.getRetryQueue=()=>[{date:'2026-10-20'}];assert(c.renderQueueSummary().includes('Saved work needs an office check'));
 c.getRetryQueue=()=>[{date:'2026-10-21'}];assert(c.renderQueueSummary().includes('Work saved and waiting to send'));
 c.getRetryQueue=()=>[];c.getPendingWalkaroundTickets=()=>[{recordId:'pending'}];assert(c.renderQueueSummary().includes('Work saved and waiting to send'));
});
test('driver identities isolate drafts and records',()=>{
 const {c}=setup();c.setLocalWalkaroundRecord(record);c.saveWalkaroundDraft();c.currentUser={driverId:'paul-test'};c.setSelectedDriverVehicle('LL21HJJ');assert.equal(c.getSelectedWalkaroundDraft(),null);assert(!c.hasSelectedWalkaroundComplete());
});
(async()=>{
 const {c}=setup();vm.runInContext(fn('ensureTorqueChecksForSelectedVehicle'),c);
 const requests=[];c.fleetApi=()=>new Promise(resolve=>requests.push(resolve));c.responseError=async()=> 'failure';
 c.ensureTorqueChecksForSelectedVehicle({force:true});c.setSelectedDriverVehicle('YJ13GRF');c.ensureTorqueChecksForSelectedVehicle({force:true});
 requests[0]({ok:true,json:async()=>({openTasks:[]})});await new Promise(r=>setImmediate(r));assert.equal(c.torqueCheckState.vehicle,'YJ13GRF');assert(c.torqueCheckState.loading);
 requests[1]({ok:true,json:async()=>({openTasks:[]})});await new Promise(r=>setImmediate(r));assert.equal(c.torqueCheckState.vehicle,'YJ13GRF');assert(!c.torqueCheckState.loading);
 console.log('PASS late torque reply cannot clear another truck');console.log(`${count+1} vehicle switch regression scenarios passed`);
})().catch(e=>{console.error(e);process.exitCode=1});
