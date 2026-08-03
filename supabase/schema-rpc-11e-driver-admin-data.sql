-- Administrator view for attendance and driver-created events.

create or replace function public.dbmt_driver_admin_data(
  p_password text, p_week_start date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare v_week date := coalesce(p_week_start, current_date);
begin
  if not public.dbmt_check_password(p_password) then raise exception 'invalid app password'; end if;
  return jsonb_build_object(
    'accounts', coalesce((select jsonb_agg(to_jsonb(a) - 'password_hash'
      order by a.employee_name) from public.driver_accounts a), '[]'::jsonb),
    'locations', '[]'::jsonb,
    'attendance', coalesce((select jsonb_agg(to_jsonb(x) order by x.start_at desc)
      from (
        select d.*, a.employee_name, a.login_id,
          coalesce(nullif(d.start_location_text,''), sl.name) as start_location_name,
          coalesce(nullif(d.end_location_text,''), el.name) as end_location_name
        from public.driver_attendance d join public.driver_accounts a on a.id = d.account_id
        left join public.driver_locations sl on sl.id = d.start_location_id
        left join public.driver_locations el on el.id = d.end_location_id
        where d.deleted_at is null and d.work_date between v_week and v_week + 6
      ) x), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(to_jsonb(x) order by x.event_at desc)
      from (
        select e.*, a.employee_name, d.work_date
        from public.driver_events e
        join public.driver_attendance d on d.id = e.attendance_id and d.deleted_at is null
        join public.driver_accounts a on a.id = e.account_id
        where d.work_date between v_week and v_week + 6
      ) x), '[]'::jsonb)
  );
end;
$dbmt$;

grant execute on function public.dbmt_driver_admin_data(text, date) to anon, authenticated;
notify pgrst, 'reload schema';
