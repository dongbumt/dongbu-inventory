-- Personal ERP login: 24 hours from login or the last committed business write.
-- Reads, polling, failed saves and other clients cannot refresh this session.

create or replace function public.dbmt_erp_login(p_login_id text, p_login_password text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $dbmt$
declare
  v_user public.erp_users%rowtype;
  v_token text;
  v_expires timestamptz := now() + interval '24 hours';
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

-- Carry only the validated session hash in transaction-local state. Pool reuse
-- cannot leak it into another request. The existing RPC grants are unchanged.
create or replace function public.dbmt_erp_session_user(p_token text)
returns uuid language plpgsql security definer set search_path='' as $fn$
declare v_user uuid; v_hash text:=encode(extensions.digest(coalesce(p_token,''),'sha256'),'hex');
begin
  select s.user_id into v_user from public.erp_user_sessions s
    join public.erp_users u on u.id=s.user_id and u.active
    join public.erp_roles r on r.id=u.role_id and r.active
    where s.token_hash=v_hash and s.expires_at>now();
  perform set_config('dbmt.erp_session_hash',case when v_user is null then '' else v_hash end,true);
  return v_user;
end;
$fn$;

-- Some newer write RPCs only call this permission helper, rather than the
-- legacy authorization wrapper. Both paths must establish the same identity.
create or replace function public.dbmt_erp_has_permission(p_token text,p_menu_code text,p_action text)
returns boolean language plpgsql security definer set search_path='' as $fn$
declare v_user uuid:=public.dbmt_erp_session_user(p_token);
begin
  return coalesce((select bool_or(case lower(coalesce(p_action,''))
    when 'view' then rp.can_view when 'create' then rp.can_create
    when 'update' then rp.can_update when 'delete' then rp.can_delete
    when 'close' then rp.can_close when 'api_send' then rp.can_api_send
    when 'admin' then rp.can_admin else false end)
    from public.erp_users u join public.erp_role_permissions rp on rp.role_id=u.role_id
    where u.id=v_user and rp.menu_code=p_menu_code),false);
end;
$fn$;

-- Keep the existing callers compatible, but stop writing the session row on
-- reads. last_used_at now records committed business saves instead of polling.
create or replace function erp_session_private.touch_session(p_token text)
returns void language plpgsql security invoker set search_path='' as $fn$
begin
  return;
end;
$fn$;
revoke all on function erp_session_private.touch_session(text) from public,anon,authenticated;

-- Record the actor only when a business row was written. Audit logs, delivery
-- status refreshes and session metadata are deliberately not business activity.
create or replace function erp_session_private.collect_write_session()
returns trigger language plpgsql security invoker set search_path='' as $fn$
declare v_hash text:=current_setting('dbmt.erp_session_hash',true); v_pending jsonb;
begin
  if nullif(v_hash,'') is null then return null; end if;
  if tg_table_schema='public' and tg_table_name='app_data' then
    if tg_op='DELETE' then
      if old.key='dataChangeLogs' then return null; end if;
    elsif new.key='dataChangeLogs' then return null;
    end if;
  end if;
  v_pending:=coalesce(nullif(current_setting('dbmt.erp_write_sessions',true),'')::jsonb,'[]'::jsonb);
  if not v_pending ? v_hash then
    perform set_config('dbmt.erp_write_sessions',(v_pending||jsonb_build_array(v_hash))::text,true);
  end if;
  return null;
end;
$fn$;
revoke all on function erp_session_private.collect_write_session() from public,anon,authenticated;

-- Defer the one session-row write until all business row locks have been
-- acquired. This avoids reversing the save/session lock order across tabs.
-- The renewal rolls back with the save and cannot resurrect revoked sessions.
create or replace function erp_session_private.commit_write_sessions()
returns trigger language plpgsql security definer set search_path='' as $fn$
declare v_pending jsonb; v_at timestamptz:=statement_timestamp();
begin
  v_pending:=coalesce(nullif(current_setting('dbmt.erp_write_sessions',true),'')::jsonb,'[]'::jsonb);
  if v_pending='[]'::jsonb then return null; end if;
  perform set_config('dbmt.erp_write_sessions','[]',true);
  update public.erp_user_sessions s
    set expires_at=greatest(s.expires_at,v_at+interval '24 hours'),
        last_used_at=greatest(s.last_used_at,v_at)
    from public.erp_users u join public.erp_roles r on r.id=u.role_id and r.active
    where u.id=s.user_id and u.active and s.expires_at>now()
      and s.token_hash in (select jsonb_array_elements_text(v_pending));
  return null;
end;
$fn$;
revoke all on function erp_session_private.commit_write_sessions() from public,anon,authenticated;

-- Explicit business-table scope: do not add triggers to authentication,
-- integration caches or audit-only tables. Private ledger writes count too.
do $fn$
declare v_table text;
begin
  foreach v_table in array array[
    'public.app_data','public.transactions','public.production_entries','public.prices',
    'public.submaterial_usages','public.product_specs','public.production_schedule',
    'public.production_board_pages','public.companies','public.business_sites',
    'public.business_site_identifiers','public.business_partners','public.business_partner_aliases',
    'public.business_partner_identifiers','public.document_sender_profiles',
    'public.erp_users','public.erp_roles','public.erp_role_permissions',
    'public.driver_accounts','public.driver_attendance','public.driver_locations',
    'public.mobile_admin_accounts','public.pda_packages','public.pda_package_events',
    'public.label_production_completions','public.label_production_completion_history',
    'public.label_stock_assignments','erp_ledger_private.accounts','erp_ledger_private.entries'
  ] loop
    execute format('create trigger dbmt_collect_write_session after insert or update or delete on %s for each row execute function erp_session_private.collect_write_session()',v_table);
    execute format('create constraint trigger dbmt_commit_write_sessions after insert or update or delete on %s deferrable initially deferred for each row execute function erp_session_private.commit_write_sessions()',v_table);
  end loop;
end;
$fn$;

-- Existing live logins adopt the new duration from their original login time.
-- Already expired/revoked sessions stay expired/revoked.
update public.erp_user_sessions
  set expires_at=greatest(expires_at,created_at+interval '24 hours')
  where expires_at>now() and expires_at<created_at+interval '24 hours';
