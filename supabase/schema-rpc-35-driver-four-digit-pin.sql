-- Apply after the existing driver account and personal ERP login schemas.
-- Changes password-setting validation only. Existing hashes and login rules stay intact.
-- The personal-session wrapper still requires driver_attendance admin permission.
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
  -- Empty passwords preserve existing accounts; all newly set passwords are PINs.
  if (v_id is null or coalesce(p_login_password,'') <> '')
     and coalesce(p_login_password,'') !~ '^[0-9]{4}$' then
    raise exception '비밀번호는 숫자 4자리로 입력해주세요.';
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
