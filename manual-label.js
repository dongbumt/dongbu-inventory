/* Independent office labels. Never writes work orders, print logs or stock. */
(function(global){
  'use strict';
  const el=id=>document.getElementById('lbl-'+id);
  const state={initialized:false,barcode:'',token:'',timer:null,previewKey:''};
  const fields=['origin','grade','mfgdate','expdate','weight','itemno','lot','ingredients','temptype','licenseno','prodtype','packaging','manufacturer','phone','address'];
  const value=id=>el(id)?.value.trim()||'';
  function selectedProduct(){
    const id=value('product-id');
    return (labelProducts||[]).find(row=>String(row.id)===id&&row.isActive!==false)||null;
  }
  function permitted(action='view'){
    return Boolean(global.DBMTAuth?.isPersonal()&&DBMTAuth.can('label',action));
  }
  function randomBarcode(){
    const bytes=new Uint8Array(4);global.crypto.getRandomValues(bytes);
    return 'ML'+Date.now().toString(36).toUpperCase()+Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('').toUpperCase();
  }
  function clear(){
    clearTimeout(state.timer);state.initialized=false;state.barcode='';state.previewKey='';
    document.getElementById('manual-label-form').reset();el('product-id').value='';el('product').value='';
    el('product-meta').textContent='품목관리에서 등록한 제품을 선택하세요.';
    el('preview-frame').removeAttribute('srcdoc');
    el('preview-frame').hidden=true;el('preview-empty').hidden=false;
    el('preview-empty').textContent='제품을 선택하면 라벨이 표시됩니다.';
  }
  function applyPermissions(){
    const token=global.DBMTAuth?.getSessionToken()||'';
    if(token!==state.token){clear();state.token=token;}
    const print=document.getElementById('manual-label-print');if(print)print.disabled=!permitted('create');
  }
  function init(){
    applyPermissions();
    if(!permitted())return;
    if(!state.initialized){
      state.initialized=true;state.barcode=randomBarcode();
      el('mfgdate').value=localDateString();el('weight').value='1';
      const size=localStorage.getItem('dbmt_label_size');el('size').value=size==='10x10'?'10x10':'7x10';
      for(const key of ['licenseno','prodtype','packaging','manufacturer','phone','address'])el(key).value=LBL_DEFAULTS[key]||'';
      setExpiry();
    }
    updatePreview();
  }
  function reset(){clear();init();}
  function openPicker(){
    if(!permitted())return;
    openTxnProductPicker('',el('product'));
  }
  function pickerKey(event){
    if(event.key==='Enter'||event.key==='F4'||(event.altKey&&event.key==='ArrowDown')){event.preventDefault();openPicker();}
  }
  function selectProduct(id){
    const row=(labelProducts||[]).find(item=>String(item.id)===String(id)&&item.isActive!==false);if(!row)return;
    if(!state.initialized)init();
    el('product-id').value=String(row.id);el('product').value=row.name||'';
    for(const key of ['origin','grade','itemno'])el(key).value=row[key]||'';
    el('temptype').value=row.storage==='냉장'?'냉장':'냉동';
    el('ingredients').value=(row.meattype||inferLabelMeatType(row.name,''))+' 100%';
    el('product-meta').textContent=[row.productCode,row.brand&&'브랜드 '+row.brand,row.packunit&&'포장 '+row.packunit].filter(Boolean).join(' · ')||'등록 품목';
    setExpiry();updatePreview();
  }
  function setExpiry(){
    const date=value('mfgdate');if(!date)return;
    const row=selectedProduct(),d=new Date(date+'T12:00:00');if(!Number.isFinite(d.getTime()))return;
    const days=Number(row?.shelfdays)||getDefaultShelfDays(row?.kind||'제품',value('temptype'));
    d.setDate(d.getDate()+days-1);el('expdate').value=localDateString(d);
  }
  function collect(){
    const row=selectedProduct();
    if(!row||value('product')!==String(row.name||''))return null;
    const data=Object.fromEntries(fields.map(key=>[key,value(key)]));
    return {...data,product:row.name,mfgdate:fmtLblDate(data.mfgdate),expdate:fmtLblDate(data.expdate),
      weight:DBMTLabelWeight.valid(data.weight)?Number(data.weight).toFixed(2):'',lotText:data.lot,
      productBarcode:state.barcode,crossFacilityNotice:labelCrossFacilityNoticeFromText(row.name,data.ingredients)};
  }
  function documentHtml(data,sizeKey){
    return DBMTLabelPrint.createDocument({labelsHtml:`<div class="lbl-label">${buildLabelBody(data)}</div>`,sizeKey,autoPrint:false});
  }
  function updatePreview(){
    clearTimeout(state.timer);
    if(!state.initialized||!permitted())return;
    const data=collect(),frame=el('preview-frame'),sizeKey=value('size')||'7x10';
    el('preview-size-text').textContent=`(${sizeKey==='10x10'?'10×10':'7×10'}cm · 임의 바코드)`;
    if(!data){
      state.previewKey='';
      el('preview-empty').hidden=false;frame.hidden=true;
      el('preview-empty').textContent=value('product-id')?'선택한 품목을 사용할 수 없습니다. 등록 품목을 다시 선택하세요.':'제품을 선택하면 라벨이 표시됩니다.';
      return;
    }
    el('preview-empty').hidden=true;frame.hidden=false;
    const width=(sizeKey==='10x10'?100:70)*96/25.4,height=100*96/25.4;
    const scale=Math.min(1.75,Math.max(0.4,(el('preview-stage').clientWidth-24)/width));
    const key=JSON.stringify([data,sizeKey,scale]);if(key===state.previewKey)return;state.previewKey=key;
    frame.style.width=Math.ceil(width*scale)+'px';frame.style.height=Math.ceil(height*scale)+'px';
    const screen=`<style>@media screen{html,body{width:${width}px!important;height:${height}px!important;padding:0!important;margin:0!important;background:#fff!important;overflow:hidden!important}body{zoom:${scale}}.print-tools{display:none!important}.lbl-label{margin:0 0 0 2mm!important}#label-print-pages{padding:0!important;margin:0!important}}</style>`;
    frame.srcdoc=documentHtml(data,sizeKey).replace('</head>',screen+'</head>');
  }
  function print(){
    if(!permitted('create')){toast('라벨을 출력할 권한이 없습니다.');return;}
    const data=collect();
    if(!data){alert('품목관리에 등록된 제품을 선택해주세요.');return;}
    if(!DBMTLabelWeight.valid(value('weight'))){alert('중량을 0보다 큰 값으로 소수 둘째 자리까지 입력해주세요.');el('weight').focus();return;}
    if(!el('mfgdate').checkValidity()||!value('mfgdate')||!el('expdate').checkValidity()||!value('expdate')||value('expdate')<value('mfgdate')){alert('제조일과 소비기한을 확인해주세요.');return;}
    const copies=Number(value('print-count'));
    if(!Number.isInteger(copies)||copies<1||copies>500){alert('출력 매수는 1~500장으로 입력해주세요.');el('print-count').focus();return;}
    printLabelData(data,value('size')||'7x10',copies);
  }
  document.getElementById('manual-label-form').addEventListener('input',()=>{clearTimeout(state.timer);state.timer=setTimeout(updatePreview,80);});
  document.getElementById('manual-label-form').addEventListener('change',event=>{
    if(event.target===el('mfgdate'))setExpiry();
    if(event.target===el('size'))localStorage.setItem('dbmt_label_size',value('size'));
    updatePreview();
  });
  let resizeTimer;global.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(document.getElementById('p-label').classList.contains('active'))updatePreview();},100);});
  global.DBMTManualLabel={init,reset,openPicker,pickerKey,selectProduct,updatePreview,print,applyPermissions};
})(window);
