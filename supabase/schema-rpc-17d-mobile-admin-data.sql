-- Read-only ERP snapshot for an authenticated mobile administrator.

create or replace function public.dbmt_mobile_admin_snapshot(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare v_account_id uuid := public.dbmt_mobile_admin_session_account(p_token);
begin
  if v_account_id is null then raise exception '로그인이 만료되었습니다.'; end if;
  update public.mobile_admin_sessions set last_used_at = now()
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');

  return jsonb_build_object(
    'account', (select jsonb_build_object('id', id, 'displayName', display_name,
      'loginId', login_id) from public.mobile_admin_accounts where id = v_account_id),
    'serverTime', now(),
    'transactions', coalesce((select jsonb_agg(raw || jsonb_build_object('id', id)
      order by date nulls last, id) from public.transactions where deleted_at is null), '[]'::jsonb),
    'prod', coalesce((select jsonb_agg(raw || jsonb_build_object('id', id)
      order by work_date nulls last, id) from public.production_entries where deleted_at is null), '[]'::jsonb),
    'appData', coalesce((select jsonb_object_agg(key, payload) from public.app_data
      where key in ('scheduleEvents', 'employees', 'expenseList')), '{}'::jsonb)
  );
end;
$dbmt$;

grant execute on function public.dbmt_mobile_admin_snapshot(text) to anon, authenticated;
notify pgrst, 'reload schema';
