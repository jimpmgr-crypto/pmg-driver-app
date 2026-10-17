/* Persist the exact request before transmission. A stale snapshot never borrows
 * the newest server revision; conflicting proposed work stays on the phone. */
(function(root) {
  function canonical(v) { if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'; if(v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}'; return JSON.stringify(v); }
  function clean(row) { const out={...row}; for(const k of Object.keys(out)) if(k.startsWith('_backup')) delete out[k]; return out; }
  function identity(row) { return String(row.movementId || row._movementId || row.id || row.jobId || '').trim(); }
  async function hash(text) { return Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(x=>x.toString(16).padStart(2,'0')).join(''); }
  async function prepare(storage,date,rows,actor) {
    const operations=[];
    for(const original of rows) {
      const row=clean(original), movementId=identity(row), expectedRevision=Number.isSafeInteger(original._backupRevision)?original._backupRevision:0;
      if(!movementId) throw new Error('This backup row has no stable identity. Keep it saved and ask the office to check.');
      const key='pmg_backup_operation_'+date+'_'+await hash(canonical({movementId,expectedRevision,row}));
      let stored; try { stored=JSON.parse(storage.getItem(key)||'null'); } catch { throw new Error('Saved backup request cannot be read. Office review required.'); }
      if(!stored) {
        stored={operationId:root.crypto.randomUUID(),movementId,expectedRevision,row};
        storage.setItem(key,JSON.stringify(stored)); // Must succeed before any network write.
      }
      operations.push(stored);
    }
    return {protocol:'pmg-jobs-v3',actor:actor||'driver',operations};
  }
  function accept(payload,result,rows) {
    if(result?.ok!==true || result.protocol!=='pmg-jobs-v3' || !Array.isArray(result.receipts) || result.receipts.length!==payload.operations.length) throw new Error('Job backup receipt is incomplete. Keep the saved work for retry.');
    for(const op of payload.operations) {
      const matches=result.receipts.filter(r=>r.operationId===op.operationId && r.movementId===op.movementId && Number.isSafeInteger(r.revision) && r.revision>0);
      if(matches.length!==1) throw new Error('Job backup identity was not confirmed.');
    }
    for(const row of rows) {
      const op=payload.operations.find(o=>o.movementId===identity(row) && canonical(o.row)===canonical(clean(row)));
      if(op) row._backupRevision=result.receipts.find(r=>r.operationId===op.operationId).revision;
    }
  }
  async function finish(storage,date,payload) {
    // Only after confirmed revisions have reached local storage. Keep unresolved
    // intents indefinitely, but do not fill phone storage with successful ones.
    for(const op of payload.operations) {
      const key='pmg_backup_operation_'+date+'_'+await hash(canonical({movementId:op.movementId,expectedRevision:op.expectedRevision,row:op.row}));
      storage.removeItem(key);
    }
  }
  function problem(storage,date,payload,message) {
    const key='pmg_backup_problems_'+date;
    let records;try{records=JSON.parse(storage.getItem(key)||'{}');}catch{records={};}
    for(const op of payload.operations) {if(message)records[op.operationId]=message;else delete records[op.operationId];}
    storage.setItem(key,JSON.stringify(records));
    const remaining=Object.values(records)[0];
    if(remaining)storage.setItem('pmg_backup_problem_'+date,remaining);else storage.removeItem('pmg_backup_problem_'+date);
  }
  root.PmgJobBackup={prepare,accept,finish,problem,clean,identity,canonical};
})(typeof globalThis!=='undefined'?globalThis:this);
