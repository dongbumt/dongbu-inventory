-- Delivery driver attendance - mobile login and session validation.

create or replace function public.dbmt_driver_session_account(p_token text)
returns uuid
language sql
security definer
set search_path = public, extensions
as $dbmt$
  select s.account_id
  from public.driver_sessions s
  join public.driver_accounts a on a.id = s.account_id and a.active
  where s.token_hash = encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex')
    and s.expires_at > now();
$dbmt$;

revoke all on function public.dbmt_driver_session_account(text)
  from public, anon, authenticated;

create or replace function public.dbmt_driver_login(p_login_id text, p_login_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_account public.driver_accounts%rowtype;
  v_token text;
begin
  select * into v_account from public.driver_accounts
  where lower(login_id) = lower(btrim(coalesce(p_login_id,''))) and active;
  if v_account.id is null then
    return jsonb_build_object('ok', false, 'message', '아이디 또는 비밀번호가 맞지 않습니다.');
  end if;
  if v_account.locked_until is not null and v_account.locked_until > now() then
    return jsonb_build_object('ok', false, 'message', '로그인이 잠시 제한되었습니다. 관리자에게 문의하세요.');
  end if;
  if v_account.password_hash <> extensions.crypt(coalesce(p_login_password,''), v_account.password_hash) then
    update public.driver_accounts set
      failed_attempts = failed_attempts + 1,
      locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' end,
      updated_at = now()
    where id = v_account.id;
    return jsonb_build_object('ok', false, 'message', '아이디 또는 비밀번호가 맞지 않습니다.');
  end if;

  update public.driver_accounts set failed_attempts = 0, locked_until = null,
    updated_at = now() where id = v_account.id;
  delete from public.driver_sessions where expires_at <= now()
    or account_id = v_account.id;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.driver_sessions(token_hash, account_id, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'),
    v_account.id, now() + interval '30 days');
  return jsonb_build_object('ok', true, 'token', v_token,
    'employeeName', v_account.employee_name,
    'expiresAt', now() + interval '30 days');
end;
$dbmt$;

create or replace function public.dbmt_driver_logout(p_token text)
returns boolean
language sql
security definer
set search_path = public, extensions
as $dbmt$
  delete from public.driver_sessions
  where token_hash = encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex')
  returning true;
$dbmt$;

grant execute on function public.dbmt_driver_login(text, text) to anon, authenticated;
grant execute on function public.dbmt_driver_logout(text) to anon, authenticated;
