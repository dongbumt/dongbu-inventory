-- Optional consumed boxes follow each selected raw-stock source through label
-- production completion. Existing orders/journals are not backfilled or changed.
-- The multi-source array is authoritative; inputBoxCount supports legacy orders.
create or replace function public.dbmt_work_order_source_inputs(p_order jsonb)
returns jsonb language plpgsql immutable security invoker set search_path='' as $dbmt$
declare v_inputs jsonb; v_input jsonb; v_source jsonb; v_boxes numeric; v_available numeric;
begin
  if p_order ? 'sourceInputs' then
    if jsonb_typeof(p_order->'sourceInputs') is distinct from 'array'
      or jsonb_array_length(p_order->'sourceInputs') not between 1 and 30 then
      raise exception '작업지시의 투입 원료육 목록을 확인해주세요. 최대 30건까지 가능합니다.';
    end if;
    v_inputs:=p_order->'sourceInputs';
  else
    v_source:=jsonb_build_object(
      'sourceStockKey',coalesce(p_order->>'sourceStockKey',p_order#>>'{sourceStock,key}',''),
      'sourceStock',p_order->'sourceStock','inputWeight',p_order->'inputWeight');
    if p_order->>'inputBoxCount' is not null then
      v_source:=v_source||jsonb_build_object('boxCount',p_order->'inputBoxCount');
    end if;
    v_inputs:=jsonb_build_array(v_source);
  end if;
  for v_input in select e from jsonb_array_elements(v_inputs) e loop
    -- Omission/null means not recorded, including every untouched old order.
    if v_input->>'boxCount' is null then continue; end if;
    v_boxes:=public.dbmt_safe_numeric(v_input->>'boxCount');
    if jsonb_typeof(v_input->'boxCount') is distinct from 'number'
      or v_boxes<0 or v_boxes>999999999 or v_boxes<>trunc(v_boxes) then
      raise exception '작업지시의 투입 박스수는 0 이상의 정수로 입력해주세요. 미기록은 공란으로 두세요.';
    end if;
    -- Never invent boxes from KG. When the selected stock has a known count,
    -- reject more boxes than that immutable selection snapshot made available.
    if jsonb_typeof(v_input#>'{sourceStock,stockBoxes}')='number' then
      v_available:=public.dbmt_safe_numeric(v_input#>>'{sourceStock,stockBoxes}');
      if v_available<0 or v_available<>trunc(v_available) then
        raise exception '선택한 재고의 박스수가 올바르지 않습니다. 재고를 다시 선택해주세요.';
      end if;
      if v_boxes>v_available then
        raise exception '투입 박스수가 선택한 재고의 박스수보다 큽니다. 재고를 다시 확인해주세요.';
      end if;
    end if;
  end loop;
  return v_inputs;
end;
$dbmt$;

-- Preserve the installed completion's PIN, immutable snapshot, generation,
-- multi-source, rounding, output box-count and stock-row rules. Only copy each
-- explicitly recorded source box count into its generated consumption row.
do $migration$
declare v_definition text; v_old text; v_new text;
begin
  select pg_get_functiondef('public.dbmt_label_complete_production(text,text,jsonb)'::regprocedure) into v_definition;
  v_definition:=replace(v_definition,'투입 예정량','투입량');
  v_old:=$old$'stockNote',coalesce(v_source->>'stockNote','')));$old$;
  v_new:=$new$'stockNote',coalesce(v_source->>'stockNote','')) ||
      case when v_source_input ? 'boxCount' then jsonb_build_object('boxCount',v_source_input->'boxCount') else '{}'::jsonb end);$new$;
  if position(v_new in v_definition)=0 then
    if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
      raise exception 'Unexpected label completion source-input definition';
    end if;
    v_definition:=replace(v_definition,v_old,v_new);
  end if;
  execute v_definition;
end;
$migration$;

-- dbmt_label_production_transactions already spreads input metadata, so its
-- existing stockRowId/sourceStockKey and the optional boxCount travel together.
revoke all on function public.dbmt_work_order_source_inputs(jsonb) from public,anon,authenticated;
revoke all on function public.dbmt_label_complete_production(text,text,jsonb) from public;
grant execute on function public.dbmt_label_complete_production(text,text,jsonb) to anon,authenticated;
notify pgrst,'reload schema';
