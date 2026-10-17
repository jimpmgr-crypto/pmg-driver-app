const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../plant.html'),'utf8');
function load(ctx,...names){for(const name of names){const start=html.search(new RegExp('(?:async )?function '+name+'\\('));assert(start>=0,name);const next=html.slice(start+1).search(/\n    (?:async )?function /);vm.runInContext(html.slice(start,next<0?html.indexOf('</script>',start):start+1+next),ctx)}}
function fixture(){const messages=[];const ctx=vm.createContext({console,crypto,TextEncoder,btoa,Intl,AbortController,
  API_KEY:'synthetic-only',WORKER_URL:'https://example.invalid',setTimeout,clearTimeout,
  navigator:{userAgent:'Synthetic'},state:{assets:[{id:'plant-a'}],record:{asset:{id:'plant-b'}},notifications:{status:'ready'}},
  els:{serviceForm:{dataset:{}},assetForm:{dataset:{}},identityForm:{dataset:{}},plantUpdateNotice:{style:{display:'none'}}},
  plantRetryScopes:new Set(),plantDirtyForms:new Set(),PLANT_BUILD_ID:'current',renderServiceAlerts(){},renderAssetList(){},toast:m=>messages.push(m),window:{confirm:()=>false,location:{reload(){throw Error('Unexpected reload')}}}});return {ctx,messages}}
