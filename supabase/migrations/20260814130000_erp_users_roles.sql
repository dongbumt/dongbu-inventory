-- M02 ERP users, roles, menu permissions and short-lived browser sessions.
-- Safe rollout: personal login is optional and the existing ERP app password
-- remains the transport credential for legacy RPC functions.

create table if not exists public.erp_permission_catalog (
  menu_code text primary key,
  menu_name text not null,
  sort_order integer not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint erp_permission_catalog_code_chk
    check (menu_code ~ '^[a-z][a-z0-9_]{1,49}$'),
  constraint erp_permission_catalog_name_chk
    check (btrim(menu_name) <> '')
);

create table if not exists public.erp_roles (
  id uuid primary key default extensions.gen_random_uuid(),
  code text not null,
  name text not null,
  description text,
  active boolean not null default true,
  system_role boolean not null default false,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint erp_roles_code_chk check (code ~ '^[a-z][a-z0-9_]{2,39}$'),
  constraint erp_roles_name_chk check (btrim(name) <> ''),
  constraint erp_roles_revision_chk check (revision >= 1)
);

create unique index if not exists idx_erp_roles_code
  on public.erp_roles(lower(code));

create table if not exists public.erp_role_permissions (
  role_id uuid not null references public.erp_roles(id) on delete cascade,
  menu_code text not null references public.erp_permission_catalog(menu_code) on delete restrict,
  can_view boolean not null default false,
  can_create boolean not null default false,
  can_update boolean not null default false,
  can_delete boolean not null default false,
  can_close boolean not null default false,
  can_api_send boolean not null default false,
  can_admin boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (role_id, menu_code)
);

create table if not exists public.erp_users (
  id uuid primary key default extensions.gen_random_uuid(),
  login_id text not null,
  display_name text not null,
  password_hash text not null,
  role_id uuid not null references public.erp_roles(id) on delete restrict,
  active boolean not null default true,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint erp_users_login_id_chk
    check (login_id ~ '^[A-Za-z0-9._-]{3,30}$'),
  constraint erp_users_display_name_chk check (btrim(display_name) <> ''),
  constraint erp_users_failed_attempts_chk check (failed_attempts >= 0),
  constraint erp_users_revision_chk check (revision >= 1)
);

create unique index if not exists idx_erp_users_login_id
  on public.erp_users(lower(login_id));
create index if not exists idx_erp_users_role on public.erp_users(role_id);

