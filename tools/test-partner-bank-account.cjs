// Actual partner form and handlers, fictional server responses, no live writes.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(match[1]);
const source=name=>{const match=html.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));assert(match);return match[0];};
const start=html.indexOf('let traderInfoMap ='),end=html.indexOf('// ─── 서류체크',start);
const setup=`
var SUPABASE_ENABLED_KEY='qa_enabled',dataChangeLogs=[],notices=[],savedRecords=[],failSave=false;
var serverMap={'가상 기존 거래처':{id:'existing',revision:1,code:'QA-OLD',active:true,paymentTerms:'월말'}};
localStorage.setItem(SUPABASE_ENABLED_KEY,'1');localStorage.setItem('dbmt_trader_info',JSON.stringify(serverMap));
function updateTraderList(){} function saveDataChangeLogsLocal(){}
function toast(value){notices.push(value)} function personalServerWriteToken(){return 'fictional-token'}
function assertPersonalServerResult(result){if(!result.ok)throw Error(result.message)}
async function sbRpc(name,args){
 if(failSave)throw Error('가상 저장 실패');
 const row={...args.p_record,id:args.p_record.id||'new-partner',code:'QA-NEW',revision:(args.p_expected_revision||0)+1};
 savedRecords.push({...row});serverMap[row.name]=row;
 return {ok:true,partner:row,traderInfoMap:structuredClone(serverMap)};
}
${['htmlEscape','jsArg'].map(source).join('\n')}
${html.slice(start,end)}
renderTraders();
`;
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
 try{
  const page=await browser.newPage({viewport:{width:1400,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
  await page.goto('http://fixture.test');
  const panel=await page.evaluate(markup=>{const template=document.createElement('template');template.innerHTML=markup;const panel=template.content.querySelector('#p-traders');panel.classList.add('active');return panel.outerHTML;},html);
  await page.setContent(`<!doctype html><html lang="ko"><meta charset="utf-8"><style>${fs.readFileSync(path.join(root,'styles/main.css'),'utf8')}body{padding:12px}</style><body>${panel}<script>${setup}</script></body></html>`);
  const account=page.locator('#tr-bank-account'),name=page.locator('#tr-name');
  assert.equal(await account.getAttribute('maxlength'),'300');
  await page.evaluate(()=>editTrader('가상 기존 거래처'));assert.equal(await account.inputValue(),'');
  await page.locator('#tr-cancel-btn').click();
  const value='가상은행 / 001-002-000003 / <가상 & 예금주>';
  await name.fill('가상 계좌 거래처');await account.fill('  '+value+'  ');await page.locator('#tr-save-btn').click();
  assert.equal(await page.evaluate(()=>savedRecords.at(-1).bankAccount),value);
  assert.equal(await account.inputValue(),'');
  assert((await page.locator('#traders-tbody').innerText()).includes(value));
  assert.equal(await page.locator('#traders-tbody').locator('script,img').count(),0);
  await page.evaluate(()=>editTrader('가상 계좌 거래처'));assert.equal(await account.inputValue(),value);
  await page.evaluate(()=>failSave=true);await account.fill('가상은행 / 000-009 / 수정 중');await page.locator('#tr-save-btn').click();
  assert.equal(await account.inputValue(),'가상은행 / 000-009 / 수정 중');
  assert.equal(await page.evaluate(()=>notices.at(-1)),'가상 저장 실패');
  await page.evaluate(()=>failSave=false);await account.fill('');await page.locator('#tr-save-btn').click();
  assert.equal(await page.evaluate(()=>serverMap['가상 계좌 거래처'].bankAccount),'');
  await page.evaluate(()=>editTrader('가상 계좌 거래처'));assert.equal(await account.inputValue(),'');
  await account.fill(value);await page.locator('#tr-save-btn').click();
  await page.evaluate(()=>{traderInfoMap=structuredClone(serverMap);renderTraders();editTrader('가상 계좌 거래처')});
  assert.equal(await account.inputValue(),value);
  const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-partner-bank-'));
  await page.screenshot({path:path.join(artifacts,'partner-bank-account.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS: legacy blank form, create/edit/clear/reload, leading zeros and punctuation, escaped list display, failed save retains input');
  console.log('Artifacts: '+artifacts);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
