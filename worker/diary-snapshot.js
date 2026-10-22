// Read-only HaulTech replica. Separate from driver edits, status and proof storage.
export const DIARY_CRON = '*/5 * * * *';
export function diaryDates(now = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return Array.from({length:4}, (_,i) => new Date(Date.parse(day+'T12:00:00Z')+i*86400000).toISOString().slice(0,10));
}
export function validateDiary(payload, continuation = '') {
  const jobs = Array.isArray(payload) ? payload : (payload?.items || payload?.data);
  if (!Array.isArray(jobs) || jobs.some(j => !j || typeof j !== 'object' || Array.isArray(j) || !j.id || !j.jobId)) throw new Error('invalid_diary');
  const total = payload?.totalCount ?? payload?.count ?? payload?.total;
  if (continuation || jobs.length >= 1000 || (total !== undefined && Number(total) !== jobs.length)) throw new Error('incomplete_diary');
  if (new Set(jobs.map(j => String(j.id))).size !== jobs.length) throw new Error('duplicate_diary_identity');
  return jobs;
}
export function diaryReply(record, date) {
  const snapshot = record?.snapshot;
  return { date, state: snapshot ? (record.error ? 'cached' : 'live') : 'unavailable', jobs: snapshot?.jobs || [], savedAt: snapshot?.savedAt || '', checkedAt: record?.checkedAt || '', error: record?.error || '', complete: !!snapshot };
}
export async function refreshDiary(storage, date, fetchSource, now = new Date()) {
  const startedAt = now.toISOString();
  const prior = await storage.get('diary');
  const age = Date.parse(startedAt) - Date.parse(prior?.checkedAt || '');
  if (age >= 0 && age < (prior?.error ? 60000 : 120000)) return diaryReply(prior, date);
  let jobs, error = '';
  try { jobs = await fetchSource(date); } catch (e) { error = String(e.message || 'source_unavailable').slice(0,100); }
  return storage.transaction(async tx => {
    const current = await tx.get('diary');
    // A slow older request may never replace a newer read or health result.
    if (current?.checkedAt >= startedAt) return diaryReply(current, date);
    const next = { date, checkedAt: startedAt, error, snapshot: error ? current?.snapshot : { jobs, savedAt: startedAt } };
    await tx.put('diary', next);
    return diaryReply(next, date);
  });
}