const cases=[];const test=(name,run)=>cases.push({name,run});
test('API reads do not cache, return status on known rejection and clear timer',async()=>{
  const f=fixture();let cleared=0,options;f.ctx.setTimeout=()=>9;f.ctx.clearTimeout=id=>{assert.equal(id,9);cleared++};f.ctx.fetch=async(url,opts)=>{options=opts;return new Response(JSON.stringify({error:'bad_date'}),{status:400})};load(f.ctx,'api');
  await assert.rejects(f.ctx.api('/plant/service-events',{method:'POST'}),error=>error.status===400&&error.message==='bad_date');assert.equal(options.cache,'no-store');assert.equal(cleared,1);
});
test('API timeout aborts request without claiming a write failed',async()=>{
  const f=fixture();let expire,cleared=false;f.ctx.setTimeout=fn=>{expire=fn;return 1};f.ctx.clearTimeout=()=>{cleared=true};f.ctx.fetch=(url,opts)=>new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('aborted'))));load(f.ctx,'api');
  const request=f.ctx.api('/plant/service-events',{method:'POST'});expire();await assert.rejects(request,/kept for safe retry/);assert(cleared);
});
test('old client rejection explains reload requirement',async()=>{
  const f=fixture();f.ctx.fetch=async()=>new Response(JSON.stringify({error:'plant_update_required_reload'}),{status:409});load(f.ctx,'api');await assert.rejects(f.ctx.api('/plant/assets'),/Reload this page before saving/);
});
for(const invalid of [true,false])test('alert acknowledgement validates exact receipt and preserves current record: '+invalid,async()=>{
  const f=fixture(),button={disabled:false,isConnected:true,dataset:{ackPlantAlert:'plant-a'}};let lists=0;
  f.ctx.renderAssetList=()=>lists++;f.ctx.api=async()=>({ok:true,asset:{id:invalid?'plant-b':'plant-a',alertAcknowledgement:{current:true,acknowledgedBy:'Tony',acknowledgedAt:'2026-10-17T12:00:00Z'}}});load(f.ctx,'acknowledgePlantAlertButton');await f.ctx.acknowledgePlantAlertButton(button);
  assert.equal(f.ctx.state.record.asset.id,'plant-b');assert.equal(button.disabled,false);assert.equal(lists,invalid?0:1);assert.equal(f.messages.includes('Marked as seen by Tony.'),!invalid);
});
test('double alert tap sends once and confirmed render failure remains saved',async()=>{
  const f=fixture(),button={disabled:false,isConnected:true,dataset:{ackPlantAlert:'plant-a'}};let release,calls=0;f.ctx.api=()=>{calls++;return new Promise(resolve=>release=resolve)};f.ctx.renderAssetList=()=>{throw Error('render failure')};load(f.ctx,'acknowledgePlantAlertButton');const first=f.ctx.acknowledgePlantAlertButton(button),second=f.ctx.acknowledgePlantAlertButton(button);
  release({ok:true,asset:{id:'plant-a',alertAcknowledgement:{current:true,acknowledgedBy:'Tony',acknowledgedAt:'2026-10-17T12:00:00Z'}}});await Promise.all([first,second]);assert.equal(calls,1);assert(f.messages.some(m=>m.includes('Marked as seen by Tony, but')));
});
for(const valid of [true,false])test('notification receipt binds this browser endpoint: '+valid,async()=>{
  const f=fixture(),endpoint='https://push.example.invalid/synthetic';const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(endpoint)));const id=Buffer.from(digest).toString('base64url');
  f.ctx.api=async()=>({ok:true,enabled:true,id:valid?id:'other-device'});load(f.ctx,'savePushSubscription');const promise=f.ctx.savePushSubscription({toJSON:()=>({endpoint,keys:{auth:'synthetic',p256dh:'synthetic'}})});if(valid)assert.equal((await promise).id,id);else await assert.rejects(promise,/not confirmed for this phone/);
});
test('notification enable blocks double tap and renders final state',async()=>{
  const f=fixture();let release,permissions=0,renders=0;f.ctx.notificationSupported=()=>true;f.ctx.Notification={requestPermission:()=>{permissions++;return new Promise(resolve=>release=resolve)}};f.ctx.renderNotificationCard=()=>renders++;
  f.ctx.api=async()=>({publicKey:'synthetic'});f.ctx.plantServiceWorkerRegistration=async()=>({pushManager:{getSubscription:async()=>({})}});f.ctx.savePushSubscription=async()=>({ok:true});load(f.ctx,'enableServiceNotifications');
  const a=f.ctx.enableServiceNotifications(),b=f.ctx.enableServiceNotifications();assert.equal(permissions,1);assert.equal(renders,1);release('granted');await Promise.all([a,b]);assert.equal(f.ctx.state.notifications.status,'enabled');assert.equal(renders,2);
});
test('new version shows notice without reloading focused or dirty forms',async()=>{
  const f=fixture();let reloads=0;f.ctx.window.location.reload=()=>reloads++;f.ctx.plantDirtyForms.add(f.ctx.els.identityForm);f.ctx.fetch=async()=>Response.json({plantBuildId:'new'});load(f.ctx,'checkPlantUpdate');await f.ctx.checkPlantUpdate();assert.equal(f.ctx.els.plantUpdateNotice.style.display,'');assert.equal(reloads,0);assert.equal(f.ctx.plantDirtyForms.size,1);
});
test('explicit update reload waits for writes and confirms unsaved edits',()=>{
  const f=fixture();let reloads=0,confirms=0;f.ctx.window.location.reload=()=>reloads++;f.ctx.window.confirm=()=>{confirms++;return false};load(f.ctx,'reloadPlantUpdate');f.ctx.els.serviceForm.dataset.saving='true';f.ctx.reloadPlantUpdate();assert.equal(reloads,0);assert.equal(confirms,0);
  delete f.ctx.els.serviceForm.dataset.saving;f.ctx.plantDirtyForms.add(f.ctx.els.identityForm);f.ctx.reloadPlantUpdate();assert.equal(reloads,0);assert.equal(confirms,1);f.ctx.window.confirm=()=>true;f.ctx.reloadPlantUpdate();assert.equal(reloads,1);
});
(async()=>{const results=[];for(const {name,run} of cases){try{await run();results.push({name,passed:true})}catch(e){results.push({name,passed:false,error:e.stack})}}for(const r of results)console.log(`${r.passed?'PASS':'FAIL'} ${r.name}${r.passed?'':': '+r.error}`);console.log(`${results.filter(r=>r.passed).length}/${results.length} Plant runtime checks passed`);if(process.env.PMG_PLANT_RUNTIME_REPORT)fs.writeFileSync(process.env.PMG_PLANT_RUNTIME_REPORT,JSON.stringify(results,null,2)+'\n');if(results.some(r=>!r.passed))process.exitCode=1})().catch(error=>{console.error(error);process.exitCode=1});
