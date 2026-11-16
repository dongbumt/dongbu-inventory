const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const output=process.env.SPEC_PRINT_QA_DIR||path.join(os.tmpdir(),'dbmt-product-spec-print');

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    fs.mkdirSync(output,{recursive:true});
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body><main class="main"></main></body></html>');
    await page.evaluate(markup=>{
      const template=document.createElement('template');template.innerHTML=markup;
      const panel=template.content.querySelector('#p-product-specs');panel.classList.add('active');
      document.querySelector('main').append(panel);
    },fs.readFileSync(path.join(root,'index.html'),'utf8'));
    for(const file of ['styles/main.css','styles/product-specs.css'])await page.addStyleTag({content:fs.readFileSync(path.join(root,file),'utf8')});
    await page.addScriptTag({content:`
      var qaToken='print-session',qaRights={view:true,create:false,update:false,delete:false};
      var qaRows=[],qaCalls=[],qaPending=false,qaRelease,qaPopupBlocked=false,qaOpenCount=0;
      var DBMTAuth={isPersonal:()=>!!qaToken,can:(_,action)=>qaRights[action],getSessionToken:()=>qaToken};
      async function sbRpc(name,params){
        qaCalls.push({name,params});
        if(name!=='dbmt_erp_get_product_specs')throw Error('Unexpected write');
        if(qaPending)await new Promise(resolve=>{qaRelease=resolve;});
        return {ok:true,specs:structuredClone(qaRows)};
      }
      const realOpen=window.open.bind(window);
      window.open=(...args)=>{
        qaOpenCount++;
        if(qaPopupBlocked)return null;
        const popup=realOpen(...args);
        if(popup)popup.print=()=>{popup.document.documentElement.dataset.qaPrinted='true';};
        return popup;
      };
    `});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'product-specs.js'),'utf8')});
    const base={distribution:'삼성웰스토리',origin:'미국산',cutting_spec:'15×30×40mm 슬라이스',inner_packaging_spec:'1KG 진공포장',outer_packaging_spec:'1KG×10PAC/BOX',price_kg:6700,price_box:67000,note:'납품 요청사항'};
    const rows=[
      {...base,id:'a',trader:'검색업체2',material:'목전지',price_kg:0,inner_packaging_spec:null,packaging_spec:'기존 포장스펙'},
      {...base,id:'b',trader:'검색업체10',material:'목전지',price_kg:null,price_box:null},
      {...base,id:'c',trader:'검색업체1',material:'목전지',price_kg:12000,note:'<img src=x onerror=alert(1)> & "비고"'},
      {...base,id:'hidden',trader:'출력제외업체',material:'부채살',distribution:'동원홈푸드',origin:'국내산'}
    ];
    await page.evaluate(data=>{qaRows=data;return DBMTProductSpecs.init();},rows);
    assert.equal(await page.locator('#spec-editor').isVisible(),false);
    assert.equal(await page.locator('#spec-print').isEnabled(),true,'View-only users can print');
    await page.locator('#spec-search').fill('삼성 목전지 미국');
    await page.locator('[data-sort="price_kg"]').click();
    await page.locator('[data-sort="price_kg"]').click();
    const openPrint=async()=>{
      const waiting=page.waitForEvent('popup');
      await page.locator('#spec-print').click();
      const popup=await waiting;
      await popup.waitForFunction(()=>document.documentElement.dataset.qaPrinted==='true');
      assert.equal(await popup.evaluate(()=>window.opener),null);
      return popup;
    };
    let popup=await openPrint();
    assert.equal(await popup.locator('tbody tr').count(),3);
    assert.deepEqual(await popup.locator('tbody tr td:first-child').allTextContents(),['검색업체1','검색업체2','검색업체10']);
    assert.match(await popup.locator('header').textContent(),/삼성 목전지 미국 · 3건/);
    assert.match(await popup.locator('header').textContent(),/정렬: 화면 목록 순서/);
    assert.deepEqual(await popup.locator('thead th').allTextContents(),['거래처','유통','원재료','원산지','세절스펙','내포장 스펙','외포장 스펙','비고']);
    assert.equal(await popup.locator('tbody tr').evaluateAll(rows=>rows.every(row=>row.cells.length===8)),true);
    assert.doesNotMatch(await popup.locator('body').textContent(),/단가|12,000|67,000/,'Neither price column nor price-unit guide is printed');
    assert.equal(await page.locator('#spec-rows tr[data-id="a"] td').nth(7).textContent(),'0','Screen prices remain available');
    assert.equal(await page.locator('#spec-rows tr[data-id="b"] td').nth(7).textContent(),'—');
    assert.match(await popup.locator('tbody').textContent(),/기존 포장스펙/);
    assert.equal(await popup.locator('img,script,button,input,select').count(),0,'No injected HTML, editor or management buttons');
    assert.ok(!(await popup.locator('body').textContent()).includes('출력제외업체'));
    await popup.close();
    assert.equal(await page.locator('#spec-search').inputValue(),'삼성 목전지 미국');
    assert.equal(await page.evaluate(()=>qaCalls.length),1,'Printing uses the displayed snapshot without another RPC');

    await page.locator('#spec-search').fill('없는 검색결과');
    assert.equal(await page.locator('#spec-print').isDisabled(),true);
    await page.evaluate(()=>DBMTProductSpecs.print());
    assert.equal(await page.evaluate(()=>qaOpenCount),1);
    await page.locator('#spec-search').fill('');
    await page.evaluate(()=>{qaPopupBlocked=true;DBMTProductSpecs.print();});
    assert.match(await page.locator('#spec-message').textContent(),/팝업 차단/);
    await page.evaluate(()=>{qaPopupBlocked=false;qaPending=true;void DBMTProductSpecs.load();});
    assert.equal(await page.locator('#spec-print').isDisabled(),true);
    await page.evaluate(()=>DBMTProductSpecs.print());
    assert.equal(await page.evaluate(()=>qaOpenCount),2,'Pending refresh cannot print a stale snapshot');
    await page.evaluate(()=>{qaPending=false;qaRelease();});
    await page.waitForFunction(()=>!document.querySelector('#spec-print').disabled);
    await page.evaluate(()=>{qaToken='new-session';DBMTProductSpecs.print();});
    assert.equal(await page.locator('#spec-rows tr[data-id]').count(),0,'Session change clears previous results');
    assert.equal(await page.evaluate(()=>qaOpenCount),2);
    await page.evaluate(()=>{qaRights.view=false;DBMTProductSpecs.print();});
    assert.equal(await page.evaluate(()=>qaOpenCount),2);

    const selectionRows=[
      {...base,id:'s1',trader:'거래처A',distribution:'삼성웰스토리',material:'돈등심',origin:'국내산'},
      {...base,id:'s2',trader:'거래처A',distribution:'동원홈푸드',material:'우삼겹',origin:'미국산'},
      {...base,id:'s3',trader:'거래처B',distribution:'삼성웰스토리',material:'목전지',origin:'미국산'},
      {...base,id:'s4',trader:'거래처AB',distribution:'삼성웰스토리',material:'돈등심',origin:'국내산'},
      {...base,id:'s5',trader:'거래처B',distribution:'<자유 & 유통>',material:'부채살',origin:'호주산'},
      {...base,id:'s6',trader:'거래처A',distribution:null,material:'앞다리',origin:'국내산'}
    ];
    await page.evaluate(data=>{qaRights.view=true;qaRows=data;return DBMTProductSpecs.load();},selectionRows);
    const trader=page.locator('#spec-filter-trader'),distribution=page.locator('#spec-filter-distribution');
    const ids=()=>page.locator('#spec-rows tr[data-id]').evaluateAll(rows=>rows.map(row=>row.dataset.id).sort());
    assert.deepEqual(await trader.locator('option').allTextContents(),['전체 거래처','거래처A','거래처AB','거래처B']);
    assert.ok((await distribution.locator('option').allTextContents()).includes('<자유 & 유통>'),'Custom distributors are selectable');
    await trader.selectOption('거래처A');
    assert.deepEqual(await ids(),['s1','s2','s6'],'Customer selection is exact and includes its unspecified distributors');
    popup=await openPrint();
    assert.deepEqual(await popup.locator('tbody tr td:first-child').allTextContents(),['거래처A','거래처A','거래처A']);
    assert.match(await popup.locator('header').textContent(),/거래처: 거래처A · 유통사: 전체/);await popup.close();
    await trader.selectOption('');await distribution.selectOption('삼성웰스토리');
    assert.deepEqual(await ids(),['s1','s3','s4']);
    popup=await openPrint();
    assert.deepEqual(await popup.locator('tbody tr td:nth-child(2)').allTextContents(),['삼성웰스토리','삼성웰스토리','삼성웰스토리']);await popup.close();
    await trader.selectOption('거래처A');await page.locator('#spec-search').fill('돈등심');
    assert.deepEqual(await ids(),['s1'],'Both selections and keyword search combine');
    await page.screenshot({path:path.join(output,'selection.png'),fullPage:false});
    popup=await openPrint();
    assert.equal(await popup.locator('tbody tr').count(),1);
    assert.match(await popup.locator('header').textContent(),/거래처: 거래처A · 유통사: 삼성웰스토리/);
    assert.doesNotMatch(await popup.locator('body').textContent(),/거래처AB|거래처B|동원홈푸드/);
    await popup.pdf({path:path.join(output,'filtered.pdf'),preferCSSPageSize:true,printBackground:true});await popup.close();
    await page.locator('#spec-search').fill('미국산');assert.equal(await page.locator('#spec-print').isDisabled(),true);
    await page.getByRole('button',{name:'검색 초기화',exact:true}).click();
    assert.equal(await trader.inputValue(),'');assert.equal(await distribution.inputValue(),'');assert.equal(await page.locator('#spec-search').inputValue(),'');
    assert.equal((await ids()).length,6);
    await distribution.selectOption('<자유 & 유통>');assert.deepEqual(await ids(),['s5']);
    popup=await openPrint();
    assert.match(await popup.locator('header').textContent(),/<자유 & 유통>/);assert.equal(await popup.locator('img,script').count(),0);await popup.close();
    await distribution.selectOption('');await trader.selectOption('거래처A');
    await page.evaluate(()=>{qaRows=qaRows.filter(row=>row.trader!=='거래처A');return DBMTProductSpecs.load();});
    assert.equal(await trader.inputValue(),'거래처A','Refresh preserves a selected customer even if its final record disappears');
    assert.deepEqual(await ids(),[]);assert.equal(await page.locator('#spec-print').isDisabled(),true,'Missing selections cannot broaden printing');
    await page.getByRole('button',{name:'검색 초기화',exact:true}).click();assert.equal((await ids()).length,3);
    await distribution.selectOption('삼성웰스토리');
    await page.evaluate(()=>{qaToken='third-session';DBMTProductSpecs.applyPermissions();});
    assert.equal(await trader.locator('option').count(),1);assert.equal(await distribution.locator('option').count(),1,'Session changes clear previous customer/distributor choices');

    const many=Array.from({length:70},(_,i)=>({...base,id:'multi-'+i,trader:'업체'+String(i+1).padStart(3,'0'),material:'상품'+String(i+1).padStart(3,'0'),note:i===35?'긴 문구 '.repeat(250)+'긴문구끝표시':'확인사항'+String(i+1).padStart(3,'0')}));
    await page.evaluate(data=>{qaRights.view=true;qaRows=data;return DBMTProductSpecs.load();},many);
    await page.locator('[data-sort="trader"]').click();
    popup=await openPrint();
    assert.equal(await popup.locator('tbody tr').count(),70);
    assert.equal(await popup.locator('tbody tr').last().locator('td').first().textContent(),'업체070');
    await popup.emulateMedia({media:'print'});
    assert.equal(await popup.locator('table').evaluate(table=>table.scrollWidth<=table.clientWidth+1),true);
    assert.equal(await popup.locator('td').evaluateAll(cells=>cells.every(cell=>cell.scrollWidth<=cell.clientWidth+1)),true,'All columns wrap without clipping');
    await popup.pdf({path:path.join(output,'multipage.pdf'),preferCSSPageSize:true,printBackground:true});
    await popup.close();
    for(const width of [1440,1366,1280]){
      await page.setViewportSize({width,height:900});
      const box=await page.locator('#spec-print').boundingBox();assert.ok(box.x+box.width<=width);
    }
    await page.screenshot({path:path.join(output,'list.png'),fullPage:false});
    assert.deepEqual(errors,[]);
    console.log('PASS: exact customer/distributor selection, combined search, custom distributors, reset/refresh/session safeguards; price-free sorted A4 print, screen prices, wrapping, permissions and popup failure. QA: '+output);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
