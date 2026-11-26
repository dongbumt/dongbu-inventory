-- PDA scans attach to an existing ERP receipt, then move that source and those boxes together.
create function pda_private.raw_manual_warehouse_receipts(p_product_id text)
returns setof public.transactions language sql stable security invoker set search_path='' as $$
  select t.* from public.transactions t
  where t.deleted_at is null and t.type='입고' and t.stock_location='물류창고'
    and t.raw->>'labelProductId'=p_product_id and coalesce(t.raw->>'stockRowId','')<>''
    and coalesce(t.raw->>'_pdaRawRequestId','')='' and coalesce(t.raw->>'_pdaRequestId','')=''
    and nullif(btrim(t.lot),'') is not null and t.date is not null
    and exists(select 1 from public.app_data a cross join lateral jsonb_array_elements(a.payload) p
      where a.key='labelProducts' and p->>'id'=p_product_id and coalesce(p->>'kind','원료육')='원료육'
        and coalesce(p->>'active','true')<>'false' and coalesce(p->>'isActive','true')<>'false')
    and not exists(select 1 from public.pda_packages p where p.source_stock_row_id=t.raw->>'stockRowId')
    and not exists(select 1 from public.transactions u where u.deleted_at is null and u.type in ('출고','사용','재고이동')
      and coalesce(u.raw->>'stockRowId','')='' and u.product=t.product and coalesce(u.lot,'')=coalesce(t.lot,'')
      and (u.date is null or u.date>=t.date));
$$;

create function pda_private.raw_warehouse_box_balance(p_source_id text)
returns numeric language plpgsql stable security invoker set search_path='' as $$
declare tx record; running numeric:=0; count_value text;
begin
  for tx in select t.type,t.weight,t.raw->>'boxCount' boxes,t.raw->>'boxCountAfter' baseline,
      t.from_location,t.to_location
    from public.transactions t where t.deleted_at is null and t.raw->>'stockRowId'=p_source_id
      and ((t.type in ('입고','출고','사용','재고조정','박스기준') and t.stock_location='물류창고')
        or (t.type='재고이동' and '물류창고' in (t.from_location,t.to_location)))
    order by t.date,(t.type<>'입고'),t.updated_at,t.id
  loop
    count_value:=case when tx.type='박스기준' then tx.baseline else tx.boxes end;
    if tx.type='박스기준' then
      if coalesce(count_value,'')~'^[0-9]{1,12}(\.0+)?$' then running:=count_value::numeric;end if;
    elsif coalesce(count_value,'')!~'^[0-9]{1,12}(\.0+)?$' then running:=null;
    elsif tx.type in ('출고','사용') or (tx.type='재고조정' and tx.weight<0)
      or (tx.type='재고이동' and tx.from_location='물류창고') then
      running:=running-count_value::numeric;
      if running<0 then running:=null;end if;
    else running:=running+count_value::numeric;
    end if;
  end loop;
  return running;
end;
$$;

