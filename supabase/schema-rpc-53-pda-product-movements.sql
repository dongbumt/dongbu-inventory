-- Product-label PDA workflow. No existing stock, print logs or production rows are rewritten.
create schema if not exists pda_private;
revoke all on schema pda_private from public,anon,authenticated;

create table if not exists public.pda_packages (
  label_id text primary key,
  code text not null unique,
  production_id text not null references public.production_entries(id),
  original_stock_row_id text not null,
  source_stock_row_id text not null,
  label_snapshot jsonb not null,
  weight numeric(16,2) not null check(weight>0),
  state text not null check(state in ('in_stock','shipped')),
  location text not null,
  revision integer not null default 1 check(revision>0),
  updated_at timestamptz not null default now()
);
create index if not exists idx_pda_packages_source on public.pda_packages(source_stock_row_id,location) where state='in_stock';
create index if not exists idx_pda_packages_production on public.pda_packages(production_id);
create table if not exists public.pda_batches (
  id uuid primary key,
  user_id uuid not null references public.erp_users(id),
  request jsonb not null,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_pda_batches_user_time on public.pda_batches(user_id,created_at desc);
create table if not exists public.pda_package_events (
  id uuid primary key default extensions.gen_random_uuid(),
  batch_id uuid not null references public.pda_batches(id),
  label_id text not null references public.pda_packages(label_id),
  action text not null check(action in ('receive','ship','return')),
  transaction_id text references public.transactions(id),
  before_state jsonb,
  after_state jsonb not null,
  created_at timestamptz not null default now(),
  unique(batch_id,label_id)
);
create index if not exists idx_pda_events_label on public.pda_package_events(label_id,created_at desc);
create index if not exists idx_pda_events_transaction on public.pda_package_events(transaction_id) where transaction_id is not null;
alter table public.pda_packages enable row level security;
alter table public.pda_batches enable row level security;
alter table public.pda_package_events enable row level security;
revoke all on public.pda_packages,public.pda_batches,public.pda_package_events from public,anon,authenticated;

create or replace function pda_private.authorize(p_token text,p_write boolean default false)
returns uuid language plpgsql security invoker set search_path='' as $$
declare v_user uuid:=public.dbmt_erp_session_user(p_token);
begin
  if v_user is null then raise exception using errcode='28000',message='ERP 사용자 로그인이 만료되었습니다. 다시 로그인해주세요.'; end if;
  if public.dbmt_erp_has_permission(p_token,'transactions','view') is not true
    or public.dbmt_erp_has_permission(p_token,'stock','view') is not true
    or (p_write and public.dbmt_erp_has_permission(p_token,'transactions','create') is not true) then
    raise exception using errcode='42501',message='거래내역 조회·등록 및 재고현황 조회 권한을 확인해주세요.';
  end if;
  return v_user;
end;
$$;

create or replace function pda_private.decode_code(p_code text)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare v_code text:=btrim(coalesce(p_code,''),E' \r\n\t'); v_n bigint; v_hash text:='';
begin
  if left(v_code,3) in (']C0',']C1') then v_code:=substr(v_code,4); end if;
  if v_code ~ '^98[0-9]{20}$' then
    v_n:=right(v_code,10)::bigint;
    if v_n>=2176782336 then raise exception '제품 고유바코드 형식이 올바르지 않습니다.'; end if;
    loop
      v_hash:=substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',(v_n%36)::integer+1,1)||v_hash;
      v_n:=v_n/36;
      exit when v_n=0;
    end loop;
    return 'DB'||substr(v_code,3,10)||'-'||v_hash;
  end if;
  if v_code ~ '^DB[0-9]{10}-[0-9A-Z]{1,6}$' then return v_code; end if;
  raise exception '제품 고유바코드를 읽어주세요. 이력번호나 미등록 원료육 바코드는 입출고할 수 없습니다.';
end;
$$;

create or replace function pda_private.locations()
returns jsonb language sql stable security invoker set search_path='' as $$
  select coalesce(jsonb_agg(name order by name),'[]'::jsonb) from (
    select '가공장'::text name union select '물류창고'
    union select name from public.business_sites where active and inventory_location
    union select nullif(btrim(v),'') from public.transactions t
      cross join lateral unnest(array[t.stock_location,t.from_location,t.to_location]) v
      where t.deleted_at is null
  ) s where name is not null;
$$;

create or replace function pda_private.balance(p_source text,p_location text)
returns numeric language sql stable security invoker set search_path='' as $$
  select coalesce(sum(
    case when t.type in ('입고','생산입고','재고조정') and coalesce(nullif(t.stock_location,''),'가공장')=p_location then t.weight
         when t.type in ('출고','사용') and coalesce(nullif(t.stock_location,''),'가공장')=p_location then -t.weight else 0 end
    + case when t.type='재고이동' then
        case when coalesce(nullif(t.from_location,''),'가공장')=p_location then -t.weight else 0 end
        + case when coalesce(nullif(t.to_location,''),'가공장')=p_location then t.weight else 0 end
      else 0 end
  ),0) from public.transactions t where t.deleted_at is null and t.raw->>'stockRowId'=p_source;
$$;

create or replace function pda_private.resolve(p_code text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_code text:=pda_private.decode_code(p_code); v_log jsonb; v_count integer;
  v_unit public.pda_packages%rowtype; v_production public.production_entries%rowtype;
  v_row jsonb; v_source public.transactions%rowtype; v_snap jsonb; v_source_id text;
begin
  select count(*),jsonb_agg(l)->0 into v_count,v_log from public.app_data a
    cross join lateral jsonb_array_elements(a.payload) l where a.key='labelPrintLogs' and l->>'code'=v_code;
  if v_count=0 then raise exception '등록된 출력이력이 없는 바코드입니다.'; end if;
  if v_count<>1 then raise exception '같은 고유번호의 출력이력이 여러 건입니다. 사무실 확인이 필요합니다.'; end if;
  if coalesce(v_log->>'status','active')='void' or public.dbmt_safe_numeric(v_log->>'labelWeight')<=0 then
    raise exception '삭제되었거나 중량이 없는 라벨입니다.';
  end if;
  if public.dbmt_safe_numeric(v_log->>'labelWeight')<>round(public.dbmt_safe_numeric(v_log->>'labelWeight'),2) then
    raise exception '라벨 중량의 소수 자릿수를 확인해주세요. 소수 둘째 자리까지만 지원합니다.';
  end if;
  select p.* into v_production from public.label_production_completions c
    join public.production_entries p on p.id=c.production_id and p.deleted_at is null
    where c.work_order_id=v_log->>'workOrderId' and c.log_ids ? (v_log->>'id');
  if not found then raise exception '생산완료 전이거나 생산일보가 삭제된 라벨입니다. 먼저 라벨전용에서 생산완료해주세요.'; end if;
  select * into v_unit from public.pda_packages where label_id=v_log->>'id';
  v_snap:=v_log->'workOrderSnapshot';
  if v_unit.label_id is not null and (v_unit.code<>v_code or v_unit.production_id<>v_production.id
      or v_unit.weight<>public.dbmt_safe_numeric(v_log->>'labelWeight') or v_unit.label_snapshot is distinct from v_snap) then
    raise exception '등록 후 라벨의 생산정보가 변경되었습니다. 사무실 확인이 필요합니다.';
  end if;
  select count(*),jsonb_agg(o)->0 into v_count,v_row
    from jsonb_array_elements(v_production.raw->'outputs') o where
      case when v_unit.label_id is not null then o->>'stockRowId'=v_unit.original_stock_row_id else
        o->>'product'=v_snap->>'product'
        and coalesce(o->>'lot','')=coalesce(v_snap->>'lot','')
        and coalesce(o->>'origin','')=coalesce(v_snap->>'origin','')
        and coalesce(o->>'packunit','')=coalesce(v_snap->>'packunit','')
        and public.dbmt_safe_date(o->>'proddate') is not distinct from public.dbmt_safe_date(v_snap->>'mfgdate')
        and (coalesce(v_snap->>'labelProductId','')='' or o->>'labelProductId'=v_snap->>'labelProductId')
        and coalesce(o->>'grade','')=coalesce(v_snap->>'grade','') end;
  if v_count<>1 or coalesce(v_row->>'stockRowId','')='' then
    raise exception '이 라벨과 일치하는 생산품 재고행을 하나로 확인할 수 없습니다. 사무실에서 확인해주세요.';
  end if;
  v_source_id:=coalesce(v_unit.source_stock_row_id,v_row->>'stockRowId');
  select * into v_source from public.transactions where deleted_at is null
    and type in ('입고','생산입고') and raw->>'stockRowId'=v_source_id;
  if not found then raise exception '라벨에 연결된 입고 재고원본이 없습니다.'; end if;
  return jsonb_build_object('labelId',v_log->>'id','code',v_code,'product',v_snap->>'product',
    'lot',v_snap->>'lot','origin',v_snap->>'origin','packunit',v_snap->>'packunit',
    'mfgdate',v_snap->>'mfgdate','expdate',v_snap->>'expdate','storage',v_snap->>'temptype',
    'weight',public.dbmt_safe_numeric(v_log->>'labelWeight'),'registered',v_unit.label_id is not null,
    'state',coalesce(v_unit.state,'in_stock'),'revision',coalesce(v_unit.revision,0),
    'location',coalesce(v_unit.location,nullif(v_source.stock_location,''),'가공장'),
    'stockRowId',v_source_id,'_originalStockRowId',v_row->>'stockRowId',
    '_productionId',v_production.id,'_snapshot',v_snap,'_source',v_source.raw);
end;
$$;

create or replace function public.dbmt_pda_bootstrap(p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform pda_private.authorize(p_token);
  return jsonb_build_object('ok',true,'locations',pda_private.locations(),
    'canSave',public.dbmt_erp_has_permission(p_token,'transactions','create'),
    'partners',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name)
      from public.business_partners where active and trade_type in ('매출','매입/매출')),'[]'::jsonb));
