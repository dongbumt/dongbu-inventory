/* Save outbound form prices without changing transactions or clearing the draft. */
(function(){
  'use strict';
  let saving = false;

  function identity(row){
    return JSON.stringify([priceKey(row.product), originKey(row.origin), priceKey(row.trader)]);
  }

  function updateButtons(){
    const wrap = document.getElementById('t-save-price-wrap');
    if(wrap) wrap.hidden = document.getElementById('t-type')?.value !== '출고';
    for(const id of ['t-save-price-btn', 'bulk-out-save-price-btn']){
      const button = document.getElementById(id);
      if(button) button.disabled = saving;
    }
  }

  function collect(source){
    const rows = [];
    const add = (product, origin, trader, value, label) => {
      product = getCanonicalPriceProductName(product);
      origin = normalizeOriginName(origin);
      trader = String(trader || '').trim();
      const text = String(value ?? '').trim();
      const price = Number(text);
      if(!product) throw new Error(`${label}: 품목관리의 등록 품목을 선택하세요.`);
      if(!trader) throw new Error(`${label}: 거래처를 입력하세요.`);
      if(!text || !Number.isFinite(price) || price <= 0) throw new Error(`${label}: 0보다 큰 출고 단가를 입력하세요.`);
      rows.push({product, origin, trader, price});
    };
    if(source === 'single'){
      if(document.getElementById('t-type')?.value !== '출고') throw new Error('출고 입력에서 사용할 수 있습니다.');
      if(!document.getElementById('t-stock-key')?.value) throw new Error('출고 재고를 검색 목록에서 선택하세요.');
      add(getTProduct(), getTOrigin(), document.getElementById('t-trader')?.value, document.getElementById('t-price')?.value, '출고 단가');
    }else if(source === 'bulk'){
      document.querySelectorAll('#bulk-outbound-tbody tr').forEach((tr, index) => {
        const key = tr.querySelector('.bulk-out-key')?.value;
        const typed = tr.querySelector('.bulk-out-stock-input')?.value.trim();
        const trader = tr.querySelector('.bulk-out-trader')?.value.trim();
        const value = tr.querySelector('.bulk-out-price-input')?.value.trim();
        if(!key && !typed && !trader && !value) return;
        if(!key) throw new Error(`${index + 1}번째 행: 출고 재고를 검색 목록에서 선택하세요.`);
        add(tr.querySelector('.bulk-out-product')?.value, tr.querySelector('.bulk-out-origin')?.value, trader, value, `${index + 1}번째 행`);
      });
    }else throw new Error('출고 입력 화면을 확인하세요.');
    if(!rows.length) throw new Error('단가표에 저장할 출고 항목이 없습니다.');
    const unique = new Map();
    for(const row of rows){
      const key = identity(row);
      if(unique.has(key) && unique.get(key).price !== row.price){
        throw new Error(`${row.product} / ${row.origin || '-'} / ${row.trader}: 같은 항목의 단가가 서로 다릅니다. 단가를 통일한 후 저장하세요.`);
      }
      unique.set(key, row);
    }
    return [...unique.values()];
  }

  function status(source, message){
    const element = document.getElementById(source === 'bulk' ? 'bulk-out-price-save-status' : 't-price-save-status');
    if(element){ element.textContent = message; element.hidden = !message; }
  }

  async function saveOutboundPrices(source='single'){
    if(saving) return;
    try{
      if(typeof DBMTAuth !== 'object' || !DBMTAuth.isPersonal() ||
        !DBMTAuth.can('transactions', 'view') || !(DBMTAuth.can('prices', 'create') || DBMTAuth.can('prices', 'update'))){
        throw new Error('출고 조회 및 단가표 등록·수정 권한이 필요합니다.');
      }
      if(localStorage.getItem(SUPABASE_ENABLED_KEY) !== '1') throw new Error('서버에 연결한 후 단가표를 저장해주세요.');
      const rows = collect(source);
      const token = requireSupabasePassword();
      saving = true;
      updateButtons();
      status(source, '단가표를 확인하고 저장하는 중입니다…');
      const request = expected => sbRpc('dbmt_erp_save_outbound_prices', {p_token:token, p_rows:rows, p_expected:expected});
      let result = await request([]);
      if(DBMTAuth.getSessionToken() !== token) return;
      if(result?.confirmationRequired){
        const detail = result.conflicts.map(row => `${row.product} / ${row.origin || '-'} / ${row.trader}: ${Number(row.oldPrice).toLocaleString('ko-KR')}원 → ${Number(row.price).toLocaleString('ko-KR')}원`).join('\n');
        if(!confirm(`이미 등록된 단가가 있습니다. 다음 단가로 갱신할까요?\n\n${detail}\n\n새 항목은 추가하고, 같은 단가는 중복 저장하지 않습니다.`)){
          status(source, '단가표 저장을 취소했습니다.');
          return;
        }
        result = await request(result.conflicts);
      }
      if(result?.confirmationRequired) throw new Error('다른 PC에서 단가가 변경되었습니다. 단가표 저장 버튼을 다시 눌러 확인해주세요.');
      if(!result?.ok || !Array.isArray(result.rows)) throw new Error(result?.message || '단가표 저장 결과를 확인하지 못했습니다.');
      if(DBMTAuth.getSessionToken() !== token) return;
      // Only committed server rows enter the local price list. Keep other rows and edit indexes.
      for(const row of result.rows){
        const index = prices.findIndex(old => String(old.id || '') === String(row.id) || identity(old) === identity(row));
        if(index < 0) prices.push(row);
        else prices[index] = row;
      }
      safeLocalStorageSet('dbmt_prices', JSON.stringify(prices), true);
      if(result.changedRows?.length) recordPriceChange(result.changedRows, null, null, {action:'출고 단가 저장'});
      renderPrices();
      const message = `단가표 저장 완료: 신규 ${result.inserted || 0}건 · 갱신 ${result.updated || 0}건 · 동일 단가 ${result.skipped || 0}건. 단가표 메뉴에서 수정할 수 있습니다.`;
      status(source, message);
      toast(message);
    }catch(error){
      const message = '단가표 저장 실패: ' + String(error?.message || error);
      status(source, message);
      toast(message);
    }finally{
      saving = false;
      updateButtons();
    }
  }

  window.saveOutboundPrices = saveOutboundPrices;
  window.updateOutboundPriceButtons = updateButtons;
  updateButtons();
})();
