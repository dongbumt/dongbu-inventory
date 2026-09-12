-- Install after 38. Keep old inventory grouped; identify newly produced rows.
-- This migration retains Samsung masters and historical transaction metadata.
do $dbmt$ begin
  if to_regprocedure('public.dbmt_label_resubmit_production(text,text,jsonb,text)') is null then
    raise exception '생산품 재고행 설치 전에 라벨 생산완료 36~38을 설치해주세요.';
  end if;
end $dbmt$;

update public.erp_permission_catalog set active=false,updated_at=now() where menu_code='samsung';

create index if not exists idx_transactions_stock_row_id
  on public.transactions ((raw->>'stockRowId'))
  where deleted_at is null and coalesce(raw->>'stockRowId','')<>'';

-- Use the same lock as label completion, including outbound/adjustment writes.
-- Acquiring it before checking dependencies prevents a concurrent shipment from
-- arriving between a journal's validation and its replacement.
create or replace function public.dbmt_stock_row_write_lock()
returns trigger language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  if (tg_op<>'DELETE' and coalesce(new.raw->>'stockRowId','')<>'')
    or (tg_op<>'INSERT' and coalesce(old.raw->>'stockRowId','')<>'') then
    perform pg_advisory_xact_lock(36100910);
  end if;
  if tg_op<>'DELETE' and new.deleted_at is null and coalesce(new.raw->>'stockRowId','')<>'' then
    if jsonb_typeof(new.raw->'stockRowId')<>'string' or length(new.raw->>'stockRowId')>120 then
      raise exception '재고행 식별값을 확인해주세요.';
    end if;
    if new.type='생산입고' then
      if not exists(select 1 from public.production_entries p
        cross join lateral jsonb_array_elements(coalesce(p.raw->'outputs','[]'::jsonb)) e
        where p.deleted_at is null and p.id=coalesce(new.prod_id,new.raw->>'_prodId')
          and e->>'stockRowId'=new.raw->>'stockRowId') then
        raise exception '생산일보의 재고행을 찾을 수 없습니다.';
      end if;
    elsif not exists(select 1 from public.transactions t where t.deleted_at is null and t.type='생산입고'
      and t.raw->>'stockRowId'=new.raw->>'stockRowId') then
      raise exception '선택한 생산품 재고행을 찾을 수 없습니다. 새로고침 후 다시 선택해주세요.';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$dbmt$;
drop trigger if exists trg_transactions_stock_row_lock on public.transactions;
create trigger trg_transactions_stock_row_lock before insert or update or delete
  on public.transactions for each row execute function public.dbmt_stock_row_write_lock();

-- Normalize only an explicit new label row. Missing IDs on existing legacy
-- outputs remain missing even after quantity, price or note edits.
create or replace function public.dbmt_prepare_label_stock_rows(p_entry jsonb,p_old jsonb default null)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
declare v_outputs jsonb:='[]'::jsonb; v_row jsonb;
begin
  for v_row in select e from jsonb_array_elements(coalesce(p_entry->'outputs','[]'::jsonb)) e loop
    if coalesce(v_row->>'stockRowId','')='' and p_old is null then
      v_row:=v_row || jsonb_build_object('stockRowId','stock_' || replace(extensions.gen_random_uuid()::text,'-',''));
    end if;
    v_outputs:=v_outputs || jsonb_build_array(v_row || jsonb_build_object('note',coalesce(v_row->>'note','')));
  end loop;
  return p_entry || jsonb_build_object('outputs',v_outputs);
end;
$dbmt$;

create or replace function public.dbmt_validate_production_stock_rows(p_entry jsonb,p_replace_id text default null)
returns void language plpgsql security definer set search_path=public,extensions as $dbmt$
declare
  v_old jsonb; v_old_id text; v_id text; v_row jsonb; v_new jsonb; v_field text;
  v_outputs jsonb:=coalesce(p_entry->'outputs','[]'::jsonb);
  v_inputs jsonb:=coalesce(p_entry->'inputs','[]'::jsonb);
  v_has_links boolean; v_old_qty numeric; v_new_qty numeric;
