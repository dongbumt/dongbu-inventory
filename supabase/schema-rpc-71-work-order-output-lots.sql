-- Add opt-in output LOT choices; no historical work order, label or journal is rewritten.
create or replace function public.dbmt_label_lot_key(p_value text)
returns text language sql immutable set search_path='' as $$
  select upper(regexp_replace(coalesce(p_value,''),'[[:space:] ]+','','g'));
$$;
revoke all on function public.dbmt_label_lot_key(text) from public,anon,authenticated;

create or replace function public.dbmt_validate_work_order_output_lots(p_order jsonb,p_before jsonb default null)
returns void language plpgsql security invoker set search_path='' as $$
declare v_lot jsonb; v_sources jsonb;
begin
  if not (p_order ? 'outputLotSelectionVersion') then
    if p_order ? 'outputLots' or p_order ? 'defaultOutputLot' or p_before->>'outputLotSelectionVersion'='1' then
      raise exception '출력 이력번호 설정을 확인해주세요. 최신 화면에서 다시 저장해주세요.';
    end if;
    return;
  end if;
  if p_order->'outputLotSelectionVersion' is distinct from '1'::jsonb
    or jsonb_typeof(p_order->'outputLots') is distinct from 'array' then raise exception '출력 이력번호 설정 형식을 확인해주세요.'; end if;
  if jsonb_array_length(p_order->'outputLots') not between 1 and 3 then raise exception '제품 라벨 이력번호는 1~3개 선택해주세요.'; end if;
  v_sources:=public.dbmt_work_order_source_inputs(p_order);
  for v_lot in select value from jsonb_array_elements(p_order->'outputLots') loop
    if jsonb_typeof(v_lot)<>'string' or public.dbmt_label_lot_key(v_lot#>>'{}')='' or length(v_lot#>>'{}')>100 then
      raise exception '제품 라벨 이력번호를 확인해주세요.';
    end if;
    if not exists(select 1 from jsonb_array_elements(v_sources) s
      where public.dbmt_label_lot_key(s#>>'{sourceStock,lot}')=public.dbmt_label_lot_key(v_lot#>>'{}')) then
      raise exception '제품 라벨 이력번호는 투입 원료육의 이력번호에서 선택해주세요.';
    end if;
  end loop;
  if exists(select 1 from jsonb_array_elements_text(p_order->'outputLots') l group by public.dbmt_label_lot_key(l) having count(*)>1) then
    raise exception '제품 라벨 이력번호가 중복됩니다.';
  end if;
  if jsonb_typeof(p_order->'defaultOutputLot') is distinct from 'string'
    or jsonb_typeof(p_order->'lot') is distinct from 'string'
    or not exists(select 1 from jsonb_array_elements_text(p_order->'outputLots') l
    where public.dbmt_label_lot_key(l)=public.dbmt_label_lot_key(p_order->>'defaultOutputLot'))
    or public.dbmt_label_lot_key(p_order->>'lot')<>public.dbmt_label_lot_key(p_order->>'defaultOutputLot') then
    raise exception '기본 출력 이력번호를 선택해주세요.';
  end if;
end;
$$;
revoke all on function public.dbmt_validate_work_order_output_lots(jsonb,jsonb) from public,anon,authenticated;

create or replace function public.dbmt_label_order_for_output_lot(p_order jsonb,p_snapshot jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
  perform public.dbmt_validate_work_order_output_lots(p_order);
  if p_order->>'outputLotSelectionVersion'='1' then
    if p_snapshot->'outputLotSelectionVersion' is distinct from '1'::jsonb
      or p_snapshot->'outputLots' is distinct from p_order->'outputLots'
      or p_snapshot->'defaultOutputLot' is distinct from p_order->'defaultOutputLot' then
      raise exception '작업지시의 출력 이력번호 설정이 변경되었습니다. 새로고침 후 다시 선택해주세요.';
    end if;
    if not exists(select 1 from jsonb_array_elements_text(p_order->'outputLots') l where l=p_snapshot->>'lot') then
      raise exception '작업지시에서 선택한 이력번호만 출력할 수 있습니다.';
    end if;
    return p_order||jsonb_build_object('lot',p_snapshot->>'lot');
  elsif p_snapshot ? 'outputLotSelectionVersion' then raise exception '작업지시의 이력번호 설정을 다시 확인해주세요.';
  end if;
  return p_order;
end;
$$;
revoke all on function public.dbmt_label_order_for_output_lot(jsonb,jsonb) from public,anon,authenticated;

-- Inner labels live in a separate ledger, never in the outer production ledger.
create schema if not exists label_print_private;
revoke all on schema label_print_private from public,anon,authenticated;
create table if not exists label_print_private.inner_print_logs(
  id text primary key check(length(id) between 1 and 200),
  work_order_id text not null check(length(work_order_id) between 1 and 200),
  code text not null unique,
  lot text not null,
  weight numeric not null check(weight>=0 and weight=round(weight,2)),
  status text not null default 'active' check(status in ('active','void')),
  data jsonb not null check(jsonb_typeof(data)='object'),
  created_at timestamptz not null default clock_timestamp()
);
alter table label_print_private.inner_print_logs enable row level security;
revoke all on label_print_private.inner_print_logs from public,anon,authenticated;
create index if not exists idx_inner_labels_order_page on label_print_private.inner_print_logs(work_order_id,created_at desc,id desc);
create index if not exists idx_inner_labels_order_lot on label_print_private.inner_print_logs(work_order_id,lot,status);

create or replace function public.dbmt_label_inner_prints(p_pin text,p_work_order_id text,p_before_id text default null,p_lot text default null,p_limit integer default 6)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_logs jsonb;v_totals jsonb;v_before label_print_private.inner_print_logs%rowtype;v_limit integer;
begin
  if public.dbmt_check_label_print_pin(p_pin) is not true then raise exception '라벨전용 PIN이 맞지 않습니다.'; end if;
  if nullif(p_work_order_id,'') is null or length(p_work_order_id)>200 then raise exception '작업지시를 선택해주세요.'; end if;
  v_limit:=least(greatest(coalesce(p_limit,6),1),100);
  if p_before_id is not null then
    select * into v_before from label_print_private.inner_print_logs where id=p_before_id and work_order_id=p_work_order_id;
    if not found then raise exception '내포장 출력이력 페이지를 다시 열어주세요.'; end if;
  end if;
  select coalesce(jsonb_agg(g),'[]'::jsonb) into v_totals from (
    select lot,count(*) as count,coalesce(sum(weight),0) as weight
      from label_print_private.inner_print_logs where work_order_id=p_work_order_id and status='active' group by lot
  ) g;
  select coalesce(jsonb_agg(data order by created_at desc,id desc),'[]'::jsonb) into v_logs from (
    select data,created_at,id from label_print_private.inner_print_logs
    where work_order_id=p_work_order_id and (p_lot is null or public.dbmt_label_lot_key(lot)=public.dbmt_label_lot_key(p_lot))
      and (p_before_id is null or (created_at,id)<(v_before.created_at,v_before.id))
    order by created_at desc,id desc limit v_limit+1
  ) p;
  return jsonb_build_object('ok',true,'workOrderId',p_work_order_id,'totals',v_totals,
    'logs',case when jsonb_array_length(v_logs)>v_limit then v_logs-(jsonb_array_length(v_logs)-1) else v_logs end,
    'nextBeforeId',case when jsonb_array_length(v_logs)>v_limit then v_logs#>>array[(v_limit-1)::text,'id'] else null end);
end;
$$;
revoke all on function public.dbmt_label_inner_prints(text,text,text,text,integer) from public;
grant execute on function public.dbmt_label_inner_prints(text,text,text,text,integer) to anon,authenticated;

create or replace function public.dbmt_label_save_inner_prints(p_pin text,p_logs jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_log jsonb;v_old label_print_private.inner_print_logs%rowtype;v_order jsonb;v_orders jsonb;v_products jsonb;v_expected jsonb;
  v_product jsonb;v_field text;v_weight numeric;v_work text;v_data jsonb;
begin
  if public.dbmt_check_label_print_pin(p_pin) is not true then raise exception '라벨전용 PIN이 맞지 않습니다.'; end if;
  if jsonb_typeof(p_logs) is distinct from 'array' then raise exception '내포장 출력이력 형식을 확인해주세요.'; end if;
  if jsonb_array_length(p_logs) not between 1 and 500 then raise exception '내포장 라벨은 한 번에 1~500장까지 저장할 수 있습니다.'; end if;
  if exists(select 1 from jsonb_array_elements(p_logs) l group by l->>'id' having count(*)>1) then raise exception '내포장 라벨 식별값이 중복됩니다.'; end if;
  v_work:=p_logs#>>'{0,workOrderId}';
  perform pg_advisory_xact_lock(36100910);
  select payload into v_orders from public.app_data where key='workOrders' for update;
  select payload into v_products from public.app_data where key='labelProducts';
  for v_log in select value from jsonb_array_elements(p_logs) loop
    if jsonb_typeof(v_log)<>'object' or nullif(v_log->>'id','') is null or length(v_log->>'id')>200
      or v_log->>'workOrderId' is distinct from v_work or nullif(v_work,'') is null
      or coalesce(v_log->>'code','') !~ '^IN[0-9]{10}-[0-9A-Z]{1,6}$'
      or v_log->>'packageKind' is distinct from 'inner' or coalesce(v_log->>'status','active') not in ('active','void') then
      raise exception '내포장 라벨 식별값 또는 상태를 확인해주세요.';
    end if;
    select * into v_old from label_print_private.inner_print_logs where id=v_log->>'id';
    if found then
      if (v_log-array['status','voidedAt','voidReason','reprintCount','lastReprintedAt']) is distinct from
        (v_old.data-array['status','voidedAt','voidReason','reprintCount','lastReprintedAt']) then raise exception '저장된 내포장 라벨의 내용은 변경할 수 없습니다.'; end if;
      v_data:=v_old.data;
      if v_log->>'status'='void' then v_data:=v_data||jsonb_build_object('status','void','voidedAt',v_log->>'voidedAt','voidReason',v_log->>'voidReason'); end if;
      if public.dbmt_safe_numeric(v_log->>'reprintCount')>public.dbmt_safe_numeric(v_old.data->>'reprintCount') then
        v_data:=v_data||jsonb_build_object('reprintCount',v_log->'reprintCount','lastReprintedAt',v_log->>'lastReprintedAt');
      end if;
      update label_print_private.inner_print_logs set data=v_data,status=coalesce(v_data->>'status','active') where id=v_old.id;
      continue;
    end if;
    select e into v_order from jsonb_array_elements(v_orders) e where e->>'id'=v_work;
    if v_order is null or v_order ? '_carryoverTo' then raise exception '작업지시를 확인해주세요. 이월한 작업에는 새 라벨을 추가할 수 없습니다.'; end if;
    if v_log#>>'{workOrderSnapshot,id}' is distinct from v_order->>'id'
      or v_log#>'{workOrderSnapshot,sourceStock}' is distinct from v_order->'sourceStock'
      or v_log#>'{workOrderSnapshot,sourceInputs}' is distinct from v_order->'sourceInputs'
      or public.dbmt_safe_numeric(v_log#>>'{workOrderSnapshot,inputWeight}')<>public.dbmt_safe_numeric(v_order->>'inputWeight') then raise exception '작업지시의 투입정보가 변경되었습니다. 새로고침해주세요.'; end if;
    v_order:=public.dbmt_label_order_for_output_lot(v_order,v_log->'workOrderSnapshot');
    if v_log#>'{workOrderSnapshot,productSelectionVersion}'='1'::jsonb then
      select e into v_product from jsonb_array_elements(v_products) e where e->>'id'=v_log#>>'{workOrderSnapshot,labelProductId}';
      if v_product is null then raise exception '선택한 생산품목을 찾을 수 없습니다.'; end if;
      v_expected:=public.dbmt_label_selected_product_order(v_order,v_product);
    else v_expected:=v_order||jsonb_build_object('mfgdate',coalesce(nullif(v_order->>'mfgdate',''),v_order->>'date',''));
    end if;
    foreach v_field in array array['date','product','origin','grade','mfgdate','expdate','labelProductId','itemno','ingredients','temptype'] loop
      if coalesce(v_log#>>array['workOrderSnapshot',v_field],'')<>coalesce(v_expected->>v_field,'') then raise exception '내포장 라벨의 품목 또는 작업지시 정보가 변경되었습니다.'; end if;
    end loop;
    v_weight:=public.dbmt_safe_numeric(v_log->>'labelWeight');
    if jsonb_typeof(v_log->'labelWeight') is distinct from 'number' or v_weight<0 or v_weight>1000 or round(v_weight,2)<>v_weight
      or (v_weight=0 and v_log->'weightOmitted' is distinct from 'true'::jsonb)
      or public.dbmt_safe_numeric(v_log#>>'{workOrderSnapshot,weight}')<>v_weight
      or v_log->>'lot' is distinct from v_log#>>'{workOrderSnapshot,lot}'
      or coalesce(v_log->>'lot','')<>coalesce(nullif(v_order->>'lot',''),v_order#>>'{sourceStock,lot}','')
      or v_log->>'product' is distinct from v_expected->>'product' then raise exception '내포장 라벨의 이력번호 또는 중량을 확인해주세요.'; end if;
    insert into label_print_private.inner_print_logs(id,work_order_id,code,lot,weight,status,data)
      values(v_log->>'id',v_work,v_log->>'code',coalesce(v_log->>'lot',''),v_weight,coalesce(v_log->>'status','active'),v_log);
  end loop;
  return public.dbmt_label_inner_prints(p_pin,v_work);
end;
$$;
revoke all on function public.dbmt_label_save_inner_prints(text,jsonb) from public;
grant execute on function public.dbmt_label_save_inner_prints(text,jsonb) to anon,authenticated;

-- Retain the installed concurrency, carry-over, product and snapshot protections.
do $migration$
declare d text;m text;
begin
  select pg_get_functiondef('public.dbmt_erp_write_work_order(text,jsonb,text,boolean)'::regprocedure) into d;
  m:='perform public.dbmt_work_order_source_inputs(p_row);';
  if position(m in d)=0 then raise exception 'Unexpected work-order write definition'; end if;
  d:=replace(d,m,m||' perform public.dbmt_validate_work_order_output_lots(p_row,v_old);');execute d;
  select pg_get_functiondef('public.dbmt_label_print_save_logs(text,jsonb)'::regprocedure) into d;
  m:='if (v_new->''workOrderSnapshot'') ? ''productSelectionVersion'' then';
  if position(m in d)=0 then raise exception 'Unexpected label validation definition'; end if;
  d:=replace(d,m,'v_order:=public.dbmt_label_order_for_output_lot(v_order,v_new->''workOrderSnapshot''); if coalesce(v_new->>''packageKind'',''outer'')<>''outer'' then raise exception ''내포장 라벨은 별도 집계로 저장해주세요.''; end if; '||m);execute d;
  -- Carry only output choices still present in the carried raw allocations.
  select pg_get_functiondef('public.dbmt_erp_carry_work_order(text,text,date,jsonb,text,uuid)'::regprocedure) into d;
  m:='v_meta:=jsonb_build_object(';
  if position(m in d)=0 then raise exception 'Unexpected carry-over definition'; end if;
  d:=replace(d,m,$patch$
    if v_child->>'outputLotSelectionVersion'='1' then
      select jsonb_agg(l order by n) into v_meta from jsonb_array_elements(v_child->'outputLots') with ordinality a(l,n)
        where exists(select 1 from jsonb_array_elements(v_inputs) s where public.dbmt_label_lot_key(s#>>'{sourceStock,lot}')=public.dbmt_label_lot_key(l#>>'{}'));
      if v_meta is null then v_meta:=jsonb_build_array(v_inputs#>>'{0,sourceStock,lot}'); end if;
      v_child:=v_child||jsonb_build_object('outputLots',v_meta,'defaultOutputLot',v_meta->>0,'lot',v_meta->>0);
      perform public.dbmt_validate_work_order_output_lots(v_child);
    end if;
  $patch$||m);execute d;
end;
$migration$;
notify pgrst,'reload schema';
