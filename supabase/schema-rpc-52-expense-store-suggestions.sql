-- Candidate exclusions are separate from expenseList. Old clients and ordinary
-- expense saves cannot overwrite this key through dbmt_erp_save_app_data.
create or replace function public.dbmt_erp_get_expense_store_exclusions(p_token text)
returns jsonb language plpgsql security definer set search_path='' as $dbmt$
declare
  v_user uuid:=public.dbmt_erp_session_user(p_token);
  v_stores jsonb;
begin
  if v_user is null then return jsonb_build_object('ok',false,'message','개인 사용자 로그인이 만료되었습니다.'); end if;
  if public.dbmt_erp_has_permission(p_token,'expenses','view') is not true then
    return public.dbmt_erp_permission_denied(v_user,'expenses','view');
  end if;
  select payload into v_stores from public.app_data where key='expenseStoreExclusions';
  return jsonb_build_object('ok',true,'stores',coalesce(v_stores,'[]'::jsonb));
end;
$dbmt$;

create or replace function public.dbmt_erp_hide_expense_store(p_token text,p_store text)
returns jsonb language plpgsql security definer set search_path='' as $dbmt$
declare
  v_user uuid:=public.dbmt_erp_session_user(p_token);
  v_store text:=btrim(coalesce(p_store,''));
  v_stores jsonb;
begin
  if v_user is null then return jsonb_build_object('ok',false,'message','개인 사용자 로그인이 만료되었습니다.'); end if;
  if public.dbmt_erp_has_permission(p_token,'expenses','view') is not true then
    return public.dbmt_erp_permission_denied(v_user,'expenses','view');
  end if;
  if public.dbmt_erp_has_permission(p_token,'expenses','delete') is not true then
    return public.dbmt_erp_permission_denied(v_user,'expenses','delete');
  end if;
  if length(v_store) not between 1 and 1000 then raise exception '구매처명을 1~1000자 이내로 입력해주세요.'; end if;
  insert into public.app_data(key,payload) values('expenseStoreExclusions','[]'::jsonb) on conflict(key) do nothing;
  -- Serialize additions so different users can remove candidates concurrently.
  select payload into v_stores from public.app_data where key='expenseStoreExclusions' for update;
  if not (v_stores ? v_store) then
    v_stores:=v_stores||jsonb_build_array(v_store);
    update public.app_data set payload=v_stores,updated_at=clock_timestamp() where key='expenseStoreExclusions';
    insert into public.change_logs(entity,action,entity_id,summary,payload)
    values('지출관리','구매처 후보 삭제',v_store,'구매처 후보 삭제: '||v_store,
      jsonb_build_object('userId',v_user,'authMode','personal_session','store',v_store,'expenseHistoryChanged',false));
  end if;
  return jsonb_build_object('ok',true,'stores',v_stores);
end;
$dbmt$;

revoke all on function public.dbmt_erp_get_expense_store_exclusions(text) from public,anon,authenticated;
revoke all on function public.dbmt_erp_hide_expense_store(text,text) from public,anon,authenticated;
grant execute on function public.dbmt_erp_get_expense_store_exclusions(text) to anon,authenticated;
grant execute on function public.dbmt_erp_hide_expense_store(text,text) to anon,authenticated;
notify pgrst,'reload schema';
