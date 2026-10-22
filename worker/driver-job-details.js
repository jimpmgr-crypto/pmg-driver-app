// Driver-only projection of full HaulTech jobs. Never merge detail records into
// operational status, allocation, pricing or completion-write payloads.
const jobFields = ['customerReference','jobReference','collectionReference','deliveryReference','bookingReference','bookingTelephone','trafficNotes','specialInstructions','collectionStartTime','collectionEndTime','deliveryStartTime','deliveryEndTime'];
const legFields = ['AddressLine1','AddressLine2','AddressLine3','AddressLine4','AddressLine5','Postcode','Country','ContactName','ContactTelephone','ContactMobile','ContactNumber','ContactEmailAddress','EmailAddress','ConsignmentNote','RestrictedAccess'];
const consignmentFields = ['id','consignmentReference','note1','note2', ...['collection','delivery'].flatMap(leg => legFields.map(field => leg+field))];
function pick(source, fields) {
  return Object.fromEntries(fields.filter(k => ['string','number','boolean'].includes(typeof source?.[k]) || source?.[k] === null).map(k => [k, source[k]]));
}
export function projectDriverDetails(job, detail, now = new Date().toISOString()) {
  if (!detail || String(detail.id).toLowerCase() !== String(job.id).toLowerCase() || (!Array.isArray(detail.consignments) || detail.consignments.some(c => !c || typeof c !== 'object' || Array.isArray(c)))) throw new Error('detail_identity_or_shape');
  return {...pick(detail,jobFields), consignments:detail.consignments.map(c => pick(c,consignmentFields)), state:'live', savedAt:now};
}
export async function enrichDriverDetails(jobs, fetchDetail) {
  const result = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({length:Math.min(4,jobs.length)}, async () => {
    while (next < jobs.length) {
      const index = next++, job = jobs[index];
      try { result[index] = {...job, driverDetails:projectDriverDetails(job,await fetchDetail(job.id))}; }
      catch { result[index] = {...job, driverDetails:{state:'unavailable',savedAt:''}}; }
    }
  }));
  return result;
}
