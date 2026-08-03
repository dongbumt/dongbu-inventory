-- Delivery driver attendance - mobile status.

create or replace function public.dbmt_driver_state(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_account_id uuid := public.dbmt_driver_session_account(p_token);
  v_week_start date;
begin
  if v_account_id is null then raise exception '로그인이 만료되었습니다.'; end if;
  update public.driver_sessions set last_used_at = now()
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  v_week_start := timezone('Asia/Seoul', now())::date
    - extract(isodow from timezone('Asia/Seoul', now()))::integer + 1;

  return jsonb_build_object(
    'account', (select jsonb_build_object('id', id, 'employeeName', employee_name,
      'loginId', login_id) from public.driver_accounts where id = v_account_id),
    'serverTime', now(),
    'weekStart', v_week_start,
    'current', (select to_jsonb(x) from (
      select d.*, sl.name as start_location_name
      from public.driver_attendance d
      left join public.driver_locations sl on sl.id = d.start_location_id
      where d.account_id = v_account_id and d.end_at is null
      order by d.start_at desc limit 1
    ) x),
    'weekEntries', coalesce((select jsonb_agg(to_jsonb(x) order by x.start_at desc)
      from (
        select d.*, sl.name as start_location_name, el.name as end_location_name
        from public.driver_attendance d
        left join public.driver_locations sl on sl.id = d.start_location_id
        left join public.driver_locations el on el.id = d.end_location_id
        where d.account_id = v_account_id
          and d.work_date between v_week_start and v_week_start + 6
      ) x), '[]'::jsonb),
    'locations', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'name', name, 'region', region, 'latitude', latitude,
      'longitude', longitude, 'radiusM', radius_m) order by name)
      from public.driver_locations where active), '[]'::jsonb)
  );
end;
$dbmt$;

grant execute on function public.dbmt_driver_state(text) to anon, authenticated;