create table if not exists public.erp_user_sessions (
  token_hash text primary key,
  user_id uuid not null references public.erp_users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create index if not exists idx_erp_user_sessions_user
  on public.erp_user_sessions(user_id);
create index if not exists idx_erp_user_sessions_expiry
  on public.erp_user_sessions(expires_at);

insert into public.erp_permission_catalog(menu_code, menu_name, sort_order)
values
  ('schedule', '일정관리', 10),
  ('company_master', '법인·사업장·창고', 20),
  ('access_control', '사용자·역할·권한', 30),
  ('label_products', '품목관리', 40),
  ('traders', '거래처 관리', 50),
  ('samsung', '삼성웰스토리', 60),
  ('transactions', '거래내역', 70),
  ('production', '생산일보', 80),
  ('production_loss', '생산 로스율', 90),
  ('stock', '재고현황', 100),
  ('cold_storage_request', '냉동창고 요청', 110),
  ('submaterials', '부자재 관리', 120),
  ('prices', '단가표', 130),
  ('workorders', '작업지시', 140),
  ('label', '라벨출력', 150),
  ('label_print', '라벨전용', 160),
  ('expense_settings', '경비 설정', 170),
  ('cost_calculator', '원가계산기', 180),
  ('cost_compare', '생산원가비교', 190),
  ('quotation', '견적서 작성', 200),
  ('invoice', '거래명세서', 210),
  ('inbound_inspection', '입고검사일지', 220),
  ('shipment_log', '출고일지', 230),
  ('document_check', '서류체크', 240),
  ('employees', '직원정보', 250),
  ('attendance', '근태관리', 260),
  ('driver_attendance', '배송기사근태', 270),
  ('mobile_admin', '모바일 관리자', 280),
  ('expenses', '지출관리', 290),
  ('import', '엑셀 가져오기', 300),
  ('factory_sim', '확장공장 시뮬레이터', 310),
  ('change_log', '변경이력', 320)
on conflict (menu_code) do update
set menu_name = excluded.menu_name,
    sort_order = excluded.sort_order,
    active = true,
    updated_at = now();

insert into public.erp_roles(code, name, description, active, system_role)
select 'system_admin', '시스템 관리자', '모든 ERP 메뉴와 동작을 관리하는 기본 역할', true, true
where not exists(select 1 from public.erp_roles where lower(code) = 'system_admin');

update public.erp_roles
set name = '시스템 관리자',
    description = '모든 ERP 메뉴와 동작을 관리하는 기본 역할',
    active = true,
    system_role = true,
    updated_at = now()
where lower(code) = 'system_admin';

insert into public.erp_role_permissions(
  role_id, menu_code, can_view, can_create, can_update, can_delete,
  can_close, can_api_send, can_admin
)
select r.id, c.menu_code, true, true, true, true, true, true, true
from public.erp_roles r
cross join public.erp_permission_catalog c
where r.code = 'system_admin'
on conflict (role_id, menu_code) do update
set can_view = true,
    can_create = true,
    can_update = true,
    can_delete = true,
    can_close = true,
    can_api_send = true,
    can_admin = true,
    updated_at = now();

insert into public.app_config(key, value)
values ('m02_auth_mode', 'optional')
on conflict (key) do nothing;

alter table public.erp_permission_catalog enable row level security;
alter table public.erp_roles enable row level security;
alter table public.erp_role_permissions enable row level security;
alter table public.erp_users enable row level security;
alter table public.erp_user_sessions enable row level security;

revoke all on public.erp_permission_catalog, public.erp_roles,
  public.erp_role_permissions, public.erp_users, public.erp_user_sessions
  from public, anon, authenticated;

create or replace function public.dbmt_erp_session_user(p_token text)
returns uuid
language sql
security definer
set search_path = public, extensions
as $dbmt$
  select s.user_id
  from public.erp_user_sessions s
  join public.erp_users u on u.id = s.user_id and u.active
  join public.erp_roles r on r.id = u.role_id and r.active
  where s.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and s.expires_at > now();
$dbmt$;

create or replace function public.dbmt_erp_user_payload(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = public, extensions
as $dbmt$
  select jsonb_build_object(
    'user', jsonb_build_object(
      'id', u.id,
      'loginId', u.login_id,
      'displayName', u.display_name,
      'roleId', r.id,
      'roleCode', r.code,
      'roleName', r.name
    ),
    'permissions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'menuCode', p.menu_code,
        'canView', p.can_view,
        'canCreate', p.can_create,
        'canUpdate', p.can_update,
        'canDelete', p.can_delete,
        'canClose', p.can_close,
        'canApiSend', p.can_api_send,
        'canAdmin', p.can_admin
      ) order by c.sort_order)
      from public.erp_role_permissions p
      join public.erp_permission_catalog c on c.menu_code = p.menu_code and c.active
      where p.role_id = r.id
    ), '[]'::jsonb),
    'authMode', coalesce((select value from public.app_config where key = 'm02_auth_mode'), 'optional')
  )
  from public.erp_users u
  join public.erp_roles r on r.id = u.role_id
  where u.id = p_user_id and u.active and r.active;
$dbmt$;

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
  if length(coalesce(p_login_password, '')) < 8
     or length(coalesce(p_login_password, '')) > 64
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

create or replace function public.dbmt_erp_session(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_user_id uuid := public.dbmt_erp_session_user(p_token);
  v_payload jsonb;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'message', '사용자 로그인이 만료되었습니다.');
  end if;
  update public.erp_user_sessions
  set last_used_at = now()
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  v_payload := public.dbmt_erp_user_payload(v_user_id);
  return jsonb_build_object('ok', true) || coalesce(v_payload, '{}'::jsonb);
