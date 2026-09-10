-- Install after 37. Deleted journals reopen label work without erasing print history.
-- Keep archived transfer generations so old retries cannot undo/repeat newer work.
create table if not exists public.label_production_completion_history (
  production_id text primary key references public.production_entries(id),
  work_order_id text not null,
  completed_at timestamptz not null,
  baseline jsonb not null,
  log_ids jsonb not null,
  reopened_at timestamptz not null default now(),
  successor_id text references public.production_entries(id)
);
alter table public.label_production_completion_history enable row level security;
revoke all on public.label_production_completion_history from public,anon,authenticated;

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
      if exists(select 1 from public.label_production_completions c join public.production_entries p on p.id=c.production_id where c.work_order_id=v_new->>'workOrderId' and p.deleted_at is null) then
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
        if exists(select 1 from public.label_production_completions c join public.production_entries p on p.id=c.production_id where c.work_order_id=v_old->>'workOrderId' and p.deleted_at is null) then
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

-- Explicitly name the deleted transfer being replaced. The existing completion
-- RPC still rejects deleted transfers, so a delayed original request is harmless.
create or replace function public.dbmt_label_resubmit_production(
  p_pin text, p_work_order_id text, p_log_ids jsonb, p_previous_production_id text
)
returns jsonb language plpgsql security definer set search_path = public, extensions as $dbmt$
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
  v_result := public.dbmt_label_complete_production(p_pin,p_work_order_id,p_log_ids);
  if v_result->>'ok' is distinct from 'true' then raise exception '생산일보 재전송을 완료하지 못했습니다.'; end if;
  update public.label_production_completion_history set successor_id=v_result->>'productionId' where production_id=p_previous_production_id;
  insert into public.change_logs(entity,action,entity_id,summary,payload)
    values('생산일보','삭제 후 재전송',v_result->>'productionId','라벨 작업 재전송',
      jsonb_build_object('workOrderId',p_work_order_id,'previousProductionId',p_previous_production_id,'authMode','label_pin'));
  return v_result;
end;
$dbmt$;

-- Include previous generations in IDs so an office browser can remove its stale
-- cached deleted rows even if a replacement was already submitted elsewhere.
create or replace function public.dbmt_erp_get_label_productions(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $dbmt$
declare v_ids jsonb;
begin
  if public.dbmt_erp_session_user(p_token) is null or public.dbmt_erp_has_permission(p_token,'production','view') is not true then
    raise exception '생산일보 조회 권한이 필요합니다.';
  end if;
  select coalesce(jsonb_agg(production_id),'[]'::jsonb) into v_ids from (
    select production_id from public.label_production_completions
    union select production_id from public.label_production_completion_history
  ) generations;
  return jsonb_build_object('ok',true,'productionIds',v_ids,
    'entries',coalesce((select jsonb_agg(p.raw) from public.production_entries p join public.label_production_completions c on c.production_id=p.id where p.deleted_at is null),'[]'::jsonb),
    'transactions',coalesce((select jsonb_agg(t.raw) from public.transactions t join public.label_production_completions c on c.production_id=t.prod_id where t.deleted_at is null),'[]'::jsonb));
end;
$dbmt$;
revoke all on function public.dbmt_label_resubmit_production(text,text,jsonb,text) from public;
revoke all on function public.dbmt_label_print_save_logs(text,jsonb) from public;
revoke all on function public.dbmt_erp_get_label_productions(text) from public;
grant execute on function public.dbmt_label_resubmit_production(text,text,jsonb,text) to anon,authenticated;
grant execute on function public.dbmt_label_print_save_logs(text,jsonb) to anon,authenticated;
grant execute on function public.dbmt_erp_get_label_productions(text) to anon,authenticated;
notify pgrst,'reload schema';
