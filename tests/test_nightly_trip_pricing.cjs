const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const root=require('path').resolve(__dirname,'../../..'),app=root+'/projects/pmg-driver-app';
const cfg=require(root+'/config/pmg-yard-prices.json');
const producer=process.env.PRICING_PRODUCER||app+'/worker/agreed-evidence-producer.js';
let rows=[];
const ctx={AGREED_COMPLETION_POLICY:cfg.haultech_completion_policy,AGREED_CATALOGUE:cfg,PM_GROUNDWORKS_CUSTOMER_ID:'6861767c-4418-45ec-ac56-a0673ecce127',DRIVER_APP_VEHICLE_IDS_BY_REG:{EY15BOV:'3acf3f0b-462d-4b75-9072-3f0890ea036a'},AbortSignal,encodeURIComponent,Date,Intl,cleanText:v=>v||'',normalisedLookupText:v=>String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(),jobCustomerId:j=>j.customerId,jobGoodsDescription:j=>j.consignments[0].goodsDescription,jobCustomerReference:j=>j.customerReference||'',firstConsignment:j=>j.consignments[0],normaliseUkPostcode:v=>v||'',normalisedCompletionMaterial:j=>ctx.normalisedLookupText(j.consignments[0].goodsDescription),isDeliveredConcreteJob:()=>false,fetchHaultechJobsByDate:async()=>({ok:true,jobs:rows}),fetch:async()=>({ok:true,json:async()=>({result:{longitude:-2.89,latitude:53.85}})})};
vm.runInNewContext(fs.readFileSync(root+'/scripts/haultech-agreed-pricing.cjs','utf8').replace('module.exports={evaluateAgreedPrice};','')+'\n'+fs.readFileSync(producer,'utf8'),ctx);
const base=n=>({id:'job-'+n,jobId:n,customerId:'4d452d95-c197-47f8-877e-a914a1801fec',active:true,cancelled:false,deliveryDate:'2026-10-21T00:00:00',deliveryLoadId:'daily-diary',deliveryVehicleId:'3acf3f0b-462d-4b75-9072-3f0890ea036a',accountNotes:'Driver app source: Neil Antony / EY15BOV | Driver movement: driver-'+n+' | Driver note: tipped',consignments:[{id:'c'+n,goodsDescription:n===11708?'Rec mot tipped.':'Type 1 mot.',deliveryAddressLine1:'1 Admarsh Drive',deliveryPostcode:'PR3 0ER'}]});
(async()=>{
 rows=[base(11708),base(11709)];
 for(const [n,q,amount] of [[11708,13,313.5],[11709,8.5,323.5]]){
  const e=await ctx.deriveAgreedEvidence(rows.find(j=>j.jobId===n),q,{});assert(e,'distinct driver trip should produce evidence');assert.equal(e.facts.loadId,'driver-'+n);
  const priced=ctx.evaluateAgreedPrice(cfg.haultech_completion_policy,{...e.facts,evidenceVerified:true,invoiceHistoryClear:true,exportStateClear:true,existingPrices:[0],route:{siteId:e.facts.siteId,method:'osrm_driving',seconds:888,originPostcode:'FY6 9DJ',accessReviewed:true,boundaryReviewRequired:false,evidence:'fixture verified route'}},cfg);
  assert.equal(priced.amount,amount,JSON.stringify(priced));
 }
 const valid=JSON.parse(JSON.stringify(rows));
 rows[1].accountNotes=rows[0].accountNotes;assert.equal(await ctx.deriveAgreedEvidence(rows[0],13,{}),null,'duplicate movement');
 rows=JSON.parse(JSON.stringify(valid));rows[1].accountNotes='';assert.equal(await ctx.deriveAgreedEvidence(rows[0],13,{}),null,'unknown same site grouping');
 rows=JSON.parse(JSON.stringify(valid));rows[1].consignments[0].goodsDescription='Type 1 MOT plus grab away';assert.equal(await ctx.deriveAgreedEvidence(rows[0],13,{}),null,'combined service');
 rows=JSON.parse(JSON.stringify(valid));rows[0].customerId=cfg.haultech_completion_policy.a1_customer_id;assert.equal(await ctx.deriveAgreedEvidence(rows[0],13,{}),null,'A1 identity hold');
 rows=JSON.parse(JSON.stringify(valid));rows[0].consignments[0].goodsDescription='Recycled MOT and cement delivered';assert.equal(await ctx.deriveAgreedEvidence(rows[0],13,{}),null,'mixed items');
 rows=JSON.parse(JSON.stringify(valid));rows.push({...rows[0],id:'duplicate-other-site',consignments:[{...rows[0].consignments[0],deliveryAddressLine1:'Elsewhere'}]});assert.equal(await ctx.deriveAgreedEvidence(rows[0],13,{}),null,'cross site movement reused');
 rows=JSON.parse(JSON.stringify(valid));rows.push({...base(11710),consignments:[{goodsDescription:'Rubble grab away',deliveryAddressLine1:'PMG Yard'}]});assert.equal(await ctx.deriveAgreedEvidence(rows[0],13,{}),null,'separate away row also needs combined waiver review');
 console.log('PASS: Swift 313.50/323.50; duplicate, split, combined, A1, mixed and reused movement holds');
})().catch(e=>{console.error(e);process.exit(1)});
