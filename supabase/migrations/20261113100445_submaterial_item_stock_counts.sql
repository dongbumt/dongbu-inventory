-- Item-wide physical counts are atomic collections of ordinary LOT adjustments.
-- Existing item-wide legacy snapshots and all receipt/usage records stay intact.
create schema if not exists erp_submaterial_private;
revoke all on schema erp_submaterial_private from public;
grant usage on schema erp_submaterial_private to anon,authenticated;

create or replace function erp_submaterial_private.item_lots(p_item_id text)
returns table(lot jsonb,stock_qty numeric)
language sql security definer set search_path='' as $fn$
  with items as (
    select e from public.app_data a cross join lateral jsonb_array_elements(a.payload) e where a.key='subMaterialItems'
  ), target as (select e from items where e->>'id'=p_item_id)
  select l.e,public.dbmt_submaterial_lot_stock(l.e->>'id')
  from public.app_data a cross join lateral jsonb_array_elements(a.payload) l(e) cross join target t
  where a.key='subMaterialLots' and case
    when nullif(l.e->>'itemId','') is not null then l.e->>'itemId'=p_item_id
    when nullif(l.e->>'itemCode','') is not null then l.e->>'itemCode'=t.e->>'code'
      and (select count(*) from items i where i.e->>'code'=l.e->>'itemCode')=1
    else coalesce(l.e->>'itemName','')=coalesce(t.e->>'name','') and coalesce(l.e->>'itemSpec','')=coalesce(t.e->>'spec','')
      and (select count(*) from items i where coalesce(i.e->>'name','')=coalesce(l.e->>'itemName','')
        and coalesce(i.e->>'spec','')=coalesce(l.e->>'itemSpec',''))=1
    end;
$fn$;
revoke all on function erp_submaterial_private.item_lots(text) from public,anon,authenticated;

