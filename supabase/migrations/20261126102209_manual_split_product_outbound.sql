-- Link selected split cartons to their ERP outbound without changing ordinary outbound.
create function public.dbmt_erp_get_manual_split_stock(p_token text,p_sources jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=public.dbmt_erp_session_user(p_token); v_rows jsonb;
begin
  if v_user is null then
    return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.');
  end if;
  if public.dbmt_erp_has_permission(p_token,'transactions','create') is not true then
    return public.dbmt_erp_permission_denied(v_user,'transactions','create');
  end if;
  if jsonb_typeof(p_sources) is distinct from 'array' or jsonb_array_length(p_sources)>500 then
    raise exception '출고 재고는 한 번에 500개까지 조회할 수 있습니다.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('stockRowId',s.source,'location',s.location,
    'quantity',pda_private.balance(s.source,s.location),'heldWeight',p.held,'packages',p.labels)), '[]'::jsonb)
  into v_rows
  from (select distinct e->>'stockRowId' as source,coalesce(nullif(e->>'location',''),'가공장') as location
    from jsonb_array_elements(p_sources) e where nullif(e->>'stockRowId','') is not null) s
  cross join lateral (
    select coalesce(sum(u.weight),0) as held,
      jsonb_agg(jsonb_build_object('barcode',c.print_code,'weight',u.weight,'revision',u.revision)
        order by c.print_code) filter(where c.label_id is not null) as labels
    from public.pda_packages u left join pda_private.weight_split_labels c on c.label_id=u.label_id
    where u.source_stock_row_id=s.source and u.location=s.location and u.state='in_stock'
  ) p where p.labels is not null;
  return jsonb_build_object('ok',true,'rows',v_rows);
end;
$$;
revoke all on function public.dbmt_erp_get_manual_split_stock(text,jsonb) from public,anon,authenticated;
grant execute on function public.dbmt_erp_get_manual_split_stock(text,jsonb) to anon,authenticated;

alter function public.dbmt_erp_save_transactions(text,jsonb,jsonb) rename to erp_save_transactions_before_manual_split;
alter function public.erp_save_transactions_before_manual_split(text,jsonb,jsonb) set schema pda_private;
revoke all on function pda_private.erp_save_transactions_before_manual_split(text,jsonb,jsonb) from public,anon,authenticated;

