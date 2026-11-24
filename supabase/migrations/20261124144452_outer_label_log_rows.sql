-- Keep exact historical snapshots and their original history order.
-- Coordinate the cutover with the existing label, production and PDA writers.
set local lock_timeout='5s';
select pg_advisory_xact_lock(36100910);

create sequence label_print_private.outer_print_revision_seq as bigint;
create table label_print_private.outer_print_logs (
  id text primary key,
  work_order_id text not null,
  code text not null unique,
  data jsonb not null,
  seq bigint generated always as identity unique,
  revision bigint not null default nextval('label_print_private.outer_print_revision_seq'),
  check (jsonb_typeof(data)='object'
    and (data->>'id') is not distinct from id
    and (data->>'workOrderId') is not distinct from work_order_id
    and (data->>'code') is not distinct from code)
);
alter sequence label_print_private.outer_print_revision_seq owned by label_print_private.outer_print_logs.revision;
create index outer_print_logs_work_order_revision
  on label_print_private.outer_print_logs(work_order_id,revision);
alter table label_print_private.outer_print_logs enable row level security;
revoke all on table label_print_private.outer_print_logs from public,anon,authenticated,service_role;
revoke all on sequence label_print_private.outer_print_revision_seq from public,anon,authenticated,service_role;

do $backfill$
declare legacy jsonb;
begin
  select payload into legacy from public.app_data where key='labelPrintLogs' for update;
  legacy:=coalesce(legacy,'[]'::jsonb);
  if jsonb_typeof(legacy)<>'array' then raise exception 'Unexpected outer label history format'; end if;
  insert into label_print_private.outer_print_logs(id,work_order_id,code,data)
    select row->>'id',row->>'workOrderId',row->>'code',row
    from jsonb_array_elements(legacy) with ordinality source(row,n) order by n;
  if legacy is distinct from (
    select coalesce(jsonb_agg(l.data order by l.seq),'[]'::jsonb) from label_print_private.outer_print_logs l
  ) then raise exception 'Outer label backfill did not exactly match the original history'; end if;
end;
$backfill$;

-- General ERP data writes must never overwrite the preserved cutover snapshot.
create function label_print_private.protect_outer_history_archive()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if (tg_op<>'INSERT' and old.key='labelPrintLogs') or (tg_op<>'DELETE' and new.key='labelPrintLogs') then
    raise exception '외포장 라벨 이력은 라벨전용 화면에서 변경해주세요.';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function label_print_private.protect_outer_history_archive() from public,anon,authenticated,service_role;
create trigger trg_protect_outer_history_archive before insert or update or delete on public.app_data
  for each row execute function label_print_private.protect_outer_history_archive();

create function label_print_private.outer_log_rows(p_order_id text)
returns jsonb language sql stable security invoker set search_path='' as $$
  select coalesce(jsonb_agg(l.data order by l.seq),'[]'::jsonb)
  from (
    select data,seq from label_print_private.outer_print_logs where work_order_id=p_order_id
    union all
    select data,seq from label_print_private.outer_print_logs where p_order_id is null
  ) l;
$$;

create function label_print_private.outer_order_revision(p_order_id text)
returns bigint language sql stable security invoker set search_path='' as $$
  select coalesce((select l.revision from label_print_private.outer_print_logs l
    where l.work_order_id=p_order_id order by l.revision desc limit 1),0);
$$;

create function label_print_private.outer_order_summaries(p_order_id text)
returns jsonb language sql stable security invoker set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'workOrderId', totals.work_order_id, 'count', totals.active_count,
    'weight', totals.weight, 'totalCount', totals.total_count
  ) order by totals.work_order_id),'[]'::jsonb)
  from (
    select l.work_order_id,
      count(*) filter (where l.data->>'status' is distinct from 'void') as active_count,
      coalesce(sum(public.dbmt_safe_numeric(l.data->>'labelWeight'))
        filter (where l.data->>'status' is distinct from 'void'),0) as weight,
      count(*) as total_count
    from (
      select work_order_id,data from label_print_private.outer_print_logs where work_order_id=p_order_id
      union all
      select work_order_id,data from label_print_private.outer_print_logs where p_order_id is null
    ) l
    group by l.work_order_id
  ) totals;
$$;