create or replace function erp_submaterial_private.save_item_count(p_token text,p_record jsonb)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare
  v_user uuid:=public.dbmt_erp_session_user(p_token); v_id text; v_item_id text; v_item jsonb;
  v_counts jsonb; v_existing jsonb; v_request jsonb; v_lots jsonb; v_snapshot jsonb;
  v_current numeric; v_expected numeric; v_qty numeric; v_delta numeric; v_remaining numeric; v_change numeric;
  v_row jsonb; v_count jsonb; v_new jsonb:='[]'; v_ids jsonb; v_child_id text; v_log jsonb;
  v_today text:=to_char(clock_timestamp() at time zone 'Asia/Seoul','YYYY-MM-DD');
  v_created text:=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if v_user is null then return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.'); end if;
  if public.dbmt_erp_has_permission(p_token,'submaterials','create') is not true then
    return public.dbmt_erp_permission_denied(v_user,'submaterials','create');
  end if;
  if jsonb_typeof(p_record) is distinct from 'object' then raise exception '실사 입력 형식을 확인해주세요.'; end if;
  v_id:=btrim(p_record->>'id'); v_item_id:=btrim(p_record->>'itemId');
  if v_id is null or v_id!~'^[A-Za-z0-9_-]{1,120}$' or nullif(v_item_id,'') is null then raise exception '실사 또는 품목 식별값을 확인해주세요.'; end if;
  if jsonb_typeof(p_record->'qty') is distinct from 'number' or jsonb_typeof(p_record->'expectedSystemQty') is distinct from 'number'
    or jsonb_typeof(p_record->'expectedLots') is distinct from 'object' then raise exception '실제 재고와 최신 LOT 재고를 확인해주세요.'; end if;
  v_qty:=public.dbmt_safe_numeric(p_record->>'qty'); v_expected:=public.dbmt_safe_numeric(p_record->>'expectedSystemQty');
  if v_qty<0 or v_qty<>round(v_qty,6) or v_expected<>round(v_expected,6) then raise exception '실제 재고는 0 이상, 수량은 소수 여섯 자리 이내로 입력해주세요.'; end if;
  v_request:=jsonb_build_object('id',v_id,'itemId',v_item_id,'qty',v_qty,'expectedSystemQty',v_expected,
    'expectedLots',p_record->'expectedLots','manager',btrim(coalesce(p_record->>'manager','')),'note',btrim(coalesce(p_record->>'note','')));
  perform pg_advisory_xact_lock(40100914);
  v_counts:=coalesce((select payload from public.app_data where key='subMaterialCounts'),'[]'::jsonb);
  select e into v_existing from jsonb_array_elements(v_counts) e where e->>'id'=v_id;
  if v_existing is not null then
    if v_existing->'itemCountRequest'=v_request and not exists(
      select 1 from jsonb_array_elements_text(v_existing->'itemCountIds') id
      where not exists(select 1 from jsonb_array_elements(v_counts) c where c->>'id'=id)
    ) then
      return public.dbmt_submaterial_stock_snapshot() || jsonb_build_object('alreadySaved',true,'itemCountId',v_id);
    end if;
    return public.dbmt_submaterial_stock_snapshot() || jsonb_build_object('ok',false,'code','count_id_conflict','message','같은 실사 요청의 내용이 변경되었습니다. 실사창을 다시 열어주세요.');
  end if;
  if exists(select 1 from public.change_logs where entity='부자재 실사' and entity_id=v_id)
    or exists(select 1 from jsonb_array_elements(v_counts) c where c->>'itemCountId'=v_id) then
    return public.dbmt_submaterial_stock_snapshot() || jsonb_build_object('ok',false,'code','count_deleted','message','이미 처리하거나 삭제한 실사 요청입니다. 실사창을 다시 열어주세요.');
  end if;
  select e into v_item from public.app_data a cross join lateral jsonb_array_elements(a.payload) e
    where a.key='subMaterialItems' and e->>'id'=v_item_id;
  if v_item is null then raise exception '선택한 부자재 품목이 없습니다.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('lot',l.lot,'stockQty',l.stock_qty)
      order by public.dbmt_safe_date(l.lot->>'date') nulls last,nullif(l.lot->>'createdAt','') collate "C" nulls last,l.lot->>'id' collate "C"),'[]'::jsonb),
    coalesce(sum(l.stock_qty),0),coalesce(jsonb_object_agg(l.lot->>'id',jsonb_build_object('qty',l.stock_qty,
      'date',coalesce(l.lot->>'date',''),'createdAt',coalesce(l.lot->>'createdAt',''),'unit',coalesce(nullif(l.lot->>'unit',''),v_item->>'unit',''))),'{}'::jsonb)
    into v_lots,v_current,v_snapshot from erp_submaterial_private.item_lots(v_item_id) l;
  if jsonb_array_length(v_lots)=0 then raise exception '입고 LOT을 등록한 후 품목 실사를 진행해주세요.'; end if;
  if exists(select 1 from jsonb_array_elements(v_lots) r where public.dbmt_safe_date(r->'lot'->>'date')>v_today::date) then
    raise exception '미래 입고일의 LOT이 포함되어 있습니다. 입고일을 확인한 후 실사해주세요.';
  end if;
  if (select count(distinct e->>'unit') from jsonb_each(v_snapshot) p(k,e))>1 then raise exception '단위가 다른 LOT은 합계 실사를 할 수 없습니다. LOT별로 확인해주세요.'; end if;
  if v_current is distinct from v_expected or v_snapshot is distinct from p_record->'expectedLots' then
    return public.dbmt_submaterial_stock_snapshot() || jsonb_build_object('ok',false,'code','stock_conflict','message','LOT 재고가 변경되었습니다. 최신 조정수량을 확인한 뒤 다시 저장해주세요.','currentQty',v_current);
  end if;
  v_delta:=v_qty-v_current; v_remaining:=abs(v_delta);
  for v_row in select e from jsonb_array_elements(v_lots) e loop
    if v_delta>0 then v_change:=v_remaining;
    elsif v_delta<0 then v_change:=-least(greatest((v_row->>'stockQty')::numeric,0),v_remaining);
    else v_change:=0; end if;
    if v_delta<>0 and v_change=0 then continue; end if;
    v_child_id:=case when jsonb_array_length(v_new)=0 then v_id else 'smcount_'||replace(extensions.gen_random_uuid()::text,'-','') end;
    v_count:=jsonb_build_object('id',v_child_id,'date',v_today,'lotId',v_row->'lot'->>'id','lot',coalesce(v_row->'lot'->>'lot',''),
      'itemId',v_item_id,'itemCode',coalesce(v_item->>'code',''),'itemName',coalesce(v_item->>'name',''),'itemSpec',coalesce(v_item->>'spec',''),
      'unit',coalesce(nullif(v_row->'lot'->>'unit',''),v_item->>'unit',''),'systemQty',(v_row->>'stockQty')::numeric,
      'qty',(v_row->>'stockQty')::numeric+v_change,'adjustmentQty',v_change,'manager',v_request->>'manager','note',v_request->>'note','createdAt',v_created,
      'itemCountId',v_id,'itemCountQty',v_qty,'itemCountSystemQty',v_current,'itemCountAdjustmentQty',v_delta);
    v_new:=v_new||jsonb_build_array(v_count); v_remaining:=v_remaining-abs(v_change);
    exit when v_remaining=0;
  end loop;
  if v_remaining<>0 or jsonb_array_length(v_new)=0 then raise exception '조정 가능한 LOT 재고를 확인해주세요.'; end if;
  select jsonb_agg(e->'id') into v_ids from jsonb_array_elements(v_new) e;
  v_new:=jsonb_set(jsonb_set(v_new,'{0,itemCountRequest}',v_request),'{0,itemCountIds}',v_ids);
  insert into public.app_data(key,payload,updated_at) values('subMaterialCounts',v_counts||v_new,now())
    on conflict(key) do update set payload=excluded.payload,updated_at=now();
  for v_count in select e from jsonb_array_elements(v_new) e loop
    v_log:=public.dbmt_submaterial_count_log(p_token,'저장',v_count);
  end loop;
  return public.dbmt_submaterial_stock_snapshot()||jsonb_build_object('itemCountId',v_id,'currentQty',v_qty,'allocations',v_new,'logEntry',v_log);
