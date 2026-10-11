const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
const source = name => {
  const match = html.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert(match, `Missing ${name}`);
  return match[0];
};
assert.match(html, /id="rs-lastsalary"[^>]*oninput="markSettlementManual\(this\)"/);

const elements = new Map();
const field = (id, value = '') => {
  const element = {value, textContent:'', innerHTML:'', style:{}, dataset:{}, classList:{remove(){},add(){}}};
  elements.set(id, element);
  return element;
};
for(const id of ['resign-modal','resign-modal-title','rs-save-btn','rs-name','rs-hire','rs-resign',
  'rs-salary','rs-tenure','rs-avgwage','rs-severance','rs-leavepay','rs-lastsalary',
  'rs-insurance','rs-note','rs-detail','rs-total']) field(id);
const employee = {id:'e1',name:'직원',hireDate:'2026-10-07',monthlySalary:2700000};
const context = {
  document:{getElementById:id=>elements.get(id)||null},
  employees:[employee],_resignTargetId:null,DEFAULT_MONTHLY_SALARY:2700000,
  localDateString:()=> '2026-10-12',calcTotalLeave:()=>0,usedLeave:()=>0
};
vm.createContext(context);
for(const name of ['calcTenure','calcLastMonthSalary','openResignModal','recalcSettlement',
  'updateSettlementTotal','markSettlementManual']) vm.runInContext(source(name),context);

assert.equal(context.calcLastMonthSalary('2026-10-07','2026-10-08',2700000).amount,174194);
assert.equal(context.calcLastMonthSalary('2026-09-07','2026-10-08',2700000).amount,696774);
assert.equal(context.calcLastMonthSalary('2026-02-01','2028-02-29',2700000).amount,2700000);
assert.equal(context.calcLastMonthSalary('2026-10-09','2026-10-08',2700000).amount,0);

context.openResignModal('e1');
assert.equal(elements.get('rs-lastsalary').value,522581, 'Opening on Oct 12 includes only Oct 7-12');
elements.get('rs-resign').value = '2026-10-08';
context.recalcSettlement();
assert.equal(elements.get('rs-lastsalary').value,174194, 'Changing resignation date refreshes automatic amount');
assert.equal(elements.get('rs-total').textContent,'174,194 원');
assert.match(elements.get('rs-detail').innerHTML,/7~8일, 2일\/31일/);

elements.get('rs-lastsalary').value = '200000';
context.markSettlementManual(elements.get('rs-lastsalary'));
elements.get('rs-resign').value = '2026-10-09';
context.recalcSettlement();
assert.equal(elements.get('rs-lastsalary').value,'200000', 'Manual amount survives later date changes');
assert.match(elements.get('rs-detail').innerHTML,/적용 금액: <strong>200,000원<\/strong>/);

employee.resignDate = '2026-10-08';
employee.settlement = {lastSalary:180000,severance:0,leavePay:0,insurance:0};
context.openResignModal('e1');
assert.equal(elements.get('rs-lastsalary').value,180000, 'Reopening preserves a saved settlement');
assert.match(elements.get('rs-detail').innerHTML,/적용 금액: <strong>180,000원<\/strong>/);

console.log('PASS: mid-month hire proration, date refresh, manual override and saved settlement preservation');