create function label_print_private.outer_order_completion(p_order_id text)
returns jsonb language sql stable security invoker set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'workOrderId', c.work_order_id, 'productionId', c.production_id,
    'completedAt', c.completed_at, 'date', coalesce(p.raw->>'date',c.baseline->>'date'),
    'jobNo', coalesce(p.raw->>'job_no',c.baseline->>'job_no'), 'deleted', p.deleted_at is not null
  )), '[]'::jsonb)
  from public.label_production_completions c join public.production_entries p on p.id=c.production_id
  where c.work_order_id=p_order_id;
$$;
revoke all on function label_print_private.outer_log_rows(text),label_print_private.outer_order_revision(text),
  label_print_private.outer_order_summaries(text),label_print_private.outer_order_completion(text)
  from public,anon,authenticated,service_role;

create or replace function public.dbmt_label_print_get_data(p_pin text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if public.dbmt_check_label_print_pin(p_pin) is not true then raise exception '라벨전용 PIN이 맞지 않습니다.'; end if;
  return jsonb_build_object('appData', jsonb_build_object(
    'workOrders', coalesce((select payload from public.app_data where key='workOrders'),'[]'::jsonb),
    'labelProducts', coalesce((select payload from public.app_data where key='labelProducts'),'[]'::jsonb),
    'labelPrintLogs', label_print_private.outer_log_rows(null)
  ), 'completions', public.dbmt_label_completion_status());
end;
$$;

create or replace function public.dbmt_label_print_get_data(p_pin text,p_work_order_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare orders jsonb;
begin
  if public.dbmt_check_label_print_pin(p_pin) is not true then raise exception '라벨전용 PIN이 맞지 않습니다.'; end if;
  if p_work_order_id is not null and (btrim(p_work_order_id)='' or length(p_work_order_id)>120) then
    raise exception '작업지시 식별값을 확인해주세요.';
  end if;
  select coalesce((select payload from public.app_data where key='workOrders'),'[]'::jsonb) into orders;
  if p_work_order_id is not null and not exists(select 1 from jsonb_array_elements(orders) e where e->>'id'=p_work_order_id) then
    raise exception '작업지시를 찾을 수 없습니다. 새로고침해주세요.';
  end if;
  return (select jsonb_build_object('appData',jsonb_build_object(
    'workOrders',orders,
    'labelProducts',coalesce((select payload from public.app_data where key='labelProducts'),'[]'::jsonb),
    'labelPrintLogs',case when p_work_order_id is null then '[]'::jsonb
      else label_print_private.outer_log_rows(p_work_order_id) end
  ),'logScope',jsonb_build_object('workOrderId',p_work_order_id,'revision',label_print_private.outer_order_revision(p_work_order_id)::text),
    'logSummaries',label_print_private.outer_order_summaries(null),
    'completions',public.dbmt_label_completion_status()));
end;
$$;

create or replace function public.dbmt_label_print_save_logs(p_pin text,p_logs jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
begin
  perform label_print_private.save_log_batch(p_pin,p_logs,null);
  return jsonb_build_object('ok',true,'logs',label_print_private.outer_log_rows(null),
    'completions',public.dbmt_label_completion_status());
end;
$$;

create or replace function public.dbmt_label_print_save_logs(p_pin text,p_logs jsonb,p_work_order_id text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
begin
  if p_work_order_id is null then raise exception '작업지시 식별값을 확인해주세요.'; end if;
  perform label_print_private.save_log_batch(p_pin,p_logs,p_work_order_id);
  return jsonb_build_object('ok',true,'logs',label_print_private.outer_log_rows(p_work_order_id),
    'completions',public.dbmt_label_completion_status(),
    'logScope',jsonb_build_object('workOrderId',p_work_order_id,'revision',label_print_private.outer_order_revision(p_work_order_id)::text),
    'logSummaries',label_print_private.outer_order_summaries(null));
end;
$$;

create function public.dbmt_label_print_save_logs_delta(
  p_pin text,p_logs jsonb,p_work_order_id text,p_after_revision bigint default null
)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare current_revision bigint; changes jsonb;
begin
  if p_work_order_id is null then raise exception '작업지시 식별값을 확인해주세요.'; end if;
  perform label_print_private.save_log_batch(p_pin,p_logs,p_work_order_id);
  current_revision:=label_print_private.outer_order_revision(p_work_order_id);
  -- Send concurrent changes since this browser last read the order, as well as
  -- the submitted IDs so an identical retry always confirms its original save.
  if p_after_revision is null or p_after_revision<0 or p_after_revision>current_revision then
    changes:=label_print_private.outer_log_rows(p_work_order_id);
  else
    select coalesce(jsonb_agg(rows.data order by rows.seq),'[]'::jsonb) into changes from (
      select l.seq,l.data from label_print_private.outer_print_logs l
      where l.work_order_id=p_work_order_id and l.revision>p_after_revision
      union all
      select l.seq,l.data from label_print_private.outer_print_logs l
      join (select distinct row->>'id' as id from jsonb_array_elements(p_logs) row) submitted using(id)
      where l.work_order_id=p_work_order_id and l.revision<=p_after_revision
    ) rows;
  end if;
  return jsonb_build_object('ok',true,'changedLogs',changes,
    'logScope',jsonb_build_object('workOrderId',p_work_order_id,'revision',current_revision::text),
    'logSummaries',label_print_private.outer_order_summaries(p_work_order_id),
    'completions',label_print_private.outer_order_completion(p_work_order_id));
end;
$$;
revoke all on function public.dbmt_label_print_save_logs_delta(text,jsonb,text,bigint) from public,anon,authenticated;
grant execute on function public.dbmt_label_print_save_logs_delta(text,jsonb,text,bigint) to anon,authenticated;

-- Carry the existing PDA and weight-split guards to the affected row.
create function label_print_private.protect_outer_print_log()
returns trigger language plpgsql security invoker set search_path='' as $fn$
begin
  if tg_op='INSERT' and exists(
    select 1 from pda_private.weight_split_labels l where l.code=new.code
  ) then
    raise exception '분할 라벨의 고유번호는 일반 출력이력에 중복 등록할 수 없습니다.';
  end if;
  if tg_op='UPDATE' then
    if new.data is distinct from old.data and exists(
      select 1 from pda_private.weight_splits s where s.parent_label_id=old.id
    ) then
      raise exception '중량분할 완료된 원본 라벨은 변경·재출력할 수 없습니다. 중량분할 이력에서 재고 라벨을 인쇄해주세요.';
    end if;
  end if;
  if exists(
    select 1 from pda_private.pending_product_labels p
      join public.pda_packages u on u.label_id=p.label_id
      where p.label_id=new.id and p.resolved_at is null
        and (new.data->>'status'='void' or new.code<>u.code
          or public.dbmt_safe_numeric(new.data->>'labelWeight')<>u.weight
          or new.data->'workOrderSnapshot' is distinct from u.label_snapshot)
  ) then
    raise exception '가출고·입고 확인된 라벨은 삭제하거나 생산정보를 변경할 수 없습니다.';
  end if;
  return new;
end;
$fn$;
revoke all on function label_print_private.protect_outer_print_log() from public,anon,authenticated,service_role;
create trigger trg_protect_outer_print_log before insert or update on label_print_private.outer_print_logs
  for each row execute function label_print_private.protect_outer_print_log();

-- The outer barcode snapshot remains immutable. Lock with the same transaction
-- key used by PDA commits, production completion and label splits.
create or replace function label_print_private.save_log_batch(p_pin text,p_logs jsonb,p_work_order_id text)
returns jsonb language plpgsql security invoker set search_path='' as $fn$
declare
  v_batch_orders jsonb; v_batch_products jsonb;
  v_new jsonb; v_old jsonb; v_merged jsonb; v_order jsonb; v_product jsonb; v_expected jsonb; v_field text;
  v_changed jsonb[] := array[]::jsonb[];
  v_written integer := 0;
begin
  if public.dbmt_check_label_print_pin(p_pin) is not true then
    raise exception '라벨전용 PIN이 맞지 않습니다.';
  end if;
  if jsonb_typeof(p_logs) is distinct from 'array' or jsonb_array_length(p_logs)>5000 then
    raise exception '라벨 출력이력 형식 또는 건수를 확인해주세요.';
  end if;
  if p_work_order_id is not null then
    if btrim(p_work_order_id)='' or length(p_work_order_id)>120 then
      raise exception '작업지시 식별값을 확인해주세요.';
    end if;
    if exists(select 1 from jsonb_array_elements(p_logs) e where e->>'workOrderId' is distinct from p_work_order_id) then
      raise exception '선택한 작업지시의 라벨만 저장할 수 있습니다.';
    end if;
  end if;
  if exists(select 1 from jsonb_array_elements(p_logs) e group by e->>'id' having count(*)>1) then
    raise exception '중복된 라벨 식별값입니다.';
  end if;

  perform pg_advisory_xact_lock(36100910);
  select coalesce(jsonb_object_agg(e->>'id',e order by n desc)
    filter(where e->>'id' is not null),'{}'::jsonb) into v_batch_orders
    from public.app_data a cross join lateral jsonb_array_elements(a.payload) with ordinality r(e,n)
    where a.key='workOrders';
  select coalesce(jsonb_object_agg(e->>'id',e order by n desc)
    filter(where e->>'id' is not null),'{}'::jsonb) into v_batch_products
    from public.app_data a cross join lateral jsonb_array_elements(a.payload) with ordinality r(e,n)
    where a.key='labelProducts';

  for v_new in select * from jsonb_array_elements(p_logs) loop
    if jsonb_typeof(v_new)<>'object' or coalesce(v_new->>'id','')='' or coalesce(v_new->>'workOrderId','')='' then
      raise exception '라벨 식별값을 확인해주세요.';
    end if;
    select l.data into v_old from label_print_private.outer_print_logs l where l.id=v_new->>'id' for update;
    if v_old is null then
      if coalesce(v_new->>'code','') !~ '^DB[0-9]{10}-[0-9A-Z]{1,6}$' then
        raise exception '라벨 고유번호를 확인해주세요.';
      end if;
      if exists(select 1 from label_print_private.outer_print_logs l where l.code=v_new->>'code') then
        raise exception '중복된 라벨 고유번호입니다. 다시 출력해주세요.';
      end if;
      if exists(select 1 from public.label_production_completions c join public.production_entries p on p.id=c.production_id
        where c.work_order_id=v_new->>'workOrderId' and p.deleted_at is null) then
        raise exception '생산완료된 작업에는 라벨을 추가할 수 없습니다. 새 작업지시를 사용하세요.';
      end if;
      if coalesce(v_new->>'status','active') not in ('active','void') or public.dbmt_safe_numeric(v_new->>'labelWeight')<=0 then
        raise exception '라벨 중량 또는 상태를 확인해주세요.';
      end if;
      v_order := v_batch_orders->(v_new->>'workOrderId');
      if v_order ? '_carryoverTo' then
        raise exception '잔량을 이월한 작업에는 새 라벨을 추가할 수 없습니다. 다음 작업지시를 선택해주세요.';
      end if;
      if v_order is null or v_new#>>'{workOrderSnapshot,id}' is distinct from v_order->>'id'
        or v_new#>'{workOrderSnapshot,sourceStock}' is distinct from v_order->'sourceStock'
        or v_new#>'{workOrderSnapshot,sourceInputs}' is distinct from v_order->'sourceInputs'
        or public.dbmt_safe_numeric(v_new#>>'{workOrderSnapshot,inputWeight}')<>public.dbmt_safe_numeric(v_order->>'inputWeight') then
        raise exception '작업지시의 투입정보가 변경되었습니다. 새로고침 후 출력하세요.';
      end if;
      v_order := public.dbmt_label_order_for_output_lot(v_order,v_new->'workOrderSnapshot');
      if coalesce(v_new->>'packageKind','outer')<>'outer' then
        raise exception '내포장 라벨은 별도 집계로 저장해주세요.';
      end if;
      if (v_new->'workOrderSnapshot') ? 'productSelectionVersion' then
        if v_new#>'{workOrderSnapshot,productSelectionVersion}' is distinct from '1'::jsonb then
          raise exception '생산품목 선택 버전을 확인해주세요. 새로고침 후 출력하세요.';
        end if;
        v_product := v_batch_products->(v_new#>>'{workOrderSnapshot,labelProductId}');
        if v_product is null or coalesce(btrim(v_product->>'name'),'')='' then
          raise exception '선택한 생산품목을 찾을 수 없습니다. 새로고침 후 다시 선택하세요.';
        end if;
        v_expected := public.dbmt_label_selected_product_order(v_order,v_product);
        foreach v_field in array array['date','product','origin','grade','mfgdate','expdate','labelProductId',
          'productCode','brand','factoryNo','nationalPartCode','nationalPartName','taxType','packunit','itemno','ingredients','temptype'] loop
          if coalesce(v_new#>>array['workOrderSnapshot',v_field],'')<>coalesce(v_expected->>v_field,'') then
            raise exception '생산품목 또는 작업지시 정보가 변경되었습니다. 새로고침 후 미리보기를 확인하고 출력하세요.';
          end if;
        end loop;
        if coalesce(v_new#>>'{workOrderSnapshot,lot}','')<>coalesce(nullif(v_order->>'lot',''),v_order#>>'{sourceStock,lot}','')
          or v_new->>'product' is distinct from v_product->>'name'
          or v_new->>'lot' is distinct from v_new#>>'{workOrderSnapshot,lot}'
          or public.dbmt_safe_numeric(v_new->>'inputWeight')<>public.dbmt_safe_numeric(v_order->>'inputWeight')
          or public.dbmt_safe_numeric(v_new#>>'{workOrderSnapshot,weight}')<>public.dbmt_safe_numeric(v_new->>'labelWeight') then
          raise exception '선택 품목 라벨의 원료·LOT·중량 정보를 확인해주세요.';
        end if;
      else
        foreach v_field in array array['date','product','origin','grade'] loop
          if coalesce(v_new#>>array['workOrderSnapshot',v_field],'')<>coalesce(v_order->>v_field,'') then
            raise exception '작업지시가 변경되었습니다. 새로고침 후 출력하세요.';
          end if;
        end loop;
        if coalesce(v_new#>>'{workOrderSnapshot,lot}','')<>coalesce(nullif(v_order->>'lot',''),v_order#>>'{sourceStock,lot}','')
          or coalesce(v_new#>>'{workOrderSnapshot,mfgdate}','')<>coalesce(nullif(v_order->>'mfgdate',''),v_order->>'date','') then
          raise exception '작업지시의 LOT 또는 생산일이 변경되었습니다. 새로고침 후 출력하세요.';
        end if;
        v_product := v_batch_products->(v_order->>'labelProductId');
        foreach v_field in array array['labelProductId','productCode','brand','factoryNo','nationalPartCode','nationalPartName','taxType','packunit'] loop
          if (v_new->'workOrderSnapshot') ? v_field and coalesce(v_new#>>array['workOrderSnapshot',v_field],'')<>
            (case when v_field='packunit' then coalesce(v_product->>'packunit',v_order->>'packunit','')
              when v_field='taxType' then coalesce(nullif(v_order->>'taxType',''),'면세')
              else coalesce(v_order->>v_field,'') end) then
            raise exception '작업지시의 품목정보가 변경되었습니다. 새로고침 후 출력하세요.';
          end if;
        end loop;
      end if;
      perform label_print_private.validate_blend_label_snapshot(v_order,v_new->'workOrderSnapshot');
      insert into label_print_private.outer_print_logs(id,work_order_id,code,data)
        values(v_new->>'id',v_new->>'workOrderId',v_new->>'code',v_new);
      v_merged := v_new;
      v_written := v_written+1;
    else
      if (v_new - array['status','voidedAt','voidReason','reprintCount','lastReprintedAt'])
        is distinct from (v_old - array['status','voidedAt','voidReason','reprintCount','lastReprintedAt']) then
        raise exception '저장된 라벨의 품목·중량은 변경할 수 없습니다. 새로고침 후 다시 시도하세요.';
      end if;
      v_merged := v_old;
      if v_new->>'status'='void' and coalesce(v_old->>'status','active')<>'void' then
        if exists(select 1 from public.label_production_completions c join public.production_entries p on p.id=c.production_id
          where c.work_order_id=v_old->>'workOrderId' and p.deleted_at is null) then
          raise exception '생산완료된 라벨은 삭제할 수 없습니다.';
        end if;
        v_merged := v_merged || jsonb_build_object('status','void','voidedAt',v_new->>'voidedAt','voidReason',v_new->>'voidReason');
      end if;
      if public.dbmt_safe_numeric(v_new->>'reprintCount')>public.dbmt_safe_numeric(v_old->>'reprintCount') then
        v_merged := v_merged || jsonb_build_object('reprintCount',v_new->'reprintCount','lastReprintedAt',v_new->>'lastReprintedAt');
      end if;
      if v_merged is distinct from v_old then
        update label_print_private.outer_print_logs l
          set data=v_merged,revision=nextval('label_print_private.outer_print_revision_seq')
          where l.id=v_new->>'id';
        v_written := v_written+1;
      end if;
    end if;
    v_changed := array_append(v_changed,v_merged);
  end loop;
  if v_written>0 then
    insert into public.change_logs(entity,action,summary,payload)
      values('label_print','save_logs','라벨 출력이력 저장',jsonb_build_object('count',v_written));
  end if;
  return jsonb_build_object('ok',true,'changedLogs',to_jsonb(v_changed));
end;
$fn$;
revoke all on function label_print_private.save_log_batch(text,jsonb,text) from public,anon,authenticated,service_role;

-- Preserve the installed business rules while switching historical label reads
-- to the authoritative row store. Single-label paths use the ID/code indexes.
do $outer_readers$
declare
  patch record;
  definition text;
begin
  for patch in
    select * from (values
      ('label_stock_private.assignments(text)'::regprocedure,
$old$  -- Parse the bounded print ledger once. Repeated full JSON scans per label
  -- would make large print batches needlessly quadratic.
  for v_id,v_count,v_log,v_code_count in
    with logs as materialized (
      select e,count(*) over(partition by e->>'code') code_count
      from public.app_data a cross join lateral jsonb_array_elements(a.payload) e where a.key='labelPrintLogs'
    ) select i.value,count(l.e)::integer,(jsonb_agg(l.e) filter(where l.e is not null))->0,max(l.code_count)::integer
      from jsonb_array_elements_text(v_completion.log_ids) i left join logs l on l.e->>'id'=i.value group by i.value$old$,
$new$  for v_id,v_count,v_log,v_code_count in
    select i.value,count(l.id)::integer,(jsonb_agg(l.data) filter(where l.id is not null))->0,
      max((select count(*) from label_print_private.outer_print_logs other where other.code=l.code))::integer
    from jsonb_array_elements_text(v_completion.log_ids) i
    left join label_print_private.outer_print_logs l on l.id=i.value
    group by i.value$new$),

      ('pda_private.raw_receipt_has_dependencies(text[],text[])'::regprocedure,
$old$  or exists(select 1 from public.app_data a cross join unnest(p_sources) s
    where a.key in ('workOrders','labelPrintLogs')
      and jsonb_path_exists(a.payload,'$.**.stockRowId ? (@ == $source)',jsonb_build_object('source',s)))$old$,
$new$  or exists(select 1 from public.app_data a cross join unnest(p_sources) s
    where a.key='workOrders'
      and jsonb_path_exists(a.payload,'$.**.stockRowId ? (@ == $source)',jsonb_build_object('source',s)))
  or exists(select 1 from label_print_private.outer_print_logs l cross join unnest(p_sources) s
    where jsonb_path_exists(l.data,'$.**.stockRowId ? (@ == $source)',jsonb_build_object('source',s)))$new$),

      ('pda_private.resolve_before_weight_split(text)'::regprocedure,
$old$  select count(*),jsonb_agg(e)->0 into n,log from public.app_data a cross join lateral jsonb_array_elements(a.payload) e
    where a.key='labelPrintLogs' and e->>'code'=code;$old$,
$new$  select count(*),jsonb_agg(l.data)->0 into n,log from label_print_private.outer_print_logs l
    where l.code=pda_private.decode_code(p_code);$new$),

      ('pda_private.resolve_completed(text)'::regprocedure,
$old$  select count(*),jsonb_agg(l)->0 into v_count,v_log from public.app_data a
    cross join lateral jsonb_array_elements(a.payload) l where a.key='labelPrintLogs' and l->>'code'=v_code;$old$,
$new$  select count(*),jsonb_agg(l.data)->0 into v_count,v_log
  from label_print_private.outer_print_logs l where l.code=v_code;$new$),

      ('pda_private.weight_split_stock(text,text)'::regprocedure,
$old$  if log is null then select e into log from public.app_data a cross join lateral jsonb_array_elements(a.payload) e
    where a.key='labelPrintLogs' and e->>'id'=d->>'labelId';end if;$old$,
$new$  if log is null then
    select l.data into log from label_print_private.outer_print_logs l where l.id=d->>'labelId';
  end if;$new$),

      ('public.dbmt_erp_cancel_work_order_carryover(text,text,text)'::regprocedure,
$old$exists(select 1 from public.app_data a cross join lateral jsonb_array_elements(a.payload) e where a.key='labelPrintLogs' and e->>'workOrderId'=p_id)$old$,
$new$exists(select 1 from label_print_private.outer_print_logs l where l.work_order_id=p_id)$new$),

      ('public.dbmt_label_complete_production_before_pda_cost(text,text,jsonb,jsonb)'::regprocedure,
$old$  select coalesce(jsonb_agg(e order by e->>'id'),'[]'::jsonb),coalesce(jsonb_agg(e->>'id' order by e->>'id'),'[]'::jsonb)
    into v_logs,v_ids from public.app_data a cross join lateral jsonb_array_elements(a.payload) e
    where a.key='labelPrintLogs' and e->>'workOrderId'=p_work_order_id and coalesce(e->>'status','active')<>'void';$old$,
$new$  select coalesce(jsonb_agg(l.data order by l.id),'[]'::jsonb),coalesce(jsonb_agg(l.id order by l.id),'[]'::jsonb)
    into v_logs,v_ids from label_print_private.outer_print_logs l
    where l.work_order_id=p_work_order_id and coalesce(l.data->>'status','active')<>'void';$new$),

      ('public.dbmt_label_weight_search(text,text,text,text,text,integer)'::regprocedure,
$old$      select e->>'code' code from public.app_data a cross join lateral jsonb_array_elements(a.payload) e
        join public.label_production_completions c on c.work_order_id=e->>'workOrderId' and c.log_ids ? (e->>'id')
        join public.production_entries p on p.id=c.production_id and p.deleted_at is null
        where a.key='labelPrintLogs' and coalesce(e->>'status','active')<>'void' and e->>'code' ~ '^DB[0-9]{10}-[0-9A-Z]{1,6}$'
          and (coalesce(p_product,'')='' or strpos(lower(e#>>'{workOrderSnapshot,product}'),lower(p_product))>0)$old$,
$new$      select l.code from label_print_private.outer_print_logs l
        join public.label_production_completions c on c.work_order_id=l.work_order_id and c.log_ids ? l.id
        join public.production_entries p on p.id=c.production_id and p.deleted_at is null
        where (full_code is null or l.code=full_code)
          and coalesce(l.data->>'status','active')<>'void' and l.code ~ '^DB[0-9]{10}-[0-9A-Z]{1,6}$'
          and (coalesce(p_product,'')='' or strpos(lower(l.data#>>'{workOrderSnapshot,product}'),lower(p_product))>0)$new$),

      ('public.dbmt_label_weight_split(text,text,uuid,text,integer,text,jsonb)'::regprocedure,
$old$not exists(select 1 from public.app_data a cross join lateral jsonb_array_elements(a.payload) e where a.key='labelPrintLogs' and e->>'code'=child_code)$old$,
$new$not exists(select 1 from label_print_private.outer_print_logs l where l.code=child_code)$new$),

      ('public.dbmt_work_order_carry_state(text)'::regprocedure,
$old$  select count(*),coalesce(sum(public.dbmt_safe_numeric(e->>'labelWeight')),0) into v_labels,v_weight
    from public.app_data a cross join lateral jsonb_array_elements(a.payload) e where a.key='labelPrintLogs'
      and e->>'workOrderId'=p_id and coalesce(e->>'status','active')<>'void' and coalesce(e->>'packageKind','outer')<>'inner';$old$,
$new$  select count(*),coalesce(sum(public.dbmt_safe_numeric(l.data->>'labelWeight')),0) into v_labels,v_weight
    from label_print_private.outer_print_logs l
    where l.work_order_id=p_id and coalesce(l.data->>'status','active')<>'void'
      and coalesce(l.data->>'packageKind','outer')<>'inner';$new$)
    ) as patches(signature,old_sql,new_sql)
  loop
    definition:=replace(pg_get_functiondef(patch.signature),E'\r\n',E'\n');
    if (length(definition)-length(replace(definition,patch.old_sql,'')))/length(patch.old_sql)<>1 then
      raise exception 'Unexpected original label reader: %',patch.signature;
    end if;
    execute replace(definition,patch.old_sql,patch.new_sql);
  end loop;
end $outer_readers$;

notify pgrst,'reload schema';