create function public.dbmt_erp_save_transactions(p_token text,p_rows jsonb default '[]'::jsonb,p_delete_ids jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=public.dbmt_erp_session_user(p_token); v_input jsonb:=coalesce(p_rows,'[]'::jsonb);
  v_writes jsonb:='[]'; v_plans jsonb:='[]'; v_groups jsonb:='[]'; v_replacements jsonb:='[]';
  v_row jsonb; v_selection jsonb; v_target jsonb; v_data jsonb; v_before jsonb; v_after jsonb;
  v_events jsonb; v_ids jsonb; v_plan jsonb; v_event jsonb; v_saved jsonb; v_result jsonb;
  v_source text; v_location text; v_id text; v_ship_id text; v_date date; v_batch uuid; v_fingerprint text;
  v_previous public.pda_batches%rowtype; v_held numeric; v_shipped numeric; v_weight numeric;
  v_price numeric; v_cost numeric; v_amount numeric; v_remaining numeric; v_requested numeric;
  v_boxes numeric; v_chosen integer; v_is_new boolean;
begin
  if v_user is null then
    return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.');
  end if;
  if jsonb_typeof(v_input) is distinct from 'array' or jsonb_typeof(coalesce(p_delete_ids,'[]'::jsonb)) is distinct from 'array'
    or jsonb_array_length(v_input)>500 or jsonb_array_length(coalesce(p_delete_ids,'[]'::jsonb))>500 then
    raise exception '거래내역은 한 번에 500건까지 올바른 목록으로 처리해주세요.';
  end if;
  if exists(select 1 from jsonb_array_elements(v_input) e group by e->>'id' having count(*)>1) then
    raise exception '같은 거래내역을 중복으로 저장할 수 없습니다.';
  end if;
  if exists(select 1 from jsonb_array_elements(v_input) e where e->>'type'='출고' and nullif(e->>'stockRowId','') is not null) then
    perform pg_advisory_xact_lock(36100910);
  end if;
  for v_row in select e from jsonb_array_elements(v_input) e loop
    v_id:=v_row->>'id';
    v_source:=nullif(v_row->>'stockRowId','');
    v_location:=coalesce(nullif(v_row->>'stockLocation',''),'가공장');
    v_is_new:=not exists(select 1 from public.transactions where id=v_id);
    v_selection:=v_row->'_manualSplitLabels';
    if v_is_new and v_row ? '_pdaRequestId' then
      raise exception 'PDA 식별정보는 서버에서만 등록할 수 있습니다.';
    end if;
    if v_row->>'type' is distinct from '출고' or v_source is null or v_row ? '_pdaRequestId' then
      if v_selection is not null then raise exception '분할 라벨은 재고를 선택한 신규 출고에서만 사용할 수 있습니다.'; end if;
      v_writes:=v_writes||jsonb_build_array(v_row);
      continue;
    end if;
    v_batch:=md5('erp-manual-split:'||v_id)::uuid;
    select * into v_previous from public.pda_batches where id=v_batch;
    v_fingerprint:=encode(extensions.digest(v_row::text,'sha256'),'hex');
    if found and (v_previous.request->>'erpRowHash'=v_fingerprint or v_is_new or v_selection is not null) then
      if v_previous.user_id is distinct from v_user or v_previous.request->>'erpRowHash' is distinct from v_fingerprint then
        raise exception '같은 출고번호로 다른 내용을 저장할 수 없습니다. 거래내역을 다시 조회해주세요.';
      end if;
      if public.dbmt_erp_has_permission(p_token,'transactions','create') is not true then
        if jsonb_array_length(v_plans)>0 then raise exception '거래내역 등록 권한이 없습니다.'; end if;
        return public.dbmt_erp_permission_denied(v_user,'transactions','create');
      end if;
      select jsonb_agg(t.raw order by i.n) into v_saved
      from jsonb_array_elements_text(v_previous.result->'erpTransactionIds') with ordinality i(id,n)
      join public.transactions t on t.id=i.id and t.deleted_at is null;
      if coalesce(jsonb_array_length(v_saved),0)<>jsonb_array_length(v_previous.result->'erpTransactionIds') then
        raise exception '이미 취소된 내역이 포함된 출고입니다. 거래내역을 다시 조회해주세요.';
      end if;
      v_replacements:=v_replacements||jsonb_build_array(jsonb_build_object('sourceId',v_id,'rows',v_saved));
      continue;
    end if;
    if not v_is_new then
      if v_selection is not null then raise exception '분할 라벨은 신규 출고에서만 선택할 수 있습니다.'; end if;
      v_writes:=v_writes||jsonb_build_array(v_row);
      continue;
    end if;

    if v_selection is null or v_selection='[]'::jsonb then
      v_writes:=v_writes||jsonb_build_array(v_row-'_manualSplitLabels');
      continue;
    end if;
    if public.dbmt_erp_has_permission(p_token,'transactions','create') is not true then
      if jsonb_array_length(v_plans)>0 then raise exception '거래내역 등록 권한이 없습니다.'; end if;
      return public.dbmt_erp_permission_denied(v_user,'transactions','create');
    end if;
    if nullif(btrim(v_id),'') is null or length(v_id)>120 or jsonb_typeof(v_selection) is distinct from 'array'
      or jsonb_array_length(v_selection) not between 1 and 500
      or coalesce(p_delete_ids,'[]'::jsonb) ? v_id then
      raise exception '분할 라벨 출고 요청을 확인해주세요.';
    end if;
    v_date:=public.dbmt_safe_date(v_row->>'date');
    v_weight:=public.dbmt_safe_numeric(v_row->>'weight');
    v_price:=public.dbmt_safe_numeric(v_row->>'price');
    v_boxes:=nullif(v_row->>'boxCount','')::numeric;
    if v_date is null or v_date>(now() at time zone 'Asia/Seoul')::date or v_weight<=0 or v_weight<>round(v_weight,2)
      or not (v_price between 0 and 1000000000) or (v_boxes is not null and (v_boxes<0 or v_boxes<>trunc(v_boxes)))
      or public.dbmt_safe_bool(v_row->>'_isProdUse',false) or public.dbmt_safe_bool(v_row->>'_isProdOut',false)
      or public.dbmt_safe_bool(v_row->>'_isStockAdjust',false) then
      raise exception '분할 라벨 출고의 일자·중량·박스수·단가를 확인해주세요.';
    end if;
    v_events:='[]'; v_ids:='[]'; v_shipped:=0; v_amount:=0;
    insert into public.pda_batches(id,user_id,request) values(v_batch,v_user,
      jsonb_build_object('mode','outbound','origin','erp_manual_split','location',v_location,'date',v_date,
        'traderId',v_row->>'traderId','note',coalesce(v_row->>'note',''),'erpRowHash',v_fingerprint));
    for v_target in select e from jsonb_array_elements(v_selection) e loop
      if jsonb_typeof(v_target) is distinct from 'object' or coalesce(v_target->>'revision','')!~'^[0-9]{1,9}$'
        or coalesce(length(v_target->>'barcode'),0) not between 1 and 100
        or not exists(select 1 from pda_private.weight_split_labels c where c.code=pda_private.decode_code(v_target->>'barcode')) then
        raise exception '중량분할 라벨을 다시 선택해주세요.';
      end if;
      v_data:=pda_private.resolve(v_target->>'barcode');
      if v_data->>'state' is distinct from 'in_stock' or v_data->>'stockRowId' is distinct from v_source
        or v_data->>'location' is distinct from v_location or v_data->>'revision' is distinct from v_target->>'revision'
        or v_data->>'product' is distinct from v_row->>'product' or v_data->>'lot' is distinct from v_row->>'lot' then
        raise exception '분할 박스의 재고 상태 또는 연결이 변경되었습니다. 재고를 다시 조회해주세요.';
      end if;
      if v_date<greatest(public.dbmt_safe_date(v_data->>'mfgdate'),(v_data->>'splitDate')::date)
        or exists(select 1 from public.pda_package_events e join public.pda_batches b on b.id=e.batch_id
          where e.label_id=v_data->>'labelId' and (b.request->>'date')::date>v_date and not exists(
            select 1 from pda_private.product_shipment_cancellations c where c.event_id=e.id)) then
        raise exception '출고일은 제조일·중량분할일 및 이전 입출고일보다 빠를 수 없습니다.';
      end if;
      v_ship_id:='tx_pda_'||replace(extensions.gen_random_uuid()::text,'-','');
      v_cost:=(v_data->>'productionCost')::numeric;
      v_remaining:=(v_data->>'weight')::numeric;
      v_shipped:=v_shipped+v_remaining;
      v_writes:=v_writes||jsonb_build_array((v_row-'_manualSplitLabels')||jsonb_build_object(
        'id',v_ship_id,'weight',v_remaining,'boxCount',1,'amount',round(v_price*v_shipped)-v_amount,
        'stockLocation',v_location,'stockUnitPrice',v_cost,'productionCost',v_cost,
        'productionCostAmount',round(v_cost*v_remaining),'_productionCostStatus','final',
        '_productionCostProductionId',v_data->>'_productionId','_productionCostSourceId',v_data->>'_originalStockRowId',
        '_pdaProvisional',false,'_pdaRequestId',v_batch,'_pdaLabelId',v_data->>'labelId',
        '_pdaCode',v_data->>'code','_pdaAction','ship'));
      v_amount:=round(v_price*v_shipped);
      select to_jsonb(p) into v_before from public.pda_packages p where p.label_id=v_data->>'labelId';
      update public.pda_packages p set state='shipped',revision=p.revision+1,updated_at=clock_timestamp()
        where p.label_id=v_data->>'labelId' returning to_jsonb(p) into v_after;
      v_events:=v_events||jsonb_build_array(jsonb_build_object('before',v_before,'after',v_after,
        'item',(v_data-array['_originalStockRowId','_productionId','_snapshot','_source'])||jsonb_build_object(
          'action','ship','state','shipped','transactionId',v_ship_id,'revision',v_after->'revision')));
      v_ids:=v_ids||jsonb_build_array(v_ship_id);
    end loop;
    v_chosen:=jsonb_array_length(v_events);
    v_remaining:=v_weight-v_shipped;
    if v_remaining<0 or v_boxes<v_chosen or (v_remaining=0 and v_boxes is not null and v_boxes<>v_chosen) then
      raise exception '선택한 분할 박스의 중량과 수량을 출고 입력과 확인해주세요.';
    end if;
    if v_remaining>0 then
      v_writes:=v_writes||jsonb_build_array((v_row-'_manualSplitLabels')||jsonb_build_object(
        'weight',v_remaining,'boxCount',v_boxes-v_chosen,'amount',round(v_price*v_weight)-v_amount));
      v_ids:=v_ids||jsonb_build_array(v_id);
    end if;
    v_plans:=v_plans||jsonb_build_array(jsonb_build_object('sourceId',v_id,'batchId',v_batch,'rows',v_ids,
      'events',v_events,'weight',v_shipped));
    v_target:=jsonb_build_object('source',v_source,'location',v_location);
    if not v_groups @> jsonb_build_array(v_target) then
      v_groups:=v_groups||jsonb_build_array(v_target);
    end if;
  end loop;

  for v_target in select e from jsonb_array_elements(v_groups) e loop
    v_source:=v_target->>'source'; v_location:=v_target->>'location';
    select coalesce(sum(p.weight),0) into v_held from public.pda_packages p
      where p.source_stock_row_id=v_source and p.location=v_location and p.state='in_stock';
    select coalesce(sum(public.dbmt_safe_numeric(e->>'weight')),0) into v_requested
      from jsonb_array_elements(v_writes) e where e->>'type'='출고' and e->>'stockRowId'=v_source
      and coalesce(nullif(e->>'stockLocation',''),'가공장')=v_location;
    if pda_private.balance(v_source,v_location)-v_requested+0.005<v_held then
      raise exception '선택한 분할 박스 외에 PDA로 관리 중인 박스의 재고가 남아야 합니다. 출고중량과 선택한 분할 라벨을 확인해주세요.';
    end if;
  end loop;
  if jsonb_array_length(v_writes)>500 then raise exception '분할 박스를 포함한 출고가 500건을 넘습니다. 나누어 저장해주세요.'; end if;
  v_result:=pda_private.erp_save_transactions_before_manual_split(p_token,v_writes,p_delete_ids);
  if v_result->>'ok' is distinct from 'true' then
    if jsonb_array_length(v_plans)>0 then
      raise exception '%',coalesce(v_result->>'message','거래내역 저장 권한을 확인해주세요.');
    end if;
    return v_result;
  end if;
  for v_plan in select e from jsonb_array_elements(v_plans) e loop
    v_batch:=(v_plan->>'batchId')::uuid;
    for v_event in select e from jsonb_array_elements(v_plan->'events') e loop
      insert into public.pda_package_events(batch_id,label_id,action,transaction_id,before_state,after_state)
      values(v_batch,v_event#>>'{item,labelId}','ship',v_event#>>'{item,transactionId}',v_event->'before',v_event->'after');
    end loop;
    update public.pda_batches set result=jsonb_build_object('ok',true,'requestId',v_batch,
      'count',jsonb_array_length(v_plan->'events'),'weight',v_plan->'weight','received',0,'returned',0,
      'shipped',jsonb_array_length(v_plan->'events'),'items',(select jsonb_agg(e->'item') from jsonb_array_elements(v_plan->'events') e),
      'erpTransactionIds',v_plan->'rows','savedAt',clock_timestamp()) where id=v_batch;
    select jsonb_agg(t.raw order by i.n) into v_saved
      from jsonb_array_elements_text(v_plan->'rows') with ordinality i(id,n) join public.transactions t on t.id=i.id;
    v_replacements:=v_replacements||jsonb_build_array(jsonb_build_object('sourceId',v_plan->>'sourceId','rows',v_saved));
  end loop;
  return v_result||jsonb_build_object('splitShipments',v_replacements);
end;
$$;
revoke all on function public.dbmt_erp_save_transactions(text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.dbmt_erp_save_transactions(text,jsonb,jsonb) to anon,authenticated;
notify pgrst,'reload schema';