end;
$$;

create or replace function public.dbmt_pda_lookup(p_token text,p_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform pda_private.authorize(p_token);
  return jsonb_build_object('ok',true,'item',pda_private.resolve(p_code)-array['_originalStockRowId','_productionId','_snapshot','_source']);
end;
$$;

create or replace function public.dbmt_pda_commit(p_token text,p_request_id uuid,p_mode text,p_location text,
  p_trader_id uuid,p_date date,p_items jsonb,p_note text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=pda_private.authorize(p_token,true); v_request jsonb; v_previous public.pda_batches%rowtype;
  v_item jsonb; v_data jsonb; v_before jsonb; v_after jsonb; v_unit public.pda_packages%rowtype;
  v_action text; v_tx_id text; v_row jsonb; v_source text; v_cost numeric; v_price numeric;
  v_partner public.business_partners%rowtype; v_remaining numeric; v_reserved numeric;
  v_total numeric:=0; v_received integer:=0; v_returned integer:=0; v_shipped integer:=0;
  v_results jsonb:='[]'::jsonb; v_result jsonb; v_display text;
begin
  if p_request_id is null or p_mode not in ('inbound','outbound') or p_mode is null
    or p_date is null or p_date>(now() at time zone 'Asia/Seoul')::date
    or p_location is null or not(pda_private.locations() ? p_location)
    or length(coalesce(p_note,''))>500 or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception '작업구분·작업일·지점·스캔 목록을 확인해주세요.';
  end if;
  if jsonb_array_length(p_items) not between 1 and 200 then raise exception '한 번에 1~200개 라벨을 처리할 수 있습니다.'; end if;
  if exists(select 1 from jsonb_array_elements(p_items) i where jsonb_typeof(i) is distinct from 'object'
    or coalesce(i->>'barcode','')='' or length(i->>'barcode')>100
    or coalesce(i->>'revision','') !~ '^[0-9]{1,9}$' or jsonb_typeof(i->'revision') is distinct from 'number'
    or i-array['barcode','revision']<>'{}'::jsonb) then raise exception '스캔 목록을 다시 조회해주세요.'; end if;
  if exists(select 1 from jsonb_array_elements(p_items) i group by pda_private.decode_code(i->>'barcode') having count(*)>1) then
    raise exception '같은 제품 고유바코드가 중복되었습니다.';
  end if;
  v_request:=jsonb_build_object('mode',p_mode,'location',p_location,'traderId',p_trader_id,'date',p_date,'items',p_items,'note',coalesce(p_note,''));
  -- Share the ERP stock lock, so different PDAs and ordinary ERP writes cannot oversell a source.
  perform pg_advisory_xact_lock(36100910);
  select * into v_previous from public.pda_batches where id=p_request_id;
  if found then
    if v_previous.user_id<>v_user or v_previous.request<>v_request then raise exception '같은 요청번호로 다른 내용을 저장할 수 없습니다.'; end if;
    return v_previous.result||jsonb_build_object('alreadySaved',true);
  end if;
  if p_mode='outbound' then
    select * into v_partner from public.business_partners where id=p_trader_id and active and trade_type in ('매출','매입/매출');
    if not found then raise exception '매출 또는 매입/매출 거래처를 선택해주세요.'; end if;
  end if;
  select display_name into v_display from public.erp_users where id=v_user;
  insert into public.pda_batches(id,user_id,request) values(p_request_id,v_user,v_request);
  for v_item in select i from jsonb_array_elements(p_items) i loop
    v_data:=pda_private.resolve(v_item->>'barcode');
    if p_date<public.dbmt_safe_date(v_data->>'mfgdate') or exists(
      select 1 from public.pda_package_events e join public.pda_batches b on b.id=e.batch_id
      where e.label_id=v_data->>'labelId' and (b.request->>'date')::date>p_date
    ) then raise exception '작업일은 제조일 및 이전 입출고일보다 빠를 수 없습니다.'; end if;
    if (v_item->>'revision')::integer<>(v_data->>'revision')::integer then
      raise exception '다른 작업자가 처리한 라벨이 있습니다. 목록을 새로 조회해주세요: %',v_data->>'code';
    end if;
    v_before:=null; v_tx_id:=null; v_source:=v_data->>'stockRowId';
    select * into v_unit from public.pda_packages where label_id=v_data->>'labelId';
    if found then v_before:=to_jsonb(v_unit); end if;
    if p_mode='outbound' and v_data->>'state'='shipped' then raise exception '이미 출고된 라벨입니다: %',v_data->>'code'; end if;
    if p_mode='inbound' and v_data->>'state'='in_stock' and (v_data->>'registered')::boolean then
      raise exception '이미 입고 확인된 라벨입니다. 중복 입고하지 않습니다: %',v_data->>'code';
    end if;
    if v_data->>'state'='in_stock' then
      if v_data->>'location'<>p_location then raise exception '현재 재고 지점은 %입니다. 선택 지점을 확인해주세요.',v_data->>'location'; end if;
      v_remaining:=pda_private.balance(v_source,p_location);
      select coalesce(sum(weight),0) into v_reserved from public.pda_packages
        where state='in_stock' and source_stock_row_id=v_source and location=p_location and label_id<>v_data->>'labelId';
      if v_remaining-v_reserved+0.005<(v_data->>'weight')::numeric then
        raise exception '이 라벨에 배정할 재고가 부족합니다. ERP 수기 출고·사용·이동 내역을 확인해주세요: %',v_data->>'product';
      end if;
    end if;
    v_cost:=coalesce(nullif(v_data#>>'{_source,stockUnitPrice}','')::numeric,nullif(v_data#>>'{_source,price}','')::numeric,0);
    if p_mode='outbound' then v_action:='ship';
    elsif v_data->>'state'='shipped' then v_action:='return';
    else v_action:='receive'; end if;
    if v_action<>'receive' then
      v_tx_id:='tx_pda_'||replace(extensions.gen_random_uuid()::text,'-','');
      if v_action='return' then v_source:='stock_pda_'||replace(extensions.gen_random_uuid()::text,'-',''); end if;
      v_price:=v_cost;
      if v_action='ship' then
        select price into v_price from public.prices where deleted_at is null and product=v_data->>'product'
          and coalesce(origin,'')=coalesce(v_data->>'origin','') and trader=v_partner.name order by updated_at desc,id limit 1;
        v_price:=coalesce(v_price,0);
      end if;
      v_row:=(v_data->'_snapshot')||jsonb_build_object('id',v_tx_id,'date',p_date,'type',case when v_action='ship' then '출고' else '입고' end,
        'product',v_data->>'product','lot',v_data->>'lot','origin',v_data->>'origin','packunit',v_data->>'packunit',
        'storage',v_data->>'storage','proddate',v_data->>'mfgdate','weight',(v_data->>'weight')::numeric,
        'boxCount',1,'price',v_price,'amount',round(v_price*(v_data->>'weight')::numeric),
        'trader',case when v_action='ship' then v_partner.name else '제품 반입' end,'traderId',case when v_action='ship' then v_partner.id end,
        'stockRowId',v_source,'stockLocation',p_location,'stockUnitPrice',v_cost,'stockProddate',v_data->>'mfgdate',
        'note',coalesce(p_note,''),'_isUser',true,'_pdaRequestId',p_request_id,'_pdaLabelId',v_data->>'labelId',
        '_pdaCode',v_data->>'code','_pdaAction',v_action,'_serverAudit',jsonb_build_object('authMode','personal_session','userId',v_user,'displayName',v_display,'savedAt',clock_timestamp()));
      insert into public.transactions(id,date,type,product,origin,packunit,trader,storage,lot,proddate,weight,price,amount,note,
        stock_unit_price,stock_proddate,stock_location,raw)
        values(v_tx_id,p_date,v_row->>'type',v_data->>'product',v_data->>'origin',v_data->>'packunit',v_row->>'trader',v_data->>'storage',
          v_data->>'lot',public.dbmt_safe_date(v_data->>'mfgdate'),(v_data->>'weight')::numeric,v_price,
          round(v_price*(v_data->>'weight')::numeric),coalesce(p_note,''),v_cost,public.dbmt_safe_date(v_data->>'mfgdate'),p_location,v_row);
    end if;
    insert into public.pda_packages(label_id,code,production_id,original_stock_row_id,source_stock_row_id,label_snapshot,weight,state,location)
      values(v_data->>'labelId',v_data->>'code',v_data->>'_productionId',v_data->>'_originalStockRowId',v_source,v_data->'_snapshot',
        (v_data->>'weight')::numeric,case when v_action='ship' then 'shipped' else 'in_stock' end,p_location)
      on conflict(label_id) do update set source_stock_row_id=excluded.source_stock_row_id,state=excluded.state,location=excluded.location,
        revision=public.pda_packages.revision+1,updated_at=clock_timestamp() returning to_jsonb(pda_packages.*) into v_after;
    insert into public.pda_package_events(batch_id,label_id,action,transaction_id,before_state,after_state)
      values(p_request_id,v_data->>'labelId',v_action,v_tx_id,v_before,v_after);
    v_received:=v_received+(v_action='receive')::integer; v_returned:=v_returned+(v_action='return')::integer;
    v_shipped:=v_shipped+(v_action='ship')::integer; v_total:=v_total+(v_data->>'weight')::numeric;
    v_results:=v_results||jsonb_build_array((v_data-array['_originalStockRowId','_productionId','_snapshot','_source'])||
      jsonb_build_object('action',v_action,'transactionId',v_tx_id,'revision',v_after->'revision'));
  end loop;
  v_result:=jsonb_build_object('ok',true,'requestId',p_request_id,'count',jsonb_array_length(p_items),'weight',v_total,
    'received',v_received,'returned',v_returned,'shipped',v_shipped,'items',v_results,'savedAt',clock_timestamp());
  update public.pda_batches set result=v_result where id=p_request_id;
  insert into public.change_logs(entity,action,entity_id,summary,payload) values('PDA 입출고',
    case when p_mode='outbound' then '출고' else '입고' end,p_request_id::text,
    format('%s %s / %s / 생산입고 확인 %s개·반입 %s개·출고 %s개 / %sKG',p_date,p_location,coalesce(v_partner.name,''),v_received,v_returned,v_shipped,v_total),
    jsonb_build_object('userId',v_user,'displayName',v_display,'items',v_results,'requestId',p_request_id));
  return v_result;
end;
$$;

create or replace function public.dbmt_pda_history(p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=pda_private.authorize(p_token);
begin
  return jsonb_build_object('ok',true,'rows',coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at desc) from
    (select id,created_at,request-'items' as request,result from public.pda_batches where user_id=v_user order by created_at desc limit 20) s),'[]'::jsonb));
end;
$$;

-- Barcode state must not diverge from inventory through legacy edit/delete screens.
create or replace function pda_private.protect_transaction()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_columns text[]:=array['note','raw','updated_at']; v_fields text[]:=array['note','_serverAudit'];
begin
  if tg_op='INSERT' then
    if new.raw ? '_pdaRequestId' and not exists(select 1 from public.transactions t
        where t.id=new.id and t.raw->>'_pdaRequestId'=new.raw->>'_pdaRequestId')
      and not exists(select 1 from public.pda_batches b where b.id::text=new.raw->>'_pdaRequestId' and b.result='{}'::jsonb) then
      raise exception 'PDA 식별정보는 PDA 전용 저장에서만 등록할 수 있습니다.';
    end if;
    return new;
  end if;
  if tg_op='UPDATE' and old.raw ? '_pdaRequestId' then
    if old.type='출고' then v_columns:=v_columns||array['price','amount']; v_fields:=v_fields||array['price','amount']; end if;
    if (to_jsonb(new)-v_columns) is distinct from (to_jsonb(old)-v_columns)
      or (new.raw-v_fields) is distinct from (old.raw-v_fields) then
      raise exception 'PDA 입출고의 품목·중량·지점·삭제는 일반 거래내역에서 변경할 수 없습니다. 출고 단가 및 비고만 수정할 수 있습니다.';
    end if;
  elsif tg_op='DELETE' and old.raw ? '_pdaRequestId' then raise exception 'PDA 입출고 기록은 삭제할 수 없습니다.';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists trg_pda_transaction_guard on public.transactions;
create trigger trg_pda_transaction_guard before insert or update or delete on public.transactions for each row execute function pda_private.protect_transaction();

create or replace function pda_private.protect_production()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_before jsonb; v_after jsonb;
begin
  if exists(select 1 from public.pda_packages where production_id=old.id) then
    if tg_op='DELETE' then raise exception 'PDA로 처리한 제품이 연결된 생산일보는 삭제할 수 없습니다.'; end if;
    select jsonb_agg(o-array['price','amount','note'] order by o->>'stockRowId') into v_before from jsonb_array_elements(old.raw->'outputs') o;
    select jsonb_agg(o-array['price','amount','note'] order by o->>'stockRowId') into v_after from jsonb_array_elements(new.raw->'outputs') o;
    if new.deleted_at is not null or v_before is distinct from v_after then raise exception 'PDA로 처리한 제품의 생산품목·중량·재고원본은 변경할 수 없습니다.'; end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists trg_pda_production_guard on public.production_entries;
create trigger trg_pda_production_guard before update or delete on public.production_entries for each row execute function pda_private.protect_production();

revoke all on all functions in schema pda_private from public,anon,authenticated;
revoke all on function public.dbmt_pda_bootstrap(text),public.dbmt_pda_lookup(text,text),
  public.dbmt_pda_commit(text,uuid,text,text,uuid,date,jsonb,text),public.dbmt_pda_history(text) from public,anon,authenticated;
grant execute on function public.dbmt_pda_bootstrap(text),public.dbmt_pda_lookup(text,text),
  public.dbmt_pda_commit(text,uuid,text,text,uuid,date,jsonb,text),public.dbmt_pda_history(text) to anon,authenticated;
notify pgrst,'reload schema';
