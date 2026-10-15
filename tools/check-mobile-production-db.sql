-- Privileged verification only. Every fictional account, plan, order and log rolls back.
begin;
do $qa$
declare
  v_suffix text:=left(replace(extensions.gen_random_uuid()::text,'-',''),12);
  v_account uuid;v_token text;v_first uuid;v_second uuid;v_result jsonb;v_record jsonb;v_patch jsonb;
  v_rejected boolean;v_orders jsonb;v_checksum text;v_order_checksum text;v_counts bigint[];v_method text;
begin
  v_token:='qa-mobile-production-'||v_suffix;
  insert into public.mobile_admin_accounts(display_name,login_id,pin_hash)
    values('QA production menus','qa_mp_'||v_suffix,extensions.crypt('0123',extensions.gen_salt('bf'))) returning id into v_account;
  insert into public.mobile_admin_sessions(token_hash,account_id,expires_at)
    values(encode(extensions.digest(v_token,'sha256'),'hex'),v_account,now()+interval '10 minutes');
  select md5(payload::text) into v_checksum from public.app_data where key='workOrders';
  select array[(select count(*) from public.transactions),(select count(*) from public.production_entries)] into v_counts;
  perform set_config('role','anon',true);
  foreach v_method in array array['production_schedule','save_production_schedule','delete_production_schedule','work_orders'] loop
    v_rejected:=false;
    begin
      if v_method='save_production_schedule' then perform public.dbmt_mobile_admin_save_production_schedule('invalid',null,'{}',null);
      elsif v_method='delete_production_schedule' then perform public.dbmt_mobile_admin_delete_production_schedule('invalid',null,1);
      elsif v_method='work_orders' then perform public.dbmt_mobile_admin_work_orders('invalid','2097-01-01','2097-01-21');
      else perform public.dbmt_mobile_admin_production_schedule('invalid','2097-01-01','2097-01-21');end if;
    exception when others then if sqlerrm<>'로그인이 만료되었습니다.' then raise;end if;v_rejected:=true;end;
    assert v_rejected,'Invalid session accepted';
  end loop;
  v_record:='{"date":"2097-01-31","product":"QA 돈등심","qty":null,"trader":"QA 거래처","note":"3mm / 5KG 포장","status":"planned"}'::jsonb;
  v_result:=public.dbmt_mobile_admin_save_production_schedule(v_token,null,v_record,null);
  assert v_result->>'ok'='true' and v_result#>>'{event,qty}' is null,'Optional quantity failed';
  v_first:=(v_result#>>'{event,id}')::uuid;
  v_result:=public.dbmt_mobile_admin_save_production_schedule(v_token,null,v_record||'{"qty":123.45}',null);
  v_second:=(v_result#>>'{event,id}')::uuid;assert v_first<>v_second,'Duplicate plans collapsed';
  v_result:=public.dbmt_mobile_admin_production_schedule(v_token,'2097-01-01','2097-02-06');
  assert exists(select 1 from jsonb_array_elements(v_result->'events') e where e->>'id'=v_first::text),'Saved plan missing';
  v_result:=public.dbmt_mobile_admin_save_production_schedule(v_token,v_first,v_record||'{"date":"2097-02-02","qty":25.5,"status":"completed"}',1);
  assert v_result#>>'{event,revision}'='2' and v_result#>>'{event,status}'='completed','Edit or status failed';
  v_rejected:=false;
  begin perform public.dbmt_mobile_admin_save_production_schedule(v_token,v_first,v_record,1);
  exception when others then if sqlerrm not like '다른 사용자가%' then raise;end if;v_rejected:=true;end;
  assert v_rejected,'Stale edit accepted';
  v_rejected:=false;
  begin perform public.dbmt_mobile_admin_delete_production_schedule(v_token,v_first,1);
  exception when others then if sqlerrm not like '다른 사용자가%' then raise;end if;v_rejected:=true;end;
  assert v_rejected,'Stale delete accepted';
  for v_patch in select value from jsonb_array_elements('[{"product":" "},{"date":"bad"},{"qty":0},{"qty":-1},{"qty":1.234},{"qty":"abc"},{"status":"bad"}]'::jsonb) loop
    v_rejected:=false;
    begin perform public.dbmt_mobile_admin_save_production_schedule(v_token,null,v_record||v_patch,null);
    exception when others then v_rejected:=true;end;
    assert v_rejected,'Invalid production plan accepted';
  end loop;
  v_rejected:=false;
  begin perform public.dbmt_mobile_admin_production_schedule(v_token,'2097-01-01','2097-04-01');
  exception when others then if sqlerrm not like '%최대 63일%' then raise;end if;v_rejected:=true;end;
  assert v_rejected,'Unbounded production range accepted';
  v_rejected:=false;
  begin perform public.dbmt_erp_save_app_data(v_token,'{"workOrders":[]}'::jsonb);
  exception when others then if sqlerrm not like '%개인 사용자 로그인이 만료%' then raise;end if;v_rejected:=true;end;
  assert v_rejected,'Mobile session can overwrite work orders through ERP API';
  v_result:=public.dbmt_mobile_admin_delete_production_schedule(v_token,v_first,2);assert v_result->>'ok'='true','Delete failed';
  perform set_config('role','postgres',true);
  assert not exists(select 1 from public.production_schedule where id=v_first),'Deleted plan retained';
  assert (select revision from public.production_schedule where id=v_second)=1,'Another plan changed';
  assert (select md5(payload::text) from public.app_data where key='workOrders') is not distinct from v_checksum,'Schedule CRUD changed work orders';
  assert (select array[(select count(*) from public.transactions),(select count(*) from public.production_entries)])=v_counts,'Schedule posted stock or actual production';
  select coalesce(payload,'[]'::jsonb) into v_orders from public.app_data where key='workOrders';
  v_orders:=coalesce(v_orders,'[]'::jsonb)||jsonb_build_array(
    jsonb_build_object('id','qa-old-'||v_suffix,'date','2097-01-31','product','QA legacy','sourceStock',jsonb_build_object('product','QA raw 1'),'inputWeight',10),
    jsonb_build_object('id','qa-new-'||v_suffix,'date','2097-02-01','product','QA multiple','sourceInputs',jsonb_build_array(jsonb_build_object('sourceStock',jsonb_build_object('product','QA raw 1'),'inputWeight',10),jsonb_build_object('sourceStock',jsonb_build_object('product','QA raw 2'),'inputWeight',20))));
  insert into public.app_data(key,payload) values('workOrders',v_orders) on conflict(key) do update set payload=excluded.payload;
  v_order_checksum:=md5(v_orders::text);
  perform set_config('role','anon',true);
  v_result:=public.dbmt_mobile_admin_work_orders(v_token,'2097-01-31','2097-02-01');
  assert exists(select 1 from jsonb_array_elements(v_result->'orders') e where e->>'id'='qa-old-'||v_suffix),'Legacy work order missing';
  assert exists(select 1 from jsonb_array_elements(v_result->'orders') e where e->>'id'='qa-new-'||v_suffix and jsonb_array_length(e->'sourceInputs')=2),'Multiple work order inputs missing';
  v_result:=public.dbmt_mobile_admin_work_orders(v_token,'2097-01-31','2097-01-31');
  assert not exists(select 1 from jsonb_array_elements(v_result->'orders') e where e->>'id'='qa-new-'||v_suffix),'Work order date filter failed';
  perform set_config('role','postgres',true);
  assert (select md5(payload::text) from public.app_data where key='workOrders')=v_order_checksum,'Work order read changed payload';
  assert (select count(*) from public.change_logs where payload->>'mobileAdminId'=v_account::text and entity='생산일정')=4,'Mobile audit identity failed';
  update public.mobile_admin_accounts set active=false where id=v_account;
  v_rejected:=false;
  begin perform public.dbmt_mobile_admin_production_schedule(v_token,'2097-01-01','2097-02-06');
  exception when others then if sqlerrm<>'로그인이 만료되었습니다.' then raise;end if;v_rejected:=true;end;
  assert v_rejected,'Inactive account accepted';
  update public.mobile_admin_accounts set active=true where id=v_account;
  update public.mobile_admin_sessions set expires_at=now()-interval '1 minute' where account_id=v_account;
  v_rejected:=false;
  begin perform public.dbmt_mobile_admin_work_orders(v_token,'2097-01-01','2097-02-06');
  exception when others then if sqlerrm<>'로그인이 만료되었습니다.' then raise;end if;v_rejected:=true;end;
  assert v_rejected,'Expired account accepted';
end;
$qa$;
rollback;
select 'PASS: mobile session CRUD, optional qty, PC table parity, revisions, validation, audit, no stock postings, read-only legacy/multiple work orders and session expiry; all fixtures rolled back' as result;
