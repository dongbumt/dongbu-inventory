// Offline certificate date checks; uses fictional items and never contacts storage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const names = ['parseAppNumber','htmlEscape','jsArg','subMaterialCertificateDateParts',
  'subMaterialCertificateAddMonths','subMaterialCertificateStatus','updateSubMaterialCertificateForm',
  'subMaterialCertificateAlertSummary','renderSubMaterialItems','addSubMaterialItem','clearSubMaterialItemForm','editSubMaterialItem',
  'cancelSubMaterialItemEdit','addSubMaterialInbound','resetSubMaterialInbound'];
const source = names.map(name=>{
  const match = html.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, `missing function ${name}`);
  return match[0];
}).join('\n');
const elements = {};
function element(id){
  if(elements[id]) return elements[id];
  let value='';
  return elements[id]={get value(){return value;},set value(next){value=String(next ?? '');},
    style:{},disabled:false,validity:{badInput:false},focus(){},innerHTML:''};
}
const ctx = vm.createContext({console, document:{getElementById:element},
  localDateString:()=> '2026-09-14', today:'2026-09-14', confirm:()=>true,
  ensureSubMaterialCodes(){}, nextSubMaterialCode:()=> 'B002', subMaterialId:()=> 'fictional-new',
  dataChangeDateLabel:value=>value, queueAppDataChangeDetail(){}, saveSubMaterials(){},
  renderSubMaterials(){}, updateSubMaterialLotPreview(){}, makeSubMaterialLot:()=> 'B001-20260914-001',
  toast(message){ ctx.lastToast=message; },
  subMaterialItems:[],subMaterialLots:[],subMaterialCounts:[]});
vm.runInContext(source,ctx);

for(const invalid of ['', '2026-2-01','2026-02-29','2026-04-31','2026-13-01','0000-01-01','2026-03-00','file-2026-01-01.pdf']){
  assert.equal(ctx.subMaterialCertificateDateParts(invalid),null,invalid);
}
assert.ok(ctx.subMaterialCertificateDateParts('2024-02-29'));
assert.ok(ctx.subMaterialCertificateDateParts('0001-01-01'));
assert.equal(ctx.subMaterialCertificateAddMonths('2025-08-31',6),'2026-02-28');
assert.equal(ctx.subMaterialCertificateAddMonths('2023-08-31',6),'2024-02-29');
assert.equal(ctx.subMaterialCertificateAddMonths('2024-02-29',6),'2024-08-29');
assert.equal(ctx.subMaterialCertificateAddMonths('2026-03-31',6),'2026-09-30');
assert.equal(ctx.subMaterialCertificateAddMonths('2026-01-31',-1),'2025-12-31');
assert.equal(ctx.subMaterialCertificateAddMonths('2026-02-29',6),'');

const monthEnd = {certRequired:true,certDate:'2025-08-31'};
assert.equal(ctx.subMaterialCertificateStatus(monthEnd,'2026-01-27').status,'normal');
const firstAlert = ctx.subMaterialCertificateStatus(monthEnd,'2026-01-28');
assert.equal(firstAlert.dueDate,'2026-02-28');
assert.equal(firstAlert.warningDate,'2026-01-28','subtract one calendar month from the clamped due date');
assert.equal(firstAlert.status,'due_soon');
assert.equal(firstAlert.needsAttention,true);
assert.equal(ctx.subMaterialCertificateStatus(monthEnd,'2026-02-28').status,'due_today');
assert.equal(ctx.subMaterialCertificateStatus(monthEnd,'2026-03-01').status,'overdue');
assert.equal(ctx.subMaterialCertificateStatus({certRequired:true}).label,'날짜 등록 필요');
assert.equal(ctx.subMaterialCertificateStatus({certRequired:true,certDate:'2026-02-29'}).needsAttention,true);
assert.equal(ctx.subMaterialCertificateStatus({certName:'old-2025-01-01.pdf'}).status,'off');
assert.equal(ctx.subMaterialCertificateStatus({certRequired:false,certDate:'2020-01-01'}).needsAttention,false);
assert.equal(ctx.subMaterialCertificateStatus({certRequired:'true',certDate:'2020-01-01'}).status,'off');

