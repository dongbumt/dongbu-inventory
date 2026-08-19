-- M02 role expansion, configurable public navigation, and safe role deletion.
-- Public operation is a protected pseudo-role: it controls only anonymous menu
-- visibility and can never be assigned to a personal user.

insert into public.erp_roles(code, name, description, active, system_role)
select 'admin', '관리자', 'ERP 운영 전반을 관리하는 수정 가능한 관리자 역할', true, false
where not exists(select 1 from public.erp_roles where lower(code) = 'admin');

insert into public.erp_roles(code, name, description, active, system_role)
select 'ceo', '대표', '전체 업무를 조회하고 마감할 수 있는 대표 역할', true, false
where not exists(select 1 from public.erp_roles where lower(code) = 'ceo');

insert into public.erp_roles(code, name, description, active, system_role)
select 'public_operator', '공용운영', '개인 로그인 전 공용 화면에 표시할 조회 메뉴', true, false
where not exists(select 1 from public.erp_roles where lower(code) = 'public_operator');

update public.erp_roles
set active = true,
    system_role = false,
    updated_at = now()
where lower(code) = 'public_operator';

insert into public.erp_role_permissions(
  role_id, menu_code, can_view, can_create, can_update, can_delete,
  can_close, can_api_send, can_admin
)
select r.id, c.menu_code, true, true, true, true, true, true, true
from public.erp_roles r
cross join public.erp_permission_catalog c
where lower(r.code) = 'admin'
on conflict (role_id, menu_code) do nothing;

insert into public.erp_role_permissions(
  role_id, menu_code, can_view, can_create, can_update, can_delete,
  can_close, can_api_send, can_admin
)
select r.id, c.menu_code, true, false, false, false, true, false, false
from public.erp_roles r
cross join public.erp_permission_catalog c
where lower(r.code) = 'ceo'
on conflict (role_id, menu_code) do nothing;

insert into public.erp_role_permissions(
  role_id, menu_code, can_view, can_create, can_update, can_delete,
  can_close, can_api_send, can_admin
)
select r.id, c.menu_code,
  c.menu_code in ('schedule', 'stock', 'change_log'),
  false, false, false, false, false, false
from public.erp_roles r
cross join public.erp_permission_catalog c
where lower(r.code) = 'public_operator'
on conflict (role_id, menu_code) do nothing;

create or replace function public.dbmt_erp_reject_public_user_role()
returns trigger
language plpgsql
set search_path = public, extensions
as $dbmt$
begin
  if exists(
    select 1 from public.erp_roles r
    where r.id = new.role_id and lower(r.code) = 'public_operator'
  ) then
    raise exception 'public role cannot be assigned to a user';
  end if;
  return new;
end;
$dbmt$;

drop trigger if exists trg_erp_users_reject_public_role on public.erp_users;
create trigger trg_erp_users_reject_public_role
before insert or update of role_id on public.erp_users
for each row execute function public.dbmt_erp_reject_public_user_role();

create or replace function public.dbmt_erp_public_permissions()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $dbmt$
  select coalesce(jsonb_agg(jsonb_build_object(
    'menuCode', c.menu_code,
    'canView', p.can_view
  ) order by c.sort_order), '[]'::jsonb)
  from public.erp_roles r
  join public.erp_role_permissions p on p.role_id = r.id
  join public.erp_permission_catalog c on c.menu_code = p.menu_code and c.active
  where lower(r.code) = 'public_operator'
    and r.active;
$dbmt$;

