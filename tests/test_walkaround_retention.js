const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const source = fs.readFileSync(__dirname + '/../worker/index.js','utf8');
function fn(name) {
  const start = source.search(new RegExp('(?:async )?function '+name+'\\('));
  const end = source.indexOf('\n}',start);
  assert(start >= 0 && end > start, name);
  return source.slice(start,end+2);
}
const context = vm.createContext({
  crypto:webcrypto,TextEncoder,Date,Intl,
  safeJsonParse:raw=>raw?JSON.parse(raw):null,
  corsResponse:(body,status=200)=>({body:JSON.parse(body),status}),
});
for (const name of ['isValidIsoDate','proofBytesHash','walkaroundRetentionCutoff','validWalkaroundRetentionIdentity','walkaroundRetentionKey','handleWalkaroundRetention']) vm.runInContext(fn(name),context);
(async()=>{
  const records=new Map(), env={PMG_DATA:{get:async key=>records.get(key),put:async (key,raw)=>records.set(key,raw)}};
  const cutoff=context.walkaroundRetentionCutoff();
  const oldDay=new Date(cutoff+'T12:00:00Z');
  oldDay.setUTCDate(oldDay.getUTCDate()-1);
  const date=oldDay.toISOString().slice(0,10);
  const old={date,driverId:'11111111-1111-4111-8111-111111111111',vehicle:'PN25AMU',trailer:'',startedAt:date+'T05:00:00Z',recordId:'wa-original-retention-id',checkSha256:'b'.repeat(64),
    photos:Object.fromEntries(['front_left','rear_left','rear_right','front_right'].map(kind=>[kind,'a'.repeat(64)]))};
  assert.equal((await context.handleWalkaroundRetention(env,[old],false)).body.receipts.length,0);
  assert.equal((await context.handleWalkaroundRetention(env,[{...old,date:cutoff}],true)).body.receipts.length,0);
  assert.equal((await context.handleWalkaroundRetention(env,[{...old,photos:{}}],true)).body.receipts.length,0);
  const receipt=(await context.handleWalkaroundRetention(env,[old],true)).body.receipts[0];
  assert.deepEqual(receipt,old);
  assert.equal(records.size,1);
  assert.equal((await context.handleWalkaroundRetention(env,[{...old,recordId:'wa-conflicting-record'}],true)).body.receipts.length,0);
  assert.equal((await context.handleWalkaroundRetention(env,[{...old,vehicle:'PN25FLF'}],false)).body.receipts.length,0);
  assert.equal((await context.handleWalkaroundRetention(env,[{...old,trailer:'C000001'}],false)).body.receipts.length,0);
  assert.equal((await context.handleWalkaroundRetention(env,Array(31).fill(old),false)).status,400);
  assert.equal((await context.handleWalkaroundRetention(env,[old],false)).body.receipts[0].recordId,old.recordId);
  const admin=source.slice(source.indexOf("if (path === '/admin/walkaround-retention'"),source.indexOf('// Read-only recovery.'));
  assert(admin.indexOf('hasAdminKey') < admin.indexOf('handleWalkaroundRetention'));
  console.log('PASS retention date bound, all photos, exact identity, immutable receipts, and admin write gate');
})().catch(error=>{console.error(error);process.exitCode=1;});