ctx.subMaterialItems.push({id:'old',code:'B001',name:'시험 포장지',spec:'200×300',unit:'매',unitPrice:10,note:'기존 메모',certRequired:true,certDate:'2026-03-31'});
ctx.subMaterialLots.push({id:'lot-old',itemId:'old',qty:100,certName:'원본 성적서명.pdf'});
ctx.editSubMaterialItem('old');
assert.equal(element('sm-item-cert-required').value,'true');
assert.equal(element('sm-item-cert-date').value,'2026-03-31');
assert.equal(element('sm-item-cert-date').disabled,false);
assert.equal(element('sm-item-cert-date').max,'2026-09-14');
element('sm-item-cert-date').value='2026-09-15';
ctx.addSubMaterialItem();
assert.equal(ctx.subMaterialItems[0].certDate,'2026-03-31','a future certificate date is rejected before changing storage');
assert.match(ctx.lastToast,/오늘 이후/);
element('sm-item-cert-date').value='2026-09-14';
ctx.addSubMaterialItem();
assert.equal(ctx.subMaterialItems[0].certDate,'2026-09-14','only the latest selected date is stored');
assert.equal(ctx.subMaterialItems[0].certRequired,true);
assert.equal(ctx.subMaterialLots[0].certName,'원본 성적서명.pdf','legacy lot certificates survive item edits');
ctx.editSubMaterialItem('old');
element('sm-item-cert-required').value='false';
ctx.updateSubMaterialCertificateForm();
assert.equal(element('sm-item-cert-date').disabled,true);
assert.equal(element('sm-item-cert-date').value,'2026-09-14');
ctx.addSubMaterialItem();
assert.equal(ctx.subMaterialItems[0].certRequired,false);
assert.equal(ctx.subMaterialItems[0].certDate,'2026-09-14','turning monitoring off preserves the last date');
assert.equal(element('sm-item-cert-required').value,'false');
assert.equal(element('sm-item-cert-date').value,'');

element('sm-item-name').value='새 시험 품목';
ctx.addSubMaterialItem();
assert.equal(ctx.subMaterialItems[1].certRequired,false);
assert.equal(ctx.subMaterialItems[1].certDate,'');
element('sm-in-date').value='2026-09-14';
element('sm-in-item').value='old';
element('sm-in-qty').value='20';
ctx.addSubMaterialInbound();
assert.equal(Object.hasOwn(ctx.subMaterialLots[1],'certName'),false,'new receipts no longer save file names');
assert.equal(ctx.subMaterialLots[0].certName,'원본 성적서명.pdf');

ctx.subMaterialItems=[{id:'red',code:'B003',name:'<시험>',certRequired:true,certDate:'2026-04-14'},
  {id:'missing',code:'B004',name:'날짜 없음',certRequired:true},
  {id:'off',code:'B005',name:'일반 품목'}];
ctx.renderSubMaterialItems();
const rendered=element('sm-item-body').innerHTML;
assert.ok(rendered.includes('2026-10-14'));
assert.ok(rendered.includes('color:#c0392b'));
assert.ok(rendered.includes('날짜 등록 필요'));
assert.ok(rendered.includes('&lt;시험&gt;'));
assert.equal(rendered.includes('<시험>'),false);
assert.equal(element('sm-cert-summary').hidden,false);
assert.match(element('sm-cert-summary').textContent,/성적서 확인 필요 2개/);
assert.ok(element('sm-cert-summary').textContent.includes('날짜 등록 필요'));
const sevenAlerts=Array.from({length:7},(_,i)=>({name:`시험${i+1}`,certRequired:true,
  certDate:i<2?'':i<4?'2025-01-01':'2026-04-14'}));
const summary=ctx.subMaterialCertificateAlertSummary(sevenAlerts,'2026-09-14');
assert.match(summary,/성적서 확인 필요 7개/);
assert.ok(summary.includes('날짜 등록 필요'));
assert.ok(summary.includes('기한 경과'));
assert.ok(summary.includes('갱신 예정'));
assert.ok(summary.includes('시험5'));
assert.equal(summary.includes('시험6'),false);
assert.match(summary,/외 2개$/);
assert.equal(ctx.subMaterialCertificateAlertSummary([{certRequired:false},{certRequired:true,certDate:'2026-09-14'}]),'');
ctx.subMaterialItems=[];
ctx.renderSubMaterialItems();
assert.ok(element('sm-item-body').innerHTML.includes('colspan="11"'));
assert.equal(element('sm-cert-summary').textContent,'');
assert.equal(element('sm-cert-summary').hidden,true);
assert.equal(html.includes('id="sm-cert-file"'),false);
assert.equal(html.includes('id="sm-cert-name"'),false);
console.log('PASS: certificate calendar boundaries, warning summary, future-date rejection, latest-date editing, opt-out defaults, legacy preservation and item rendering');
