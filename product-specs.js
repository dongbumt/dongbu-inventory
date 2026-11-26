(function(){
  'use strict';
  const state={rows:[],editing:null,loading:false,saving:false,token:'',request:0,sortKey:'trader',sortDirection:1,traderSelection:null,usageSortKey:'material',usageSortDirection:1};
  const el=id=>document.getElementById('spec-'+id);
  const can=action=>Boolean(window.DBMTAuth?.isPersonal() && DBMTAuth.can('product_specs',action));
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const normalize=value=>String(value??'').normalize('NFKC').toLocaleLowerCase('ko-KR').trim();
  const money=value=>value===null || value===undefined?'—':Number(value).toLocaleString('ko-KR',{maximumFractionDigits:2});
  const fields=['trader','distribution','material','brand','origin','cutting_spec','inner_packaging_spec','outer_packaging_spec','monthly_usage','stock_qty','price_kg','price_box','note'];
  const numericFields=new Set(['monthly_usage','stock_qty','price_kg','price_box']);
  const collator=new Intl.Collator('ko',{numeric:true,sensitivity:'base'});
  const inputs={trader:'trader',distribution:'distribution',material:'material',brand:'brand',origin:'origin',cutting_spec:'cutting',inner_packaging_spec:'inner-packaging',outer_packaging_spec:'outer-packaging',monthly_usage:'monthly-usage',stock_qty:'stock-qty',price_kg:'price-kg',price_box:'price-box',note:'note'};
  const catalog=()=>typeof labelProducts==='undefined'?[]:labelProducts;
  const usageValue=value=>value===null||value===undefined||String(value).trim()===''?null:Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;
  const quantityText=value=>usageValue(value)===null?'—':Number(value).toLocaleString('ko-KR',{maximumFractionDigits:6});
  function syncMaterialHint(){
    const id=el('material-product-id').value,p=catalog().find(p=>String(p.id)===id);
    el('material-meta').textContent=p?[p.kind,p.productCode,p.brand,p.origin,p.packunit,p.isActive===false?'사용 중지':''].filter(Boolean).join(' · '):el('material').value?(id?'기존 선택 품목 · 품목 선택으로 변경할 수 있습니다.':'기존 직접입력 · 등록 제품 또는 원료육을 선택해 연결할 수 있습니다.') : '';
  }
  function setMaterial(row={}){el('material-product-id').value=row.material_product_id??'';syncMaterialHint();}
  function selectMaterial(id){
    if(state.saving||state.loading||!can(state.editing?'update':'create'))return false;
    const p=catalog().find(p=>String(p.id)===String(id));
    if(!p||p.isActive===false||!['제품','원료육'].includes(String(p.kind||'').trim())){message('품목관리에 등록된 사용 가능한 제품 또는 원료육을 선택해주세요.',true);return false;}
    el('material-product-id').value=String(p.id);el('material').value=p.name||'';
    el('brand').value=p.brand||'';
    el('origin').value=typeof normalizeOriginName==='function'?normalizeOriginName(p.origin):p.origin||'';
    syncMaterialHint();message('');return true;
  }
  function openMaterialPicker(){
    if(state.saving||state.loading||!can(state.editing?'update':'create'))return;
    openTxnProductPicker(el('material').value,el('material'));
  }
  function materialPickerKey(event){if(['Enter',' ','ArrowDown'].includes(event.key)){event.preventDefault();openMaterialPicker();}}
  const usageColumns=[['material','품목(원재료)'],['brand','브랜드'],['origin','원산지'],['qty','월사용량 합계(KG)']];
  function usageSummary(rows){
    const groups=new Map();let total=0n,entered=0,missing=0;
    for(const row of rows){
      const value=usageValue(row.monthly_usage);
      if(value===null){missing++;continue;}
      const key=JSON.stringify([normalize(row.material),normalize(row.brand),normalize(row.origin)]);
      if(!groups.has(key))groups.set(key,{material:String(row.material??'').trim(),brand:String(row.brand??'').trim(),origin:String(row.origin??'').trim(),qty:0n});
      const scaled=BigInt(value.toFixed(6).replace('.',''));groups.get(key).qty+=scaled;total+=scaled;entered++;
    }
    return {rows:Array.from(groups.values()).sort((a,b)=>compareUsageRows(a,b)||collator.compare(a.material,b.material)||collator.compare(a.brand,b.brand)||collator.compare(a.origin,b.origin)),total,entered,missing};
  }
  function compareUsageRows(a,b){
    const key=state.usageSortKey;
    if(key==='qty')return (a.qty<b.qty?-1:a.qty>b.qty?1:0)*state.usageSortDirection;
    const left=normalize(a[key]),right=normalize(b[key]);
    if(!left||!right)return Number(!left)-Number(!right);
    return collator.compare(left,right)*state.usageSortDirection;
  }
  function sortUsageBy(key){
    if(!usageColumns.some(([column])=>column===key))return;
    state.usageSortDirection=state.usageSortKey===key?-state.usageSortDirection:1;
    state.usageSortKey=key;renderUsageSummary(filteredRows());
  }
  function totalUsageText(value){
    const fraction=(value%1000000n).toString().padStart(6,'0').replace(/0+$/,'');
    return (value/1000000n).toLocaleString('ko-KR')+(fraction?'.'+fraction:'');
  }
  function usageTable(report){
    return `<table class="spec-usage-table"><thead><tr>${usageColumns.map(([,label])=>`<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${usageRows(report)}</tbody></table>`;
  }
  function usageRows(report){
    const groups=report.rows.map(row=>`<tr><td>${esc(row.material||'미입력')}</td><td>${esc(row.brand)}</td><td>${esc(row.origin||'미입력')}</td><td>${totalUsageText(row.qty)}</td></tr>`).join('');
    return groups?groups+`<tr><th scope="row" colspan="3">합계</th><td><strong>${totalUsageText(report.total)}</strong></td></tr>`:'<tr><td colspan="4">월사용량이 입력된 제품스펙이 없습니다.</td></tr>';
  }
  function renderUsageSummary(rows){
    const report=usageSummary(rows);
    el('usage-total').textContent=`${report.entered?totalUsageText(report.total)+' KG':'월사용량 미입력'} · ${report.rows.length}개 품목/브랜드/원산지`;
    el('usage-info').textContent=`현재 선택·검색된 목록에서 월사용량이 입력된 스펙만 품목명·브랜드·원산지별로 합산합니다. 입력 ${report.entered}건 · 미입력 ${report.missing}건 제외`;
    el('usage-rows').innerHTML=usageRows(report);
    document.querySelectorAll('.spec-usage-sort').forEach(button=>{
      const active=button.dataset.usageSort===state.usageSortKey;
      button.closest('th').setAttribute('aria-sort',active?(state.usageSortDirection===1?'ascending':'descending'):'none');
      button.querySelector('.spec-sort-indicator').textContent=active?(state.usageSortDirection===1?'▲':'▼'):'↕';
      button.title=`${button.dataset.label} ${active&&state.usageSortDirection===1?'내림차순':'오름차순'} 정렬`;
    });
  }
  const distributions=new Set(['삼성웰스토리','동원홈푸드','CJ프레시웨이','동부축산유통','직납']);
  function setDistribution(value=''){
    const text=String(value??'');
    const custom=Boolean(text&&!distributions.has(text));
    el('distribution-choice').value=custom?'__custom__':text;
    el('distribution').value=text;
    el('distribution').hidden=!custom;
  }
  function changeDistribution(){
    const choice=el('distribution-choice').value,custom=choice==='__custom__';
    el('distribution').value=custom?'':choice;
    el('distribution').hidden=!custom;
    if(custom)el('distribution').focus();
  }
  function message(value='',error=false){el('message').textContent=value;el('message').classList.toggle('error',error);}
  function syncControls(){
    const action=state.editing?'update':'create';
    el('editor').hidden=!can(action);
    el('editor-title').textContent=state.editing?'제품스펙 수정':'제품스펙 등록';
    el('save').textContent=state.saving?'저장 중…':state.editing?'수정 저장':'+ 스펙 등록';
    el('editor').querySelectorAll('input,select,button').forEach(node=>{node.disabled=state.saving||state.loading||!can(action);});
    syncTraderChoices();
    syncPrintControl();
  }
  function reset(){
    if(state.saving)return;
    state.editing=null;el('editor').reset();setDistribution();setMaterial();syncControls();
  }
  function applyPermissions(){
    const token=window.DBMTAuth?.getSessionToken()||'';
    if(token!==state.token || !can('view')){
      state.token=token;state.request++;state.rows=[];state.loading=false;state.saving=false;
      state.traderSelection=null;el('filter-distribution').value='';
      reset();message('');
    }
    if(state.editing&&!can('update'))reset();
    syncControls();render();
  }
  function syncFilterChoices(){
    for(const [key,label] of [['distribution','전체 유통사']]){
      const select=el('filter-'+key),selected=select.value;
      const values=new Set(state.rows.map(row=>String(row[key]??'').trim()).filter(Boolean));
      // Keep a missing selection after refresh so printing never expands to all rows.
      if(selected)values.add(selected);
      select.replaceChildren(new Option(label,''),...Array.from(values).sort(collator.compare).map(value=>new Option(value,value)));
      select.value=selected;
    }
  }
  function traderChoices(){
    const distribution=el('filter-distribution').value;
    const values=new Set(state.rows.filter(row=>!distribution||String(row.distribution??'').trim()===distribution).map(row=>String(row.trader??'').trim()));
    // Keep explicit selections after refresh; removed customers must not broaden printing.
    state.traderSelection?.forEach(value=>values.add(value));
    return Array.from(values).sort(collator.compare);
  }
  function syncTraderChoices(){
    const choices=traderChoices(),list=el('filter-traders'),all=el('traders-all');
    const current=Array.from(list.querySelectorAll('input[data-spec-trader]'));
    if(current.length!==choices.length||current.some((input,index)=>input.value!==choices[index])){
      list.innerHTML=choices.length?choices.map(value=>`<label class="spec-trader-option"><input type="checkbox" data-spec-trader value="${esc(value)}"><span>${esc(value||'거래처 미입력')}</span></label>`).join(''):'<span class="spec-trader-empty">선택한 유통사에 등록된 거래처가 없습니다.</span>';
    }
    const disabled=state.loading||state.saving||!can('view');
    let selected=0;
    list.querySelectorAll('input[data-spec-trader]').forEach(input=>{
      input.checked=state.traderSelection===null||state.traderSelection.has(input.value);
      input.disabled=disabled;
      if(input.checked)selected++;
    });
    all.checked=choices.length>0&&selected===choices.length;
    all.indeterminate=selected>0&&selected<choices.length;
    all.disabled=disabled||!choices.length;
    el('traders-count').textContent=`${selected.toLocaleString('ko-KR')} / ${choices.length.toLocaleString('ko-KR')}개 거래처 선택`;
  }
  function traderSelectionText(){
    return state.traderSelection===null?'전체':Array.from(state.traderSelection).sort(collator.compare).map(value=>value||'거래처 미입력').join(', ')||'선택 없음';
  }
  function filteredRows(){
    const terms=normalize(el('search').value).split(/\s+/).filter(Boolean);
    const distribution=el('filter-distribution').value;
    return state.rows.filter(row=>{
      if(state.traderSelection!==null&&!state.traderSelection.has(String(row.trader??'').trim()))return false;
      if(distribution&&String(row.distribution??'').trim()!==distribution)return false;
      const values=[row.trader,row.distribution,row.material,row.brand,row.origin].map(normalize);
      return terms.every(term=>values.some(value=>value.includes(term)));
    }).sort((a,b)=>compareRows(a,b)||collator.compare(a.trader??'',b.trader??'')||collator.compare(a.material??'',b.material??'')||collator.compare(a.id,b.id));
  }
  function compareRows(a,b){
    const key=state.sortKey,numeric=numericFields.has(key);
    const value=row=>key==='inner_packaging_spec'?(row[key]??row.packaging_spec):row[key];
    const left=value(a),right=value(b);
    const empty=item=>item===null||item===undefined||normalize(item)===''||(numeric&&!Number.isFinite(Number(item)));
    const leftEmpty=empty(left),rightEmpty=empty(right);
    if(leftEmpty||rightEmpty)return Number(leftEmpty)-Number(rightEmpty);
    return (numeric?Number(left)-Number(right):collator.compare(normalize(left),normalize(right)))*state.sortDirection;
  }
  function sortBy(key){
    if(!fields.includes(key))return;
    state.sortDirection=state.sortKey===key?-state.sortDirection:1;
    state.sortKey=key;render();
  }
  function syncPrintControl(rows=filteredRows()){
    el('print').disabled=state.loading||state.saving||!can('view')||!rows.length;
    el('usage-print').disabled=el('print').disabled||!rows.some(row=>usageValue(row.monthly_usage)!==null);
  }
  function printDocument(rows,mode='details'){
    const columns=[
      ['trader','거래처',14],['material','원재료',13],['brand','브랜드',10],['origin','원산지',9],
      ['cutting_spec','세절스펙',14],['inner_packaging_spec','내포장 스펙',14],
      ['outer_packaging_spec','외포장 스펙',14],['monthly_usage','월사용량(KG)',12]
    ];
    const search=el('search').value.trim();
    const sortColumn=columns.find(([key])=>key===state.sortKey);
    const sortLabel=mode==='usage'?`${usageColumns.find(([key])=>key===state.usageSortKey)[1]} ${state.usageSortDirection===1?'오름차순':'내림차순'}`:sortColumn?`${sortColumn[1]} ${state.sortDirection===1?'오름차순':'내림차순'}`:'화면 목록 순서';
    const cell=(row,key)=>key==='monthly_usage'?quantityText(row[key]):key==='inner_packaging_spec'?(row[key]??row.packaging_spec??''):(row[key]??'');
    const report=usageSummary(rows),title=mode==='usage'?'월사용량 합계':'제품스펙 목록';
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title} - 동부엠티 ERP</title>
      <style>
        @page{size:A4 portrait;margin:10mm;}
        *{box-sizing:border-box;}
        body{margin:0;color:#222;background:#fff;font-family:"Malgun Gothic","맑은 고딕",sans-serif;font-size:9pt;}
        header{margin-bottom:4mm;}
        h1{margin:0 0 2mm;font-size:16pt;}
        .company{float:right;font-size:9pt;font-weight:400;color:#555;}
        .conditions{margin:0;line-height:1.6;overflow-wrap:anywhere;}
        table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:9pt;line-height:1.45;}
        thead{display:table-header-group;}
        th,td{padding:2mm 1mm;border:0.2mm solid #bbb;text-align:left;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere;}
        th{background:#eee;font-weight:700;}
        tr{break-inside:avoid;page-break-inside:avoid;}
        .spec-usage-table th:last-child,.spec-usage-table td:last-child{text-align:right;}
        @media screen{body{max-width:190mm;margin:10mm auto;padding:0 2mm;}}
      </style></head><body>
      <header><h1>${title}<span class="company">동부엠티 ERP</span></h1>
        <p class="conditions">거래처: ${esc(traderSelectionText())} · 유통사: ${esc(el('filter-distribution').value||'전체')}<br>검색: ${esc(search||'전체')} · ${(mode==='usage'?report.entered:rows.length).toLocaleString('ko-KR')}건<br>정렬: ${esc(sortLabel)}</p>
      </header>
      ${mode==='usage'?`<p class="conditions">품목명/브랜드/원산지별 합계 · 입력 ${report.entered}건 · 미입력 ${report.missing}건 제외</p>${usageTable(report)}`:`<table><colgroup>${columns.map(([, ,width])=>`<col style="width:${width}%">`).join('')}</colgroup>
        <thead><tr>${columns.map(([,label])=>`<th scope="col">${label}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(row=>`<tr>${columns.map(([key])=>`<td>${esc(cell(row,key))}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>`}</body></html>`;
  }
  function printList(mode='details'){
    const token=window.DBMTAuth?.getSessionToken()||'';
    if(!can('view')||token!==state.token){
      applyPermissions();message('제품스펙을 다시 조회한 후 인쇄해주세요.',true);return;
    }
    if(state.loading||state.saving)return;
    const rows=filteredRows();
    if(!rows.length){message('인쇄할 제품스펙이 없습니다.',true);return;}
    if(mode==='usage'&&!rows.some(row=>usageValue(row.monthly_usage)!==null)){message('월사용량이 입력된 제품스펙이 없습니다.',true);return;}
    const html=printDocument(rows,mode);
    const popup=window.open('','_blank','width=820,height=900');
    if(!popup){message('인쇄 창을 열 수 없습니다. 브라우저의 팝업 차단을 해제해주세요.',true);return;}
    popup.opener=null;
    popup.document.open();popup.document.write(html);popup.document.close();
    popup.requestAnimationFrame(()=>popup.requestAnimationFrame(async()=>{
      try{
        if(popup.document.fonts)await popup.document.fonts.ready;
        if(popup.closed)return;
        if(token!==DBMTAuth.getSessionToken()||!can('view')){popup.close();return;}
        popup.document.documentElement.dataset.printReady='true';
        popup.focus();popup.print();
      }catch(error){message('인쇄 창을 확인한 후 다시 인쇄해주세요.',true);}
    }));
  }
  function render(){
    syncFilterChoices();
    syncTraderChoices();
    const rows=filteredRows();
    syncPrintControl(rows);
    renderUsageSummary(rows);
    document.querySelectorAll('.spec-sort').forEach(button=>{
      const active=button.dataset.sort===state.sortKey;
      button.closest('th').setAttribute('aria-sort',active?(state.sortDirection===1?'ascending':'descending'):'none');
      button.querySelector('.spec-sort-indicator').textContent=active?(state.sortDirection===1?'▲':'▼'):'↕';
      button.title=`${button.dataset.label} ${active&&state.sortDirection===1?'내림차순':'오름차순'} 정렬`;
    });
    el('count').textContent=`${rows.length.toLocaleString('ko-KR')}건 / 전체 ${state.rows.length.toLocaleString('ko-KR')}건`;
    el('rows').innerHTML=rows.length?rows.map(row=>`<tr data-id="${esc(row.id)}">
      <td>${esc(row.trader)}</td><td>${esc(row.distribution)}</td><td>${esc(row.material)}</td><td>${esc(row.brand)}</td><td>${esc(row.origin)}</td>
      <td>${esc(row.cutting_spec)}</td><td>${esc(row.inner_packaging_spec??row.packaging_spec)}</td><td>${esc(row.outer_packaging_spec)}</td>
      <td class="spec-qty">${quantityText(row.monthly_usage)}</td><td class="spec-qty">${quantityText(row.stock_qty)}</td>
      <td class="spec-money">${money(row.price_kg)}</td><td class="spec-money">${money(row.price_box)}</td><td>${esc(row.note)}</td>
      <td>${can('update')?`<button type="button" class="btn btn-secondary btn-sm" data-action="edit" data-id="${esc(row.id)}">수정</button>`:''}${can('create')?`<button type="button" class="btn btn-secondary btn-sm" data-action="copy" data-id="${esc(row.id)}">복사</button>`:''}${can('delete')?`<button type="button" class="btn btn-danger btn-sm" data-action="delete" data-id="${esc(row.id)}">삭제</button>`:''}</td>
    </tr>`).join(''):`<tr><td colspan="14" class="spec-empty">${state.loading?'제품스펙을 불러오는 중입니다.':state.rows.length?'검색 조건에 맞는 제품스펙이 없습니다.':'등록된 제품스펙이 없습니다.'}</td></tr>`;
  }
  async function load(){
    if(state.saving)return;
    applyPermissions();
    if(!can('view')){message('제품스펙 조회 권한이 없습니다.',true);return;}
    const request=++state.request,token=state.token;
    state.loading=true;render();message('제품스펙을 불러오는 중입니다…');
    try{
      const result=await sbRpc('dbmt_erp_get_product_specs',{p_token:token});
      if(request!==state.request||token!==DBMTAuth.getSessionToken())return;
      if(!result?.ok)throw new Error(result?.message||'제품스펙을 불러오지 못했습니다.');
      state.rows=result.specs||[];
      if(state.editing){
        const fresh=state.rows.find(row=>row.id===state.editing.id);
        if(fresh)state.editing=fresh;else reset();
      }
      message('');
    }catch(error){if(request===state.request)message(error.message||String(error),true);}
    finally{if(request===state.request){state.loading=false;syncControls();render();}}
  }
  function edit(id){
    if(state.saving||!can('update'))return;
    const row=state.rows.find(item=>item.id===id);
    if(!row)return;
    state.editing={...row};
    fields.forEach(key=>{el(inputs[key]).value=key==='inner_packaging_spec'?(row[key]??row.packaging_spec??''):(row[key]??'');});
    setDistribution(row.distribution);
    setMaterial(row);
    syncControls();el('editor').scrollIntoView({block:'nearest',behavior:'smooth'});el('trader').focus();
  }
  function readPrice(key){
    const value=el(inputs[key]).value;
    if(value==='')return null;
    const number=Number(value);
    if(!Number.isFinite(number)||number<0||number>999999999||Math.abs(number*100-Math.round(number*100))>0.000001)throw new Error('단가는 0 이상, 소수 둘째 자리까지 입력해주세요.');
    return number;
  }
  function readQuantity(key,label){
    const raw=el(inputs[key]).value.trim();
    if(raw==='')return null;
    const value=Number(raw);
    if(!Number.isFinite(value)||value<0||value>999999999||Number(value.toFixed(6))!==value){
      throw new Error(`${label}은 0 이상, 소수 여섯 자리까지 입력해주세요.`);
    }
    return value;
  }
  function copy(id){
    if(state.saving||state.loading||!can('create'))return;
    const row=state.rows.find(item=>item.id===id);
    if(!row)return;
    state.editing=null;
    fields.forEach(key=>{el(inputs[key]).value=key==='inner_packaging_spec'?(row[key]??row.packaging_spec??''):(row[key]??'');});
    setDistribution(row.distribution);
    setMaterial(row);
    syncControls();message('스펙을 입력칸에 복사했습니다. 내용을 수정한 후 새 스펙으로 등록하세요.');
    el('editor').scrollIntoView({block:'nearest',behavior:'smooth'});el('trader').focus();
  }
  async function save(){
    if(state.saving||state.loading||!can(state.editing?'update':'create'))return;
    if(!el('editor').reportValidity())return;
    let record;
    try{
      record=Object.fromEntries(fields.filter(key=>!numericFields.has(key)).map(key=>[key,el(inputs[key]).value.trim()]));
      record.price_kg=readPrice('price_kg');record.price_box=readPrice('price_box');
      record.monthly_usage=readQuantity('monthly_usage','월사용량');
      record.stock_qty=readQuantity('stock_qty','재고량');
      record.material_product_id=el('material-product-id').value||null;
      if(!record.material_product_id&&(!state.editing||record.material!==state.editing.material))throw new Error('품목관리에 등록된 제품 또는 원료육을 선택해주세요.');
    }catch(error){message(error.message,true);return;}
    const previous=state.editing,token=state.token;
    state.saving=true;syncControls();message('제품스펙을 저장하는 중입니다…');
    try{
      const result=await sbRpc('dbmt_erp_save_product_spec',{p_token:token,p_id:previous?.id||null,p_record:record,p_revision:previous?.revision??null});
      if(token!==DBMTAuth.getSessionToken())return;
      if(!result?.ok)throw new Error(result?.message||'제품스펙 저장에 실패했습니다.');
      state.rows=state.rows.filter(row=>row.id!==result.spec.id).concat(result.spec);
      state.saving=false;reset();render();message('제품스펙을 저장했습니다.');
    }catch(error){if(token===DBMTAuth.getSessionToken())message(error.message||String(error),true);}
    finally{if(token===state.token){state.saving=false;syncControls();}}
  }
  async function remove(id){
    if(state.saving||state.loading||!can('delete'))return;
    const row=state.rows.find(item=>item.id===id);
    if(!row||!confirm(`${row.trader} / ${row.material} 제품스펙을 삭제할까요?`))return;
    const token=state.token;
    state.saving=true;syncControls();message('제품스펙을 삭제하는 중입니다…');
    try{
      const result=await sbRpc('dbmt_erp_delete_product_spec',{p_token:token,p_id:id,p_revision:row.revision});
      if(token!==DBMTAuth.getSessionToken())return;
      if(!result?.ok)throw new Error(result?.message||'제품스펙 삭제에 실패했습니다.');
      state.rows=state.rows.filter(item=>item.id!==id);
      state.saving=false;if(state.editing?.id===id)reset();render();message('제품스펙을 삭제했습니다.');
    }catch(error){if(token===DBMTAuth.getSessionToken())message(error.message||String(error),true);}
    finally{if(token===state.token){state.saving=false;syncControls();}}
  }
  async function init(){
    applyPermissions();
    if(typeof updateTraderList==='function')updateTraderList();
    if(can('view'))await load();
  }
  el('rows').addEventListener('click',event=>{
    const button=event.target.closest('button[data-action]');
    if(!button)return;
    if(button.dataset.action==='edit')edit(button.dataset.id);
    else if(button.dataset.action==='copy')copy(button.dataset.id);
    else if(button.dataset.action==='delete')remove(button.dataset.id);
  });
  el('search').addEventListener('input',render);
  document.querySelector('#spec-usage-summary thead').addEventListener('click',event=>{
    const button=event.target.closest('button[data-usage-sort]');
    if(button)sortUsageBy(button.dataset.usageSort);
  });
  el('traders-all').addEventListener('change',event=>{state.traderSelection=event.target.checked?null:new Set();render();});
  el('filter-traders').addEventListener('change',event=>{
    const input=event.target.closest('input[data-spec-trader]');
    if(!input)return;
    if(state.traderSelection===null)state.traderSelection=new Set(traderChoices());
    if(input.checked)state.traderSelection.add(input.value);else state.traderSelection.delete(input.value);
    render();
  });
  el('filter-distribution').addEventListener('change',()=>{state.traderSelection=null;render();});
  document.querySelector('.spec-table thead').addEventListener('click',event=>{
    const button=event.target.closest('button[data-sort]');
    if(button)sortBy(button.dataset.sort);
  });
  el('distribution-choice').addEventListener('change',changeDistribution);
  document.addEventListener('dbmt-product-catalog-changed',syncMaterialHint);
  window.DBMTProductSpecs={init,load,save,reset,applyPermissions,print:printList,printUsage(){printList('usage');},openMaterialPicker,materialPickerKey,selectMaterial,clearFilters(){el('search').value='';state.traderSelection=null;el('filter-distribution').value='';render();}};
})();