begin
  perform pg_advisory_xact_lock(36100910);
  v_old_id:=coalesce(nullif(btrim(p_replace_id),''),p_entry->>'id');
  select raw into v_old from public.production_entries where id=v_old_id and deleted_at is null for update;
  if jsonb_typeof(v_outputs) is distinct from 'array' or jsonb_typeof(v_inputs) is distinct from 'array' then
    raise exception '투입 및 생산 항목 형식을 확인해주세요.';
  end if;
  if exists(select 1 from jsonb_array_elements(v_outputs || v_inputs) e
    where e ? 'stockRowId' and e->'stockRowId'<>'null'::jsonb and
      (jsonb_typeof(e->'stockRowId')<>'string' or length(e->>'stockRowId')>120
        or (coalesce(e->>'stockRowId','')<>'' and btrim(e->>'stockRowId')<>e->>'stockRowId'))) then
    raise exception '생산품 재고행 식별값을 확인해주세요.';
  end if;
  if exists(select 1 from jsonb_array_elements(v_outputs) e where coalesce(e->>'stockRowId','')<>''
    group by e->>'stockRowId' having count(*)>1) then
    raise exception '생산품 재고행 식별값이 중복되었습니다.';
  end if;
  if exists(select 1 from jsonb_array_elements(v_outputs) e where coalesce(e->>'stockRowId','')<>''
    and (jsonb_typeof(e->'qty') is distinct from 'number' or public.dbmt_safe_numeric(e->>'qty')<=0)) then
    raise exception '생산품 중량은 0보다 커야 합니다.';
  end if;
  if exists(select 1 from jsonb_array_elements(v_outputs) e
    join public.production_entries p on p.id<>coalesce(v_old_id,'')
    cross join lateral jsonb_array_elements(coalesce(p.raw->'outputs','[]'::jsonb)) old_row
    where coalesce(e->>'stockRowId','')<>'' and old_row->>'stockRowId'=e->>'stockRowId') then
    raise exception '다른 생산일보에서 사용한 재고행 식별값입니다.';
  end if;
  if exists(select 1 from jsonb_array_elements(v_outputs) e join public.transactions t
    on t.raw->>'stockRowId'=e->>'stockRowId'
    where coalesce(e->>'stockRowId','')<>'' and t.deleted_at is null and t.type in ('입고','생산입고')
      and coalesce(t.prod_id,t.raw->>'_prodId','')<>coalesce(v_old_id,'')) then
    raise exception '다른 입고내역에서 사용한 재고행 식별값입니다.';
  end if;
  if exists(select 1 from jsonb_array_elements(v_inputs) i join jsonb_array_elements(v_outputs) o
    on i->>'stockRowId'=o->>'stockRowId' where coalesce(i->>'stockRowId','')<>'') then
    raise exception '투입 재고행을 새 생산품의 식별값으로 재사용할 수 없습니다.';
  end if;
  -- A registered ID is never silently downgraded by an older client. Removing
  -- an unused row remains allowed; dependent rows must retain their identity.
  for v_row in select e from jsonb_array_elements(coalesce(v_old->'outputs','[]'::jsonb)) e
    where coalesce(e->>'stockRowId','')<>'' loop
    v_id:=v_row->>'stockRowId';
    select e into v_new from jsonb_array_elements(v_outputs) e where e->>'stockRowId'=v_id;
    select exists(select 1 from public.transactions t where t.deleted_at is null
      and t.raw->>'stockRowId'=v_id and coalesce(t.prod_id,t.raw->>'_prodId','')<>coalesce(v_old_id,'')) into v_has_links;
    -- Saved work orders also reserve the identity used by immutable print snapshots.
    v_has_links:=v_has_links or exists(select 1 from public.app_data a
      cross join lateral jsonb_array_elements(case when jsonb_typeof(a.payload)='array' then a.payload else '[]'::jsonb end) e
      where a.key='workOrders' and e#>>'{sourceStock,stockRowId}'=v_id);
    if not v_has_links then continue; end if;
    if v_new is null then raise exception '출고·재투입·이동 또는 작업지시에 연결된 생산품은 삭제할 수 없습니다. 연결 내역을 먼저 정리해주세요.'; end if;
    foreach v_field in array array['product','productId','labelProductId','lot','origin','packunit','proddate','stockLocation'] loop
      if coalesce(v_row->>v_field,case when v_field='stockLocation' then '가공장' else '' end)
        is distinct from coalesce(v_new->>v_field,case when v_field='stockLocation' then '가공장' else '' end) then
        raise exception '출고·재투입·이동 또는 작업지시에 연결된 생산품의 품목·LOT·원산지·규격·생산일·창고는 변경할 수 없습니다.';
      end if;
    end loop;
    if round(public.dbmt_safe_numeric(v_row->>'price'))<>round(public.dbmt_safe_numeric(v_new->>'price')) then
      raise exception '다른 내역에 연결된 생산품의 재고단가는 변경할 수 없습니다.';
    end if;
    v_old_qty:=public.dbmt_safe_numeric(v_row->>'qty');
    v_new_qty:=public.dbmt_safe_numeric(v_new->>'qty');
    if v_new_qty<v_old_qty then
      if exists(
        select 1 from (
          select coalesce(nullif(v_row->>'stockLocation',''),'가공장') place,v_new_qty delta
          union all
          select coalesce(nullif(case when t.type='재고이동' then t.raw->>'fromLocation' else t.raw->>'stockLocation' end,''),'가공장'),
            case when t.type in ('출고','사용','재고이동') then -t.weight
              when t.type in ('입고','생산입고','재고조정') then t.weight else 0 end
          from public.transactions t where t.deleted_at is null and t.raw->>'stockRowId'=v_id
            and coalesce(t.prod_id,t.raw->>'_prodId','')<>coalesce(v_old_id,'')
          union all
          select coalesce(nullif(t.raw->>'toLocation',''),'가공장'),t.weight
          from public.transactions t where t.deleted_at is null and t.raw->>'stockRowId'=v_id and t.type='재고이동'
            and coalesce(t.prod_id,t.raw->>'_prodId','')<>coalesce(v_old_id,'')
        ) movements group by place having sum(delta)<-0.005
      ) then raise exception '이미 출고·사용·이동한 중량보다 생산중량을 줄일 수 없습니다.'; end if;
      if exists(select 1 from public.app_data a
        cross join lateral jsonb_array_elements(case when jsonb_typeof(a.payload)='array' then a.payload else '[]'::jsonb end) e
        where a.key='workOrders' and e#>>'{sourceStock,stockRowId}'=v_id
          and public.dbmt_safe_numeric(e->>'inputWeight')>v_new_qty) then
        raise exception '작업지시에 지정한 투입중량보다 생산중량을 줄일 수 없습니다.';
      end if;
    end if;
  end loop;
end;
$dbmt$;

-- Keep the existing session, production permissions and label completion audit.
do $dbmt$ begin
  if to_regprocedure('public.dbmt_erp_save_production_before_stock_rows(text,jsonb,jsonb,text)') is null then
    alter function public.dbmt_erp_save_production(text,jsonb,jsonb,text) rename to dbmt_erp_save_production_before_stock_rows;
  end if;
end $dbmt$;

create or replace function public.dbmt_erp_save_production(p_token text,p_entry jsonb default null,p_transaction_rows jsonb default '[]'::jsonb,p_replace_id text default null)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
declare v_entry jsonb:=p_entry; v_old jsonb; v_old_id text; v_result jsonb; v_action text; v_is_label boolean;
begin
  if public.dbmt_erp_session_user(p_token) is null then
    return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.');
  end if;
  perform pg_advisory_xact_lock(36100910);
  v_old_id:=coalesce(nullif(btrim(p_replace_id),''),p_entry->>'id');
  select raw into v_old from public.production_entries where id=v_old_id and deleted_at is null;
  v_action:=case when p_entry is null or p_entry='null'::jsonb then 'delete' when v_old is not null then 'update' else 'create' end;
  if public.dbmt_erp_has_permission(p_token,'production',v_action) is not true then
    return public.dbmt_erp_permission_denied(public.dbmt_erp_session_user(p_token),'production',v_action);
  end if;
  v_is_label:=exists(select 1 from public.label_production_completions where production_id in(p_entry->>'id',p_replace_id));
  if v_is_label and v_action<>'delete' then
    v_entry:=public.dbmt_prepare_label_stock_rows(p_entry,v_old);
  end if;
  perform public.dbmt_validate_production_stock_rows(case when v_action='delete' then null else v_entry end,v_old_id);
  if not v_is_label and v_action<>'delete' then
    -- Existing legacy outputs may keep empty IDs. New rows supplied by current
    -- clients carry an ID; never manufacture one for a legacy row on an edit.
    if v_old is null and exists(select 1 from jsonb_array_elements(coalesce(v_entry->'outputs','[]'::jsonb)) e
      where coalesce(e->>'stockRowId','')='') then
      raise exception '새 생산품의 재고행 식별값이 없습니다. 새로고침 후 다시 저장해주세요.';
    end if;
    if jsonb_typeof(p_transaction_rows) is distinct from 'array' then raise exception '생산 연계 거래 형식을 확인해주세요.'; end if;
    if exists(
      with expected as (
        select e->>'stockRowId' row_id,'생산입고' kind,public.dbmt_safe_numeric(e->>'qty') qty,coalesce(e->>'note','') note,coalesce(e->>'product','') product,coalesce(e->>'lot','') lot,coalesce(e->>'origin','') origin,coalesce(e->>'packunit','') packunit
          from jsonb_array_elements(coalesce(v_entry->'outputs','[]'::jsonb)) e where coalesce(e->>'stockRowId','')<>''
        union all
        select e->>'stockRowId','사용',public.dbmt_safe_numeric(e->>'qty'),coalesce(e->>'stockNote',''),coalesce(e->>'product',''),coalesce(e->>'lot',''),coalesce(e->>'origin',''),coalesce(e->>'packunit','')
          from jsonb_array_elements(coalesce(v_entry->'inputs','[]'::jsonb)) e where coalesce(e->>'stockRowId','')<>''
      ), actual as (
        select e->>'stockRowId' row_id,e->>'type' kind,public.dbmt_safe_numeric(e->>'weight') qty,coalesce(e->>'stockNote','') note,coalesce(e->>'product','') product,coalesce(e->>'lot','') lot,coalesce(e->>'origin','') origin,coalesce(e->>'packunit','') packunit
          from jsonb_array_elements(p_transaction_rows) e where coalesce(e->>'stockRowId','')<>''
      ) select 1 from (
        (select * from expected except all select * from actual)
        union all (select * from actual except all select * from expected)
      ) difference
    ) then raise exception '생산일보와 연계 재고행의 식별값·중량·비고가 다릅니다. 새로고침 후 다시 저장해주세요.'; end if;
  end if;
  v_result:=public.dbmt_erp_save_production_before_stock_rows(p_token,v_entry,p_transaction_rows,p_replace_id);
  return v_result;
end;
$dbmt$;

-- Server-generated label postings carry the same permanent ID as their source
-- journal row. Keep legacy Samsung snapshots without creating new selections.
create or replace function public.dbmt_label_production_transactions(p_entry jsonb)
returns jsonb language sql security definer set search_path=public,extensions as $dbmt$
  select coalesce(jsonb_agg((e-array['qty','manualPrice']) || jsonb_build_object(
    'samsungVendorId',coalesce(e#>>'{samsung,vendorId}',''),
    'samsungVendorName',coalesce(e#>>'{samsung,vendorName}',''),
    'samsungProductRowId',coalesce(e#>>'{samsung,productRowId}',''),
    'samsungProductId',coalesce(e#>>'{samsung,productId}',''),
    'samsungProductName',coalesce(e#>>'{samsung,productName}',''),
    'samsungSpec',coalesce(e#>>'{samsung,spec}',''),
    'stockRowId',coalesce(e->>'stockRowId',''),
    'stockNote',case when kind='out' then coalesce(e->>'note','') else coalesce(e->>'stockNote','') end,
    'id','tx_' || (p_entry->>'id') || '_' || kind || '_' || (n-1)::text,
    'date',replace(p_entry->>'date','/','-'),'type',case when kind='use' then '사용' else '생산입고' end,
    'weight',e->'qty','trader',case when kind='use' then '' else '생산작업' end,
    'stockLocation',coalesce(nullif(e->>'stockLocation',''),'가공장'),
    'stockProddate',coalesce(e->>'proddate',''),'stockUnitPrice',coalesce(e->'stockUnitPrice',e->'price','0'::jsonb),
    '_isUser',true,'_isProdUse',kind='use','_isProdOut',kind='out','_prodId',p_entry->>'id',
    'note',coalesce(p_entry->>'job_type','생산') || case when kind='use' then '작업 ' else '완료 ' end ||
      (p_entry->>'date') || ' #' || (p_entry->>'job_no') ||
      case when coalesce(p_entry->>'note','')='' then '' else ' / ' || (p_entry->>'note') end
  ) order by kind,n),'[]'::jsonb)
  from (
    select e,n,'use' kind from jsonb_array_elements(p_entry->'inputs') with ordinality a(e,n)
    union all select e,n,'out' kind from jsonb_array_elements(p_entry->'outputs') with ordinality a(e,n)
  ) rows;
$dbmt$;

revoke all on function public.dbmt_stock_row_write_lock() from public,anon,authenticated;
revoke all on function public.dbmt_prepare_label_stock_rows(jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.dbmt_validate_production_stock_rows(jsonb,text) from public,anon,authenticated;
revoke all on function public.dbmt_label_production_transactions(jsonb) from public,anon,authenticated;
revoke all on function public.dbmt_erp_save_production_before_stock_rows(text,jsonb,jsonb,text) from public,anon,authenticated;
revoke all on function public.dbmt_erp_save_production(text,jsonb,jsonb,text) from public;
grant execute on function public.dbmt_erp_save_production(text,jsonb,jsonb,text) to anon,authenticated;

-- Assign IDs only after printed output groups have been consolidated.
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
    'price',public.dbmt_safe_numeric(v_source->>'price'),'amount',v_cost,'samsung',v_source->'samsung',
    'stockRowId',coalesce(v_source->>'stockRowId',''),'stockNote',coalesce(v_source->>'stockNote','')
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
      'qty',v_base->'qty','samsung',null,'note',coalesce(v_base->>'note','')
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
    to_char(v_date,'YYYY/MM/DD') || ' #' || v_job::text,jsonb_build_object('workOrderId',p_work_order_id,'labelCount',jsonb_array_length(v_ids),'authMode','label_pin'));
  return jsonb_build_object('ok',true,'productionId',v_id,'completions',public.dbmt_label_completion_status());
end;
$dbmt$;

revoke all on function public.dbmt_label_complete_production(text,text,jsonb) from public;
grant execute on function public.dbmt_label_complete_production(text,text,jsonb) to anon,authenticated;
notify pgrst,'reload schema';

-- Preserve row selection and per-product note when the adjustment RPC builds raw.
create or replace function public.dbmt_erp_save_stock_adjust(p_token text, p_record jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_user_id uuid := public.dbmt_erp_session_user(p_token);
  v_user public.erp_users%rowtype;
  v_role public.erp_roles%rowtype;
  v_id text := nullif(btrim(coalesce(p_record->>'id', '')), '');
  v_date date := public.dbmt_safe_date(p_record->>'date');
  v_product text := btrim(coalesce(p_record->>'product', ''));
  v_origin text := btrim(coalesce(p_record->>'origin', ''));
  v_packunit text := btrim(coalesce(p_record->>'packunit', ''));
  v_location text := btrim(coalesce(p_record->>'stockLocation', ''));
  v_lot text := btrim(coalesce(p_record->>'lot', ''));
  v_proddate date := public.dbmt_safe_date(p_record->>'proddate');
  v_price numeric := public.dbmt_safe_numeric(p_record->>'price');
  v_current numeric := public.dbmt_safe_numeric(p_record->>'stockBefore');
  v_actual numeric := public.dbmt_safe_numeric(p_record->>'stockActual');
  v_diff numeric;
  v_note text := btrim(coalesce(p_record->>'note', ''));
  v_transaction jsonb;
  v_log_entry jsonb;
  v_logs jsonb;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'session_expired', 'message', '개인 사용자 로그인이 만료되었습니다.');
  end if;
  if public.dbmt_erp_has_permission(p_token, 'stock', 'update') is not true then
    return public.dbmt_erp_permission_denied(v_user_id, 'stock', 'update');
  end if;
  if jsonb_typeof(coalesce(p_record, '{}'::jsonb)) <> 'object' then raise exception '재고 정리 값이 올바르지 않습니다.'; end if;
  if v_date is null then raise exception '재고 정리 날짜를 입력해주세요.'; end if;
  if v_product = '' or length(v_product) > 200 then raise exception '품목 정보를 확인해주세요.'; end if;
  if v_location = '' or length(v_location) > 120 then raise exception '재고 지점을 확인해주세요.'; end if;
  if length(v_origin) > 100 or length(v_packunit) > 60 or length(v_lot) > 120 then raise exception '재고 식별정보가 너무 깁니다.'; end if;
  if v_current is null or v_actual is null then raise exception '현재 재고와 실제 재고를 숫자로 입력해주세요.'; end if;
  v_price := coalesce(v_price, 0);
  if v_price < 0 then raise exception '단가는 0 이상이어야 합니다.'; end if;
  v_diff := round(v_actual - v_current, 2);
  if abs(v_diff) < 0.01 then raise exception '현재 재고와 실제 재고가 같습니다.'; end if;
  if length(v_note) > 500 then raise exception '메모는 500자 이내로 입력해주세요.'; end if;
  if v_id is null then v_id := 'stock_adjust_' || encode(extensions.gen_random_bytes(10), 'hex'); end if;
  if v_id !~ '^[A-Za-z0-9_-]{1,100}$' then raise exception '재고 정리 식별값이 올바르지 않습니다.'; end if;

  select * into v_user from public.erp_users where id = v_user_id;
  select * into v_role from public.erp_roles where id = v_user.role_id;

  v_transaction := jsonb_strip_nulls(jsonb_build_object(
    'id', v_id, 'date', v_date::text, 'type', '재고조정', 'trader', '재고정리',
    'product', v_product, 'origin', v_origin, 'storage', '', 'packunit', v_packunit,
    'stockLocation', v_location, 'lot', v_lot, 'proddate', v_proddate,
    'stockProddate', v_proddate, 'stockUnitPrice', v_price,
    'stockRowId', coalesce(p_record->>'stockRowId',''),
    'stockNote', coalesce(p_record->>'stockNote',''),
    'sourceStockKey', coalesce(p_record->>'sourceStockKey',''),
    'weight', v_diff, 'price', v_price, 'amount', round(v_diff * v_price),
    'note', v_note, '_isUser', true, '_isStockAdjust', true,
    'stockBefore', v_current, 'stockActual', v_actual,
    'audit', jsonb_build_object(
      'authMode', 'personal_session', 'userId', v_user.id,
      'loginId', v_user.login_id, 'displayName', v_user.display_name,
      'roleCode', v_role.code, 'savedAt', clock_timestamp()
    )
  ));

  insert into public.transactions(
    id, date, type, product, origin, packunit, trader, storage, lot, proddate,
    weight, price, amount, note, is_user, is_stock_adjust, stock_before,
    stock_actual, stock_unit_price, stock_proddate, stock_location, raw, updated_at, deleted_at
  ) values (
    v_id, v_date, '재고조정', v_product, v_origin, v_packunit, '재고정리', '', v_lot, v_proddate,
    v_diff, v_price, round(v_diff * v_price), v_note, true, true, v_current,
    v_actual, v_price, v_proddate, v_location, v_transaction, now(), null
  );

  v_log_entry := jsonb_build_object(
    'id', 'cl_user_' || encode(extensions.gen_random_bytes(8), 'hex'),
    'at', clock_timestamp(), 'menu', '재고현황', 'action', '재고정리',
    'target', v_product, 'summary', v_location || ' / ' || v_product || ' / ' ||
      v_current::text || 'KG → ' || v_actual::text || 'KG', 'refId', v_id,
    'authMode', 'personal_session', 'userId', v_user.id,
    'userName', v_user.display_name, 'userLoginId', v_user.login_id,
    'roleCode', v_role.code, 'roleName', v_role.name
  );
  insert into public.app_data(key, payload, updated_at)
  values ('dataChangeLogs', '[]'::jsonb, now()) on conflict (key) do nothing;
  select case when jsonb_typeof(payload) = 'array' then payload else '[]'::jsonb end
  into v_logs from public.app_data where key = 'dataChangeLogs' for update;
  update public.app_data set payload = jsonb_build_array(v_log_entry) || v_logs, updated_at = now()
  where key = 'dataChangeLogs';

  update public.erp_user_sessions set last_used_at = now()
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values ('재고현황', '재고정리', v_id, v_log_entry->>'summary',
    jsonb_build_object('userId', v_user.id, 'loginId', v_user.login_id,
      'displayName', v_user.display_name, 'roleCode', v_role.code,
      'authMode', 'personal_session', 'transaction', v_transaction));

  return jsonb_build_object('ok', true, 'transaction', v_transaction, 'logEntry', v_log_entry);
end;
$dbmt$;

revoke all on function public.dbmt_erp_save_stock_adjust(text, jsonb) from public;
grant execute on function public.dbmt_erp_save_stock_adjust(text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
