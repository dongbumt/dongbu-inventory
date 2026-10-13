-- All fictional accounts, exclusions and audit records are rolled back.
begin;
do $qa$
declare
  v_suffix text:=left(replace(extensions.gen_random_uuid()::text,'-',''),12);
  v_role uuid;v_user uuid;v_token text;v_result jsonb;v_before jsonb;v_checksum text;v_rejected boolean;
  v_store text;
begin
  v_token:='qa-expense-store-'||v_suffix;
  v_store:='QA 구매처 "<&> '||v_suffix;
  select payload into v_before from public.app_data where key='expenseStoreExclusions';
  v_before:=coalesce(v_before,'[]'::jsonb);
  select md5(payload::text) into v_checksum from public.app_data where key='expenseList';
  insert into public.erp_roles(code,name) values('qa_exp_store_'||v_suffix,'Expense candidate QA') returning id into v_role;
  insert into public.erp_role_permissions(role_id,menu_code,can_view,can_delete) values(v_role,'expenses',true,true);
  insert into public.erp_users(login_id,display_name,password_hash,role_id)
    values('qa_exp_store_'||v_suffix,'Expense candidate QA',extensions.crypt(v_suffix,extensions.gen_salt('bf')),v_role) returning id into v_user;
  insert into public.erp_user_sessions(token_hash,user_id,expires_at)
    values(encode(extensions.digest(v_token,'sha256'),'hex'),v_user,now()+interval '10 minutes');
  perform set_config('role','anon',true);
  assert (public.dbmt_erp_get_expense_store_exclusions('qa-invalid')->>'ok')='false','Unauthenticated read accepted';
  assert (public.dbmt_erp_hide_expense_store('qa-invalid',v_store)->>'ok')='false','Unauthenticated deletion accepted';
  assert public.dbmt_erp_get_expense_store_exclusions(v_token)->'stores'=v_before,'Initial exclusions differ';
  v_result:=public.dbmt_erp_hide_expense_store(v_token,'  '||v_store||'  ');
  assert (v_result->>'ok')='true' and (v_result->'stores' ? v_store),'Deletion/trim failed';
  assert jsonb_array_length(v_result->'stores')=jsonb_array_length(v_before)+1,'Existing exclusions lost';
  v_result:=public.dbmt_erp_hide_expense_store(v_token,v_store);
  assert jsonb_array_length(v_result->'stores')=jsonb_array_length(v_before)+1,'Duplicate exclusion inserted';
  v_result:=public.dbmt_erp_hide_expense_store(v_token,v_store||' 2');
  assert jsonb_array_length(v_result->'stores')=jsonb_array_length(v_before)+2,'Second deletion overwrote the first';
  assert public.dbmt_erp_get_expense_store_exclusions(v_token)->'stores'=v_result->'stores','Reload did not retain deletions';
  foreach v_store in array array['',repeat('a',1001)] loop
    v_rejected:=false;
    begin perform public.dbmt_erp_hide_expense_store(v_token,v_store);
    exception when others then
      if sqlerrm not like '구매처명을%' then raise; end if;
      v_rejected:=true;
    end;
    assert v_rejected,'Invalid name accepted';
  end loop;
  v_rejected:=false;
  begin perform public.dbmt_erp_save_app_data(v_token,'{"expenseStoreExclusions":[]}'::jsonb);
  exception when others then
    if sqlerrm not like '%저장할 수 없는 보조데이터%' then raise; end if;
    v_rejected:=true;
  end;
  assert v_rejected,'Generic expense saves can overwrite exclusions';
  perform set_config('role','postgres',true);
  assert (select md5(payload::text) from public.app_data where key='expenseList') is not distinct from v_checksum,'Historical expense payload changed';
  assert (select count(*) from public.change_logs where action='구매처 후보 삭제' and payload->>'userId'=v_user::text)=2,'Idempotent audit count differs';
  update public.erp_role_permissions set can_delete=false where role_id=v_role;
  assert (public.dbmt_erp_get_expense_store_exclusions(v_token)->>'ok')='true','Read-only lookup failed';
  assert (public.dbmt_erp_hide_expense_store(v_token,'권한 없음')->>'ok')='false','Missing delete permission accepted';
  update public.erp_role_permissions set can_view=false,can_delete=true where role_id=v_role;
  assert (public.dbmt_erp_get_expense_store_exclusions(v_token)->>'ok')='false','Missing view permission accepted';
  assert (public.dbmt_erp_hide_expense_store(v_token,'권한 없음')->>'ok')='false','Missing view permission allowed deletion';
  update public.erp_user_sessions set expires_at=now()-interval '1 minute' where user_id=v_user;
  assert (public.dbmt_erp_get_expense_store_exclusions(v_token)->>'ok')='false','Expired session accepted';
end;
$qa$;
rollback;
select 'PASS: durable/idempotent exclusions, no expense history changes, token/view/delete permissions, expiry, validation, audit and old-client protection; all fixtures rolled back' as result;
