const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function fn(name) {
  const start = html.indexOf('function ' + name + '(');
  assert(start >= 0, name);
  return html.slice(html.slice(start - 6, start) === 'async ' ? start - 6 : start, html.indexOf('\n}', start) + 2);
}
(async () => {
  for (const driver of ['john', 'andrew', 'neil', 'ian', 'richard', 'paul']) {
    const remote = {id:'other-driver-row', movementId:'driver-other', _driverAdded:true, savedAt:'old'};
    const localProposal = {id:'local-row', movementId:'driver-local', _driverAdded:true, status:'problem', proofReceipt:{protected:true}};
    let writes=0, saved, retries=0, mergeOptions;
    const c=vm.createContext({
      document:{hidden:false}, todayISO:()=> '2026-11-13', $:()=>({innerHTML:''}), showError(){},
      flushRetryQueue:async()=>{retries++;}, customers:[{}],
      api:async()=>({ok:true,json:async()=>({date:'2026-11-13',complete:true,state:'live',savedAt:'2026-11-13T12:00:00Z',jobs:[remote]})}),
      hydrateBackupRevisions:async(d,j)=>j,
      PmgDriverStorage:{readJobRaw:async()=>JSON.stringify([localProposal])},
      mergeWithLocal:(d,j,l,options)=>{mergeOptions=options;return [...j,...l];},
      renderJobs(){}, updateSyncUI(){}, console,
      ensureDriverStorageSpace:async()=>{},
      localSaveJobs:async(d,j,expected)=>{saved=JSON.parse(JSON.stringify(j));assert.equal(expected,JSON.stringify([localProposal]));return true;},
      saveJobsToCloud:async()=>{writes++;}, cloudPutJobs:async()=>{writes++;},
      loadJobsFallback:async()=>{throw Error('Unexpected fallback');},
    });
    // The same shared code runs for every named route. A plan read retains both
    // foreign live rows and protected local work without creating a new write.
    if(html.includes('async function saveRefreshedJobsLocally(')) vm.runInContext(fn('saveRefreshedJobsLocally'),c);
    vm.runInContext(fn('loadJobs'),c);
    await c.loadJobs({force:true});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(writes,0,driver+' refresh must not create backup requests');
    assert.equal(retries,1,'existing exact pending intents still get their normal retry');
    assert.equal(mergeOptions.retryLocalRows,false);
    assert.equal(saved.length,2);
    assert.deepEqual(saved[1],localProposal);
  }
  let uploads=0;
  const pending={id:'driver-pending',movementId:'driver-pending',status:'problem',notes:'retain this'};
  const c=vm.createContext({getHaultechJobId:()=>'',driverMovementId:j=>j.movementId,
    clearMatchedDriverWritebackQueue(){},isLocalDriverTempJob:()=>true,findMatchingLiveDriverJob:()=>null,
    getCollectionAddress:()=>'',getDeliveryAddress:()=>'',cachedDriverFields:()=>({}),cloudPutJobs:async()=>{uploads++;},addToRetryQueue(){}});
  vm.runInContext(fn('mergeWithLocal'),c);
  const retained=c.mergeWithLocal('2026-11-13',[],[pending],{retryLocalRows:false});
  assert.equal(retained.length,1);assert.equal(retained[0]._notes,'retain this');assert.equal(uploads,0);
  c.mergeWithLocal('2026-11-13',[],[pending]);
  assert.equal(uploads,1,'explicit existing recovery behaviour remains available');
  const edited={id:'driver-own',_driverAdded:true,notes:'actual driver edit'};
  const foreign={id:'driver-other',_driverAdded:true,notes:'other driver retained'};
  let offline, submitted;
  const edit=vm.createContext({jobToLocal:j=>j,driverReviewBackupJobs:j=>j,
    ensureDriverStorageSpace:async()=>{},localSaveJobs:async(d,j)=>{offline=j;return true;},
    cloudPutJobs:async(d,j)=>{submitted=j;},updateSyncUI(){},addToRetryQueue(){throw Error('Unexpected retry');}});
  vm.runInContext(fn('saveJobsToCloud'),edit);
  await edit.saveJobsToCloud('2026-11-13',[edited,foreign],undefined,[edited]);
  assert.equal(offline.length,2);assert.equal(submitted.length,1);assert.equal(submitted[0].id,edited.id);
  for(const name of ['cancelDriverJob','handleSignComplete']) {
    assert(fn(name).includes('saveJobsToCloud(todayISO(), allJobs, undefined, [job])'),name+' must bind the edit to its actual job');
  }
  console.log('PASS six driver plan refreshes make no new backup writes; protected proposals, exact retries and explicit recovery retained');
})().catch(e=>{console.error(e);process.exitCode=1;});
