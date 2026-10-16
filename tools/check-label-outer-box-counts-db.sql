-- Fictional fixture: always execute the whole file, including ROLLBACK.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $qa$
declare
  v_suffix text:=replace(extensions.gen_random_uuid()::text,'-','');
  v_pin text:=lpad(floor(random()*10000)::integer::text,4,'0');
  v_order jsonb; v_source jsonb; v_source2 jsonb; v_products jsonb;
  v_logs jsonb; v_log jsonb; v_active jsonb; v_done jsonb;
  v_id text; v_new_id text; v_entry jsonb; v_definition text;
  v_before integer;
begin
  assert has_function_privilege('anon','public.dbmt_label_complete_production(text,text,jsonb)','execute');
  assert not has_function_privilege('anon','public.dbmt_label_production_transactions(jsonb)','execute');
  update public.app_config set value=extensions.crypt(v_pin,extensions.gen_salt('bf')) where key='label_print_pin_hash';
  v_source:=jsonb_build_object('key','qa-box-source-'||v_suffix,'product','QA box raw','lot','QA-RAW',
    'origin','국내산','packunit','벌크','proddate','2026-10-01','stockLocation','가공장','price',5000,'stock',100);
  v_source2:=v_source || jsonb_build_object('key','qa-box-source2-'||v_suffix,'product','QA box raw 2','price',6000,'stock',20);
  v_order:=jsonb_build_object('id','qa-box-order-'||v_suffix,'date','2026-10-16','title','QA outer boxes',
    'product','QA box A','labelProductId','qa-box-A-'||v_suffix,'inputWeight',120,'weight',5,'lot','QA-OUT',
    'origin','국내산','mfgdate','2026-10-16','sourceStock',v_source,'note','QA 3mm',
    'sourceInputs',jsonb_build_array(jsonb_build_object('sourceStock',v_source,'inputWeight',100),
      jsonb_build_object('sourceStock',v_source2,'inputWeight',20)));
  v_products:=jsonb_build_array(jsonb_build_object('id','qa-box-A-'||v_suffix,'name','QA box A','packunit','5KG','origin','국내산'),
    jsonb_build_object('id','qa-box-B-'||v_suffix,'name','QA box B','packunit','10KG','origin','국내산'));
  insert into public.app_data(key,payload) values('workOrders',jsonb_build_array(v_order)),('labelProducts',v_products),('labelPrintLogs','[]'::jsonb)
    on conflict(key) do update set payload=excluded.payload;
  v_logs:='[]'::jsonb;
  for v_log in select * from jsonb_array_elements(jsonb_build_array(
    jsonb_build_object('id','a1-'||v_suffix,'labelWeight',5,'status','active','reprintCount',7,'workOrderSnapshot',v_order),
    jsonb_build_object('id','a2-'||v_suffix,'labelWeight',7.35,'status','active','reprintCount',0,
      'workOrderSnapshot',public.dbmt_label_selected_product_order(v_order,v_products->0) || jsonb_build_object('weight',7.35)),
    jsonb_build_object('id','a3-'||v_suffix,'labelWeight',10,'status','active','reprintCount',0,
      'workOrderSnapshot',v_order || jsonb_build_object('weight',10,'labelSize','7x10')),
    jsonb_build_object('id','b1-'||v_suffix,'labelWeight',20,'status','active','reprintCount',2,
      'workOrderSnapshot',public.dbmt_label_selected_product_order(v_order,v_products->1) || jsonb_build_object('weight',20,'note','QA 5mm')),
    jsonb_build_object('id','void-'||v_suffix,'labelWeight',99,'status','void','reprintCount',0,'workOrderSnapshot',v_order)
  )) loop
    v_logs:=v_logs || jsonb_build_array(v_log || jsonb_build_object('workOrderId',v_order->>'id','product',v_log#>>'{workOrderSnapshot,product}',
      'lot',v_log#>>'{workOrderSnapshot,lot}','inputWeight',120));
  end loop;
  execute 'set local role anon';
  begin
    perform public.dbmt_label_complete_production('invalid fixture pin',v_order->>'id','[]'::jsonb);
    raise exception 'QA unexpectedly accepted authentication';
  exception when raise_exception then
    if sqlerrm not like '%PIN%' then raise; end if;
  end;
  perform public.dbmt_label_print_save_logs(v_pin,v_logs);
  select jsonb_agg(e->>'id' order by e->>'id') into v_active from jsonb_array_elements(v_logs) e where e->>'status'<>'void';
  v_done:=public.dbmt_label_complete_production(v_pin,v_order->>'id',v_active);
  execute 'set local role postgres';
  v_id:=v_done->>'productionId';
  select raw into v_entry from public.production_entries where id=v_id;
  assert jsonb_array_length(v_entry->'inputs')=2,'Multiple source inputs preserved';
  assert jsonb_array_length(v_entry->'outputs')=2,'Different snapshot shapes must merge to two real product rows';
  assert (select sum(public.dbmt_safe_numeric(e->>'boxCount')) from jsonb_array_elements(v_entry->'outputs') e)=4,'One active log is one box, regardless of reprints';
  assert (select public.dbmt_safe_numeric(e->>'boxCount')=3 and public.dbmt_safe_numeric(e->>'qty')=22.35
    from jsonb_array_elements(v_entry->'outputs') e where e->>'product'='QA box A'),'Mixed weights and snapshot groups must add their box counts';
  assert (select public.dbmt_safe_numeric(e->>'boxCount')=1 and public.dbmt_safe_numeric(e->>'qty')=20
    from jsonb_array_elements(v_entry->'outputs') e where e->>'product'='QA box B');
  assert not exists(select 1 from jsonb_array_elements(v_entry->'inputs') e where e ? 'boxCount'),'Raw input box counts must not be guessed';
  assert (select sum(public.dbmt_safe_numeric(raw->>'boxCount')) from public.transactions where prod_id=v_id and type='생산입고' and deleted_at is null)=4,'Inventory postings carry the output box counts';
  assert (select baseline=v_entry from public.label_production_completions where production_id=v_id),'Completion baseline includes counted boxes';
  select count(*) into v_before from public.transactions where prod_id=v_id;
  execute 'set local role anon';
  v_done:=public.dbmt_label_complete_production(v_pin,v_order->>'id',v_active);
  assert v_done->>'productionId'=v_id and v_done->>'alreadyCompleted'='true','Retry returns the same journal';
  perform public.dbmt_label_print_save_logs(v_pin,jsonb_build_array(v_logs->0 || jsonb_build_object('reprintCount',8)));
  execute 'set local role postgres';
  assert (select count(*) from public.transactions where prod_id=v_id)=v_before,'Retries/reprints cannot duplicate inventory';
  assert (select raw=v_entry from public.production_entries where id=v_id),'Reprints cannot change the produced box count';

  -- Manual office edits continue to supply their own box count to postings.
  assert public.dbmt_label_production_transactions(jsonb_set(v_entry,'{outputs,0,boxCount}','2'::jsonb))
    @> jsonb_build_array(jsonb_build_object('type','생산입고','boxCount',2));
  execute 'set local role anon';
  v_done:=public.dbmt_label_cancel_production(v_pin,v_order->>'id',v_id);
  execute 'set local role postgres';
  assert v_done->>'ok'='true';
  assert not exists(select 1 from public.transactions where prod_id=v_id and deleted_at is null),'Cancellation removes weight and box postings together';
  v_log:=v_logs->2 || jsonb_build_object('status','void','voidReason','QA cancel one box');
  execute 'set local role anon';
  perform public.dbmt_label_print_save_logs(v_pin,jsonb_build_array(v_log));
  v_done:=public.dbmt_label_resubmit_production(v_pin,v_order->>'id',v_active-('a3-'||v_suffix),v_id);
  execute 'set local role postgres';
  v_new_id:=v_done->>'productionId';
  assert v_new_id<>v_id,'Resubmission creates a new journal generation';
  select raw into v_entry from public.production_entries where id=v_new_id;
  assert (select sum(public.dbmt_safe_numeric(e->>'boxCount')) from jsonb_array_elements(v_entry->'outputs') e)=3,'Resubmission counts only remaining active labels';
  assert (select sum(public.dbmt_safe_numeric(raw->>'boxCount')) from public.transactions where prod_id=v_new_id and type='생산입고' and deleted_at is null)=3;
  assert (select sum(public.dbmt_safe_numeric(e->>'boxCount')) from public.label_production_completion_history c
    cross join lateral jsonb_array_elements(c.baseline->'outputs') e where c.production_id=v_id)=4,'Original baseline stays in audit history';
  execute 'set local role anon';
  v_done:=public.dbmt_label_resubmit_production(v_pin,v_order->>'id',v_active-('a3-'||v_suffix),v_id);
  execute 'set local role postgres';
  assert v_done->>'productionId'=v_new_id and v_done->>'alreadyCompleted'='true','Resubmission retry never creates extra boxes';
  assert (select count(*) from public.production_entries where raw#>>'{_labelCompletion,workOrderId}'=v_order->>'id')=2;
end;
$qa$;
rollback;
