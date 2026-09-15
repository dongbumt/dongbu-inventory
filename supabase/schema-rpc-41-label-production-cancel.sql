-- Additive install after 39 and 40. No business rows are changed by installation.
do $dbmt$ begin
  if to_regprocedure('public.dbmt_validate_production_stock_rows(jsonb,text)') is null
    or to_regprocedure('public.dbmt_submaterial_write_lock()') is null then
    raise exception '생산품 재고행 및 부자재 재고 기능(39, 40)을 먼저 설치해주세요.';
  end if;
end $dbmt$;

-- A stale office usage editor must not recreate usage after cancellation.
-- Preserve legacy usages whose journal has never been migrated to this table.
-- The existing trigger also serializes this check with cancellation and counts.
create or replace function public.dbmt_submaterial_write_lock()
returns trigger language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  perform pg_advisory_xact_lock(40100914);
  if tg_op='DELETE' then return old; end if;
  if tg_table_name='submaterial_usages' then
    if new.deleted_at is null and exists (
      select 1 from public.production_entries where id=new.production_id and deleted_at is not null
    ) then
      raise exception '삭제되거나 전송 취소된 생산일보입니다. 새로고침 후 부자재 사용내역을 확인해주세요.';
    end if;
  end if;
  return new;
end;
$dbmt$;

-- Label PIN authorizes ONLY the current completion linked to the named work
-- order and exact journal generation. It grants no general ERP delete access.
create or replace function public.dbmt_label_cancel_production(
  p_pin text,p_work_order_id text,p_production_id text
)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
declare
  v_completion public.label_production_completions%rowtype;
  v_entry public.production_entries%rowtype;
  v_transactions jsonb; v_usages jsonb;
begin
  if public.dbmt_check_label_print_pin(p_pin) is not true then raise exception '라벨전용 PIN이 맞지 않습니다.'; end if;
  if nullif(btrim(p_work_order_id),'') is null or nullif(btrim(p_production_id),'') is null then
    raise exception '취소할 작업지시와 생산일보를 확인해주세요.';
  end if;
  -- Same order as production writes: production/stock first, submaterials next.
  perform pg_advisory_xact_lock(36100910);
  perform pg_advisory_xact_lock(40100914);
  select * into v_completion from public.label_production_completions where work_order_id=p_work_order_id for update;
  if not found or v_completion.production_id is distinct from p_production_id then
    raise exception '전송 상태가 변경되었습니다. 새로고침 후 다시 확인해주세요.';
  end if;
  select * into v_entry from public.production_entries where id=p_production_id for update;
  if not found then raise exception '연결된 생산일보를 찾을 수 없습니다. 사무실에서 확인해주세요.'; end if;
  if v_entry.deleted_at is not null then
    if exists(select 1 from public.transactions where deleted_at is null and (prod_id=p_production_id or raw->>'_prodId'=p_production_id))
      or exists(select 1 from public.submaterial_usages where production_id=p_production_id and deleted_at is null) then
      raise exception '삭제한 생산일보에 연결된 재고 내역이 남아 있습니다. 사무실에서 확인해주세요.';
    end if;
    return jsonb_build_object('ok',true,'alreadyCancelled',true,'productionId',p_production_id,'completions',public.dbmt_label_completion_status());
  end if;
  -- Do not remove stock that has been shipped, reused, moved or reserved.
  perform public.dbmt_validate_production_stock_rows(null,p_production_id);
  select coalesce(jsonb_agg(id),'[]'::jsonb) into v_transactions from public.transactions
    where deleted_at is null and (prod_id=p_production_id or raw->>'_prodId'=p_production_id);
  select coalesce(jsonb_agg(id),'[]'::jsonb) into v_usages from public.submaterial_usages
    where production_id=p_production_id and deleted_at is null;
  -- Soft deletion is atomic. Keep journal snapshots, logs, and the completion
  -- marker: deleted=true unlocks printing and the existing resubmit RPC creates
  -- a new generation. An old cancellation can never touch that successor.
  update public.production_entries set deleted_at=now(),updated_at=now() where id=p_production_id;
  update public.transactions set deleted_at=now(),updated_at=now()
    where deleted_at is null and (prod_id=p_production_id or raw->>'_prodId'=p_production_id);
  update public.submaterial_usages set deleted_at=now(),updated_at=now()
    where production_id=p_production_id and deleted_at is null;
  insert into public.change_logs(entity,action,entity_id,summary,payload)
    values('생산일보','라벨 전송 취소',p_production_id,'라벨 출력화면에서 생산일보 및 연결 재고 취소',
      jsonb_build_object('authMode','label_pin','workOrderId',p_work_order_id,'entry',v_entry.raw,
        'transactionIds',v_transactions,'submaterialUsageIds',v_usages));
  return jsonb_build_object('ok',true,'productionId',p_production_id,
    'deletedTransactions',jsonb_array_length(v_transactions),'deletedUsages',jsonb_array_length(v_usages),
    'completions',public.dbmt_label_completion_status());
end;
$dbmt$;
revoke all on function public.dbmt_submaterial_write_lock() from public,anon,authenticated;
revoke all on function public.dbmt_label_cancel_production(text,text,text) from public;
grant execute on function public.dbmt_label_cancel_production(text,text,text) to anon,authenticated;
notify pgrst,'reload schema';
