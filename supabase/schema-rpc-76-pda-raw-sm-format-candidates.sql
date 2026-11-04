-- New receipts use explicitly selected, versioned SM formats. Historical parses stay unchanged.
create table if not exists pda_private.raw_sm_formats(
  rule_key text primary key,definition jsonb not null,active boolean not null default true
);
create index if not exists idx_raw_sm_formats_length on pda_private.raw_sm_formats(((definition->>'length')::integer)) where active;
create table if not exists pda_private.raw_sm_links(
  product_id text not null,partner_id uuid not null references public.business_partners(id),
  code_length integer not null,code_prefix text not null,rule_key text not null references pda_private.raw_sm_formats(rule_key),
  user_id uuid not null references public.erp_users(id),updated_at timestamptz not null default now(),
  primary key(product_id,partner_id,code_length,code_prefix)
);
alter table pda_private.raw_sm_formats enable row level security;
alter table pda_private.raw_sm_links enable row level security;
revoke all on pda_private.raw_sm_formats,pda_private.raw_sm_links from public,anon,authenticated;
create index if not exists idx_raw_packages_barcode on pda_private.raw_packages(barcode);
create index if not exists idx_raw_sm_links_partner on pda_private.raw_sm_links(partner_id);
create index if not exists idx_raw_sm_links_rule on pda_private.raw_sm_links(rule_key);
create index if not exists idx_raw_sm_links_user on pda_private.raw_sm_links(user_id);

create or replace function pda_private.raw_sm_code(p_code text)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare v text:=btrim(coalesce(p_code,''),E' \r\n\t');
begin
  if left(v,3) in (']C0',']C1',']d2',']Q3',']I0') then v:=substr(v,4);end if;
  if v ~ '^98[0-9]{20}$' or v ~ '^270601[0-9]{21}$' or v ~ '^DB[0-9]{10}-' then raise exception '제품 바코드는 제품 화면에서 처리해주세요.';end if;
  if v !~ '^[0-9]{8,250}$' then raise exception '비규격 원료육의 숫자형 박스 바코드를 읽어주세요. 이력번호는 별도 입력합니다.';end if;
  return v;
end;
$$;

create or replace function pda_private.raw_sm_parse(p_code text,p_rule text)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v text:=pda_private.raw_sm_code(p_code);d jsonb;source numeric;w numeric;ledger numeric;
  n integer;digits integer;places integer;rd integer;factor numeric;low numeric;high numeric;
begin
  select definition into d from pda_private.raw_sm_formats where rule_key=p_rule;
  if d is null then raise exception '등록된 비규격 판독형식을 선택해주세요.';end if;
  n:=(d->>'start')::integer;digits:=(d->>'digits')::integer;places:=(d->>'decimals')::integer;rd:=(d->>'rounding')::integer;
  factor:=(d->>'factor')::numeric;low:=(d->>'min')::numeric;high:=(d->>'max')::numeric;
  if n<1 or digits<1 or n+digits-1>(d->>'length')::integer or places not between 0 and 6 or rd not between 0 and 6
    or factor<=0 or low<0 or high<low or high>1000 then raise exception '원본 판독조건 확인 필요: 시작위치·자릿수·환산·허용범위를 확인해주세요.';end if;
  if length(v)<>(d->>'length')::integer then raise exception '선택한 비규격 형식의 바코드 길이와 다릅니다.';end if;
  source:=substr(v,n,digits)::numeric/power(10,places);
  w:=round(source*factor,rd);ledger:=round(w,2);
  if w<=0 or w<low or w>high or ledger<=0 or ledger>1000 then raise exception '계산 중량 %KG이 허용범위 %~%KG 밖입니다.',w,low,high;end if;
  return jsonb_build_object('id',encode(extensions.digest('SM:'||v,'sha256'),'hex'),'code',v,'ruleKey',p_rule,
    'rule',format('SM [%s] %s / %s',d->>'manuId',coalesce(nullif(d->>'name',''),d->>'shortName'),d->>'source'),
    'weight',ledger,'calculatedWeight',ledger,'smWeight',w,'sourceWeight',source,'conversion',factor,'requiresReview',true,
    'barcodeLot',null,'gtin',null,'mfgdate',null,'expdate',null,'fields','{}'::jsonb,'smFormat',d);
end;
$$;

create or replace function pda_private.raw_sm_candidates(p_code text,p_source text)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v text:=pda_private.raw_sm_code(p_code);row record;parsed jsonb;reason text;result jsonb:='[]'::jsonb;
begin
  if p_source is null or p_source not in ('동부엠티','동부축산유통','전체') then raise exception '규칙 원본 회사를 선택해주세요.';end if;
  for row in select rule_key,definition from pda_private.raw_sm_formats where active and (definition->>'length')::integer=length(v)
    and (p_source='전체' or definition->>'source'=p_source) order by (definition->>'manuId')::integer,definition->>'source' loop
    parsed:=null;reason:=null;
    begin parsed:=pda_private.raw_sm_parse(v,row.rule_key);exception when others then reason:=sqlerrm;end;
    result:=result||jsonb_build_array(row.definition||jsonb_build_object('key',row.rule_key,'enabled',parsed is not null,
      'weight',parsed->'weight','smWeight',parsed->'smWeight','reason',reason));
  end loop;
  return result;
