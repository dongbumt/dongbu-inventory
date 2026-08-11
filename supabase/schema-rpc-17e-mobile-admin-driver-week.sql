-- Read-only delivery driver attendance for a selected week.

create or replace function public.dbmt_mobile_admin_driver_week(
  p_token text, p_week_start date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_account_id uuid := public.dbmt_mobile_admin_session_account(p_token);
  v_week date := coalesce(p_week_start,
    timezone('Asia/Seoul', now())::date
      - extract(isodow from timezone('Asia/Seoul', now()))::integer + 1);
begin
  if v_account_id is null then raise exception '로그인이 만료되었습니다.'; end if;
  update public.mobile_admin_sessions set last_used_at = now()
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');

  return jsonb_build_object(
    'weekStart', v_week,
    'attendance', coalesce((select jsonb_agg(to_jsonb(x) order by x.start_at desc)
      from (
        select d.*, a.employee_name, a.login_id,
          coalesce(nullif(d.start_location_text,''), sl.name) as start_location_name,
          coalesce(nullif(d.end_location_text,''), el.name) as end_location_name
        from public.driver_attendance d
        join public.driver_accounts a on a.id = d.account_id
        left join public.driver_locations sl on sl.id = d.start_location_id
        left join public.driver_locations el on el.id = d.end_location_id
        where d.deleted_at is null and d.work_date between v_week and v_week + 6
      ) x), '[]'::jsonb)
  );
end;
$dbmt$;

grant execute on function public.dbmt_mobile_admin_driver_week(text, date)
  to anon, authenticated;
notify pgrst, 'reload schema';
