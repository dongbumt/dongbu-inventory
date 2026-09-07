(function(){
  'use strict';

  const SESSION_KEY = 'dbmt_erp_user_session_token';
  const ACTION_KEYS = ['view','create','update','delete','close','apiSend','admin'];
  const ACTION_FIELDS = {
    view:'canView', create:'canCreate', update:'canUpdate', delete:'canDelete',
    close:'canClose', apiSend:'canApiSend', admin:'canAdmin'
  };
  const NAV_MENU = {
    'nav-schedule':'schedule',
    'nav-company-master':'company_master',
    'nav-access-control':'access_control',
    'nav-labelproducts':'label_products',
    'nav-traders':'traders',
    'nav-samsung':'samsung',
    'nav-transactions':'transactions',
    'nav-production':'production',
    'nav-prod-loss':'production_loss',
    'nav-production-board':'production_board',
    'nav-stock':'stock',
    'nav-cold-storage-request':'cold_storage_request',
    'nav-submaterials':'submaterials',
    'nav-prices':'prices',
    'nav-workorders':'workorders',
    'nav-label':'label',
    'nav-label-print-standalone':'label_print',
    'nav-pangwanbi':'expense_settings',
    'nav-costcalc':'cost_calculator',
    'nav-costcompare':'cost_compare',
    'nav-quotation':'quotation',
    'nav-invoice':'invoice',
    'nav-incheck':'inbound_inspection',
    'nav-shiplog':'shipment_log',
    'nav-trace-integration':'trace_integration',
    'nav-doccheck':'document_check',
    'nav-employees':'employees',
    'nav-leaves':'attendance',
    'nav-driver-attendance':'driver_attendance',
    'nav-mobile-admin':'mobile_admin',
    'nav-expense':'expenses',
    'nav-import':'import',
    'nav-factorysim':'factory_sim',
    'nav-change-log':'change_log'
  };
  const PAGE_MENU = Object.fromEntries(Object.entries(NAV_MENU)
    .filter(([nav])=>nav !== 'nav-label-print-standalone')
    .map(([nav,menu])=>['p-' + nav.slice(4), menu]));

  // One permission registry drives both button visibility and direct calls.
  // `write` is used only by legacy forms that share one save button for create/update.
  const ACTION_POLICIES = Object.freeze({
    'DBMTAuth.newUser':['access_control','admin','uiOnly'],
    'DBMTAuth.saveUser':['access_control','admin','uiOnly'],
    'DBMTAuth.deleteUser':['access_control','admin','uiOnly'],
    'DBMTAuth.newRole':['access_control','admin','uiOnly'],
    'DBMTAuth.saveRole':['access_control','admin','uiOnly'],
    'DBMTAuth.deleteRole':['access_control','admin','uiOnly'],

    newCompanyBusinessSite:['company_master','create','uiOnly'],
    saveCompanyMasterRecord:['company_master','update'],
    saveCompanyBusinessSite:['company_master','write'],
    newDocumentSenderProfile:['company_master','create','uiOnly'],
    saveDocumentSenderProfile:['company_master','write'],
    clearCompanyIdentifierForm:['company_master','create','uiOnly'],
    saveCompanySiteIdentifier:['company_master','write'],

    addSamsungVendor:['samsung','create'],
    deleteSamsungVendor:['samsung','delete'],
    addSamsungVendorProduct:['samsung','write'],
    editSamsungVendorProduct:['samsung','update'],
    deleteSamsungVendorProduct:['samsung','delete'],

    addTransaction:['transactions','write'],
    lookupImportedMeatExpiry:['transactions','write'],
    saveBulkInbound:['transactions','create'],
    saveBulkOutbound:['transactions','create'],
    saveEditTxn:['transactions','update'],
    loadTxnToForm:['transactions','update'],
    updateTxnPrice:['transactions','update'],
    deleteTransaction:['transactions','delete'],

    loadTraceIntegrationPreview:['trace_integration','view'],
    exportTraceIntegrationPreviewCSV:['trace_integration','view'],

    addProdInputRow:['production','write','uiOnly'],
    addProdOutputRow:['production','write','uiOnly'],
    saveProdEntry:['production','write'],
    openEditProdEntry:['production','update'],
    deleteProdEntry:['production','delete'],
    addSubMaterialUsageDraftRow:['production','update'],
    removeSubMaterialUsageDraftRow:['production','update'],
    saveSubMaterialUsageModal:['production','update'],
    printSubMaterialUsage:['production','view'],
    deleteSubMaterialUsage:['production','delete'],

    openStockAdjust:['stock','update'],
    saveStockAdjust:['stock','update'],
    printStockReport:['stock','view'],
    exportStockCSV:['stock','view'],

    newColdStorageRequest:['cold_storage_request','create','uiOnly'],
    addColdStorageRequestItem:['cold_storage_request','create','uiOnly'],
    saveColdStorageRequest:['cold_storage_request','write'],
    deleteColdStorageRequest:['cold_storage_request','delete'],
    sendColdStorageRequestFax:['cold_storage_request','apiSend'],

    addSubMaterialItem:['submaterials','write'],
    editSubMaterialItem:['submaterials','update'],
    deleteSubMaterialItem:['submaterials','delete'],
    addSubMaterialInbound:['submaterials','create'],
    deleteSubMaterialLot:['submaterials','delete'],
    addSubMaterialCount:['submaterials','create'],
    deleteSubMaterialCount:['submaterials','delete'],

    savePrice:['prices','write'],
    editPrice:['prices','update'],
    deletePrice:['prices','delete'],
    doImport:['import','create'],
    restoreAllData:['import','admin'],

    toggleDocCheckKeys:['document_check','update'],
    sendDocumentRequests:['document_check','apiSend'],
    saveTraderInfo:['traders','write'],
    editTrader:['traders','update'],
    deleteTrader:['traders','delete'],

    saveEmployee:['employees','write'],
    editEmployee:['employees','update'],
    openResignModal:['employees','update'],
    deleteEmployee:['employees','delete'],
    saveResignation:['employees','update'],
    reinstateEmployee:['employees','update'],
    reopenSettlement:['employees','update'],
    saveLeave:['attendance','write'],
    editLeave:['attendance','update'],
    deleteLeave:['attendance','delete'],
    saveLeaveDeduction:['attendance','write'],
    editLeaveDeduction:['attendance','update'],
    deleteLeaveDeduction:['attendance','delete'],
    saveWeekendWork:['attendance','write'],
    editWeekendWork:['attendance','update'],
    deleteWeekendWork:['attendance','delete'],

    saveDriverAccount:['driver_attendance','admin'],
    editDriverAccount:['driver_attendance','admin'],
    setDriverAccountActive:['driver_attendance','admin'],
    saveDriverAttendanceAdmin:['driver_attendance','write'],
    editDriverAttendance:['driver_attendance','update'],
    deleteDriverAttendance:['driver_attendance','delete'],
    saveDriverLocation:['driver_attendance','admin'],
    editDriverLocation:['driver_attendance','admin'],
    saveMobileAdminAccount:['mobile_admin','admin'],
    editMobileAdminAccount:['mobile_admin','admin'],

    addMaterialRow:['cost_calculator','create','uiOnly'],
    saveCostCalc:['cost_calculator','create'],
    deleteCostCalc:['cost_calculator','delete'],
    newQuotation:['quotation','create','uiOnly'],
    addQuotationRow:['quotation','create','uiOnly'],
    saveQuotation:['quotation','write'],
    deleteQuotation:['quotation','delete'],

    newFactorySimScenario:['factory_sim','create','uiOnly'],
    duplicateFactorySimBaseline:['factory_sim','create','uiOnly'],
    saveFactorySimScenario:['factory_sim','write'],
    deleteFactorySimScenario:['factory_sim','delete'],
    addFactorySimZone:['factory_sim','write','uiOnly'],
    addFactorySimEquipment:['factory_sim','write','uiOnly'],
    addFactorySimRoute:['factory_sim','write','uiOnly'],
    resetFactorySimWholeLayout:['factory_sim','write','uiOnly'],
    applyFactorySimProductionAverage:['factory_sim','write','uiOnly'],

    applySalaryToExpense:['expense_settings','update'],
    savePangwanbi:['expense_settings','write'],
    editPangwanbi:['expense_settings','update'],
    deletePangwanbi:['expense_settings','delete'],
    addExpense:['expenses','write'],
    editExpense:['expenses','update'],
    deleteExpense:['expenses','delete'],

    saveLabelProduct:['label_products','write'],
    editLabelProduct:['label_products','update'],
    saveInlineLabelProduct:['label_products','update'],
    deleteLabelProduct:['label_products','delete'],
    saveWorkOrder:['workorders','write'],
    editWorkOrder:['workorders','update'],
    deleteWorkOrder:['workorders','delete'],
    printLabel:['label','create'],
    saveLabelTemplate:['label','create'],
    deleteLabelTemplate:['label','delete']
  });

  const SELECTOR_POLICIES = Object.freeze([
    ['#doc-request-email-btn','document_check','apiSend'],
    ['#doc-request-fax-btn','document_check','apiSend'],
    ['#doc-request-send-btn','document_check','apiSend'],
    ['#m02-user-save','access_control','admin'],
    ['#m02-role-save','access_control','admin'],
    ['[data-identifier-key]','company_master','update']
  ]);

  let state = {
    user:null,
    permissions:new Map(),
    authMode:'required'
  };
  let adminData = null;
  let selectedUserId = '';
  let selectedRoleId = '';
  let sessionPromise = null;

  function esc(value){
    if(typeof window.htmlEscape === 'function') return window.htmlEscape(String(value ?? ''));
    return String(value ?? '').replace(/[&<>"']/g, ch=>({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    })[ch]);
  }

  function rpc(name, params){
    if(typeof window.sbRpc !== 'function') return Promise.reject(new Error('Supabase 연결이 준비되지 않았습니다.'));
    return window.sbRpc(name, params);
  }

  function sessionToken(){
    try{return sessionStorage.getItem(SESSION_KEY) || '';}catch(_){return '';}
  }

  function storeSessionToken(token){
    try{
      if(token) sessionStorage.setItem(SESSION_KEY, token);
      else sessionStorage.removeItem(SESSION_KEY);
    }catch(_){}
  }

  function setSession(payload){
    state.user = payload?.user || null;
    state.authMode = payload?.authMode || 'required';
    state.permissions = new Map((payload?.permissions || []).map(row=>[row.menuCode, row]));
    renderHeader();
    applyNavigation();
    notifyPermissionSurfaces();
  }

  function clearSession(){
    storeSessionToken('');
    setSession({user:null, permissions:[], authMode:'required'});
  }

  function renderHeader(){
    const button = document.getElementById('m02-user-button');
    const label = document.getElementById('m02-auth-mode-label');
    if(!button || !label) return;
    if(state.user){
      button.textContent = state.user.displayName || state.user.loginId || '사용자';
      button.title = `${state.user.roleName || ''} · 클릭하여 로그아웃`;
      button.onclick = logoutConfirm;
      label.textContent = state.user.roleName || '개인 로그인';
    }else{
      button.textContent = '사용자 로그인';
      button.title = '개인 계정으로 로그인';
      button.onclick = openLogin;
      label.textContent = '로그인 필요';
    }
  }

  function can(menuCode, action='view'){
    if(!state.user) return false;
    const row = state.permissions.get(menuCode);
    return Boolean(row && row[ACTION_FIELDS[action] || action]);
  }

  function canAction(menuCode, action='view'){
    if(action === 'write') return can(menuCode, 'create') || can(menuCode, 'update');
    return can(menuCode, action);
  }

  function requireAction(menuCode, action, silent=false){
    if(canAction(menuCode, action)) return true;
    if(!silent && typeof window.toast === 'function'){
      window.toast(state.user ? '이 작업을 수행할 권한이 없습니다.' : '이 작업은 개인 사용자 로그인이 필요합니다.');
    }
    return false;
  }

  function isPersonal(){ return Boolean(state.user && sessionToken()); }
  function getSessionToken(){ return isPersonal() ? sessionToken() : ''; }

  function notifyPermissionSurfaces(){
    if(typeof window.applySchedulePermissionState === 'function') window.applySchedulePermissionState();
    if(typeof window.renderScheduleCalendar === 'function' && document.getElementById('p-schedule')?.classList.contains('active')){
      window.renderScheduleCalendar();
    }
    if(typeof window.applyStockPermissionState === 'function') window.applyStockPermissionState();
    if(typeof window.renderStock === 'function' && document.getElementById('p-stock')?.classList.contains('active')){
      window.renderStock();
    }
    if(typeof window.applyFactorySimPermissionState === 'function') window.applyFactorySimPermissionState();
    applyActionPermissions();
    if(typeof window.updateMeatwatchLookupState === 'function') window.updateMeatwatchLookupState();
  }

  function policyForElement(el){
    const onclick = el.getAttribute?.('onclick') || '';
    for(const [name, spec] of Object.entries(ACTION_POLICIES)){
      if(onclick.includes(name + '(')) return spec;
    }
    for(const [selector, menuCode, action] of SELECTOR_POLICIES){
      if(el.matches?.(selector)) return [menuCode, action];
    }
    const page = el.closest?.('.tab-panel[id^="p-"]');
    const menuCode = page ? PAGE_MENU[page.id] : '';
    const label = String(el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
    if(menuCode && label){
      if(/remove[A-Za-z0-9_]*Row\s*\(|\.remove\s*\(\)/.test(onclick)) return [menuCode, 'write'];
      if(/(팩스|요청 발송|API\s*전송)/.test(label)) return [menuCode, 'apiSend'];
      if(/(영구삭제|실사삭제|삭제)/.test(label) || /^(×|✕)$/.test(label)) return [menuCode, 'delete'];
      if(/(수정|퇴사처리|복직|반영)/.test(label)) return [menuCode, 'update'];
      if(/(저장|등록|일괄 저장|가져오기 실행)/.test(label) || /^\+\s*/.test(label) || /^새 (요청|견적|시나리오)/.test(label)) return [menuCode, 'write'];
    }
    return null;
  }

  function setActionElementVisible(el, visible){
    if(!el?.style) return;
    if(el.dataset.m02OriginalDisplay === undefined) el.dataset.m02OriginalDisplay = el.style.display || '';
    el.style.display = visible ? el.dataset.m02OriginalDisplay : 'none';
    el.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function applyActionPermissions(root=document){
    const scope = root?.querySelectorAll ? root : document;
    const candidates = [];
    if(scope.matches?.('[onclick],button,input[type="button"],input[type="submit"]')) candidates.push(scope);
    candidates.push(...scope.querySelectorAll('[onclick],button,input[type="button"],input[type="submit"]'));
    candidates.forEach(el=>{
      const spec = policyForElement(el);
      if(spec) setActionElementVisible(el, canAction(spec[0], spec[1]));
    });
  }

  function installActionGuards(){
    Object.entries(ACTION_POLICIES).forEach(([name, spec])=>{
      if(spec[2] === 'uiOnly') return;
      const original = window[name];
      if(typeof original !== 'function' || original.__m02PermissionGuard) return;
      const guarded = function(...args){
        if(!requireAction(spec[0], spec[1])) return undefined;
        return original.apply(this, args);
      };
      Object.defineProperty(guarded, '__m02PermissionGuard', {value:true});
      window[name] = guarded;
    });
  }

  function canOpenPage(pageId){
    const menuCode = PAGE_MENU[pageId];
    return !menuCode || can(menuCode, 'view');
  }

  function applyNavigation(){
    Object.entries(NAV_MENU).forEach(([navId, menuCode])=>{
      const el = document.getElementById(navId);
      if(!el) return;
      el.dataset.permissionMenu = menuCode;
      el.style.display = can(menuCode, 'view') ? '' : 'none';
    });
    document.querySelectorAll('.nav-group').forEach(group=>{
      const hasVisibleMenu = [...group.querySelectorAll('.nav-tab')]
        .some(el=>el.style.display !== 'none');
      group.style.display = hasVisibleMenu ? '' : 'none';
      if(!hasVisibleMenu){
        group.classList.remove('open');
        group.querySelector('.nav-group-title')?.setAttribute('aria-expanded', 'false');
      }
    });
    const active = document.querySelector('.tab-panel.active');
    if(active && !canOpenPage(active.id)){
      const first = Object.keys(NAV_MENU).map(id=>document.getElementById(id))
        .find(el=>el && el.style.display !== 'none' && el.id !== 'nav-label-print-standalone');
      if(first) first.click();
    }
  }

  async function initializeSession(force=false){
    if(sessionPromise && !force) return sessionPromise;
    sessionPromise = (async()=>{
      const token = sessionToken();
      if(!token){ setSession({user:null, permissions:[], authMode:'required'}); return null; }
      try{
        const result = await rpc('dbmt_erp_session', {p_token:token});
        if(!result?.ok){ clearSession(); return null; }
        setSession(result);
        return result;
      }catch(err){
        console.warn('M02 사용자 세션을 확인하지 못했습니다:', err);
        setSession({user:null, permissions:[], authMode:'required'});
        return null;
      }
    })();
    try{return await sessionPromise;}finally{sessionPromise = null;}
  }

  function openLogin(){
    const modal = document.getElementById('m02-login-modal');
    if(!modal) return;
    document.getElementById('m02-login-error')?.classList.remove('show');
    modal.classList.remove('hidden');
    setTimeout(()=>document.getElementById('m02-login-id')?.focus(), 50);
  }

  function closeLogin(){
    if(!state.user) return;
    document.getElementById('m02-login-modal')?.classList.add('hidden');
    const pw = document.getElementById('m02-login-password');
    if(pw) pw.value = '';
  }

  async function loginFromModal(){
    const loginId = document.getElementById('m02-login-id')?.value.trim() || '';
    const password = document.getElementById('m02-login-password')?.value || '';
    const errorEl = document.getElementById('m02-login-error');
    const submit = document.getElementById('m02-login-submit');
    if(!loginId || !/^\d{4}$/.test(password)){
      if(errorEl){errorEl.textContent='아이디와 숫자 4자리 비밀번호를 입력해주세요.';errorEl.classList.add('show');}
      return;
    }
    if(submit) submit.disabled = true;
    try{
      const result = await rpc('dbmt_erp_login', {p_login_id:loginId, p_login_password:password});
      if(!result?.ok) throw new Error(result?.message || '로그인에 실패했습니다.');
      storeSessionToken(result.token);
      setSession(result);
      if(typeof window.startAuthenticatedErp === 'function') await window.startAuthenticatedErp();
      closeLogin();
      if(typeof window.toast === 'function') window.toast(`${result.user?.displayName || loginId}님으로 로그인했습니다.`);
    }catch(err){
      if(errorEl){errorEl.textContent=String(err?.message || err);errorEl.classList.add('show');}
    }finally{
      if(submit) submit.disabled = false;
    }
  }

  async function logoutConfirm(){
    if(!state.user){openLogin();return;}
    if(!confirm(`${state.user.displayName} 사용자 로그아웃을 할까요?\nERP 화면이 잠기고 다시 로그인해야 합니다.`)) return;
    const token = sessionToken();
    clearSession();
    try{if(token) await rpc('dbmt_erp_logout', {p_token:token});}catch(err){console.warn('로그아웃 서버 정리 실패:', err);}
    if(typeof window.lockErpForLogin === 'function') window.lockErpForLogin(true);
  }

  function auditIdentity(){
    if(!state.user) return {authMode:'required_personal_login'};
    return {
      authMode:'personal_session',
      userId:state.user.id || '',
      userName:state.user.displayName || '',
      userLoginId:state.user.loginId || '',
      roleCode:state.user.roleCode || '',
      roleName:state.user.roleName || ''
    };
  }

  function status(message, error=false){
    const el = document.getElementById('m02-admin-status');
    if(!el) return;
    el.textContent = message;
    el.classList.toggle('error', error);
  }

  function ensureAdminAction(){
    if(!isPersonal() || !can('access_control', 'admin')) throw new Error('사용자·권한 관리 권한이 없습니다.');
  }

  async function initAdminPage(){
    if(adminData){renderAdmin();return;}
    await refreshAdmin();
  }

  async function refreshAdmin(){
    try{
      ensureAdminAction();
      status('서버에서 사용자·역할 정보를 불러오는 중입니다.');
      adminData = await rpc('dbmt_erp_admin_get', {p_token:sessionToken()});
      selectedUserId = adminData.users?.some(x=>x.id===selectedUserId) ? selectedUserId : '';
      selectedRoleId = adminData.roles?.some(x=>x.id===selectedRoleId) ? selectedRoleId : (adminData.roles?.[0]?.id || '');
      renderAdmin();
      status(`개인 로그인 운영 · 사용자 ${adminData.users?.length || 0}명 · 역할 ${(adminData.roles || []).filter(r=>r.code!=='public_operator').length}개`);
    }catch(err){
      console.error('M02 관리자 데이터 로드 실패:', err);
      status('사용자·역할 정보를 불러오지 못했습니다: ' + String(err?.message || err), true);
    }
  }

  function renderAdmin(){
    if(!adminData) return;
    const bootstrap = document.getElementById('m02-bootstrap-note');
    bootstrap?.classList.toggle('show', !(adminData.users || []).length);
    renderRoleSelect();
    renderUserList();
    renderRoleList();
    if(selectedUserId) editUser(selectedUserId); else newUser(false);
    if(selectedRoleId) editRole(selectedRoleId); else newRole(false);
  }

  function renderRoleSelect(){
    const el = document.getElementById('m02-user-role');
    if(!el) return;
    el.innerHTML = (adminData.roles || []).filter(r=>r.active && r.code!=='public_operator').map(r=>
      `<option value="${esc(r.id)}">${esc(r.name)}${r.systemRole?' (관리자)':''}</option>`
    ).join('');
  }

  function renderUserList(){
    const el = document.getElementById('m02-user-list');
    if(!el) return;
    const rows = adminData.users || [];
    el.innerHTML = rows.length ? rows.map(row=>
      `<button type="button" class="m02-list-row ${row.id===selectedUserId?'active':''} ${row.active?'':'m02-disabled'}" data-user-id="${esc(row.id)}">
        <strong>${esc(row.displayName)} · ${esc(row.loginId)}</strong>
        <small>${esc(row.roleName)} · ${row.active?'사용':'중지'}${row.lastLoginAt?' · 최근 로그인 '+esc(new Date(row.lastLoginAt).toLocaleString('ko-KR')):''}</small>
      </button>`).join('') : '<div class="m02-status">등록된 개인 사용자가 없습니다.</div>';
    el.querySelectorAll('[data-user-id]').forEach(btn=>btn.addEventListener('click',()=>editUser(btn.dataset.userId)));
  }

  function renderRoleList(){
    const el = document.getElementById('m02-role-list');
    if(!el) return;
    el.innerHTML = (adminData.roles || []).filter(row=>row.code!=='public_operator').map(row=>{
      const badge = row.systemRole ? ' · 기본 시스템' : '';
      return `<button type="button" class="m02-list-row ${row.id===selectedRoleId?'active':''} ${row.active?'':'m02-disabled'}" data-role-id="${esc(row.id)}">
        <strong>${esc(row.name)}${badge}</strong>
        <small>사용 중 ${Number(row.userCount || 0)}명 · ${row.active?'사용':'중지'}</small>
      </button>`;
    }).join('');
    el.querySelectorAll('[data-role-id]').forEach(btn=>btn.addEventListener('click',()=>editRole(btn.dataset.roleId)));
  }

  function newUser(render=true){
    selectedUserId = '';
    setValue('m02-user-id',''); setValue('m02-user-revision','');
    setValue('m02-user-name',''); setValue('m02-user-login-id',''); setValue('m02-user-password','');
    setValue('m02-user-active','1');
    const firstRole = (adminData?.roles || []).find(r=>r.code==='system_admin' && r.active)
      || (adminData?.roles || []).find(r=>r.active);
    setValue('m02-user-role',firstRole?.id || '');
    const title=document.getElementById('m02-user-form-title'); if(title) title.textContent='사용자 등록';
    const hint=document.getElementById('m02-user-password-hint'); if(hint) hint.textContent='* 숫자 4자리';
    const deleteButton=document.getElementById('m02-user-delete-btn'); if(deleteButton) deleteButton.style.display='none';
    if(render) renderUserList();
  }

  function editUser(id){
    const row=(adminData?.users || []).find(x=>x.id===id); if(!row) return;
    selectedUserId=id;
    setValue('m02-user-id',row.id); setValue('m02-user-revision',row.revision);
    setValue('m02-user-name',row.displayName); setValue('m02-user-login-id',row.loginId);
    setValue('m02-user-role',row.roleId); setValue('m02-user-active',row.active?'1':'0');
    setValue('m02-user-password','');
    const title=document.getElementById('m02-user-form-title'); if(title) title.textContent='사용자 수정';
    const hint=document.getElementById('m02-user-password-hint'); if(hint) hint.textContent='(변경할 때만 입력, 숫자 4자리)';
    const role=(adminData?.roles || []).find(x=>x.id===row.roleId);
    const currentUser=state.user?.id===row.id;
    const lastSystemAdmin=Boolean(row.active && role?.systemRole && Number(role.userCount || 0)<=1);
    const deleteButton=document.getElementById('m02-user-delete-btn');
    if(deleteButton){
      deleteButton.style.display='';
      deleteButton.disabled=currentUser || lastSystemAdmin;
      deleteButton.title=currentUser
        ? '현재 로그인한 계정은 다른 관리자로 로그인한 뒤 삭제할 수 있습니다.'
        : lastSystemAdmin
          ? '마지막 활성 시스템관리자는 삭제할 수 없습니다.'
          : '선택한 사용자를 삭제합니다.';
    }
    renderUserList();
  }

  function permissionRowsForRole(roleId){
    const byMenu=new Map((adminData?.permissions || []).filter(p=>p.roleId===roleId).map(p=>[p.menuCode,p]));
    return (adminData?.catalog || []).map(menu=>({
      ...menu,
      ...(byMenu.get(menu.menuCode) || {})
    }));
  }

  function renderPermissionTable(rows, options={}){
    const body=document.getElementById('m02-permission-body'); if(!body) return;
    const locked=Boolean(options.locked);
    const viewOnly=Boolean(options.viewOnly);
    const allRow=`<tr class="m02-all-row"><td>전체 선택</td>${ACTION_KEYS.map(action=>
      `<td><input type="checkbox" data-all-action="${action}" ${(locked || (viewOnly && action!=='view'))?'disabled':''}></td>`).join('')}</tr>`;
    body.innerHTML=allRow+rows.map(row=>`<tr data-menu-code="${esc(row.menuCode)}"><td>${esc(row.menuName)}</td>${ACTION_KEYS.map(action=>{
      const field=ACTION_FIELDS[action];
      const disabled=locked || (viewOnly && action!=='view');
      const checked=viewOnly && action!=='view' ? false : Boolean(row[field]);
      return `<td><input type="checkbox" data-action="${action}" ${checked?'checked':''} ${disabled?'disabled':''}></td>`;
    }).join('')}</tr>`).join('');
    body.querySelectorAll('[data-all-action]').forEach(box=>{
      const action=box.dataset.allAction;
      const targets=[...body.querySelectorAll(`[data-action="${action}"]`)];
      box.checked=targets.length>0 && targets.every(x=>x.checked);
      box.addEventListener('change',()=>targets.forEach(x=>{x.checked=box.checked;}));
      targets.forEach(x=>x.addEventListener('change',()=>{box.checked=targets.every(y=>y.checked);}));
    });
  }

  function generateRoleCode(){
    const randomToken = typeof crypto === 'object' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g,'')
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    return `role_${randomToken.slice(0,24).toLowerCase()}`;
  }

  function newRole(render=true){
    selectedRoleId='';
    setValue('m02-role-id',''); setValue('m02-role-revision',''); setValue('m02-role-code',generateRoleCode());
    setValue('m02-role-name',''); setValue('m02-role-description',''); setValue('m02-role-active','1');
    const title=document.getElementById('m02-role-form-title'); if(title) title.textContent='역할 등록';
    const deleteButton=document.getElementById('m02-role-delete-btn'); if(deleteButton) deleteButton.style.display='none';
    renderPermissionTable(permissionRowsForRole(''));
    if(render) renderRoleList();
  }

  function editRole(id){
    const row=(adminData?.roles || []).find(x=>x.id===id); if(!row) return;
    selectedRoleId=id;
    setValue('m02-role-id',row.id); setValue('m02-role-revision',row.revision);
    setValue('m02-role-code',row.code); setValue('m02-role-name',row.name);
    setValue('m02-role-description',row.description || ''); setValue('m02-role-active',row.active?'1':'0');
    const title=document.getElementById('m02-role-form-title');
    if(title) title.textContent='역할 수정';
    const deleteButton=document.getElementById('m02-role-delete-btn');
    if(deleteButton){
      deleteButton.style.display=row.protectedRole?'none':'';
      deleteButton.disabled=Number(row.totalUserCount || 0)>0;
      deleteButton.title=deleteButton.disabled?'먼저 이 역할의 사용자를 다른 역할로 변경해주세요.':'선택한 역할을 삭제합니다.';
    }
    renderPermissionTable(permissionRowsForRole(id), {
      locked:Boolean(row.systemRole),
      viewOnly:false
    });
    renderRoleList();
  }

  function collectPermissions(){
    const body=document.getElementById('m02-permission-body');
    return [...(body?.querySelectorAll('tr[data-menu-code]') || [])].map(tr=>{
      const out={menuCode:tr.dataset.menuCode};
      ACTION_KEYS.forEach(action=>{out[ACTION_FIELDS[action]]=Boolean(tr.querySelector(`[data-action="${action}"]`)?.checked);});
      return out;
    });
  }

  async function saveRole(){
    try{
      ensureAdminAction();
      const id=value('m02-role-id') || null;
      const code=value('m02-role-code').trim() || generateRoleCode();
      setValue('m02-role-code',code);
      const name=value('m02-role-name').trim();
      if(!/^[a-z][a-z0-9_]{2,39}$/.test(code)) throw new Error('내부 역할 코드를 자동 생성하지 못했습니다. 역할 등록을 다시 시작해주세요.');
      if(!name) throw new Error('역할명을 입력해주세요.');
      const saved = await rpc('dbmt_erp_admin_save_role', {
        p_token:sessionToken(), p_id:id, p_code:code, p_name:name,
        p_description:value('m02-role-description').trim() || null,
        p_active:value('m02-role-active')==='1', p_permissions:collectPermissions(),
        p_expected_revision:id ? Number(value('m02-role-revision')) : null
      });
      if(typeof window.toast==='function') window.toast('역할과 메뉴 권한을 저장했습니다.');
      selectedRoleId=saved?.id || id || '';
      await refreshAdmin();
    }catch(err){status('역할 저장 실패: '+friendly(err),true);}
  }

  async function deleteRole(){
    try{
      ensureAdminAction();
      const id=value('m02-role-id');
      const row=(adminData?.roles || []).find(role=>role.id===id);
      if(!row) throw new Error('삭제할 역할을 선택해주세요.');
      if(row.protectedRole) throw new Error('기본 시스템 역할은 삭제할 수 없습니다.');
      if(Number(row.totalUserCount || 0)>0) throw new Error('이 역할에 연결된 사용자를 먼저 다른 역할로 변경해주세요.');
      if(!window.confirm(`역할 '${row.name}'을 삭제할까요?\n저장된 메뉴 권한도 함께 삭제됩니다.`)) return;
      await rpc('dbmt_erp_admin_delete_role', {
        p_token:sessionToken(),
        p_id:id,
        p_expected_revision:Number(value('m02-role-revision'))
      });
      if(typeof window.toast==='function') window.toast('역할을 삭제했습니다.');
      selectedRoleId='';
      await refreshAdmin();
    }catch(err){status('역할 삭제 실패: '+friendly(err),true);}
  }

  async function saveUser(){
    try{
      ensureAdminAction();
      const id=value('m02-user-id') || null;
      const loginId=value('m02-user-login-id').trim();
      const displayName=value('m02-user-name').trim();
      const loginPassword=value('m02-user-password');
      if(!/^[A-Za-z0-9._-]{3,30}$/.test(loginId)) throw new Error('아이디는 영문만으로 3~30자 입력할 수 있습니다. 숫자·점·밑줄·하이픈도 선택적으로 사용할 수 있습니다.');
      if(!displayName) throw new Error('표시 이름을 입력해주세요.');
      if((!id || loginPassword) && !/^\d{4}$/.test(loginPassword)) throw new Error('비밀번호는 숫자 4자리로 입력해주세요.');
      const saved = await rpc('dbmt_erp_admin_save_user', {
        p_token:sessionToken(), p_id:id, p_login_id:loginId,
        p_display_name:displayName, p_role_id:value('m02-user-role'),
        p_login_password:loginPassword || null, p_active:value('m02-user-active')==='1',
        p_expected_revision:id ? Number(value('m02-user-revision')) : null
      });
      if(typeof window.toast==='function') window.toast(id?'사용자 정보를 수정했습니다.':'개인 사용자를 등록했습니다.');
      selectedUserId=saved?.id || id || '';
      setValue('m02-user-password','');
      await refreshAdmin();
    }catch(err){status('사용자 저장 실패: '+friendly(err),true);}
  }

  async function deleteUser(){
    try{
      ensureAdminAction();
      const id=value('m02-user-id');
      const row=(adminData?.users || []).find(user=>user.id===id);
      if(!row) throw new Error('삭제할 사용자를 선택해주세요.');
      if(state.user?.id===row.id) throw new Error('현재 로그인한 계정은 다른 관리자로 로그인한 뒤 삭제해주세요.');
      const role=(adminData?.roles || []).find(item=>item.id===row.roleId);
      if(row.active && role?.systemRole && Number(role.userCount || 0)<=1){
        throw new Error('마지막 활성 시스템관리자는 삭제할 수 없습니다.');
      }
      if(!window.confirm(`사용자 '${row.displayName} · ${row.loginId}'을 삭제할까요?\n해당 사용자의 로그인 세션도 종료됩니다.`)) return;
      await rpc('dbmt_erp_admin_delete_user', {
        p_token:sessionToken(),
        p_id:id,
        p_expected_revision:Number(value('m02-user-revision'))
      });
      if(typeof window.toast==='function') window.toast('사용자를 삭제했습니다.');
      selectedUserId='';
      await refreshAdmin();
    }catch(err){status('사용자 삭제 실패: '+friendly(err),true);}
  }

  function friendly(err){
    const msg=String(err?.message || err || '');
    if(/duplicate key|unique constraint/i.test(msg)) return '이미 사용 중인 코드 또는 아이디입니다.';
    if(/stale .* revision/i.test(msg)) return '다른 화면에서 먼저 수정되었습니다. 서버 새로고침 후 다시 시도해주세요.';
    if(/at least one active system administrator/i.test(msg)) return '활성 시스템 관리자는 최소 1명 유지해야 합니다.';
    if(/active users are assigned/i.test(msg)) return '사용 중인 사용자가 연결된 역할은 중지할 수 없습니다.';
    if(/users are assigned to this role/i.test(msg)) return '사용자가 연결된 역할은 삭제할 수 없습니다. 먼저 사용자의 역할을 변경해주세요.';
    if(/protected role cannot be deleted/i.test(msg)) return '기본 시스템 역할은 삭제할 수 없습니다.';
    if(/protected role cannot be disabled/i.test(msg)) return '기본 시스템 역할은 중지할 수 없습니다.';
    return msg || '알 수 없는 오류입니다.';
  }

  function value(id){return document.getElementById(id)?.value || '';}
  function setValue(id,v){const el=document.getElementById(id);if(el)el.value=v ?? '';}

  const api={
    initializeSession, openLogin, closeLogin, loginFromModal, logoutConfirm,
    can, canAction, requireAction, canOpenPage, isPersonal, getSessionToken, auditIdentity, applyNavigation,
    applyActionPermissions,
    initAdminPage, refreshAdmin, newUser, newRole, editUser, editRole,
    saveUser, deleteUser, saveRole, deleteRole
  };
  window.DBMTAuth=api;

  async function bootstrap(){
    installActionGuards();
    renderHeader();
    applyNavigation();
    applyActionPermissions();
    if(document.body && typeof MutationObserver === 'function'){
      const observer = new MutationObserver(changes=>changes.forEach(change=>change.addedNodes.forEach(node=>{
        if(node?.nodeType === 1) applyActionPermissions(node);
      })));
      observer.observe(document.body, {childList:true, subtree:true});
    }
    const session = await initializeSession();
    if(session?.ok && typeof window.startAuthenticatedErp === 'function'){
      try{
        await window.startAuthenticatedErp();
        closeLogin();
      }catch(err){
        console.error('개인 로그인 ERP 초기화 실패:', err);
        const errorEl=document.getElementById('m02-login-error');
        if(errorEl){errorEl.textContent='서버 자료를 불러오지 못했습니다: '+String(err?.message||err);errorEl.classList.add('show');}
        openLogin();
      }
    }else{
      openLogin();
    }
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',bootstrap);
  else bootstrap();
})();
