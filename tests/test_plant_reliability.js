// Execute the actual Plant/Tony frontend functions with synthetic state and API replies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(process.env.PMG_PLANT_TEST_HTML || path.join(__dirname, '../plant.html'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '../worker/index.js'), 'utf8');
const workerHelpers = vm.createContext({});
for (const name of ['cleanText', 'normaliseVehicleRef']) {
  const start = worker.indexOf('function ' + name + '(');
  const end = worker.indexOf('\nfunction ', start + 1);
  assert(start >= 0 && end > start, 'existing worker helper ' + name);
  vm.runInContext(worker.slice(start, end), workerHelpers);
}
// Build valid acknowledgements with the existing worker's normalization rules.
function identityReply(f, opts) {
  const payload = JSON.parse(opts.body);
  const limits = {displayName:180,plantNumber:80,machineType:180,serialNumber:180,year:20,site:180,assetType:40,sharePointEvidencePath:300};
  const asset = {...f.a};
  for (const [name, limit] of Object.entries(limits)) asset[name] = workerHelpers.cleanText(payload[name], limit);
  asset.registration = workerHelpers.normaliseVehicleRef(payload.registration);
  return {ok:true,asset};
}
function fn(name) {
  const start = html.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert(start >= 0, name);
  const next = html.slice(start + 1).search(/\n    (?:async )?function /);
  return html.slice(start, next < 0 ? html.indexOf('</script>', start) : start + 1 + next);
}
function load(ctx, ...names) { for (const name of names) if (html.includes('function ' + name + '(')) vm.runInContext(fn(name), ctx); }
function field(value='') { return {value,disabled:false,isConnected:true,dataset:{auto:'true'}}; }
function form(values) {
  const fields=Object.fromEntries(Object.entries(values).map(([k,v])=>[k,field(v)]));
  const elements=Object.values(fields);elements.namedItem=name=>fields[name]||(fields[name]=field());
  return {fields,elements,dataset:{},resets:0,reset(){this.resets++;Object.values(fields).forEach(f=>f.value='')},querySelectorAll:()=>elements};
}
function fixture() {
  const a={id:'plant-a',displayName:'Synthetic A',plantNumber:'A'},b={id:'plant-b',displayName:'Synthetic B',plantNumber:'B'};
  const state={role:'tony',mode:'worker',workerOnline:true,assets:[a,b],selectedId:a.id,record:{asset:a,history:[],filterParts:[]},historyByAsset:{},filterParts:{},reviewByAsset:{},reviewItems:[]};
  const values={date:'2026-10-17',hours:'123',serviceType:'Repair',workDone:'Synthetic repair draft',anomalies:'Synthetic note',nextDueDate:'',nextDueHours:'',nextServiceIntervalHours:'500',createdBy:'Tony',torqueNm:''};
  const identity={displayName:'Edited A',plantNumber:'A',registration:'',machineType:'Fixture',serialNumber:'SYNTHETIC',year:'2020',site:'Test yard'};
  const els={serviceForm:form(values),assetForm:form(identity),identityForm:form(identity),filterEditList:{innerHTML:'draft filter'},syncState:{textContent:''}};
  const messages=[],requests=[],events=[],loads=[],busy=[];
  const ctx={state,els,plantDataGeneration:0,plantRecordGeneration:0,plantDirtyForms:new Set(),console,
    localStorage:{setItem(){}},FormData:class {constructor(f){this.form=f}get(name){return this.form.fields[name]?.value||''}},
    api:async(url,opts)=>{requests.push({url,opts});return {}},toast:m=>messages.push(m),setBusy:v=>busy.push(v),renderAll(){},renderAssetList(){},
    loadRecord:async id=>{loads.push(id);state.record=id?{asset:state.assets.find(a=>a.id===id),history:[],filterParts:[]}:null},
    loadData:async()=>{},loadSeedState:async()=>({assets:[{id:'seed-old'}],historyByAsset:{},reviewByAsset:{},filterParts:{}}),groupByAsset:()=>({}),
    updateUsageModeForAsset(){},window:{confirm:()=>true},isVehicleAsset:()=>false,serviceTypeNeedsTorque:()=>false,categoryForServiceType:()=> 'repair',
    serviceField:name=>els.serviceForm.elements.namedItem(name),CHECK_ITEMS:[],collectFilterRows:()=>[],appendLocalEvent:e=>events.push(e),
    defaultIntervalForAsset:()=>500,updateNextDueDateFromServiceDate(){},addFilterEditRow(){},dueStatus:()=>({state:'unknown',label:'Unknown'}),plantGroupKey:()=> 'other',plantGroupLabel:()=> 'Other'};
  // These existing checks isolate save handlers; the durable transport is exercised separately.
  ctx.submitPlantWrite=(kind,url,method,payload)=>ctx.api(url,{method,body:JSON.stringify(payload)});
  ctx.markPlantFormClean=()=>{};
  vm.createContext(ctx);load(ctx,'beginPlantSave','selectedServiceAsset','normalisePlantIdentityText','plantIdentityAcknowledged');return {ctx,state,els,messages,requests,events,loads,busy,a,b};
}
function loadInline(f) {
  Object.assign(f.ctx,{serviceAlertForAsset:()=>null,nextDueText:()=>'-',formatDate:v=>v||'',usageLabel:()=> 'Hours',historyTypeLabel:()=> 'Repair',historyDetailText:e=>e.workDone,publicPartText:v=>v||''});
  load(f.ctx,'escapeHtml','inlineFact','inlineLine','inlineAssetDetail');
}
const cases=[];const test=(name,run)=>cases.push({name,run});const event={preventDefault(){}};
test('authoritative empty list never resurrects seed assets',async()=>{
  const f=fixture();let seeds=0;f.ctx.api=async()=>({assets:[]});f.ctx.loadSeedState=async()=>{seeds++;return {assets:[{id:'old'}]}};load(f.ctx,'loadData');await f.ctx.loadData();
  assert.equal(seeds,0);assert.equal(f.state.mode,'worker');assert.equal(f.state.assets.length,0);assert.equal(f.state.selectedId,'');assert.equal(f.state.record,null);
});
test('malformed successful list is not writable worker readiness',async()=>{
  const f=fixture();f.ctx.api=async()=>({});load(f.ctx,'loadData');await f.ctx.loadData();assert.equal(f.state.workerOnline,false);assert.equal(f.state.mode,'seed');
});
test('seed failure preserves known data and clears busy state',async()=>{
  const f=fixture();f.ctx.api=async()=>{throw Error('offline')};f.ctx.loadSeedState=async()=>{throw Error('seed unavailable')};load(f.ctx,'loadData');await f.ctx.loadData();
  assert.equal(f.state.assets[0].id,'plant-a');assert.equal(f.busy.at(-1),false);assert.equal(f.state.workerOnline,false);
});
test('older full-list read cannot overwrite newer result',async()=>{
  const f=fixture();let release,calls=0;f.ctx.api=()=>++calls===1?new Promise(resolve=>release=resolve):Promise.resolve({assets:[f.b]});load(f.ctx,'loadData');
  const old=f.ctx.loadData();await f.ctx.loadData();release({assets:[f.a]});await old;assert.equal(f.state.assets[0].id,'plant-b');
});
test('full-list refresh cannot erase a newer selected identity draft',async()=>{
  const f=fixture();let release;f.ctx.api=()=>new Promise(resolve=>release=resolve);load(f.ctx,'loadData','renderIdentityForm');f.ctx.renderAll=options=>{if(!options?.preserveIdentityDraft)f.ctx.renderIdentityForm()};const pending=f.ctx.loadData();
  f.ctx.plantRecordGeneration++;f.state.selectedId='plant-b';f.state.record={asset:f.b,history:[],filterParts:[]};f.ctx.renderIdentityForm();f.els.identityForm.fields.site.value='New B draft';f.ctx.plantDirtyForms.add(f.els.identityForm);release({assets:[f.a,f.b]});await pending;
  assert.equal(f.state.selectedId,'plant-b');assert.equal(f.els.identityForm.fields.site.value,'New B draft');assert.equal(f.loads.length,0);
});
for(const same of [false,true])test('late record response cannot replace newer selection: '+same,async()=>{
  const f=fixture();let release,calls=0;f.ctx.api=()=>++calls===1?new Promise(resolve=>release=resolve):Promise.resolve({asset:{...(same?f.a:f.b),site:'new'},history:[],filterParts:[]});load(f.ctx,'loadRecord');
  const old=f.ctx.loadRecord('plant-a');await f.ctx.loadRecord(same?'plant-a':'plant-b');release({asset:{...f.a,site:'old'},history:[],filterParts:[]});await old;assert.equal(f.state.record.asset.site,'new');
});
test('wrong record identity and failed read do not manufacture empty history',async()=>{
  for(const failure of [false,true]){const f=fixture();f.ctx.api=async()=>{if(failure)throw Error('unavailable');return {asset:f.b,history:[],filterParts:[]}};load(f.ctx,'loadRecord');await f.ctx.loadRecord('plant-a');assert.equal(f.state.record,null);}
});
test('failed live record is unavailable in inline history and parts, never zero',async()=>{
  const f=fixture();f.ctx.api=async()=>{throw Error('Live history unavailable')};load(f.ctx,'loadRecord');loadInline(f);await f.ctx.loadRecord('plant-a');const rendered=f.ctx.inlineAssetDetail(f.a);
  assert.equal(f.state.record,null);assert(rendered.includes('<span>History</span><strong>Unavailable</strong>'));assert(rendered.includes('<span>Filters / parts</span><strong>Unavailable</strong>'));
  assert(!rendered.includes('0 rows'));assert(rendered.includes('Select this item again to reload.'));
});
test('another asset record cannot supply inline availability or zero counts',()=>{
  const f=fixture();f.state.record={asset:f.b,history:[],filterParts:[]};loadInline(f);const rendered=f.ctx.inlineAssetDetail(f.a);
  assert(rendered.includes('<span>History</span><strong>Unavailable</strong>'));assert(!rendered.includes('0 rows'));
});
for(const listCount of [0,5])test('authoritative empty detail arrays show zero despite list count '+listCount,async()=>{
  const f=fixture();f.a.historyCount=listCount;f.a.filterPartCount=listCount;f.ctx.api=async()=>({asset:f.a,history:[],filterParts:[]});load(f.ctx,'loadRecord');loadInline(f);await f.ctx.loadRecord('plant-a');const rendered=f.ctx.inlineAssetDetail(f.a);
  assert(rendered.includes('<span>History</span><strong>0 rows</strong>'));assert(rendered.includes('<span>Filters / parts</span><strong>0 rows</strong>'));assert(!rendered.includes('Unavailable'));
});
test('authoritative populated detail renders actual history and parts',()=>{
  const f=fixture();f.state.record={asset:f.a,history:[{date:'2026-10-17',workDone:'Synthetic known repair'}],filterParts:[{type:'Synthetic filter',code:'TEST-PART'}]};loadInline(f);const rendered=f.ctx.inlineAssetDetail(f.a);
  assert(rendered.includes('<span>History</span><strong>1 rows</strong>'));assert(rendered.includes('<span>Filters / parts</span><strong>1 rows</strong>'));assert(rendered.includes('Synthetic known repair'));assert(rendered.includes('TEST-PART'));assert(!rendered.includes('Unavailable'));
});
test('read-only seed preview retains its snapshot history and parts',()=>{
  const f=fixture();f.state.mode='seed';f.state.workerOnline=false;f.state.record=null;f.state.historyByAsset['plant-a']=[{date:'2026-10-17',workDone:'Synthetic seed repair'}];f.state.filterParts['plant-a']=[{type:'Synthetic seed filter',code:'SEED-PART'}];loadInline(f);const rendered=f.ctx.inlineAssetDetail(f.a);
  assert(rendered.includes('<span>History</span><strong>1 rows</strong>'));assert(rendered.includes('Synthetic seed repair'));assert(rendered.includes('SEED-PART'));assert(!rendered.includes('Unavailable'));assert.equal(f.state.workerOnline,false);
});
test('cleared selection invalidates an outstanding record read',async()=>{
  const f=fixture();let release;f.ctx.api=()=>new Promise(resolve=>release=resolve);load(f.ctx,'loadRecord');const old=f.ctx.loadRecord('plant-a');await f.ctx.loadRecord('');release({asset:f.a,history:[],filterParts:[]});await old;assert.equal(f.state.selectedId,'');assert.equal(f.state.record,null);
});
test('selected service asset never uses an old selected record',()=>{const f=fixture();f.state.selectedId='plant-b';assert.equal(f.ctx.selectedServiceAsset().id,'plant-b')});
for(const result of [{ok:true},{ok:true,asset:{id:'plant-b'}},{ok:false,asset:{id:'plant-a'}}])test('identity acknowledgement must confirm exact asset: '+JSON.stringify(result),async()=>{
  const f=fixture();f.ctx.api=async()=>result;load(f.ctx,'saveIdentity');await f.ctx.saveIdentity(event);assert.equal(f.state.assets[0].displayName,'Synthetic A');assert(!f.messages.includes('Plant details saved.'));assert.equal(f.els.identityForm.fields.displayName.value,'Edited A');
});
test('late identity acknowledgement updates original asset without changing new selection',async()=>{
  const f=fixture();let release,reply;f.ctx.api=(url,opts)=>{reply=identityReply(f,opts);return new Promise(resolve=>release=resolve)};load(f.ctx,'saveIdentity');const pending=f.ctx.saveIdentity(event);f.state.selectedId='plant-b';f.state.record={asset:f.b};release(reply);await pending;
  assert.equal(f.state.assets[0].displayName,'Edited A');assert.equal(f.state.assets[1].displayName,'Synthetic B');assert.equal(f.state.record.asset.id,'plant-b');
});
test('identity ID alone cannot confirm submitted field changes',async()=>{
  const f=fixture();f.ctx.api=async()=>({ok:true,asset:{id:'plant-a'}});load(f.ctx,'saveIdentity');await f.ctx.saveIdentity(event);
  assert.equal(f.state.assets[0].displayName,'Synthetic A');assert.equal(f.els.identityForm.fields.displayName.value,'Edited A');assert(!f.messages.some(m=>/details saved/i.test(m)));
});
for (const key of ['displayName','plantNumber','registration','machineType','serialNumber','year','site','assetType','sharePointEvidencePath']) {
  for (const missing of [true,false]) test(`identity reply ${missing?'missing':'mismatching'} ${key} keeps draft`,async()=>{
    const f=fixture();f.ctx.api=async(url,opts)=>{const reply=identityReply(f,opts);if(missing)delete reply.asset[key];else reply.asset[key]='UNRELATED VALUE';return reply};load(f.ctx,'saveIdentity');await f.ctx.saveIdentity(event);
    assert.equal(f.state.assets[0].displayName,'Synthetic A');assert.equal(f.els.identityForm.fields.displayName.value,'Edited A');assert(!f.messages.some(m=>/details saved/i.test(m)));
  });
}
test('full normalized worker identity reply confirms editable fields',async()=>{
  const f=fixture();f.els.identityForm.fields.displayName.value='  Edited\n  name  ';f.els.identityForm.fields.registration.value=' yj13- grf ';
  f.els.identityForm.fields.machineType.value=' x '.repeat(200);f.a.sharePointEvidencePath='  Synthetic\n evidence  ';
  f.ctx.api=async(url,opts)=>identityReply(f,opts);load(f.ctx,'saveIdentity','renderIdentityForm');f.ctx.renderAll=()=>f.ctx.renderIdentityForm();await f.ctx.saveIdentity(event);
  assert.equal(f.state.record.asset.displayName,'Edited name');assert.equal(f.state.record.asset.registration,'YJ13GRF');assert.equal(f.state.record.asset.machineType.length,180);
  assert.equal(f.state.record.asset.sharePointEvidencePath,'Synthetic evidence');assert.equal(f.els.identityForm.fields.displayName.value,'Edited name');assert(f.messages.includes('Plant details saved.'));
});
for(const result of [{ok:true,event:{id:'event-a',assetId:'plant-b',date:'2026-10-17'}},{ok:false,event:{id:'event-a',assetId:'plant-a',date:'2026-10-17'}},{ok:true,event:{assetId:'plant-a'}}])test('unconfirmed service preserves draft: '+JSON.stringify(result),async()=>{
  const f=fixture();f.ctx.api=async()=>result;load(f.ctx,'saveServiceEntry');await f.ctx.saveServiceEntry(event);assert.equal(f.events.length,0);assert.equal(f.els.serviceForm.fields.workDone.value,'Synthetic repair draft');assert(!f.messages.some(m=>/^Entry saved/.test(m)));
});
test('late service acknowledgement does not clear new selection draft',async()=>{
  const f=fixture();let release;f.ctx.api=()=>new Promise(resolve=>release=resolve);load(f.ctx,'saveServiceEntry');const pending=f.ctx.saveServiceEntry(event);f.state.selectedId='plant-b';f.state.record={asset:f.b};f.els.serviceForm.fields.workDone.value='New selection draft';release({ok:true,event:{id:'event-a',assetId:'plant-a',date:'2026-10-17'}});await pending;
  assert.equal(f.events.length,1);assert.equal(f.els.serviceForm.fields.workDone.value,'New selection draft');assert.equal(f.loads.length,0);
});
test('new asset form is retained until a real asset acknowledgement',async()=>{
  const f=fixture();f.ctx.api=async()=>({ok:true});load(f.ctx,'saveAsset');await f.ctx.saveAsset(event);assert.equal(f.els.assetForm.resets,0);assert.equal(f.els.assetForm.fields.machineType.value,'Fixture');
});
for (const returnToSame of [false,true]) test('late asset creation preserves newer selection and edited identity draft: '+returnToSame,async()=>{
  const f=fixture();let release,refreshes=0,listRenders=0;f.ctx.api=()=>new Promise(resolve=>release=resolve);load(f.ctx,'saveAsset','renderIdentityForm');
  f.ctx.renderAll=()=>f.ctx.renderIdentityForm();f.ctx.renderAssetList=()=>listRenders++;
  // A real full refresh rehydrates identity fields: it must not run on the late branch.
  f.ctx.loadData=async()=>{refreshes++;f.state.record={asset:f.state.assets.find(a=>a.id===f.state.selectedId)};f.ctx.renderAll()};
  const pending=f.ctx.saveAsset(event);f.ctx.plantRecordGeneration++;f.state.selectedId='plant-b';f.state.record={asset:f.b};f.ctx.renderIdentityForm();
  if(returnToSame){f.ctx.plantRecordGeneration++;f.state.selectedId='plant-a';f.state.record={asset:f.a};f.ctx.renderIdentityForm()}
  const selected=f.state.selectedId;f.els.identityForm.fields.site.value='Unsaved current site';f.els.identityForm.fields.displayName.value='Unsaved current name';
  release({ok:true,asset:{id:'plant-new',displayName:'Synthetic new plant'}});await pending;
  assert.equal(f.state.selectedId,selected);assert.equal(f.state.record.asset.id,selected);assert.equal(f.els.identityForm.fields.site.value,'Unsaved current site');assert.equal(f.els.identityForm.fields.displayName.value,'Unsaved current name');
  assert.equal(refreshes,0);assert.equal(listRenders,1);assert(f.state.assets.some(a=>a.id==='plant-new'));assert.equal(f.els.assetForm.fields.machineType.disabled,false);assert(f.messages.some(m=>m.includes('Plant item saved: Synthetic new plant. Current selection and form kept.')));
});
for(const name of ['saveIdentity','saveServiceEntry','saveAsset'])test('double submit has one request: '+name,async()=>{
  const f=fixture();let calls=0;const releases=[];f.ctx.api=(url,opts)=>{calls++;return new Promise(resolve=>releases.push(()=>resolve(name==='saveIdentity'?identityReply(f,opts):{ok:true,asset:{...f.a},event:{id:'event-a',assetId:'plant-a',date:'2026-10-17'}})))};load(f.ctx,name);const first=f.ctx[name](event),second=f.ctx[name](event);
  const count=calls;releases.forEach(done=>done());await Promise.all([first,second]);assert.equal(count,1);
});
test('confirmed service clears original form and releases save controls',async()=>{
  const f=fixture();f.ctx.api=async()=>({ok:true,event:{id:'event-a',assetId:'plant-a',date:'2026-10-17'}});load(f.ctx,'saveServiceEntry');await f.ctx.saveServiceEntry(event);assert.equal(f.events.length,1);assert.equal(f.els.serviceForm.fields.workDone.value,'');assert.equal(f.els.serviceForm.fields.workDone.disabled,false);
});
test('service cannot use a still-loading stale selected record',async()=>{
  const f=fixture();f.state.selectedId='plant-b';load(f.ctx,'saveServiceEntry');await f.ctx.saveServiceEntry(event);assert.equal(f.requests.length,0);
});
test('malformed asset row cannot become a writable live list',async()=>{
  const f=fixture();f.ctx.api=async()=>({assets:[null]});load(f.ctx,'loadData');await f.ctx.loadData();assert.equal(f.state.mode,'seed');assert.equal(f.state.workerOnline,false);
});
test('unavailable selection cache does not prevent current record read',async()=>{
  const f=fixture();f.ctx.localStorage.setItem=()=>{throw Error('blocked')};f.ctx.api=async()=>({asset:f.a,history:[],filterParts:[]});load(f.ctx,'loadRecord');await f.ctx.loadRecord('plant-a');assert.equal(f.state.record.asset.id,'plant-a');
});
for(const name of ['saveIdentity','saveServiceEntry','saveAsset'])test('confirmed write remains saved when rendering fails: '+name,async()=>{
  const f=fixture();f.ctx.api=async(url,opts)=>name==='saveIdentity'?identityReply(f,opts):{ok:true,asset:{...f.a},event:{id:'event-a',assetId:'plant-a',date:'2026-10-17'}};f.ctx.renderAll=()=>{throw Error('render failed')};f.ctx.loadData=async()=>{throw Error('refresh failed')};load(f.ctx,name);await f.ctx[name](event);assert(f.messages.some(m=>/saved, but the view could not refresh/.test(m)));
});
test('all Plant inline JavaScript compiles',()=>{for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi))new vm.Script(m[1]);});
(async()=>{const results=[];for(const {name,run} of cases){try{await run();results.push({name,passed:true})}catch(e){results.push({name,passed:false,error:e.stack})}}for(const r of results)console.log(`${r.passed?'PASS':'FAIL'} ${r.name}${r.passed?'':': '+r.error}`);console.log(`${results.filter(r=>r.passed).length}/${results.length} Plant reliability checks passed`);if(process.env.PMG_PLANT_TEST_REPORT)fs.writeFileSync(process.env.PMG_PLANT_TEST_REPORT,JSON.stringify(results,null,2)+'\n');if(results.some(r=>!r.passed))process.exitCode=1})().catch(e=>{console.error(e);process.exitCode=1});
