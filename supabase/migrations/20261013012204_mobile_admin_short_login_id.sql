-- Permit three-character IDs, including letters-only IDs, without changing
-- existing accounts, PIN validation, authorization or session revocation.
create or replace function public.dbmt_mobile_admin_save_account(
  p_password text, p_id uuid, p_display_name text, p_login_id text,
  p_pin text default null, p_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_id uuid := p_id;
  v_old public.mobile_admin_accounts%rowtype;
  v_revoke boolean := false;
begin
  if not public.dbmt_check_password(p_password) then raise exception 'invalid app password'; end if;
  if btrim(coalesce(p_display_name,'')) = '' then raise exception 'display name is required'; end if;
  if btrim(coalesce(p_login_id,'')) !~ '^[A-Za-z0-9._-]{3,30}$' then
    raise exception 'login id must be 3-30 letters, numbers, dot, dash or underscore';
  end if;

  if v_id is null then
    if coalesce(p_pin,'') !~ '^[0-9]{4}$' then raise exception 'pin must be 4 digits'; end if;
    insert into public.mobile_admin_accounts(display_name, login_id, pin_hash, active)
    values (btrim(p_display_name), lower(btrim(p_login_id)),
      extensions.crypt(p_pin, extensions.gen_salt('bf')), p_active)
    returning id into v_id;
  else
    select * into v_old from public.mobile_admin_accounts where id = v_id;
    if v_old.id is null then raise exception 'account not found'; end if;
    if coalesce(p_pin,'') <> '' and p_pin !~ '^[0-9]{4}$' then raise exception 'pin must be 4 digits'; end if;
    v_revoke := coalesce(p_pin,'') <> ''
      or lower(v_old.login_id) <> lower(btrim(p_login_id)) or v_old.active <> p_active;
    update public.mobile_admin_accounts set
      display_name = btrim(p_display_name), login_id = lower(btrim(p_login_id)),
      pin_hash = case when coalesce(p_pin,'') = '' then pin_hash
        else extensions.crypt(p_pin, extensions.gen_salt('bf')) end,
      active = p_active, failed_attempts = 0, locked_until = null, updated_at = now()
    where id = v_id;
  end if;

  if v_revoke then delete from public.mobile_admin_sessions where account_id = v_id; end if;
  insert into public.change_logs(entity, action, entity_id, summary)
  values ('모바일관리자', case when p_id is null then '계정등록' else '계정수정' end,
    v_id::text, btrim(p_display_name) || ' / ' || lower(btrim(p_login_id)));
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$dbmt$;

notify pgrst, 'reload schema';