create or replace function public.dbmt_m02_get_admin(p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
begin
  if public.dbmt_check_password(p_password) is not true then
    raise exception 'invalid app password';
  end if;
  return jsonb_build_object(
    'schemaVersion', 2,
    'authMode', coalesce((select value from public.app_config where key = 'm02_auth_mode'), 'optional'),
    'catalog', coalesce((
      select jsonb_agg(jsonb_build_object(
        'menuCode', menu_code, 'menuName', menu_name, 'sortOrder', sort_order
      ) order by sort_order)
      from public.erp_permission_catalog where active
    ), '[]'::jsonb),
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'code', r.code, 'name', r.name, 'description', r.description,
        'active', r.active, 'systemRole', r.system_role,
        'protectedRole', (r.system_role or lower(r.code) = 'public_operator'),
        'revision', r.revision,
        'userCount', (select count(*) from public.erp_users u where u.role_id = r.id and u.active),
        'totalUserCount', (select count(*) from public.erp_users u where u.role_id = r.id)
      ) order by r.system_role desc,
        case lower(r.code) when 'admin' then 1 when 'ceo' then 2 when 'public_operator' then 3 else 4 end,
        r.name)
      from public.erp_roles r
    ), '[]'::jsonb),
    'permissions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'roleId', p.role_id, 'menuCode', p.menu_code,
        'canView', p.can_view, 'canCreate', p.can_create,
        'canUpdate', p.can_update, 'canDelete', p.can_delete,
        'canClose', p.can_close, 'canApiSend', p.can_api_send,
        'canAdmin', p.can_admin
      ) order by p.role_id, c.sort_order)
      from public.erp_role_permissions p
      join public.erp_permission_catalog c on c.menu_code = p.menu_code
    ), '[]'::jsonb),
    'users', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', u.id, 'loginId', u.login_id, 'displayName', u.display_name,
        'roleId', u.role_id, 'roleCode', r.code, 'roleName', r.name,
        'active', u.active, 'failedAttempts', u.failed_attempts,
        'lockedUntil', u.locked_until, 'lastLoginAt', u.last_login_at,
        'revision', u.revision, 'createdAt', u.created_at
      ) order by u.active desc, u.display_name, u.login_id)
      from public.erp_users u join public.erp_roles r on r.id = u.role_id
    ), '[]'::jsonb)
  );
end;
$dbmt$;

