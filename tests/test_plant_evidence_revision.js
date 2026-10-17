const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '../worker/index.js'), 'utf8');
const start = src.indexOf('    // PATCH /plant/service-events/{eventId}');
const end = src.indexOf('    // ═', start);
assert(start > 0 && end > start);
const events = [{id:'event-one',assetId:'plant-59',createdAt:'2026-10-15T15:59:47Z',description:'Original repair',sharePointWriteState:'linked',sharePointEvidencePath:'asset-59/original',sharePointLinkedAt:'2026-10-15T16:00:00Z'}];
let writes = 0, revision = 0;
const ctx = vm.createContext({Request, Response, Date, JSON,
  crypto:{randomUUID:()=>`revision-${++revision}`},
  safePathParam:decodeURIComponent,safeJsonParse:JSON.parse,safeArray:x=>Array.isArray(x)?x:[],
  cleanText:(x,n)=>String(x??'').trim().slice(0,n),cleanMultiline:(x,n)=>String(x??'').slice(0,n),
  maybeNumber:x=>x==null?null:Number(x),maybeIsoDate:x=>String(x||''),
  maybePlantServiceIntervalHours:x=>x,maybeVehicleServiceIntervalMiles:x=>x,
  PLANT_MANUAL_EVENTS_KEY:'events',env:{},
  getKvJson:async()=>JSON.parse(JSON.stringify(events)),
  putKvJson:async(env,key,value)=>{writes++;events.splice(0,events.length,...value)},
  corsResponse:(body,status=200)=>new Response(body,{status}),notFound:()=>new Response('{}',{status:404})});
vm.runInContext(`async function route(request){const path=new URL(request.url).pathname;${src.slice(start,end)}}`,ctx);
ctx.URL=URL;
const call=(method,url,body)=>ctx.route(new Request('https://example.invalid'+url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
(async()=>{
  let r=await call('POST','/plant/evidence-links',{eventId:'event-one'});assert.equal(r.status,200);
  r=await call('PATCH','/plant/service-events/event-one',{description:'Corrected repair'});assert.equal(r.status,200);
  assert.equal(events[0].sharePointWriteState,'queued_for_sharepoint_evidence');
  assert.equal(events[0].previousSharePointEvidence.path,'asset-59/original');
  const firstRevision=events[0].sharePointContentRevision,afterEdit=writes;
  for(const expected of [undefined,'2026-10-15T15:59:47Z','wrong']){
    r=await call('POST','/plant/evidence-links',{eventId:'event-one',expectedEventRevision:expected});assert.equal(r.status,409);
    assert.equal(writes,afterEdit);assert.equal(events[0].sharePointWriteState,'queued_for_sharepoint_evidence');
  }
  r=await call('POST','/plant/evidence-links',{eventId:'event-one',expectedEventRevision:firstRevision,sharePointEvidencePath:'asset-59/corrected'});
  assert.equal(r.status,200);assert.equal(events[0].sharePointEvidenceRevision,firstRevision);assert.equal(events[0].description,'Corrected repair');
  r=await call('PATCH','/plant/service-events/event-one',{description:'Second correction'});assert.equal(r.status,200);
  assert.notEqual(events[0].sharePointContentRevision,firstRevision);assert.equal(events[0].previousSharePointEvidence.eventRevision,firstRevision);
  const before=writes;
  r=await call('POST','/plant/evidence-links',{eventId:'event-one',expectedEventRevision:firstRevision});assert.equal(r.status,409);assert.equal(writes,before);
  r=await call('POST','/plant/evidence-links',{eventId:'missing',expectedEventRevision:firstRevision});assert.equal(r.status,404);assert.equal(writes,before);
  console.log('PASS original compatibility; correction requeue; prior evidence retained; missing/stale revision rejection; exact revision acknowledgement; successive correction isolation; unknown event no writes');
})().catch(e=>{console.error(e);process.exitCode=1});
