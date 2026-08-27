-- Main ERP cutover: personal ERP sessions are now mandatory.
-- Legacy password RPCs remain available for maintenance scripts, while the
-- browser uses permission-checked personal-session wrappers below.

insert into public.app_config(key, value, updated_at)
values ('m02_auth_mode', 'required', now())
on conflict (key) do update set value = excluded.value, updated_at = now();

create or replace function public.dbmt_check_password(p_password text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $dbmt$
  select coalesce(current_setting('dbmt.personal_authorized', true) = 'true', false)
    or coalesce(
      encode(extensions.digest(coalesce(p_password, ''), 'sha256'), 'hex') =
        (select value from public.app_config where key = 'app_password_sha256'),
      false
    );
$dbmt$;

create or replace function public.dbmt_erp_authorize_legacy(
  p_token text,
  p_menu_code text default null,
  p_action text default 'view'
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_user_id uuid := public.dbmt_erp_session_user(p_token);
begin
  if v_user_id is null then
    raise exception '개인 사용자 로그인이 만료되었습니다.';
  end if;
  if p_menu_code is not null
     and public.dbmt_erp_has_permission(p_token, p_menu_code, p_action) is not true then
    raise exception '이 작업을 수행할 권한이 없습니다.';
  end if;
  perform set_config('dbmt.personal_authorized', 'true', true);
  update public.erp_user_sessions
  set last_used_at = now()
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  return v_user_id;
end;
$dbmt$;

create or replace function public.dbmt_erp_get_all(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
begin
  perform public.dbmt_erp_authorize_legacy(p_token, null, 'view');
  return public.dbmt_get_all('');
end;
$dbmt$;

create or replace function public.dbmt_erp_get_submaterial_usages(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
begin
  if public.dbmt_erp_has_permission(p_token, 'submaterials', 'view') is not true
     and public.dbmt_erp_has_permission(p_token, 'production', 'view') is not true then
    raise exception '부자재 사용이력을 조회할 권한이 없습니다.';
  end if;
  perform public.dbmt_erp_authorize_legacy(p_token, null, 'view');
  return public.dbmt_get_submaterial_usages('');
end;
$dbmt$;

create or replace function public.dbmt_erp_save_prices(
  p_token text,
  p_rows jsonb default '[]'::jsonb,
  p_delete_ids jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_rows jsonb := coalesce(p_rows, '[]'::jsonb);
  v_delete_ids jsonb := coalesce(p_delete_ids, '[]'::jsonb);
  v_id text;
begin
  if public.dbmt_erp_session_user(p_token) is null then raise exception '개인 사용자 로그인이 만료되었습니다.'; end if;
  if jsonb_typeof(v_rows) <> 'array' or jsonb_typeof(v_delete_ids) <> 'array' then raise exception '단가 저장 형식이 올바르지 않습니다.'; end if;
  if jsonb_array_length(v_rows) > 500 or jsonb_array_length(v_delete_ids) > 500 then raise exception '단가는 한 번에 500건까지 처리할 수 있습니다.'; end if;
  if exists(select 1 from jsonb_array_elements(v_rows) r where exists(select 1 from public.prices p where p.id = r->>'id'))
     and public.dbmt_erp_has_permission(p_token, 'prices', 'update') is not true then
    raise exception '단가를 수정할 권한이 없습니다.';
  end if;
  if exists(select 1 from jsonb_array_elements(v_rows) r where not exists(select 1 from public.prices p where p.id = r->>'id'))
     and public.dbmt_erp_has_permission(p_token, 'prices', 'create') is not true then
    raise exception '단가를 등록할 권한이 없습니다.';
  end if;
  if jsonb_array_length(v_delete_ids) > 0
     and public.dbmt_erp_has_permission(p_token, 'prices', 'delete') is not true then
    raise exception '단가를 삭제할 권한이 없습니다.';
  end if;
  perform public.dbmt_erp_authorize_legacy(p_token, null, 'view');
  if jsonb_array_length(v_rows) > 0 then perform public.dbmt_upsert_prices('', v_rows); end if;
  for v_id in select value from jsonb_array_elements_text(v_delete_ids) loop
    perform public.dbmt_delete_price('', v_id);
  end loop;
  return jsonb_build_object('ok', true, 'prices', jsonb_array_length(v_rows), 'deleted', jsonb_array_length(v_delete_ids));
end;
$dbmt$;

create or replace function public.dbmt_erp_app_data_menu(p_key text)
returns text
language sql
immutable
as $dbmt$
  select case p_key
    when 'employees' then 'employees'
    when 'leaveRecs' then 'attendance'
    when 'weekendWorkRecs' then 'attendance'
    when 'leaveDeductRecs' then 'attendance'
    when 'docChecks' then 'document_check'
    when 'pgbList' then 'expense_settings'
    when 'expenseList' then 'expenses'
    when 'costCalcHistory' then 'cost_calculator'
    when 'labelTemplates' then 'label'
    when 'workOrders' then 'workorders'
    when 'subMaterialItems' then 'submaterials'
    when 'subMaterialLots' then 'submaterials'
    when 'subMaterialCounts' then 'submaterials'
    when 'factorySimScenarios' then 'factory_sim'
    when 'samsungVendors' then 'samsung'
    when 'coldStorageRequests' then 'cold_storage_request'
    when 'quotationList' then 'quotation'
    else null
  end;
$dbmt$;

create or replace function public.dbmt_erp_save_app_data(p_token text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_user_id uuid := public.dbmt_erp_session_user(p_token);
  v_key text;
  v_value jsonb;
  v_before jsonb;
  v_menu text;
  v_needs_create boolean;
  v_needs_update boolean;
  v_needs_delete boolean;
  v_count integer;
begin
  if v_user_id is null then raise exception '개인 사용자 로그인이 만료되었습니다.'; end if;
  if jsonb_typeof(coalesce(p_payload, '{}'::jsonb)) <> 'object' then raise exception '보조데이터 저장 형식이 올바르지 않습니다.'; end if;
  select count(*) into v_count from jsonb_each(coalesce(p_payload, '{}'::jsonb));
  if v_count > 8 then raise exception '한 번에 저장할 수 있는 보조데이터 종류는 8개입니다.'; end if;

  for v_key, v_value in select key, value from jsonb_each(coalesce(p_payload, '{}'::jsonb)) loop
    v_menu := public.dbmt_erp_app_data_menu(v_key);
    if v_menu is null then raise exception '개인 로그인으로 저장할 수 없는 보조데이터입니다: %', v_key; end if;
    select payload into v_before from public.app_data where key = v_key;
    if v_before is not distinct from v_value then continue; end if;
    v_needs_create := v_before is null;
    v_needs_update := v_before is not null;
    v_needs_delete := false;

    if jsonb_typeof(v_before) = 'array' and jsonb_typeof(v_value) = 'array' then
      v_needs_create := exists(
        select 1 from jsonb_array_elements(v_value) n
        where nullif(n->>'id','') is not null
          and not exists(select 1 from jsonb_array_elements(v_before) o where o->>'id' = n->>'id')
      ) or jsonb_array_length(v_value) > jsonb_array_length(v_before);
      v_needs_delete := exists(
        select 1 from jsonb_array_elements(v_before) o
        where nullif(o->>'id','') is not null
          and not exists(select 1 from jsonb_array_elements(v_value) n where n->>'id' = o->>'id')
      ) or jsonb_array_length(v_value) < jsonb_array_length(v_before);
      v_needs_update := exists(
        select 1 from jsonb_array_elements(v_value) n
        join jsonb_array_elements(v_before) o on o->>'id' = n->>'id'
        where nullif(n->>'id','') is not null and n is distinct from o
      ) or (not v_needs_create and not v_needs_delete);
    end if;

    if v_needs_create and public.dbmt_erp_has_permission(p_token, v_menu, 'create') is not true then
      raise exception '이 데이터를 등록할 권한이 없습니다: %', v_key;
    end if;
    if v_needs_update and public.dbmt_erp_has_permission(p_token, v_menu, 'update') is not true then
      raise exception '이 데이터를 수정할 권한이 없습니다: %', v_key;
    end if;
    if v_needs_delete and public.dbmt_erp_has_permission(p_token, v_menu, 'delete') is not true then
      raise exception '이 데이터를 삭제할 권한이 없습니다: %', v_key;
    end if;
  end loop;

  perform public.dbmt_erp_authorize_legacy(p_token, null, 'view');
  return public.dbmt_import_app_data('', coalesce(p_payload, '{}'::jsonb));
end;
$dbmt$;

create or replace function public.dbmt_erp_append_change_logs(p_token text, p_logs jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_user_id uuid := public.dbmt_erp_session_user(p_token);
  v_existing jsonb;
  v_merged jsonb;
begin
  if v_user_id is null then raise exception '개인 사용자 로그인이 만료되었습니다.'; end if;
  if jsonb_typeof(coalesce(p_logs, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_logs, '[]'::jsonb)) > 100 then
    raise exception '변경이력 저장 형식이 올바르지 않습니다.';
  end if;
  insert into public.app_data(key, payload, updated_at) values('dataChangeLogs', '[]'::jsonb, now()) on conflict(key) do nothing;
  select case when jsonb_typeof(payload) = 'array' then payload else '[]'::jsonb end
  into v_existing from public.app_data where key = 'dataChangeLogs' for update;
  select coalesce(jsonb_agg(row_value order by sort_at desc), '[]'::jsonb)
  into v_merged
  from (
    select row_value, sort_at
    from (
      select distinct on (coalesce(row_value->>'id', md5(row_value::text))) row_value,
        coalesce(row_value->>'at', '') as sort_at
      from jsonb_array_elements(coalesce(p_logs, '[]'::jsonb) || v_existing) rows(row_value)
      order by coalesce(row_value->>'id', md5(row_value::text)), coalesce(row_value->>'at', '') desc
    ) deduplicated
    order by sort_at desc
    limit 5000
  ) merged;
  update public.app_data set payload = v_merged, updated_at = now() where key = 'dataChangeLogs';
  update public.erp_user_sessions set last_used_at = now()
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  return jsonb_build_object('ok', true, 'count', jsonb_array_length(v_merged));
end;
$dbmt$;

create or replace function public.dbmt_erp_admin_get(p_token text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  perform public.dbmt_erp_authorize_legacy(p_token, 'access_control', 'admin');
  return public.dbmt_m02_get_admin('');
end;
$dbmt$;

create or replace function public.dbmt_erp_admin_save_role(
  p_token text, p_id uuid, p_code text, p_name text, p_description text,
  p_active boolean, p_permissions jsonb, p_expected_revision bigint default null
)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  perform public.dbmt_erp_authorize_legacy(p_token, 'access_control', 'admin');
  return public.dbmt_m02_save_role('', p_id, p_code, p_name, p_description, p_active, p_permissions, p_expected_revision);
end;
$dbmt$;

create or replace function public.dbmt_erp_admin_delete_role(p_token text, p_id uuid, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  perform public.dbmt_erp_authorize_legacy(p_token, 'access_control', 'admin');
  return public.dbmt_m02_delete_role('', p_id, p_expected_revision);
end;
$dbmt$;

create or replace function public.dbmt_erp_admin_save_user(
  p_token text, p_id uuid, p_login_id text, p_display_name text, p_role_id uuid,
  p_login_password text default null, p_active boolean default true, p_expected_revision bigint default null
)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  perform public.dbmt_erp_authorize_legacy(p_token, 'access_control', 'admin');
  return public.dbmt_m02_save_user('', p_id, p_login_id, p_display_name, p_role_id, p_login_password, p_active, p_expected_revision);
end;
$dbmt$;

create or replace function public.dbmt_erp_admin_delete_user(p_token text, p_id uuid, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  perform public.dbmt_erp_authorize_legacy(p_token, 'access_control', 'admin');
  return public.dbmt_m02_delete_user('', p_id, p_expected_revision);
end;
$dbmt$;

create or replace function public.dbmt_erp_get_company_master(p_token text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  perform public.dbmt_erp_authorize_legacy(p_token, 'company_master', 'view');
  return public.dbmt_get_company_master('');
end;
$dbmt$;

create or replace function public.dbmt_erp_save_company(p_token text, p_record jsonb, p_expected_revision bigint default null)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  perform public.dbmt_erp_authorize_legacy(p_token, 'company_master', case when p_expected_revision is null then 'create' else 'update' end);
  return public.dbmt_save_company('', p_record, p_expected_revision);
end;
$dbmt$;

create or replace function public.dbmt_erp_save_business_site(p_token text, p_record jsonb, p_expected_revision bigint default null)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  perform public.dbmt_erp_authorize_legacy(p_token, 'company_master', case when p_expected_revision is null then 'create' else 'update' end);
  return public.dbmt_save_business_site('', p_record, p_expected_revision);
end;
$dbmt$;

create or replace function public.dbmt_erp_save_business_site_identifier(p_token text, p_record jsonb, p_expected_revision bigint default null)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  perform public.dbmt_erp_authorize_legacy(p_token, 'company_master', case when p_expected_revision is null then 'create' else 'update' end);
  return public.dbmt_save_business_site_identifier('', p_record, p_expected_revision);
end;
$dbmt$;

create or replace function public.dbmt_erp_save_document_sender_profile(p_token text, p_record jsonb, p_expected_revision bigint default null)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  perform public.dbmt_erp_authorize_legacy(p_token, 'company_master', case when p_expected_revision is null then 'create' else 'update' end);
  return public.dbmt_save_document_sender_profile('', p_record, p_expected_revision);
end;
$dbmt$;

create or replace function public.dbmt_erp_driver_admin_data(p_token text, p_week_start date default null)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  perform public.dbmt_erp_authorize_legacy(p_token, 'driver_attendance', 'view');
  return public.dbmt_driver_admin_data('', p_week_start);
end;
$dbmt$;

create or replace function public.dbmt_erp_driver_admin_save_account(
  p_token text, p_employee_id text, p_employee_name text, p_login_id text,
  p_login_password text default null, p_active boolean default true
)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  perform public.dbmt_erp_authorize_legacy(p_token, 'driver_attendance', 'admin');
  return public.dbmt_driver_admin_save_account('', p_employee_id, p_employee_name, p_login_id, p_login_password, p_active);
end;
$dbmt$;

create or replace function public.dbmt_erp_driver_admin_save_attendance(
  p_token text, p_id uuid, p_account_id uuid, p_start_at timestamptz, p_end_at timestamptz,
  p_start_region text, p_end_region text, p_break_minutes integer,
  p_start_location_text text, p_end_location_text text, p_note text, p_manual_reason text
)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  perform public.dbmt_erp_authorize_legacy(p_token, 'driver_attendance', case when p_id is null then 'create' else 'update' end);
  return public.dbmt_driver_admin_save_attendance('', p_id, p_account_id, p_start_at, p_end_at, p_start_region, p_end_region,
    p_break_minutes, p_start_location_text, p_end_location_text, p_note, p_manual_reason);
end;
$dbmt$;

create or replace function public.dbmt_erp_driver_admin_delete_attendance(p_token text, p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  perform public.dbmt_erp_authorize_legacy(p_token, 'driver_attendance', 'delete');
  return public.dbmt_driver_admin_delete_attendance('', p_id, p_reason);
end;
$dbmt$;

create or replace function public.dbmt_erp_driver_admin_save_location(
  p_token text, p_id uuid, p_name text, p_address text, p_region text,
  p_latitude double precision, p_longitude double precision, p_radius_m integer default 200, p_active boolean default true
)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  perform public.dbmt_erp_authorize_legacy(p_token, 'driver_attendance', 'admin');
  return public.dbmt_driver_admin_save_location('', p_id, p_name, p_address, p_region, p_latitude, p_longitude, p_radius_m, p_active);
end;
$dbmt$;

create or replace function public.dbmt_erp_mobile_admin_accounts(p_token text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  perform public.dbmt_erp_authorize_legacy(p_token, 'mobile_admin', 'admin');
  return public.dbmt_mobile_admin_accounts('');
end;
$dbmt$;

create or replace function public.dbmt_erp_mobile_admin_save_account(
  p_token text, p_id uuid, p_display_name text, p_login_id text,
  p_pin text default null, p_active boolean default true
)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  perform public.dbmt_erp_authorize_legacy(p_token, 'mobile_admin', 'admin');
  return public.dbmt_mobile_admin_save_account('', p_id, p_display_name, p_login_id, p_pin, p_active);
end;
$dbmt$;

create or replace function public.dbmt_erp_get_document_request_logs(p_token text, p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  perform public.dbmt_erp_authorize_legacy(p_token, 'document_check', 'view');
  return public.dbmt_get_document_request_logs('', p_limit);
end;
$dbmt$;

create or replace function public.dbmt_erp_edge_authorized(p_token text, p_menu_code text, p_action text)
returns boolean language sql security definer set search_path=public,extensions as $dbmt$
  select public.dbmt_erp_session_user(p_token) is not null
    and (p_menu_code is null or public.dbmt_erp_has_permission(p_token, p_menu_code, p_action));
$dbmt$;

revoke all on function public.dbmt_erp_authorize_legacy(text,text,text) from public, anon, authenticated;
revoke all on function public.dbmt_erp_app_data_menu(text) from public, anon, authenticated;
revoke all on function public.dbmt_erp_edge_authorized(text,text,text) from public, anon, authenticated;
grant execute on function public.dbmt_erp_edge_authorized(text,text,text) to service_role;

grant execute on function public.dbmt_erp_get_all(text) to anon, authenticated;
grant execute on function public.dbmt_erp_get_submaterial_usages(text) to anon, authenticated;
grant execute on function public.dbmt_erp_save_prices(text,jsonb,jsonb) to anon, authenticated;
grant execute on function public.dbmt_erp_save_app_data(text,jsonb) to anon, authenticated;
grant execute on function public.dbmt_erp_append_change_logs(text,jsonb) to anon, authenticated;
grant execute on function public.dbmt_erp_admin_get(text) to anon, authenticated;
grant execute on function public.dbmt_erp_admin_save_role(text,uuid,text,text,text,boolean,jsonb,bigint) to anon, authenticated;
grant execute on function public.dbmt_erp_admin_delete_role(text,uuid,bigint) to anon, authenticated;
grant execute on function public.dbmt_erp_admin_save_user(text,uuid,text,text,uuid,text,boolean,bigint) to anon, authenticated;
grant execute on function public.dbmt_erp_admin_delete_user(text,uuid,bigint) to anon, authenticated;
grant execute on function public.dbmt_erp_get_company_master(text) to anon, authenticated;
grant execute on function public.dbmt_erp_save_company(text,jsonb,bigint) to anon, authenticated;
grant execute on function public.dbmt_erp_save_business_site(text,jsonb,bigint) to anon, authenticated;
grant execute on function public.dbmt_erp_save_business_site_identifier(text,jsonb,bigint) to anon, authenticated;
grant execute on function public.dbmt_erp_save_document_sender_profile(text,jsonb,bigint) to anon, authenticated;
grant execute on function public.dbmt_erp_driver_admin_data(text,date) to anon, authenticated;
grant execute on function public.dbmt_erp_driver_admin_save_account(text,text,text,text,text,boolean) to anon, authenticated;
grant execute on function public.dbmt_erp_driver_admin_save_attendance(text,uuid,uuid,timestamptz,timestamptz,text,text,integer,text,text,text,text) to anon, authenticated;
grant execute on function public.dbmt_erp_driver_admin_delete_attendance(text,uuid,text) to anon, authenticated;
grant execute on function public.dbmt_erp_driver_admin_save_location(text,uuid,text,text,text,double precision,double precision,integer,boolean) to anon, authenticated;
grant execute on function public.dbmt_erp_mobile_admin_accounts(text) to anon, authenticated;
grant execute on function public.dbmt_erp_mobile_admin_save_account(text,uuid,text,text,text,boolean) to anon, authenticated;
grant execute on function public.dbmt_erp_get_document_request_logs(text,integer) to anon, authenticated;

notify pgrst, 'reload schema';
