-- Run as the database maintainer. All fixture accounts, sessions and logs roll back.
begin;
do $qa$
declare
  v_login text;
  v_id uuid;
  v_result jsonb;
  v_before_hash text;
  v_invalid text;
  v_rejected boolean;
begin
  perform set_config('dbmt.personal_authorized','false',true);
  begin
    perform public.dbmt_mobile_admin_save_account('qa-invalid-password',null,'QA','abc','0123',true);
    raise exception 'QA: unauthorized save was accepted';
  exception when others then
    if sqlerrm <> 'invalid app password' then raise; end if;
  end;
  -- This internal flag is used only by this privileged, rolled-back fixture.
  perform set_config('dbmt.personal_authorized','true',true);
  select 'z'||chr(97+n/26)||chr(97+n%26) into v_login
    from generate_series(0,675) n
    where not exists(select 1 from public.mobile_admin_accounts where lower(login_id)='z'||chr(97+n/26)||chr(97+n%26))
    order by n limit 1;
  if v_login is null then raise exception 'QA: no unused three-letter fixture ID'; end if;
  v_result := public.dbmt_mobile_admin_save_account('',null,'QA short ID',upper(v_login),'0123',true);
  if v_result->>'ok' <> 'true' then raise exception 'QA: three-letter creation failed'; end if;
  v_id := (v_result->>'id')::uuid;
  if (select login_id from public.mobile_admin_accounts where id=v_id) <> v_login then
    raise exception 'QA: lowercase normalization failed';
  end if;
  select pin_hash into v_before_hash from public.mobile_admin_accounts where id=v_id;
  v_result := public.dbmt_mobile_admin_login(upper(v_login),'0123');
  if v_result->>'ok' <> 'true' then raise exception 'QA: three-letter login failed'; end if;
  perform public.dbmt_mobile_admin_save_account('',v_id,'QA edited',v_login,null,true);
  if (select pin_hash from public.mobile_admin_accounts where id=v_id) <> v_before_hash then
    raise exception 'QA: blank PIN changed the existing PIN';
  end if;
  foreach v_invalid in array array['ab',repeat('a',31),'관리자','a b','abc@'] loop
    v_rejected:=false;
    begin
      perform public.dbmt_mobile_admin_save_account('',v_id,'QA',v_invalid,null,true);
    exception when others then
      if sqlerrm <> 'login id must be 3-30 letters, numbers, dot, dash or underscore' then raise; end if;
      v_rejected:=true;
    end;
    if not v_rejected then raise exception 'QA: invalid ID was accepted'; end if;
  end loop;
  v_rejected:=false;
  begin
    perform public.dbmt_mobile_admin_save_account('',v_id,'QA',v_login,'123',true);
  exception when others then
    if sqlerrm <> 'pin must be 4 digits' then raise; end if;
    v_rejected:=true;
  end;
  if not v_rejected then raise exception 'QA: invalid PIN was accepted'; end if;
  perform public.dbmt_mobile_admin_save_account('',v_id,'QA renamed',v_login||'.old_01-x',null,true);
  if exists(select 1 from public.mobile_admin_sessions where account_id=v_id) then
    raise exception 'QA: renaming an ID did not revoke its old session';
  end if;
  v_result := public.dbmt_mobile_admin_login(v_login||'.old_01-x','0123');
  if v_result->>'ok' <> 'true' then raise exception 'QA: legacy-style ID login failed'; end if;
end;
$qa$;
select 'PASS: 3-letter create/login, uppercase normalization, blank PIN preservation, invalid IDs/PINs, authorization and session revocation' as result;
rollback;
