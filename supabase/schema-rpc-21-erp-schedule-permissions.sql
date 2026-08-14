-- M02 phase 2: enforce personal create/update/delete permissions for ERP schedules.
-- Schedule array replacement through the legacy generic app-data RPC is blocked;
-- mobile administrators keep using their separate authenticated schedule RPC.

create or replace function public.dbmt_erp_has_permission(
  p_token text, p_menu_code text, p_action text
)
returns boolean
language sql
security definer
set search_path = public, extensions
as $dbmt$
  select coalesce(bool_or(case lower(coalesce(p_action, ''))
    when 'view' then rp.can_view
    when 'create' then rp.can_create
    when 'update' then rp.can_update
    when 'delete' then rp.can_delete
    when 'close' then rp.can_close
    when 'api_send' then rp.can_api_send
    when 'admin' then rp.can_admin
    else false end), false)
  from public.erp_user_sessions s
  join public.erp_users u on u.id = s.user_id and u.active
  join public.erp_roles r on r.id = u.role_id and r.active
  join public.erp_role_permissions rp on rp.role_id = r.id
    and rp.menu_code = p_menu_code
  where s.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and s.expires_at > now();
$dbmt$;

create or replace function public.dbmt_erp_permission_denied(
  p_user_id uuid, p_menu_code text, p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_user public.erp_users%rowtype;
  v_role public.erp_roles%rowtype;
begin
  select * into v_user from public.erp_users where id = p_user_id;
  select * into v_role from public.erp_roles where id = v_user.role_id;
  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values ('권한관리', '거부', p_user_id::text,
    p_menu_code || ' / ' || p_action,
    jsonb_build_object(
      'userId', p_user_id,
      'loginId', v_user.login_id,
      'displayName', v_user.display_name,
      'roleCode', v_role.code,
      'menuCode', p_menu_code,
      'requiredAction', p_action,
      'authMode', 'personal_session'
    ));
  return jsonb_build_object(
    'ok', false,
    'code', 'permission_denied',
    'message', '이 작업을 수행할 권한이 없습니다.'
  );
end;
$dbmt$;

create or replace function public.dbmt_erp_save_schedule(
  p_token text, p_id text, p_date date, p_text text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_user_id uuid := public.dbmt_erp_session_user(p_token);
  v_user public.erp_users%rowtype;
  v_role public.erp_roles%rowtype;
  v_events jsonb;
  v_event jsonb;
  v_previous_event jsonb;
  v_logs jsonb;
  v_log_entry jsonb;
  v_id text := nullif(btrim(coalesce(p_id, '')), '');
  v_required_action text := case when nullif(btrim(coalesce(p_id, '')), '') is null then 'create' else 'update' end;
  v_log_action text := case when nullif(btrim(coalesce(p_id, '')), '') is null then '저장' else '수정' end;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'session_expired', 'message', '개인 사용자 로그인이 만료되었습니다.');
  end if;
  if public.dbmt_erp_has_permission(p_token, 'schedule', v_required_action) is not true then
    return public.dbmt_erp_permission_denied(v_user_id, 'schedule', v_required_action);
  end if;
  if p_date is null then raise exception '일정 날짜를 입력해주세요.'; end if;
  if btrim(coalesce(p_text, '')) = '' then raise exception '일정 내용을 입력해주세요.'; end if;
  if length(btrim(p_text)) > 300 then raise exception '일정 내용은 300자 이내로 입력해주세요.'; end if;

  select * into v_user from public.erp_users where id = v_user_id;
  select * into v_role from public.erp_roles where id = v_user.role_id;

  insert into public.app_data(key, payload, updated_at)
  values ('scheduleEvents', '[]'::jsonb, now())
  on conflict (key) do nothing;
  select case when jsonb_typeof(payload) = 'array' then payload else '[]'::jsonb end
  into v_events from public.app_data where key = 'scheduleEvents' for update;

  if v_id is null then
    v_id := 'schedule_' || encode(extensions.gen_random_bytes(10), 'hex');
    v_event := jsonb_build_object('id', v_id, 'date', p_date::text, 'text', btrim(p_text));
    v_events := v_events || jsonb_build_array(v_event);
  else
    select e into v_previous_event
    from jsonb_array_elements(v_events) as rows(e)
    where e->>'id' = v_id limit 1;
    if v_previous_event is null then
      raise exception '수정할 일정을 찾을 수 없습니다. 새로고침 후 다시 시도해주세요.';
    end if;
    select coalesce(jsonb_agg(
      case when e->>'id' = v_id
        then e || jsonb_build_object('date', p_date::text, 'text', btrim(p_text))
        else e end order by ord
    ), '[]'::jsonb)
    into v_events
    from jsonb_array_elements(v_events) with ordinality as rows(e, ord);
    select e into v_event from jsonb_array_elements(v_events) as rows(e)
    where e->>'id' = v_id limit 1;
  end if;

  update public.app_data set payload = v_events, updated_at = now()
  where key = 'scheduleEvents';

  v_log_entry := jsonb_build_object(
    'id', 'cl_user_' || encode(extensions.gen_random_bytes(8), 'hex'),
    'at', clock_timestamp(),
    'menu', '일정관리',
    'action', v_log_action,
    'target', p_date::text,
    'summary', case
      when v_log_action = '수정' and coalesce(v_previous_event->>'date', '') <> p_date::text
        then '일정 수정: ' || coalesce(v_previous_event->>'date', '') || ' → ' || p_date::text || ' / ' || btrim(p_text)
      else '일정 ' || v_log_action || ': ' || p_date::text || ' / ' || btrim(p_text)
    end,
    'refId', v_id,
    'authMode', 'personal_session',
    'userId', v_user.id,
    'userName', v_user.display_name,
    'userLoginId', v_user.login_id,
    'roleCode', v_role.code,
    'roleName', v_role.name
  );

  insert into public.app_data(key, payload, updated_at)
  values ('dataChangeLogs', '[]'::jsonb, now())
  on conflict (key) do nothing;
  select case when jsonb_typeof(payload) = 'array' then payload else '[]'::jsonb end
  into v_logs from public.app_data where key = 'dataChangeLogs' for update;
  update public.app_data
  set payload = jsonb_build_array(v_log_entry) || v_logs,
      updated_at = now()
  where key = 'dataChangeLogs';

  update public.erp_user_sessions set last_used_at = now()
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values ('일정관리', case when v_required_action = 'create' then '등록' else '수정' end,
    v_id, p_date::text || ' / ' || btrim(p_text),
    jsonb_build_object(
      'userId', v_user.id,
      'loginId', v_user.login_id,
      'displayName', v_user.display_name,
      'roleCode', v_role.code,
      'authMode', 'personal_session',
      'event', v_event
    ));

  return jsonb_build_object('ok', true, 'event', v_event, 'events', v_events, 'logEntry', v_log_entry);
end;
$dbmt$;

create or replace function public.dbmt_erp_delete_schedule(p_token text, p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_user_id uuid := public.dbmt_erp_session_user(p_token);
  v_user public.erp_users%rowtype;
  v_role public.erp_roles%rowtype;
  v_events jsonb;
  v_event jsonb;
  v_logs jsonb;
  v_log_entry jsonb;
  v_id text := nullif(btrim(coalesce(p_id, '')), '');
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'session_expired', 'message', '개인 사용자 로그인이 만료되었습니다.');
  end if;
  if public.dbmt_erp_has_permission(p_token, 'schedule', 'delete') is not true then
    return public.dbmt_erp_permission_denied(v_user_id, 'schedule', 'delete');
  end if;
  if v_id is null then raise exception '삭제할 일정이 없습니다.'; end if;

  select * into v_user from public.erp_users where id = v_user_id;
  select * into v_role from public.erp_roles where id = v_user.role_id;
  select case when jsonb_typeof(payload) = 'array' then payload else '[]'::jsonb end
  into v_events from public.app_data where key = 'scheduleEvents' for update;
  if v_events is null then raise exception '일정 데이터를 찾을 수 없습니다.'; end if;
  select e into v_event from jsonb_array_elements(v_events) as rows(e)
  where e->>'id' = v_id limit 1;
  if v_event is null then raise exception '삭제할 일정을 찾을 수 없습니다. 새로고침 후 다시 시도해주세요.'; end if;

  select coalesce(jsonb_agg(e order by ord), '[]'::jsonb)
  into v_events
  from jsonb_array_elements(v_events) with ordinality as rows(e, ord)
  where e->>'id' <> v_id;
  update public.app_data set payload = v_events, updated_at = now()
  where key = 'scheduleEvents';

  v_log_entry := jsonb_build_object(
    'id', 'cl_user_' || encode(extensions.gen_random_bytes(8), 'hex'),
    'at', clock_timestamp(),
    'menu', '일정관리',
    'action', '삭제',
    'target', coalesce(v_event->>'date', ''),
    'summary', '일정 삭제: ' || coalesce(v_event->>'date', '') ||
      case when coalesce(v_event->>'text', '') = '' then '' else ' / ' || v_event->>'text' end,
    'refId', v_id,
    'authMode', 'personal_session',
    'userId', v_user.id,
    'userName', v_user.display_name,
    'userLoginId', v_user.login_id,
    'roleCode', v_role.code,
    'roleName', v_role.name
  );
  insert into public.app_data(key, payload, updated_at)
  values ('dataChangeLogs', '[]'::jsonb, now())
  on conflict (key) do nothing;
  select case when jsonb_typeof(payload) = 'array' then payload else '[]'::jsonb end
  into v_logs from public.app_data where key = 'dataChangeLogs' for update;
  update public.app_data
  set payload = jsonb_build_array(v_log_entry) || v_logs,
      updated_at = now()
  where key = 'dataChangeLogs';

  update public.erp_user_sessions set last_used_at = now()
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values ('일정관리', '삭제', v_id,
    coalesce(v_event->>'date', '') || ' / ' || coalesce(v_event->>'text', ''),
    jsonb_build_object(
      'userId', v_user.id,
      'loginId', v_user.login_id,
      'displayName', v_user.display_name,
      'roleCode', v_role.code,
      'authMode', 'personal_session',
      'event', v_event
    ));

  return jsonb_build_object('ok', true, 'event', v_event, 'events', v_events, 'logEntry', v_log_entry);
end;
$dbmt$;

-- Schedule changes now require a personal or mobile authenticated RPC. This
-- prevents an old browser from replacing the complete schedule array with the
-- shared ERP password after menu/action permissions have been enabled.
create or replace function public.dbmt_import_app_data(p_password text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  row_count integer := 0;
  payload_keys text[] := array[]::text[];
begin
  if public.dbmt_check_password(p_password) is not true then
    raise exception 'invalid app password';
  end if;
  if coalesce(p_payload, '{}'::jsonb) ? 'scheduleEvents' then
    raise exception '일정 변경은 개인 사용자 로그인이 필요합니다.';
  end if;

  select count(*), coalesce(array_agg(e.key order by e.key), array[]::text[])
  into row_count, payload_keys
  from jsonb_each(coalesce(p_payload, '{}'::jsonb)) as e(key, value);
  if row_count > 8 then
    raise exception 'bulk app data save blocked: refresh the ERP page before saving';
  end if;

  insert into public.app_data(key, payload, updated_at)
  select key, value, now()
  from jsonb_each(coalesce(p_payload, '{}'::jsonb))
  on conflict (key) do update set payload = excluded.payload, updated_at = now();

  insert into public.change_logs(entity, action, summary, payload)
  values ('migration', 'import_app_data', 'App data imported',
    jsonb_build_object('count', row_count, 'keys', to_jsonb(payload_keys)));
  return jsonb_build_object('ok', true, 'appData', row_count, 'keys', to_jsonb(payload_keys));
end;
$dbmt$;

revoke all on function public.dbmt_erp_has_permission(text, text, text) from public, anon, authenticated;
revoke all on function public.dbmt_erp_permission_denied(uuid, text, text) from public, anon, authenticated;
revoke all on function public.dbmt_erp_save_schedule(text, text, date, text) from public;
revoke all on function public.dbmt_erp_delete_schedule(text, text) from public;
grant execute on function public.dbmt_erp_save_schedule(text, text, date, text) to anon, authenticated;
grant execute on function public.dbmt_erp_delete_schedule(text, text) to anon, authenticated;
grant execute on function public.dbmt_import_app_data(text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
