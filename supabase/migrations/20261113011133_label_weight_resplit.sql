-- Repack physical stock; never rewrite the issued production labels or manufacture more stock.
create table pda_private.weight_splits(
  id uuid primary key,parent_label_id text not null unique references public.pda_packages(label_id),
  root_label_id text not null references public.pda_packages(label_id),
  user_id uuid references public.erp_users(id),auth_mode text not null,
  request jsonb not null,result jsonb not null default '{}',created_at timestamptz not null default clock_timestamp()
);
create index weight_splits_root on pda_private.weight_splits(root_label_id);
create index weight_splits_user on pda_private.weight_splits(user_id);
create table pda_private.weight_split_labels(
  label_id text primary key references public.pda_packages(label_id),
  split_id uuid not null references pda_private.weight_splits(id),
  code text not null unique,print_code text not null unique,log jsonb not null
);
create index weight_split_labels_request on pda_private.weight_split_labels(split_id);
create index weight_split_labels_suffix on pda_private.weight_split_labels(reverse(print_code) text_pattern_ops);
create table pda_private.weight_split_context(transaction_id bigint primary key,split_id uuid not null);
alter table pda_private.weight_splits enable row level security;
alter table pda_private.weight_split_labels enable row level security;
alter table pda_private.weight_split_context enable row level security;
revoke all on pda_private.weight_splits,pda_private.weight_split_labels,pda_private.weight_split_context from public,anon,authenticated;
alter table public.pda_packages drop constraint pda_packages_state_check;
alter table public.pda_packages add constraint pda_packages_state_check check(state in ('in_stock','shipped','split'));

create function pda_private.weight_split_auth(p_pin text,p_token text,p_write boolean default false)
returns uuid language plpgsql security invoker set search_path='' as $$
declare actor uuid;
begin
  if coalesce(p_token,'')<>'' then
    actor:=public.dbmt_erp_session_user(p_token);
    if actor is null then raise exception using errcode='28000',message='ERP 사용자 로그인이 만료되었습니다.';end if;
    if public.dbmt_erp_has_permission(p_token,'label','view') is not true or(p_write and(
      public.dbmt_erp_has_permission(p_token,'label','create') is not true or public.dbmt_erp_has_permission(p_token,'label','update') is not true)) then
      raise exception using errcode='42501',message='라벨 조회·등록·수정 권한을 확인해주세요.';end if;
  elsif public.dbmt_check_label_print_pin(p_pin) is not true then
    raise exception using errcode='28000',message='라벨전용 PIN이 맞지 않습니다.';
  end if;
  return actor;
end;
$$;

create function pda_private.print_code(p_code text)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare code text:=pda_private.decode_code(p_code);n bigint:=0;i integer;
begin
  for i in 14..length(code) loop n:=n*36+strpos('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',substr(code,i,1))-1;end loop;
  return '98'||substr(code,3,10)||lpad(n::text,10,'0');
end;
$$;

-- Intercept only derived labels and retired parents; every ordinary PDA path stays intact.
do $$ declare d text;begin
  select pg_get_functiondef('pda_private.resolve(text)'::regprocedure) into d;
  execute replace(d,'FUNCTION pda_private.resolve(','FUNCTION pda_private.resolve_before_weight_split(');
