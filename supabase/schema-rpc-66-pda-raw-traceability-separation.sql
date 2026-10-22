-- Domestic traceability numbers are separate from manufacturer batch/lot codes.
-- Preserve stored inventory and parser provenance; only reject new receipts without explicit traceability.
create or replace function public.dbmt_pda_raw_commit(p_token text,p_request_id uuid,p_mode text,p_location text,
  p_trader_id uuid,p_date date,p_items jsonb,p_product_id text default null,p_lot text default '',
  p_source_id text default null,p_price numeric default 0,p_note text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  usr uuid:=pda_private.authorize(p_token,true); req jsonb; prev pda_private.raw_batches%rowtype;
  item jsonb; data jsonb; prod jsonb; snap jsonb; raw jsonb; pack pda_private.raw_packages%rowtype;
  partner public.business_partners%rowtype; src public.transactions%rowtype;
  source_id text; tx text; action text; lot text; w numeric; cost numeric; price numeric; held numeric;
  total numeric:=0; results jsonb:='[]'::jsonb; v_result jsonb; display text; linked text;
begin
  if p_request_id is null or p_mode is null or p_mode not in ('inbound','outbound') or p_date is null
    or p_date>(now() at time zone 'Asia/Seoul')::date or p_location is null or not(pda_private.locations() ? p_location)
    or p_price is null or p_price<0 or p_price>1000000000 or length(coalesce(p_lot,''))>100 or length(coalesce(p_note,''))>500
    or jsonb_typeof(p_items) is distinct from 'array' then raise exception '작업구분·일자·지점·단가·목록을 확인해주세요.'; end if;
  if jsonb_array_length(p_items) not between 1 and 200 then raise exception '1~200박스씩 처리해주세요.'; end if;
  if exists(select 1 from jsonb_array_elements(p_items) i where jsonb_typeof(i) is distinct from 'object'
    or coalesce(i->>'barcode','')='' or length(i->>'barcode')>300 or coalesce(i->>'revision','')!~'^[0-9]{1,9}$'
    or jsonb_typeof(i->'revision') is distinct from 'number' or jsonb_typeof(i->'labelWeight') is distinct from 'number'
    or i->>'checked' is distinct from 'true' or jsonb_typeof(i->'checked') is distinct from 'boolean'
    or i-array['barcode','revision','rule','labelWeight','checked']<>'{}'::jsonb)
    then raise exception '스캔 목록의 중량 대조를 다시 확인해주세요.'; end if;
  req:=jsonb_build_object('mode',p_mode,'location',p_location,'traderId',p_trader_id,'date',p_date,'items',p_items,
    'productId',p_product_id,'lot',p_lot,'sourceId',p_source_id,'price',p_price,'note',p_note);
  perform pg_advisory_xact_lock(36100910);
  select * into prev from pda_private.raw_batches where id=p_request_id;
  if found then
    if prev.user_id<>usr or prev.request<>req then raise exception '같은 요청번호로 다른 내용을 저장할 수 없습니다.'; end if;
    return prev.result||jsonb_build_object('alreadySaved',true);
  end if;
  if exists(select 1 from jsonb_array_elements(p_items) i group by pda_private.raw_parse(i->>'barcode',i->>'rule')->>'id' having count(*)>1)
    then raise exception '같은 박스 바코드가 목록에 중복되었습니다.'; end if;
  if p_mode='outbound' or coalesce(p_source_id,'')='' then
    select * into partner from public.business_partners where id=p_trader_id and active and
      trade_type in (case when p_mode='outbound' then '매출' else '매입' end,'매입/매출');
    if not found then raise exception '작업구분에 맞는 거래처를 선택해주세요.'; end if;
  end if;
  if p_mode='inbound' then
    select p into prod from public.app_data a cross join lateral jsonb_array_elements(a.payload) p
      where a.key='labelProducts' and p->>'id'=p_product_id and coalesce(p->>'kind','원료육')='원료육' and coalesce(p->>'active','true')<>'false' and coalesce(p->>'isActive','true')<>'false';
    if prod is null then raise exception '등록된 원료육 품목을 선택해주세요.'; end if;
    if coalesce(p_source_id,'')<>'' then
      select t.* into src from public.transactions t where t.deleted_at is null and t.type='입고' and t.raw->>'stockRowId'=p_source_id
        and t.raw->>'labelProductId'=p_product_id and coalesce(nullif(t.stock_location,''),'가공장')=p_location;
      if not found or exists(select 1 from public.pda_packages where source_stock_row_id=p_source_id) then
        raise exception '기존 원료육 입고 재고를 정확히 선택해주세요.';
      end if;
      if src.date>p_date then raise exception '작업일은 기존 입고일보다 빠를 수 없습니다.'; end if;
      if exists(select 1 from public.transactions u where u.deleted_at is null and u.type in ('출고','사용','재고이동')
        and coalesce(u.raw->>'stockRowId','')='' and u.product=src.product and coalesce(u.lot,'')=coalesce(src.lot,'')
        and (u.date is null or u.date>=src.date)) then raise exception '재고원본이 지정되지 않은 과거 출고·사용·이동이 있어 자동 연결할 수 없습니다.'; end if;
    end if;
  end if;
  select display_name into display from public.erp_users where id=usr;
  insert into pda_private.raw_batches(id,user_id,request) values(p_request_id,usr,req);
  for item in select i from jsonb_array_elements(p_items) i loop
    data:=pda_private.raw_parse(item->>'barcode',item->>'rule');
    select * into pack from pda_private.raw_packages where id=data->>'id';
    if pack.id is not null and (pack.parsed->'fields' is distinct from data->'fields' or pack.parsed->>'ruleKey' is distinct from data->>'ruleKey'
      or pack.parsed->'weight' is distinct from data->'weight') then raise exception '같은 고유번호의 바코드 정보가 등록 후 변경되었습니다.'; end if;
    if (item->>'revision')::integer<>coalesce(pack.revision,0) then raise exception '다른 작업자가 처리했습니다. 스캔 목록을 다시 조회해주세요.'; end if;
    w:=(item->>'labelWeight')::numeric;
    if w<=0 or w<>round(w,2) or (w<>(data->>'weight')::numeric and
      ((data->>'conversion')::numeric=1 or abs(w-(data->>'weight')::numeric)>0.02)) then
      raise exception '라벨 중량과 계산 중량이 다릅니다. 원문과 판독형식을 확인해주세요.';
    end if;
    tx:=null;
    if p_mode='inbound' then
      if pack.id is not null then raise exception '이미 등록한 원료육 바코드입니다. 중복 입고하거나 자동 반입하지 않습니다.'; end if;
      linked:=null;
      if coalesce(data->>'gtin','')<>'' then
        select product_id into linked from pda_private.raw_product_links where gtin=data->>'gtin';
        if linked is not null and linked<>p_product_id then raise exception '이 GTIN에 연결된 품목과 선택한 품목이 다릅니다.'; end if;
        insert into pda_private.raw_product_links(gtin,product_id,user_id) values(data->>'gtin',p_product_id,usr) on conflict do nothing;
      end if;
      lot:=nullif(btrim(p_lot),'');
      if lot is null then raise exception '제품 바코드와 별도로 이력번호 바코드를 읽거나 이력번호를 입력해주세요.'; end if;
      snap:=prod||jsonb_build_object('product',prod->>'name','lot',lot,'mfgdate',data->>'mfgdate','expdate',data->>'expdate');
      if coalesce(p_source_id,'')<>'' then
        if src.product<>prod->>'name' or coalesce(src.lot,'')<>lot or coalesce(src.origin,'')<>coalesce(prod->>'origin','')
          or coalesce(src.packunit,'')<>coalesce(prod->>'packunit','') then raise exception '선택한 기존 재고와 품목·이력번호·원산지·포장단위가 다릅니다.'; end if;
        source_id:=p_source_id;cost:=src.price;action:='bind';
        snap:=snap||jsonb_build_object('mfgdate',src.proddate::text,'expdate',src.raw->>'expdate');
        select coalesce(sum(r.weight),0) into held from pda_private.raw_packages r where r.source_id=p_source_id and r.state='in_stock' and r.location=p_location;
        if pda_private.balance(p_source_id,p_location)-held+0.005<w then raise exception '기존 재고의 미연결 잔량이 부족합니다.'; end if;
      else source_id:='stock_raw_'||replace(extensions.gen_random_uuid()::text,'-','');cost:=p_price;action:='receive'; end if;
      price:=cost;
    else
      if pack.id is null then raise exception 'PDA 원료육 입고 또는 기존 재고 연결을 먼저 해주세요.'; end if;
      if pack.state<>'in_stock' then raise exception '이미 출고된 원료육 박스입니다.'; end if;
      if pack.location<>p_location then raise exception '현재 재고 지점은 %입니다.',pack.location; end if;
      if p_date<pack.work_date then raise exception '이전 입출고일보다 빠른 날짜로 처리할 수 없습니다.'; end if;
      if w<>pack.weight then raise exception '입고 확인한 박스 중량과 다릅니다.'; end if;
      source_id:=pack.source_id;snap:=pack.snapshot;lot:=snap->>'lot';action:='ship';
      select t.* into src from public.transactions t where t.deleted_at is null and t.type='입고' and t.raw->>'stockRowId'=source_id;
      if not found then raise exception '연결된 원료육 입고 재고가 없습니다.'; end if;
      if src.date>p_date then raise exception '작업일은 기존 입고일보다 빠를 수 없습니다.'; end if;
      cost:=src.price;
      select p.price into price from public.prices p where p.deleted_at is null and p.product=snap->>'product'
        and coalesce(p.origin,'')=coalesce(snap->>'origin','') and p.trader=partner.name order by p.updated_at desc,p.id limit 1;
      price:=coalesce(price,0);
      select coalesce(sum(r.weight),0) into held from pda_private.raw_packages r where r.source_id=pack.source_id and r.state='in_stock' and r.location=p_location and r.id<>pack.id;
      if pda_private.balance(source_id,p_location)-held+0.005<w then raise exception '원료육 재고가 부족합니다. 수기 출고·사용·이동을 확인해주세요.'; end if;
    end if;
    if pda_private.raw_date(coalesce(data#>>'{fields,11}',data#>>'{fields,13}'))::date>p_date then raise exception '작업일은 제조·포장일보다 빠를 수 없습니다.'; end if;
    if action<>'bind' then
      tx:='tx_raw_'||replace(extensions.gen_random_uuid()::text,'-','');
      raw:=snap||jsonb_build_object('id',tx,'date',p_date,'type',case when action='ship' then '출고' else '입고' end,
        'labelProductId',case when action='ship' then pack.product_id else p_product_id end,
        'proddate',snap->>'mfgdate','weight',w,'boxCount',1,'price',price,'amount',round(w*price),
        'trader',partner.name,'traderId',partner.id,'stockRowId',source_id,'stockLocation',p_location,
        'stockUnitPrice',cost,'stockProddate',snap->>'mfgdate','note',coalesce(p_note,''),'_isUser',true,
        '_pdaRawRequestId',p_request_id,'_pdaRawPackageId',data->>'id','_pdaCode',data->>'code','_pdaAction',action,
        '_barcodeRule',data->>'rule','_barcodeCalculatedWeight',data->'weight',
        '_serverAudit',jsonb_build_object('authMode','personal_session','userId',usr,'displayName',display,'savedAt',clock_timestamp()));
      insert into public.transactions(id,date,type,product,origin,packunit,trader,storage,lot,proddate,weight,price,amount,note,stock_unit_price,stock_proddate,stock_location,raw)
        values(tx,p_date,raw->>'type',snap->>'product',snap->>'origin',snap->>'packunit',partner.name,snap->>'storage',lot,
          public.dbmt_safe_date(snap->>'mfgdate'),w,price,round(w*price),coalesce(p_note,''),cost,public.dbmt_safe_date(snap->>'mfgdate'),p_location,raw);
    end if;
    insert into pda_private.raw_packages(id,barcode,parsed,product_id,snapshot,weight,source_id,state,location,work_date)
      values(data->>'id',data->>'code',data,case when action='ship' then pack.product_id else p_product_id end,snap,w,source_id,
        case when action='ship' then 'shipped' else 'in_stock' end,p_location,p_date)
      on conflict(id) do update set state=excluded.state,work_date=excluded.work_date,revision=pda_private.raw_packages.revision+1,updated_at=clock_timestamp();
    insert into pda_private.raw_events(batch_id,package_id,action,transaction_id,scan) values(p_request_id,data->>'id',action,tx,item||jsonb_build_object('parsed',data));
    results:=results||jsonb_build_array(jsonb_build_object('id',data->>'id','product',snap->>'product','lot',lot,'weight',w,'action',action,'transactionId',tx));
    total:=total+w;
  end loop;
  v_result:=jsonb_build_object('ok',true,'requestId',p_request_id,'count',jsonb_array_length(p_items),'weight',total,'items',results,'savedAt',clock_timestamp());
  update pda_private.raw_batches set result=v_result where id=p_request_id;
  insert into public.change_logs(entity,action,entity_id,summary,payload) values('PDA 원료육',case when p_mode='outbound' then '출고' else '입고' end,
    p_request_id::text,format('%s %s / %s / %s박스 / %sKG',p_date,p_location,coalesce(partner.name,'기존 재고 연결'),jsonb_array_length(p_items),total),
    jsonb_build_object('userId',usr,'displayName',display,'request',req,'result',v_result));
  return v_result;
end;
$$;
