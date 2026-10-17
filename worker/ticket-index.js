// Date pointer index in the same transactional binding. Original tickets/assets
// remain in KV. Backfill advances a saved cursor only after its full page is indexed.
function json(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
export async function bulkTicketRows(env,keys){
  const rows=[];
  for(let i=0;i<keys.length;i+=100){
    const batch=keys.slice(i,i+100), values=await env.PMG_DATA.get(batch);
    if(!values || typeof values.get!=='function')throw new Error('ticket_bulk_read_unavailable');
    for(const key of batch){const raw=values.get(key);if(raw==null)throw new Error('indexed_ticket_unavailable');let value;try{value=JSON.parse(raw);}catch{throw new Error('ticket_invalid_json');}rows.push(value);}
  }
  return rows;
}
export function ticketIndexStub(env){if(!env.PMG_APP_STORE)throw new Error('ticket_index_unavailable');return env.PMG_APP_STORE.get(env.PMG_APP_STORE.idFromName('ticket-index:v1'));}
export async function recordTicketIndex(env,ticketId,event){
  const date=typeof event?.date==='string' && /^\d{4}-\d{2}-\d{2}$/.test(event.date)?event.date:'';
  const response=await ticketIndexStub(env).fetch('https://store/__ticket_index/record',{method:'POST',body:JSON.stringify({key:'ticket:'+ticketId,date})});
  if(!response.ok)throw new Error('ticket_index_write_unconfirmed');
}
export async function readDateTickets(env,date){
  const response=await ticketIndexStub(env).fetch('https://store/__ticket_index/date?date='+encodeURIComponent(date));
  if(!response.ok)throw new Error('ticket_index_backfill_required');
  const {keys}=await response.json();
  const rows=await bulkTicketRows(env,keys);
  if(rows.some(row=>row?.date!==date))throw new Error('indexed_ticket_date_unavailable');
  return rows;
}
export async function handleTicketIndex(ctx,env,request){
  return ctx.blockConcurrencyWhile(async()=>{
    const sql=ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS ticket_dates (key TEXT PRIMARY KEY,date TEXT NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS ticket_dates_date ON ticket_dates(date)');
    sql.exec('CREATE TABLE IF NOT EXISTS ticket_index_state (id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL)');
    const state=()=>JSON.parse(sql.exec('SELECT state FROM ticket_index_state WHERE id=1').toArray()[0]?.state||'{"cursor":"","complete":false,"scanned":0,"undated":0}');
    const url=new URL(request.url);
    if(url.pathname.endsWith('/status'))return json({...state(),indexed:sql.exec('SELECT count(*) AS n FROM ticket_dates').toArray()[0].n});
    if(url.pathname.endsWith('/date')){
      if(!state().complete)return json({error:'ticket_index_backfill_required'},503);
      const date=url.searchParams.get('date');if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))return json({error:'bad_date'},400);
      return json({date,complete:true,keys:sql.exec('SELECT key FROM ticket_dates WHERE date=? ORDER BY key',date).toArray().map(r=>r.key)});
    }
    let body;try{body=await request.json();}catch{return json({error:'bad_json'},400);}
    if(url.pathname.endsWith('/record')){
      if(typeof body.key!=='string'||!body.key.startsWith('ticket:')||!(body.date===''||/^\d{4}-\d{2}-\d{2}$/.test(body.date)))return json({error:'bad_index_entry'},400);
      sql.exec('INSERT INTO ticket_dates(key,date) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET date=excluded.date',body.key,body.date);
      return json({ok:true});
    }
    if(!url.pathname.endsWith('/backfill'))return json({error:'bad_route'},404);
    const previous=state();if(previous.complete)return json({ok:true,...previous});
    if(String(body.cursor||'')!==previous.cursor)return json({ok:false,error:'backfill_cursor_changed',...previous},409);
    const page=await env.PMG_DATA.list({prefix:'ticket:',limit:100,...(previous.cursor?{cursor:previous.cursor}:{})});
    if(!Array.isArray(page.keys)||(!page.list_complete&&!page.cursor))throw new Error('invalid_ticket_page');
    const values=await bulkTicketRows(env,page.keys.map(k=>k.name));
    const next={cursor:page.list_complete?'':page.cursor,complete:!!page.list_complete,scanned:previous.scanned+values.length,undated:previous.undated,updatedAt:new Date().toISOString()};
    ctx.storage.transactionSync(()=>{
      values.forEach((event,i)=>{const date=typeof event?.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(event.date)?event.date:'';if(!date)next.undated++;sql.exec('INSERT OR IGNORE INTO ticket_dates(key,date) VALUES(?,?)',page.keys[i].name,date);});
      sql.exec('INSERT INTO ticket_index_state(id,state) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state',JSON.stringify(next));
    });
    return json({ok:true,...next});
  });
}
