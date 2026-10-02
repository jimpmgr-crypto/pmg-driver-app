const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const config=require('../../../config/pmg-yard-prices.json');
const source=fs.readFileSync(require.resolve('../../../scripts/haultech-agreed-pricing.cjs'),'utf8').replace('module.exports={evaluateAgreedPrice};','')+'\n'+fs.readFileSync(require.resolve('../worker/agreed-evidence-producer.js'),'utf8')+'\n'+fs.readFileSync(require.resolve('../worker/agreed-pricing-adapter.js'),'utf8');
let record=null,history=[],seconds=1500,receipts=[];
const job={id:'job',customerId:'customer',quotedPrice:0,totalPrice:0,deliveryDate:'2026-10-02T00:00:00Z',consignments:[{goodsDescription:'6F2',weight:20,invoicedCount:0,invoiceExportCount:0}],accountNotes:'original',trafficNotes:'customer note'};
const sandbox={AGREED_COMPLETION_POLICY:config.haultech_completion_policy,AGREED_CATALOGUE:config,Date,AbortSignal,encodeURIComponent,jobHasExistingPrice:j=>[j.quotedPrice,j.totalPrice].some(n=>n!==0),cleanText:v=>v||'',jobCustomerId:j=>j.customerId,jobGoodsDescription:j=>j.consignments[0].goodsDescription,jobCustomerReference:j=>j.customerReference||'',firstConsignment:j=>j.consignments[0],htFetch:async()=>({ok:true,json:async()=>history}),fetch:async()=>({ok:true,json:async()=>({code:'Ok',routes:[{duration:seconds}]})})};
vm.runInNewContext(source,sandbox);
sandbox.deriveAgreedEvidence=async()=>null;
const env={PMG_DATA:{get:async()=>record,put:async(k,v)=>receipts.push(JSON.parse(v))}};
function evidence() {return {policyVersion:config.haultech_completion_policy.version,reviewed:true,source:'review.json',snapshot:sandbox.agreedJobSnapshot(job,20),facts:{kind:'6f2_delivered',customerId:'customer',siteId:'site',loadId:'load',jobDate:'2026-10-02',quantity:20,unit:'t',agreementsChecked:true,vehicle:'eight_wheeler',fullLoadConfirmed:true,singleMaterialConfirmed:true,route:{destination:{longitude:-3,latitude:53.8},reviewedBand:0,siteId:'site',accessReviewed:true,evidence:'route.json'}}};}
(async()=>{
 let r=await sandbox.agreedCompletionAutoPrice(job,20,env);assert.equal(r.reason,'source_fields_or_grouping_required');
 record=evidence();r=await sandbox.agreedCompletionAutoPrice(job,20,env);assert.equal(r.quotedPrice,240);assert.equal(r.job.accountNotes,'original');assert.equal(r.job.trafficNotes,'customer note');assert.equal(receipts[0].status,'calculated_not_write_verified');
 seconds=1500.1;r=await sandbox.agreedCompletionAutoPrice(job,20,env);assert.equal(r.reason,'road_band_changed_since_review');
 seconds=1500;history=[{id:'issued'}];r=await sandbox.agreedCompletionAutoPrice(job,20,env);assert.equal(r.reason,'invoice_history_hold');
 history=[];r=await sandbox.agreedCompletionAutoPrice(job,19,env);assert.equal(r.reason,'stale_or_unreviewed_pricing_evidence');
 record=evidence();record.facts.jobDate='2026-10-01';r=await sandbox.agreedCompletionAutoPrice(job,20,env);assert.equal(r.reason,'job_date_evidence_mismatch');
 console.log('6 adapter scenarios passed: review evidence, clean notes, raw route boundary, invoice hold, stale snapshot, date binding');
})().catch(e=>{console.error(e);process.exit(1)});