end;
$$;

create or replace function pda_private.raw_sm_remember(p_user uuid,p_product text,p_partner uuid,p_data jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare v text:=p_data->>'code';
begin
  if left(coalesce(p_data->>'ruleKey',''),7)<>'sm2:v1:' then return;end if;
  if not exists(select 1 from pda_private.raw_sm_formats where rule_key=p_data->>'ruleKey' and active) then raise exception '비활성 판독형식은 신규 입고에 사용할 수 없습니다.';end if;
  if p_partner is null then return;end if;
  insert into pda_private.raw_sm_links(product_id,partner_id,code_length,code_prefix,rule_key,user_id)
    values(p_product,p_partner,length(v),left(v,6),p_data->>'ruleKey',p_user)
    on conflict(product_id,partner_id,code_length,code_prefix) do update set rule_key=excluded.rule_key,user_id=excluded.user_id,updated_at=clock_timestamp();
end;
$$;

create or replace function public.dbmt_pda_raw_resolve(p_token text,p_code text,p_mode text default 'inbound',
  p_product_id text default null,p_trader_id uuid default null,p_rule text default null,p_format text default 'auto',
  p_source text default '동부엠티',p_reselect boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v text;pack pda_private.raw_packages%rowtype;remembered text;result jsonb;
begin
  perform pda_private.authorize(p_token);
  if p_mode is null or p_mode not in ('inbound','outbound') or p_format is null or p_format not in ('auto','gs1','sm') then raise exception '입출고 구분과 판독방식을 확인해주세요.';end if;
  begin v:=pda_private.raw_code(p_code);
  exception when others then
    if p_format='sm' or p_mode='outbound' or left(coalesce(p_rule,''),7)='sm2:v1:' then v:=pda_private.raw_sm_code(p_code);else raise;end if;
  end;
  select * into pack from pda_private.raw_packages where barcode=v;
  if found then return public.dbmt_pda_raw_lookup(p_token,v,pack.parsed->>'ruleKey');end if;
  if p_mode='outbound' then
    result:=public.dbmt_pda_raw_lookup(p_token,p_code,p_rule);
    if result#>>'{item,registered}'='true' then return result;end if;
    raise exception '원료육 입고 또는 기존 재고 연결을 먼저 해주세요.';
  end if;
  if p_format='gs1' or(p_format='auto' and left(v,2) in ('00','01','02')) then
    if left(v,2) not in ('00','01','02') then raise exception '규격 GS1 품목번호·순중량 바코드를 읽어주세요.';end if;
    return public.dbmt_pda_raw_lookup(p_token,v,'gs1');
  end if;
  v:=pda_private.raw_sm_code(v);
  if coalesce(p_rule,'')<>'' then return public.dbmt_pda_raw_lookup(p_token,v,p_rule);end if;
  if not coalesce(p_reselect,false) then
    select l.rule_key into remembered from pda_private.raw_sm_links l join pda_private.raw_sm_formats f on f.rule_key=l.rule_key and f.active
      where l.product_id=p_product_id and l.partner_id=p_trader_id and l.code_length=length(v) and l.code_prefix=left(v,6);
    if remembered is not null then
      begin return public.dbmt_pda_raw_lookup(p_token,v,remembered)||jsonb_build_object('remembered',true);
      exception when others then remembered:=null;end;
    end if;
  end if;
  return jsonb_build_object('ok',true,'needsRule',true,'code',v,'candidates',pda_private.raw_sm_candidates(v,p_source));
end;
$$;
revoke all on function pda_private.raw_sm_code(text),pda_private.raw_sm_parse(text,text),pda_private.raw_sm_candidates(text,text),
  pda_private.raw_sm_remember(uuid,text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.dbmt_pda_raw_resolve(text,text,text,text,uuid,text,text,text,boolean) from public,anon,authenticated;
grant execute on function public.dbmt_pda_raw_resolve(text,text,text,text,uuid,text,text,text,boolean) to anon,authenticated;

create or replace function pda_private.raw_parse(p_code text,p_rule text default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare
  v text; s text; ai text; val text; n integer; lim integer;
  fields jsonb:='{}'::jsonb; r jsonb; w numeric; source numeric; factor numeric:=1;
  rule text; key text; gtin text; barcode_lot text; mfg text; expiry text; review boolean:=false;
  check_sum integer; i integer; weights integer:=0; is_gs boolean;
begin
  if left(coalesce(p_rule,''),7)='sm2:v1:' then return pda_private.raw_sm_parse(p_code,p_rule);end if;
  v:=pda_private.raw_code(p_code);is_gs:=left(v,2) in ('00','01','02');
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
    -- Only these domestic patterns were also checked against supplied photographs.
    if rule is null and v ~ '^076623[0-9]{20}$' then rule:='26|17|4|2|1.00000000|3'; end if;
    if rule is null and v ~ '^076076[0-9]{20}$' then rule:='26|17|4|2|1.00000000|1'; end if;
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
      perform pda_private.raw_sm_remember(usr,p_product_id,case when coalesce(p_source_id,'')='' then p_trader_id else null end,data);
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

notify pgrst,'reload schema';
