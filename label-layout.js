/* Shared label artwork for ERP previews, standalone printing and reprints. */
(function(global){
  'use strict';
  const styles = `
    .dbmt-inner-label { flex:1; min-height:0; display:flex; flex-direction:column; }
    .dbmt-inner-label,.dbmt-inner-label * { box-sizing:border-box; margin:0; padding:0; }
    .dbmt-label-body { flex:1; min-height:0; height:100%; display:flex; flex-direction:column; font-family:"Malgun Gothic","맑은 고딕",Arial,sans-serif; font-size:6.5pt; font-weight:700; line-height:1.13; color:#000; background:#fff; }
    .dbmt-label-body,.dbmt-label-body * { box-sizing:border-box; margin:0; padding:0; }
    .dbmt-label-body .dl-row { flex-shrink:0; border-bottom:0.3mm solid #000; padding:0.4mm 0.5mm; }
    .dbmt-label-body .dl-key { flex-shrink:0; font-size:6pt; font-weight:900; }
    .dbmt-label-body .dl-top-code { height:8.5mm; display:flex; align-items:center; gap:1mm; }
    .dbmt-label-body .dl-code-caption { flex-shrink:0; font-size:6pt; font-weight:900; }
    .dbmt-label-body .dl-code-body { flex:1; min-width:0; text-align:center; }
    .dbmt-label-body .dl-code-body img { display:block; width:100%; height:5.2mm; object-fit:fill; }
    .dbmt-label-body .dl-code-number { font-family:Arial,sans-serif; font-size:7pt; line-height:1; padding-top:0.25mm; overflow-wrap:anywhere; }
    .dbmt-label-body .dl-unissued { font-size:6.5pt; }
    .dbmt-label-body .dl-split-body { display:grid; grid-template-columns:minmax(0,1fr) 8mm; flex-shrink:0; }
    .dbmt-label-body .dl-main-fields { min-width:0; }
    .dbmt-label-body .dl-product-row { height:6.4mm; display:flex; align-items:center; gap:1mm; }
    .dbmt-label-body .dl-product-name { min-width:0; font-size:13pt; font-weight:900; line-height:1.05; overflow-wrap:anywhere; }
    .dbmt-label-body .dl-grade-row { height:4.5mm; display:grid; grid-template-columns:1fr 1fr; padding:0; }
    .dbmt-label-body .dl-grade-cell { display:flex; align-items:center; gap:0.7mm; padding:0.4mm 0.5mm; min-width:0; }
    .dbmt-label-body .dl-grade-cell:first-child { border-right:0.3mm solid #000; }
    .dbmt-label-body .dl-grade-value { flex:1; min-width:0; text-align:center; font-size:8pt; }
    .dbmt-label-body .dl-origin-value { flex:1; min-width:0; text-align:center; font-size:10pt; }
    .dbmt-label-body .dl-date-row { height:4.8mm; display:flex; align-items:center; gap:0.6mm; }
    .dbmt-label-body .dl-date-value { flex:0 1 auto; min-width:0; font-size:7.5pt; font-weight:900; text-align:left; white-space:nowrap; }
    .dbmt-label-body .dl-weight-row { height:8.3mm; display:grid; grid-template-columns:1fr 1fr; padding:0; }
    .dbmt-label-body .dl-weight-cell { border-right:0.3mm solid #000; display:flex; align-items:center; gap:0.8mm; padding:0.4mm 0.5mm; min-width:0; }
    .dbmt-label-body .dl-weight-value { flex:1; min-width:0; display:flex; align-items:baseline; justify-content:center; gap:0.7mm; white-space:nowrap; }
    .dbmt-label-body .dl-weight-value strong { font-size:17.5pt; font-weight:900; line-height:1; }
    .dbmt-label-body .dl-weight-value span { font-size:8pt; }
    .dbmt-label-body .dl-report-cell { display:flex; flex-direction:column; justify-content:center; gap:0.8mm; min-width:0; padding:0.4mm 0.5mm; }
    .dbmt-label-body .dl-report-value { font-family:Arial,sans-serif; font-size:8.4pt; text-align:center; overflow-wrap:anywhere; }
    .dbmt-label-body .dl-trace-code { height:8.2mm; display:flex; align-items:center; gap:0.6mm; }
    .dbmt-label-body .dl-trace-code .dl-code-body img { height:4.7mm; }
    .dbmt-label-body .dl-ingredients-row { min-height:4.8mm; display:flex; align-items:center; gap:1.5mm; }
    .dbmt-label-body .dl-ingredients-value { min-width:0; font-size:8pt; line-height:1.15; overflow-wrap:anywhere; }
    .dbmt-label-body .dl-ingredients-long { display:block; }
    .dbmt-label-body .dl-ingredients-long .dl-key { margin-right:1.5mm; }
    .dbmt-label-body .dl-ingredients-long .dl-ingredients-value { font-size:7pt; }
    .dbmt-label-body .dl-ingredients-extra .dl-ingredients-value { font-size:6.5pt; }
    .dbmt-label-body .dl-ingredients-separated { display:block; }
    .dbmt-label-body .dl-ingredients-main { display:flex; align-items:center; gap:1mm; }
    .dbmt-label-body .dl-ingredients-separated .dl-key { margin-right:0; }
    .dbmt-label-body .dl-ingredients-separated .dl-ingredients-value { font-size:8pt; }
    .dbmt-label-body .dl-ingredients-details { margin-top:0.25mm; font-size:6.3pt; line-height:1.15; overflow-wrap:anywhere; }
    .dbmt-label-body .dl-meat { display:inline-block; background:#000; color:#fff; padding:0.2mm 0.5mm; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    .dbmt-label-body .dl-storage-row { height:5.8mm; display:flex; align-items:center; }
    .dbmt-label-body .dl-storage-copy { flex:1; min-width:0; font-size:6pt; line-height:1.18; }
    .dbmt-label-body .dl-storage-note { margin-top:0.25mm; font-size:5.2pt; line-height:1.1; }
    .dbmt-label-body .dl-temperature { flex-shrink:0; font-size:13pt; font-weight:900; line-height:1; border:0.5mm solid #000; padding:0.35mm 1mm; white-space:nowrap; }
    .dbmt-label-body .dl-side-strip { display:flex; justify-content:center; align-items:center; position:relative; min-width:0; border-left:0.3mm solid #000; border-bottom:0.3mm solid #000; }
    .dbmt-label-body .dl-side-code { width:44mm; flex-shrink:0; transform:rotate(-90deg); }
    .dbmt-label-body .dl-side-code img { display:block; width:100%; height:4.6mm; object-fit:fill; }
    .dbmt-label-body .dl-footer { flex:1; min-height:0; display:flex; flex-direction:column; gap:0.6mm; padding:0.6mm 0.5mm 0; }
    .dbmt-label-body .dl-notices { flex:1; min-height:0; display:flex; flex-direction:column; justify-content:space-between; gap:0.2mm; font-size:6.5pt; line-height:1.15; overflow-wrap:break-word; }
    .dbmt-label-body.dl-long-ingredients .dl-notices { font-size:6pt; line-height:1.08; gap:0.1mm; }
    .dbmt-label-body .dl-notice-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:1mm; }
    .dbmt-label-body .dl-notice-short { flex:1; min-width:0; display:flex; flex-direction:column; gap:0.2mm; }
    .dbmt-label-body .dl-manufacturer { flex-shrink:0; display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; min-height:14mm; gap:0.3mm; }
    .dbmt-label-body .dl-company { min-width:0; display:flex; flex-direction:column; gap:0.35mm; }
    .dbmt-label-body .dl-company-role { font-size:6.5pt; line-height:1.1; }
    .dbmt-label-body .dl-company-name { font-size:11pt; font-weight:900; line-height:1.08; white-space:nowrap; }
    .dbmt-label-body .dl-company-phone { font-size:7pt; line-height:1.1; }
    .dbmt-label-body .dl-company-address { grid-column:1 / -1; font-size:6.2pt; line-height:1.17; white-space:nowrap; }
    .dbmt-label-body .dl-marks { display:flex; align-items:center; gap:0.6mm; }
    .dbmt-label-body .dl-mark { display:block; width:10.4mm; height:11.6mm; object-fit:contain; }
    .dbmt-label-body .dl-haccp { width:11.6mm; filter:grayscale(1) brightness(0.6) contrast(20); }
    #lbl-preview,#wo-preview { display:flex; flex-direction:column; box-sizing:border-box; padding:0.55mm 0.7mm 0.8mm; border:2px solid #000; font-family:"Malgun Gothic","맑은 고딕",Arial,sans-serif; background:#fff; color:#000; }
  `;
  const escape = value => String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const textUnits=value=>Array.from(String(value||'')).reduce((sum,ch)=>sum+(ch.charCodeAt(0)>255?1:0.55),0);
  const originFont=(value,max=10,capacity=5.5)=>Math.max(6,Math.min(max,max*capacity/Math.max(capacity,textUnits(value))));
  function ingredientParts(value){
    const text=String(value||'').trim();
    const match=/^((?:소고기|돼지고기|가금류|닭고기|양고기|오리고기|기타 축종)\s*100\s*%)\s*(\([\s\S]*\))$/.exec(text);
    return match?{base:match[1],details:match[2]}:{base:text,details:''};
  }
  const asset=file=>escape(new URL(file,global.document.baseURI).href);
  // Reversible numeric encoding keeps existing identities while reducing Code 128 modules.
  function encodePrintCode(value){
    const code=String(value||''),match=/^DB(\d{10})-([0-9A-Z]{1,6})$/.exec(code);
    if(!match) return code;
    const number=parseInt(match[2],36);
    if(number.toString(36).toUpperCase()!==match[2]) return code;
    return '98'+match[1]+number.toString().padStart(10,'0');
  }
  function decodePrintCode(value){
    const code=String(value||''),match=/^98(\d{10})(\d{10})$/.exec(code);
    if(!match||Number(match[2])>=36**6) return code;
    return 'DB'+match[1]+'-'+Number(match[2]).toString(36).toUpperCase();
  }
  const images = new Map();
  function barcodeImage(value){
    value=String(value||'');
    if(!value) return '';
    if(!/^[\x20-\x7e]+$/.test(value)) return '';
    if(images.has(value)) return images.get(value);
    if(typeof global.JsBarcode!=='function') throw new Error('바코드 생성 도구를 불러오지 못했습니다. 화면을 새로고침해주세요.');
    const svg=global.document.createElementNS('http://www.w3.org/2000/svg','svg');
    global.JsBarcode(svg,value,{format:'CODE128',width:1,height:20,displayValue:false,margin:0,marginLeft:10,marginRight:10});
    svg.setAttribute('viewBox',`0 0 ${parseFloat(svg.getAttribute('width'))} ${parseFloat(svg.getAttribute('height'))}`);
    svg.setAttribute('preserveAspectRatio','none');
    svg.setAttribute('shape-rendering','crispEdges');
    const src='data:image/svg+xml;base64,'+global.btoa(new global.XMLSerializer().serializeToString(svg));
    if(images.size>=1000) images.clear();
    images.set(value,src);
    return src;
  }
  function codeImage(src,value,kind,alt){
    return src?`<img src="${src}" data-barcode-kind="${kind}" data-barcode-value="${escape(value)}" alt="${alt}">`:'';
  }
  // Inner packaging retains the original full-width, text-only label artwork.
  function buildInnerBody(d){
    const bb='border-bottom:1pt solid #000;',br='border-right:1pt solid #000;';
    const pad='padding:1.8pt 2.2pt;',sh='flex-shrink:0;';
    const name=String(d.manufacturer||'주식회사 동부엠티').replace(/주식회사\s*동부엠티/g,'주식회사 동부엠티');
    const chilled=d.temptype==='냉장';
    const badgeStyle='display:inline-block;background:#000;color:#fff;padding:0.7pt 2.2pt;margin-right:2pt;line-height:1.1;-webkit-print-color-adjust:exact;print-color-adjust:exact;box-shadow:inset 0 0 0 9999px #000;';
    const parts=ingredientParts(d.ingredients);
    const ingredients=escape(parts.base).replace(/(돼지고기|소고기)\s*/g,`<span style="${badgeStyle}">$1</span> `);
    return `<div class="dbmt-inner-label">
      <div class="il-product" style="${bb+pad+sh}min-height:22pt;display:flex;align-items:center;">
        <span style="font-size:6pt;font-weight:900;margin-right:5pt;">제품명: </span><strong style="font-size:${(d.product||'').length>8?'11':'13'}pt;">${escape(d.product||'　')}</strong></div>
      <div style="display:flex;${bb+sh}min-height:17pt;">
        <div style="flex:11;${pad+br}font-size:6pt;display:flex;align-items:center;"><span style="font-weight:900;flex-shrink:0;">성별및등급:</span><span style="flex:1;text-align:center;font-size:9.1pt;">${escape(d.grade)}</span></div>
        <div style="flex:9;min-width:0;${pad}font-size:6pt;display:flex;align-items:center;"><span style="font-weight:900;flex-shrink:0;">원산지:</span> <strong style="font-size:${originFont(d.origin,10.4,4.5)}pt;margin-left:3pt;white-space:nowrap;">${escape(d.origin)}</strong></div></div>
      <div class="il-date" style="${bb+pad+sh}min-height:17pt;display:flex;align-items:center;gap:2pt;">
        <span style="font-size:6pt;font-weight:900;flex-shrink:0;white-space:nowrap;">제조 및 소비기한: </span><strong style="flex:0 1 auto;min-width:0;text-align:left;font-size:8.5pt;white-space:nowrap;">${escape(d.mfgdate)} ～ ${escape(d.expdate)}</strong></div>
      <div style="display:flex;align-items:stretch;${bb+sh}min-height:30pt;">
        <div style="flex:11;${pad+br}display:flex;align-items:baseline;"><span style="font-size:6pt;font-weight:900;margin-right:3pt;">중량:</span>
          <div class="il-weight" style="flex:1;display:flex;align-items:baseline;justify-content:center;padding-left:5pt;">${d.weightOmitted?'':`<span style="font-size:19.5pt;font-weight:900;line-height:1.05;">${escape(d.weight||'0.00')}</span><span style="font-size:9.2pt;font-weight:700;margin-left:3pt;">Kg</span>`}</div></div>
        <div style="flex:9;${pad}font-size:6pt;"><div style="font-weight:900;">품목보고번호</div><div style="font-size:9.1pt;font-weight:700;margin-top:5pt;text-align:center;">${escape(d.itemno)}</div></div></div>
      <div class="il-trace" style="${bb+pad+sh}min-height:15pt;display:flex;align-items:center;gap:4pt;">
        <span style="font-size:6pt;font-weight:900;flex-shrink:0;">이력번호</span><strong style="font-size:9.1pt;line-height:1.1;word-break:break-all;">${escape(d.lot??d.lotText??'')}</strong></div>
      <div class="il-ingredients" style="${bb+pad+sh}font-size:6pt;min-height:15pt;display:block;">
        <div class="il-ingredients-main" style="display:flex;align-items:center;gap:5pt;"><span style="font-weight:900;flex-shrink:0;">원료 및 함량:</span><strong style="min-width:0;overflow-wrap:anywhere;font-size:${parts.details?8:textUnits(d.ingredients)>40?6.5:textUnits(d.ingredients)>18?7:8}pt;">${ingredients}</strong></div>${parts.details?`<div class="il-ingredients-details" style="margin-top:0.7pt;font-size:6.3pt;line-height:1.15;overflow-wrap:anywhere;">${escape(parts.details)}</div>`:''}</div>
      <div style="${bb+pad+sh}min-height:22pt;"><div style="font-size:6pt;"><span style="font-weight:900;">보관방법:</span> &nbsp; ${chilled?'-2℃ ~ 5℃이하 냉장보관':'-18℃이하 냉동보관'}</div>${chilled?'':'<div class="il-storage-note" style="font-size:5.2pt;line-height:1.1;text-align:center;">이미 냉동된바 있으니 해동후 재냉동 시키지 마십시오</div>'}</div>
      <div class="il-footer" style="padding:2pt 2pt 0;font-size:6.5pt;flex:1 1 0;min-height:0;overflow:hidden;display:flex;flex-direction:column;justify-content:space-between;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div class="il-notices" style="flex:1;line-height:${textUnits(d.ingredients)>40?1.1:textUnits(d.ingredients)>18?1.2:1.42};display:flex;flex-direction:column;gap:${textUnits(d.ingredients)>18?0.25:0.5}pt;padding-right:2pt;">
            <div>· 허가번호: ${escape(d.licenseno)}</div><div>· 식품의유형: ${escape(d.prodtype)}</div><div>· 포장재질: ${escape(d.packaging)}</div>
            <div>· 반품및교환: 제조원및판매원 하단 표시</div><div>· 부정,불량 축산물 신고는 국번없이 1399</div>
            <div>· 이 제품은 공정거래위원회 고시 소비자 분쟁해결기준에 의거 교환 또는 보상받을 수 있습니다</div>
            <div>· 동봉되는 흡습제는 먹어서는 아니됩니다</div><div>· ${escape(d.crossNotice||d.crossFacilityNotice||'')}</div></div>
          <div class="il-marks" style="display:flex;flex-direction:column;align-items:center;margin-left:2pt;flex-shrink:0;">
            <div style="font-size:13pt;font-weight:900;border:1.5pt solid #000;padding:1pt 3pt;">${escape(d.temptype||'냉동')}</div>
            <div style="margin-top:20pt;text-align:center;"><img src="${asset('assets/other-recycle.svg')}" alt="OTHER 재활용 표시" style="height:33pt;width:auto;display:block;margin:0 auto 1pt;"><img src="${asset('HACCP2.png')}" alt="HACCP" style="height:33pt;width:33pt;object-fit:contain;display:block;"></div></div></div>
        <div class="il-manufacturer" style="display:flex;align-items:flex-start;margin-top:-18pt;padding-bottom:3pt;line-height:1.12;">
          <div style="max-width:100%;"><div style="display:flex;align-items:baseline;gap:8pt;margin-bottom:1pt;"><span style="font-size:6.5pt;">제조판매원</span><strong style="font-size:11pt;">${escape(name)}</strong></div>
            <div style="margin-top:1pt;font-size:6.2pt;">${escape(d.phone)}</div><div style="font-size:6.2pt;">${escape(d.address)}</div></div></div></div>
    </div>`;
  }
  function buildBody(d={}){
    if(d.innerLabel) return buildInnerBody(d);
    // An issued print-log code is the identity. Never derive one from product/LOT or mockup samples.
    const code=String(d.productBarcode||'');
    const lot=String(d.lot??d.lotText??'');
    const productImage=barcodeImage(code),traceImage=barcodeImage(lot);
    if(code&&!productImage) throw new Error('출력이력의 고유번호를 바코드로 변환할 수 없습니다. 고유번호를 확인해주세요.');
    const product=String(d.product||'');
    const productUnits=Array.from(product).reduce((sum,ch)=>sum+(ch.charCodeAt(0)>255?1:0.55),0);
    const productFont=Math.max(6,Math.min(13,13*9/Math.max(9,productUnits)));
    const weight=String(d.weight||'0.00'),weightFont=Math.min(17.5,17.5*5/Math.max(5,weight.length));
    const temperature=d.temptype||'냉동',chilled=temperature==='냉장';
    const name=String(d.manufacturer||'주식회사 동부엠티').replace(/주식회사\s*동부엠티/g,'주식회사 동부엠티');
    const parts=ingredientParts(d.ingredients);
    const ingredients=escape(parts.base).replace(/(돼지고기|소고기)\s*/g,'<span class="dl-meat">$1</span> ');
    const notice=d.crossNotice||d.crossFacilityNotice||'';
    return `<div class="dbmt-label-body${textUnits(d.ingredients)>18?' dl-long-ingredients':''}">
      <div class="dl-row dl-top-code"><div class="dl-code-body">${codeImage(productImage,code,'product','상단 제품 고유바코드')}<div class="dl-code-number${code?'':' dl-unissued'}">${escape(code)||'미발급'}</div></div></div>
      <div class="dl-split-body"><div class="dl-main-fields">
        <div class="dl-row dl-product-row"><span class="dl-key">제품명:</span><strong class="dl-product-name" style="font-size:${productFont}pt;">${escape(product)}</strong></div>
        <div class="dl-row dl-grade-row"><div class="dl-grade-cell"><span class="dl-key">성별및등급:</span><span class="dl-grade-value">${escape(d.grade)}</span></div><div class="dl-grade-cell"><span class="dl-key">원산지:</span><strong class="dl-origin-value" style="font-size:${originFont(d.origin)}pt;">${escape(d.origin)}</strong></div></div>
        <div class="dl-row dl-date-row"><span class="dl-key">제조 및 소비기한:</span><strong class="dl-date-value">${escape(d.mfgdate)} ~ ${escape(d.expdate)}</strong></div>
        <div class="dl-row dl-weight-row"><div class="dl-weight-cell"><span class="dl-key">중량:</span><div class="dl-weight-value">${d.weightOmitted?'':`<strong style="font-size:${weightFont}pt;">${escape(weight)}</strong><span>Kg</span>`}</div></div><div class="dl-report-cell"><span class="dl-key">품목보고번호</span><strong class="dl-report-value">${escape(d.itemno)}</strong></div></div>
        <div class="dl-row dl-trace-code"><span class="dl-code-caption">이력번호</span><div class="dl-code-body">${codeImage(traceImage,lot,'trace','이력번호 바코드')}<div class="dl-code-number">${escape(lot)}</div></div></div>
        <div class="dl-row dl-ingredients-row${textUnits(d.ingredients)>18?' dl-ingredients-long':''}${textUnits(d.ingredients)>40?' dl-ingredients-extra':''}${parts.details?' dl-ingredients-separated':''}">${parts.details?`<div class="dl-ingredients-main"><span class="dl-key">원료 및 함량:</span><strong class="dl-ingredients-value">${ingredients}</strong></div><div class="dl-ingredients-details">${escape(parts.details)}</div>`:`<span class="dl-key">원료 및 함량:</span><strong class="dl-ingredients-value">${ingredients}</strong>`}</div>
        <div class="dl-row dl-storage-row"><div class="dl-storage-copy"><div><strong>보관방법:</strong> ${chilled?'-2℃ ~ 5℃이하 냉장보관':'-18℃이하 냉동보관'}</div>${chilled?'':'<div class="dl-storage-note">이미 냉동된바 있으니 해동후 재냉동 시키지 마십시오</div>'}</div></div>
      </div><div class="dl-side-strip"><div class="dl-side-code">${codeImage(productImage,code,'product','우측 세로 제품 고유바코드')}</div></div></div>
      <div class="dl-footer"><div class="dl-notices"><div class="dl-notice-heading"><div class="dl-notice-short"><div>· 허가번호: ${escape(d.licenseno)}</div><div>· 식품의유형: ${escape(d.prodtype)}</div><div>· 포장재질: ${escape(d.packaging)}</div></div><strong class="dl-temperature">${escape(temperature)}</strong></div>
        <div>· 반품및교환: 제조원및판매원 하단 표시</div><div>· 부정,불량 축산물 신고는 국번없이 1399</div><div>· 이 제품은 공정거래위원회 고시 소비자 분쟁해결기준에 의거 교환 또는 보상받을 수 있습니다</div><div>· 동봉되는 흡습제는 먹어서는 아니됩니다</div><div class="dl-cross-notice">· ${escape(notice)}</div>
      </div><div class="dl-manufacturer"><div class="dl-company"><div class="dl-company-role">제조판매원</div><div class="dl-company-name">${escape(name)}</div><div class="dl-company-phone">${escape(d.phone)}</div></div><div class="dl-marks"><img class="dl-mark" src="${asset('assets/other-recycle.svg')}" alt="OTHER 재활용 표시"><img class="dl-mark dl-haccp" src="${asset('HACCP2.png')}" alt="HACCP"></div><div class="dl-company-address">${escape(d.address)}</div></div></div>
    </div>`;
  }
  const style=global.document.createElement('style');
  style.id='dbmt-label-layout-style';
  style.textContent=styles;
  global.document.head.appendChild(style);
  global.DBMTLabelLayout={styles,buildBody,encodePrintCode,decodePrintCode};
})(window);
