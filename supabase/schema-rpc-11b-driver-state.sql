-- Mobile state without a fixed work-location requirement.

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
    'current', (select to_jsonb(d) from public.driver_attendance d
      where d.account_id = v_account_id and d.end_at is null and d.deleted_at is null
      order by d.start_at desc limit 1),
    'activeBreak', coalesce((select e.event_type = 'lunch_start'
      from public.driver_events e join public.driver_attendance d on d.id = e.attendance_id
      where d.account_id = v_account_id and d.end_at is null and d.deleted_at is null
        and e.event_type in ('lunch_start', 'lunch_end')
      order by e.event_at desc limit 1), false),
    'weekEntries', coalesce((select jsonb_agg(to_jsonb(d) order by d.start_at desc)
      from public.driver_attendance d where d.account_id = v_account_id
        and d.deleted_at is null and d.work_date between v_week_start and v_week_start + 6), '[]'::jsonb),
    'todayEvents', coalesce((select jsonb_agg(to_jsonb(e) order by e.event_at desc)
      from public.driver_events e join public.driver_attendance d on d.id = e.attendance_id
      where e.account_id = v_account_id and d.deleted_at is null
        and d.work_date = timezone('Asia/Seoul', now())::date), '[]'::jsonb)
  );
end;
$dbmt$;

grant execute on function public.dbmt_driver_state(text) to anon, authenticated;
notify pgrst, 'reload schema';
