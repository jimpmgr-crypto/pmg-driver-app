// Real workerd/SQLite persistence, no production calls.
const {Miniflare}=require('miniflare');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pmg-diary-'));
const source=fs.readFileSync(path.join(root,'worker/index.js'),'utf8');
const key=source.match(/const API_KEY = '([^']+)'/)[1];
let mf, fail=false;
fs.cpSync(path.join(root,'worker'),path.join(dir,'worker'),{recursive:true,filter:p=>!p.includes('/.wrangler') && !p.includes('/node_modules')});
const fixtureSource=source.replace('date => fetchDiarySource(this.env,date))',"date => fetchDiarySource(this.env,date),new Date('2026-10-21T20:00:00.000Z'))");
fs.writeFileSync(path.join(dir,'worker/index.js'),fixtureSource);
const savedAt='2026-10-21T20:00:00.000Z',row={id:'test-guid',jobId:99000,driverName:'John Bowman',deliveryDate:'2026-10-22',status:'Scheduled'};
function start(){mf=new Miniflare({modules:true,modulesRoot:dir,modulesRules:[{type:'ESModule',include:['**/*.js']}],scriptPath:path.join(dir,'worker/index.js'),compatibilityDate:'2024-01-01',kvNamespaces:['PMG_DATA'],kvPersist:path.join(dir,'kv'),durableObjects:{PMG_APP_STORE:{className:'PmgAppStore',useSQLite:true}},durableObjectsPersist:path.join(dir,'do'),outboundService:()=>fail ? new Response('fixture unavailable',{status:500}) : Response.json([row])});}
async function read(date,suffix=''){const r=await mf.dispatchFetch('https://fixture/driver-diary/'+date+suffix,{headers:{'X-PMG-Key':key}});return {status:r.status,body:await r.json(),cors:r.headers.get('Access-Control-Allow-Origin')};}
(async()=>{start();assert.equal((await mf.dispatchFetch('https://fixture/driver-diary/2026-10-22')).status,401);assert.equal((await read('2026-02-30')).status,400);
const kv=await mf.getKVNamespace('PMG_DATA');await kv.put('haultech-auth',JSON.stringify({token:'synthetic-test-only',tmsId:'synthetic'}));
let first=await read('2026-10-22');assert.equal(first.body.state,'live');
await mf.dispose();fs.writeFileSync(path.join(dir,'worker/index.js'),source);fail=true;start();
let result=await read('2026-10-22');assert.equal(result.body.state,'cached');assert.equal(result.body.jobs[0].jobId,99000);assert.equal(result.body.savedAt,savedAt);assert.equal(result.cors,'*');
await mf.dispose();start();result=await read('2026-10-22','?stored=true');assert.equal(result.body.jobs[0].jobId,99000);assert.equal(result.body.state,'cached');
const absent=await read('2026-10-23');assert.equal(absent.body.complete,false);assert.equal(absent.body.state,'unavailable');
assert.equal((await mf.dispatchFetch('https://fixture/driver-diary/2026-10-22',{method:'PUT',headers:{'X-PMG-Key':key},body:'[]'})).status,404);
console.log('PASS real workerd diary outage, restart persistence, date/auth/CORS and no public write route');
})().finally(async()=>{if(mf)await mf.dispose();fs.rmSync(dir,{recursive:true,force:true});}).catch(e=>{console.error(e);process.exitCode=1});
