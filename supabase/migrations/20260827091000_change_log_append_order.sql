-- Keep the newest 5,000 ERP audit rows after personal-session append/dedup.

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

revoke all on function public.dbmt_erp_append_change_logs(text,jsonb) from public;
grant execute on function public.dbmt_erp_append_change_logs(text,jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