create or replace function public.dbmt_m02_save_role(
  p_password text,
  p_id uuid,
  p_code text,
  p_name text,
  p_description text,
  p_active boolean,
  p_permissions jsonb,
  p_expected_revision bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_id uuid := p_id;
  v_old public.erp_roles%rowtype;
  v_role public.erp_roles%rowtype;
  v_revision bigint;
begin
  if public.dbmt_check_password(p_password) is not true then raise exception 'invalid app password'; end if;
  if btrim(coalesce(p_code, '')) !~ '^[a-z][a-z0-9_]{2,39}$' then raise exception 'role code is invalid'; end if;
  if btrim(coalesce(p_name, '')) = '' or length(btrim(p_name)) > 100 then raise exception 'role name is required'; end if;
  if jsonb_typeof(coalesce(p_permissions, '[]'::jsonb)) <> 'array' then raise exception 'permissions must be an array'; end if;
  if exists(
    select 1 from jsonb_array_elements(coalesce(p_permissions, '[]'::jsonb)) x
    where not exists(select 1 from public.erp_permission_catalog c where c.menu_code = x->>'menuCode' and c.active)
  ) then raise exception 'unknown menu code'; end if;

  if v_id is null then
    if p_expected_revision is not null then raise exception 'new role must not include revision'; end if;
    if lower(btrim(p_code)) in ('system_admin', 'public_operator') then raise exception 'reserved role code'; end if;
    insert into public.erp_roles(code, name, description, active)
    values (lower(btrim(p_code)), btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), coalesce(p_active, true))
    returning id, revision into v_id, v_revision;
  else
    select * into v_old from public.erp_roles where id = v_id for update;
    if v_old.id is null then raise exception 'role not found'; end if;
    if p_expected_revision is null or p_expected_revision <> v_old.revision then raise exception 'stale role revision'; end if;
    if lower(v_old.code) <> lower(btrim(p_code)) then raise exception 'role code cannot be changed'; end if;
    if (v_old.system_role or lower(v_old.code) = 'public_operator') and p_active is not true then
      raise exception 'protected role cannot be disabled';
    end if;
    if p_active is not true and exists(select 1 from public.erp_users where role_id = v_id and active) then
      raise exception 'active users are assigned to this role';
    end if;
    update public.erp_roles
    set name = btrim(p_name),
        description = nullif(btrim(coalesce(p_description, '')), ''),
        active = case when system_role or lower(code) = 'public_operator' then true else coalesce(p_active, true) end,
        revision = revision + 1,
        updated_at = now()
    where id = v_id and revision = p_expected_revision
    returning revision into v_revision;
    if v_revision is null then raise exception 'stale role revision'; end if;
  end if;

  select * into v_role from public.erp_roles where id = v_id;
  delete from public.erp_role_permissions where role_id = v_id;
  if v_role.system_role then
    insert into public.erp_role_permissions(
      role_id, menu_code, can_view, can_create, can_update, can_delete, can_close, can_api_send, can_admin
    )
    select v_id, menu_code, true, true, true, true, true, true, true
    from public.erp_permission_catalog where active;
  elsif lower(v_role.code) = 'public_operator' then
    insert into public.erp_role_permissions(
      role_id, menu_code, can_view, can_create, can_update, can_delete, can_close, can_api_send, can_admin
    )
    select v_id, x->>'menuCode', coalesce((x->>'canView')::boolean, false),
      false, false, false, false, false, false
    from jsonb_array_elements(coalesce(p_permissions, '[]'::jsonb)) x;
  else
    insert into public.erp_role_permissions(
      role_id, menu_code, can_view, can_create, can_update, can_delete, can_close, can_api_send, can_admin
    )
    select v_id,
      x->>'menuCode',
      coalesce((x->>'canView')::boolean, false),
      coalesce((x->>'canCreate')::boolean, false),
      coalesce((x->>'canUpdate')::boolean, false),
      coalesce((x->>'canDelete')::boolean, false),
      coalesce((x->>'canClose')::boolean, false),
      coalesce((x->>'canApiSend')::boolean, false),
      coalesce((x->>'canAdmin')::boolean, false)
    from jsonb_array_elements(coalesce(p_permissions, '[]'::jsonb)) x;
  end if;

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values ('ERP역할', case when p_id is null then '등록' else '수정' end,
    v_id::text, btrim(p_name),
    jsonb_build_object('code', lower(btrim(p_code)), 'authMode', 'legacy_app_password'));
  return jsonb_build_object('ok', true, 'id', v_id, 'revision', v_revision);
end;
$dbmt$;

create or replace function public.dbmt_m02_delete_role(
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
  v_old public.erp_roles%rowtype;
begin
  if public.dbmt_check_password(p_password) is not true then raise exception 'invalid app password'; end if;
  if p_id is null or p_expected_revision is null then raise exception 'role id and revision are required'; end if;

  select * into v_old from public.erp_roles where id = p_id for update;
  if v_old.id is null then raise exception 'role not found'; end if;
  if v_old.revision <> p_expected_revision then raise exception 'stale role revision'; end if;
  if v_old.system_role or lower(v_old.code) = 'public_operator' then raise exception 'protected role cannot be deleted'; end if;
  if exists(select 1 from public.erp_users where role_id = p_id) then raise exception 'users are assigned to this role'; end if;

  delete from public.erp_roles where id = p_id and revision = p_expected_revision;
  if not found then raise exception 'stale role revision'; end if;

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values ('ERP역할', '삭제', v_old.id::text, v_old.name,
    jsonb_build_object('code', v_old.code, 'active', v_old.active, 'authMode', 'legacy_app_password'));
  return jsonb_build_object('ok', true, 'id', v_old.id);
end;
$dbmt$;

revoke all on function public.dbmt_erp_public_permissions() from public;
revoke all on function public.dbmt_erp_reject_public_user_role() from public, anon, authenticated;
revoke all on function public.dbmt_m02_delete_role(text, uuid, bigint) from public;

grant execute on function public.dbmt_erp_public_permissions() to anon, authenticated;
grant execute on function public.dbmt_m02_delete_role(text, uuid, bigint) to anon, authenticated;

notify pgrst, 'reload schema';
