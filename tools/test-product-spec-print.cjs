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
      {...base,id:'a',trader:'검색업체2',material:'목전지',brand:'브랜드A',price_kg:0,inner_packaging_spec:null,packaging_spec:'기존 포장스펙'},
      {...base,id:'b',trader:'검색업체10',material:'목전지',price_kg:null,price_box:null},
      {...base,id:'c',trader:'검색업체1',material:'목전지',brand:'<브랜드 & "명칭">',price_kg:12000,note:'<img src=x onerror=alert(1)> & "비고"'},
      {...base,id:'hidden',trader:'출력제외업체',material:'부채살',distribution:'동원홈푸드',origin:'국내산'}
    ];
    await page.evaluate(data=>{qaRows=data;return DBMTProductSpecs.init();},rows);
    assert.equal(await page.locator('#spec-editor').isVisible(),false);
    assert.equal(await page.locator('#spec-print').isEnabled(),true,'View-only users can print');
    assert.equal(await page.locator('#spec-usage-print').isDisabled(),true,'Specs with no monthly usage can print details but cannot print a usage report');
    await page.locator('#spec-search').fill('삼성 목전지 미국');
    await page.locator('[data-sort="price_kg"]').click();
    await page.locator('[data-sort="price_kg"]').click();
    const openPrint=async(selector='#spec-print')=>{
      const waiting=page.waitForEvent('popup');
      await page.locator(selector).click();
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
    assert.deepEqual(await popup.locator('thead th').allTextContents(),['거래처','원재료','브랜드','원산지','세절스펙','내포장 스펙','외포장 스펙','월사용량(KG)']);
    assert.equal(await popup.locator('tbody tr').evaluateAll(rows=>rows.every(row=>row.cells.length===8)),true);
    assert.deepEqual(await popup.locator('tbody tr td:nth-child(3)').allTextContents(),['<브랜드 & "명칭">','브랜드A',''],'Brand prints after material and missing legacy values stay blank');
    assert.doesNotMatch(await popup.locator('body').textContent(),/납품 요청사항|<img src=x onerror=alert\(1\)>/,'Notes never appear in the print document');
    assert.equal(await page.locator('.spec-table th').filter({hasText:'유통'}).count(),1,'Distributor remains on screen');
    assert.equal(await page.locator('.spec-table th').filter({hasText:'비고'}).count(),1,'Notes remain on screen');
    assert.doesNotMatch(await popup.locator('body').textContent(),/단가|12,000|67,000/,'Neither price column nor price-unit guide is printed');
    assert.equal(await page.locator('#spec-rows tr[data-id="a"] td').nth(9).textContent(),'0','Screen prices remain available');
    assert.equal(await page.locator('#spec-rows tr[data-id="b"] td').nth(9).textContent(),'—');
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
      {...base,id:'s1',trader:'거래처A',distribution:'삼성웰스토리',material:'돈등심',brand:'브랜드A',origin:'국내산',monthly_usage:100.1},
      {...base,id:'s2',trader:'거래처A',distribution:'동원홈푸드',material:'우삼겹',brand:'브랜드B',origin:'미국산',monthly_usage:50.000001},
      {...base,id:'s3',trader:'거래처B',distribution:'삼성웰스토리',material:'돈등심',origin:'미국산'},
      {...base,id:'s4',trader:'거래처AB',distribution:'삼성웰스토리',material:'돈등심',brand:'브랜드A',origin:'국내산',monthly_usage:200.2},
      {...base,id:'s5',trader:'거래처B',distribution:'<자유 & 유통>',material:'부채살',origin:'호주산',monthly_usage:0},
      {...base,id:'s6',trader:'거래처A',distribution:null,material:'앞다리',origin:'국내산'}
    ];
    await page.evaluate(data=>{qaRights.view=true;qaRows=data;return DBMTProductSpecs.load();},selectionRows);
    const distribution=page.locator('#spec-filter-distribution'),all=page.locator('#spec-traders-all');
    const trader=name=>page.locator('#spec-filter-traders').getByRole('checkbox',{name,exact:true});
    const selectOnly=async name=>{await all.check();await all.uncheck();await trader(name).check();};
    const ids=()=>page.locator('#spec-rows tr[data-id]').evaluateAll(rows=>rows.map(row=>row.dataset.id).sort());
    await page.locator('#spec-usage-summary summary').click();
    assert.match(await page.locator('#spec-usage-total').textContent(),/350.300001 KG/);
    assert.match(await page.locator('#spec-usage-info').textContent(),/입력 4건 · 미입력 2건 제외/);
    assert.equal(await page.locator('#spec-usage-rows tr').filter({hasText:'돈등심'}).filter({hasText:'국내산'}).locator('td').last().textContent(),'300.3','Same item/brand/origin groups sum exactly');
    assert.equal(await page.locator('#spec-usage-rows tr').filter({hasText:'돈등심'}).filter({hasText:'미국산'}).count(),0,'Groups with no entered usage are omitted');
    assert.equal(await page.locator('#spec-usage-rows tr').filter({hasText:'앞다리'}).count(),0);
    assert.deepEqual(await page.locator('#spec-usage-summary thead button').evaluateAll(buttons=>buttons.map(button=>button.dataset.label)),['품목(원재료)','브랜드','원산지','월사용량 합계(KG)']);
    assert.equal(await page.locator('#spec-usage-rows tr').filter({hasText:'부채살'}).locator('td').last().textContent(),'0','Explicit zero remains distinct from missing usage');
    assert.deepEqual(await page.locator('#spec-filter-traders input').evaluateAll(inputs=>inputs.map(input=>input.value)),['거래처A','거래처AB','거래처B']);
    assert.equal(await all.isChecked(),true);
    assert.ok((await distribution.locator('option').allTextContents()).includes('<자유 & 유통>'),'Custom distributors are selectable');
    await selectOnly('거래처A');
    assert.match(await page.locator('#spec-usage-total').textContent(),/150.100001 KG/);
    assert.deepEqual(await ids(),['s1','s2','s6'],'Customer selection is exact and includes its unspecified distributors');
    popup=await openPrint();
    assert.deepEqual(await popup.locator('tbody tr td:first-child').allTextContents(),['거래처A','거래처A','거래처A']);
    assert.match(await popup.locator('header').textContent(),/거래처: 거래처A · 유통사: 전체/);await popup.close();
    await distribution.selectOption('삼성웰스토리');
    assert.equal(await all.isChecked(),true,'Changing distributor starts with all of its customers selected');
    assert.deepEqual(await ids(),['s1','s3','s4']);
    popup=await openPrint();
    assert.deepEqual(await popup.locator('tbody tr td:first-child').allTextContents(),['거래처A','거래처AB','거래처B']);
    assert.match(await popup.locator('header').textContent(),/유통사: 삼성웰스토리/);await popup.close();
    await trader('거래처B').uncheck();
    assert.deepEqual(await ids(),['s1','s4'],'Exclude a customer without affecting similarly named customers');
    assert.equal(await all.evaluate(input=>input.indeterminate),true);
    popup=await openPrint();
    assert.deepEqual(await popup.locator('tbody tr td:first-child').allTextContents(),['거래처A','거래처AB']);await popup.close();
    popup=await openPrint('#spec-usage-print');
    assert.equal(await popup.locator('tbody tr').last().locator('td').textContent(),'300.3','Usage print obeys the same exclusions');await popup.close();
    await all.check();await all.uncheck();
    assert.deepEqual(await ids(),[]);
    assert.equal(await page.locator('#spec-print').isDisabled(),true);
    assert.equal(await page.locator('#spec-usage-print').isDisabled(),true,'Selecting none cannot print all');
    const openCount=await page.evaluate(()=>qaOpenCount);
    await page.evaluate(()=>DBMTProductSpecs.print());assert.equal(await page.evaluate(()=>qaOpenCount),openCount);
    await all.check();assert.deepEqual(await ids(),['s1','s3','s4']);
    await selectOnly('거래처A');await page.locator('#spec-search').fill('돈등심');
    assert.deepEqual(await ids(),['s1'],'Both selections and keyword search combine');
    await page.screenshot({path:path.join(output,'selection.png'),fullPage:false});
    popup=await openPrint();
    assert.equal(await popup.locator('tbody tr').count(),1);
    assert.match(await popup.locator('header').textContent(),/거래처: 거래처A · 유통사: 삼성웰스토리/);
    assert.doesNotMatch(await popup.locator('body').textContent(),/거래처AB|거래처B|동원홈푸드/);
    await popup.pdf({path:path.join(output,'filtered.pdf'),preferCSSPageSize:true,printBackground:true});await popup.close();
    await page.locator('#spec-search').fill('미국산');assert.equal(await page.locator('#spec-print').isDisabled(),true);
    await page.getByRole('button',{name:'검색 초기화',exact:true}).click();
    assert.equal(await all.isChecked(),true);assert.equal(await distribution.inputValue(),'');assert.equal(await page.locator('#spec-search').inputValue(),'');
    assert.equal((await ids()).length,6);
    popup=await openPrint('#spec-usage-print');
    assert.equal(await popup.locator('tbody tr').count(),4,'Only three entered groups and the total are printed');
    assert.deepEqual(await popup.locator('thead th').allTextContents(),['품목(원재료)','브랜드','원산지','월사용량 합계(KG)']);
    assert.equal(await popup.locator('tbody tr').filter({hasText:'돈등심'}).locator('td').nth(1).textContent(),'브랜드A');
    assert.doesNotMatch(await popup.locator('tbody').textContent(),/앞다리/);
    assert.equal(await popup.locator('tbody tr').filter({hasText:'돈등심'}).filter({hasText:'국내산'}).locator('td').last().textContent(),'300.3');
    assert.equal(await popup.locator('tbody tr').last().locator('td').textContent(),'350.300001');
    assert.match(await popup.locator('body').textContent(),/미입력 2건 제외/);
    await popup.pdf({path:path.join(output,'usage.pdf'),preferCSSPageSize:true,printBackground:true});await popup.close();
    await distribution.selectOption('<자유 & 유통>');assert.deepEqual(await ids(),['s5']);
    assert.equal(await page.locator('#spec-usage-print').isEnabled(),true,'An entered zero is printable');
    popup=await openPrint('#spec-usage-print');
    assert.equal(await popup.locator('tbody tr').count(),2);assert.equal(await popup.locator('tbody tr').last().locator('td').textContent(),'0');await popup.close();
    popup=await openPrint();
    assert.match(await popup.locator('header').textContent(),/<자유 & 유통>/);assert.equal(await popup.locator('img,script').count(),0);await popup.close();
    await distribution.selectOption('');await selectOnly('거래처A');
    await page.evaluate(()=>{qaRows=qaRows.filter(row=>row.trader!=='거래처A');return DBMTProductSpecs.load();});
    assert.equal(await trader('거래처A').isChecked(),true,'Refresh preserves a selected customer even if its final record disappears');
    assert.deepEqual(await ids(),[]);assert.equal(await page.locator('#spec-print').isDisabled(),true,'Missing selections cannot broaden printing');
    await page.getByRole('button',{name:'검색 초기화',exact:true}).click();assert.equal((await ids()).length,3);
    await distribution.selectOption('삼성웰스토리');
    await page.evaluate(()=>{qaToken='third-session';DBMTProductSpecs.applyPermissions();});
    assert.equal(await page.locator('#spec-filter-traders input').count(),0);assert.equal(await distribution.locator('option').count(),1,'Session changes clear previous customer/distributor choices');

    const summaryRows=[
      {...base,id:'u1',trader:'합계거래처',material:'품목10',brand:'브랜드2',origin:'원산지3',monthly_usage:100},
      {...base,id:'u2',trader:'합계거래처',material:'품목2',brand:'브랜드10',origin:'원산지2',monthly_usage:10},
      {...base,id:'u3',trader:'합계거래처',material:'품목1',brand:'브랜드1',origin:'원산지1',monthly_usage:2},
      {...base,id:'u4',trader:'합계거래처',material:' 품목１ ',brand:'브랜드１',origin:'원산지1',monthly_usage:0.25},
      {...base,id:'u5',trader:'합계거래처',material:'품목1',brand:'브랜드2',origin:'원산지1',monthly_usage:0},
      {...base,id:'u6',trader:'합계거래처',material:'미입력품목',brand:'제외브랜드',monthly_usage:null},
      {...base,id:'u7',trader:'합계거래처',material:'미입력품목',brand:'제외브랜드',monthly_usage:''},
      {...base,id:'u8',trader:'합계거래처',material:'미입력품목',brand:'제외브랜드'},
      {...base,id:'u9',trader:'합계거래처',material:'품목3',brand:'',origin:'',monthly_usage:1}
    ];
    await page.evaluate(data=>{qaRows=data;return DBMTProductSpecs.load();},summaryRows);
    assert.equal(await page.locator('#spec-usage-rows tr').count(),6,'Brands remain distinct and normalized duplicates combine');
    assert.match(await page.locator('#spec-usage-total').textContent(),/113.25 KG/);
    const summaryData=()=>page.locator('#spec-usage-rows tr').evaluateAll(rows=>rows.filter(row=>row.querySelectorAll('td').length===4).map(row=>Array.from(row.cells).map(cell=>cell.textContent.normalize('NFKC').trim())));
    const summarySorts=[
      ['material',0,['품목1','품목1','품목2','품목3','품목10'],['품목10','품목3','품목2','품목1','품목1']],
      ['brand',1,['브랜드1','브랜드2','브랜드2','브랜드10',''],['브랜드10','브랜드2','브랜드2','브랜드1','']],
      ['origin',2,['원산지1','원산지1','원산지2','원산지3','미입력'],['원산지3','원산지2','원산지1','원산지1','미입력']],
      ['qty',3,['0','1','2.25','10','100'],['100','10','2.25','1','0']]
    ];
    const detailsBefore=await ids(),summaryCalls=await page.evaluate(()=>qaCalls.length);
    for(const [key,column,ascending,descending] of summarySorts){
      const button=page.locator(`[data-usage-sort="${key}"]`),header=page.locator(`th:has([data-usage-sort="${key}"])`);
      await button.click();if(await header.getAttribute('aria-sort')!=='ascending')await button.click();
      assert.deepEqual((await summaryData()).map(row=>row[column]),ascending,key+' ascending');
      await button.press('Enter');assert.equal(await header.getAttribute('aria-sort'),'descending');
      assert.deepEqual((await summaryData()).map(row=>row[column]),descending,key+' descending');
      assert.equal(await page.locator('#spec-usage-summary th[aria-sort="descending"]').count(),1);
      assert.equal(await page.locator('#spec-usage-rows tr').last().locator('td').textContent(),'113.25','The grand total stays last');
    }
    assert.deepEqual(await ids(),detailsBefore,'Usage sorting does not reorder the detail list');
    assert.equal(await page.evaluate(()=>qaCalls.length),summaryCalls,'Usage sorting never reads or writes the database');
    const sortedSummary=await summaryData();
    await page.evaluate(()=>DBMTProductSpecs.load());assert.deepEqual(await summaryData(),sortedSummary,'Refresh preserves usage sorting');
    popup=await openPrint('#spec-usage-print');
    assert.deepEqual(await popup.locator('tbody tr').evaluateAll(rows=>rows.filter(row=>row.querySelectorAll('td').length===4).map(row=>Array.from(row.cells).map(cell=>cell.textContent.normalize('NFKC').trim()))),sortedSummary,'Usage print follows the visible sort');
    assert.match(await popup.locator('header').textContent(),/월사용량 합계\(KG\) 내림차순/);
    assert.match(await popup.locator('header').textContent(),/전체 · 6건/,'Print count includes entered specs only');
    assert.doesNotMatch(await popup.locator('tbody').textContent(),/미입력품목|제외브랜드/);
    assert.equal(await popup.locator('button,input,script').count(),0,'Print headers contain no interactive controls');
    await popup.pdf({path:path.join(output,'usage-sorted.pdf'),preferCSSPageSize:true,printBackground:true});await popup.close();
    await page.screenshot({path:path.join(output,'usage-sorted.png'),fullPage:false});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Usage table scroll stays inside its card on mobile');
    assert.equal(await page.locator('#spec-usage-summary thead button').evaluateAll(buttons=>buttons.every(button=>button.scrollWidth<=button.closest('th').clientWidth-16)),true,'All usage sort headers fit their cells');
    await page.screenshot({path:path.join(output,'usage-mobile.png'),fullPage:false});
    await page.setViewportSize({width:1440,height:900});
    await page.locator('#spec-search').fill('미입력품목');
    assert.equal(await page.locator('#spec-print').isEnabled(),true);
    assert.equal(await page.locator('#spec-usage-print').isDisabled(),true);
    assert.equal(await page.locator('#spec-usage-rows td').getAttribute('colspan'),'4');
    const noUsageOpenCount=await page.evaluate(()=>qaOpenCount);
    await page.evaluate(()=>DBMTProductSpecs.printUsage());assert.equal(await page.evaluate(()=>qaOpenCount),noUsageOpenCount,'Direct calls cannot open a report with no entered usage');
    await page.getByRole('button',{name:'검색 초기화',exact:true}).click();

    const many=Array.from({length:70},(_,i)=>({...base,id:'multi-'+i,trader:'업체'+String(i+1).padStart(3,'0'),material:'상품'+String(i+1).padStart(3,'0'),brand:i===35?'긴 브랜드 '.repeat(20)+'브랜드끝표시':'브랜드'+String(i+1).padStart(3,'0'),note:'인쇄제외비고'+String(i+1).padStart(3,'0')}));
    await page.evaluate(data=>{qaRights.view=true;qaRows=data;return DBMTProductSpecs.load();},many);
    await page.locator('[data-sort="trader"]').click();
    popup=await openPrint();
    assert.equal(await popup.locator('tbody tr').count(),70);
    assert.match(await popup.locator('body').textContent(),/브랜드끝표시/);
    assert.doesNotMatch(await popup.locator('body').textContent(),/인쇄제외비고/);
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
    console.log('PASS: brand-aware entered-only usage groups, zero handling, four-column ascending/descending sort, matching print order, no-usage print guard and mobile headers; customer filters, detail print and permissions. QA: '+output);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
