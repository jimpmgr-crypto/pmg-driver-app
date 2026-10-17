// Actual workerd top-level requests: response header names are case-insensitive.
const {Miniflare}=require('miniflare');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const key=fs.readFileSync(path.join(root,'worker/index.js'),'utf8').match(/const API_KEY = '([^']+)'/)[1];
const origin='https://browser-fixture.invalid';
const mf=new Miniflare({modules:true,modulesRules:[{type:'ESModule',include:['**/*.js']}],scriptPath:path.join(root,'worker/index.js'),compatibilityDate:'2024-01-01',kvNamespaces:['PMG_DATA'],durableObjects:{PMG_APP_STORE:{className:'PmgAppStore',useSQLite:true}}});
let count=0;
function headers(response,{preflight=false}={}){
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),'*');
  assert.equal(response.headers.get('Access-Control-Allow-Methods'),'GET, PUT, POST, PATCH, DELETE, OPTIONS');
  assert.equal(response.headers.get('Access-Control-Allow-Headers'),'Content-Type, X-PMG-Key, X-PMG-Admin-Key');
  if(!preflight){assert.equal(response.headers.get('Cache-Control'),'no-store');assert.match(response.headers.get('Content-Type'),/application\/json/);}
}
async function request(route,method='GET',body){return mf.dispatchFetch('https://fixture'+route,{method,headers:{Origin:origin,'X-PMG-Key':key,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}
async function check(name,run){await run();count++;console.log('PASS '+name);}
(async()=>{
  await check('native Headers normalization preserves body/status/content type and leaves source headers unchanged',async()=>{const source=fs.readFileSync(path.join(root,'worker/index.js'),'utf8');const start=source.indexOf('function withStoreCors('),end=source.indexOf('\nfunction jobStoreRequest(',start);const CORS_HEADERS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, PUT, POST, PATCH, DELETE, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-PMG-Key, X-PMG-Admin-Key'};const wrap=new Function('Headers','Response','CORS_HEADERS',source.slice(start,end)+'; return withStoreCors;')(Headers,Response,CORS_HEADERS);const original=new Response('fixture-body',{status:207,headers:{'access-control-allow-origin':'https://old.invalid','Access-Control-Allow-Origin':'*','cache-control':'private','Cache-Control':'max-age=123','content-type':'application/custom','X-Trace':'keep'}});const before=[...original.headers];const result=wrap(original);assert.equal(result.status,207);assert.equal(await result.text(),'fixture-body');assert.equal(result.headers.get('Content-Type'),'application/custom');assert.equal(result.headers.get('X-Trace'),'keep');assert.equal(result.headers.get('Access-Control-Allow-Origin'),'*');assert.equal(result.headers.get('Cache-Control'),'no-store');assert.deepEqual([...original.headers],before);});
  const kv=await mf.getKVNamespace('PMG_DATA');
  await kv.put('plant:snapshot:v1',JSON.stringify({schema:'pmg-plant-snapshot-v1',assets:[{id:'fixture-plant',displayName:'Fixture plant',plantNumber:'FIX1'}]}));
  await check('Plant assets GET has one CORS value after nested coordinator response',async()=>{const r=await request('/plant/assets?role=tony');assert.equal(r.status,200);headers(r);const data=await r.json();assert.equal(data.assets.length,1);assert.equal(data.assets[0].id,'fixture-plant');});
  await check('Plant validation rejection retains one CORS value and actual error',async()=>{const r=await request('/plant/service-events','POST',{assetId:'fixture-plant'});assert.equal(r.status,409);headers(r);assert.equal((await r.json()).error,'plant_update_required_reload');});
  await check('Jobs GET adds CORS once without disturbing array contract',async()=>{const r=await request('/jobs/2099-01-01');assert.equal(r.status,200);headers(r);assert.deepEqual(await r.json(),[]);});
  await check('Jobs PUT receipt and conflict both have one CORS value',async()=>{const body={protocol:'pmg-jobs-v3',operations:[{operationId:'fixture-cors-op',movementId:'fixture-cors',expectedRevision:0,row:{id:'fixture-cors',movementId:'fixture-cors',status:'pending'}}]};let r=await request('/jobs/2099-01-01','PUT',body);assert.equal(r.status,200);headers(r);assert.equal((await r.json()).ok,true);body.operations[0].row.status='completed';r=await request('/jobs/2099-01-01','PUT',body);assert.equal(r.status,409);headers(r);assert.equal((await r.json()).error,'backup_conflict');});
  await check('Plant and jobs OPTIONS preflight have one origin and unchanged allowed methods/headers',async()=>{for(const route of ['/plant/assets?role=tony','/jobs/2099-01-01']){const r=await mf.dispatchFetch('https://fixture'+route,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'content-type,x-pmg-key'}});assert.equal(r.status,204);headers(r,{preflight:true});assert.equal(await r.text(),'');}});
  console.log(`PASS ${count} CORS boundary scenarios (5 actual workerd, 1 native Headers)`);
})().finally(()=>mf.dispose()).catch(error=>{console.error(error);process.exitCode=1;});