create function public.dbmt_pda_raw_transfer_sources(p_token text,p_product_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform pda_private.authorize(p_token);
  return jsonb_build_object('ok',true,'rows',coalesce((
    select jsonb_agg(jsonb_build_object('id',r.source_id,'date',t.date,'lot',t.lot,'proddate',t.proddate,
      'price',t.price,'available',r.balance,'unlinkedWeight',greatest(0,r.balance-held.weight),
      'linkedWeight',held.weight,'linkedBoxes',held.boxes) order by t.date desc,t.id)
    from pda_private.raw_manual_warehouse_receipts(p_product_id) t
    cross join lateral (select t.raw->>'stockRowId' source_id,
      pda_private.balance(t.raw->>'stockRowId','물류창고') balance) r
    cross join lateral (select coalesce(sum(p.weight),0) weight,count(*) boxes from pda_private.raw_packages p
      where p.source_id=r.source_id and p.state='in_stock' and p.location='물류창고') held
    where r.balance>0 and r.balance+0.005>=held.weight
  ),'[]'::jsonb));
end;
$$;

create function public.dbmt_pda_raw_transfer(p_token text,p_request_id uuid,p_date date,p_items jsonb,
  p_product_id text,p_lot text,p_source_id text,p_note text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  usr uuid:=pda_private.authorize(p_token,true); v_request jsonb; prev pda_private.raw_batches%rowtype;
  src public.transactions%rowtype; item jsonb; parsed jsonb; pack pda_private.raw_packages%rowtype;
  source_location constant text:='물류창고'; target_location constant text:='가공장';
  lot text:=btrim(coalesce(p_lot,'')); note text:=coalesce(p_note,'');
  v_package_id text; normalized_code text; entered_weight numeric; warehouse_boxes numeric; movable_weight numeric; total numeric:=0;
  package_ids text[]:=array[]::text[]; new_ids text[]:=array[]::text[]; new_items jsonb:='[]'::jsonb;
  moved integer; tx text; cost numeric; stock_raw jsonb; display text; results jsonb; outcome jsonb;
  audit_summary text; audit_payload jsonb;
begin
  if p_request_id is null or p_date is null or p_date>(now() at time zone 'Asia/Seoul')::date
    or length(coalesce(p_product_id,'')) not between 1 and 120 or length(coalesce(p_source_id,'')) not between 1 and 120
    or length(lot) not between 1 and 100 or length(note)>500 or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception '이동일·품목·이력번호·기존 입고 재고를 확인해주세요.';
  end if;
  if jsonb_array_length(p_items) not between 1 and 200 then raise exception '1~200박스씩 처리해주세요.';end if;
  v_request:=jsonb_build_object('mode','transfer','location',source_location,'toLocation',target_location,'date',p_date,
    'items',p_items,'productId',p_product_id,'lot',lot,'sourceId',p_source_id,'note',note);
  perform pg_advisory_xact_lock(36100910);
  select b.* into prev from pda_private.raw_batches b where b.id=p_request_id;
  if found then
    if prev.user_id<>usr or prev.request<>v_request then raise exception '같은 요청번호로 다른 내용을 저장할 수 없습니다.';end if;
    return prev.result||jsonb_build_object('alreadySaved',true);
  end if;
  select t.* into src from pda_private.raw_manual_warehouse_receipts(p_product_id) t where t.raw->>'stockRowId'=p_source_id;
  if not found or src.lot is distinct from lot then raise exception '물류창고 수기 입고 재고와 이력번호를 다시 선택해주세요.';end if;
  if src.date>p_date then raise exception '이동일은 기존 입고일보다 빠를 수 없습니다.';end if;

  for item in select i from jsonb_array_elements(p_items) i loop
    if jsonb_typeof(item) is distinct from 'object' or coalesce(item->>'barcode','')='' or length(item->>'barcode')>300
      or coalesce(item->>'revision','')!~'^[0-9]{1,9}$' or jsonb_typeof(item->'revision') is distinct from 'number'
      or jsonb_typeof(item->'labelWeight') is distinct from 'number' or item->'checked' is distinct from 'true'::jsonb
      or coalesce(item->>'rule','')='' or length(item->>'rule')>120
      or item-array['barcode','revision','rule','labelWeight','checked','manualWeight','manualUnit']<>'{}'::jsonb
      or (item->>'rule'<>'manual:v1' and item ?| array['manualWeight','manualUnit']) then
      raise exception '스캔 목록의 중량 대조를 다시 확인해주세요.';
    end if;
    entered_weight:=(item->>'labelWeight')::numeric;
    if entered_weight<=0 or entered_weight>1000 or entered_weight<>round(entered_weight,2) then
      raise exception '박스 중량은 0보다 크고 소수 둘째 자리까지 입력해주세요.';
    end if;
    normalized_code:=regexp_replace(btrim(item->>'barcode',E' \r\n\t'),'^\](C0|C1|d2|Q3|I0)','');
    if item->>'rule'='manual:v1' and normalized_code~'^DR1[0-9]{26}$' and not exists(
      select 1 from pda_private.raw_manual_labels m where m.barcode=normalized_code) then
      -- The existing bind validates and creates this internal label in this transaction.
      parsed:=null;
      v_package_id:=encode(extensions.digest('MANUAL:'||normalized_code,'sha256'),'hex');
    else
      parsed:=pda_private.raw_parse(item->>'barcode',item->>'rule');
      v_package_id:=parsed->>'id';
    end if;
    if v_package_id=any(package_ids) then raise exception '같은 박스 바코드가 목록에 중복되었습니다.';end if;
    package_ids:=array_append(package_ids,v_package_id);
    select p.* into pack from pda_private.raw_packages p where p.id=v_package_id;
    if (item->>'revision')::integer<>coalesce(pack.revision,0) then
      raise exception '다른 작업자가 처리했습니다. 스캔 목록을 다시 조회해주세요.';
    end if;
    if pack.id is null or pack.state='cancelled' then
      new_ids:=array_append(new_ids,v_package_id);
      new_items:=new_items||jsonb_build_array(item);
    else
      if pack.state<>'in_stock' or pack.source_id<>p_source_id or pack.product_id<>p_product_id
        or pack.location<>source_location or pack.snapshot->>'lot' is distinct from lot then
        raise exception '선택한 물류창고 입고 재고에 남아 있는 박스만 이동할 수 있습니다.';
      end if;
      if p_date<pack.work_date then raise exception '이동일은 해당 박스의 이전 처리일보다 빠를 수 없습니다.';end if;
      if pack.parsed->'fields' is distinct from parsed->'fields' or pack.parsed->>'ruleKey' is distinct from parsed->>'ruleKey'
        or pack.parsed->'weight' is distinct from parsed->'weight' or pack.weight<>entered_weight then
        raise exception '등록한 바코드 정보와 중량을 다시 확인해주세요.';
      end if;
    end if;
    total:=total+entered_weight;
  end loop;

  warehouse_boxes:=pda_private.raw_warehouse_box_balance(p_source_id);
  if total>pda_private.balance(p_source_id,source_location)+0.005 then raise exception '물류창고의 현재 재고 중량을 초과합니다.';end if;
  if cardinality(package_ids)>warehouse_boxes then raise exception '물류창고의 현재 재고 박스수를 초과합니다.';end if;
  -- A backdated movement must also fit the warehouse balance on and after its date.
  with daily as (
    select greatest(coalesce(t.date,p_date),p_date) as movement_date,
      sum(pda_private.movement_delta(to_jsonb(t),source_location)) delta
    from public.transactions t where t.deleted_at is null and t.raw->>'stockRowId'=p_source_id
    group by 1
  ), balances as (
    select sum(delta) over(order by movement_date) balance from daily
  )
  select min(balance) into movable_weight from balances;
  if total>coalesce(movable_weight,0)+0.005 then raise exception '이동일 이후 해당 물류창고 재고가 부족해집니다. 이동일을 확인해주세요.';end if;
  if cardinality(new_ids)>0 then
    -- Link only the new boxes to this receipt. The existing implementation checks
    -- source identity, GTIN, unreserved KG and the barcode/label weight, and adds no receipt.
    perform public.dbmt_pda_raw_commit(p_token,p_request_id,'inbound',source_location,null,p_date,
      new_items,p_product_id,lot,p_source_id,coalesce(src.price,0),note);
    update pda_private.raw_batches set request=v_request, result='{}'::jsonb where id=p_request_id;
  else
    insert into pda_private.raw_batches(id,user_id,request) values(p_request_id,usr,v_request);
  end if;

  -- The stock trigger sees the new physical reservations at both locations. It
  -- checks the same source balance including the movement that is about to be inserted.
  update pda_private.raw_packages p set location=target_location,work_date=p_date,revision=p.revision+1,updated_at=clock_timestamp()
    where p.id=any(package_ids) and p.source_id=p_source_id and p.product_id=p_product_id
      and p.state='in_stock' and p.location=source_location;
  get diagnostics moved=row_count;
  if moved<>cardinality(package_ids) then raise exception '박스의 현재 재고 지점이 변경됐습니다. 다시 조회해주세요.';end if;

  select display_name into display from public.erp_users where id=usr;
  tx:='tx_raw_move_'||replace(extensions.gen_random_uuid()::text,'-','');
  cost:=coalesce(src.price,0);
  stock_raw:=jsonb_build_object('id',tx,'date',p_date,'type','재고이동','product',src.product,'origin',src.origin,
    'packunit',src.packunit,'storage',src.storage,'lot',lot,'proddate',src.proddate,'trader','',
    'weight',total,'boxCount',moved,'price',cost,'amount',round(total*cost),'note',note,'labelProductId',p_product_id,
    'productCode',src.raw->>'productCode','brand',src.raw->>'brand','factoryNo',src.raw->>'factoryNo',
    'grade',src.raw->>'grade','taxType',src.raw->>'taxType','stockRowId',p_source_id,'stockTrackingVersion','1',
    'stockUnitPrice',cost,'stockProddate',src.proddate,'stockLocation',source_location,'stockNote',src.raw->>'stockNote',
    'fromLocation',source_location,'toLocation',target_location,'_isUser',true,'_pdaAction','transfer',
    '_pdaRawRequestId',p_request_id,'_serverAudit',jsonb_build_object('authMode','personal_session',
      'userId',usr,'displayName',display,'savedAt',clock_timestamp()));
  insert into public.transactions(id,date,type,product,origin,packunit,trader,storage,lot,proddate,weight,price,amount,
    note,is_user,stock_unit_price,stock_proddate,stock_location,from_location,to_location,raw)
  values(tx,p_date,'재고이동',src.product,src.origin,src.packunit,'',src.storage,lot,src.proddate,total,cost,round(total*cost),
    note,true,cost,src.proddate,source_location,source_location,target_location,stock_raw);

  insert into pda_private.raw_events(batch_id,package_id,action,transaction_id,scan)
  select p_request_id,p.id,'transfer',tx,a.scan||jsonb_build_object('parsed',p.parsed,
    'newlyLinked',p.id=any(new_ids),'fromLocation',source_location,'toLocation',target_location)
  from unnest(package_ids) with ordinality ids(id,n)
  join pda_private.raw_packages p on p.id=ids.id
  join jsonb_array_elements(p_items) with ordinality a(scan,n) on a.n=ids.n
  on conflict(batch_id,package_id) do update set action=excluded.action,transaction_id=excluded.transaction_id,scan=excluded.scan;

  select jsonb_agg(jsonb_build_object('id',p.id,'product',src.product,'lot',lot,'weight',p.weight,'action','transfer',
    'transactionId',tx,'stockRowId',p_source_id,'barcode',p.barcode,'newlyLinked',p.id=any(new_ids))||
    case when m.barcode is not null then jsonb_build_object('manualWeight',m.input_weight,'manualUnit',m.input_unit,
      'entryKind','manual','entryReason','바코드 훼손 수기입력') else '{}'::jsonb end order by ids.n) into results
  from unnest(package_ids) with ordinality ids(id,n)
  join pda_private.raw_packages p on p.id=ids.id
  left join pda_private.raw_manual_labels m on m.barcode=p.barcode;
  outcome:=jsonb_build_object('ok',true,'requestId',p_request_id,'count',moved,'weight',total,'items',results,
    'transactionId',tx,'savedAt',clock_timestamp());
  update pda_private.raw_batches set result=outcome where id=p_request_id;
  audit_summary:=format('%s 물류창고 → 가공장 / %s / 이력번호 %s / %s박스 / %sKG',p_date,src.product,lot,moved,total);
  audit_payload:=jsonb_build_object('userId',usr,'displayName',display,'request',v_request,'result',outcome);
  if cardinality(new_ids)>0 then
    update public.change_logs set action='재고이동',summary=audit_summary,payload=audit_payload
      where entity='PDA 원료육' and action='입고' and entity_id=p_request_id::text;
  else
    insert into public.change_logs(entity,action,entity_id,summary,payload)
      values('PDA 원료육','재고이동',p_request_id::text,audit_summary,audit_payload);
  end if;
  return outcome;
end;
$$;

revoke all on function pda_private.raw_manual_warehouse_receipts(text),pda_private.raw_warehouse_box_balance(text),
  public.dbmt_pda_raw_transfer_sources(text,text),public.dbmt_pda_raw_transfer(text,uuid,date,jsonb,text,text,text,text)
  from public,anon,authenticated;
grant execute on function public.dbmt_pda_raw_transfer_sources(text,text),
  public.dbmt_pda_raw_transfer(text,uuid,date,jsonb,text,text,text,text) to anon,authenticated;
notify pgrst,'reload schema';
