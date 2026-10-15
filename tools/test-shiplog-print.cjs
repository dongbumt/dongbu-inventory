const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const {chromium}=require('playwright');
const {PDFDocument}=require('pdf-lib');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const moduleSource=fs.readFileSync(path.join(root,'shiplog-print.js'),'utf8');
const start=html.indexOf('function getShipLogSelectedTrader()'),printStart=html.indexOf('function exportShipLogExcel()');
const source=html.slice(start,html.indexOf('// ─── 단가표',start))+html.slice(printStart,html.indexOf('// ━━━━━━━━━',printStart));
const escapeSource=`function htmlEscape(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}`;
const makeRows=(count,date='2026-10-15',long=false)=>Array.from({length:count},(_,i)=>({id:date+'-'+i,type:'출고',date,
  trader:['한식뷔페','가나유통','동원홈푸드'][i%3]+(long?' 긴 거래처명 확인'.repeat(8):''),
  product:`QA품목${String(i+1).padStart(3,'0')}`+(long?' 긴 세절규격 확인'.repeat(10):''),
  origin:'국내산',proddate:'2026-10-14',lot:`L${date.replace(/-/g,'').slice(2)}${String(i+1).padStart(6,'0')}`,weight:i+0.75}));

(async()=>{
  for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))if(match[1].trim())new vm.Script(match[1]);
  new vm.Script(moduleSource);
  const controls={'ship-date':{value:'2026-10-15'},'ship-trader':{value:''},'ship-from':{value:'2026-10-15'},'ship-to':{value:'2026-10-16'},'shiplog-preview':{innerHTML:''}};
  const calls=[],context=vm.createContext({transactions:makeRows(80).concat(makeRows(21,'2026-10-16')),document:{getElementById:id=>controls[id]},
    DBMTShipLogPrint:{open:input=>calls.push(input)},alert:message=>{throw Error(message)},localDateString:()=> '2026-10-15'});
  vm.runInContext(escapeSource+source,context);
  const before=JSON.stringify(context.transactions);
  context.exportShipLogExcel();assert.equal(calls.at(-1).groups[0].items.length,80);
  context.exportShipLogRange();assert.deepEqual(Array.from(calls.at(-1).groups,group=>group.items.length),[80,21]);
  controls['ship-trader'].value='가나유통';context.exportShipLogRange();
  assert.ok(calls.at(-1).groups.every(group=>group.items.every(row=>row.trader==='가나유통')));
  assert.equal(JSON.stringify(context.transactions),before,'Source transactions must remain unchanged');
  const blocked={window:{open:()=>null},alert:()=>{}};vm.runInNewContext(moduleSource,blocked);
  assert.equal(await blocked.window.DBMTShipLogPrint.open({}),false,'Blocked popup must be handled');

  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const artifactDir=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-shiplog-fit-'));
  try{
    const page=await browser.newPage({viewport:{width:1000,height:1200}}),errors=[];
    await page.context().addInitScript(()=>{window.print=()=>{window.printCalls=(window.printCalls||0)+1;};});
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto('about:blank');await page.setContent('<button id="print">인쇄</button>');
    await page.addScriptTag({content:escapeSource+source});
    await page.addScriptTag({content:moduleSource});
    const cases=[...['1','10','11','21','45','80'].map(count=>({name:count,groups:[{date:'2026-10-15',trader:'',items:makeRows(Number(count))}]})),
      {name:'long',groups:[{date:'2026-10-15',trader:'',items:makeRows(45,'2026-10-15',true)}]},
      {name:'range',groups:[{date:'2026-10-15',trader:'',items:makeRows(80)},{date:'2026-10-16',trader:'',items:makeRows(21,'2026-10-16')}]},
      {name:'escaped',groups:[{date:'2026-10-15',trader:'',items:makeRows(1).map(row=>({...row,product:'QA <img src=x onerror="window.INJECTED=true">',trader:'거래처 "<&>',lot:'LOT "<&>'}))}]}];
    let normalCapacity;
    for(const test of cases){
      await page.evaluate(groups=>{window.qaGroups=groups;document.getElementById('print').onclick=()=>DBMTShipLogPrint.open({title:'출고일지 QA',groups:qaGroups,renderPage:buildShipLogPageHTML});},test.groups);
      const ready=page.waitForEvent('popup');await page.locator('#print').click();const popup=await ready;
      popup.on('pageerror',error=>errors.push(error.message));
      await popup.waitForFunction(()=>document.documentElement.dataset.printReady==='true'||document.body.textContent.startsWith('출고일지 출력 준비 실패'));
      assert.equal(await popup.locator('html').getAttribute('data-print-ready'),'true',await popup.locator('body').innerText());
      await popup.setViewportSize({width:718,height:1123});
      await popup.emulateMedia({media:'print'});
      const layout=await popup.locator('.shiplog-page').evaluateAll(nodes=>nodes.map(node=>({height:node.getBoundingClientRect().height,
        fitsWidth:[...node.querySelectorAll('table,th,td')].every(cell=>cell.getBoundingClientRect().right<=node.getBoundingClientRect().right),
        rows:[...node.querySelector('table').tBodies[0].rows].filter(row=>row.cells[1].textContent).map(row=>({number:Number(row.cells[0].textContent),product:row.cells[1].textContent,lot:row.cells[5].textContent})),
        title:node.firstElementChild.innerText,approvals:(node.innerText.match(/승인/g)||[]).length,checks:(node.innerText.match(/▶ 점검사항/g)||[]).length})));
      assert.ok(layout.every(item=>item.height<=1040),test.name+': A4 height overflow');
      assert.ok(layout.every(item=>item.fitsWidth),test.name+': A4 column overflow');
      assert.equal(layout.reduce((sum,item)=>sum+item.approvals,0),test.groups.length,test.name+': approval repeated');
      assert.equal(layout.reduce((sum,item)=>sum+item.checks,0),test.groups.length,test.name+': checks repeated');
      const expected=test.groups.flatMap(group=>group.items);
      assert.deepEqual(layout.flatMap(item=>item.rows).map(row=>row.lot),expected.map(row=>row.lot),test.name+': rows lost or reordered');
      for(const group of test.groups){
        const groupPages=layout.filter(item=>item.rows[0].lot===group.items[0].lot||item.rows.some(row=>group.items.some(entry=>entry.lot===row.lot)));
        assert.deepEqual(groupPages.flatMap(item=>item.rows).map(row=>row.number),group.items.map((_,i)=>i+1),test.name+': continuous numbering');
        assert.ok(groupPages[0].rows.length<=10,test.name+': first page limit');
        assert.ok(groupPages.slice(1).every(item=>item.approvals===0&&item.checks===0),test.name+': continuation duplicates');
      }
      const pdf=await popup.pdf({preferCSSPageSize:true,printBackground:true,displayHeaderFooter:false,...(['80','long','range'].includes(test.name)?{path:path.join(artifactDir,test.name+'.pdf')}:{})});
      assert.equal((await PDFDocument.load(pdf)).getPageCount(),layout.length,test.name+': unexpected physical PDF page');
      assert.equal(await popup.evaluate(()=>window.printCalls),1,test.name+': print lifecycle');
      if(test.name==='21')assert.equal(layout.length,2,'21 products should use two pages');
      if(test.name==='80'){
        normalCapacity=layout[1].rows.length;assert.ok(normalCapacity>=30,'Continuation page should use its free space');
        await popup.locator('.shiplog-page').nth(1).screenshot({path:path.join(artifactDir,'continuation.png')});
      }
      if(test.name==='long')assert.ok(layout[1].rows.length<normalCapacity,'Long names must reduce page capacity');
      assert.equal(await popup.evaluate(()=>window.INJECTED),undefined,'Values must be plain text');
      console.log(`${test.name}: ${layout.length} A4 pages; rows ${layout.map(item=>item.rows.length).join('/')}`);
      await popup.close();
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: automatic A4 capacity, long rows, physical PDF pagination, continuous numbering, one shared section per date, single/range/trader integration, escaping and popup handling');
    console.log('Artifacts: '+artifactDir);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