end;
$dbmt$;

create or replace function public.dbmt_erp_logout(p_token text)
returns boolean
language sql
security definer
set search_path = public, extensions
as $dbmt$
  delete from public.erp_user_sessions
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
  returning true;
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
    'schemaVersion', 1,
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
        'active', r.active, 'systemRole', r.system_role, 'revision', r.revision,
        'userCount', (select count(*) from public.erp_users u where u.role_id = r.id and u.active)
      ) order by r.system_role desc, r.name)
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
    insert into public.erp_roles(code, name, description, active)
    values (btrim(p_code), btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), coalesce(p_active, true))
    returning id, revision into v_id, v_revision;
  else
    select * into v_old from public.erp_roles where id = v_id for update;
    if v_old.id is null then raise exception 'role not found'; end if;
    if p_expected_revision is null or p_expected_revision <> v_old.revision then raise exception 'stale role revision'; end if;
    if lower(v_old.code) <> lower(btrim(p_code)) then raise exception 'role code cannot be changed'; end if;
    if v_old.system_role and p_active is not true then raise exception 'system role cannot be disabled'; end if;
    if p_active is not true and exists(select 1 from public.erp_users where role_id = v_id and active) then
      raise exception 'active users are assigned to this role';
    end if;
    update public.erp_roles
    set name = btrim(p_name),
        description = nullif(btrim(coalesce(p_description, '')), ''),
        active = case when system_role then true else coalesce(p_active, true) end,
        revision = revision + 1,
        updated_at = now()
    where id = v_id and revision = p_expected_revision
    returning revision into v_revision;
    if v_revision is null then raise exception 'stale role revision'; end if;
  end if;

  delete from public.erp_role_permissions where role_id = v_id;
  if exists(select 1 from public.erp_roles where id = v_id and system_role) then
    insert into public.erp_role_permissions(
      role_id, menu_code, can_view, can_create, can_update, can_delete, can_close, can_api_send, can_admin
    )
    select v_id, menu_code, true, true, true, true, true, true, true
    from public.erp_permission_catalog where active;
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
    jsonb_build_object('code', btrim(p_code), 'authMode', 'legacy_app_password'));
  return jsonb_build_object('ok', true, 'id', v_id, 'revision', v_revision);
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
    if length(coalesce(p_login_password, '')) < 8 or length(coalesce(p_login_password, '')) > 64 then
      raise exception 'password must contain 8 to 64 characters';
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
    if coalesce(p_login_password, '') <> ''
       and (length(p_login_password) < 8 or length(p_login_password) > 64) then
      raise exception 'password must contain 8 to 64 characters';
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

revoke all on function public.dbmt_erp_session_user(text) from public, anon, authenticated;
revoke all on function public.dbmt_erp_user_payload(uuid) from public, anon, authenticated;
revoke all on function public.dbmt_erp_login(text, text) from public;
revoke all on function public.dbmt_erp_session(text) from public;
revoke all on function public.dbmt_erp_logout(text) from public;
revoke all on function public.dbmt_m02_get_admin(text) from public;
revoke all on function public.dbmt_m02_save_role(text, uuid, text, text, text, boolean, jsonb, bigint) from public;
revoke all on function public.dbmt_m02_save_user(text, uuid, text, text, uuid, text, boolean, bigint) from public;

grant execute on function public.dbmt_erp_login(text, text) to anon, authenticated;
grant execute on function public.dbmt_erp_session(text) to anon, authenticated;
grant execute on function public.dbmt_erp_logout(text) to anon, authenticated;
grant execute on function public.dbmt_m02_get_admin(text) to anon, authenticated;
grant execute on function public.dbmt_m02_save_role(text, uuid, text, text, text, boolean, jsonb, bigint) to anon, authenticated;
grant execute on function public.dbmt_m02_save_user(text, uuid, text, text, uuid, text, boolean, bigint) to anon, authenticated;

notify pgrst, 'reload schema';
