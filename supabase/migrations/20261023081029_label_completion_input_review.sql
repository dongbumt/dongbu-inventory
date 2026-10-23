-- Explicitly confirmed input corrections preserve every printed snapshot/barcode.
-- No existing work order, label, journal or stock record is rewritten by this migration.

CREATE OR REPLACE FUNCTION public.dbmt_label_complete_production_reviewed(p_pin text, p_work_order_id text, p_log_ids jsonb, p_confirmed_work_order jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_order jsonb; v_logs jsonb; v_ids jsonb; v_snap jsonb; v_source jsonb; v_sources jsonb; v_source_input jsonb; v_products jsonb;
  v_entry jsonb; v_inputs jsonb; v_outputs jsonb; v_rows jsonb; v_base jsonb;
  v_id text; v_date date; v_job integer; v_weight numeric; v_input_total numeric:=0; v_qty numeric; v_cost numeric:=0; v_price numeric;
  v_existing public.label_production_completions%rowtype;
  v_input_review jsonb;
  v_work_orders jsonb;
begin
  if public.dbmt_check_label_print_pin(p_pin) is not true then raise exception '라벨전용 PIN이 맞지 않습니다.'; end if;
  perform pg_advisory_xact_lock(36100910);
  select * into v_existing from public.label_production_completions where work_order_id=p_work_order_id;
  if found then
    if exists(select 1 from public.production_entries where id=v_existing.production_id and deleted_at is not null) then
      raise exception '이미 전송 후 삭제된 생산일보입니다. 중복 등록하지 않습니다. 사무실에서 확인해주세요.';
    end if;
    return jsonb_build_object('ok',true,'alreadyCompleted',true,'productionId',v_existing.production_id,'completions',public.dbmt_label_completion_status());
  end if;
  -- Coordinate with row-based work-order edits: the confirmed version stays fixed until commit.
  select payload into v_work_orders from public.app_data where key='workOrders' for update;
  select e into v_order from jsonb_array_elements(v_work_orders) e where e->>'id'=p_work_order_id;
  if v_order is null then raise exception '작업지시를 찾을 수 없습니다. 새로고침해주세요.'; end if;
  select coalesce(jsonb_agg(e order by e->>'id'),'[]'::jsonb),coalesce(jsonb_agg(e->>'id' order by e->>'id'),'[]'::jsonb)
    into v_logs,v_ids from public.app_data a cross join lateral jsonb_array_elements(a.payload) e
    where a.key='labelPrintLogs' and e->>'workOrderId'=p_work_order_id and coalesce(e->>'status','active')<>'void';
  if jsonb_array_length(v_logs)=0 then raise exception '생산완료할 출력이력이 없습니다.'; end if;
  if jsonb_typeof(p_log_ids) is distinct from 'array' or v_ids is distinct from (select jsonb_agg(e order by e#>>'{}') from jsonb_array_elements(p_log_ids) e) then
    raise exception '출력이력이 변경되었습니다. 새로고침하여 중량을 확인한 후 생산완료해주세요.';
  end if;
  v_snap := v_logs#>'{0,workOrderSnapshot}';
  v_source := v_snap->'sourceStock';
  v_sources := public.dbmt_work_order_source_inputs(v_snap);
  v_date := public.dbmt_safe_date(v_snap->>'date');
  v_weight := public.dbmt_safe_numeric(v_snap->>'inputWeight');
  -- Work dates and printed output metadata are never reconciled as input corrections.
  if v_date is null or v_date is distinct from public.dbmt_safe_date(v_order->>'date')
    or exists(select 1 from jsonb_array_elements(v_logs) e where
      public.dbmt_safe_date(e#>>'{workOrderSnapshot,date}') is distinct from v_date
      or public.dbmt_safe_numeric(e->>'labelWeight')<=0) then
    raise exception '출력이력과 작업지시의 작업일 또는 라벨 중량을 확인해주세요. 투입내역 확인으로 작업일은 변경할 수 없습니다.';
  end if;
  if p_confirmed_work_order is null then
    -- Unchanged/older clients retain the original strict snapshot checks.
    if v_source is distinct from v_order->'sourceStock'
      or v_snap->'sourceInputs' is distinct from v_order->'sourceInputs'
      or v_sources is distinct from public.dbmt_work_order_source_inputs(v_order)
      or v_weight<>public.dbmt_safe_numeric(v_order->>'inputWeight')
      or v_date is distinct from public.dbmt_safe_date(v_order->>'date') then
      raise exception '출력 후 작업지시의 투입정보 또는 작업일이 변경되었습니다. 사무실에서 확인해주세요.';
    end if;
    if exists(select 1 from jsonb_array_elements(v_logs) e where
        e#>'{workOrderSnapshot,sourceStock}' is distinct from v_source
        or e#>'{workOrderSnapshot,sourceInputs}' is distinct from v_snap->'sourceInputs'
        or public.dbmt_safe_numeric(e#>>'{workOrderSnapshot,inputWeight}')<>v_weight
        or public.dbmt_safe_date(e#>>'{workOrderSnapshot,date}') is distinct from v_date
        or public.dbmt_safe_numeric(e->>'labelWeight')<=0) then
      raise exception '출력이력의 투입 원료 또는 작업일이 서로 다릅니다. 사무실에서 확인해주세요.';
    end if;
  else
    if jsonb_typeof(p_confirmed_work_order) is distinct from 'object'
      or p_confirmed_work_order is distinct from v_order then
      raise exception '확인한 뒤 작업지시가 다시 변경되었습니다. 생산완료를 다시 눌러 최신 투입내역을 확인해주세요.';
    end if;
    v_sources := public.dbmt_work_order_source_inputs(v_order);
    v_source := v_order->'sourceStock';
    v_weight := public.dbmt_safe_numeric(v_order->>'inputWeight');
    select jsonb_build_object(
      'confirmedAt',now(),'authMode','label_pin','workOrder',v_order,
      'printedInputVersions',jsonb_agg(g.input_snapshot order by g.input_snapshot::text))
      into v_input_review from (
        select distinct jsonb_build_object('date',e#>'{workOrderSnapshot,date}',
          'inputWeight',e#>'{workOrderSnapshot,inputWeight}',
          'sourceInputs',public.dbmt_work_order_source_inputs(e->'workOrderSnapshot')) as input_snapshot
        from jsonb_array_elements(v_logs) e
      ) g;
  end if;
  if coalesce(v_source->>'product','')='' or v_weight<=0 then
    raise exception '작업지시의 투입 원료·투입중량을 확인해주세요.';
  end if;
  if exists(select 1 from jsonb_array_elements(v_sources) e
    group by coalesce(nullif(e#>>'{sourceStock,stockRowId}',''),e#>>'{sourceStock,key}') having count(*)>1) then
    raise exception '같은 재고가 작업지시에 중복 지정되었습니다. 사무실에서 확인해주세요.';
  end if;
  v_inputs := '[]'::jsonb;
  for v_source_input in select e from jsonb_array_elements(v_sources) e loop
    v_source:=v_source_input->'sourceStock';
    v_qty:=public.dbmt_safe_numeric(v_source_input->>'inputWeight');
    if jsonb_typeof(v_source) is distinct from 'object' or coalesce(v_source->>'product','')=''
      or coalesce(v_source->>'key','')='' or jsonb_typeof(v_source_input->'inputWeight') is distinct from 'number'
      or v_qty<=0 or v_qty>999999999 or round(v_qty,2)<>v_qty then
      raise exception '작업지시의 원료육 또는 원료별 투입량을 확인해주세요.';
    end if;
    v_input_total:=v_input_total+v_qty;
    v_cost:=v_cost+v_qty*public.dbmt_safe_numeric(v_source->>'price');
    v_inputs:=v_inputs || jsonb_build_array(jsonb_build_object(
      'product',v_source->>'product','lot',coalesce(v_source->>'lot',''),'origin',coalesce(v_source->>'origin',''),
      'packunit',coalesce(v_source->>'packunit',''),'proddate',coalesce(v_source->>'proddate',''),
      'stockLocation',coalesce(nullif(v_source->>'stockLocation',''),'가공장'),'sourceStockKey',coalesce(v_source->>'key',''),
      'stockUnitPrice',public.dbmt_safe_numeric(v_source->>'price'),'qty',v_qty,
      'price',public.dbmt_safe_numeric(v_source->>'price'),'amount',v_qty*public.dbmt_safe_numeric(v_source->>'price'),
      'samsung',v_source->'samsung','stockRowId',coalesce(v_source->>'stockRowId',''),
      'stockNote',coalesce(v_source->>'stockNote','')) ||
      case when v_source_input ? 'boxCount' then jsonb_build_object('boxCount',v_source_input->'boxCount') else '{}'::jsonb end);
  end loop;
  if v_input_total<>v_weight then raise exception '원료별 투입량 합계가 작업지시 총량과 다릅니다.'; end if;
  v_products := coalesce((select payload from public.app_data where key='labelProducts'),'[]'::jsonb);
  v_outputs := '[]'::jsonb;
  -- Group mixed-weight labels by the actual printed product/LOT, not the current form.
  for v_base in select (e->'workOrderSnapshot') - array['weight','labelSize','inputWeight','sourceStock','sourceInputs','title'] ||
      jsonb_build_object('qty',sum(public.dbmt_safe_numeric(e->>'labelWeight')),'boxCount',count(*))
      from jsonb_array_elements(v_logs) e
      group by (e->'workOrderSnapshot') - array['weight','labelSize','inputWeight','sourceStock','sourceInputs','title'] loop
    if v_base->>'productSelectionVersion'='1' then
      -- A selected ID must never silently move to a same-named replacement.
      select p into v_snap from jsonb_array_elements(v_products) p where p->>'id'=v_base->>'labelProductId';
    else
    select p into v_snap from jsonb_array_elements(v_products) p
      where p->>'id'=coalesce(nullif(v_base->>'labelProductId',''),case when v_base->>'product'=v_order->>'product' then v_order->>'labelProductId' end);
    if v_snap is null then
      select case when count(*)=1 then jsonb_agg(p)->0 else null end into v_snap
        from jsonb_array_elements(v_products) p where p->>'name'=v_base->>'product';
    end if;
    end if;
    if v_snap is null then raise exception '출력한 생산품목을 품목관리에서 확인할 수 없습니다. 사무실에서 확인해주세요.'; end if;
    v_outputs := v_outputs || jsonb_build_array(jsonb_build_object(
      'product',v_base->>'product','productId',v_snap->>'id','labelProductId',v_snap->>'id',
      'productCode',coalesce(v_base->>'productCode',v_snap->>'productCode',''),
      'brand',coalesce(v_base->>'brand',v_snap->>'brand',''),'factoryNo',coalesce(v_base->>'factoryNo',v_snap->>'factoryNo',''),
      'nationalPartCode',coalesce(v_base->>'nationalPartCode',v_snap->>'nationalPartCode',''),
      'nationalPartName',coalesce(v_base->>'nationalPartName',v_snap->>'nationalPartName',''),
      'taxType',coalesce(v_base->>'taxType',v_snap->>'taxType','면세'),'grade',coalesce(v_base->>'grade',''),
      'packunit',coalesce(v_base->>'packunit',v_snap->>'packunit',''),'lot',coalesce(v_base->>'lot',''),
      'origin',coalesce(v_base->>'origin',''),'proddate',coalesce(v_base->>'mfgdate',''),
      'qty',v_base->'qty','boxCount',v_base->'boxCount','samsung',null,'note',coalesce(v_base->>'note','')
    ));
  end loop;
  select jsonb_agg(g.row order by g.row->>'product',g.row->>'lot',g.row->>'proddate') into v_outputs
    from (select (e-array['qty','boxCount']) || jsonb_build_object('qty',sum(public.dbmt_safe_numeric(e->>'qty')),'boxCount',sum(public.dbmt_safe_numeric(e->>'boxCount'))) as row
      from jsonb_array_elements(v_outputs) e group by e-array['qty','boxCount']) g;
  select ceil(v_cost / sum(public.dbmt_safe_numeric(e->>'qty'))) into v_price from jsonb_array_elements(v_outputs) e;
  select jsonb_agg(e || jsonb_build_object('price',v_price,'amount',round(v_price*public.dbmt_safe_numeric(e->>'qty')))) into v_outputs from jsonb_array_elements(v_outputs) e;
  v_id := 'prod_label_' || replace(extensions.gen_random_uuid()::text,'-','');
  select coalesce(max(case when raw->>'job_no' ~ '^[0-9]{1,8}$' then (raw->>'job_no')::integer else 0 end),0)+1
    into v_job from public.production_entries where work_date=v_date and deleted_at is null;
  v_entry := jsonb_build_object('id',v_id,'date',to_char(v_date,'YYYY/MM/DD'),'job_no',v_job::text,
    'key',jsonb_build_array(to_char(v_date,'YYYY/MM/DD'),v_job::text),'job_type','생산',
    'note',coalesce(v_order->>'title',''),'inputs',v_inputs,'outputs',v_outputs,
    '_isUser',true,'_labelCompletion',jsonb_build_object('workOrderId',p_work_order_id,'completedAt',now(),'lockedInputCount',jsonb_array_length(v_inputs)),
    '_serverAudit',jsonb_build_object('authMode','label_pin','savedAt',now()));
  if v_input_review is not null then
    v_entry:=jsonb_set(v_entry,'{_labelCompletion,inputConfirmation}',v_input_review);
  end if;
  v_entry := public.dbmt_prepare_label_stock_rows(v_entry);
  v_outputs := v_entry->'outputs';
  perform public.dbmt_validate_production_stock_rows(v_entry);
  v_rows := public.dbmt_label_production_transactions(v_entry);
  insert into public.production_entries(id,work_date,product,lot,output_weight,raw)
    values(v_id,v_date,v_outputs#>>'{0,product}',v_outputs#>>'{0,lot}',
      (select sum(public.dbmt_safe_numeric(e->>'qty')) from jsonb_array_elements(v_outputs) e),v_entry);
  insert into public.transactions(id,date,type,product,origin,packunit,trader,lot,proddate,weight,price,amount,note,
    is_user,is_prod_use,is_prod_out,prod_id,stock_unit_price,stock_proddate,source_stock_key,stock_location,raw)
    select e->>'id',v_date,e->>'type',e->>'product',e->>'origin',e->>'packunit',e->>'trader',e->>'lot',
      public.dbmt_safe_date(e->>'proddate'),public.dbmt_safe_numeric(e->>'weight'),public.dbmt_safe_numeric(e->>'price'),
      public.dbmt_safe_numeric(e->>'amount'),e->>'note',true,public.dbmt_safe_bool(e->>'_isProdUse',false),
      public.dbmt_safe_bool(e->>'_isProdOut',false),v_id,public.dbmt_safe_numeric(e->>'stockUnitPrice'),
      public.dbmt_safe_date(e->>'stockProddate'),e->>'sourceStockKey',e->>'stockLocation',e || jsonb_build_object('_serverAudit',v_entry->'_serverAudit')
    from jsonb_array_elements(v_rows) e;
  insert into public.label_production_completions(work_order_id,production_id,baseline,log_ids) values(p_work_order_id,v_id,v_entry,v_ids);
  insert into public.change_logs(entity,action,entity_id,summary,payload) values('생산일보','라벨 생산완료',v_id,
    to_char(v_date,'YYYY/MM/DD') || ' #' || v_job::text,jsonb_build_object('workOrderId',p_work_order_id,'labelCount',jsonb_array_length(v_ids),'authMode','label_pin','inputConfirmation',v_input_review));
  return jsonb_build_object('ok',true,'productionId',v_id,'completions',public.dbmt_label_completion_status());
end;
$function$
;

CREATE OR REPLACE FUNCTION public.dbmt_label_resubmit_production_reviewed(p_pin text, p_work_order_id text, p_log_ids jsonb, p_previous_production_id text, p_confirmed_work_order jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_current public.label_production_completions%rowtype;
  v_result jsonb;
  v_deleted_at timestamptz;
begin
  if public.dbmt_check_label_print_pin(p_pin) is not true then raise exception '라벨전용 PIN이 맞지 않습니다.'; end if;
  perform pg_advisory_xact_lock(36100910);
  select * into v_current from public.label_production_completions where work_order_id=p_work_order_id for update;
  if not found or nullif(btrim(p_previous_production_id),'') is null then
    raise exception '전송 상태가 변경되었습니다. 새로고침 후 다시 확인해주세요.';
  end if;
  select deleted_at into v_deleted_at from public.production_entries where id=v_current.production_id for update;
  if v_current.production_id<>p_previous_production_id then
    if v_deleted_at is null and exists (
      select 1 from public.label_production_completion_history
      where production_id=p_previous_production_id and work_order_id=p_work_order_id and successor_id=v_current.production_id
    ) then
      return jsonb_build_object('ok',true,'alreadyCompleted',true,'productionId',v_current.production_id,'completions',public.dbmt_label_completion_status());
    end if;
    raise exception '전송 상태가 변경되었습니다. 새로고침 후 다시 확인해주세요.';
  end if;
  if v_deleted_at is null then raise exception '생산일보가 남아 있습니다. ERP에서 해당 생산일보를 먼저 삭제해주세요.'; end if;
  if exists(select 1 from public.transactions where prod_id=v_current.production_id and deleted_at is null)
    or exists(select 1 from public.submaterial_usages where production_id=v_current.production_id and deleted_at is null) then
    raise exception '삭제한 생산일보에 연결된 재고 내역이 남아 있습니다. 사무실에서 확인해주세요.';
  end if;
  insert into public.label_production_completion_history(production_id,work_order_id,completed_at,baseline,log_ids)
    values(v_current.production_id,v_current.work_order_id,v_current.completed_at,v_current.baseline,v_current.log_ids);
  -- This marker alone moves to history. The deleted journal and all printed
  -- snapshots remain intact. Any downstream error rolls this entire reset back.
  delete from public.label_production_completions where work_order_id=p_work_order_id and production_id=p_previous_production_id;
  v_result := public.dbmt_label_complete_production_reviewed(p_pin,p_work_order_id,p_log_ids,p_confirmed_work_order);
  if v_result->>'ok' is distinct from 'true' then raise exception '생산일보 재전송을 완료하지 못했습니다.'; end if;
  update public.label_production_completion_history set successor_id=v_result->>'productionId' where production_id=p_previous_production_id;
  insert into public.change_logs(entity,action,entity_id,summary,payload)
    values('생산일보','삭제 후 재전송',v_result->>'productionId','라벨 작업 재전송',
      jsonb_build_object('workOrderId',p_work_order_id,'previousProductionId',p_previous_production_id,'authMode','label_pin'));
  return v_result;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.dbmt_label_complete_production(p_pin text, p_work_order_id text, p_log_ids jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO '' AS $function$
  select public.dbmt_label_complete_production_reviewed(p_pin,p_work_order_id,p_log_ids,null);
$function$;

CREATE OR REPLACE FUNCTION public.dbmt_label_resubmit_production(p_pin text, p_work_order_id text, p_log_ids jsonb, p_previous_production_id text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO '' AS $function$
  select public.dbmt_label_resubmit_production_reviewed(p_pin,p_work_order_id,p_log_ids,p_previous_production_id,null);
$function$;

REVOKE ALL ON FUNCTION public.dbmt_label_complete_production_reviewed(text,text,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dbmt_label_resubmit_production_reviewed(text,text,jsonb,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dbmt_label_complete_production_reviewed(text,text,jsonb,jsonb) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dbmt_label_resubmit_production_reviewed(text,text,jsonb,text,jsonb) TO anon,authenticated;
NOTIFY pgrst, 'reload schema';