end $$;
create or replace function pda_private.resolve(p_code text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_code text:=pda_private.decode_code(p_code);p public.pda_packages%rowtype;l jsonb;src public.transactions%rowtype;
  child pda_private.weight_split_labels%rowtype;
begin
  if exists(select 1 from public.pda_packages u join pda_private.weight_splits s on s.parent_label_id=u.label_id where u.code=v_code) then
    raise exception '중량분할 완료된 원본 바코드입니다. 분할된 새 라벨을 사용해주세요.';end if;
  select * into child from pda_private.weight_split_labels where weight_split_labels.code=v_code;
  if not found then return pda_private.resolve_before_weight_split(p_code);end if;
  select * into p from public.pda_packages where label_id=child.label_id;
  if p.state not in ('in_stock','shipped') then raise exception '사용할 수 없는 분할 라벨입니다.';end if;
  if not exists(select 1 from public.production_entries e cross join lateral jsonb_array_elements(e.raw->'outputs') o
    where e.id=p.production_id and e.deleted_at is null and o->>'stockRowId'=p.original_stock_row_id) then
    raise exception '분할 라벨의 원본 생산 연결을 확인할 수 없습니다.';end if;
  select * into src from public.transactions where deleted_at is null and type in ('입고','생산입고') and raw->>'stockRowId'=p.source_stock_row_id;
  if not found then raise exception '분할 라벨의 입고 재고원본이 없습니다.';end if;
  l:=p.label_snapshot;
  return jsonb_build_object('labelId',p.label_id,'code',v_code,'product',l->>'product','lot',l->>'lot','origin',l->>'origin',
    'packunit',l->>'packunit','mfgdate',l->>'mfgdate','expdate',l->>'expdate','storage',l->>'temptype',
    'weight',p.weight,'registered',true,'state',p.state,'revision',p.revision,'location',p.location,
    'stockRowId',p.source_stock_row_id,'_originalStockRowId',p.original_stock_row_id,'_productionId',p.production_id,
    '_snapshot',l,'_source',src.raw,'productionPending',false,'costStatus','final',
    'productionCost',coalesce(src.stock_unit_price,src.price,0),
    'splitDate',(select (s.created_at at time zone 'Asia/Seoul')::date from pda_private.weight_splits s where s.id=child.split_id));
end;
$$;

create function pda_private.weight_split_stock(p_code text,p_location text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare d jsonb;held numeric;unbound numeric:=0;r record;u jsonb;log jsonb;
begin
  d:=pda_private.resolve(p_code);
  if d->>'state'<>'in_stock' or d->>'productionPending'='true' or d->>'location'<>p_location then
    raise exception '해당 지점의 생산완료된 재고 라벨만 분할할 수 있습니다.';end if;
  if public.dbmt_safe_date(d->>'mfgdate')>(now() at time zone 'Asia/Seoul')::date
    or public.dbmt_safe_date(d#>>'{_source,date}')>(now() at time zone 'Asia/Seoul')::date then
    raise exception '미래 일자의 생산·입고 라벨은 아직 분할할 수 없습니다.';end if;
  select coalesce(sum(weight),0) into held from public.pda_packages where source_stock_row_id=d->>'stockRowId' and state='in_stock' and location=p_location;
  if d->>'registered'='false' then
    -- If an untracked manual movement depleted this source, do not guess which printed box remains.
    for r in select a.label,a.stock_row_id from label_stock_private.assignments(d->>'_productionId') a
      where a.problem is null and a.stock_row_id=d->>'stockRowId'
        and not exists(select 1 from public.pda_packages p where p.label_id=a.label->>'id') loop
      unbound:=unbound+public.dbmt_safe_numeric(r.label->>'labelWeight');
    end loop;
  end if;
  if pda_private.balance(d->>'stockRowId',p_location)+0.005<held+unbound then
    raise exception '재고 잔량과 미확인 라벨 중량이 달라 분할할 수 없습니다. PDA 입고 연결·수기 사용 내역을 확인해주세요.';end if;
  select c.log into log from pda_private.weight_split_labels c where c.label_id=d->>'labelId';
  if log is null then select e into log from public.app_data a cross join lateral jsonb_array_elements(a.payload) e
    where a.key='labelPrintLogs' and e->>'id'=d->>'labelId';end if;
  if coalesce(log->>'sizeKey',log#>>'{workOrderSnapshot,labelSize}','7x10') not in ('7x10','10x10') then
    raise exception '기존 라벨의 출력 크기를 확인해주세요.';end if;
  return d||jsonb_build_object('log',log);
end;
$$;

create function public.dbmt_label_weight_search(p_pin text,p_token text,p_query text,p_location text default '가공장',p_product text default '',p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=pda_private.weight_split_auth(p_pin,p_token);q text:=btrim(coalesce(p_query,''));full_code text;
  r record;d jsonb;rows jsonb:='[]';page jsonb;
begin
  if p_offset is null or p_offset<0 or p_offset>100000 or length(coalesce(p_product,''))>100 or length(q)>100
    or p_location is null or not(pda_private.locations() ? p_location) then raise exception '조회 지점과 검색조건을 확인해주세요.';end if;
  if q='' then return jsonb_build_object('ok',true,'locations',pda_private.locations(),'rows','[]'::jsonb,'count',0);end if;
  if q ~ '^(98[0-9]{20}|DB[0-9]{10}-[0-9A-Z]{1,6}|\]C[01].+)$' then full_code:=pda_private.decode_code(q);
  elsif q !~ '^[0-9]{6,21}$' then raise exception '바코드 끝 6자리 이상 또는 전체 제품 바코드를 입력해주세요.';end if;
  for r in
    with codes as (
      select e->>'code' code from public.app_data a cross join lateral jsonb_array_elements(a.payload) e
        join public.label_production_completions c on c.work_order_id=e->>'workOrderId' and c.log_ids ? (e->>'id')
        join public.production_entries p on p.id=c.production_id and p.deleted_at is null
        where a.key='labelPrintLogs' and coalesce(e->>'status','active')<>'void' and e->>'code' ~ '^DB[0-9]{10}-[0-9A-Z]{1,6}$'
          and (coalesce(p_product,'')='' or strpos(lower(e#>>'{workOrderSnapshot,product}'),lower(p_product))>0)
      union all select l.code from pda_private.weight_split_labels l join public.pda_packages p on p.label_id=l.label_id
        where p.state='in_stock' and p.location=p_location and(coalesce(p_product,'')='' or strpos(lower(p.label_snapshot->>'product'),lower(p_product))>0)
    ) select distinct code from codes where case when full_code is not null then code=full_code
      else right(pda_private.print_code(code),length(q))=q end order by code desc
  loop
    begin
      d:=pda_private.weight_split_stock(r.code,p_location);
      rows:=rows||jsonb_build_array((d-array['_source','_snapshot'])||jsonb_build_object('printCode',pda_private.print_code(r.code)));
    exception when raise_exception then continue;end;
  end loop;
  select coalesce(jsonb_agg(e order by n),'[]') into page from jsonb_array_elements(rows) with ordinality a(e,n) where n>p_offset and n<=p_offset+50;
  return jsonb_build_object('ok',true,'locations',pda_private.locations(),'rows',page,'count',jsonb_array_length(rows));
end;
$$;

create function public.dbmt_label_weight_split(p_pin text,p_token text,p_request_id uuid,p_code text,p_revision integer,p_location text,p_weights jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=pda_private.weight_split_auth(p_pin,p_token,true);code text:=pda_private.decode_code(p_code);
  req jsonb;previous pda_private.weight_splits%rowtype;d jsonb;root text;parent text;id text;child_code text;digits text;
  w numeric;total numeric;log jsonb;logs jsonb:='[]';row jsonb;tx text;cost numeric;today date:=(now() at time zone 'Asia/Seoul')::date;
begin
  if p_request_id is null or p_revision is null or p_revision<0 or jsonb_typeof(p_weights) is distinct from 'array'
    or p_location is null or not(pda_private.locations() ? p_location) then raise exception '분할 대상·지점·중량을 확인해주세요.';end if;
  if jsonb_array_length(p_weights) not between 2 and 50 or exists(select 1 from jsonb_array_elements(p_weights) e
    where jsonb_typeof(e) is distinct from 'number' or (e#>>'{}')::numeric<=0 or (e#>>'{}')::numeric>100000
      or (e#>>'{}')::numeric<>round((e#>>'{}')::numeric,2)) then raise exception '분할 중량은 2~50개, 0 초과 소수 둘째 자리까지 입력해주세요.';end if;
  req:=jsonb_build_object('code',code,'revision',p_revision,'location',p_location,'weights',p_weights);
  perform pg_advisory_xact_lock(36100910);
  select * into previous from pda_private.weight_splits where weight_splits.id=p_request_id;
  if found then
    if previous.request<>req or previous.user_id is distinct from actor or previous.auth_mode<>(case when actor is null then 'label_pin' else 'personal_session' end) then
      raise exception '같은 요청번호로 다른 분할을 저장할 수 없습니다.';end if;
    return previous.result||jsonb_build_object('alreadySaved',true);
  end if;
  d:=pda_private.weight_split_stock(code,p_location);
  if (d->>'revision')::integer<>p_revision then raise exception '다른 작업자가 처리한 라벨입니다. 다시 조회해주세요.';end if;
  select sum((e#>>'{}')::numeric) into total from jsonb_array_elements(p_weights) e;
  if total<>(d->>'weight')::numeric then raise exception '분할 합계 %KG가 원본 %KG와 다릅니다.',total,d->>'weight';end if;
  parent:=d->>'labelId';
  select s.root_label_id into root from pda_private.weight_split_labels l join pda_private.weight_splits s on s.id=l.split_id where l.label_id=parent;
  root:=coalesce(root,parent);
  insert into public.pda_packages(label_id,code,production_id,original_stock_row_id,source_stock_row_id,label_snapshot,weight,state,location)
    values(parent,code,d->>'_productionId',d->>'_originalStockRowId',d->>'stockRowId',d->'_snapshot',(d->>'weight')::numeric,'in_stock',p_location) on conflict do nothing;
  insert into pda_private.weight_splits(id,parent_label_id,root_label_id,user_id,auth_mode,request)
    values(p_request_id,parent,root,actor,case when actor is null then 'label_pin' else 'personal_session' end,req);
  update public.pda_packages set state='split',revision=revision+1,updated_at=clock_timestamp() where label_id=parent;
  for w in select (e#>>'{}')::numeric from jsonb_array_elements(p_weights) e loop
    id:='lws_'||replace(extensions.gen_random_uuid()::text,'-','');
    loop
      digits:=substr(encode(extensions.gen_random_bytes(4),'hex'),1,6);child_code:='DB'||to_char(now() at time zone 'Asia/Seoul','YYMMDDHH24MI')||'-'||upper(digits);
      if left(digits,1)='0' then continue;end if;
      exit when not exists(select 1 from public.pda_packages p where p.code=child_code)
        and not exists(select 1 from public.app_data a cross join lateral jsonb_array_elements(a.payload) e where a.key='labelPrintLogs' and e->>'code'=child_code);
    end loop;
    -- Preserve the exact snapshot, including the original manufacturing/expiry dates, LOT and packaging.
    log:=(d->'log')||jsonb_build_object('id',id,'code',child_code,'labelWeight',w,'weightOmitted',false,'status','active',
      'batchId',p_request_id,'printedAt',clock_timestamp(),'reprintCount',0,'splitParentId',parent,'splitRootId',root);
    insert into public.pda_packages(label_id,code,production_id,original_stock_row_id,source_stock_row_id,label_snapshot,weight,state,location)
      values(id,child_code,d->>'_productionId',d->>'_originalStockRowId',d->>'stockRowId',d->'_snapshot',w,'in_stock',p_location);
    insert into pda_private.weight_split_labels values(id,p_request_id,child_code,pda_private.print_code(child_code),log);
    logs:=logs||jsonb_build_array(log);
  end loop;
  -- Zero KG: only the number of physical boxes changes. The production journal stays immutable.
  cost:=coalesce((d#>>'{_source,stockUnitPrice}')::numeric,(d#>>'{_source,price}')::numeric,0);
  tx:='tx_label_split_'||replace(p_request_id::text,'-','');
  row:=(d->'_snapshot')||jsonb_build_object('id',tx,'date',today,'type','재고조정','product',d->>'product','lot',d->>'lot',
    'origin',d->>'origin','packunit',d->>'packunit','proddate',d->>'mfgdate','storage',d->>'storage',
    'weight',0,'boxCount',jsonb_array_length(p_weights)-1,'price',cost,'amount',0,'stockUnitPrice',cost,'stockProddate',d->>'mfgdate',
    'stockRowId',d->>'stockRowId','stockLocation',p_location,'note','라벨 중량분할 · 박스수 조정','_labelWeightSplitId',p_request_id,
    'productionCost',cost,'productionCostAmount',0,'_productionCostStatus','final','_productionCostProductionId',d->>'_productionId',
    '_productionCostSourceId',d->>'_originalStockRowId','_pdaProvisional',false,'_isUser',false);
  insert into pda_private.weight_split_context values(txid_current(),p_request_id);
  insert into public.transactions(id,date,type,product,origin,packunit,storage,lot,proddate,weight,price,amount,note,stock_unit_price,stock_proddate,stock_location,raw)
    values(tx,today,'재고조정',d->>'product',d->>'origin',d->>'packunit',d->>'storage',d->>'lot',public.dbmt_safe_date(d->>'mfgdate'),0,cost,0,row->>'note',cost,public.dbmt_safe_date(d->>'mfgdate'),p_location,row);
  delete from pda_private.weight_split_context where transaction_id=txid_current();
  row:=jsonb_build_object('ok',true,'requestId',p_request_id,'parentId',parent,'rootId',root,'parentCode',code,'weight',total,
    'location',p_location,'labels',logs,'transaction',row,'savedAt',clock_timestamp());
  update pda_private.weight_splits s set result=row where s.id=p_request_id;
  insert into public.change_logs(entity,action,entity_id,summary,payload) values('라벨 중량분할','분할',parent,
    format('%s %s / 이력번호 %s / %sKG → %s박스 / %s',today,d->>'product',d->>'lot',total,jsonb_array_length(p_weights),p_location),
    jsonb_build_object('userId',actor,'authMode',case when actor is null then 'label_pin' else 'personal_session' end,'request',req,'result',row));
  return row;
end;
$$;

create function public.dbmt_label_weight_history(p_pin text,p_token text,p_request_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=pda_private.weight_split_auth(p_pin,p_token);
begin
  return jsonb_build_object('ok',true,'rows',coalesce((select jsonb_agg(r order by r.created_at desc) from(
    select s.id,s.created_at,s.result-'labels'-'transaction' as result,coalesce((select jsonb_agg(l.log order by l.label_id)
      from pda_private.weight_split_labels l join public.pda_packages p on p.label_id=l.label_id
      where l.split_id=s.id and p.state='in_stock'),'[]') as labels
    from pda_private.weight_splits s where p_request_id is null or s.id=p_request_id order by s.created_at desc limit 30) r),'[]'));
end;
$$;

create function pda_private.protect_weight_split_posting()
returns trigger language plpgsql security definer set search_path='' as $$
declare cols text[]:=array['price','amount','stock_unit_price','raw','updated_at'];
  fields text[]:=array['price','amount','stockUnitPrice','productionCost','productionCostAmount','_productionCostStatus','_productionCostProductionId','_productionCostSourceId','_productionCostUpdatedAt','_pdaProvisional'];
begin
  if tg_op='INSERT' then
    if new.raw ? '_labelWeightSplitId' and not exists(select 1 from pda_private.weight_split_context c
      where c.transaction_id=txid_current() and c.split_id::text=new.raw->>'_labelWeightSplitId') then raise exception '라벨 분할 박스수는 분할 화면에서만 생성할 수 있습니다.';end if;
    return new;
  end if;
  if old.raw ? '_labelWeightSplitId' then
    if tg_op='UPDATE' and exists(select 1 from pda_private.product_cost_context c where c.transaction_id=txid_current()
      and c.production_id=old.raw->>'_productionCostProductionId') and(to_jsonb(new)-cols)=(to_jsonb(old)-cols)
      and(new.raw-fields)=(old.raw-fields) then return new;end if;
    raise exception '라벨 분할 박스수 조정은 거래내역에서 수정·삭제할 수 없습니다.';
  end if;
  if tg_op='UPDATE' and new.raw ? '_labelWeightSplitId' then raise exception '분할 식별정보는 변경할 수 없습니다.';end if;
  if tg_op='DELETE' then return old;end if;return new;
end;
$$;
create trigger trg_label_weight_posting before insert or update or delete on public.transactions for each row execute function pda_private.protect_weight_split_posting();

create function pda_private.protect_weight_split_logs()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from jsonb_array_elements(new.payload) e join pda_private.weight_split_labels l on l.code=e->>'code') then
    raise exception '분할 라벨의 고유번호는 일반 출력이력에 중복 등록할 수 없습니다.';end if;
  if exists(with incoming as materialized(select e from jsonb_array_elements(new.payload) e),
    prior as materialized(select e from jsonb_array_elements(old.payload) e)
    select 1 from pda_private.weight_splits s join prior p on p.e->>'id'=s.parent_label_id
      left join incoming n on n.e->>'id'=s.parent_label_id where n.e is distinct from p.e) then
    raise exception '중량분할 완료된 원본 라벨은 변경·재출력할 수 없습니다. 중량분할 이력에서 재고 라벨을 인쇄해주세요.';end if;
  return new;
end;
$$;
create trigger trg_label_weight_logs before update of payload on public.app_data for each row when(old.key='labelPrintLogs') execute function pda_private.protect_weight_split_logs();

do $patch$
declare d text;a text;b text;
begin
  select replace(pg_get_functiondef('public.dbmt_label_print_save_logs(text,jsonb)'::regprocedure),E'\r\n',E'\n') into d;
  a:='if v_old is null then';
  b:=$body$if exists(select 1 from pda_private.weight_splits s where s.parent_label_id=v_new->>'id')
      and coalesce(public.dbmt_safe_numeric(v_new->>'reprintCount'),0)>coalesce(public.dbmt_safe_numeric(v_old->>'reprintCount'),0) then
      raise exception '중량분할 완료된 원본 라벨은 재출력할 수 없습니다. 중량분할 이력을 사용해주세요.';end if;
    if v_old is null then$body$;
  if position(a in d)=0 then raise exception 'Unexpected label reprint merge';end if;execute replace(d,a,b);
  select replace(pg_get_functiondef('pda_private.sync_product_costs(text)'::regprocedure),E'\r\n',E'\n') into d;
  a:='and t.type in (''출고'',''입고'',''생산입고'',''재고이동'')';b:='and t.type in (''출고'',''입고'',''생산입고'',''재고이동'',''재고조정'')';
  if position(a in d)=0 then raise exception 'Unexpected product cost linkage';end if;execute replace(d,a,b);
  select replace(pg_get_functiondef('public.dbmt_pda_commit(text,uuid,text,text,uuid,date,jsonb,text)'::regprocedure),E'\r\n',E'\n') into d;
  a:='v_data:=pda_private.resolve(v_item->>''barcode'');';
  b:=a||E'\n    if p_date<public.dbmt_safe_date(v_data->>''splitDate'') then raise exception ''작업일은 라벨 분할일보다 빠를 수 없습니다.'';end if;';
  if position(a in d)=0 then raise exception 'Unexpected PDA resolution';end if;execute replace(d,a,b);
end $patch$;
revoke all on function pda_private.weight_split_auth(text,text,boolean),pda_private.print_code(text),pda_private.resolve_before_weight_split(text),
  pda_private.resolve(text),pda_private.weight_split_stock(text,text),pda_private.protect_weight_split_posting(),pda_private.protect_weight_split_logs() from public,anon,authenticated;
revoke all on function public.dbmt_label_weight_search(text,text,text,text,text,integer),public.dbmt_label_weight_split(text,text,uuid,text,integer,text,jsonb),
  public.dbmt_label_weight_history(text,text,uuid) from public,anon,authenticated;
grant execute on function public.dbmt_label_weight_search(text,text,text,text,text,integer),public.dbmt_label_weight_split(text,text,uuid,text,integer,text,jsonb),
  public.dbmt_label_weight_history(text,text,uuid) to anon,authenticated;
notify pgrst,'reload schema';
