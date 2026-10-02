const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'worker/index.js'), 'utf8');
function fn(source, name) {
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert(start >= 0, name);
  const tail = source.slice(start);
  const end = tail.slice(1).search(/\n(?:async )?function |\nexport default/);
  return end < 0 ? tail : tail.slice(0, end + 1);
}
const names = ['Lego block - Full', 'Lego block - Two-thirds', 'Lego block - One-third'];
const pricing = app.match(/const MATERIAL_PRICING = \{[\s\S]*?\n\};/)[0];
const inputs = {
  'f-vehicle': {value:'LL21HJJ'}, 'f-material': {value:''}, 'f-unit': {value:'m3'},
  'f-notes': {value:'concrete blocks'}, 'f-concrete-type': {value:'quarried'},
  'concrete-type-fields': {classList:{toggle(_name, hide){this.hidden=hide;}}}
};
const frontend = vm.createContext({$: id=>inputs[id]});
vm.runInContext(app.match(/\/\/ BEGIN GENERATED PMG_YARD_PRICES:COLLECTED_CONCRETE[\s\S]*?\/\/ END GENERATED PMG_YARD_PRICES:COLLECTED_CONCRETE/)[0]+"\n"+pricing + "\nconst VOLUMETRIC_CONCRETE_VEHICLES = new Set(['LL21HJJ','PN25FLF']);\n" +
 ['isLegoBlockMaterial','normaliseVehicleReg','isVolumetricConcreteVehicle','isConcreteEntryCandidate','updateConcreteTypeFields','unitForMaterial','tonnageBandMatches','rateForMaterial'].map(n=>fn(app,n)).join('\n'), frontend);
const backend = vm.createContext({});
vm.runInContext(worker.match(/\/\/ BEGIN GENERATED PMG_YARD_PRICES:COLLECTED_CONCRETE[\s\S]*?\/\/ END GENERATED PMG_YARD_PRICES:COLLECTED_CONCRETE/)[0]+'\n'+['cleanText','isLegoBlockMaterial','concreteQuantityFromText','driverAddedQuantityAndUnit','driverAddedConcreteAutoPrice'].map(n=>fn(worker,n)).join('\n'), backend);
(async()=>{
 for (const [i,name] of names.entries()) {
  for (const vehicle of ['EY15BOV','LL21HJJ','PN25FLF']) {
   inputs['f-material'].value=name; inputs['f-vehicle'].value=vehicle; inputs['f-unit'].value='m3';
   frontend.updateConcreteTypeFields();
   assert.equal(inputs['f-unit'].value,'each');
   assert.equal(inputs['f-concrete-type'].value,'');
   assert.equal(inputs['concrete-type-fields'].classList.hidden,true);
   assert.equal(frontend.isConcreteEntryCandidate({vehicle,material:name,unit:'m3',notes:'concrete C35 8m3'}),false);
   for (const qty of [1,2,10,11,16]) {
    assert.equal(frontend.rateForMaterial(name,qty),[120,100,80][i]);
    assert.equal(frontend.unitForMaterial(name),'each');
    for (const unit of ['each','t','m3']) {
     const body={material:name,quantity:qty,unit,vehicle,notes:'C35 concrete 8m3',customer:'PM Groundworks'};
     const value=backend.driverAddedQuantityAndUnit(body);
     assert.equal(value.quantity,qty);assert.equal(value.unit,'each');
     const price=await backend.driverAddedConcreteAutoPrice(body,qty);
     assert.equal(price.useQuotedPrice,false);assert.equal(price.quotedPrice,0);
    }
   }
  }
  const missing=backend.driverAddedQuantityAndUnit({material:name,quantity:0,unit:'each',notes:'8m3 concrete'});
  assert.equal(missing.quantity,0);assert.equal(missing.unit,'each');
 }
 assert.equal(frontend.isConcreteEntryCandidate({vehicle:'LL21HJJ',material:'Concrete',unit:'m3'}),true);
 assert.equal(frontend.rateForMaterial('40mm Recycled MOT',10),20);
 assert.equal(frontend.rateForMaterial('40mm Recycled MOT',11),18);
 console.log('PASS: Lego each counts, retained units on all wagon types, no concrete auto-pricing/inference, unchanged wet concrete and tonne thresholds');
})().catch(e=>{console.error(e);process.exitCode=1;});
