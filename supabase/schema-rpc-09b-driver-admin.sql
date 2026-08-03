-- Delivery driver attendance - administrator read and account management.

create or replace function public.dbmt_driver_admin_data(
  p_password text,
  p_week_start date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_week date := coalesce(p_week_start, current_date);
begin
  if not public.dbmt_check_password(p_password) then
    raise exception 'invalid app password';
  end if;
  return jsonb_build_object(
    'accounts', coalesce((select jsonb_agg(to_jsonb(a) - 'password_hash'
      order by a.employee_name) from public.driver_accounts a), '[]'::jsonb),
    'locations', coalesce((select jsonb_agg(to_jsonb(l) order by l.name)
      from public.driver_locations l), '[]'::jsonb),
    'attendance', coalesce((select jsonb_agg(to_jsonb(x) order by x.start_at desc)
      from (
        select d.*, a.employee_name, a.login_id,
          sl.name as start_location_name, el.name as end_location_name
        from public.driver_attendance d
        join public.driver_accounts a on a.id = d.account_id
        left join public.driver_locations sl on sl.id = d.start_location_id
        left join public.driver_locations el on el.id = d.end_location_id
        where d.work_date between v_week and v_week + 6
      ) x), '[]'::jsonb)
  );
end;
$dbmt$;

create or replace function public.dbmt_driver_admin_save_account(
  p_password text, p_employee_id text, p_employee_name text,
  p_login_id text, p_login_password text default null,
  p_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare v_id uuid;
begin
  if not public.dbmt_check_password(p_password) then
    raise exception 'invalid app password';
  end if;
  if btrim(coalesce(p_employee_id,'')) = '' or btrim(coalesce(p_employee_name,'')) = '' then
    raise exception 'employee is required';
  end if;
  if btrim(coalesce(p_login_id,'')) !~ '^[A-Za-z0-9._-]{4,30}$' then
    raise exception 'login id must be 4-30 letters, numbers, dot, dash or underscore';
  end if;

  select id into v_id from public.driver_accounts where employee_id = p_employee_id;
  if v_id is null and length(coalesce(p_login_password,'')) < 8 then
    raise exception 'new password must be at least 8 characters';
  end if;

  if v_id is null then
    insert into public.driver_accounts(
      employee_id, employee_name, login_id, password_hash, active
    ) values (
      btrim(p_employee_id), btrim(p_employee_name), lower(btrim(p_login_id)),
      extensions.crypt(p_login_password, extensions.gen_salt('bf')), p_active
    ) returning id into v_id;
  else
    update public.driver_accounts set
      employee_name = btrim(p_employee_name), login_id = lower(btrim(p_login_id)),
      password_hash = case when coalesce(p_login_password,'') = '' then password_hash
        else extensions.crypt(p_login_password, extensions.gen_salt('bf')) end,
      active = p_active, failed_attempts = 0, locked_until = null,
      updated_at = now()
    where id = v_id;
  end if;

  delete from public.driver_sessions where account_id = v_id
    and coalesce(p_login_password,'') <> '';
  insert into public.change_logs(entity, action, entity_id, summary)
  values ('배송기사근태', '계정저장', v_id::text, btrim(p_employee_name));
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$dbmt$;

grant execute on function public.dbmt_driver_admin_data(text, date) to anon, authenticated;
grant execute on function public.dbmt_driver_admin_save_account(text, text, text, text, text, boolean)
  to anon, authenticated;
