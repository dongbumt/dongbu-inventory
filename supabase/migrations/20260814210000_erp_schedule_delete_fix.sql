-- Fix schedule deletion failing while building the JSON change-log summary.

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
    'summary', concat(
      '일정 삭제: ',
      coalesce(v_event->>'date', ''),
      case
        when coalesce(v_event->>'text', '') = '' then ''
        else ' / ' || coalesce(v_event->>'text', '')
      end
    ),
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

revoke all on function public.dbmt_erp_delete_schedule(text, text) from public;
grant execute on function public.dbmt_erp_delete_schedule(text, text) to anon, authenticated;

notify pgrst, 'reload schema';
