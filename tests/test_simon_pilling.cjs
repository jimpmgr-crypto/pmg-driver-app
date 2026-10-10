const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const config=require('../../../config/pmg-yard-prices.json');
const source=fs.readFileSync(require.resolve('../../../scripts/haultech-agreed-pricing.cjs'),'utf8').replace('module.exports={evaluateAgreedPrice};','')+'\n'+fs.readFileSync(require.resolve('../worker/agreed-evidence-producer.js'),'utf8')+'\n'+fs.readFileSync(require.resolve('../worker/agreed-pricing-adapter.js'),'utf8');
const clone=x=>JSON.parse(JSON.stringify(x));let history=[],writes=0,record,kv=new Map();
const fixture=()=>({id:'job',jobId:12001,customerId:'generic-known-account',quotedPrice:0,totalPrice:0,useQuotedPrice:false,active:true,deliveryStatus:'Completed',deliveryDate:'2026-10-02T00:00:00Z',deliveryVehicleId:'eight-id',deliveryLoadId:'load',trafficNotes:'legitimate site note',accountNotes:'',consignments:[{id:'c',goodsDescription:'6F2 Crush',weight:20,quantity:20,invoicedCount:0,invoiceExportCount:0,deliveryAddressLine1:'1 Test Road',deliveryPostcode:'FY6 9DJ'}]});record=fixture();
const sandbox={AGREED_COMPLETION_POLICY:config.haultech_completion_policy,AGREED_CATALOGUE:config,Date,Intl,AbortSignal,encodeURIComponent,PM_GROUNDWORKS_CUSTOMER_ID:'pmg',DRIVER_APP_VEHICLE_IDS_BY_REG:{PN25AMU:'eight-id'},jobHasExistingPrice:j=>[j.quotedPrice,j.totalPrice].some(n=>n!==0),cleanText:v=>v||'',jobCustomerId:j=>j.customerId,jobGoodsDescription:j=>j.consignments[0].goodsDescription,jobCustomerReference:j=>j.customerReference||'',firstConsignment:j=>j.consignments[0],jobQuantity:j=>j.consignments[0].weight,isDeliveredConcreteJob:j=>false,normalisedLookupText:v=>String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(),normalisedCompletionMaterial:j=>j.consignments[0].goodsDescription.toLowerCase(),normaliseUkPostcode:v=>v,normalisedStatus:v=>v.toLowerCase(),htFetch:async(_env,path,options)=>{if(path.includes('GetOldInvoices'))return {ok:true,json:async()=>history};if(path.includes('UpsertJob')){writes++;record=JSON.parse(options.body);record.consignments[0]._etag='fresh';return {ok:true};}throw Error(path);},fetchHaultechJobsByDate:async()=>({ok:true,jobs:[clone(record)]}),fetch:async(url)=>({ok:true,json:async()=>url.includes('postcodes.io')?{result:{longitude:-2.95,latitude:53.88}}:{code:'Ok',routes:[{duration:1500.01}]}})};
vm.runInNewContext(source,sandbox);sandbox.completionAutoPrice=(j,q,e)=>sandbox.agreedCompletionAutoPrice(j,q,e);
const env={PMG_DATA:{get:async k=>kv.get(k)||null,put:async(k,v)=>kv.set(k,JSON.parse(v))}};
(async()=>{
 let checks=0;
 function simon(material='Type 1 MOT'){const j=fixture();j.customerId='b4482d71-a8ac-4648-8ae1-ced8074f0972';j.deliveryDate='2026-10-05T00:00:00Z';j.consignments[0].goodsDescription=material;j.consignments[0].deliveryAddressLine1='Pilling';return j;}
 for(const material of ['Type 1 MOT','MOT Type 1','40mm Quarried MOT','Quarried MOT','6F2 Crush','Crush','6F2 Crushed Concrete']){
  kv.clear();record=simon(material);const expected=/mot/i.test(material)?485:235;
  const ev=await sandbox.deriveAgreedEvidence(record,20,env);assert.equal(ev.facts.agreement.amount,expected);checks++;
  const priced=await sandbox.verifiedAgreedReprice(env,clone(record),'2026-10-05');assert.equal(priced.status,'verified');assert.equal(record.quotedPrice,expected);assert.equal(record.trafficNotes,'legitimate site note');checks++;
 }
 for(const change of [j=>j.deliveryDate='2026-10-04',j=>j.consignments[0].deliveryAddressLine1='Pilling Lane, Preesall',j=>j.consignments[0].deliveryAddressLine1='Lancaster',j=>j.consignments[0].deliveryAddressLine1='',j=>j.deliveryVehicleId='unknown',j=>j.trafficNotes='Paid',j=>j.trafficNotes='manual price',j=>j.consignments.push(clone(j.consignments[0]))]){
  kv.clear();record=simon();change(record);assert.equal(await sandbox.deriveAgreedEvidence(record,20,env),null);checks++;
 }
 for(const q of [10,19,21,190]){record=simon();assert.equal(await sandbox.deriveAgreedEvidence(record,q,env),null);checks++;}
 for(const label of ['40mm Recycled MOT','20mm clean stone','6F2 Crush and MOT']){record=simon(label);const ev=await sandbox.deriveAgreedEvidence(record,20,env);assert.ok(!ev?.facts?.agreement);checks++;}
 record=simon();record.quotedPrice=1900;record.totalPrice=1900;assert.equal((await sandbox.agreedCompletionAutoPrice(record,20,env)).reason,'existing_price');checks++;
 record=simon();history=[{invoiceId:1}];assert.equal((await sandbox.agreedCompletionAutoPrice(record,20,env)).reason,'invoice_history_hold');checks++;history=[];
 record=simon();record.consignments[0].invoiceExportCount=1;assert.equal((await sandbox.agreedCompletionAutoPrice(record,20,env)).reason,'invoice_or_export_state_unknown');checks++;
 // Source independent path is shared by driver completion and ticket post-import: no source discriminator.
 record=simon();record.customerReference='YARD-example';assert.equal((await sandbox.agreedCompletionAutoPrice(record,20,env)).quotedPrice,485);checks++;
 console.log(checks+' Simon Pilling scope, protection, source-independence and write/readback checks passed');
})().catch(e=>{console.error(e);process.exit(1)});
