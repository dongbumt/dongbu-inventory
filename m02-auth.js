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
    'DBMTAuth.newRole':['access_control','admin','uiOnly'],
    'DBMTAuth.saveRole':['access_control','admin','uiOnly'],

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
    saveBulkInbound:['transactions','create'],
    saveBulkOutbound:['transactions','create'],
    saveEditTxn:['transactions','update'],
    loadTxnToForm:['transactions','update'],
    deleteTransaction:['transactions','delete'],

    addProdInputRow:['production','write','uiOnly'],
    addProdOutputRow:['production','write','uiOnly'],
    saveProdEntry:['production','write'],
    openEditProdEntry:['production','update'],
    deleteProdEntry:['production','delete'],
    saveSubMaterialUsageModal:['production','update'],
    deleteSubMaterialUsage:['production','delete'],

    openStockAdjust:['stock','update'],
    saveStockAdjust:['stock','update'],

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
    saveFactorySimScenario:['factory_sim','write'],
    deleteFactorySimScenario:['factory_sim','delete'],
    addFactorySimZone:['factory_sim','create','uiOnly'],
    addFactorySimEquipment:['factory_sim','create','uiOnly'],
    addFactorySimRoute:['factory_sim','create','uiOnly'],

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

  let state = {user:null, permissions:new Map(), authMode:'optional'};
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
    state.authMode = payload?.authMode || 'optional';
    state.permissions = new Map((payload?.permissions || []).map(row=>[row.menuCode, row]));
    renderHeader();
    applyNavigation();
    notifyPermissionSurfaces();
  }

  function clearSession(){
    storeSessionToken('');
    setSession({user:null, permissions:[], authMode:'optional'});
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
      label.textContent = '공용 운영';
    }
  }

  function can(menuCode, action='view'){
    if(!state.user) return action === 'view';
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
    applyActionPermissions();
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
    if(!state.user) return;
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
      if(!token){ setSession({user:null, permissions:[], authMode:'optional'}); return null; }
      try{
        const result = await rpc('dbmt_erp_session', {p_token:token});
        if(!result?.ok){ clearSession(); return null; }
        setSession(result);
        return result;
      }catch(err){
        console.warn('M02 사용자 세션을 확인하지 못했습니다:', err);
        setSession({user:null, permissions:[], authMode:'optional'});
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
    if(!confirm(`${state.user.displayName} 사용자 로그아웃을 할까요?\n공용 ERP 연결은 유지됩니다.`)) return;
    const token = sessionToken();
    clearSession();
    try{if(token) await rpc('dbmt_erp_logout', {p_token:token});}catch(err){console.warn('로그아웃 서버 정리 실패:', err);}
    if(typeof window.toast === 'function') window.toast('개인 사용자 로그아웃을 완료했습니다.');
  }

  function auditIdentity(){
    if(!state.user) return {authMode:'legacy_app_password'};
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

  function adminPassword(){
    if(typeof window.requireSupabasePassword !== 'function') throw new Error('공용 ERP 연결이 필요합니다.');
    return window.requireSupabasePassword();
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
      adminData = await rpc('dbmt_m02_get_admin', {p_password:adminPassword()});
      selectedUserId = adminData.users?.some(x=>x.id===selectedUserId) ? selectedUserId : '';
      selectedRoleId = adminData.roles?.some(x=>x.id===selectedRoleId) ? selectedRoleId : (adminData.roles?.[0]?.id || '');
      renderAdmin();
      status(`병행 운영 · 사용자 ${adminData.users?.length || 0}명 · 역할 ${adminData.roles?.length || 0}개`);
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
    el.innerHTML = (adminData.roles || []).filter(r=>r.active).map(r=>
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
    el.innerHTML = (adminData.roles || []).map(row=>
      `<button type="button" class="m02-list-row ${row.id===selectedRoleId?'active':''} ${row.active?'':'m02-disabled'}" data-role-id="${esc(row.id)}">
        <strong>${esc(row.name)}${row.systemRole?' · 기본 관리자':''}</strong>
        <small>${esc(row.code)} · 사용 중 ${Number(row.userCount || 0)}명 · ${row.active?'사용':'중지'}</small>
      </button>`).join('');
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
    renderUserList();
  }

  function permissionRowsForRole(roleId){
    const byMenu=new Map((adminData?.permissions || []).filter(p=>p.roleId===roleId).map(p=>[p.menuCode,p]));
    return (adminData?.catalog || []).map(menu=>({
      ...menu,
      ...(byMenu.get(menu.menuCode) || {})
    }));
  }

  function renderPermissionTable(rows, locked=false){
    const body=document.getElementById('m02-permission-body'); if(!body) return;
    const allRow=`<tr class="m02-all-row"><td>전체 선택</td>${ACTION_KEYS.map(action=>
      `<td><input type="checkbox" data-all-action="${action}" ${locked?'disabled':''}></td>`).join('')}</tr>`;
    body.innerHTML=allRow+rows.map(row=>`<tr data-menu-code="${esc(row.menuCode)}"><td>${esc(row.menuName)}</td>${ACTION_KEYS.map(action=>{
      const field=ACTION_FIELDS[action];
      return `<td><input type="checkbox" data-action="${action}" ${row[field]?'checked':''} ${locked?'disabled':''}></td>`;
    }).join('')}</tr>`).join('');
    body.querySelectorAll('[data-all-action]').forEach(box=>{
      const action=box.dataset.allAction;
      const targets=[...body.querySelectorAll(`[data-action="${action}"]`)];
      box.checked=targets.length>0 && targets.every(x=>x.checked);
      box.addEventListener('change',()=>targets.forEach(x=>{x.checked=box.checked;}));
      targets.forEach(x=>x.addEventListener('change',()=>{box.checked=targets.every(y=>y.checked);}));
    });
  }

  function newRole(render=true){
    selectedRoleId='';
    setValue('m02-role-id',''); setValue('m02-role-revision',''); setValue('m02-role-code','');
    setValue('m02-role-name',''); setValue('m02-role-description',''); setValue('m02-role-active','1');
    const code=document.getElementById('m02-role-code'); if(code) code.readOnly=false;
    const active=document.getElementById('m02-role-active'); if(active) active.disabled=false;
    const title=document.getElementById('m02-role-form-title'); if(title) title.textContent='역할 등록';
    renderPermissionTable(permissionRowsForRole(''), false);
    if(render) renderRoleList();
  }

  function editRole(id){
    const row=(adminData?.roles || []).find(x=>x.id===id); if(!row) return;
    selectedRoleId=id;
    setValue('m02-role-id',row.id); setValue('m02-role-revision',row.revision);
    setValue('m02-role-code',row.code); setValue('m02-role-name',row.name);
    setValue('m02-role-description',row.description || ''); setValue('m02-role-active',row.active?'1':'0');
    const code=document.getElementById('m02-role-code'); if(code) code.readOnly=true;
    const active=document.getElementById('m02-role-active'); if(active) active.disabled=Boolean(row.systemRole);
    const title=document.getElementById('m02-role-form-title'); if(title) title.textContent='역할 수정';
    renderPermissionTable(permissionRowsForRole(id), Boolean(row.systemRole));
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
      const code=value('m02-role-code').trim();
      const name=value('m02-role-name').trim();
      if(!/^[a-z][a-z0-9_]{2,39}$/.test(code)) throw new Error('역할 코드는 소문자 영문으로 시작하는 3~40자 코드여야 합니다.');
      if(!name) throw new Error('역할명을 입력해주세요.');
      const saved = await rpc('dbmt_m02_save_role', {
        p_password:adminPassword(), p_id:id, p_code:code, p_name:name,
        p_description:value('m02-role-description').trim() || null,
        p_active:value('m02-role-active')==='1', p_permissions:collectPermissions(),
        p_expected_revision:id ? Number(value('m02-role-revision')) : null
      });
      if(typeof window.toast==='function') window.toast('역할과 메뉴 권한을 저장했습니다.');
      selectedRoleId=saved?.id || id || '';
      await refreshAdmin();
    }catch(err){status('역할 저장 실패: '+friendly(err),true);}
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
      const saved = await rpc('dbmt_m02_save_user', {
        p_password:adminPassword(), p_id:id, p_login_id:loginId,
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

  function friendly(err){
    const msg=String(err?.message || err || '');
    if(/duplicate key|unique constraint/i.test(msg)) return '이미 사용 중인 코드 또는 아이디입니다.';
    if(/stale .* revision/i.test(msg)) return '다른 화면에서 먼저 수정되었습니다. 서버 새로고침 후 다시 시도해주세요.';
    if(/at least one active system administrator/i.test(msg)) return '활성 시스템 관리자는 최소 1명 유지해야 합니다.';
    if(/active users are assigned/i.test(msg)) return '사용 중인 사용자가 연결된 역할은 중지할 수 없습니다.';
    if(/invalid app password/i.test(msg)) return '공용 ERP 연동 비밀번호가 맞지 않습니다.';
    return msg || '알 수 없는 오류입니다.';
  }

  function value(id){return document.getElementById(id)?.value || '';}
  function setValue(id,v){const el=document.getElementById(id);if(el)el.value=v ?? '';}

  const api={
    initializeSession, openLogin, closeLogin, loginFromModal, logoutConfirm,
    can, canAction, requireAction, canOpenPage, isPersonal, getSessionToken, auditIdentity, applyNavigation,
    applyActionPermissions,
    initAdminPage, refreshAdmin, newUser, newRole, editUser, editRole, saveUser, saveRole
  };
  window.DBMTAuth=api;

  function bootstrap(){
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
    initializeSession();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',bootstrap);
  else bootstrap();
})();
