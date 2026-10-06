-- Run via a privileged SQL connection. All fixture changes are rolled back.
begin;
do $qa$
declare
  v_suffix text:=substr(md5(random()::text),1,12);
  v_order_id text;
  v_product_id text;
  v_log_id text;
  v_source_a jsonb;
  v_source_b jsonb;
  v_order jsonb;
  v_product jsonb;
  v_log jsonb;
  v_bad jsonb;
  v_result jsonb;
  v_entry jsonb;
  v_reservation jsonb;
  v_changed jsonb;
  v_legacy_order jsonb;
  v_legacy_log jsonb;
  v_legacy_id text;
  v_pid text;
begin
  v_order_id:='qa_multi_'||v_suffix;
  v_product_id:='qa_output_'||v_suffix;
  v_log_id:='qa_log_'||v_suffix;
  update public.app_config set value=extensions.crypt('0927',extensions.gen_salt('bf')) where key='label_print_pin_hash';
  v_source_a:=jsonb_build_object('key','qa_a_'||v_suffix,'product','QA 원료 A','lot','RAW-A','origin','국내산',
    'packunit','벌크','proddate','2026-10-01','stockLocation','가공장','price',5000,'stock',100);
  v_source_b:=jsonb_build_object('key','qa_b_'||v_suffix,'product','QA 원료 B','lot','RAW-B','origin','국내산',
    'packunit','벌크','proddate','2026-10-01','stockLocation','가공장','price',6000,'stock',100);
  v_order:=jsonb_build_object('id',v_order_id,'date','2026-10-06','title','QA 다중 원료',
    'product','QA 생산품','labelProductId',v_product_id,'inputWeight',75,'weight',0,'lot','MIX-LOT',
    'origin','국내산','grade','','mfgdate','2026-10-06','expdate','2027-10-05','ingredients','돼지고기 100%',
    'temptype','냉동','sourceStockKey',v_source_a->>'key','sourceStock',v_source_a,
    'sourceInputs',jsonb_build_array(
      jsonb_build_object('sourceStockKey',v_source_a->>'key','sourceStock',v_source_a,'inputWeight',50),
      jsonb_build_object('sourceStockKey',v_source_b->>'key','sourceStock',v_source_b,'inputWeight',25)));
  v_product:=jsonb_build_object('id',v_product_id,'name','QA 생산품','packunit','5KG','taxType','면세');
  insert into public.app_data(key,payload) values('workOrders',jsonb_build_array(v_order))
    on conflict(key) do update set payload=excluded.payload;
  insert into public.app_data(key,payload) values('labelProducts',jsonb_build_array(v_product))
    on conflict(key) do update set payload=excluded.payload;
  insert into public.app_data(key,payload) values('labelPrintLogs','[]'::jsonb)
    on conflict(key) do update set payload=excluded.payload;
  v_log:=jsonb_build_object('id',v_log_id,'workOrderId',v_order_id,'product','QA 생산품','lot','MIX-LOT',
    'labelWeight',10,'inputWeight',75,'status','active','reprintCount',0,
    'workOrderSnapshot',public.dbmt_label_selected_product_order(v_order,v_product)||jsonb_build_object('weight',10));
  v_bad:=jsonb_set(v_log,'{workOrderSnapshot,sourceInputs,1,inputWeight}','99'::jsonb);
  begin
    perform public.dbmt_label_print_save_logs('0927',jsonb_build_array(v_bad));
    raise exception 'QA: altered second input was accepted';
  exception when others then
    if sqlerrm not like '%투입정보%' then raise; end if;
  end;
  v_result:=public.dbmt_label_print_save_logs('0927',jsonb_build_array(v_log));
  if v_result->>'ok' is distinct from 'true' then raise exception 'QA: print log save failed'; end if;
  v_result:=public.dbmt_label_complete_production('0927',v_order_id,jsonb_build_array(v_log_id));
  v_pid:=v_result->>'productionId';
  select raw into v_entry from public.production_entries where id=v_pid;
  if jsonb_array_length(v_entry->'inputs')<>2 or v_entry#>>'{_labelCompletion,lockedInputCount}'<>'2' then
    raise exception 'QA: expected two locked input rows';
  end if;
  if (select sum(public.dbmt_safe_numeric(e->>'qty')) from jsonb_array_elements(v_entry->'inputs') e)<>75
    or (select sum(public.dbmt_safe_numeric(e->>'amount')) from jsonb_array_elements(v_entry->'inputs') e)<>400000 then
    raise exception 'QA: source weight or cost incorrect';
  end if;
  if (select count(*) from public.transactions where prod_id=v_pid and type='사용' and deleted_at is null)<>2 then
    raise exception 'QA: expected two stock usage transactions';
  end if;
  if jsonb_array_length(public.dbmt_work_order_source_inputs(jsonb_build_object(
      'sourceStock',v_source_a,'inputWeight',50)))<>1 then
    raise exception 'QA: legacy source fallback failed';
  end if;
  v_legacy_id:='qa_legacy_'||v_suffix;
  v_legacy_order:=(v_order-'sourceInputs')||jsonb_build_object('id',v_legacy_id,'inputWeight',20);
  update public.app_data set payload=jsonb_build_array(v_order,v_legacy_order) where key='workOrders';
  v_legacy_log:=jsonb_build_object('id','qa_legacy_log_'||v_suffix,'workOrderId',v_legacy_id,
    'product','QA 생산품','lot','MIX-LOT','labelWeight',5,'inputWeight',20,'status','active',
    'reprintCount',0,'workOrderSnapshot',v_legacy_order||jsonb_build_object('weight',5));
  v_result:=public.dbmt_label_print_save_logs('0927',jsonb_build_array(v_legacy_log));
  v_result:=public.dbmt_label_complete_production('0927',v_legacy_id,jsonb_build_array(v_legacy_log->>'id'));
  select raw into v_result from public.production_entries where id=v_result->>'productionId';
  if jsonb_array_length(v_result->'inputs')<>1 or v_result#>>'{inputs,0,qty}' not in ('20','20.00') then
    raise exception 'QA: legacy one-source completion changed';
  end if;
  v_reservation:=jsonb_build_object('id','qa_reservation_'||v_suffix,'sourceStock',v_source_a,
    'inputWeight',6,'sourceInputs',jsonb_build_array(
      jsonb_build_object('sourceStock',v_source_a,'inputWeight',1),
      jsonb_build_object('sourceStock',v_source_b||jsonb_build_object(
        'stockRowId',v_entry#>>'{outputs,0,stockRowId}'),'inputWeight',5)));
  update public.app_data set payload=jsonb_build_array(v_reservation) where key='workOrders';
  v_changed:=jsonb_set(v_entry,'{outputs,0,qty}','1'::jsonb);
  begin
    perform public.dbmt_validate_production_stock_rows(v_changed,v_pid);
    raise exception 'QA: second source reservation was ignored';
  exception when others then
    if sqlerrm not like '%작업지시에 지정한 투입중량%' then raise; end if;
  end;
end;
$qa$;
rollback;
