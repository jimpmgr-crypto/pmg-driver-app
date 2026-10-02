const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const root='/Users/bill/.openclaw/workspace';
const paths=['projects/pmg-driver-app/index.html','projects/pmg-yard-input/index.html','projects/pmg-driver-app/worker/index.js','scripts/haultech-tickets/worker/index.js'];
for(const p of paths){
 const source=fs.readFileSync(root+'/'+p,'utf8');const block=source.match(/\/\/ BEGIN GENERATED PMG_YARD_PRICES:COLLECTED_CONCRETE[\s\S]*?\/\/ END GENERATED PMG_YARD_PRICES:COLLECTED_CONCRETE/)[0];
 const ctx={};vm.createContext(ctx);vm.runInContext(block,ctx);
 for(const [name,half,one] of [['Quarried',90,130],['Recycled',80,120]]){
  const material='Collected concrete - '+name;
  for(const [q,expected] of [[.5,half],[.6,half+8],[.75,(half+one)/2],[.9,half+32],[1,one],[1.2,one*1.2],[2.5,one*2.5]])assert.equal(ctx.collectedConcreteQuote(material,q,'m3').amount,expected,p+q);
  for(const q of [0,.49,-1,NaN,Infinity])assert(ctx.collectedConcreteQuote(material,q,'m3').error);
  assert(ctx.collectedConcreteQuote(material,1,'tonnes').error);
 }
 for(const material of ['Concrete','6F2 Crushed Concrete','Quarried Concrete Aggregate (4/20)','ST1','Lego block - Full'])assert.equal(ctx.collectedConcreteQuote(material,1,'m3'),null);
}
const worker=fs.readFileSync(root+'/projects/pmg-driver-app/worker/index.js','utf8');
assert(worker.includes("reason:'collected_concrete_intake_price_or_office_review'"));
assert(worker.includes("error:'collected_concrete_source_conflict'"));
console.log('PASS collected concrete curve, minimum, units, source split and delivered-material isolation across4consumers');
