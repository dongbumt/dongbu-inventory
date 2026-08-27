(function(){
  'use strict';

  let previewRows = [];
  let previewLoading = false;
  let previewInitialized = false;

  const byId = id => document.getElementById(id);
  const esc = value => typeof window.htmlEscape === 'function'
    ? window.htmlEscape(value == null ? '' : String(value))
    : String(value == null ? '' : value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

  function localIsoDate(date){
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function monthStartIso(){
    const now = new Date();
    return localIsoDate(new Date(now.getFullYear(), now.getMonth(), 1));
  }

  function statusLabel(status){
    return ({
      ready:'준비 완료', review:'확인 필요', excluded:'제외',
      registered:'대기 등록', sent:'전송 완료'
    })[status] || '확인 필요';
  }

  function statusClass(status){
    return ['ready','review','excluded','registered','sent'].includes(status) ? status : 'review';
  }

  function setStatus(message, isError=false){
    const el = byId('trace-preview-status-text');
    if(!el) return;
    el.textContent = message || '';
    el.classList.toggle('error', Boolean(isError));
  }

  function formatWeight(value){
    return `${Number(value || 0).toLocaleString('ko-KR', {minimumFractionDigits:0, maximumFractionDigits:2})} KG`;
  }

  function renderSummary(summary={}){
    const el = byId('trace-preview-summary');
    if(!el) return;
    const total = Number(summary.total || 0);
    const ready = Number(summary.ready || 0);
    const review = Number(summary.review || 0);
    const excluded = Number(summary.excluded || 0);
    const registered = Number(summary.registered || 0);
    const sent = Number(summary.sent || 0);
    el.innerHTML = `
      <div class="trace-preview-stat"><span>조회대상</span><strong>${total.toLocaleString()}건</strong></div>
      <div class="trace-preview-stat"><span>준비 완료</span><strong>${ready.toLocaleString()}건</strong></div>
      <div class="trace-preview-stat"><span>확인 필요</span><strong>${review.toLocaleString()}건</strong></div>
      <div class="trace-preview-stat"><span>제외</span><strong>${excluded.toLocaleString()}건</strong></div>
      <div class="trace-preview-stat"><span>대기·완료</span><strong>${(registered + sent).toLocaleString()}건</strong></div>`;
  }

  function movementText(row){
    if(row.transactionType === '재고이동'){
      return [row.fromLocation || '-', row.toLocation || '-'].join(' → ');
    }
    return row.trader || '-';
  }

  function renderRows(){
    const body = byId('trace-preview-body');
    if(!body) return;
    if(!previewRows.length){
      body.innerHTML = '<tr><td colspan="11" class="trace-preview-empty">조건에 맞는 이력연계 자료가 없습니다.</td></tr>';
      return;
    }
    body.innerHTML = previewRows.map(row => {
      const key = String(row.idempotencyKey || '');
      const shortKey = key ? key.slice(0, 12) : '-';
      const productMeta = [row.productCode, row.meatType, row.origin].filter(Boolean).join(' · ');
      const reason = row.reason || '전송 준비자료 확인 완료';
      return `<tr>
        <td class="trace-preview-nowrap">${esc(row.date || '-')}</td>
        <td class="trace-preview-nowrap">${esc(row.transactionType || '-')}</td>
        <td class="trace-preview-nowrap">${esc(row.providerLabel || '-')}</td>
        <td class="trace-preview-nowrap">${esc(row.reportTypeLabel || '-')}</td>
        <td><strong>${esc(row.product || '-')}</strong><small>${esc(productMeta)}</small></td>
        <td class="trace-preview-lot">${esc(row.lot || '-')}</td>
        <td>${esc(movementText(row))}</td>
        <td class="trace-preview-number">${esc(formatWeight(row.weight))}</td>
        <td><span class="trace-preview-badge ${statusClass(row.status)}">${esc(statusLabel(row.status))}</span></td>
        <td class="trace-preview-reason" title="${esc(reason)}">${esc(reason)}</td>
        <td><button type="button" class="trace-preview-key" title="${esc(key)}" onclick="copyTraceIntegrationKey('${esc(key)}')">${esc(shortKey)}</button></td>
      </tr>`;
    }).join('');
  }

  function validateRange(){
    const from = byId('trace-preview-from')?.value || '';
    const to = byId('trace-preview-to')?.value || '';
    if(!from || !to) throw new Error('조회 시작일과 종료일을 선택해주세요.');
    if(from > to) throw new Error('조회 시작일은 종료일보다 늦을 수 없습니다.');
    const fromDate = new Date(`${from}T00:00:00`);
    const toDate = new Date(`${to}T00:00:00`);
    if((toDate - fromDate) / 86400000 > 370) throw new Error('조회 기간은 최대 1년까지 선택할 수 있습니다.');
    return {from, to};
  }

  async function initTraceIntegrationPage(){
    if(!previewInitialized){
      const from = byId('trace-preview-from');
      const to = byId('trace-preview-to');
      if(from && !from.value) from.value = monthStartIso();
      if(to && !to.value) to.value = localIsoDate(new Date());
      previewInitialized = true;
    }
    if(!previewRows.length && !previewLoading) await loadTraceIntegrationPreview();
  }

  async function loadTraceIntegrationPreview(){
    if(previewLoading) return;
    if(typeof window.DBMTAuth !== 'object' || !window.DBMTAuth.requireAction('trace_integration', 'view')) return;
    try{
      const range = validateRange();
      const token = window.DBMTAuth.getSessionToken();
      if(!token) throw new Error('개인 사용자 로그인이 만료되었습니다. 다시 로그인해주세요.');
      previewLoading = true;
      const body = byId('trace-preview-body');
      if(body) body.innerHTML = '<tr><td colspan="11" class="trace-preview-empty">신고대상을 확인하고 있습니다.</td></tr>';
      setStatus('거래자료에서 이력연계 대상을 확인하고 있습니다.');
      const result = await window.sbRpc('dbmt_erp_trace_preview', {
        p_token:token,
        p_from:range.from,
        p_to:range.to,
        p_provider:byId('trace-preview-provider')?.value || 'all',
        p_status:byId('trace-preview-status')?.value || 'all',
        p_query:(byId('trace-preview-query')?.value || '').trim(),
        p_limit:500
      });
      if(!result?.ok) throw new Error(result?.message || '신고대상 조회에 실패했습니다.');
      previewRows = Array.isArray(result.rows) ? result.rows : [];
      renderSummary(result.summary || {});
      renderRows();
      const matched = Number(result.summary?.matched || previewRows.length);
      setStatus(`${range.from} ~ ${range.to} · ${matched.toLocaleString()}건${result.hasMore ? ' (최대 500건 표시)' : ''} · 기관 전송은 수행하지 않았습니다.`);
    }catch(error){
      previewRows = [];
      renderSummary({});
      renderRows();
      setStatus(String(error?.message || error || '신고대상 조회에 실패했습니다.'), true);
    }finally{
      previewLoading = false;
    }
  }

  function exportTraceIntegrationPreviewCSV(){
    if(typeof window.DBMTAuth !== 'object' || !window.DBMTAuth.requireAction('trace_integration', 'view')) return;
    if(!previewRows.length){
      if(typeof window.toast === 'function') window.toast('CSV로 저장할 조회 결과가 없습니다.');
      return;
    }
    const header = ['거래일','거래구분','연계구분','예정신고','품목명','제품코드','육종','원산지','이력번호','거래처/이동','중량(KG)','준비상태','확인내용','중복방지키'];
    const rows = previewRows.map(row => [
      row.date || '', row.transactionType || '', row.providerLabel || '', row.reportTypeLabel || '',
      row.product || '', row.productCode || '', row.meatType || '', row.origin || '', row.lot || '',
      movementText(row), Number(row.weight || 0), statusLabel(row.status), row.reason || '', row.idempotencyKey || ''
    ]);
    const from = byId('trace-preview-from')?.value || '';
    const to = byId('trace-preview-to')?.value || '';
    window.downloadCSV([header, ...rows], `이력연계_신고대상_${from}_${to}.csv`);
  }

  async function copyTraceIntegrationKey(key){
    if(!key) return;
    try{
      await navigator.clipboard.writeText(key);
      if(typeof window.toast === 'function') window.toast('중복방지키를 복사했습니다.');
    }catch(_){
      window.prompt('중복방지키를 복사하세요.', key);
    }
  }

  window.initTraceIntegrationPage = initTraceIntegrationPage;
  window.loadTraceIntegrationPreview = loadTraceIntegrationPreview;
  window.exportTraceIntegrationPreviewCSV = exportTraceIntegrationPreviewCSV;
  window.copyTraceIntegrationKey = copyTraceIntegrationKey;
})();
