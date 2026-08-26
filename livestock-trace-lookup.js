(function(){
  'use strict';

  const originalLookup = window.lookupImportedMeatExpiry;
  const originalUpdate = window.updateMeatwatchLookupState;
  const originalClear = window.clearMeatwatchLookupResult;
  const originalRestore = window.restoreMeatwatchLookupFromTransaction;
  const DOMESTIC_FIELDS = [
    't-livestock-species','t-livestock-trace-type','t-livestock-slaughter-date',
    't-livestock-slaughter-end-date','t-livestock-slaughter-houses','t-livestock-grades',
    't-livestock-inspection-results','t-livestock-process-date','t-livestock-process-end-date',
    't-livestock-process-companies','t-livestock-queried-at'
  ];
  const BULK_DOMESTIC_FIELDS = [
    'bulk-in-livestock-species','bulk-in-livestock-trace-type','bulk-in-livestock-slaughter-date',
    'bulk-in-livestock-slaughter-end-date','bulk-in-livestock-slaughter-houses','bulk-in-livestock-grades',
    'bulk-in-livestock-inspection-results','bulk-in-livestock-process-date','bulk-in-livestock-process-end-date',
    'bulk-in-livestock-process-companies','bulk-in-livestock-queried-at'
  ];

  function byId(id){ return document.getElementById(id); }

  function selectedProduct(){
    const id = byId('t-label-product-id')?.value || '';
    return (typeof labelProducts !== 'undefined' ? labelProducts : [])
      .find(row=>String(row?.id || '') === String(id)) || null;
  }

  function normalizedOrigin(value){
    return typeof normalizeOriginName === 'function'
      ? normalizeOriginName(value)
      : String(value || '').trim();
  }

  function domesticContext(){
    const product = selectedProduct();
    const origin = normalizedOrigin(byId('t-origin-managed')?.value || product?.origin || '');
    const meatType = String(product?.meattype || '').trim();
    const species = meatType === '소고기' ? 'cattle' : meatType === '돼지고기' ? 'pig' : '';
    return {
      product,
      origin,
      species,
      applicable:Boolean(product && origin === '국내산' && species)
    };
  }

  function permitted(){
    return typeof DBMTAuth === 'object' && DBMTAuth.isPersonal() &&
      (DBMTAuth.canAction('transactions','create') || DBMTAuth.canAction('transactions','update'));
  }

  function setStatus(message, kind='normal'){
    const el=byId('t-meatwatch-status');
    if(!el) return;
    el.textContent=message || '';
    el.style.display=message ? 'block' : 'none';
    el.style.color=kind==='success' ? '#16794c' : kind==='error' ? '#c0392b' : '#666';
  }

  function setValues(values){
    Object.entries(values).forEach(([id,value])=>{
      const el=byId(id);
      if(el) el.value=Array.isArray(value) ? value.join(' / ') : String(value || '');
    });
  }

  function dateRange(start, end){
    if(!start) return '';
    return end && end!==start ? `${start}~${end}` : start;
  }

  function removeGeneratedTraceDateNote(existing){
    return String(existing || '').trim()
      .replace(/(^|\s*\/\s*)(?:도축일|포장일)\s*[:：]\s*\d{4}[-./]\d{2}[-./]\d{2}/g, '')
      .replace(/^\s*\/\s*|\s*\/\s*$/g, '')
      .replace(/\s*\/\s*\/\s*/g, ' / ')
      .trim();
  }

  function traceDateNote(existing, label, date){
    const text=removeGeneratedTraceDateNote(existing);
    const next=`${label}: ${date}`;
    return text ? `${text} / ${next}` : next;
  }

  function domesticSummary(row, prefix=''){
    const parts=[];
    const animal=row.animalType || (row.species==='cattle' ? '소' : row.species==='pig' ? '돼지' : '');
    if(animal) parts.push(`${row.isBundle ? '묶음번호' : '이력번호'} · 국내산 ${animal}`);
    const slaughter=dateRange(row.slaughterDate,row.slaughterEndDate);
    if(slaughter) parts.push(`도축 ${slaughter}`);
    if(row.slaughterHouses?.length) parts.push(`도축장 ${row.slaughterHouses.join(', ')}`);
    if(row.grades?.length) parts.push(`등급 ${row.grades.join(', ')}`);
    if(row.inspectionResults?.length) parts.push(`검사 ${row.inspectionResults.join(', ')}`);
    const process=dateRange(row.processDate,row.processEndDate);
    if(process) parts.push(`포장 ${process}`);
    if(row.processCompanies?.length) parts.push(`포장처 ${row.processCompanies.join(', ')}`);
    return `${prefix}${parts.join(' · ')}`;
  }

  function bulkDomesticContext(baseContext){
    const product=baseContext?.product || null;
    const origin=normalizedOrigin(product?.origin || '');
    const meatType=String(product?.meattype || '').trim();
    const species=meatType==='소고기' ? 'cattle' : meatType==='돼지고기' ? 'pig' : '';
    return {
      ...(baseContext || {}),
      product,
      origin,
      species,
      isDomestic:origin==='국내산',
      applicable:Boolean(product && origin==='국내산' && species)
    };
  }

  function setBulkDomesticStatus(row, message, kind='normal'){
    const el=row?.querySelector('.bulk-in-meatwatch-status');
    if(!el) return;
    el.textContent=message || '';
    el.style.display=message ? 'block' : 'none';
    el.style.color=kind==='success' ? '#16794c' : kind==='error' ? '#c0392b' : '#666';
  }

  function setBulkDomesticValues(row, values){
    Object.entries(values).forEach(([className,value])=>{
      const el=row?.querySelector(`.${className}`);
      if(el) el.value=Array.isArray(value) ? value.join(' / ') : String(value || '');
    });
  }

  function clearBulkDomesticResult(row, options={}){
    if(!row) return;
    const hasGeneratedDate=Boolean(
      row.querySelector('.bulk-in-livestock-slaughter-date')?.value ||
      row.querySelector('.bulk-in-livestock-process-date')?.value
    );
    if(options?.removeNote && hasGeneratedDate){
      const noteEl=row.querySelector('.bulk-in-note');
      if(noteEl) noteEl.value=removeGeneratedTraceDateNote(noteEl.value);
    }
    BULK_DOMESTIC_FIELDS.forEach(className=>{
      const el=row.querySelector(`.${className}`);
      if(el) el.value='';
    });
  }

  async function lookupBulkDomesticTrace(context, sessionToken){
    const row=context?.row;
    const traceNo=String(context?.traceNo || '').trim();
    if(!row || !context?.applicable || !traceNo) throw new Error('국내산 품목 또는 이력번호를 확인하세요.');
    setBulkDomesticStatus(row,'축산물이력제에서 도축·포장 정보를 조회하고 있습니다.');
    const result=await sbFunctionRequest('livestock-trace-lookup',{
      sessionToken,
      traceNo,
      speciesHint:context.species,
      permissionAction:'create'
    });
    setBulkDomesticValues(row,{
      'bulk-in-livestock-species':result.species,
      'bulk-in-livestock-trace-type':result.traceType || (result.isBundle ? `${String(result.species || '').toUpperCase()}/LOT_NO` : ''),
      'bulk-in-livestock-slaughter-date':result.slaughterDate,
      'bulk-in-livestock-slaughter-end-date':result.slaughterEndDate,
      'bulk-in-livestock-slaughter-houses':result.slaughterHouses,
      'bulk-in-livestock-grades':result.grades,
      'bulk-in-livestock-inspection-results':result.inspectionResults,
      'bulk-in-livestock-process-date':result.processDate,
      'bulk-in-livestock-process-end-date':result.processEndDate,
      'bulk-in-livestock-process-companies':result.processCompanies,
      'bulk-in-livestock-queried-at':result.queriedAt
    });
    const productKind=String(context.product?.kind || '원료육').trim()==='제품' ? '제품' : '원료육';
    const noteLabel=productKind==='제품' ? '포장일' : '도축일';
    const noteDate=productKind==='제품' ? result.processDate : result.slaughterDate;
    const noteEl=row.querySelector('.bulk-in-note');
    if(noteEl && noteDate) noteEl.value=traceDateNote(noteEl.value,noteLabel,noteDate);
    setBulkDomesticStatus(row,domesticSummary(result),'success');
  }

  function updateTransactionTraceLookupState(){
    const statusEl=byId('t-meatwatch-status');
    const previousStatus=statusEl ? {
      textContent:statusEl.textContent,
      display:statusEl.style.display,
      color:statusEl.style.color
    } : null;
    if(typeof originalUpdate==='function') originalUpdate();
    const button=byId('t-meatwatch-lookup-btn');
    if(!button) return;
    const context=domesticContext();
    const applicable=permitted() && byId('t-type')?.value==='입고' && context.applicable;
    if(!applicable){
      button.textContent='가공일 조회';
      return;
    }
    const traceNo=String(byId('t-lot')?.value || '').trim();
    button.style.display='';
    button.textContent='이력 조회';
    button.disabled=!traceNo;
    button.title=traceNo
      ? '축산물이력제에서 국내산 소·돼지 도축·포장 정보를 조회합니다.'
      : '이력번호 또는 묶음번호를 입력하세요.';
    if(statusEl && previousStatus?.textContent){
      statusEl.textContent=previousStatus.textContent;
      statusEl.style.display=previousStatus.display || 'block';
      statusEl.style.color=previousStatus.color || '#666';
    }
  }

  function clearTransactionTraceLookupResult(options={}){
    if(options?.removeNote){
      const noteEl=byId('t-note');
      const hasGeneratedDate=Boolean(
        byId('t-livestock-slaughter-date')?.value || byId('t-livestock-process-date')?.value
      );
      if(noteEl && hasGeneratedDate) noteEl.value=removeGeneratedTraceDateNote(noteEl.value);
    }
    if(typeof originalClear==='function') originalClear(options);
    DOMESTIC_FIELDS.forEach(id=>{ const el=byId(id); if(el) el.value=''; });
  }

  function restoreTransactionTraceLookup(transaction){
    if(typeof originalRestore==='function') originalRestore(transaction);
    const row=transaction || {};
    const values={
      't-livestock-species':row.livestockSpecies || '',
      't-livestock-trace-type':row.livestockTraceType || '',
      't-livestock-slaughter-date':row.livestockSlaughterDate || '',
      't-livestock-slaughter-end-date':row.livestockSlaughterEndDate || '',
      't-livestock-slaughter-houses':row.livestockSlaughterHouses || '',
      't-livestock-grades':row.livestockGrades || '',
      't-livestock-inspection-results':row.livestockInspectionResults || '',
      't-livestock-process-date':row.livestockProcessDate || '',
      't-livestock-process-end-date':row.livestockProcessEndDate || '',
      't-livestock-process-companies':row.livestockProcessCompanies || '',
      't-livestock-queried-at':row.livestockQueriedAt || ''
    };
    setValues(values);
    if(values['t-livestock-queried-at']){
      setStatus(domesticSummary({
        species:values['t-livestock-species'],
        animalType:values['t-livestock-species']==='cattle' ? '소' : '돼지',
        isBundle:/LOT_NO/i.test(values['t-livestock-trace-type']),
        slaughterDate:values['t-livestock-slaughter-date'],
        slaughterEndDate:values['t-livestock-slaughter-end-date'],
        slaughterHouses:String(values['t-livestock-slaughter-houses']).split(' / ').filter(Boolean),
        grades:String(values['t-livestock-grades']).split(' / ').filter(Boolean),
        inspectionResults:String(values['t-livestock-inspection-results']).split(' / ').filter(Boolean),
        processDate:values['t-livestock-process-date'],
        processEndDate:values['t-livestock-process-end-date'],
        processCompanies:String(values['t-livestock-process-companies']).split(' / ').filter(Boolean)
      }, '조회 기록: '), 'success');
    }
    updateTransactionTraceLookupState();
  }

  async function lookupDomesticLivestockTrace(){
    const isEdit=typeof _editTxnId!=='undefined' && Boolean(_editTxnId);
    const permissionAction=isEdit ? 'update' : 'create';
    if(typeof DBMTAuth!=='object' || !DBMTAuth.requireAction('transactions',permissionAction)) return;
    const context=domesticContext();
    const traceNo=String(byId('t-lot')?.value || '').trim();
    if(byId('t-type')?.value!=='입고' || !context.applicable){
      setStatus('국내산 소고기·돼지고기 입고 품목에서만 조회할 수 있습니다.','error');
      return;
    }
    if(!traceNo){ setStatus('이력번호 또는 묶음번호를 입력하세요.','error'); return; }
    const sessionToken=DBMTAuth.getSessionToken();
    if(!sessionToken){ setStatus('개인 사용자 로그인이 필요합니다.','error'); return; }

    const button=byId('t-meatwatch-lookup-btn');
    if(button){ button.disabled=true; button.textContent='조회 중…'; }
    setStatus('축산물이력제에서 도축·포장 정보를 조회하고 있습니다.');
    try{
      const result=await sbFunctionRequest('livestock-trace-lookup',{
        sessionToken,
        traceNo,
        speciesHint:context.species,
        permissionAction
      });
      setValues({
        't-livestock-species':result.species,
        't-livestock-trace-type':result.traceType || (result.isBundle ? `${String(result.species || '').toUpperCase()}/LOT_NO` : ''),
        't-livestock-slaughter-date':result.slaughterDate,
        't-livestock-slaughter-end-date':result.slaughterEndDate,
        't-livestock-slaughter-houses':result.slaughterHouses,
        't-livestock-grades':result.grades,
        't-livestock-inspection-results':result.inspectionResults,
        't-livestock-process-date':result.processDate,
        't-livestock-process-end-date':result.processEndDate,
        't-livestock-process-companies':result.processCompanies,
        't-livestock-queried-at':result.queriedAt
      });
      const productKind=String(context.product?.kind || '원료육').trim()==='제품' ? '제품' : '원료육';
      const noteLabel=productKind==='제품' ? '포장일' : '도축일';
      const noteDate=productKind==='제품' ? result.processDate : result.slaughterDate;
      const noteEl=byId('t-note');
      if(noteEl && noteDate) noteEl.value=traceDateNote(noteEl.value,noteLabel,noteDate);
      setStatus(domesticSummary(result),'success');
      if(typeof toast==='function'){
        toast(noteDate
          ? `${noteLabel}을 비고에 입력했습니다.`
          : `조회정보에 ${noteLabel}이 없어 비고는 변경하지 않았습니다.`);
      }
    }catch(error){
      setStatus(`조회 실패: ${String(error?.message || error)}`,'error');
    }finally{
      updateTransactionTraceLookupState();
    }
  }

  async function lookupTransactionTrace(){
    if(domesticContext().applicable) return lookupDomesticLivestockTrace();
    if(typeof originalLookup==='function') return originalLookup();
  }

  window.lookupImportedMeatExpiry=lookupTransactionTrace;
  window.updateMeatwatchLookupState=updateTransactionTraceLookupState;
  window.clearMeatwatchLookupResult=clearTransactionTraceLookupResult;
  window.restoreMeatwatchLookupFromTransaction=restoreTransactionTraceLookup;
  window.lookupDomesticLivestockTrace=lookupDomesticLivestockTrace;
  window.DBMTLivestockBulkLookup={
    context:bulkDomesticContext,
    lookup:lookupBulkDomesticTrace,
    clear:clearBulkDomesticResult
  };
  document.addEventListener('DOMContentLoaded',updateTransactionTraceLookupState);
})();
