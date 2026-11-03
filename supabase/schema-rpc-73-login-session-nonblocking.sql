-- Session activity is informational; expiry and authorization remain authoritative.
-- Only the optional activity timestamp may be skipped when its row is busy.
create schema if not exists erp_session_private;
revoke all on schema erp_session_private from public, anon, authenticated;

create or replace function erp_session_private.touch_session(p_token text)
returns void
language sql
set search_path = pg_catalog
as $dbmt$
  with available as materialized (
    select s.token_hash
    from public.erp_user_sessions s
    where s.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
      and s.expires_at > now()
      and s.last_used_at < now() - interval '5 minutes'
    for update skip locked
  )
  update public.erp_user_sessions s
  set last_used_at = now()
  from available a
  where s.token_hash = a.token_hash;
$dbmt$;
revoke all on function erp_session_private.touch_session(text) from public, anon, authenticated;

create or replace function public.dbmt_erp_authorize_legacy(
  p_token text, p_menu_code text default null, p_action text default 'view'
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_user_id uuid := public.dbmt_erp_session_user(p_token);
begin
  if v_user_id is null then
    raise exception '개인 사용자 로그인이 만료되었습니다.';
  end if;
  if p_menu_code is not null
     and public.dbmt_erp_has_permission(p_token, p_menu_code, p_action) is not true then
    raise exception '이 작업을 수행할 권한이 없습니다.';
  end if;
  perform set_config('dbmt.personal_authorized', 'true', true);
  perform erp_session_private.touch_session(p_token);
  return v_user_id;
end;
$dbmt$;
revoke all on function public.dbmt_erp_authorize_legacy(text, text, text) from public, anon, authenticated;

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
  perform erp_session_private.touch_session(p_token);
  v_payload := public.dbmt_erp_user_payload(v_user_id);
  return jsonb_build_object('ok', true) || coalesce(v_payload, '{}'::jsonb);
end;
$dbmt$;
revoke all on function public.dbmt_erp_session(text) from public;
grant execute on function public.dbmt_erp_session(text) to anon, authenticated;
