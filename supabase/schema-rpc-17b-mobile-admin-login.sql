-- Mobile administrator login. Sessions last 90 days for automatic login.

create or replace function public.dbmt_mobile_admin_login(
  p_login_id text, p_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_account public.mobile_admin_accounts%rowtype;
  v_token text;
  v_expires timestamptz := now() + interval '90 days';
begin
  select * into v_account from public.mobile_admin_accounts
  where lower(login_id) = lower(btrim(coalesce(p_login_id,''))) and active;

  if v_account.id is null then
    return jsonb_build_object('ok', false, 'message', '아이디 또는 비밀번호가 맞지 않습니다.');
  end if;
  if v_account.locked_until is not null and v_account.locked_until > now() then
    return jsonb_build_object('ok', false, 'message', '로그인이 잠시 제한되었습니다. 15분 후 다시 시도하세요.');
  end if;
  if coalesce(p_pin,'') !~ '^[0-9]{4}$'
     or v_account.pin_hash <> extensions.crypt(coalesce(p_pin,''), v_account.pin_hash) then
    update public.mobile_admin_accounts set
      failed_attempts = failed_attempts + 1,
      locked_until = case when failed_attempts + 1 >= 5
        then now() + interval '15 minutes' end,
      updated_at = now()
    where id = v_account.id;
    return jsonb_build_object('ok', false, 'message', '아이디 또는 비밀번호가 맞지 않습니다.');
  end if;

  update public.mobile_admin_accounts set failed_attempts = 0,
    locked_until = null, updated_at = now() where id = v_account.id;
  delete from public.mobile_admin_sessions
    where expires_at <= now() or account_id = v_account.id;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.mobile_admin_sessions(token_hash, account_id, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_account.id, v_expires);

  return jsonb_build_object('ok', true, 'token', v_token,
    'displayName', v_account.display_name, 'expiresAt', v_expires);
end;
$dbmt$;

create or replace function public.dbmt_mobile_admin_logout(p_token text)
returns boolean
language sql
security definer
set search_path = public, extensions
as $dbmt$
  delete from public.mobile_admin_sessions
  where token_hash = encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex')
  returning true;
$dbmt$;

grant execute on function public.dbmt_mobile_admin_login(text, text) to anon, authenticated;
grant execute on function public.dbmt_mobile_admin_logout(text) to anon, authenticated;
notify pgrst, 'reload schema';