end;
$fn$;
revoke all on function erp_submaterial_private.save_item_count(text,jsonb) from public;
grant execute on function erp_submaterial_private.save_item_count(text,jsonb) to anon,authenticated;
create or replace function public.dbmt_erp_save_submaterial_item_count(p_token text,p_record jsonb)
returns jsonb language sql security invoker set search_path='' as $fn$
  select erp_submaterial_private.save_item_count(p_token,p_record);
$fn$;
revoke all on function public.dbmt_erp_save_submaterial_item_count(text,jsonb) from public;
grant execute on function public.dbmt_erp_save_submaterial_item_count(text,jsonb) to anon,authenticated;

create or replace function erp_submaterial_private.delete_item_count(p_token text,p_group_id text,p_expected_revision text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v_user uuid:=public.dbmt_erp_session_user(p_token); v_counts jsonb; v_group jsonb; v_count jsonb;
  v_current numeric; v_after numeric; v_log jsonb;
begin
  if v_user is null then return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.'); end if;
  if public.dbmt_erp_has_permission(p_token,'submaterials','delete') is not true then return public.dbmt_erp_permission_denied(v_user,'submaterials','delete'); end if;
  perform pg_advisory_xact_lock(40100914);
  v_counts:=coalesce((select payload from public.app_data where key='subMaterialCounts'),'[]'::jsonb);
  if p_expected_revision is not null and p_expected_revision<>md5(v_counts::text) then
    return public.dbmt_submaterial_stock_snapshot()||jsonb_build_object('ok',false,'code','counts_conflict','message','실사 이력이 변경되었습니다. 최신 이력을 확인한 뒤 다시 삭제해주세요.');
  end if;
  select coalesce(jsonb_agg(e),'[]'::jsonb) into v_group from jsonb_array_elements(v_counts) e where e->>'itemCountId'=p_group_id;
  if jsonb_array_length(v_group)=0 then return public.dbmt_submaterial_stock_snapshot()||jsonb_build_object('alreadyDeleted',true); end if;
  for v_count in select e from jsonb_array_elements(v_group) e loop
    v_current:=public.dbmt_submaterial_lot_stock(v_count->>'lotId'); v_after:=v_current-public.dbmt_safe_numeric(v_count->>'adjustmentQty');
    if v_after<0 and v_after<v_current then
      return public.dbmt_submaterial_stock_snapshot()||jsonb_build_object('ok',false,'code','count_in_use','message','실사로 늘어난 재고가 이미 사용되었습니다. 사용내역을 먼저 확인해주세요.','currentQty',v_current,'qtyAfterDelete',v_after);
    end if;
  end loop;
  select coalesce(jsonb_agg(e order by n),'[]'::jsonb) into v_counts from jsonb_array_elements(v_counts) with ordinality a(e,n)
    where e->>'itemCountId' is distinct from p_group_id;
  update public.app_data set payload=v_counts,updated_at=now() where key='subMaterialCounts';
  for v_count in select e from jsonb_array_elements(v_group) e loop v_log:=public.dbmt_submaterial_count_log(p_token,'삭제',v_count); end loop;
  return public.dbmt_submaterial_stock_snapshot()||jsonb_build_object('logEntry',v_log);
end;
$fn$;
revoke all on function erp_submaterial_private.delete_item_count(text,text,text) from public,anon,authenticated;

-- Any old or new client deleting a member cancels the complete item-wide count.
create or replace function public.dbmt_erp_delete_submaterial_count(p_token text,p_count_id text,p_expected_revision text default null)
returns jsonb language plpgsql security definer set search_path=public,extensions as $fn$
declare v_user_id uuid:=public.dbmt_erp_session_user(p_token); v_counts jsonb; v_count jsonb; v_log jsonb;
  v_current numeric; v_after numeric; v_lot_id text;
begin
  if v_user_id is null then return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.'); end if;
  if public.dbmt_erp_has_permission(p_token,'submaterials','delete') is not true then return public.dbmt_erp_permission_denied(v_user_id,'submaterials','delete'); end if;
  perform pg_advisory_xact_lock(40100914);
  v_counts:=coalesce((select payload from public.app_data where key='subMaterialCounts'),'[]'::jsonb);
  select e into v_count from jsonb_array_elements(v_counts) e where e->>'id'=p_count_id;
  if v_count is null then return public.dbmt_submaterial_stock_snapshot()||jsonb_build_object('alreadyDeleted',true); end if;
  if p_expected_revision is not null and p_expected_revision<>md5(v_counts::text) then
    return public.dbmt_submaterial_stock_snapshot()||jsonb_build_object('ok',false,'code','counts_conflict','message','실사 이력이 변경되었습니다. 최신 이력을 확인한 뒤 다시 삭제해주세요.');
  end if;
  if nullif(v_count->>'itemCountId','') is not null then
    return erp_submaterial_private.delete_item_count(p_token,v_count->>'itemCountId',p_expected_revision);
  end if;
  v_lot_id:=nullif(v_count->>'lotId','');
  if v_lot_id is not null then
    v_current:=public.dbmt_submaterial_lot_stock(v_lot_id); v_after:=v_current-public.dbmt_safe_numeric(v_count->>'adjustmentQty');
    if v_after<0 and v_after<v_current then
      return public.dbmt_submaterial_stock_snapshot()||jsonb_build_object('ok',false,'code','count_in_use','message','실사로 늘어난 재고가 이미 사용되었습니다. 사용내역을 먼저 확인해주세요.','currentQty',v_current,'qtyAfterDelete',v_after);
    end if;
  end if;
  select coalesce(jsonb_agg(e order by n),'[]'::jsonb) into v_counts from jsonb_array_elements(v_counts) with ordinality a(e,n) where e->>'id' is distinct from p_count_id;
  update public.app_data set payload=v_counts,updated_at=now() where key='subMaterialCounts';
  v_log:=public.dbmt_submaterial_count_log(p_token,'삭제',v_count);
  return public.dbmt_submaterial_stock_snapshot()||jsonb_build_object('currentQty',v_after,'logEntry',v_log);
end;
$fn$;
notify pgrst,'reload schema';
