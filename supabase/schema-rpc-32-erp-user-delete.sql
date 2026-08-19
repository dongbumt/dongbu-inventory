-- M02 safe personal-user deletion.
-- Historical business records and change logs are retained; only the user and
-- that user's short-lived login sessions are removed.

create or replace function public.dbmt_m02_delete_user(
  p_password text,
  p_id uuid,
  p_expected_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_old public.erp_users%rowtype;
  v_system_role boolean := false;
begin
  if public.dbmt_check_password(p_password) is not true then raise exception 'invalid app password'; end if;
  if p_id is null or p_expected_revision is null then raise exception 'user id and revision are required'; end if;

  select * into v_old from public.erp_users where id = p_id for update;
  if v_old.id is null then raise exception 'user not found'; end if;
  if v_old.revision <> p_expected_revision then raise exception 'stale user revision'; end if;

  select r.system_role into v_system_role
  from public.erp_roles r
  where r.id = v_old.role_id;

  if v_old.active and coalesce(v_system_role, false)
     and not exists(
       select 1
       from public.erp_users u
       join public.erp_roles r on r.id = u.role_id
       where u.id <> v_old.id and u.active and r.active and r.system_role
     ) then
    raise exception 'at least one active system administrator is required';
  end if;

  delete from public.erp_users
  where id = p_id and revision = p_expected_revision;
  if not found then raise exception 'stale user revision'; end if;

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values ('ERP사용자', '삭제', v_old.id::text,
    v_old.display_name || ' / ' || v_old.login_id,
    jsonb_build_object(
      'loginId', v_old.login_id,
      'displayName', v_old.display_name,
      'roleId', v_old.role_id,
      'active', v_old.active,
      'authMode', 'legacy_app_password'
    ));
  return jsonb_build_object('ok', true, 'id', v_old.id);
end;
$dbmt$;

revoke all on function public.dbmt_m02_delete_user(text, uuid, bigint) from public;
grant execute on function public.dbmt_m02_delete_user(text, uuid, bigint) to anon, authenticated;

notify pgrst, 'reload schema';
