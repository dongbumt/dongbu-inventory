(function(){
  'use strict';

  const STATUS_COLORS = {
    normal:'#666', success:'#16794c', error:'#c0392b'
  };

  function byId(id){ return document.getElementById(id); }

  function setStatus(message, kind='normal'){
    const el = byId('t-meatwatch-status');
    if(!el) return;
    el.textContent = message || '';
    el.style.display = message ? 'block' : 'none';
    el.style.color = STATUS_COLORS[kind] || STATUS_COLORS.normal;
  }

  function selectedProduct(){
    const id = byId('t-label-product-id')?.value || '';
    return (typeof labelProducts !== 'undefined' ? labelProducts : [])
      .find(row=>String(row?.id || '') === String(id)) || null;
  }

  function isImportedOrigin(value){
    const normalized = typeof normalizeOriginName === 'function'
      ? normalizeOriginName(value)
      : String(value || '').trim();
    return Boolean(normalized) && normalized !== '국내산';
  }

  function validIsoDate(value){
    const text = String(value || '').trim();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
    const date = new Date(text + 'T00:00:00Z');
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10) === text ? text : '';
  }

  function calculateExpiryDate(processBeginDate, shelfDays){
    const start = validIsoDate(processBeginDate);
    const days = Number.parseInt(shelfDays, 10);
    if(!start || !Number.isInteger(days) || days < 1) return '';
    const date = new Date(start + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + days - 1);
    return date.toISOString().slice(0,10);
  }

  function expiryNote(existing, expiryDate){
    const text = String(existing || '').trim();
    const next = `소비기한: ${expiryDate}`;
    const pattern = /(^|\s*\/\s*)소비기한\s*[:：]\s*\d{4}[-./]\d{2}[-./]\d{2}/;
    if(pattern.test(text)) return text.replace(pattern, (_, prefix)=>`${prefix || ''}${next}`);
    return text ? `${text} / ${next}` : next;
  }

  function removeGeneratedExpiryNote(existing, expiryDate){
    const text = String(existing || '').trim();
    const date = validIsoDate(expiryDate);
    if(!text || !date) return text;
    const escaped = date.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text
      .replace(new RegExp(`(^|\\s*\\/\\s*)소비기한\\s*[:：]\\s*${escaped}`), '')
      .replace(/^\s*\/\s*|\s*\/\s*$/g, '')
      .trim();
  }

  function updateMeatwatchLookupState(){
    const button = byId('t-meatwatch-lookup-btn');
    if(!button) return;
    const type = byId('t-type')?.value || '';
    const product = selectedProduct();
    const origin = byId('t-origin-managed')?.value || product?.origin || '';
    const permitted = typeof DBMTAuth === 'object' && DBMTAuth.isPersonal() &&
      (DBMTAuth.canAction('transactions','create') || DBMTAuth.canAction('transactions','update'));
    const applicable = permitted && type === '입고' && isImportedOrigin(origin);
    button.style.display = applicable ? '' : 'none';
    if(!applicable){
      button.disabled = true;
      setStatus('');
      return;
    }
    const lot = String(byId('t-lot')?.value || '').trim();
    const shelfDays = Number.parseInt(product?.shelfdays, 10);
    button.disabled = !lot || !product || !Number.isInteger(shelfDays) || shelfDays < 1;
    button.title = !product
      ? '품목관리의 수입 원료육을 먼저 선택하세요.'
      : (!Number.isInteger(shelfDays) || shelfDays < 1
          ? '품목관리에서 소비기한(일)을 확인하세요.'
          : (!lot ? '이력번호를 입력하세요.' : 'MeatWatch에서 수출국 가공일을 조회합니다.'));
  }

  function clearMeatwatchLookupResult(options={}){
    const expiryEl = byId('t-meatwatch-expiry');
    const previousExpiry = expiryEl?.value || '';
    if(options?.removeNote && previousExpiry){
      const noteEl = byId('t-note');
      if(noteEl) noteEl.value = removeGeneratedExpiryNote(noteEl.value, previousExpiry);
    }
    ['t-meatwatch-process-begin','t-meatwatch-process-end','t-meatwatch-expiry','t-meatwatch-queried-at']
      .forEach(id=>{ const el=byId(id); if(el) el.value=''; });
    setStatus('');
  }

  function restoreMeatwatchLookupFromTransaction(transaction){
    const row = transaction || {};
    const values = {
      't-meatwatch-process-begin':row.meatwatchProcessBeginDate || '',
      't-meatwatch-process-end':row.meatwatchProcessEndDate || '',
      't-meatwatch-expiry':row.meatwatchExpiryDate || '',
      't-meatwatch-queried-at':row.meatwatchQueriedAt || ''
    };
    Object.entries(values).forEach(([id,value])=>{ const el=byId(id); if(el) el.value=value; });
    if(values['t-meatwatch-process-begin'] && values['t-meatwatch-expiry']){
      setStatus(`조회 기록: 가공 시작일 ${values['t-meatwatch-process-begin']} · 소비기한 ${values['t-meatwatch-expiry']}`, 'success');
    } else setStatus('');
    updateMeatwatchLookupState();
  }

  async function lookupImportedMeatExpiry(){
    const isEdit = typeof _editTxnId !== 'undefined' && Boolean(_editTxnId);
    const permissionAction = isEdit ? 'update' : 'create';
    if(typeof DBMTAuth !== 'object' || !DBMTAuth.requireAction('transactions', permissionAction)) return;
    const type = byId('t-type')?.value || '';
    const product = selectedProduct();
    const origin = byId('t-origin-managed')?.value || product?.origin || '';
    const traceNo = String(byId('t-lot')?.value || '').trim();
    const shelfDays = Number.parseInt(product?.shelfdays, 10);
    if(type !== '입고' || !isImportedOrigin(origin)){
      setStatus('수입 원료육 입고에서만 조회할 수 있습니다.', 'error');
      return;
    }
    if(!product){
      setStatus('품목관리에서 등록된 수입 원료육을 먼저 선택하세요.', 'error');
      return;
    }
    if(!traceNo){
      setStatus('이력번호를 입력하세요.', 'error');
      return;
    }
    if(!Number.isInteger(shelfDays) || shelfDays < 1){
      setStatus('품목관리에서 이 품목의 소비기한(일)을 확인하세요.', 'error');
      return;
    }
    const sessionToken = DBMTAuth.getSessionToken();
    if(!sessionToken){
      setStatus('개인 사용자 로그인이 필요합니다.', 'error');
      return;
    }

    const button = byId('t-meatwatch-lookup-btn');
    if(button){ button.disabled=true; button.textContent='조회 중…'; }
    setStatus('MeatWatch에서 수출국 가공일을 조회하고 있습니다.');
    try{
      const result = await sbFunctionRequest('meatwatch-lookup', {
        sessionToken, traceNo, permissionAction
      });
      const processBeginDate = validIsoDate(result?.processBeginDate);
      const processEndDate = validIsoDate(result?.processEndDate);
      const expiryDate = calculateExpiryDate(processBeginDate, shelfDays);
      if(!processBeginDate || !expiryDate) throw new Error('가공일 또는 소비기한을 계산할 수 없습니다.');
      const values = {
        't-meatwatch-process-begin':processBeginDate,
        't-meatwatch-process-end':processEndDate,
        't-meatwatch-expiry':expiryDate,
        't-meatwatch-queried-at':String(result?.queriedAt || '')
      };
      Object.entries(values).forEach(([id,value])=>{ const el=byId(id); if(el) el.value=value; });
      const noteEl = byId('t-note');
      if(noteEl) noteEl.value = expiryNote(noteEl.value, expiryDate);
      const range = processEndDate && processEndDate !== processBeginDate
        ? `${processBeginDate}~${processEndDate}` : processBeginDate;
      setStatus(`가공일 ${range} · 시작일 기준 ${shelfDays}일 → 소비기한 ${expiryDate}`, 'success');
      if(typeof toast === 'function') toast('수입육 소비기한을 비고에 입력했습니다.');
    }catch(error){
      setStatus(`조회 실패: ${String(error?.message || error)}`, 'error');
    }finally{
      if(button){ button.textContent='가공일 조회'; }
      updateMeatwatchLookupState();
    }
  }

  function bulkRowProduct(row){
    const id = row?.querySelector('.bulk-in-product-id')?.value || '';
    return (typeof labelProducts !== 'undefined' ? labelProducts : [])
      .find(product=>String(product?.id || '') === String(id)) || null;
  }

  function setBulkRowStatus(row, message, kind='normal'){
    const el = row?.querySelector('.bulk-in-meatwatch-status');
    if(!el) return;
    el.textContent = message || '';
    el.style.display = message ? 'block' : 'none';
    el.style.color = STATUS_COLORS[kind] || STATUS_COLORS.normal;
  }

  function clearBulkInboundMeatwatchResult(row, options={}){
    if(!row) return;
    const expiryEl = row.querySelector('.bulk-in-meatwatch-expiry');
    const previousExpiry = expiryEl?.value || '';
    if(options?.removeNote && previousExpiry){
      const noteEl = row.querySelector('.bulk-in-note');
      if(noteEl) noteEl.value = removeGeneratedExpiryNote(noteEl.value, previousExpiry);
    }
    ['bulk-in-meatwatch-process-begin','bulk-in-meatwatch-process-end','bulk-in-meatwatch-expiry','bulk-in-meatwatch-queried-at']
      .forEach(className=>{
        const el = row.querySelector(`.${className}`);
        if(el) el.value = '';
      });
    setBulkRowStatus(row, '');
  }

  function bulkRowLookupContext(row){
    const product = bulkRowProduct(row);
    return {
      row,
      product,
      traceNo:String(row?.querySelector('.bulk-in-lot')?.value || '').trim(),
      shelfDays:Number.parseInt(product?.shelfdays,10),
      weight:Number.parseFloat(row?.querySelector('.bulk-in-weight')?.value || 0) || 0,
      trader:String(row?.querySelector('.bulk-in-trader')?.value || '').trim(),
      note:String(row?.querySelector('.bulk-in-note')?.value || '').trim()
    };
  }

  async function lookupBulkInboundRow(context, sessionToken){
    const {row, traceNo, shelfDays} = context;
    setBulkRowStatus(row, 'MeatWatch에서 가공일을 조회하고 있습니다.');
    const result = await sbFunctionRequest('meatwatch-lookup', {
      sessionToken,
      traceNo,
      permissionAction:'create'
    });
    const processBeginDate = validIsoDate(result?.processBeginDate);
    const processEndDate = validIsoDate(result?.processEndDate);
    const expiryDate = calculateExpiryDate(processBeginDate, shelfDays);
    if(!processBeginDate || !expiryDate) throw new Error('가공일 또는 소비기한을 계산할 수 없습니다.');
    const values = {
      'bulk-in-meatwatch-process-begin':processBeginDate,
      'bulk-in-meatwatch-process-end':processEndDate,
      'bulk-in-meatwatch-expiry':expiryDate,
      'bulk-in-meatwatch-queried-at':String(result?.queriedAt || '')
    };
    Object.entries(values).forEach(([className,value])=>{
      const el = row.querySelector(`.${className}`);
      if(el) el.value = value;
    });
    const noteEl = row.querySelector('.bulk-in-note');
    if(noteEl) noteEl.value = expiryNote(noteEl.value, expiryDate);
    const range = processEndDate && processEndDate !== processBeginDate
      ? `${processBeginDate}~${processEndDate}` : processBeginDate;
    setBulkRowStatus(row, `가공일 ${range} · 소비기한 ${expiryDate}`, 'success');
  }

  async function lookupAllBulkInboundMeatExpiry(){
    if(typeof DBMTAuth !== 'object' || !DBMTAuth.requireAction('transactions','create')) return;
    const sessionToken = DBMTAuth.getSessionToken();
    if(!sessionToken){
      if(typeof toast === 'function') toast('개인 사용자 로그인이 필요합니다.');
      return;
    }
    const rows = [...document.querySelectorAll('#bulk-inbound-tbody tr')];
    const targets = [];
    let invalidCount = 0;
    rows.forEach((row,index)=>{
      const context = bulkRowLookupContext(row);
      const hasRowData = context.traceNo || context.weight > 0 || context.trader || context.note;
      if(!hasRowData){
        setBulkRowStatus(row,'');
        return;
      }
      if(!context.product){
        if(context.traceNo){
          setBulkRowStatus(row, `${index+1}행: 품목을 먼저 선택하세요.`, 'error');
          invalidCount++;
        }
        return;
      }
      if(!isImportedOrigin(context.product.origin)){
        setBulkRowStatus(row,'');
        return;
      }
      if(!context.traceNo){
        setBulkRowStatus(row, `${index+1}행: 이력번호를 입력하세요.`, 'error');
        invalidCount++;
        return;
      }
      if(!Number.isInteger(context.shelfDays) || context.shelfDays < 1){
        setBulkRowStatus(row, `${index+1}행: 품목관리의 소비기한(일)을 확인하세요.`, 'error');
        invalidCount++;
        return;
      }
      targets.push(context);
    });
    if(!targets.length){
      if(typeof toast === 'function') toast(invalidCount ? '조회 조건을 확인하세요.' : '조회할 수입 원료육 행이 없습니다.');
      return;
    }

    const button = byId('bulk-in-meatwatch-lookup-all-btn');
    const originalText = button?.textContent || '이력번호 일괄조회';
    if(button) button.disabled = true;
    let successCount = 0;
    let failedCount = 0;
    for(let index=0; index<targets.length; index++){
      const context = targets[index];
      if(button) button.textContent = `조회 중 ${index+1}/${targets.length}`;
      try{
        await lookupBulkInboundRow(context, sessionToken);
        successCount++;
      }catch(error){
        failedCount++;
        setBulkRowStatus(context.row, `조회 실패: ${String(error?.message || error)}`, 'error');
      }
    }
    if(button){
      button.disabled = false;
      button.textContent = originalText;
    }
    if(typeof toast === 'function'){
      toast(failedCount
        ? `이력번호 조회 완료: 성공 ${successCount}건 / 실패 ${failedCount}건`
        : `이력번호 ${successCount}건 조회 완료`);
    }
  }

  window.updateMeatwatchLookupState = updateMeatwatchLookupState;
  window.clearMeatwatchLookupResult = clearMeatwatchLookupResult;
  window.restoreMeatwatchLookupFromTransaction = restoreMeatwatchLookupFromTransaction;
  window.lookupImportedMeatExpiry = lookupImportedMeatExpiry;
  window.clearBulkInboundMeatwatchResult = clearBulkInboundMeatwatchResult;
  window.lookupAllBulkInboundMeatExpiry = lookupAllBulkInboundMeatExpiry;
  document.addEventListener('DOMContentLoaded', updateMeatwatchLookupState);
})();
