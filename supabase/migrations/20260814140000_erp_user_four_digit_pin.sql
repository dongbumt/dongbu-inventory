-- M02 usability adjustment: personal ERP users authenticate with a four-digit
-- numeric PIN. No user existed when this migration was prepared, so there is
-- no legacy personal password to invalidate.

create or replace function public.dbmt_erp_login(p_login_id text, p_login_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_user public.erp_users%rowtype;
  v_token text;
  v_expires timestamptz := now() + interval '12 hours';
  v_payload jsonb;
begin
  select * into v_user
  from public.erp_users
  where lower(login_id) = lower(btrim(coalesce(p_login_id, '')))
    and active;

  if v_user.id is null then
    return jsonb_build_object('ok', false, 'message', '아이디 또는 비밀번호가 맞지 않습니다.');
  end if;
  if v_user.locked_until is not null and v_user.locked_until > now() then
    return jsonb_build_object('ok', false, 'message', '로그인이 잠시 제한되었습니다. 15분 후 다시 시도하세요.');
  end if;
  if coalesce(p_login_password, '') !~ '^[0-9]{4}$'
     or v_user.password_hash <> extensions.crypt(coalesce(p_login_password, ''), v_user.password_hash) then
    update public.erp_users
    set failed_attempts = failed_attempts + 1,
        locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' end,
        updated_at = now()
    where id = v_user.id;
    return jsonb_build_object('ok', false, 'message', '아이디 또는 비밀번호가 맞지 않습니다.');
  end if;

  if not exists(select 1 from public.erp_roles where id = v_user.role_id and active) then
    return jsonb_build_object('ok', false, 'message', '사용자 역할이 비활성 상태입니다.');
  end if;

  update public.erp_users
  set failed_attempts = 0,
      locked_until = null,
      last_login_at = now(),
      updated_at = now()
  where id = v_user.id;

  delete from public.erp_user_sessions where expires_at <= now();
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.erp_user_sessions(token_hash, user_id, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_user.id, v_expires);

  v_payload := public.dbmt_erp_user_payload(v_user.id);
  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values ('ERP사용자', '로그인', v_user.id::text, v_user.display_name,
    jsonb_build_object('loginId', v_user.login_id, 'authMode', 'personal_session'));

  return jsonb_build_object('ok', true, 'token', v_token, 'expiresAt', v_expires) || coalesce(v_payload, '{}'::jsonb);
end;
$dbmt$;

create or replace function public.dbmt_m02_save_user(
  p_password text,
  p_id uuid,
  p_login_id text,
  p_display_name text,
  p_role_id uuid,
  p_login_password text default null,
  p_active boolean default true,
  p_expected_revision bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_id uuid := p_id;
  v_old public.erp_users%rowtype;
  v_old_role public.erp_roles%rowtype;
  v_new_role public.erp_roles%rowtype;
  v_revision bigint;
  v_revoke boolean := false;
begin
  if public.dbmt_check_password(p_password) is not true then raise exception 'invalid app password'; end if;
  if btrim(coalesce(p_login_id, '')) !~ '^[A-Za-z0-9._-]{3,30}$' then raise exception 'login id is invalid'; end if;
  if btrim(coalesce(p_display_name, '')) = '' or length(btrim(p_display_name)) > 100 then raise exception 'display name is required'; end if;
  select * into v_new_role from public.erp_roles where id = p_role_id and active for share;
  if v_new_role.id is null then raise exception 'active role is required'; end if;

  if v_id is null then
    if p_expected_revision is not null then raise exception 'new user must not include revision'; end if;
    if coalesce(p_login_password, '') !~ '^[0-9]{4}$' then
      raise exception 'password must contain exactly 4 digits';
    end if;
    insert into public.erp_users(login_id, display_name, password_hash, role_id, active)
    values (lower(btrim(p_login_id)), btrim(p_display_name),
      extensions.crypt(p_login_password, extensions.gen_salt('bf')), p_role_id, coalesce(p_active, true))
    returning id, revision into v_id, v_revision;
  else
    select * into v_old from public.erp_users where id = v_id for update;
    if v_old.id is null then raise exception 'user not found'; end if;
    select * into v_old_role from public.erp_roles where id = v_old.role_id;
    if p_expected_revision is null or p_expected_revision <> v_old.revision then raise exception 'stale user revision'; end if;
    if coalesce(p_login_password, '') <> '' and p_login_password !~ '^[0-9]{4}$' then
      raise exception 'password must contain exactly 4 digits';
    end if;
    if v_old.active and v_old_role.system_role
       and (p_active is not true or not v_new_role.system_role)
       and (select count(*) from public.erp_users u join public.erp_roles r on r.id = u.role_id
            where u.active and r.system_role and u.id <> v_id) = 0 then
      raise exception 'at least one active system administrator is required';
    end if;
    v_revoke := lower(v_old.login_id) <> lower(btrim(p_login_id))
      or v_old.role_id <> p_role_id
      or v_old.active <> coalesce(p_active, true)
      or coalesce(p_login_password, '') <> '';
    update public.erp_users
    set login_id = lower(btrim(p_login_id)),
        display_name = btrim(p_display_name),
        role_id = p_role_id,
        password_hash = case when coalesce(p_login_password, '') = '' then password_hash
          else extensions.crypt(p_login_password, extensions.gen_salt('bf')) end,
        active = coalesce(p_active, true),
        failed_attempts = 0,
        locked_until = null,
        revision = revision + 1,
        updated_at = now()
    where id = v_id and revision = p_expected_revision
    returning revision into v_revision;
    if v_revision is null then raise exception 'stale user revision'; end if;
  end if;

  if v_revoke then delete from public.erp_user_sessions where user_id = v_id; end if;
  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values ('ERP사용자', case when p_id is null then '등록' else '수정' end,
    v_id::text, btrim(p_display_name) || ' / ' || lower(btrim(p_login_id)),
    jsonb_build_object('roleId', p_role_id, 'active', coalesce(p_active, true), 'authMode', 'legacy_app_password'));
  return jsonb_build_object('ok', true, 'id', v_id, 'revision', v_revision);
end;
$dbmt$;

revoke all on function public.dbmt_erp_login(text, text) from public;
revoke all on function public.dbmt_m02_save_user(text, uuid, text, text, uuid, text, boolean, bigint) from public;
grant execute on function public.dbmt_erp_login(text, text) to anon, authenticated;
grant execute on function public.dbmt_m02_save_user(text, uuid, text, text, uuid, text, boolean, bigint) to anon, authenticated;

notify pgrst, 'reload schema';
