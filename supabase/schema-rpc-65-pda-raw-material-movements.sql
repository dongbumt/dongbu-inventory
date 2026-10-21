-- Independent raw-material workflow; existing product-label functions stay unchanged.
create table if not exists pda_private.raw_rules (
  rule_key text primary key, definition jsonb not null
);
create table if not exists pda_private.raw_batches (
  id uuid primary key, user_id uuid not null references public.erp_users(id),
  request jsonb not null, result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_pda_raw_batches_user on pda_private.raw_batches(user_id,created_at desc);
create table if not exists pda_private.raw_packages (
  id text primary key, barcode text not null, parsed jsonb not null,
  product_id text not null, snapshot jsonb not null, weight numeric(16,2) not null check(weight>0),
  source_id text not null, state text not null check(state in ('in_stock','shipped')),
  location text not null, work_date date not null, revision integer not null default 1,
  updated_at timestamptz not null default now()
);
create index if not exists idx_pda_raw_packages_source on pda_private.raw_packages(source_id,location);
create table if not exists pda_private.raw_product_links (
  gtin text primary key, product_id text not null,
  user_id uuid not null references public.erp_users(id), created_at timestamptz not null default now()
);
create table if not exists pda_private.raw_events (
  batch_id uuid not null references pda_private.raw_batches(id),
  package_id text not null references pda_private.raw_packages(id), action text not null,
  transaction_id text references public.transactions(id), scan jsonb not null,
  primary key(batch_id,package_id)
);
alter table pda_private.raw_rules enable row level security;
alter table pda_private.raw_batches enable row level security;
alter table pda_private.raw_packages enable row level security;
alter table pda_private.raw_product_links enable row level security;
alter table pda_private.raw_events enable row level security;
revoke all on pda_private.raw_rules,pda_private.raw_batches,pda_private.raw_packages,
  pda_private.raw_product_links,pda_private.raw_events from public,anon,authenticated;

create or replace function pda_private.raw_code(p_code text)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare v text:=btrim(coalesce(p_code,''),E' \r\n\t'); m text[]; out text:='';
begin
  if left(v,3) in (']C0',']C1',']d2',']Q3',']I0') then v:=substr(v,4); end if;
  v:=replace(replace(replace(v,'<GS>',chr(29)),'<FNC1>',chr(29)),'|',chr(29));
  if v ~ '^DB[0-9]{10}-' or v ~ '^98[0-9]{20}$' or v ~ '^270601[0-9]{21}$' then
    raise exception '제품 바코드는 제품 화면에서 처리해주세요.';
  end if;
  if left(v,1)='(' then
    for m in select regexp_matches(v,'\(([0-9]{2,4})\)([^()]*)','g') loop
      out:=out||m[1]||m[2]||chr(29);
    end loop;
    if regexp_replace(v,'\(([0-9]{2,4})\)([^()]*)','','g')<>'' or out='' then raise exception 'GS1 괄호 형식을 확인해주세요.'; end if;
    v:=out;
  end if;
  if length(v) not between 16 and 250 or v ~ '[^ -~\x1d]' then raise exception '원료육 박스 바코드 원문을 확인해주세요.'; end if;
  return v;
end;
$$;

create or replace function pda_private.raw_date(p_value text)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare d date; y integer; m integer; day integer;
begin
  if p_value is null then return null; end if;
  if p_value !~ '^[0-9]{6}$' then raise exception 'GS1 날짜 형식이 올바르지 않습니다.'; end if;
  y:=2000+left(p_value,2)::integer; m:=substr(p_value,3,2)::integer; day:=right(p_value,2)::integer;
  d:=make_date(y,m,1);
  if day=0 then d:=(d+interval '1 month'-interval '1 day')::date; else d:=make_date(y,m,day); end if;
  return d::text;
end;
$$;

create or replace function pda_private.raw_parse(p_code text,p_rule text default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare
  v text:=pda_private.raw_code(p_code); s text; ai text; val text; n integer; lim integer;
  fields jsonb:='{}'::jsonb; r jsonb; w numeric; source numeric; factor numeric:=1;
  rule text; key text; gtin text; barcode_lot text; mfg text; expiry text; review boolean:=false;
  check_sum integer; i integer; weights integer:=0; is_gs boolean:=left(v,2) in ('00','01','02');
begin
  if is_gs then
    if coalesce(p_rule,'') not in ('','gs1') then raise exception 'GS1 바코드는 GS1 자동 판독을 선택해주세요.'; end if;
    s:=v;
    while s<>'' loop
      if left(s,1)=chr(29) then s:=substr(s,2);continue; end if;
      ai:=left(s,2); lim:=null; n:=null;
      if ai='00' then n:=18;
      elsif ai in ('01','02') then n:=14;
      elsif ai in ('11','13','15','16','17') then n:=6;
      elsif ai='20' then n:=2;
      elsif left(s,4) ~ '^(310|320|330)[0-5]$' then ai:=left(s,4);n:=6;
      elsif ai in ('10','21') then lim:=20;
      elsif ai in ('30','37') then lim:=8;
      elsif ai ~ '^9[0-9]$' then lim:=30;
      elsif left(s,3) in ('240','241','250','251') then ai:=left(s,3);lim:=30;
      else raise exception '아직 지원하지 않거나 구분자가 없는 GS1 항목입니다: %',left(s,4); end if;
      s:=substr(s,length(ai)+1);
      if n is not null then
        val:=left(s,n);if length(val)<>n or val !~ '^[0-9]+$' then raise exception 'GS1 고정 항목 길이를 확인해주세요: %',ai; end if;
        s:=substr(s,n+1);
      else
        val:=split_part(s,chr(29),1);
        if length(val) not between 1 and lim then raise exception 'GS1 가변 항목 구분자와 길이를 확인해주세요: %',ai; end if;
        s:=substr(s,length(val)+1);
      end if;
      if fields ? ai then raise exception '중복된 GS1 항목입니다: %',ai; end if;
      fields:=fields||jsonb_build_object(ai,val);
      if ai in ('00','01','02') then
        check_sum:=0;
        for i in 1..length(val)-1 loop check_sum:=check_sum+substr(val,i,1)::integer*case when (length(val)-i)%2=1 then 3 else 1 end; end loop;
        if (10-check_sum%10)%10<>right(val,1)::integer then raise exception 'GTIN/SSCC 체크숫자가 일치하지 않습니다.'; end if;
      end if;
      if left(ai,3) in ('310','320') then
        weights:=weights+1;source:=val::numeric/power(10,right(ai,1)::integer);
        factor:=case when left(ai,3)='320' then 0.45359237 else 1 end;
        w:=round(source*factor,2); rule:='GS1 '||ai; review:=left(ai,3)='320';
      end if;
    end loop;
    if weights<>1 or not(fields ? '01' or fields ? '02') then raise exception 'GS1 품목번호와 순중량(310n/320n)을 하나씩 포함한 박스 바코드가 필요합니다.'; end if;
    gtin:=coalesce(fields->>'01',fields->>'02');barcode_lot:=fields->>'10';
    mfg:=pda_private.raw_date(coalesce(fields->>'11',fields->>'13'));
    expiry:=pda_private.raw_date(coalesce(fields->>'17',fields->>'15'));
    key:=case when fields ? '00' then 'GS1:00:'||(fields->>'00')
      when fields ? '21' then 'GS1:'||gtin||':21:'||(fields->>'21') else 'GS1:'||fields::text end;
  else
    if v !~ '^[0-9]+$' then raise exception '검증된 GS1 또는 숫자형 SM 중량 바코드만 지원합니다.'; end if;
    rule:=nullif(p_rule,'');
    -- Only these two domestic patterns were also checked against supplied photographs.
    if rule is null and v ~ '^076623[0-9]{20}$' then rule:='26|17|4|2|1.00000000|3'; end if;
    if rule is null and v ~ '^2[0-9]{5}122040[0-9]{10}$' then rule:='22|19|4|2|1.00000000|2'; end if;
    select definition into r from pda_private.raw_rules where rule_key=rule;
    if r is null then raise exception '검증된 SM 판독형식을 선택해주세요. 길이만으로 임의 판독하지 않습니다.'; end if;
    n:=(r->>'WgtStartPos')::integer;lim:=(r->>'WgtLength')::integer;
    if n<1 or length(v)<>(r->>'BarcodeLength')::integer or n+lim-1>length(v) then raise exception '선택한 SM 형식과 바코드 길이·중량 위치가 맞지 않습니다.'; end if;
    val:=substr(v,n,lim);factor:=(r->>'ConvFactor')::numeric;
    source:=val::numeric/power(10,(r->>'WgtDecimal')::integer);
    w:=round(round(source*factor,(r->>'WgtDecimal')::integer),2);
    review:=true;key:='SM:'||v;rule:='SM '||rule;
  end if;
  if w is null or w<=0 or w>1000 then raise exception '박스 중량 허용범위(0 초과~1,000KG)를 벗어났습니다.'; end if;
  return jsonb_build_object('id',encode(extensions.digest(key,'sha256'),'hex'),'code',v,'rule',rule,
    'weight',w,'calculatedWeight',w,'sourceWeight',source,'conversion',factor,'requiresReview',review,
    'barcodeLot',barcode_lot,'gtin',gtin,'mfgdate',mfg,'expdate',expiry,'fields',fields,
    'ruleKey',case when is_gs then 'gs1' else substr(rule,4) end);
end;
$$;

create or replace function public.dbmt_pda_raw_bootstrap(p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform pda_private.authorize(p_token);
  return jsonb_build_object('ok',true,'locations',pda_private.locations(),
    'canSave',public.dbmt_erp_has_permission(p_token,'pda','create'),
    'products',coalesce((select jsonb_agg(p order by p->>'name',p->>'productCode') from public.app_data a
      cross join lateral jsonb_array_elements(a.payload) p where a.key='labelProducts'
      and coalesce(p->>'kind','원료육')='원료육' and coalesce(p->>'active','true')<>'false' and coalesce(p->>'isActive','true')<>'false'),'[]'::jsonb),
    'partners',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'tradeType',trade_type) order by name)
      from public.business_partners where active and trade_type in ('매입','매출','매입/매출')),'[]'::jsonb),
    'rules',coalesce((select jsonb_agg(jsonb_build_object('key',rule_key,'label',definition->>'SourceFormats',
      'length',definition->'BarcodeLength') order by (definition->>'TotalMatchCount')::bigint desc)
      from pda_private.raw_rules where (definition->>'WgtStartPos')::integer>0 and (definition->>'BarcodeLength')::integer>=16),'[]'::jsonb));
