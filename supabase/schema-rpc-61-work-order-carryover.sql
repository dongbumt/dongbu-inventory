-- Carry-over only schedules unused allocations. It never recalculates or
-- rewrites production inputs, transactions, output labels or their barcodes.
create or replace function public.dbmt_work_order_carry_state(p_id text)
returns jsonb language plpgsql security invoker set search_path='' as $fn$
declare v_order jsonb; v_entry jsonb; v_pid text; v_sources jsonb; v_source jsonb; v_rows jsonb:='[]';
  v_used numeric; v_used_boxes numeric; v_max numeric; v_boxes numeric; v_key text; v_n integer:=0;
  v_labels integer; v_weight numeric; v_reason text:=''; v_matches integer;
begin
  select e into v_order from public.app_data a cross join lateral jsonb_array_elements(a.payload) e
    where a.key='workOrders' and e->>'id'=p_id;
  if v_order is null then raise exception '작업지시를 찾을 수 없습니다.'; end if;
  select p.id,p.raw into v_pid,v_entry from public.label_production_completions c
    join public.production_entries p on p.id=c.production_id and p.deleted_at is null where c.work_order_id=p_id;
  select count(*),coalesce(sum(public.dbmt_safe_numeric(e->>'labelWeight')),0) into v_labels,v_weight
    from public.app_data a cross join lateral jsonb_array_elements(a.payload) e where a.key='labelPrintLogs'
      and e->>'workOrderId'=p_id and coalesce(e->>'status','active')<>'void' and coalesce(e->>'packageKind','outer')<>'inner';
  if v_order ? '_carryoverTo' then v_reason:='이미 잔량을 이월한 작업지시입니다.';
  elsif v_labels>0 and v_entry is null then v_reason:='오늘 출력한 생산분을 먼저 생산일보로 전송해주세요. 투입량은 자동으로 수정하지 않습니다.'; end if;
  v_sources:=public.dbmt_work_order_source_inputs(v_order);
  for v_source in select e from jsonb_array_elements(v_sources) e loop
    v_key:=coalesce(nullif(v_source#>>'{sourceStock,stockRowId}',''),v_source#>>'{sourceStock,key}',v_source->>'sourceStockKey');
    v_used:=0;v_used_boxes:=0;
    if v_entry is not null then
      select count(*),sum(public.dbmt_safe_numeric(e->>'qty')),
        case when bool_and(e->>'boxCount' is not null) then sum(public.dbmt_safe_numeric(e->>'boxCount')) else null end
        into v_matches,v_used,v_used_boxes from jsonb_array_elements(v_entry->'inputs') e
        where coalesce(nullif(e->>'stockRowId',''),nullif(e->>'sourceStockKey',''))=v_key;
      if v_matches<>1 then v_reason:='생산일보의 투입 원료 연결을 확인해주세요. 원료별 실제 투입 내역을 확인한 뒤 이월할 수 있습니다.'; end if;
    end if;
    v_max:=greatest(public.dbmt_safe_numeric(v_source->>'inputWeight')-coalesce(v_used,0),0);
    v_boxes:=case when v_source->>'boxCount' is not null and v_used_boxes is not null
      then greatest(public.dbmt_safe_numeric(v_source->>'boxCount')-v_used_boxes,0) else null end;
    v_rows:=v_rows||jsonb_build_array(jsonb_build_object('index',v_n,'product',v_source#>>'{sourceStock,product}',
      'lot',v_source#>>'{sourceStock,lot}','originalKg',v_source->'inputWeight','usedKg',v_used,'maxKg',v_max,'maxBoxes',v_boxes));
    v_n:=v_n+1;
  end loop;
  if v_reason='' and not exists(select 1 from jsonb_array_elements(v_rows) e where public.dbmt_safe_numeric(e->>'maxKg')>0) then
    v_reason:='생산일보에 원료 전량이 투입된 것으로 기록되어 있습니다. 실제 투입 내역을 먼저 확인해주세요. 이월 기능은 생산일보나 재고를 자동 수정하지 않습니다.';
  end if;
  return jsonb_build_object('order',v_order,'orderVersion',md5(v_order::text),'productionId',v_pid,
    'sources',v_rows,'labelKg',v_weight,'labelBoxes',v_labels,'canCarry',v_reason='','reason',v_reason);
end;
$fn$;
revoke all on function public.dbmt_work_order_carry_state(text) from public,anon,authenticated;

create or replace function public.dbmt_erp_get_work_order_carryover(p_token text,p_id text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v_state jsonb;
begin
  if public.dbmt_erp_has_permission(p_token,'workorders','view') is not true then raise exception '작업지시 조회 권한 또는 로그인 상태를 확인해주세요.'; end if;
  v_state:=public.dbmt_work_order_carry_state(p_id);
  return jsonb_build_object('ok',true,'state',v_state,'stateVersion',md5(v_state::text));
end;
$fn$;

create or replace function public.dbmt_erp_carry_work_order(p_token text,p_id text,p_date date,p_sources jsonb,p_state_version text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v_state jsonb;v_order jsonb;v_child jsonb;v_rows jsonb;v_inputs jsonb:='[]';v_input jsonb;v_limit jsonb;v_item jsonb;
  v_qty numeric;v_boxes numeric;v_total numeric:=0;v_total_boxes numeric:=0;v_all_boxes boolean:=true;v_child_id text;v_meta jsonb;v_days integer;
begin
  if public.dbmt_erp_has_permission(p_token,'workorders','view') is not true
    or public.dbmt_erp_has_permission(p_token,'workorders','create') is not true
    or public.dbmt_erp_has_permission(p_token,'workorders','update') is not true then
    raise exception '작업지시 조회·등록·수정 권한 또는 로그인 상태를 확인해주세요.';
  end if;
  if p_request_id is null then raise exception '이월 요청 식별값을 확인해주세요.'; end if;
  -- Same lock order as label completion and production edits.
  perform pg_advisory_xact_lock(36100910);
  perform pg_advisory_xact_lock(40100914);
  select payload into v_rows from public.app_data where key='workOrders' for update;
  select e into v_order from jsonb_array_elements(v_rows) e where e->>'id'=p_id;
  if v_order is null then raise exception '작업지시를 찾을 수 없습니다.'; end if;
  if v_order#>>'{_carryoverTo,requestId}'=p_request_id::text then
    if v_order#>>'{_carryoverTo,requestHash}' is distinct from md5(jsonb_build_object('date',p_date,'sources',p_sources)::text) then raise exception '이미 처리된 이월 요청의 날짜·수량은 변경할 수 없습니다.';end if;
    return public.dbmt_work_order_snapshot(v_rows)||jsonb_build_object('childId',v_order#>>'{_carryoverTo,id}','alreadyCarried',true);
  end if;
  v_state:=public.dbmt_work_order_carry_state(p_id);
  if md5(v_state::text) is distinct from p_state_version then raise exception '작업지시 또는 생산일보가 변경되었습니다. 이월 창을 다시 열어 확인해주세요.'; end if;
  if not (v_state->>'canCarry')::boolean then raise exception '%',v_state->>'reason'; end if;
  if p_date is null or p_date<=public.dbmt_safe_date(v_order->>'date') then raise exception '다음 작업일은 원래 작업일보다 이후로 선택해주세요.'; end if;
  if jsonb_typeof(p_sources) is distinct from 'array' or jsonb_array_length(p_sources) not between 1 and 30 then raise exception '이월 원료를 하나 이상 입력해주세요.'; end if;
  if exists(select 1 from jsonb_array_elements(p_sources) e group by e->>'index' having count(*)>1) then raise exception '같은 원료를 중복 이월할 수 없습니다.'; end if;
  for v_item in select e from jsonb_array_elements(p_sources) e loop
    select e into v_limit from jsonb_array_elements(v_state->'sources') e where e->'index'=v_item->'index';
    if v_limit is null then raise exception '이월할 원료 연결을 확인해주세요.'; end if;
    v_qty:=public.dbmt_safe_numeric(v_item->>'qty');
    if jsonb_typeof(v_item->'qty') is distinct from 'number' or v_qty<=0 or v_qty>999999999 or round(v_qty,2)<>v_qty
      or v_qty>public.dbmt_safe_numeric(v_limit->>'maxKg') then raise exception '이월 중량은 원료별 이월 상한 이내로 입력해주세요.'; end if;
    v_boxes:=null;
    if v_item->>'boxCount' is not null then
      v_boxes:=public.dbmt_safe_numeric(v_item->>'boxCount');
      if jsonb_typeof(v_item->'boxCount') is distinct from 'number' or v_boxes<0 or v_boxes>999999999 or trunc(v_boxes)<>v_boxes
        or (v_limit->>'maxBoxes' is not null and v_boxes>public.dbmt_safe_numeric(v_limit->>'maxBoxes')) then
        raise exception '이월 박스수는 이월 상한 이내의 0 이상 정수로 입력하거나 공란으로 두세요.';
      end if;
    end if;
    v_input:=(public.dbmt_work_order_source_inputs(v_order))->((v_item->>'index')::integer);
    v_input:=v_input||jsonb_build_object('inputWeight',v_qty,'boxCount',v_boxes);
    -- The stock identity, cost and LOT remain the same. No new inventory receipt.
    v_inputs:=v_inputs||jsonb_build_array(v_input);
    v_total:=v_total+v_qty;
    if v_boxes is null then v_all_boxes:=false;else v_total_boxes:=v_total_boxes+v_boxes;end if;
  end loop;
  perform public.dbmt_work_order_source_inputs(jsonb_build_object('sourceInputs',v_inputs));
  v_child_id:='wo_carry_'||replace(p_request_id::text,'-','');
  if exists(select 1 from jsonb_array_elements(v_rows) e where e->>'id'=v_child_id) then raise exception '이미 사용된 이월 요청입니다.'; end if;
  v_days:=public.dbmt_safe_date(v_order->>'expdate')-public.dbmt_safe_date(v_order->>'mfgdate');
  v_child:=(v_order-array['_carryoverTo','_carryoverFrom','id','updatedAt'])||jsonb_build_object(
    'id',v_child_id,'date',p_date,'mfgdate',p_date,
    'expdate',case when v_days between 0 and 3650 then to_char(p_date+v_days,'YYYY-MM-DD') else '' end,
    'sourceInputs',v_inputs,'sourceStock',v_inputs#>'{0,sourceStock}','sourceStockKey',v_inputs#>>'{0,sourceStockKey}',
    'inputWeight',v_total,'inputBoxCount',case when v_all_boxes then v_total_boxes else null end,'updatedAt',now(),
    '_carryoverFrom',jsonb_build_object('id',p_id,'date',v_order->>'date','rootId',coalesce(v_order#>>'{_carryoverFrom,rootId}',p_id),'requestId',p_request_id));
  v_meta:=jsonb_build_object('id',v_child_id,'date',p_date,'requestId',p_request_id,'productionId',v_state->'productionId','createdAt',now(),
    'labelKg',v_state->'labelKg','labelBoxes',v_state->'labelBoxes','requestHash',md5(jsonb_build_object('date',p_date,'sources',p_sources)::text));
  select jsonb_agg(case when e->>'id'=p_id then e||jsonb_build_object('_carryoverTo',v_meta,'updatedAt',now()) else e end order by n)
    into v_rows from jsonb_array_elements(v_rows) with ordinality a(e,n);
  v_rows:=jsonb_build_array(v_child)||v_rows;
  update public.app_data set payload=v_rows,updated_at=now() where key='workOrders';
  insert into public.change_logs(entity,action,summary,payload) values('workorders','carryover','Work order carried forward',jsonb_build_object('id',p_id,'childId',v_child_id,'date',p_date));
  return public.dbmt_work_order_snapshot(v_rows)||jsonb_build_object('childId',v_child_id);
end;
$fn$;

-- Before any label is printed, an accidental carry can be cancelled atomically.
create or replace function public.dbmt_erp_cancel_work_order_carryover(p_token text,p_id text,p_expected_version text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v_rows jsonb;v_child jsonb;v_parent jsonb;
begin
  if public.dbmt_erp_has_permission(p_token,'workorders','view') is not true
    or public.dbmt_erp_has_permission(p_token,'workorders','update') is not true
    or public.dbmt_erp_has_permission(p_token,'workorders','delete') is not true then raise exception '작업지시 조회·수정·삭제 권한 또는 로그인 상태를 확인해주세요.';end if;
  perform pg_advisory_xact_lock(36100910);perform pg_advisory_xact_lock(40100914);
  select payload into v_rows from public.app_data where key='workOrders' for update;
  select e into v_child from jsonb_array_elements(v_rows) e where e->>'id'=p_id;
  if v_child is null then return public.dbmt_work_order_snapshot(v_rows)||jsonb_build_object('alreadyCancelled',true);end if;
  if md5(v_child::text) is distinct from p_expected_version then raise exception '작업지시가 변경되었습니다. 최신 목록을 확인해주세요.';end if;
  if not(v_child ? '_carryoverFrom') or v_child ? '_carryoverTo' then raise exception '다음 작업으로 다시 이월되지 않은 이월 작업만 취소할 수 있습니다.';end if;
  if exists(select 1 from public.app_data a cross join lateral jsonb_array_elements(a.payload) e where a.key='labelPrintLogs' and e->>'workOrderId'=p_id)
    or exists(select 1 from public.label_production_completions where work_order_id=p_id) then raise exception '이미 라벨 출력 또는 생산 이력이 있어 이월을 취소할 수 없습니다.';end if;
  select e into v_parent from jsonb_array_elements(v_rows) e where e->>'id'=v_child#>>'{_carryoverFrom,id}';
  if v_parent#>>'{_carryoverTo,id}' is distinct from p_id then raise exception '원 작업지시의 이월 연결을 확인해주세요.';end if;
  select coalesce(jsonb_agg(case when e->>'id'=v_parent->>'id' then (e-'_carryoverTo')||jsonb_build_object('updatedAt',now()) else e end order by n),'[]'::jsonb)
    into v_rows from jsonb_array_elements(v_rows) with ordinality a(e,n) where e->>'id'<>p_id;
  update public.app_data set payload=v_rows,updated_at=now() where key='workOrders';
  insert into public.change_logs(entity,action,summary,payload) values('workorders','cancel_carryover','Work order carry cancelled',jsonb_build_object('id',p_id,'parentId',v_parent->>'id'));
  return public.dbmt_work_order_snapshot(v_rows);
end;
$fn$;

-- Carry links and allocated sources cannot be forged or removed by generic row
-- edits. Closed parents remain as history; the pending child can edit its spec.
create or replace function public.dbmt_guard_work_order_carry_edit(p_old jsonb,p_new jsonb,p_delete boolean)
returns void language plpgsql security invoker set search_path='' as $fn$
begin
  if p_old ? '_carryoverTo' then raise exception '잔량을 이월한 원 작업지시는 수정·삭제할 수 없습니다. 연결된 다음 작업지시를 사용해주세요.'; end if;
  if p_new ? '_carryoverTo' then raise exception '이월 연결은 잔량 이월 기능에서 등록해주세요.';end if;
  if p_old ? '_carryoverFrom' then
    if p_delete then raise exception '이월로 연결된 작업지시는 삭제할 수 없습니다. 작업일을 수정하거나 다음 작업일로 이월해주세요.'; end if;
    if p_old->'_carryoverFrom' is distinct from p_new->'_carryoverFrom'
      or public.dbmt_work_order_source_inputs(p_old) is distinct from public.dbmt_work_order_source_inputs(p_new)
      or p_old->'inputWeight' is distinct from p_new->'inputWeight' or p_old->'inputBoxCount' is distinct from p_new->'inputBoxCount' then
      raise exception '이월된 원료와 중량·박스수는 이월 등록값을 유지해주세요.';
    end if;
  elsif p_new ? '_carryoverFrom' or p_new ? '_carryoverTo' then raise exception '이월 연결은 잔량 이월 기능에서 등록해주세요.'; end if;
end;
$fn$;
revoke all on function public.dbmt_guard_work_order_carry_edit(jsonb,jsonb,boolean) from public,anon,authenticated;

-- Defer the check until the final journal exists, allowing the existing
-- soft-delete/upsert implementation for note edits and output label splits.
create or replace function public.dbmt_guard_carried_production()
returns trigger language plpgsql security definer set search_path='' as $fn$
declare v_final public.production_entries%rowtype;
begin
  if exists(select 1 from public.app_data a cross join lateral jsonb_array_elements(a.payload) e
    where a.key='workOrders' and e#>>'{_carryoverTo,productionId}'=old.id) then
    select * into v_final from public.production_entries where id=old.id;
    if not found or v_final.deleted_at is not null or v_final.raw->'inputs' is distinct from old.raw->'inputs' then
      raise exception '잔량 이월에 연결된 생산일보의 투입 원료는 변경하거나 삭제할 수 없습니다.';
    end if;
  end if;
  return null;
end;
$fn$;
revoke all on function public.dbmt_guard_carried_production() from public,anon,authenticated;
drop trigger if exists trg_dbmt_carried_production on public.production_entries;
create constraint trigger trg_dbmt_carried_production after update or delete on public.production_entries
  deferrable initially deferred for each row execute function public.dbmt_guard_carried_production();

do $patch$
declare v_def text;v_old text;
begin
  select pg_get_functiondef('public.dbmt_erp_write_work_order(text,jsonb,text,boolean)'::regprocedure) into v_def;
  if position('dbmt_guard_work_order_carry_edit' in v_def)=0 then
    v_old:='v_action:=case when p_delete';
    if position(v_old in v_def)=0 then raise exception 'Unexpected work order row writer';end if;
    v_def:=replace(v_def,v_old,'perform public.dbmt_guard_work_order_carry_edit(v_old,p_row,p_delete); '||v_old);execute v_def;
  end if;
  select pg_get_functiondef('public.dbmt_label_print_save_logs(text,jsonb)'::regprocedure) into v_def;
  if position('잔량을 이월한 작업에는 새 라벨' in v_def)=0 then
    v_old:='if v_order is null or v_new#>>';
    if position(v_old in v_def)=0 then raise exception 'Unexpected label log writer';end if;
    v_def:=replace(v_def,v_old,'if v_order ? ''_carryoverTo'' then raise exception ''잔량을 이월한 작업에는 새 라벨을 추가할 수 없습니다. 다음 작업지시를 선택해주세요.''; end if; '||v_old);execute v_def;
  end if;
end;
$patch$;
revoke all on function public.dbmt_erp_get_work_order_carryover(text,text) from public;
revoke all on function public.dbmt_erp_carry_work_order(text,text,date,jsonb,text,uuid) from public;
grant execute on function public.dbmt_erp_get_work_order_carryover(text,text) to anon,authenticated;
grant execute on function public.dbmt_erp_carry_work_order(text,text,date,jsonb,text,uuid) to anon,authenticated;
revoke all on function public.dbmt_erp_cancel_work_order_carryover(text,text,text) from public;
grant execute on function public.dbmt_erp_cancel_work_order_carryover(text,text,text) to anon,authenticated;
notify pgrst,'reload schema';
