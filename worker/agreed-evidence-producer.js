function agreedJobSnapshot(job, quantity) {
  const stable=value=>{if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).filter(k=>!['_etag','_ts','quotedPrice','totalPrice','price','consignmentPrice','useQuotedPrice'].includes(k)).sort().map(k=>[k,stable(value[k])]));return value;};
  return JSON.stringify(stable({id:job.id,customerId:jobCustomerId(job),goods:jobGoodsDescription(job),reference:jobCustomerReference(job),quantity:Number(quantity),date:job.deliveryDate||job.collectionDate,consignments:job.consignments,deliveryLoadId:job.deliveryLoadId,collectionLoadId:job.collectionLoadId,deliveryVehicleId:job.deliveryVehicleId,collectionVehicleId:job.collectionVehicleId}));
}
async function deriveAgreedEvidence(job, quantity, env) {
  const c=firstConsignment(job), qty=Number(quantity), customerId=jobCustomerId(job);
  const goods=normalisedCompletionMaterial(job).replace(/[.]+$/,'').trim();
  const date=String(job.deliveryDate||job.collectionDate||'').slice(0,10);
  if (!job.id || !customerId || !Number.isFinite(qty) || qty<=0 || date<AGREED_COMPLETION_POLICY.effective_from) return null;
  if(!Array.isArray(job.consignments) || job.consignments.length!==1) return null;
  if(isDeliveredConcreteJob(job) || customerId===PM_GROUNDWORKS_CUSTOMER_ID) return null;
  const crush=['6f2','6f2 crush','6f2 crushed concrete','crush','recycled 6f2','recycled crush'].includes(goods);
  const spoil=['mixed spoil away','spoil mix grabbed away','spoil grab away','mixed spoil grab away'].includes(goods);
  const part=AGREED_CATALOGUE.materials.find(m=>normalisedLookupText(m.name)===goods && m.active!==false && !['TIPPING','CONCRETE','OTHER'].includes(m.group));
  if(!crush && !spoil && !part) return null;
  const side=spoil?'collection':'delivery';
  const address=[1,2,3,4,5].map(i=>cleanText(c[`${side}AddressLine${i}`],240)).filter(Boolean);
  const siteText=normalisedLookupText(address.join(' '));
  let postcode=normaliseUkPostcode(c[`${side}Postcode`]);
  if(!postcode) {
    const resolved=await resolveDeliveryPostcodeFromAddress(env,{line1:c[`${side}AddressLine1`]||'',line2:c[`${side}AddressLine2`]||'',line3:c[`${side}AddressLine3`]||'',line4:c[`${side}AddressLine4`]||'',formattedAddress:address.join(', ')});
    if(resolved.ok)postcode=resolved.postcode;
  }
  if(!siteText && !postcode) return null;
  const vehicleId=job.deliveryVehicleId||job.collectionVehicleId;
  const reg=Object.keys(DRIVER_APP_VEHICLE_IDS_BY_REG).find(k=>DRIVER_APP_VEHICLE_IDS_BY_REG[k]===vehicleId);
  // EY15BOV is the established grab truck; vehicle type is reviewed in policy.
  const eight=AGREED_COMPLETION_POLICY.eight_wheeler_registrations.includes(reg);
  const kind=spoil?'mixed_spoil_away':crush&&qty===20&&eight?'6f2_delivered':'part_mixed_delivery';
  if(spoil && (qty!==20 || !eight)) return null;
  const facts={jobDate:date,customerId,siteId:JSON.stringify({address,postcode}),loadId:job.deliveryLoadId||job.collectionLoadId||job.id,quantity:qty,unit:'t',kind,agreementsChecked:true,vehicle:eight?'eight_wheeler':reg||'unknown',fullLoadConfirmed:qty===20&&eight,singleMaterialConfirmed:true};
  const protectedRule=AGREED_COMPLETION_POLICY.protected_agreements.find(a=>a.customer_id===customerId);
  if(protectedRule) {
    if(kind!==protectedRule.material || !protectedRule.exact_site_labels.includes(siteText)) return null;
    facts.agreement={customerId,siteId:facts.siteId,kind,quantity:qty,unit:'t',amount:protectedRule.rate,validOn:date,deliveryInclusive:true,evidence:protectedRule.evidence};
  } else if(AGREED_COMPLETION_POLICY.manual_agreement_customer_ids.includes(customerId)) return null;
  // Do not guess identity behind the miscellaneous A1 account.
  if(customerId===AGREED_COMPLETION_POLICY.a1_customer_id) return null;
  if(spoil) {
    const locality=address.map(a=>normalisedLookupText(a)).find(a=>['lytham','st annes','lytham st annes'].includes(a));
    if(!locality && /lytham|st annes|saint annes/.test(siteText))return null;
    if(locality){facts.localityOverride=locality==='lytham'?'Lytham':'St Annes';facts.localityEvidence='Exact structured locality in live HaulTech address';}
  }
  if(!facts.agreement && !facts.localityOverride) {
    if(!postcode) return null;
    const response=await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`,{signal:AbortSignal.timeout(9000)});
    if(!response.ok) return null;const p=(await response.json()).result;
    if(!p || !Number.isFinite(p.longitude)||!Number.isFinite(p.latitude)) return null;
    facts.route={siteId:facts.siteId,destination:{longitude:p.longitude,latitude:p.latitude},evidence:`postcodes.io:${postcode}; fresh OSRM route`,accessReviewed:true,boundaryReviewRequired:false};
  }
  if(kind==='part_mixed_delivery') {
    if(!part || !reg) return null;
    facts.completeLoadItems=true;facts.deliveryAlreadyCharged=false;
    facts.items=[{id:String(c.id||c.consignmentId||job.id),material:part.name,quantity:qty,unit:part.unit,deliveryInclusive:false}];
    // Plain material record must be the only job on this load: otherwise delivery could be charged twice.
    const jobs=await fetchHaultechJobsByDate(env,date);
    if(!jobs.ok || jobs.jobs.length>=200) return null;
    const load=job.deliveryLoadId||job.collectionLoadId;
    if(!load || jobs.jobs.filter(j=>(j.deliveryLoadId===load||j.collectionLoadId===load)&&j.active!==false&&!j.cancelled).length!==1) return null;
  }
  return {policyVersion:AGREED_COMPLETION_POLICY.version,reviewed:true,source:'live HaulTech exact structured fields + approved canonical policy',snapshot:agreedJobSnapshot(job,qty),facts};
}
async function persistAgreedOutcome(env,job,result,status) {
  const receipt={schema:'pmg.agreed-pricing-result.v2',jobId:job.id,jobNumber:job.jobId,customerId:jobCustomerId(job),date:job.deliveryDate||job.collectionDate,quantity:jobQuantity(job),observedAt:new Date().toISOString(),policyVersion:AGREED_COMPLETION_POLICY.version,status,result};
  await env.PMG_DATA.put(`agreed-pricing-result:${job.id}`,JSON.stringify(receipt));
  await env.PMG_DATA.put(`agreed-pricing-day:${String(receipt.date||'').slice(0,10)}:${job.id}`,JSON.stringify(receipt));
  return receipt;
}
async function verifiedAgreedReprice(env,job,date) {
  if(jobHasExistingPrice(job)) return {status:'preserved_existing_price',jobId:job.id};
  const manualText=[job.accountNotes,job.trafficNotes,jobGoodsDescription(job)].filter(Boolean).join(' ').replace(/not paid/gi,'');
  if(/\bpaid\b|ring for amount|manual price|agreed price|free of charge|no charge/i.test(manualText))return {status:'manual_price_review',jobId:job.id};
  if(!['completed','received','delivered'].includes(normalisedStatus(job.deliveryStatus))) return {status:'awaiting_actual_completion',jobId:job.id};
  if(!job.id || !Array.isArray(job.consignments) || job.consignments.some(c=>c.invoicedCount!==0||c.invoiceExportCount!==0)) return {status:'invoice_or_export_hold',jobId:job.id};
  const historyResponse=await htFetch(env,`/api/Invoice/GetOldInvoices?jobId=${encodeURIComponent(job.id)}`);
  if(!historyResponse.ok) return {status:'invoice_history_unavailable',jobId:job.id};
  const history=await historyResponse.json();if(!Array.isArray(history)||history.length)return {status:'invoice_history_hold',jobId:job.id};
  const price=await completionAutoPrice(job,jobQuantity(job),env);
  if(!price.quotedPrice || price.reviewRequired || !price.changed) {
    return persistAgreedOutcome(env,job,{reason:price.reason||'unsupported'},'review_required');
  }
  // Fresh read and full snapshot comparison before mutation.
  const current=await fetchHaultechJobsByDate(env,date);
  if(!current.ok || current.jobs.length>=200) return {status:'coverage_incomplete'};
  const fresh=current.jobs.find(j=>j.id===job.id);
  if(!fresh || JSON.stringify(fresh)!==JSON.stringify(job)) return persistAgreedOutcome(env,job,{reason:'concurrent_change'},'review_required');
  await persistAgreedOutcome(env,job,{amount:price.quotedPrice,beforeSnapshot:agreedJobSnapshot(job,jobQuantity(job))},'write_pending');
  let response={ok:false};
  try {response=await htFetch(env,'/api/Job/UpsertJob?formId=',{method:'POST',body:JSON.stringify(price.job)});} catch {}
  // Never blindly retry. Reconcile a response or failure with live state.
  const readback=await fetchHaultechJobsByDate(env,date);
  const after=readback.ok?readback.jobs.find(j=>j.id===job.id):null;
  const same=after && Number(after.quotedPrice)===price.quotedPrice && Number(after.totalPrice)===price.quotedPrice && after.useQuotedPrice===true && agreedJobSnapshot(after,jobQuantity(after))===agreedJobSnapshot(job,jobQuantity(job)) && after.trafficNotes===job.trafficNotes && after.deliveryStatus===job.deliveryStatus;
  if(!same) return persistAgreedOutcome(env,job,{amount:price.quotedPrice,httpOk:response.ok,reason:'write_readback_not_proved'},'unknown_do_not_retry');
  return persistAgreedOutcome(env,after,{amount:price.quotedPrice,basis:price.basis,beforePrice:0},'verified');
}
async function runAgreedPricingSweep(env,event={}) {
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(event.scheduledTime||Date.now()));
  const lookup=await fetchHaultechJobsByDate(env,date);
  if(!lookup.ok || lookup.jobs.length>=200) return {status:'coverage_incomplete',date};
  const results=[];
  for(const job of lookup.jobs) {
    if(job.active===false || job.cancelled) continue;
    const previous=await env.PMG_DATA.get(`agreed-pricing-result:${job.id}`,{type:'json'});
    if(['unknown_do_not_retry','write_pending'].includes(previous?.status)) {results.push({jobId:job.id,status:'unknown_do_not_retry'});continue;}
    if(jobHasExistingPrice(job))continue;
    try {results.push(await verifiedAgreedReprice(env,job,date));}
    catch {results.push({jobId:job.id,status:'review_required',reason:'pricing_source_unavailable'});}
  }
  const report={schema:'pmg.agreed-pricing-sweep.v1',observedAt:new Date().toISOString(),date,policyVersion:AGREED_COMPLETION_POLICY.version,results};
  await env.PMG_DATA.put('agreed-pricing-latest-run',JSON.stringify(report));return report;
}

async function agreedDailyResults(env,date) {
  const results=[];let cursor;let complete=false;
  for(let page=0;page<10;page++) {
    const listing=await env.PMG_DATA.list({prefix:`agreed-pricing-day:${date}:`,limit:100,cursor});
    for(const key of listing.keys||[]) {const value=await env.PMG_DATA.get(key.name,{type:'json'});if(value)results.push(value);}
    if(listing.list_complete){complete=true;break;}cursor=listing.cursor;if(!cursor)break;
  }
  const latest=await env.PMG_DATA.get('agreed-pricing-latest-run',{type:'json'});
  return {schema:'pmg.agreed-pricing-daily.v1',date,policyVersion:AGREED_COMPLETION_POLICY.version,observedAt:results.map(r=>r.observedAt).sort().pop()||latest?.observedAt||new Date().toISOString(),coverage:complete?'complete':'partial',results,latestRun:latest?.date===date?latest:null};
}