end;
$$;

create or replace function public.dbmt_pda_raw_lookup(p_token text,p_code text,p_rule text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_parsed jsonb; pack pda_private.raw_packages%rowtype; linked text; selected_rule text:=p_rule;
begin
  perform pda_private.authorize(p_token);
  if coalesce(selected_rule,'')='' then select r.parsed->>'ruleKey' into selected_rule from pda_private.raw_packages r where r.barcode=pda_private.raw_code(p_code); end if;
  v_parsed:=pda_private.raw_parse(p_code,selected_rule);
  select * into pack from pda_private.raw_packages where id=v_parsed->>'id';
  if found then
    if pack.parsed->'fields' is distinct from v_parsed->'fields' or pack.parsed->>'ruleKey' is distinct from v_parsed->>'ruleKey'
      or pack.parsed->'weight' is distinct from v_parsed->'weight' then raise exception '같은 고유번호의 바코드 정보가 등록 후 변경되었습니다. 라벨을 확인해주세요.'; end if;
    return jsonb_build_object('ok',true,'item',v_parsed||pack.snapshot||jsonb_build_object('weight',pack.weight,
      'registered',true,'state',pack.state,'location',pack.location,'revision',pack.revision,'stockRowId',pack.source_id,'productId',pack.product_id));
  end if;
  select product_id into linked from pda_private.raw_product_links where gtin=v_parsed->>'gtin';
  return jsonb_build_object('ok',true,'item',v_parsed||jsonb_build_object('registered',false,'revision',0,'productId',linked));
end;
$$;

create or replace function public.dbmt_pda_raw_sources(p_token text,p_product_id text,p_location text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform pda_private.authorize(p_token);
  return jsonb_build_object('ok',true,'rows',coalesce((select jsonb_agg(s order by s.date desc) from (
    select t.raw->>'stockRowId' as id,t.date,t.lot,t.proddate,t.price,
      pda_private.balance(t.raw->>'stockRowId',p_location)-coalesce((select sum(weight) from pda_private.raw_packages r
        where r.source_id=t.raw->>'stockRowId' and r.state='in_stock' and r.location=p_location),0) as available
    from public.transactions t where t.deleted_at is null and t.type='입고' and t.raw->>'labelProductId'=p_product_id
      and coalesce(t.raw->>'stockRowId','')<>'' and coalesce(nullif(t.stock_location,''),'가공장')=p_location
      and not exists(select 1 from public.pda_packages p where p.source_stock_row_id=t.raw->>'stockRowId')
      and not exists(select 1 from public.transactions u where u.deleted_at is null and u.type in ('출고','사용','재고이동')
        and coalesce(u.raw->>'stockRowId','')='' and u.product=t.product and coalesce(u.lot,'')=coalesce(t.lot,'')
        and (u.date is null or u.date>=t.date))
  ) s where s.available>0),'[]'::jsonb));
end;
$$;

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
      lot:=coalesce(nullif(btrim(p_lot),''),nullif(data->>'barcodeLot',''));
      if lot is null then raise exception '이력번호(LOT)를 입력하거나 별도 이력 바코드를 읽어주세요.'; end if;
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

create or replace function public.dbmt_pda_raw_history(p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare usr uuid:=pda_private.authorize(p_token);
begin
  return jsonb_build_object('ok',true,'rows',coalesce((select jsonb_agg(s order by s.created_at desc) from
    (select id,created_at,request-'items' as request,result from pda_private.raw_batches where user_id=usr order by created_at desc limit 20) s),'[]'::jsonb));
end;
$$;

create or replace function pda_private.protect_raw_stock()
returns trigger language plpgsql security definer set search_path='' as $$
declare before jsonb:='{}'::jsonb; after jsonb:='{}'::jsonb; source text; loc text; reserved numeric; balance numeric;
  exempt text:=''; cols text[]:=array['note','price','amount','raw','updated_at']; fields text[]:=array['note','price','amount','_serverAudit'];
begin
  if tg_op<>'INSERT' then before:=to_jsonb(old); end if;
  if tg_op<>'DELETE' then after:=to_jsonb(new); end if;
  if tg_op='INSERT' and exists(select 1 from public.transactions where id=new.id) then return new; end if;
  if tg_op<>'DELETE' and new.deleted_at is null and new.type in ('출고','사용','재고이동') and coalesce(new.raw->>'stockRowId','')=''
    and exists(select 1 from pda_private.raw_packages p where p.state='in_stock'
      and p.snapshot->>'product'=new.product and coalesce(p.snapshot->>'lot','')=coalesce(new.lot,'')) then
    raise exception 'PDA 원료육은 재고원본을 지정해야 합니다. 해당 박스는 PDA에서 출고해주세요.';
  end if;
  if after#>>'{raw,_pdaRawRequestId}' is not null then
    if tg_op='INSERT' and not exists(select 1 from pda_private.raw_batches where id::text=after#>>'{raw,_pdaRawRequestId}' and result='{}'::jsonb)
      then raise exception '원료육 PDA 식별정보는 전용 저장에서만 등록할 수 있습니다.'; end if;
    exempt:=coalesce(after#>>'{raw,_pdaRawPackageId}','');
  end if;
  if before#>>'{raw,_pdaRawRequestId}' is not null and (tg_op='DELETE' or
    (after-cols) is distinct from (before-cols) or ((after->'raw')-fields) is distinct from ((before->'raw')-fields)) then
    raise exception 'PDA 원료육의 품목·중량·재고 연결·삭제는 일반 거래내역에서 변경할 수 없습니다.';
  end if;
  for source in select distinct v from unnest(array[before#>>'{raw,stockRowId}',after#>>'{raw,stockRowId}']) v where coalesce(v,'')<>'' loop
    perform pg_advisory_xact_lock(36100910);
    if not exists(select 1 from pda_private.raw_packages where source_id=source) then continue; end if;
    if tg_op<>'INSERT' and before->>'type'='입고' and (
      tg_op='DELETE' or after->>'deleted_at' is not null or
      (before-cols) is distinct from (after-cols) or
      ((before->'raw')-array['note','price','amount','_serverAudit','stockNote']) is distinct from
      ((after->'raw')-array['note','price','amount','_serverAudit','stockNote'])) then
      raise exception 'PDA 원료육 박스에 연결된 입고 재고원본은 단가·비고 외에는 수정하거나 삭제할 수 없습니다.';
    end if;
    for loc in select distinct coalesce(nullif(v,''),'가공장') from unnest(array[before->>'stock_location',after->>'stock_location',before->>'from_location',after->>'from_location',before->>'to_location',after->>'to_location']) v loop
      balance:=pda_private.balance(source,loc)
        -case when before#>>'{raw,stockRowId}'=source then pda_private.movement_delta(before,loc) else 0 end
        +case when after#>>'{raw,stockRowId}'=source then pda_private.movement_delta(after,loc) else 0 end;
      select coalesce(sum(weight),0) into reserved from pda_private.raw_packages where source_id=source and state='in_stock' and location=loc and id<>exempt;
      if balance+0.005<reserved then raise exception 'PDA 원료육 박스 몫을 차감하거나 재고를 음수로 만들 수 없습니다. 해당 박스는 PDA에서 출고해주세요.'; end if;
    end loop;
  end loop;
  if tg_op='DELETE' then return old; end if;return new;
end;
$$;
drop trigger if exists trg_pda_raw_stock_guard on public.transactions;
create trigger trg_pda_raw_stock_guard before insert or update or delete on public.transactions
  for each row execute function pda_private.protect_raw_stock();

revoke all on function pda_private.raw_code(text),pda_private.raw_date(text),pda_private.raw_parse(text,text),pda_private.protect_raw_stock() from public,anon,authenticated;
revoke all on function public.dbmt_pda_raw_bootstrap(text),public.dbmt_pda_raw_lookup(text,text,text),
  public.dbmt_pda_raw_sources(text,text,text),public.dbmt_pda_raw_commit(text,uuid,text,text,uuid,date,jsonb,text,text,text,numeric,text),
  public.dbmt_pda_raw_history(text) from public,anon,authenticated;
grant execute on function public.dbmt_pda_raw_bootstrap(text),public.dbmt_pda_raw_lookup(text,text,text),
  public.dbmt_pda_raw_sources(text,text,text),public.dbmt_pda_raw_commit(text,uuid,text,text,uuid,date,jsonb,text,text,text,numeric,text),
  public.dbmt_pda_raw_history(text) to anon,authenticated;
notify pgrst,'reload schema';
