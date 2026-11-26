-- Move completed product barcodes and their exact stock sources in one transaction.
alter table public.pda_package_events drop constraint pda_package_events_action_check;
alter table public.pda_package_events add constraint pda_package_events_action_check
  check (action in ('receive','ship','return','transfer'));

-- Production settlement already recalculates movement amounts. Allow its existing
-- private context to update values on a tracked movement as it does on returns.
do $patch$
declare definition text;
  previous text := $old$if old.type='입고' then v_columns:=v_columns||array['price','amount'];v_fields:=v_fields||array['price','amount'];end if;$old$;
  replacement text := $new$if old.type in ('입고','재고이동') then v_columns:=v_columns||array['price','amount'];v_fields:=v_fields||array['price','amount'];end if;$new$;
begin
  select pg_get_functiondef('pda_private.protect_transaction()'::regprocedure) into definition;
  if position(previous in definition)=0 then raise exception 'Unexpected PDA production settlement guard'; end if;
  execute replace(definition,previous,replacement);
end;
$patch$;

-- A missing box count remains unknown until an explicit stock count supersedes it.
create function pda_private.product_transfer_box_balance(p_source_id text,p_location text)
returns numeric language plpgsql stable security invoker set search_path='' as $$
declare posting record; running numeric:=0; count_text text;
begin
  for posting in
    select t.type,t.weight,t.raw->>'boxCount' boxes,t.raw->>'boxCountAfter' baseline,
      coalesce(nullif(t.from_location,''),'가공장') as from_location
    from public.transactions t where t.deleted_at is null and t.raw->>'stockRowId'=p_source_id
      and ((t.type in ('입고','생산입고','재고조정','박스기준','출고','사용')
          and coalesce(nullif(t.stock_location,''),'가공장')=p_location)
        or (t.type='재고이동' and p_location in (coalesce(nullif(t.from_location,''),'가공장'),
          coalesce(nullif(t.to_location,''),'가공장'))))
    order by t.date,(t.type not in ('입고','생산입고')),
      case when pg_input_is_valid(t.raw#>>'{_serverAudit,savedAt}','timestamptz')
        then (t.raw#>>'{_serverAudit,savedAt}')::timestamptz else t.updated_at end,t.id
  loop
    count_text:=case when posting.type='박스기준' then posting.baseline else posting.boxes end;
    if posting.type='박스기준' then
      if coalesce(count_text,'')~'^[0-9]{1,12}(\.0+)?$' then running:=count_text::numeric; end if;
    elsif coalesce(count_text,'')!~'^[0-9]{1,12}(\.0+)?$' then
      running:=null;
    elsif posting.type in ('출고','사용') or (posting.type='재고조정' and posting.weight<0)
      or (posting.type='재고이동' and posting.from_location=p_location) then
      running:=running-count_text::numeric;
      if running<0 then running:=null; end if;
    else
      running:=running+count_text::numeric;
    end if;
  end loop;
  return running;
end;
$$;

create function public.dbmt_pda_transfer(p_token text,p_request_id uuid,p_from_location text,p_to_location text,
  p_date date,p_items jsonb,p_note text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid:=pda_private.authorize(p_token,true); request_body jsonb; previous public.pda_batches%rowtype;
  item jsonb; data jsonb; prepared jsonb:='[]'::jsonb; source record; resolved_source text;
  source_held numeric; target_held numeric; source_balance numeric; available_on_date numeric; unconfirmed numeric;
  tx_id text; tx_row jsonb; weight numeric; cost numeric; audit_stamp timestamptz;
  before_state jsonb; after_state jsonb; display text; result_items jsonb:='[]'::jsonb;
  batch_result jsonb; total_weight numeric:=0;
begin
  if p_from_location is null or p_to_location is null
    or p_from_location not in ('가공장','물류창고') or p_to_location not in ('가공장','물류창고')
    or p_from_location=p_to_location then
    raise exception '가공장과 물류창고 사이의 이동 방향을 선택해주세요.';
  end if;
  if p_request_id is null or p_date is null or p_date>(now() at time zone 'Asia/Seoul')::date
    or length(coalesce(p_note,''))>500 or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception '이동일·메모·스캔 목록을 확인해주세요.';
  end if;
  if jsonb_array_length(p_items) not between 1 and 200 then
    raise exception '한 번에 1~200개 라벨을 처리할 수 있습니다.';
  end if;
  if exists(select 1 from jsonb_array_elements(p_items) i where jsonb_typeof(i) is distinct from 'object'
    or coalesce(length(i->>'barcode'),0) not between 1 and 100
    or coalesce(i->>'revision','')!~'^[0-9]{1,9}$' or jsonb_typeof(i->'revision') is distinct from 'number'
    or i-array['barcode','revision']<>'{}'::jsonb) then
    raise exception '스캔 목록을 다시 조회해주세요.';
  end if;
  request_body:=jsonb_build_object('mode','transfer','location',p_from_location,'toLocation',p_to_location,
    'date',p_date,'items',p_items,'note',coalesce(p_note,''));
  perform pg_advisory_xact_lock(36100910);
  select * into previous from public.pda_batches b where b.id=p_request_id;
  if found then
    if previous.user_id<>actor or previous.request<>request_body then
      raise exception '같은 요청번호로 다른 내용을 저장할 수 없습니다.';
    end if;
    return previous.result||jsonb_build_object('alreadySaved',true);
  end if;
  if exists(select 1 from jsonb_array_elements(p_items) i group by pda_private.decode_code(i->>'barcode') having count(*)>1) then
    raise exception '같은 제품 바코드가 목록에 중복되었습니다.';
  end if;

  for item in select i from jsonb_array_elements(p_items) i loop
    data:=pda_private.resolve(item->>'barcode');
    if data->>'productionPending'='true' or coalesce(data->>'_productionId','')='' then
      raise exception '생산완료된 제품 라벨만 재고이동할 수 있습니다: %',data->>'code';
    end if;
    if (item->>'revision')::integer<>(data->>'revision')::integer then
      raise exception '다른 작업자가 처리한 라벨이 있습니다. 목록을 새로 조회해주세요: %',data->>'code';
    end if;
    if data->>'state'<>'in_stock' then
      raise exception '이미 출고되었거나 이동할 수 없는 제품 라벨입니다: %',data->>'code';
    end if;
    if data->>'location' is distinct from p_from_location then
      raise exception '현재 재고 지점은 %입니다. 이동 방향을 확인해주세요.',data->>'location';
    end if;
    if p_date<greatest(public.dbmt_safe_date(data->>'mfgdate'),public.dbmt_safe_date(data->>'splitDate'),
        public.dbmt_safe_date(data#>>'{_source,date}')) or exists(
      select 1 from public.pda_package_events e join public.pda_batches b on b.id=e.batch_id
      where e.label_id=data->>'labelId' and public.dbmt_safe_date(b.request->>'date')>p_date
        and not exists(select 1 from pda_private.product_shipment_cancellations c where c.event_id=e.id)
    ) then raise exception '이동일은 제조일·분할일·입고일 및 이전 처리일보다 빠를 수 없습니다.'; end if;
    if coalesce(data->>'stockRowId','')='' or (data->>'weight')::numeric<=0
      or (data->>'productionCost')::numeric is null then
      raise exception '연결된 재고원본·라벨 중량·원가를 확인해주세요.';
    end if;
    prepared:=prepared||jsonb_build_array(data);
  end loop;

  for source in select d->>'stockRowId' id,max(d->>'_productionId') production_id,
      count(*) boxes,sum((d->>'weight')::numeric) weight,
      coalesce(sum((d->>'weight')::numeric) filter(where d->>'registered'='true'),0) registered_weight,
      coalesce(sum((d->>'weight')::numeric) filter(where d->>'registered'='false'),0) unregistered_weight
    from jsonb_array_elements(prepared) d group by d->>'stockRowId'
  loop
    resolved_source:=source.id;
    source_balance:=pda_private.balance(resolved_source,p_from_location);
    select coalesce(sum(p.weight) filter(where p.location=p_from_location),0),
      coalesce(sum(p.weight) filter(where p.location=p_to_location),0)
      into source_held,target_held from public.pda_packages p
      where p.source_stock_row_id=resolved_source and p.state='in_stock' and p.location in (p_from_location,p_to_location);
    if source_balance-source.weight+0.005<source_held-source.registered_weight then
      raise exception '%의 현재 재고 중량을 초과하거나 다른 박스의 예약 재고를 차감합니다.',p_from_location;
    end if;
    if pda_private.balance(resolved_source,p_to_location)+0.005<target_held then
      raise exception '%의 재고와 연결된 박스 중량이 일치하지 않습니다. 재고를 확인해주세요.',p_to_location;
    end if;
    if source.boxes>pda_private.product_transfer_box_balance(resolved_source,p_from_location) then
      raise exception '%의 현재 재고 박스수를 초과합니다.',p_from_location;
    end if;
    if source.unregistered_weight>0 then
      -- A manual movement can leave book stock without identifying which printed
      -- labels remain. Register only when all still-unconfirmed labels reconcile.
      select coalesce(sum(public.dbmt_safe_numeric(a.label->>'labelWeight')),0) into unconfirmed
      from label_stock_private.assignments(source.production_id) a
      where a.problem is null and a.stock_row_id=resolved_source
        and not exists(select 1 from public.pda_packages p where p.label_id=a.label->>'id');
      if unconfirmed<source.unregistered_weight or source_balance+0.005<source_held+unconfirmed then
        raise exception '재고 잔량과 미확인 제품 라벨 중량이 일치하지 않습니다. PDA 입고 및 수기 이동 내역을 확인해주세요.';
      end if;
    end if;
    with movements as (
      select greatest(coalesce(t.date,p_date),p_date) movement_date,
        pda_private.movement_delta(to_jsonb(t),p_from_location) delta
      from public.transactions t where t.deleted_at is null and t.raw->>'stockRowId'=resolved_source
      union all select p_date,0::numeric
    ), daily as (
      select movement_date,sum(delta) delta from movements group by movement_date
    ), balances as (
      select sum(delta) over(order by movement_date) balance from daily
    ) select min(balance) into available_on_date from balances;
    if available_on_date+0.005<source.weight then
      raise exception '이동일 이후 % 재고가 부족해집니다. 이동일을 확인해주세요.',p_from_location;
    end if;
  end loop;

  select display_name into display from public.erp_users where id=actor;
  insert into public.pda_batches(id,user_id,request) values(p_request_id,actor,request_body);
  for data in select d from jsonb_array_elements(prepared) d loop
    weight:=(data->>'weight')::numeric;
    cost:=(data->>'productionCost')::numeric;
    resolved_source:=data->>'stockRowId';
    tx_id:='tx_pda_move_'||replace(extensions.gen_random_uuid()::text,'-','');
    audit_stamp:=clock_timestamp();
    tx_row:=(data->'_snapshot')||jsonb_build_object('id',tx_id,'date',p_date,'type','재고이동',
      'product',data->>'product','lot',data->>'lot','origin',data->>'origin','packunit',data->>'packunit','storage',data->>'storage',
      'proddate',data->>'mfgdate','weight',weight,'boxCount',1,'price',cost,'amount',round(cost*weight),'trader','',
      'stockRowId',resolved_source,'stockTrackingVersion','1','stockLocation',p_from_location,
      'fromLocation',p_from_location,'toLocation',p_to_location,'stockUnitPrice',cost,'stockProddate',data->>'mfgdate',
      'stockNote',data#>>'{_source,stockNote}','productionCost',cost,'productionCostAmount',round(cost*weight),
      '_productionCostStatus','final','_productionCostProductionId',data->>'_productionId','_productionCostSourceId',data->>'_originalStockRowId',
      '_pdaProvisional',false,'note',coalesce(p_note,''),'_isUser',true,'_pdaRequestId',p_request_id,
      '_pdaLabelId',data->>'labelId','_pdaCode',data->>'code','_pdaAction','transfer',
      '_serverAudit',jsonb_build_object('authMode','personal_session','userId',actor,'displayName',display,'savedAt',audit_stamp));
    select to_jsonb(p) into before_state from public.pda_packages p where p.label_id=data->>'labelId';
    insert into public.pda_packages(label_id,code,production_id,original_stock_row_id,source_stock_row_id,label_snapshot,weight,state,location,updated_at)
      values(data->>'labelId',data->>'code',data->>'_productionId',data->>'_originalStockRowId',resolved_source,data->'_snapshot',weight,'in_stock',p_to_location,audit_stamp)
      on conflict(label_id) do update set location=excluded.location,revision=public.pda_packages.revision+1,updated_at=excluded.updated_at
      returning to_jsonb(pda_packages.*) into after_state;
    insert into public.transactions(id,date,type,product,origin,packunit,trader,storage,lot,proddate,weight,price,amount,note,
      is_user,stock_unit_price,stock_proddate,stock_location,from_location,to_location,raw)
      values(tx_id,p_date,'재고이동',data->>'product',data->>'origin',data->>'packunit','',data->>'storage',data->>'lot',
        public.dbmt_safe_date(data->>'mfgdate'),weight,cost,round(cost*weight),coalesce(p_note,''),true,cost,
        public.dbmt_safe_date(data->>'mfgdate'),p_from_location,p_from_location,p_to_location,tx_row);
    insert into public.pda_package_events(batch_id,label_id,action,transaction_id,before_state,after_state)
      values(p_request_id,data->>'labelId','transfer',tx_id,before_state,after_state);
    result_items:=result_items||jsonb_build_array((data-array['_originalStockRowId','_productionId','_snapshot','_source'])||
      jsonb_build_object('action','transfer','transactionId',tx_id,'registered',true,'location',p_to_location,'revision',after_state->'revision'));
    total_weight:=total_weight+weight;
  end loop;
  batch_result:=jsonb_build_object('ok',true,'requestId',p_request_id,'count',jsonb_array_length(result_items),'weight',total_weight,
    'transferred',jsonb_array_length(result_items),'items',result_items,'fromLocation',p_from_location,'toLocation',p_to_location,'savedAt',clock_timestamp());
  update public.pda_batches set result=batch_result where id=p_request_id;
  insert into public.change_logs(entity,action,entity_id,summary,payload) values('PDA 입출고','재고이동',p_request_id::text,
    format('%s %s → %s / %s박스 / %sKG',p_date,p_from_location,p_to_location,jsonb_array_length(result_items),total_weight),
    jsonb_build_object('userId',actor,'displayName',display,'requestId',p_request_id,'fromLocation',p_from_location,
      'toLocation',p_to_location,'items',result_items));
  return batch_result;
end;
$$;

revoke all on function pda_private.product_transfer_box_balance(text,text),
  public.dbmt_pda_transfer(text,uuid,text,text,date,jsonb,text) from public,anon,authenticated;
grant execute on function public.dbmt_pda_transfer(text,uuid,text,text,date,jsonb,text) to anon,authenticated;
notify pgrst,'reload schema';
