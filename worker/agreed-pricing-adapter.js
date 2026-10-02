// Server-owned reviewed evidence only. Driver request JSON cannot supply this context.
// Evidence upload/activation remains office-controlled; no route accepts writes here.
async function agreedCompletionAutoPrice(job, quantity, env) {
  const unchanged = reason => ({job,changed:false,reviewRequired:true,reason});
  if (jobHasExistingPrice(job)) return unchanged('existing_price');
  const id=cleanText(job?.id,120);
  if (!id || !env?.PMG_DATA) return unchanged('reviewed_pricing_evidence_required');
  let evidence;
  try { evidence=await env.PMG_DATA.get(`agreed-pricing-evidence:${id}`,{type:'json'}); }
  catch { return unchanged('pricing_evidence_unavailable'); }
  if (!evidence) evidence=await deriveAgreedEvidence(job,quantity,env);
  if (!evidence) return unchanged('source_fields_or_grouping_required');
  const consignment=firstConsignment(job);
  if (evidence?.facts?.jobDate !== String(job.deliveryDate||job.collectionDate||'').slice(0,10)) return unchanged('job_date_evidence_mismatch');
  const currentSnapshot=agreedJobSnapshot(job,quantity);
  // Snapshot equality deliberately holds after address, material, quantity, load or grouping changes.
  if(evidence.policyVersion!==AGREED_COMPLETION_POLICY.version || evidence.snapshot!==currentSnapshot || evidence.reviewed!==true || !evidence.source || !evidence.facts || evidence.facts.customerId!==jobCustomerId(job)) return unchanged('stale_or_unreviewed_pricing_evidence');
  if(!Array.isArray(job.consignments) || !job.consignments.length || job.consignments.some(c=>c.invoicedCount!==0 || c.invoiceExportCount!==0)) return unchanged('invoice_or_export_state_unknown');
  let history;
  try { const response=await htFetch(env,`/api/Invoice/GetOldInvoices?jobId=${encodeURIComponent(id)}`); if(!response.ok) return unchanged('invoice_history_unavailable');history=await response.json(); }
  catch {return unchanged('invoice_history_unavailable');}
  if(!Array.isArray(history) || history.length) return unchanged('invoice_history_hold');
  const facts={...evidence.facts,evidenceVerified:true,quantity:Number(quantity),existingPrices:[Number(job.quotedPrice||0),Number(job.totalPrice||0)],invoiceHistoryClear:true,exportStateClear:true};
  if(facts.kind==='internal_concrete') {
    const group=facts.wholeJob;
    if(!group || !Array.isArray(group.tickets) || !Array.isArray(group.snapshots)) return unchanged('whole_job_live_snapshots_required');
    for(const ticket of group.tickets) {
      if(ticket.id===id) continue;
      const snapshot=group.snapshots.find(s=>s.id===ticket.id);
      if(!snapshot || !snapshot.date || !snapshot.json) return unchanged('whole_job_live_snapshots_required');
      const lookup=await fetchHaultechJobsByDate(env,snapshot.date);
      if(!lookup.ok) return unchanged('whole_job_lookup_failed');
      const member=lookup.jobs.find(j=>j.id===ticket.id);
      if(!member || JSON.stringify(member)!==snapshot.json || jobCustomerId(member)!==jobCustomerId(job) || jobQuantity(member)!==ticket.quantity) return unchanged('whole_job_member_changed');
      if(!Array.isArray(member.consignments) || member.consignments.some(c=>c.invoicedCount!==0 || c.invoiceExportCount!==0)) return unchanged('whole_job_member_invoice_hold');
      if(jobHasExistingPrice(member)) {
        const expected=evaluateAgreedPrice(AGREED_COMPLETION_POLICY,{...facts,ticketId:ticket.id,quantity:ticket.quantity,mixType:ticket.mixType,existingPrices:[0],invoiceHistoryClear:true,exportStateClear:true,evidenceVerified:true},AGREED_CATALOGUE);
        if(expected.status!=='priced' || Number(member.quotedPrice)!==expected.amount || Number(member.totalPrice)!==expected.amount || member.useQuotedPrice!==true)return unchanged('whole_job_existing_price_conflict');
      }
    }
  }
  if(facts.kind==='internal_concrete' && (jobCustomerId(job)!==PM_GROUNDWORKS_CUSTOMER_ID || !isDeliveredConcreteJob(job))) return unchanged('internal_customer_or_material_mismatch');
  // No rounded calculator time; use raw seconds from the same OSRM routing method.
  if(facts.route) {
    const r=facts.route;
    if(!r.destination || !Number.isFinite(r.destination.longitude) || !Number.isFinite(r.destination.latitude)) return unchanged('route_destination_required');
    try {
      const y=AGREED_COMPLETION_POLICY.yard;
      const response=await fetch(`https://router.project-osrm.org/route/v1/driving/${y.longitude},${y.latitude};${r.destination.longitude},${r.destination.latitude}?overview=false&alternatives=false&steps=false`, {signal:AbortSignal.timeout(9000)});
      if(!response.ok) return unchanged('road_route_unavailable');
      const body=await response.json();const route=body.routes?.[0];
      if(body.code!=='Ok' || !route || !Number.isFinite(route.duration) || route.duration<=0) return unchanged('road_route_unavailable');
      facts.route={...r,seconds:route.duration,originPostcode:y.postcode,method:'osrm_driving'};
      // Reviewed band must match the freshly fetched route. A crossing cannot silently reprice.
      const band=route.duration<=1500?0:route.duration<=2700?1:2;
      if(r.reviewedBand!==undefined && r.reviewedBand!==band) return unchanged('road_band_changed_since_review');
    } catch {return unchanged('road_route_unavailable');}
  }
  const result=evaluateAgreedPrice(AGREED_COMPLETION_POLICY,facts,AGREED_CATALOGUE);
  if(result.status!=='priced') return unchanged(result.reason);
  // Private audit context is kept in Worker KV; never written to customer/account/traffic notes.
  try {await env.PMG_DATA.put(`agreed-pricing-result:${id}`,JSON.stringify({schema:'pmg.agreed-pricing-result.v1',jobId:id,observedAt:new Date().toISOString(),result,source:evidence.source,status:'calculated_not_write_verified'}));}
  catch {return unchanged('private_audit_write_failed');}
  return {job:{...job,quotedPrice:result.amount,totalPrice:result.amount,useQuotedPrice:true},changed:true,quotedPrice:result.amount,basis:result.basis,pricingEvidence:result};
}
