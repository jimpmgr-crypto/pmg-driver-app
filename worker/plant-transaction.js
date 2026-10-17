// Plant writes share one Durable Object. Documents and request receipts commit together.
// Legacy KV is a compatibility mirror, never a lock or the authority after a document is stored.
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
}
function rows(ctx, sql, ...bindings) { return Array.from(ctx.storage.sql.exec(sql, ...bindings)); }
function initialise(ctx) {
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS plant_documents (key TEXT PRIMARY KEY, value TEXT, deleted INTEGER NOT NULL DEFAULT 0)');
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS plant_receipts (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, headers TEXT NOT NULL, body TEXT NOT NULL)');
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {status, headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'}});
}
function isUiWrite(path, method) {
  return (method === 'POST' && ['/plant/service-events','/plant/assets'].includes(path))
    || (method === 'PATCH' && /^\/plant\/assets\/[^/]+$/.test(path));
}
async function descriptor(request) {
  const url = new URL(request.url);
  if (!isUiWrite(url.pathname, request.method)) return null;
  let body;
  try { body = await request.clone().json(); } catch { return {error:'bad_json',status:400}; }
  if (!body || Array.isArray(body) || typeof body !== 'object') return {error:'bad_json',status:400};
  const requestId = body.requestId;
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    return {error:'plant_update_required_reload',status:409};
  }
  const contents = {...body};delete contents.requestId;
  const encoded = new TextEncoder().encode(stableJson({method:request.method,path:url.pathname,query:url.search,body:contents}));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return {requestId, fingerprint:Array.from(new Uint8Array(digest)).map(byte=>byte.toString(16).padStart(2,'0')).join('')};
}
async function readLocal(ctx, env, key) {
  const row = rows(ctx,'SELECT value, deleted FROM plant_documents WHERE key = ?',key)[0];
  if (row) return row.deleted ? null : row.value;
  return env.PMG_DATA.get(key);
}
function valueAs(raw, options) {
  const type = typeof options === 'string' ? options : options?.type;
  if (raw == null) return null;
  if (type === 'json') return JSON.parse(raw);
  if (type === 'arrayBuffer') return new TextEncoder().encode(raw).buffer;
  if (type && type !== 'text') throw new Error('Unsupported Plant document read type.');
  return raw;
}
export async function readPlantDocument(env, key) {
  if (typeof key !== 'string' || !key.startsWith('plant:')) throw new Error('Invalid Plant document key.');
  if (!env.PMG_APP_STORE) throw new Error('Plant transactional store unavailable.');
  const stub = env.PMG_APP_STORE.get(env.PMG_APP_STORE.idFromName('plant:v1'));
  const response = await stub.fetch('https://plant.internal/__plant_document?key='+encodeURIComponent(key));
  if (!response.ok) throw new Error('Plant authoritative read failed.');
  return (await response.json()).value;
}
export async function handlePlantTransaction(ctx, env, request, execute) {
  return ctx.blockConcurrencyWhile(async () => {
    initialise(ctx);
    const url = new URL(request.url);
    if (url.pathname === '/__plant_document' && request.method === 'GET') {
      const key = url.searchParams.get('key');
      if (!key?.startsWith('plant:')) return json({error:'bad_document_key'},400);
      return json({value:await readLocal(ctx,env,key)});
    }
    const operation = await descriptor(request);
    if (operation?.error) return json({error:operation.error},operation.status);
    if (operation) {
      const receipt = rows(ctx,'SELECT fingerprint, status, headers, body FROM plant_receipts WHERE request_id = ?',operation.requestId)[0];
      if (receipt) {
        if (receipt.fingerprint !== operation.fingerprint) return json({error:'plant_request_payload_conflict',requestId:operation.requestId},409);
        return new Response(receipt.body,{status:receipt.status,headers:JSON.parse(receipt.headers)});
      }
    }
    const dirty = new Map(), readCache = new Map();
    const transactionEnv = {...env,__PMG_STORE:true,PMG_DATA:{
      async get(key, options) {
        if (Array.isArray(key)) {
          if (key.every(item=>typeof item==='string'&&!item.startsWith('plant:'))) return env.PMG_DATA.get(key,options);
          return new Map(await Promise.all(key.map(async item=>[item,await this.get(item,options)])));
        }
        if (!key.startsWith('plant:')) return env.PMG_DATA.get(key,options);
        if (dirty.has(key)) return valueAs(dirty.get(key),options);
        if (!readCache.has(key)) readCache.set(key,await readLocal(ctx,env,key));
        return valueAs(readCache.get(key),options);
      },
      async put(key,value) {
        if (!key.startsWith('plant:') || typeof value !== 'string') throw new Error('Unsupported Plant transaction write.');
        dirty.set(key,value);
      },
      async delete(key) {
        if (!key.startsWith('plant:')) throw new Error('Unsupported Plant transaction delete.');
        dirty.set(key,null);
      },
      async list(options) {
        if (options?.prefix?.startsWith('plant:')) throw new Error('Plant document listing must use its explicit authoritative keys.');
        return env.PMG_DATA.list(options);
      }
    }};
    let response;
    try { response = await execute(request,transactionEnv); }
    catch { return json({error:'plant_write_not_committed_retry_original'},503); }
    if (!response.ok) return response;
    let body = await response.text();
    const headers = new Headers(response.headers);headers.set('Cache-Control','no-store');
    if (operation) {
      let value;
      try { value=JSON.parse(body); } catch { return json({error:'plant_receipt_invalid'},503); }
      if (value?.ok !== true) return json({error:'plant_receipt_invalid'},503);
      body=JSON.stringify({...value,requestId:operation.requestId});
    }
    try {
      ctx.storage.transactionSync(() => {
        for (const [key,value] of dirty) ctx.storage.sql.exec('INSERT INTO plant_documents (key,value,deleted) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, deleted=excluded.deleted',key,value,value===null?1:0);
        if (operation) ctx.storage.sql.exec('INSERT INTO plant_receipts (request_id,fingerprint,status,headers,body) VALUES (?,?,?,?,?)',operation.requestId,operation.fingerprint,response.status,JSON.stringify([...headers]),body);
      });
    } catch { return json({error:'plant_commit_failed_retry_original'},503); }
    // Commit precedes mirroring. Failure here cannot turn a saved request into a new request.
    // Every Plant API/cron consumer reads the Durable Object, so a stale mirror is not authoritative.
    for (const [key,value] of dirty) {
      try { if (value===null) await env.PMG_DATA.delete(key);else await env.PMG_DATA.put(key,value); } catch {}
    }
    return new Response(body,{status:response.status,headers});
  });
}
