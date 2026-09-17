/* Selected touch layout 2. Shares production log/print functions with label-print.html. */
(function(){
  'use strict';
  let ready=false,current='',historyPage=0,historyOrder='',lastFocus=null,previewReturn=false;
  const jobs=new Map(),selected=new Set();
  const productStorage='dbmt_label_output_products_v1';
  let productChoices=new Map(),pendingProduct='',productPage=0;
  try{const saved=JSON.parse(localStorage.getItem(productStorage)||'[]');if(Array.isArray(saved))productChoices=new Map(saved.filter(e=>Array.isArray(e)&&typeof e[0]==='string'&&typeof e[1]==='string'));}catch(e){/* Optional station preference; printing does not depend on storage. */}
  const byId=id=>document.getElementById(id);
  const button=(text,attrs='')=>`<button type="button" ${attrs}>${text}</button>`;
  const name=kind=>kind==='inner'?'내포장':'외포장';
  const chosenProduct=()=>productChoices.get(String(selectedOrder()?.id||''))||'';
  const registeredProduct=id=>id?state.labelProducts.find(p=>String(p.id)===String(id)):null;
  function printOrder(){
    const row=selectedOrder(),id=chosenProduct(),product=id&&registeredProduct(id);
    if(id&&!product)return null;
    try{return DBMTLabelProducts.compose(row,product||null);}catch(e){return null;}
  }
  function productError(){
    if(!selectedOrder())return '';
    if(chosenProduct()&&!registeredProduct(chosenProduct()))return '선택했던 생산품목이 삭제되었습니다. 생산품목 변경에서 다시 선택하세요.';
    try{DBMTLabelProducts.compose(selectedOrder(),registeredProduct(chosenProduct())||null);return '';}catch(e){return e.message;}
  }
  function productDetail(row){
    return [row.productCode,row.packunit&&`포장 ${row.packunit}`,row.origin,row.storage||row.temptype].filter(Boolean).join(' · ');
  }
  function renderProducts(){
    const row=selectedOrder();if(!row)return;
    const query=byId('product-search').value.trim().toLowerCase();
    const list=state.labelProducts.filter(p=>p.id&&p.name&&[p.name,p.productCode,p.packunit,p.brand,p.nationalPartCode,p.nationalPartName,p.origin,p.storage,p.meattype].join(' ').toLowerCase().includes(query))
      .sort((a,b)=>String(a.name).localeCompare(String(b.name),'ko')||String(a.packunit||'').localeCompare(String(b.packunit||''),'ko')||String(a.productCode||a.id).localeCompare(String(b.productCode||b.id)));
    const pages=Math.max(1,Math.ceil(list.length/6));productPage=Math.min(productPage,pages-1);
    byId('product-default').textContent=`작업지시 기본품목 · ${row.product||'-'}`;
    byId('product-default').setAttribute('aria-pressed',String(!pendingProduct));
    byId('product-list').innerHTML=list.slice(productPage*6,productPage*6+6).map(p=>button(`<strong>${html(p.name)}</strong><small>${html(productDetail(p))}</small>`,`data-product="${html(p.id)}" aria-pressed="${pendingProduct===String(p.id)}"`)).join('')||'<p class="empty">등록 품목이 없거나 검색 결과가 없습니다. ERP 품목관리에서 먼저 등록해주세요.</p>';
    byId('product-page').textContent=`${productPage+1} / ${pages} · ${list.length}품목`;
    byId('product-prev').disabled=productPage===0;byId('product-next').disabled=productPage===pages-1;
    let effective=null,error='';
    try{if(pendingProduct&&!registeredProduct(pendingProduct))throw new Error('선택한 품목을 찾을 수 없습니다.');effective=DBMTLabelProducts.compose(row,registeredProduct(pendingProduct)||null);}catch(e){error=e.message;}
    byId('product-selection-detail').textContent=effective?`${effective.product} · ${productDetail(effective)}\n품목보고번호 ${effective.itemno||'미등록'} · 제조 ${effective.mfgdate||row.date} / 소비기한 ${effective.expdate||'미등록'}\n원료·LOT·작업일·원산지·등급 및 라벨 중량 유지 / 매수는 1장으로 설정` : error;
    byId('product-apply').disabled=!effective||state.loading;
  }
  function renderProductTotals(){
    const groups=DBMTLabelProducts.group(logsForOrder(state.selectedId));
    byId('product-totals-list').innerHTML=groups.map(g=>`<div class="product-total-row"><span><strong>${html(g.name)}</strong><small>${html([g.code,g.packunit,g.origin,`LOT ${g.lot}`].filter(Boolean).join(' · '))}</small></span><b>${g.count}장<br>${kg(g.weight)}</b></div>`).join('')||'<p class="empty">외포장 출력이력이 없습니다.</p>';
    byId('product-totals-summary').textContent=`${groups.length}개 품목 구분 · ${groups.reduce((sum,g)=>sum+g.count,0)}장 · ${kg(groups.reduce((sum,g)=>sum+g.weight,0))} / 내포장·삭제 이력 제외`;
  }
  function settings(){
    const row=selectedOrder(),key=String(row?.id||'');
    if(!jobs.has(key))jobs.set(key,{inner:{weight:1,copies:1,mode:'fixed'},outer:{weight:DBMTLabelWeight.valid(row?.weight)?Number(row.weight):0,copies:1,mode:'fixed'},size:row?.labelSize||'7x10'});
    return jobs.get(key);
  }
  const scale=DBMTScale.create(navigator.serial,()=>{if(ready)sync();});
  function remember(){
    if(!ready||!current||!jobs.has(current))return;
    const s=jobs.get(current);s.outer.weight=DBMTLabelWeight.value('print-weight');s.outer.copies=Number(byId('print-copies').value);s.size=byId('print-size').value;
  }
  function restore(){
    const s=settings();current=String(selectedOrder()?.id||'');
    const select=byId('print-weight');
    if([...select.options].some(o=>o.value===String(s.outer.weight)))select.value=String(s.outer.weight);
    else {select.value='custom';byId('print-weight-custom').value=s.outer.weight||'';}
    byId('print-weight-custom').hidden=select.value!=='custom';
    byId('print-copies').value=s.outer.copies;byId('print-size').value=s.size;
  }
  function weight(kind){
    const s=settings()[kind];
    if(s.mode==='scale'){const live=scale.status();return live.ready?live.value:0;}
    return kind==='outer'?DBMTLabelWeight.value('print-weight'):(DBMTLabelWeight.valid(s.weight)?s.weight:0);
  }
  // Only inner packaging may deliberately omit the net weight.  Keep this
  // separate from an invalid/empty value so outer labels and production totals
  // always continue to require a positive, recorded weight.
  function isWeightOmitted(kind){
    const s=settings()[kind];
    return kind==='inner'&&s.mode==='fixed'&&Number(s.weight)===0;
  }
  function copies(kind){
    const s=settings()[kind],n=s.mode==='scale'?1:kind==='outer'?Number(byId('print-copies').value):s.copies;
    return Number.isInteger(n)&&n>=1&&n<=500?n:0;
  }
  function sync(){
    if(!ready||!byId('scale-value'))return;
    const row=selectedOrder(),s=settings(),live=scale.status();
    const effective=printOrder(),selectionError=productError();
    if(current!==String(row?.id||''))restore();
    byId('scale-value').textContent=live.value===null?'—':live.value.toFixed(2);
    byId('scale-state').textContent=live.message;
    byId('scale-state').classList.toggle('not-ready',!live.ready);
    byId('scale-connect').disabled=live.connecting||live.connected||state.loading;
    byId('scale-disconnect').disabled=!live.connected||state.loading;
    byId('scale-dialog-status').textContent=live.message;
    for(const kind of ['inner','outer']){
      const set=s[kind],w=weight(kind),weightOmitted=isWeightOmitted(kind),n=copies(kind),locked=state.loading||!row||(kind==='outer'&&!!completionFor(row.id));
      byId(`${kind}-weight-btn`).innerHTML=weightOmitted?'<strong>미표기</strong><small>중량 없음</small>':`<strong>${w?w.toFixed(2):'—'}</strong><small>kg</small>`;
      byId(`${kind}-weight-btn`).disabled=locked||set.mode==='scale';
      byId(`${kind}-weight-help`).textContent=set.mode==='scale'?'저울 안정 중량 자동 적용':weightOmitted?'0 kg · 중량 미표기로 출력':'터치하여 중량 입력';
      byId(`${kind}-copies-btn`).textContent=n||'—';
      document.querySelectorAll(`[data-kind="${kind}"][data-mode]`).forEach(el=>{el.setAttribute('aria-pressed',String(el.dataset.mode===set.mode));el.disabled=locked;});
      document.querySelectorAll(`[data-kind="${kind}"][data-copy]`).forEach(el=>el.disabled=locked||set.mode==='scale');
      byId(`${kind}-copies-btn`).disabled=locked||set.mode==='scale';
      byId(`${kind}-copies-help`).textContent=set.mode==='scale'?'계근당 1장':'매수';
      const print=byId(kind==='outer'?'print-btn':'inner-print-btn');
      print.disabled=locked||(!w&&!weightOmitted)||!n||!!selectionError;
      print.innerHTML=`<span>${name(kind)}라벨출력</span><small>${!w&&!weightOmitted?'중량 확인 필요':kind==='inner'?`${n}장 · ${weightOmitted?'중량 미표기 · ':''}생산 집계 제외`:`${n}장 · 생산 +${kg(w*n)}`}</small>`;
      byId(kind==='outer'?'preview-btn':'inner-preview-btn').disabled=state.loading||!row||(!w&&!weightOmitted)||!!selectionError;
    }
    byId('print-size').disabled=state.loading||!row; // Shared physical media; inner printing remains available after completion.
    byId('reprint-open').disabled=state.loading||!row;
    byId('history-print').disabled=state.loading||!selected.size;
    byId('history-print').textContent=`선택 ${selected.size}장 재출력`;
    byId('touch-output').textContent=byId('metric-output').textContent;
    byId('outer-total').textContent=byId('active-count').textContent;
    byId('metric-label-weight').textContent=weight('outer')?kg(weight('outer')):'—';
    byId('selected-name').textContent=selectionError?'생산품목 확인 필요':effective?.product||'작업지시를 선택하세요';
    byId('selected-meta').textContent=selectionError|| (row?`${productDetail(effective||row)} · LOT ${row.lot||row.sourceStock?.lot||'-'}`:'연결 후 작업지시를 선택하세요.');
    byId('product-open').disabled=state.loading||!row||!state.pin;
    byId('product-totals-open').disabled=state.loading||!row;
    byId('work-order-open').disabled=state.loading||!state.pin;
    byId('current-work-title').textContent=row?(row.title||row.product):'작업지시를 선택하세요';
    byId('current-work-meta').textContent=row?`${row.date||''} · LOT ${row.lot||row.sourceStock?.lot||'-'}`:'먼저 PIN으로 연결하세요.';
    const completed=row&&completionFor(row.id);
    byId('current-work-state').textContent=completed?'생산일보 전송 완료':row&&completionRecordFor(row.id)?.deleted?'전송 취소 · 수정 가능':row?'라벨 출력 중':'연결 대기';
    byId('cancel-transfer-open').hidden=!completed;
    byId('cancel-transfer-open').disabled=state.loading||!completed;
    byId('complete-production-btn').hidden=!!completed;
    byId('cancel-transfer-confirm').disabled=state.loading;
    document.querySelectorAll('#cancel-transfer-dialog [data-close]').forEach(b=>b.disabled=state.loading);
    document.querySelectorAll('#history-body button,#history-body input').forEach(el=>{if(state.loading)el.disabled=true;});
    document.querySelectorAll('#order-list button,#date-filter,#today-btn,#all-btn,#search-filter,#clear-search-btn').forEach(el=>el.disabled=state.loading);
  }
  function closeDialog(id){const d=byId(id);if(!d.open)return;d.close();if(lastFocus?.isConnected&&!lastFocus.hidden)lastFocus.focus();else byId('work-order-open').focus();}
  function openDialog(id){lastFocus=document.activeElement;byId(id).showModal();}
  function renderHistory(){
    if(!ready)return;
    const row=selectedOrder(),id=String(row?.id||'');
    if(historyOrder!==id){historyOrder=id;historyPage=0;selected.clear();}
    const logs=row?logsForOrder(row.id):[],pages=Math.max(1,Math.ceil(logs.length/4));
    historyPage=Math.min(historyPage,pages-1);
    const valid=new Set(logs.filter(l=>l.status!=='void').map(l=>String(l.id)));
    for(const key of selected)if(!valid.has(key))selected.delete(key);
    byId('history-count').textContent=`${logs.length}건`;
    byId('history-title').textContent=row?`${row.product||row.title} · 외포장 ${logs.length}건`:'외포장 출력이력';
    byId('history-meta').textContent=row?`${row.date||''} · LOT ${row.lot||row.sourceStock?.lot||'-'} · 과거 라벨 내용으로 재출력`:'';
    byId('history-body').innerHTML=logs.slice(historyPage*4,historyPage*4+4).map(log=>{
      const id=String(log.id),voided=log.status==='void';
      return `<div class="touch-history-row"><label class="history-choice"><input type="checkbox" data-log="${html(id)}" aria-label="${html(log.code||id)} 선택" ${selected.has(id)?'checked':''} ${voided||state.loading?'disabled':''}><span><strong>${html(log.workOrderSnapshot?.product||log.product||'품목 없음')}${log.workOrderSnapshot?.packunit?' / '+html(log.workOrderSnapshot.packunit):''}</strong><small>${html(log.code||id)}</small><small>${html(formatTime(log.printedAt))} · ${voided?'삭제됨':`재출력 ${toNumber(log.reprintCount)}회`}</small></span><b>${kg(log.labelWeight)}</b></label><div class="history-actions">${button('미리보기',`data-act="preview" data-id="${html(id)}"`)}${button('재출력',`data-act="reprint" data-id="${html(id)}" ${voided||state.loading?'disabled':''}`)}${button('삭제',`data-act="void" data-id="${html(id)}" ${voided||state.loading||completionFor(row.id)?'disabled':''}`)}</div></div>`;
    }).join('')||'<p class="empty">이 작업의 외포장 출력이력이 없습니다.</p>';
    byId('history-page').textContent=`${historyPage+1} / ${pages}`;
    byId('history-prev').disabled=historyPage===0||state.loading;
    byId('history-next').disabled=historyPage===pages-1||state.loading;
    sync();
  }
  function preview(log,back=false){
    previewReturn=back;
    if(byId('history-dialog').open)byId('history-dialog').close();
    const size=log.sizeKey||log.workOrderSnapshot?.labelSize||'7x10';
    const doc=DBMTLabelPrint.createDocument({labelsHtml:`<section class="print-label">${buildLabelBody(labelDataFromLog(log))}</section>`,sizeKey:size,preview:true,autoPrint:false});
    // The exact same print document in a sandboxed, non-scripted inline frame.
    // Hide printer instructions/watermark only on-screen; retain every label field.
    byId('label-preview-frame').srcdoc=doc.replace(/<script>[\s\S]*?<\/script>/g,'').replace('</style>','.print-tools,.preview-watermark{display:none!important} html,body{background:white} body{padding:0} .print-label{margin:0} </style>');
    byId('label-preview-frame').style.width=(size==='10x10'?100:70)+'mm';
    byId('label-preview-title').textContent=back?`당시 출력 라벨 · ${log.code||''}`:'실제 라벨 미리보기';
    byId('label-preview-close').textContent=back?'목록으로':'닫기';
    openDialog('label-preview-dialog');
  }
  function edit(kind,field){
    const s=settings()[kind],value=field==='copies'?copies(kind):(isWeightOmitted(kind)?0:s.weight);
    byId('number-title').textContent=`${name(kind)} ${field==='weight'?'1장 중량 (kg)':'출력 매수'}`;
    byId('number-input').value=value===0?'0':(value||'');byId('number-error').textContent='';
    byId('number-dialog').dataset.kind=kind;byId('number-dialog').dataset.field=field;
    byId('number-dialog').dataset.fresh='true';openDialog('number-dialog');byId('number-input').select();
  }
  function packageHtml(kind){
    return `<section class="touch-pack panel" data-package="${kind}"><div class="pack-heading"><strong>${name(kind)} · ${kind==='inner'?'진공지':'박스'}</strong><small>${kind==='inner'?'생산이력·재고에 반영하지 않음':'외포장 출력만 생산량에 포함'}</small></div><div class="pack-fields"><div class="weight-modes">${button('고정중량',`data-kind="${kind}" data-mode="fixed"`)}${button('계근중량',`data-kind="${kind}" data-mode="scale"`)}</div><div><label>라벨 적용 중량${kind==='inner'?' (0 = 미표기)':''}</label>${button('',`id="${kind}-weight-btn" class="touch-weight" data-edit="weight" data-kind="${kind}" aria-label="${name(kind)} 중량 수정"`)}<small id="${kind}-weight-help"></small></div><div><label id="${kind}-copies-help">매수</label><div class="touch-stepper">${button('−',`data-copy="-1" data-kind="${kind}" aria-label="${name(kind)} 매수 줄이기"`)}${button('1',`id="${kind}-copies-btn" data-edit="copies" data-kind="${kind}" aria-label="${name(kind)} 매수 입력"`)}${button('+',`data-copy="1" data-kind="${kind}" aria-label="${name(kind)} 매수 늘리기"`)}</div></div></div><div class="pack-actions" id="${kind}-actions"></div></section>`;
  }
  function init(){
    document.body.classList.add('touch-label');
    const left=document.querySelector('.left'),shell=document.querySelector('.shell'),right=document.querySelector('.right');
    const col=document.createElement('aside');col.className='touch-left';shell.insertBefore(col,left);
    col.innerHTML='<section class="panel touch-current-work"><span>현재 작업지시</span><strong id="current-work-title"></strong><small id="current-work-meta"></small><span id="current-work-state"></span>'+button('작업지시 변경','id="work-order-open"')+'</section>';
    col.querySelector('.touch-current-work').insertAdjacentHTML('beforeend',button('품목별 생산현황','id="product-totals-open"'));
    const calc=document.createElement('section');calc.className='panel touch-calc';calc.setAttribute('aria-label','터치 계산기');
    calc.innerHTML='<div class="calc-title">계산기 <small>독립 계산</small></div><output id="calc-output" aria-live="polite">0</output><div class="calc-keys">'+['AC','⌫','%','÷','7','8','9','×','4','5','6','−','1','2','3','+','0','.','='].map(k=>button(k,`data-calc="${k}" aria-label="계산기 ${k}"`)).join('')+'</div>';col.append(calc);
    document.querySelector('.brand').textContent='동부엠티 ERP · 라벨 출력';
    document.querySelector('.connect').insertAdjacentHTML('beforeend',button('저울 연결','id="scale-open"')+button('전체화면','id="fullscreen-btn"'));
    document.body.append(byId('status'));byId('status').setAttribute('role','status');
    const summary=byId('selected-name').closest('.panel');summary.classList.add('touch-summary');
    byId('selected-size').hidden=true;summary.append(byId('selected-size'));summary.querySelector('.panel-head').remove();
    const title=summary.querySelector('.selected-title');title.insertAdjacentHTML('beforeend','<small id="selected-meta"></small>');
    const head=document.createElement('div');head.className='touch-job-head';title.before(head);head.append(title);
    const productButton=document.createElement('button');productButton.type='button';productButton.id='product-open';productButton.setAttribute('aria-label','생산품목 / 스펙 변경');
    productButton.innerHTML='<small class="product-change-caption">다음 출력품목 · 변경 ▾</small>';title.before(productButton);productButton.append(title);byId('selected-date').hidden=true;
    head.insertAdjacentHTML('beforeend',button('<span>현재 계근중량</span><small id="scale-state">저울 미연결</small><strong><span id="scale-value">—</span><small>kg</small></strong>','id="scale-readout" class="scale-readout"'));
    // Remove the small legacy on-screen editor, but keep its form values as the
    // single outer-weight source for the existing print/save workflow.
    const editor=byId('print-btn').closest('.panel'),outerPrint=byId('print-btn'),outerPreview=byId('preview-btn');
    const controls=document.createElement('div');controls.hidden=true;controls.id='legacy-label-values';
    const weightMetric=byId('metric-label-weight').parentElement;
    ['print-weight','print-weight-custom','print-copies','print-product','metric-label-weight','active-count'].forEach(id=>controls.append(byId(id)));
    weightMetric.remove();
    document.body.append(controls);
    const media=document.createElement('label');media.className='touch-media';media.textContent='라벨 크기 ';media.append(byId('print-size'));
    const area=document.createElement('div');area.className='touch-pack-area';area.innerHTML=packageHtml('inner')+packageHtml('outer');editor.replaceWith(area);
    byId('outer-actions').append(outerPrint,outerPreview);outerPreview.textContent='라벨 미리보기';
    byId('inner-actions').innerHTML=button('내포장라벨출력','id="inner-print-btn"')+button('라벨 미리보기','id="inner-preview-btn"');
    const bottom=document.createElement('section');bottom.className='panel touch-bottom';
    const complete=byId('complete-production-btn'),notice=byId('completion-status');
    complete.parentElement.remove();complete.removeAttribute('style');notice.removeAttribute('style');
    bottom.innerHTML='<div class="touch-history-open"><span>외포장 <b id="outer-total">0장</b></span>'+button('재출력','id="reprint-open"')+'</div><div class="touch-transfer"><span>생산량 <b id="touch-output">—</b></span></div>';
    bottom.querySelector('.touch-transfer').append(complete);bottom.querySelector('.touch-transfer').insertAdjacentHTML('beforeend',button('전송 취소 · 수정하기','id="cancel-transfer-open" hidden'));bottom.append(notice);bottom.querySelector('.touch-history-open').prepend(media);right.append(bottom);
    document.querySelector('.history-wrap').remove();
    document.body.insertAdjacentHTML('beforeend',`<dialog id="history-dialog" class="touch-dialog history-dialog"><h2 id="history-title">외포장 출력이력</h2><p id="history-meta"></p><span id="history-count" hidden></span><div id="history-body"></div><nav class="history-pager">${button('이전','id="history-prev"')}<span id="history-page"></span>${button('다음','id="history-next"')}</nav><footer>${button('닫기','data-close="history-dialog"')}${button('선택 0장 재출력','id="history-print" class="dark"')}</footer><p class="dialog-notice" role="status"></p></dialog>
      <dialog id="label-preview-dialog" class="touch-dialog preview-dialog"><h2 id="label-preview-title"></h2><div class="preview-stage"><iframe id="label-preview-frame" title="실제 인쇄 라벨" sandbox="allow-same-origin"></iframe></div>${button('닫기','id="label-preview-close"')}</dialog>
      <dialog id="number-dialog" class="touch-dialog number-dialog"><h2 id="number-title"></h2><input id="number-input" inputmode="decimal" aria-label="라벨 숫자 입력"><div id="number-keys">${['7','8','9','4','5','6','1','2','3','.','0','⌫'].map(k=>button(k,`data-number="${k}"`)).join('')}</div><p id="number-error" role="alert"></p><footer>${button('취소','data-close="number-dialog"')}${button('적용','id="number-apply" class="dark"')}</footer></dialog>
      <dialog id="scale-dialog" class="touch-dialog"><h2>저울 연결</h2><p>A&amp;D FG-150KAL · COM2 / 2400 / 7E1</p><p>SM을 종료한 뒤 연결을 누르고 <b>COM2</b>를 선택하세요. 브라우저를 다시 열면 연결 버튼으로 재연결하세요.</p><p>저울 표시값을 그대로 사용합니다. 용기무게는 저울에서 설정하고, 첫 출력 전 표시 중량과 일치하는지 확인하세요.</p><p id="scale-dialog-status" role="status"></p><footer>${button('연결','id="scale-connect"')}${button('연결 해제','id="scale-disconnect"')}${button('닫기','data-close="scale-dialog"')}</footer></dialog>`);
    document.body.insertAdjacentHTML('beforeend',`<dialog id="work-order-dialog" class="touch-dialog work-order-dialog" aria-labelledby="work-order-title"><h2 id="work-order-title">작업지시 선택</h2><p>작업을 누르면 전환됩니다. 검색하거나 닫기만 하면 현재 작업은 유지됩니다.</p><div id="work-order-content"></div><footer>${button('현재 작업 유지 · 닫기','data-close="work-order-dialog"')}</footer></dialog>
      <dialog id="cancel-transfer-dialog" class="touch-dialog" aria-labelledby="cancel-transfer-title"><h2 id="cancel-transfer-title">생산일보 전송을 취소할까요?</h2><p id="cancel-transfer-target"></p><ul><li>연결된 생산일보를 삭제하고 원료·생산품 재고 반영과 부자재 사용을 함께 취소합니다.</li><li>사무실에서 해당 생산일보에 추가·수정한 내용도 취소됩니다. 재전송 시 출력이력 기준으로 새 생산일보를 만듭니다.</li><li>기존 라벨 출력이력은 유지됩니다. 잘못 출력한 외포장 이력은 재출력 목록에서 삭제한 뒤 다시 출력하세요.</li><li>출고·재투입·이동 또는 다른 작업지시에 연결된 생산품은 먼저 연결 내역을 정리해야 합니다.</li></ul><p id="cancel-transfer-error" role="alert"></p><footer>${button('돌아가기','data-close="cancel-transfer-dialog"')}${button('생산일보 삭제 · 전송 취소','id="cancel-transfer-confirm" class="dark"')}</footer></dialog>`);
    byId('work-order-content').append(left);
    document.body.insertAdjacentHTML('beforeend',`<dialog id="product-dialog" class="touch-dialog product-dialog" aria-labelledby="product-dialog-title"><h2 id="product-dialog-title">생산품목 / 스펙 변경</h2><p>등록된 품목을 선택한 뒤 적용하세요. 기존 출력이력은 바뀌지 않습니다.</p><div class="product-search"><input id="product-search" type="search" placeholder="품목명, 스펙, 제품코드 검색" aria-label="생산품목 검색">${button('지움','id="product-search-clear"')}</div>${button('작업지시 기본품목','id="product-default"')}<div id="product-list"></div><nav class="history-pager">${button('이전','id="product-prev"')}<span id="product-page"></span>${button('다음','id="product-next"')}</nav><p id="product-selection-detail"></p><footer>${button('현재 품목 유지 · 닫기','data-close="product-dialog"')}${button('다음 출력부터 적용','id="product-apply" class="dark"')}</footer></dialog>
      <dialog id="product-totals-dialog" class="touch-dialog history-dialog" aria-labelledby="product-totals-title"><h2 id="product-totals-title">품목별 외포장 생산현황</h2><p id="product-totals-summary"></p><div id="product-totals-list"></div><footer>${button('닫기','data-close="product-totals-dialog"')}</footer></dialog>`);
    ready=true;wire();renderAll();window.DBMTLabelFullscreen?.sync();setInterval(()=>sync(),500);
  }
  function wire(){
    byId('product-open').onclick=()=>{pendingProduct=chosenProduct();productPage=0;byId('product-search').value='';renderProducts();openDialog('product-dialog');};
    byId('product-search').oninput=()=>{productPage=0;renderProducts();};
    byId('product-search-clear').onclick=()=>{byId('product-search').value='';productPage=0;renderProducts();};
    byId('product-prev').onclick=()=>{productPage--;renderProducts();};byId('product-next').onclick=()=>{productPage++;renderProducts();};
    byId('product-default').onclick=()=>{pendingProduct='';renderProducts();};
    byId('product-list').onclick=e=>{const b=e.target.closest('[data-product]');if(b){pendingProduct=b.dataset.product;renderProducts();}};
    byId('product-dialog').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeDialog('product-dialog');}});
    byId('product-apply').onclick=()=>{
      if(state.loading||!selectedOrder()||(pendingProduct&&!registeredProduct(pendingProduct)))return;
      const key=String(selectedOrder().id);pendingProduct?productChoices.set(key,pendingProduct):productChoices.delete(key);
      try{localStorage.setItem(productStorage,JSON.stringify([...productChoices].slice(-2000)));}catch(e){/* Current selection stays in memory. */}
      settings().inner.copies=settings().outer.copies=1;byId('print-copies').value=1;
      closeDialog('product-dialog');renderAll();
      setStatus(`다음 출력품목: ${printOrder()?.product||'-'} · 기존 이력 유지 · 매수 1장. 중량·품목보고번호·소비기한은 미리보기로 확인하세요.${completionFor(key)?' 전송 완료 상태에서는 내포장만 새로 출력할 수 있습니다.':''}`,'ok');
    };
    byId('product-totals-open').onclick=()=>{renderProductTotals();openDialog('product-totals-dialog');};
    byId('work-order-open').onclick=()=>{renderOrders();openDialog('work-order-dialog');};
    byId('work-order-dialog').addEventListener('keydown',e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeDialog('work-order-dialog');}
    });
    byId('cancel-transfer-open').onclick=()=>{
      const row=selectedOrder(),done=row&&completionFor(row.id);if(state.loading||!done)return;
      const dialog=byId('cancel-transfer-dialog');dialog.dataset.workOrderId=String(row.id);dialog.dataset.productionId=done.productionId;
      byId('cancel-transfer-target').textContent=`${row.title||row.product} · ${done.date||''} #${done.jobNo||''} 생산일보`;
      byId('cancel-transfer-error').textContent='';openDialog('cancel-transfer-dialog');
    };
    byId('cancel-transfer-dialog').addEventListener('cancel',e=>{if(state.loading)e.preventDefault();});
    byId('cancel-transfer-confirm').onclick=async()=>{
      const dialog=byId('cancel-transfer-dialog');
      if(await cancelProductionTransfer(dialog.dataset.workOrderId,dialog.dataset.productionId))closeDialog('cancel-transfer-dialog');
      else byId('cancel-transfer-error').textContent=byId('status').textContent;
    };
    byId('inner-print-btn').onclick=()=>printSelectedLabels('inner');byId('inner-preview-btn').onclick=()=>previewSelectedLabel('inner');
    byId('reprint-open').onclick=()=>{selected.clear();historyPage=0;renderHistory();openDialog('history-dialog');};
    byId('history-prev').onclick=()=>{historyPage--;renderHistory();};byId('history-next').onclick=()=>{historyPage++;renderHistory();};
    byId('history-body').onchange=e=>{if(e.target.matches('[data-log]')){e.target.checked?selected.add(e.target.dataset.log):selected.delete(e.target.dataset.log);sync();}};
    byId('history-body').onclick=async e=>{
      const b=e.target.closest('button[data-act]');if(!b||b.disabled||state.loading)return;
      const log=logsForOrder(state.selectedId).find(l=>String(l.id)===b.dataset.id);if(!log)return;
      if(b.dataset.act==='preview'){preview(log,true);return;}
      if(b.dataset.act==='reprint')await reprintLog(log.id);
      if(b.dataset.act==='void')await voidLog(log.id);
      renderHistory();byId('history-dialog').querySelector('.dialog-notice').textContent=byId('status').textContent;
    };
    byId('history-print').onclick=async()=>{if(state.loading)return;await reprintLogs([...selected]);renderHistory();byId('history-dialog').querySelector('.dialog-notice').textContent=byId('status').textContent;};
    byId('label-preview-close').onclick=()=>{closeDialog('label-preview-dialog');if(previewReturn)openDialog('history-dialog');};
    document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>closeDialog(b.dataset.close));
    document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{settings()[b.dataset.kind].mode=b.dataset.mode;sync();});
    document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>edit(b.dataset.kind,b.dataset.edit));
    document.querySelectorAll('[data-copy]').forEach(b=>b.onclick=()=>{
      const kind=b.dataset.kind,s=settings()[kind];s.copies=Math.max(1,Math.min(500,copies(kind)+Number(b.dataset.copy)));
      if(kind==='outer')byId('print-copies').value=s.copies;sync();
    });
    byId('number-input').oninput=()=>byId('number-dialog').dataset.fresh='false';
    byId('number-keys').onclick=e=>{
      const b=e.target.closest('[data-number]');if(!b)return;const d=byId('number-dialog'),input=byId('number-input'),k=b.dataset.number;
      if(d.dataset.fresh==='true'){input.value='';d.dataset.fresh='false';}
      if(k==='⌫')input.value=input.value.slice(0,-1);else if(input.value.length<9&&(k!=='.'||!input.value.includes('.')))input.value+=k;
    };
    byId('number-apply').onclick=()=>{
      const d=byId('number-dialog'),kind=d.dataset.kind,field=d.dataset.field,raw=byId('number-input').value.trim(),value=Number(raw);
      const zeroWeight=kind==='inner'&&field==='weight'&&/^0(?:\.0{1,2})?$/.test(raw);
      const valid=field==='weight'?(zeroWeight||(DBMTLabelWeight.valid(raw)&&value<=1000)):Number.isInteger(value)&&value>=1&&value<=500;
      if(!valid){byId('number-error').textContent=field==='weight'?(kind==='inner'?'0은 중량 미표기 출력입니다. 그 외에는 0 초과 1,000 kg 이하, 소수 둘째 자리까지 입력하세요.':'0 초과 1,000 kg 이하, 소수 둘째 자리까지 입력하세요.'):'1~500 사이 정수로 입력하세요.';return;}
      settings()[kind][field]=value;
      if(kind==='outer'){
        if(field==='weight'){byId('print-weight').value='custom';byId('print-weight-custom').value=value;byId('print-weight-custom').hidden=false;}
        else byId('print-copies').value=value;
      }
      closeDialog('number-dialog');sync();
    };
    ['print-weight','print-weight-custom','print-copies','print-size'].forEach(id=>['input','change'].forEach(event=>byId(id).addEventListener(event,()=>{remember();sync();})));
    byId('scale-open').onclick=byId('scale-readout').onclick=()=>openDialog('scale-dialog');
    byId('scale-connect').onclick=async()=>{try{await scale.connect();}catch(e){setStatus(e.message,'warn');}sync();};
    byId('scale-disconnect').onclick=async()=>{await scale.disconnect();sync();};
    byId('fullscreen-btn').onclick=()=>window.DBMTLabelFullscreen?.toggle();
    const calc={value:'0',stored:null,op:null,fresh:false};
    function result(a,b,op){return op==='+'?a+b:op==='−'?a-b:op==='×'?a*b:op==='÷'?(b===0?NaN:a/b):b;}
    const format=n=>Number.isFinite(n)?String(Number(n.toPrecision(10))):'오류';
    document.querySelector('.calc-keys').onclick=e=>{
      const k=e.target.closest('[data-calc]')?.dataset.calc;if(!k)return;
      if(k==='AC'||calc.value==='오류')Object.assign(calc,{value:'0',stored:null,op:null,fresh:false});
      if(/^[\d.]$/.test(k)){if(calc.fresh){calc.value='0';calc.fresh=false;}if(k==='.'){if(!calc.value.includes('.'))calc.value+='.';}else if(calc.value.length<11)calc.value=calc.value==='0'?k:calc.value+k;}
      else if(k==='⌫')calc.value=calc.value.slice(0,-1)||'0';
      else if(k==='%')calc.value=format(Number(calc.value)/100);
      else if(k==='='){if(calc.op)calc.value=format(result(calc.stored,Number(calc.value),calc.op));calc.op=null;calc.fresh=true;}
      else if(k!=='AC'){if(calc.op&&!calc.fresh)calc.value=format(result(calc.stored,Number(calc.value),calc.op));calc.stored=Number(calc.value);calc.op=k;calc.fresh=true;}
      byId('calc-output').textContent=calc.value;
    };
  }
  window.DBMTLabelTouch={get ready(){return ready;},remember,sync,weight,isWeightOmitted,copies,renderHistory,preview,printOrder,productError,closeOrders:()=>closeDialog('work-order-dialog')};
  document.addEventListener('DOMContentLoaded',init);
})();
