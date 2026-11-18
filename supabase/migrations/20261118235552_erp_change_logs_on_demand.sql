-- Keep the one-argument RPC for older clients and full-data comparisons.
create or replace function public.dbmt_erp_get_all(p_token text, p_defer_change_logs boolean)
returns json
language plpgsql
security definer
set search_path = ''
as $dbmt$
begin
  if p_defer_change_logs is not true then
    return public.dbmt_erp_get_all(p_token)::json;
  end if;

  perform public.dbmt_erp_authorize_legacy(p_token, null, 'view');

  -- Return JSON to avoid rebuilding the large response as JSONB before serialization.
  return json_build_object(
    'transactions', coalesce((
      select json_agg(raw || jsonb_build_object('id', id) order by date nulls last, id)
      from public.transactions where deleted_at is null
    ), '[]'::json),
    'prod', coalesce((
      select json_agg(raw || jsonb_build_object('id', id) order by work_date nulls last, id)
      from public.production_entries where deleted_at is null
    ), '[]'::json),
    'prices', coalesce((
      select json_agg(raw || jsonb_build_object('id', id) order by product nulls last, trader nulls last, id)
      from public.prices where deleted_at is null
    ), '[]'::json),
    'appData', coalesce((
      select json_object_agg(key, payload) from public.app_data
      where key not in ('labelPrintLogs', 'dataChangeLogs')
    ), '{}'::json),
    'deferredAppData', json_build_array('labelPrintLogs', 'dataChangeLogs')
  );
end;
$dbmt$;

create or replace function public.dbmt_erp_get_change_logs(p_token text)
returns json
language plpgsql
security definer
set search_path = ''
as $dbmt$
declare
  v_logs jsonb;
begin
  if public.dbmt_erp_session_user(p_token) is null then
    raise sqlstate '28000' using message = '개인 사용자 로그인이 만료되었습니다.';
  end if;
  if public.dbmt_erp_has_permission(p_token, 'change_log', 'view') is not true then
    raise insufficient_privilege using message = '변경이력을 조회할 권한이 없습니다.';
  end if;

  select payload into v_logs from public.app_data where key = 'dataChangeLogs';
  if jsonb_typeof(v_logs) is distinct from 'array' then
    v_logs := '[]'::jsonb;
  end if;

  return json_build_object('ok', true, 'logs', v_logs);
end;
$dbmt$;

revoke all on function public.dbmt_erp_get_all(text, boolean) from public, anon, authenticated;
revoke all on function public.dbmt_erp_get_change_logs(text) from public, anon, authenticated;
grant execute on function public.dbmt_erp_get_all(text, boolean) to anon, authenticated;
grant execute on function public.dbmt_erp_get_change_logs(text) to anon, authenticated;

notify pgrst, 'reload schema';
