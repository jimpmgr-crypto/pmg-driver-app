const fs=require('fs'),vm=require('vm'),assert=require('assert');
const html=fs.readFileSync(__dirname+'/../index.html','utf8');
const source=html.slice(html.indexOf('const driverAddRequests = new Map();'),html.indexOf('async function flushRetryQueue()'));
let calls=0,release,fail=false,jobId='00000000-0000-4000-8000-000000000001';
const c={Map,Error,JSON,isGuidId:id=>id==='00000000-0000-4000-8000-000000000001',api:async()=>{calls++;await new Promise(r=>release=r);return {ok:!fail,status:502,json:async()=>fail?{error:'offline'}:{ok:true,jobId}};}};
vm.createContext(c);vm.runInContext(source+';globalThis.submit=submitDriverAddedRow;',c);
(async()=>{let a=c.submit({movementId:'one'},'2026-10-14'),b=c.submit({movementId:'one'},'2026-10-14');assert.equal(calls,1);release();await Promise.all([a,b]);await c.submit({movementId:'one'},'2026-10-14');assert.equal(calls,1);
let d=c.submit({movementId:'two'},'2026-10-14');assert.equal(calls,2);release();await d;
fail=true;let e=c.submit({movementId:'three'},'2026-10-14');release();await assert.rejects(e);fail=false;e=c.submit({movementId:'three'},'2026-10-14');assert.equal(calls,4);release();await e;jobId='';let missing=c.submit({movementId:'four'},'2026-10-14');release();await assert.rejects(missing,/has not confirmed/);jobId='00000000-0000-4000-8000-000000000001';missing=c.submit({movementId:'four'},'2026-10-14');release();assert.equal((await missing).jobId,jobId);console.log('concurrent retry, settled retry, distinct loads and failure recovery passed');})().catch(e=>{console.error(e);process.exitCode=1;});
