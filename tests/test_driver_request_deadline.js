const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(__dirname+'/../index.html','utf8'),start=html.indexOf('async function driverFetch('),end=html.indexOf('\n}',start)+2;
assert(start>=0);const ctx=vm.createContext({AbortController,Response,setTimeout,clearTimeout,fetch:global.fetch});vm.runInContext(html.slice(start,end),ctx);
(async()=>{
 let aborted=false;
 ctx.fetch=async(u,opts)=>{opts.signal.addEventListener('abort',()=>aborted=true);return new Promise(()=>{});};
 await assert.rejects(()=>ctx.driverFetch('https://fixture.invalid',{},10),/timed out before confirmation/);assert(aborted);
 ctx.fetch=async()=>({clone:()=>({arrayBuffer:()=>new Promise(()=>{})})});
 await assert.rejects(()=>ctx.driverFetch('https://fixture.invalid',{},10),/timed out before confirmation/);
 ctx.fetch=async()=>new Response(JSON.stringify({ok:true}),{status:200,headers:{'Content-Type':'application/json'}});
 const response=await ctx.driverFetch('https://fixture.invalid',{method:'POST'},1000);assert.equal(response.status,200);assert.equal((await response.json()).ok,true);assert.equal(response.headers.get('Content-Type'),'application/json');
 let writes=0;ctx.fetch=async()=>{writes++;return new Promise(()=>{});};
 await assert.rejects(()=>ctx.driverFetch('https://fixture.invalid',{method:'POST'},10));assert.equal(writes,1,'unknown reply never silently replays a write');
 console.log('PASS deadlines cover headers and bodies, abort stalled connections, preserve receipts and never replay unknown writes');
})().catch(e=>{console.error(e);process.exitCode=1});
