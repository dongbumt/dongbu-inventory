-- A label PIN may complete an existing printed work order, not write arbitrary ERP data.
-- Completion and inventory postings are atomic; the immutable ledger prevents retries
-- (including retries after an office deletion) from posting the same work order twice.
create table if not exists public.label_production_completions (
  work_order_id text primary key,
  production_id text not null unique references public.production_entries(id),
  completed_at timestamptz not null default now(),
  baseline jsonb not null,
  log_ids jsonb not null
);
alter table public.label_production_completions enable row level security;
revoke all on public.label_production_completions from public, anon, authenticated;

create or replace function public.dbmt_label_completion_status()
returns jsonb language sql security definer set search_path = public, extensions as $dbmt$
  select coalesce(jsonb_agg(jsonb_build_object(
    'workOrderId', c.work_order_id, 'productionId', c.production_id,
    'completedAt', c.completed_at, 'date', c.baseline->>'date',
    'jobNo', c.baseline->>'job_no', 'deleted', p.deleted_at is not null
  )), '[]'::jsonb)
  from public.label_production_completions c join public.production_entries p on p.id=c.production_id;
$dbmt$;

create or replace function public.dbmt_label_print_get_data(p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $dbmt$
begin
  if public.dbmt_check_label_print_pin(p_pin) is not true then raise exception '라벨전용 PIN이 맞지 않습니다.'; end if;
  return jsonb_build_object('appData', jsonb_build_object(
    'workOrders', coalesce((select payload from public.app_data where key='workOrders'),'[]'::jsonb),
    'labelProducts', coalesce((select payload from public.app_data where key='labelProducts'),'[]'::jsonb),
    'labelPrintLogs', coalesce((select payload from public.app_data where key='labelPrintLogs'),'[]'::jsonb)
  ), 'completions', public.dbmt_label_completion_status());
end;
$dbmt$;

-- Merge immutable print records. An older browser must not erase another browser's
-- labels or resurrect a voided label by submitting its stale full-array snapshot.
create or replace function public.dbmt_label_print_save_logs(p_pin text, p_logs jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $dbmt$
declare
  v_logs jsonb; v_new jsonb; v_old jsonb; v_merged jsonb; v_index integer; v_order jsonb; v_product jsonb; v_field text;
begin
  if public.dbmt_check_label_print_pin(p_pin) is not true then raise exception '라벨전용 PIN이 맞지 않습니다.'; end if;
  if jsonb_typeof(p_logs) is distinct from 'array' or jsonb_array_length(p_logs)>5000 then
    raise exception '라벨 출력이력 형식 또는 건수를 확인해주세요.';
  end if;
  perform pg_advisory_xact_lock(36100910);
  v_logs := coalesce((select payload from public.app_data where key='labelPrintLogs' for update),'[]'::jsonb);
  if exists(select 1 from jsonb_array_elements(p_logs) e group by e->>'id' having count(*)>1) then
    raise exception '중복된 라벨 식별값입니다.';
  end if;
  for v_new in select * from jsonb_array_elements(p_logs) loop
    if jsonb_typeof(v_new)<>'object' or coalesce(v_new->>'id','')='' or coalesce(v_new->>'workOrderId','')='' then
      raise exception '라벨 식별값을 확인해주세요.';
    end if;
    select e, n::integer-1 into v_old, v_index from jsonb_array_elements(v_logs) with ordinality r(e,n) where e->>'id'=v_new->>'id';
    if v_old is null then
      if exists(select 1 from public.label_production_completions where work_order_id=v_new->>'workOrderId') then
        raise exception '생산완료된 작업에는 라벨을 추가할 수 없습니다. 새 작업지시를 사용하세요.';
      end if;
      if coalesce(v_new->>'status','active') not in ('active','void') or public.dbmt_safe_numeric(v_new->>'labelWeight')<=0 then
        raise exception '라벨 중량 또는 상태를 확인해주세요.';
      end if;
      select e into v_order from public.app_data a cross join lateral jsonb_array_elements(a.payload) e
        where a.key='workOrders' and e->>'id'=v_new->>'workOrderId';
      if v_order is null or v_new#>>'{workOrderSnapshot,id}' is distinct from v_order->>'id'
        or v_new#>'{workOrderSnapshot,sourceStock}' is distinct from v_order->'sourceStock'
        or public.dbmt_safe_numeric(v_new#>>'{workOrderSnapshot,inputWeight}')<>public.dbmt_safe_numeric(v_order->>'inputWeight') then
        raise exception '작업지시의 투입정보가 변경되었습니다. 새로고침 후 출력하세요.';
      end if;
      foreach v_field in array array['date','product','origin','grade'] loop
        if coalesce(v_new#>>array['workOrderSnapshot',v_field],'')<>coalesce(v_order->>v_field,'') then
          raise exception '작업지시가 변경되었습니다. 새로고침 후 출력하세요.';
        end if;
      end loop;
      if coalesce(v_new#>>'{workOrderSnapshot,lot}','')<>coalesce(nullif(v_order->>'lot',''),v_order#>>'{sourceStock,lot}','')
        or coalesce(v_new#>>'{workOrderSnapshot,mfgdate}','')<>coalesce(nullif(v_order->>'mfgdate',''),v_order->>'date','') then
        raise exception '작업지시의 LOT 또는 생산일이 변경되었습니다. 새로고침 후 출력하세요.';
      end if;
      select e into v_product from public.app_data a cross join lateral jsonb_array_elements(a.payload) e
        where a.key='labelProducts' and e->>'id'=v_order->>'labelProductId';
      foreach v_field in array array['labelProductId','productCode','brand','factoryNo','nationalPartCode','nationalPartName','taxType','packunit'] loop
        -- Older labels omit product metadata. New metadata must match its server master.
        if (v_new->'workOrderSnapshot') ? v_field and coalesce(v_new#>>array['workOrderSnapshot',v_field],'')<>
          (case when v_field='packunit' then coalesce(v_product->>'packunit',v_order->>'packunit','')
            when v_field='taxType' then coalesce(nullif(v_order->>'taxType',''),'면세')
            else coalesce(v_order->>v_field,'') end) then
          raise exception '작업지시의 품목정보가 변경되었습니다. 새로고침 후 출력하세요.';
        end if;
      end loop;
      v_logs := v_logs || jsonb_build_array(v_new);
    else
      if (v_new - array['status','voidedAt','voidReason','reprintCount','lastReprintedAt'])
         is distinct from (v_old - array['status','voidedAt','voidReason','reprintCount','lastReprintedAt']) then
        raise exception '저장된 라벨의 품목·중량은 변경할 수 없습니다. 새로고침 후 다시 시도하세요.';
      end if;
      v_merged := v_old;
      if v_new->>'status'='void' and coalesce(v_old->>'status','active')<>'void' then
        if exists(select 1 from public.label_production_completions where work_order_id=v_old->>'workOrderId') then
          raise exception '생산완료된 라벨은 삭제할 수 없습니다.';
        end if;
        v_merged := v_merged || jsonb_build_object('status','void','voidedAt',v_new->>'voidedAt','voidReason',v_new->>'voidReason');
      end if;
      if public.dbmt_safe_numeric(v_new->>'reprintCount')>public.dbmt_safe_numeric(v_old->>'reprintCount') then
        v_merged := v_merged || jsonb_build_object('reprintCount',v_new->'reprintCount','lastReprintedAt',v_new->>'lastReprintedAt');
      end if;
      v_logs := jsonb_set(v_logs,array[v_index::text],v_merged);
    end if;
  end loop;
  if jsonb_array_length(v_logs)>5000 then raise exception '라벨 출력이력은 5,000건까지 저장할 수 있습니다.'; end if;
  insert into public.app_data(key,payload,updated_at) values('labelPrintLogs',v_logs,now())
    on conflict(key) do update set payload=excluded.payload,updated_at=now();
  insert into public.change_logs(entity,action,summary,payload) values('label_print','save_logs','라벨 출력이력 저장',jsonb_build_object('count',jsonb_array_length(p_logs)));
  return jsonb_build_object('ok',true,'logs',v_logs,'completions',public.dbmt_label_completion_status());
end;
$dbmt$;

-- Generate inventory postings from journal rows, never from caller-supplied postings.
create or replace function public.dbmt_label_production_transactions(p_entry jsonb)
returns jsonb language sql security definer set search_path = public, extensions as $dbmt$
  select coalesce(jsonb_agg(
    (e - array['qty','manualPrice']) || jsonb_build_object(
      'samsungVendorId',coalesce(e#>>'{samsung,vendorId}',''),
      'samsungVendorName',coalesce(e#>>'{samsung,vendorName}',''),
      'samsungProductRowId',coalesce(e#>>'{samsung,productRowId}',''),
      'samsungProductId',coalesce(e#>>'{samsung,productId}',''),
      'samsungProductName',coalesce(e#>>'{samsung,productName}',''),
      'samsungSpec',coalesce(e#>>'{samsung,spec}',''),
      'id','tx_' || (p_entry->>'id') || '_' || kind || '_' || (n-1)::text,
      'date',replace(p_entry->>'date','/','-'), 'type',case when kind='use' then '사용' else '생산입고' end,
      'weight',e->'qty','trader',case when kind='use' then '' else '생산작업' end,
      'stockLocation',coalesce(nullif(e->>'stockLocation',''),'가공장'),
      'stockProddate',coalesce(e->>'proddate',''),
      'stockUnitPrice',coalesce(e->'stockUnitPrice',e->'price','0'::jsonb),
      '_isUser',true,'_isProdUse',kind='use','_isProdOut',kind='out','_prodId',p_entry->>'id',
      'note','라벨 생산완료 ' || (p_entry->>'date') || ' #' || (p_entry->>'job_no')
    ) order by kind,n
  ),'[]'::jsonb)
  from (
    select e,n,'use' kind from jsonb_array_elements(p_entry->'inputs') with ordinality a(e,n)
    union all
    select e,n,'out' kind from jsonb_array_elements(p_entry->'outputs') with ordinality a(e,n)
  ) rows;
$dbmt$;

create or replace function public.dbmt_label_complete_production(p_pin text, p_work_order_id text, p_log_ids jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $dbmt$
declare
  v_order jsonb; v_logs jsonb; v_ids jsonb; v_snap jsonb; v_source jsonb; v_products jsonb;
  v_entry jsonb; v_inputs jsonb; v_outputs jsonb; v_rows jsonb; v_base jsonb;
  v_id text; v_date date; v_job integer; v_weight numeric; v_cost numeric; v_price numeric;
  v_existing public.label_production_completions%rowtype;
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
  select e into v_order from public.app_data a cross join lateral jsonb_array_elements(a.payload) e where a.key='workOrders' and e->>'id'=p_work_order_id;
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
  v_date := public.dbmt_safe_date(v_snap->>'date');
  v_weight := public.dbmt_safe_numeric(v_snap->>'inputWeight');
  if v_date is null or coalesce(v_source->>'product','')='' or v_weight<=0 then
    raise exception '작업지시의 투입 원료·투입중량·작업일을 확인해주세요. 출력 당시 정보가 필요합니다.';
  end if;
  if v_source is distinct from v_order->'sourceStock' or v_weight<>public.dbmt_safe_numeric(v_order->>'inputWeight')
    or v_date is distinct from public.dbmt_safe_date(v_order->>'date') then
    raise exception '출력 후 작업지시의 투입정보 또는 작업일이 변경되었습니다. 사무실에서 확인해주세요.';
  end if;
  if exists(select 1 from jsonb_array_elements(v_logs) e where
      e#>'{workOrderSnapshot,sourceStock}' is distinct from v_source
      or public.dbmt_safe_numeric(e#>>'{workOrderSnapshot,inputWeight}')<>v_weight
      or public.dbmt_safe_date(e#>>'{workOrderSnapshot,date}') is distinct from v_date
      or public.dbmt_safe_numeric(e->>'labelWeight')<=0) then
    raise exception '출력이력의 투입 원료 또는 작업일이 서로 다릅니다. 사무실에서 확인해주세요.';
  end if;
  v_cost := v_weight * public.dbmt_safe_numeric(v_source->>'price');
  v_inputs := jsonb_build_array(jsonb_build_object(
    'product',v_source->>'product','lot',coalesce(v_source->>'lot',''),'origin',coalesce(v_source->>'origin',''),
    'packunit',coalesce(v_source->>'packunit',''),'proddate',coalesce(v_source->>'proddate',''),
    'stockLocation',coalesce(nullif(v_source->>'stockLocation',''),'가공장'),'sourceStockKey',coalesce(v_source->>'key',''),
    'stockUnitPrice',public.dbmt_safe_numeric(v_source->>'price'),'qty',v_weight,
    'price',public.dbmt_safe_numeric(v_source->>'price'),'amount',v_cost,'samsung',v_source->'samsung'
  ));
  v_products := coalesce((select payload from public.app_data where key='labelProducts'),'[]'::jsonb);
  v_outputs := '[]'::jsonb;
  -- Group mixed-weight labels by the actual printed product/LOT, not the current form.
  for v_base in select (e->'workOrderSnapshot') - array['weight','labelSize','inputWeight','sourceStock','title'] ||
      jsonb_build_object('qty',sum(public.dbmt_safe_numeric(e->>'labelWeight')))
      from jsonb_array_elements(v_logs) e
      group by (e->'workOrderSnapshot') - array['weight','labelSize','inputWeight','sourceStock','title'] loop
    select p into v_snap from jsonb_array_elements(v_products) p
      where p->>'id'=coalesce(nullif(v_base->>'labelProductId',''),case when v_base->>'product'=v_order->>'product' then v_order->>'labelProductId' end);
    if v_snap is null then
      select case when count(*)=1 then jsonb_agg(p)->0 else null end into v_snap
        from jsonb_array_elements(v_products) p where p->>'name'=v_base->>'product';
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
      'qty',v_base->'qty','samsung',null
    ));
  end loop;
  select jsonb_agg(g.row order by g.row->>'product',g.row->>'lot',g.row->>'proddate') into v_outputs
    from (select (e-'qty') || jsonb_build_object('qty',sum(public.dbmt_safe_numeric(e->>'qty'))) as row
      from jsonb_array_elements(v_outputs) e group by e-'qty') g;
  select ceil(v_cost / sum(public.dbmt_safe_numeric(e->>'qty'))) into v_price from jsonb_array_elements(v_outputs) e;
  select jsonb_agg(e || jsonb_build_object('price',v_price,'amount',ceil(v_price*public.dbmt_safe_numeric(e->>'qty')))) into v_outputs from jsonb_array_elements(v_outputs) e;
  v_id := 'prod_label_' || replace(extensions.gen_random_uuid()::text,'-','');
  select coalesce(max(case when raw->>'job_no' ~ '^[0-9]{1,8}$' then (raw->>'job_no')::integer else 0 end),0)+1
    into v_job from public.production_entries where work_date=v_date and deleted_at is null;
  v_entry := jsonb_build_object('id',v_id,'date',to_char(v_date,'YYYY/MM/DD'),'job_no',v_job::text,
    'key',jsonb_build_array(to_char(v_date,'YYYY/MM/DD'),v_job::text),'job_type','생산',
    'note',coalesce(v_order->>'title','') || ' / 라벨 생산완료','inputs',v_inputs,'outputs',v_outputs,
    '_isUser',true,'_labelCompletion',jsonb_build_object('workOrderId',p_work_order_id,'completedAt',now(),'lockedInputCount',1),
    '_serverAudit',jsonb_build_object('authMode','label_pin','savedAt',now()));
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
    to_char(v_date,'YYYY/MM/DD') || ' #' || v_job::text,jsonb_build_object('workOrderId',p_work_order_id,'labelCount',jsonb_array_length(v_ids),'authMode','label_pin'));
  return jsonb_build_object('ok',true,'productionId',v_id,'completions',public.dbmt_label_completion_status());
end;
$dbmt$;

-- Keep the existing personal-session permissions and normal journal save behavior.
do $dbmt$ begin
  if to_regprocedure('public.dbmt_erp_save_production_before_label(text,jsonb,jsonb,text)') is null then
    alter function public.dbmt_erp_save_production(text,jsonb,jsonb,text) rename to dbmt_erp_save_production_before_label;
  end if;
end $dbmt$;
revoke all on function public.dbmt_erp_save_production_before_label(text,jsonb,jsonb,text) from public,anon,authenticated;

create or replace function public.dbmt_erp_save_production(p_token text,p_entry jsonb default null,p_transaction_rows jsonb default '[]'::jsonb,p_replace_id text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $dbmt$
declare
  v_completion public.label_production_completions%rowtype; v_entry jsonb := p_entry;
  v_inputs jsonb; v_outputs jsonb; v_rows jsonb; v_count integer; v_cost numeric; v_price numeric; v_result jsonb;
begin
  -- Permission validation still occurs in the existing save; validate here before reading the ledger.
  if public.dbmt_erp_session_user(p_token) is null then
    return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.');
  end if;
  select * into v_completion from public.label_production_completions
    where production_id in (p_entry->>'id',p_replace_id) limit 1;
  if v_completion.work_order_id is null or p_entry is null or p_entry='null'::jsonb then
    if v_completion.work_order_id is null and p_entry ? '_labelCompletion' then raise exception '라벨 생산완료 정보는 직접 등록할 수 없습니다.'; end if;
    return public.dbmt_erp_save_production_before_label(p_token,p_entry,p_transaction_rows,p_replace_id);
  end if;
  v_count := jsonb_array_length(v_completion.baseline->'inputs');
  if jsonb_typeof(p_entry->'inputs') is distinct from 'array' or jsonb_array_length(p_entry->'inputs')>450
    or (p_entry - array['inputs','outputs','_serverAudit']) is distinct from (v_completion.baseline - array['inputs','outputs','_serverAudit'])
    or (select coalesce(jsonb_agg(e order by n),'[]'::jsonb) from jsonb_array_elements(p_entry->'inputs') with ordinality r(e,n) where n<=v_count)
       is distinct from v_completion.baseline->'inputs'
    or (select jsonb_agg(e-array['price','amount'] order by n) from jsonb_array_elements(p_entry->'outputs') with ordinality r(e,n))
       is distinct from (select jsonb_agg(e-array['price','amount'] order by n) from jsonb_array_elements(v_completion.baseline->'outputs') with ordinality r(e,n)) then
    raise exception '라벨에서 전송된 원료·생산품목·중량은 변경할 수 없습니다. 추가 원료와 부자재만 수정해주세요.';
  end if;
  if exists(select 1 from jsonb_array_elements(p_entry->'inputs') e where coalesce(btrim(e->>'product'),'')=''
    or public.dbmt_safe_numeric(e->>'qty')<=0 or public.dbmt_safe_numeric(e->>'price')<0) then
    raise exception '추가 원료의 품목·투입량·단가를 확인해주세요.';
  end if;
  select jsonb_agg(e || jsonb_build_object('amount',public.dbmt_safe_numeric(e->>'qty')*public.dbmt_safe_numeric(e->>'price')) order by n)
    into v_inputs from jsonb_array_elements(p_entry->'inputs') with ordinality r(e,n);
  select sum(public.dbmt_safe_numeric(e->>'amount')) into v_cost from jsonb_array_elements(v_inputs) e;
  select ceil(v_cost/sum(public.dbmt_safe_numeric(e->>'qty'))) into v_price from jsonb_array_elements(v_completion.baseline->'outputs') e;
  select jsonb_agg(e || jsonb_build_object('price',v_price,'amount',ceil(v_price*public.dbmt_safe_numeric(e->>'qty'))) order by n)
    into v_outputs from jsonb_array_elements(v_completion.baseline->'outputs') with ordinality r(e,n);
  v_entry := v_completion.baseline || jsonb_build_object('inputs',v_inputs,'outputs',v_outputs);
  v_rows := public.dbmt_label_production_transactions(v_entry);
  v_result := public.dbmt_erp_save_production_before_label(p_token,v_entry,v_rows,v_completion.production_id);
  return v_result || case when v_result->>'ok'='true' then jsonb_build_object(
    'entry',(select raw from public.production_entries where id=v_completion.production_id),
    'transactionRows',(select jsonb_agg(raw order by id) from public.transactions where prod_id=v_completion.production_id and deleted_at is null)
  ) else '{}'::jsonb end;
end;
$dbmt$;

create or replace function public.dbmt_erp_get_label_productions(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $dbmt$
declare v_ids jsonb;
begin
  if public.dbmt_erp_session_user(p_token) is null or public.dbmt_erp_has_permission(p_token,'production','view') is not true then
    raise exception '생산일보 조회 권한이 필요합니다.';
  end if;
  select coalesce(jsonb_agg(production_id),'[]'::jsonb) into v_ids from public.label_production_completions;
  return jsonb_build_object('ok',true,'productionIds',v_ids,
    'entries',coalesce((select jsonb_agg(p.raw) from public.production_entries p join public.label_production_completions c on c.production_id=p.id where p.deleted_at is null),'[]'::jsonb),
    'transactions',coalesce((select jsonb_agg(t.raw) from public.transactions t join public.label_production_completions c on c.production_id=t.prod_id where t.deleted_at is null),'[]'::jsonb));
end;
$dbmt$;
revoke all on function public.dbmt_erp_get_label_productions(text) from public;
grant execute on function public.dbmt_erp_get_label_productions(text) to anon,authenticated;
revoke all on function public.dbmt_label_completion_status() from public,anon,authenticated;
revoke all on function public.dbmt_label_production_transactions(jsonb) from public,anon,authenticated;
revoke all on function public.dbmt_label_complete_production(text,text,jsonb) from public;
revoke all on function public.dbmt_label_print_get_data(text) from public;
revoke all on function public.dbmt_label_print_save_logs(text,jsonb) from public;
revoke all on function public.dbmt_erp_save_production(text,jsonb,jsonb,text) from public;
grant execute on function public.dbmt_label_complete_production(text,text,jsonb) to anon,authenticated;
grant execute on function public.dbmt_label_print_get_data(text) to anon,authenticated;
grant execute on function public.dbmt_label_print_save_logs(text,jsonb) to anon,authenticated;
grant execute on function public.dbmt_erp_save_production(text,jsonb,jsonb,text) to anon,authenticated;
notify pgrst,'reload schema';
