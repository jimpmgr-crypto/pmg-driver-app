const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root,'index.html'),'utf8');
const worker = fs.readFileSync(path.join(root,'worker/index.js'),'utf8');
function fn(source,name) {
 const start=source.search(new RegExp('(?:async )?function '+name+'\\('));assert(start>=0,name);
 const tail=source.slice(start), end=tail.slice(1).search(/\n(?:async )?function |\nexport default/);
 return end<0?tail:tail.slice(0,end+1);
}
const items = [
 ['40mm Quarried MOT',29,31],['20mm Quarried MOT',31.5,33.5],['Type 3 MOT',33,35],
 ['Quarried 6mm Clean Stone',38.5,41.5],['Quarried 10mm Clean Stone',41.5,44],
 ['Quarried 20mm Clean Stone',41.5,44],['Quarried Concrete Aggregate (4/20)',38,40.5]
];
const inputs={'f-vehicle':{value:'LL21HJJ'},'f-material':{value:''},'f-unit':{value:'m3'},'f-notes':{value:'C35 8m3 concrete'},'f-concrete-type':{value:'quarried'},'concrete-type-fields':{classList:{toggle(k,hidden){this.hidden=hidden;}}}};
const front=vm.createContext({$:id=>inputs[id]});
vm.runInContext(app.match(/const MATERIAL_PRICING = \{[\s\S]*?\n\};/)[0]+"\nconst VOLUMETRIC_CONCRETE_VEHICLES = new Set(['LL21HJJ','PN25FLF']);\n"+['normaliseVehicleReg','isVolumetricConcreteVehicle','isLegoBlockMaterial','isConcreteEntryCandidate','updateConcreteTypeFields','unitForMaterial','tonnageBandMatches','rateForMaterial'].map(n=>fn(app,n)).join('\n'),front);
const back=vm.createContext({});
vm.runInContext(['cleanText','isLegoBlockMaterial','driverAddedQuantityAndUnit','driverAddedConcreteAutoPrice'].map(n=>fn(worker,n)).join('\n'),back);
(async()=>{
 for(const [name,large,small] of items){
  for(const q of [0.5,10,10.1,20])assert.equal(front.rateForMaterial(name,q),q>10?large:small);
  for(const wagon of ['LL21HJJ','PN25FLF','BT66ZJO']){
   inputs['f-material'].value=name;inputs['f-vehicle'].value=wagon;inputs['f-unit'].value='m3';
   front.updateConcreteTypeFields();assert.equal(inputs['f-unit'].value,'t');assert.equal(inputs['concrete-type-fields'].classList.hidden,true);
   const body={material:name,vehicle:wagon,unit:'m3',quantity:10,notes:'C35 8m3 concrete',customer:'PM Groundworks'};
   assert.equal(back.driverAddedQuantityAndUnit(body).unit,'t');assert.equal((await back.driverAddedConcreteAutoPrice(body,10)).useQuotedPrice,false);
   assert.equal(back.driverAddedQuantityAndUnit({...body,quantity:0}).quantity,0);
  }
 }
 assert.equal(front.isConcreteEntryCandidate({vehicle:'LL21HJJ',material:'Concrete',unit:'m3'}),true);
 assert.equal(front.rateForMaterial('40mm Recycled MOT',10),20);
 console.log('PASS: seven Holcim prices, exact 10t boundary, 6mm exception, dry aggregate units and no wet-concrete auto-pricing.');
})().catch(e=>{console.error(e);process.exitCode=1;});
