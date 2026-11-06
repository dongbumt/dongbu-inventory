-- Pending physical shipments do not manufacture a production journal or a zero cost.
alter table public.pda_packages alter column production_id drop not null;
create index if not exists idx_transactions_pda_label on public.transactions((raw->>'_pdaLabelId')) where raw ? '_pdaLabelId';
create index if not exists idx_transactions_production_cost on public.transactions((raw->>'_productionCostProductionId')) where deleted_at is null;
create table if not exists pda_private.pending_product_labels(
  label_id text primary key references public.pda_packages(label_id),work_order_id text not null,
  original_source text not null,production_id text references public.production_entries(id),resolved_at timestamptz
);
create index if not exists idx_pending_product_order on pda_private.pending_product_labels(work_order_id) where resolved_at is null;
create index if not exists idx_pending_product_production on pda_private.pending_product_labels(production_id);
-- A private, transaction-scoped capability, never a client-set session variable.
create table if not exists pda_private.product_cost_context(
  transaction_id bigint primary key,production_id text not null,mode text not null check(mode in ('completion','edit')),actor uuid
);
alter table pda_private.pending_product_labels enable row level security;
alter table pda_private.product_cost_context enable row level security;
revoke all on pda_private.pending_product_labels,pda_private.product_cost_context from public,anon,authenticated;

do $$ begin
  if to_regprocedure('pda_private.resolve_completed(text)') is null then alter function pda_private.resolve(text) rename to resolve_completed;end if;
  if to_regprocedure('public.dbmt_label_complete_production_before_pda_cost(text,text,jsonb,jsonb)') is null then
    alter function public.dbmt_label_complete_production_reviewed(text,text,jsonb,jsonb) rename to dbmt_label_complete_production_before_pda_cost;
  end if;
  if to_regprocedure('public.dbmt_erp_save_production_before_pda_cost(text,jsonb,jsonb,text)') is null then
    alter function public.dbmt_erp_save_production(text,jsonb,jsonb,text) rename to dbmt_erp_save_production_before_pda_cost;
  end if;
end $$;

create or replace function pda_private.resolve(p_code text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare code text:=pda_private.decode_code(p_code);log jsonb;pack public.pda_packages%rowtype;snap jsonb;data jsonb;n integer;
begin
  select count(*),jsonb_agg(e)->0 into n,log from public.app_data a cross join lateral jsonb_array_elements(a.payload) e
    where a.key='labelPrintLogs' and e->>'code'=code;
  if n=0 then raise exception '등록된 출력이력이 없는 바코드입니다.';end if;
  if n<>1 then raise exception '같은 고유번호의 출력이력이 여러 건입니다.';end if;
  select * into pack from public.pda_packages where label_id=log->>'id';
  if exists(select 1 from public.label_production_completions where work_order_id=log->>'workOrderId') or pack.production_id is not null then
    data:=pda_private.resolve_completed(p_code);
    return data||jsonb_build_object('productionPending',false,'productionCost',coalesce(nullif(data#>>'{_source,stockUnitPrice}','')::numeric,nullif(data#>>'{_source,price}','')::numeric,0),'costStatus','final');
  end if;
  snap:=log->'workOrderSnapshot';
  if coalesce(log->>'status','active')='void' or public.dbmt_safe_numeric(log->>'labelWeight')<=0
    or public.dbmt_safe_numeric(log->>'labelWeight')<>round(public.dbmt_safe_numeric(log->>'labelWeight'),2) then raise exception '삭제되었거나 중량이 올바르지 않은 라벨입니다.';end if;
  if not exists(select 1 from public.app_data a cross join lateral jsonb_array_elements(a.payload) e
    where a.key='workOrders' and e->>'id'=log->>'workOrderId') then raise exception '생산완료 전 작업지시를 확인할 수 없습니다.';end if;
  if coalesce(snap->>'product','')='' or coalesce(snap->>'lot','')='' or public.dbmt_safe_date(snap->>'mfgdate') is null then raise exception '라벨의 품목·이력번호·제조일을 확인해주세요.';end if;
  if pack.label_id is not null and(pack.code<>code or pack.weight<>public.dbmt_safe_numeric(log->>'labelWeight') or pack.label_snapshot is distinct from snap) then raise exception '등록 후 라벨의 생산정보가 변경되었습니다.';end if;
  return jsonb_build_object('labelId',log->>'id','code',code,'product',snap->>'product','lot',snap->>'lot','origin',snap->>'origin',
    'packunit',snap->>'packunit','mfgdate',snap->>'mfgdate','expdate',snap->>'expdate','storage',snap->>'temptype',
    'weight',public.dbmt_safe_numeric(log->>'labelWeight'),'registered',pack.label_id is not null,'state',coalesce(pack.state,'in_stock'),
    'revision',coalesce(pack.revision,0),'location',coalesce(pack.location,'가공장'),
    'stockRowId',coalesce(pack.source_stock_row_id,'stock_pending_'||(log->>'id')),
    '_originalStockRowId',coalesce(pack.original_stock_row_id,'stock_pending_'||(log->>'id')),'_productionId',null,'_snapshot',snap,'_source','{}'::jsonb,
    'workOrderId',log->>'workOrderId','productionPending',true,'productionCost',null,'costStatus','pending');
end;
$$;

create or replace function pda_private.check_product_balances(p_production text)
returns void language plpgsql security invoker set search_path='' as $$
begin
  if exists(select 1 from public.pda_packages where production_id=p_production group by source_stock_row_id,location
    having pda_private.balance(source_stock_row_id,location)+0.005<sum(case when state='in_stock' then weight else 0 end)) then
    raise exception '제품 재고와 PDA 박스 중량이 일치하지 않습니다. 전체 작업을 취소했습니다.';
  end if;
end;
$$;

create or replace function pda_private.product_cost_sources(p_production text,p_original text default null)
returns table(source_id text) language sql stable security invoker set search_path='' as $$
  select o->>'stockRowId' from public.production_entries p cross join lateral jsonb_array_elements(p.raw->'outputs') o
    where p.id=p_production and coalesce(o->>'stockRowId','')<>'' and(p_original is null or o->>'stockRowId'=p_original)
  union
  select t.raw->>'stockRowId' from public.transactions t join public.pda_packages u on u.label_id=t.raw->>'_pdaLabelId'
    where u.production_id=p_production and t.deleted_at is null and t.type='입고' and coalesce(t.raw->>'stockRowId','')<>''
      and(p_original is null or u.original_stock_row_id=p_original);
$$;

create or replace function pda_private.sync_product_costs(p_production text)
returns integer language plpgsql security invoker set search_path='' as $$
declare row record;posting record;cost numeric;meta jsonb;changed integer:=0;changes jsonb:='[]'::jsonb;
begin
  if not exists(select 1 from pda_private.product_cost_context where transaction_id=txid_current() and production_id=p_production) then raise exception '원가 정산 권한이 없습니다.';end if;
  for row in select o from public.production_entries p cross join lateral jsonb_array_elements(p.raw->'outputs') o where p.id=p_production and p.deleted_at is null and coalesce(o->>'stockRowId','')<>'' loop
    cost:=(row.o->>'price')::numeric;
    if cost is null or cost<0 then raise exception '확정할 생산원가를 확인해주세요.';end if;
    for posting in select t.* from public.transactions t where t.deleted_at is null and (
      t.raw->>'stockRowId' in(select source_id from pda_private.product_cost_sources(p_production,row.o->>'stockRowId')) or t.raw->>'_pdaLabelId' in
        (select label_id from public.pda_packages where production_id=p_production and original_stock_row_id=row.o->>'stockRowId'))
      and t.type in ('출고','입고','생산입고','재고이동') loop
      meta:=(posting.raw-'_productionCostUpdatedAt')||jsonb_build_object('stockUnitPrice',cost,'productionCost',cost,'productionCostAmount',round(cost*posting.weight),
        '_productionCostStatus','final','_productionCostProductionId',p_production,'_productionCostSourceId',row.o->>'stockRowId','_pdaProvisional',false);
      -- Sales prices/amounts are independent of cost, including intentionally edited prices.
      if posting.type<>'출고' then meta:=meta||jsonb_build_object('price',cost,'amount',round(cost*posting.weight));end if;
      if posting.stock_unit_price is distinct from cost or (posting.raw-'_productionCostUpdatedAt') is distinct from meta then
        changes:=changes||jsonb_build_array(jsonb_build_object('transactionId',posting.id,'previousCost',posting.raw->'stockUnitPrice','cost',cost,'labelId',posting.raw->>'_pdaLabelId'));
        update public.transactions set stock_unit_price=cost,price=case when type='출고' then price else cost end,
          amount=case when type='출고' then amount else round(cost*weight) end,raw=meta||jsonb_build_object('_productionCostUpdatedAt',clock_timestamp()),updated_at=clock_timestamp() where id=posting.id;
        changed:=changed+1;
      end if;
    end loop;
  end loop;
  perform pda_private.check_product_balances(p_production);
  if changed>0 then insert into public.change_logs(entity,action,entity_id,summary,payload)
    values('생산원가','자동 정산',p_production,format('생산원가 연동 %s건 / 판매단가·매출금액 유지',changed),
      jsonb_build_object('productionId',p_production,'changes',changes,'actor',(select actor from pda_private.product_cost_context where transaction_id=txid_current())));end if;
  return changed;
end;
$$;

create or replace function pda_private.finalize_pending_products(p_order text,p_production text)
returns void language plpgsql security invoker set search_path='' as $$
declare binding record;pending record;n integer:=0;expected integer;
begin
  select count(*) into expected from pda_private.pending_product_labels where work_order_id=p_order and resolved_at is null;
  if expected=0 then return;end if;
  for binding in select * from label_stock_private.assignments(p_production) loop
    select * into pending from pda_private.pending_product_labels where label_id=binding.label->>'id' and work_order_id=p_order and resolved_at is null;
    if not found then continue;end if;
    if binding.problem is not null or binding.stock_row_id is null then raise exception '%',coalesce(binding.problem,'가출고와 생산품의 연결정보가 다릅니다.');end if;
    update public.pda_packages set production_id=p_production,original_stock_row_id=binding.stock_row_id,
      source_stock_row_id=case when source_stock_row_id=pending.original_source then binding.stock_row_id else source_stock_row_id end,
      revision=revision+1,updated_at=clock_timestamp() where label_id=pending.label_id and production_id is null;
    update pda_private.pending_product_labels set production_id=p_production,resolved_at=clock_timestamp() where label_id=pending.label_id;
    update public.transactions set raw=raw||jsonb_build_object('stockRowId',binding.stock_row_id),updated_at=clock_timestamp()
      where deleted_at is null and raw->>'_pdaLabelId'=pending.label_id and raw->>'stockRowId'=pending.original_source;
    n:=n+1;
  end loop;
  if n<>expected then raise exception '가출고한 라벨이 생산완료 목록에 없습니다. 출력이력을 확인해주세요.';end if;
end;
$$;

create or replace function public.dbmt_label_complete_production_reviewed(p_pin text,p_work_order_id text,p_log_ids jsonb,p_confirmed_work_order jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;pid text;
begin
  perform pg_advisory_xact_lock(36100910);
  result:=public.dbmt_label_complete_production_before_pda_cost(p_pin,p_work_order_id,p_log_ids,p_confirmed_work_order);
  pid:=result->>'productionId';
  if result->>'ok' is distinct from 'true' or pid is null then raise exception '생산완료 처리 결과를 확인할 수 없습니다.';end if;
  insert into pda_private.product_cost_context values(txid_current(),pid,'completion',null);
  perform pda_private.finalize_pending_products(p_work_order_id,pid);
  perform pda_private.sync_product_costs(pid);
  delete from pda_private.product_cost_context where transaction_id=txid_current();
  return result;
end;
$$;

create or replace function pda_private.cost_shape(p_rows jsonb,p_input boolean default false)
returns jsonb language sql immutable security invoker set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('identity',label_stock_private.identity(e),'row',coalesce(e->>'stockRowId',''),
    'qty',case when p_input then null else public.dbmt_safe_numeric(e->>'qty') end,'boxes',case when p_input then null else e->'boxCount' end,'source',coalesce(e->>'sourceStockKey','')) order by n),'[]'::jsonb)
    from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) with ordinality r(e,n);
$$;

create or replace function public.dbmt_erp_save_production(p_token text,p_entry jsonb default null,p_transaction_rows jsonb default '[]'::jsonb,p_replace_id text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare usr uuid:=public.dbmt_erp_session_user(p_token);pid text:=coalesce(nullif(btrim(p_replace_id),''),p_entry->>'id');old jsonb;result jsonb;cost_change boolean:=false;prices_changed boolean:=false;
begin
  if usr is null then return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.');end if;
  perform pg_advisory_xact_lock(36100910);
  select raw into old from public.production_entries where id=pid and deleted_at is null for update;
  if old is not null and jsonb_typeof(p_entry)='object' then
    select exists(select 1 from jsonb_array_elements(old->'outputs') a join jsonb_array_elements(p_entry->'outputs') b
      on coalesce(a->>'stockRowId','')<>'' and a->>'stockRowId'=b->>'stockRowId'
      where public.dbmt_safe_numeric(a->>'price')<>public.dbmt_safe_numeric(b->>'price')) into cost_change;
    prices_changed:=cost_change;
    cost_change:=cost_change and(exists(select 1 from public.pda_packages where production_id=pid) or exists(
      select 1 from public.transactions t where t.deleted_at is null and coalesce(t.prod_id,t.raw->>'_prodId','')<>pid
        and t.raw->>'stockRowId' in(select e->>'stockRowId' from jsonb_array_elements(old->'outputs') e)));
    cost_change:=cost_change or exists(select 1 from public.pda_packages where production_id=pid);
  end if;
  if cost_change then
    if public.dbmt_erp_has_permission(p_token,'production','update') is not true then return public.dbmt_erp_permission_denied(usr,'production','update');end if;
    if pda_private.cost_shape(old->'outputs') is distinct from pda_private.cost_shape(p_entry->'outputs')
      or pda_private.cost_shape(old->'inputs',true) is distinct from pda_private.cost_shape(p_entry->'inputs',true) then
      raise exception '연결된 생산원가 정정 시 품목·중량·박스수·재고원본은 함께 변경할 수 없습니다.';end if;
    if exists(select 1 from jsonb_array_elements(p_entry->'outputs') e where jsonb_typeof(e->'price') is distinct from 'number' or (e->>'price')::numeric<0) then raise exception '생산원가는 0 이상의 숫자로 입력해주세요.';end if;
    if exists(
      select 1 from(select e->>'stockRowId' source_id,coalesce(nullif(e->>'stockLocation',''),'가공장') place,sum(public.dbmt_safe_numeric(e->>'qty')) qty
        from jsonb_array_elements(p_entry->'inputs') e where coalesce(e->>'stockRowId','')<>'' group by 1,2) req
      where pda_private.balance(req.source_id,req.place)
        +coalesce((select sum(public.dbmt_safe_numeric(o->>'qty')) from jsonb_array_elements(old->'inputs') o where o->>'stockRowId'=req.source_id
          and coalesce(nullif(o->>'stockLocation',''),'가공장')=req.place),0)<req.qty-0.005) then raise exception '정정할 투입중량에 비해 원료육 재고가 부족합니다.';end if;
    if prices_changed and(exists(select 1 from public.transactions t where t.deleted_at is null and t.type='사용' and coalesce(t.prod_id,t.raw->>'_prodId','')<>pid
      and t.raw->>'stockRowId' in(select source_id from pda_private.product_cost_sources(pid))) or exists(
      select 1 from public.app_data a cross join lateral jsonb_array_elements(a.payload) e cross join lateral jsonb_array_elements(public.dbmt_work_order_source_inputs(e)) src
      where a.key='workOrders' and src#>>'{sourceStock,stockRowId}' in(select source_id from pda_private.product_cost_sources(pid)))) then
      raise exception '다른 생산 투입·작업지시에 연결된 원가는 자동 정정할 수 없습니다. 사무실에서 확인해주세요.';end if;
    insert into pda_private.product_cost_context values(txid_current(),pid,'edit',usr);
  end if;
  result:=public.dbmt_erp_save_production_before_pda_cost(p_token,p_entry,p_transaction_rows,p_replace_id);
  if cost_change then
    if result->>'ok' is distinct from 'true' then raise exception '%',coalesce(result->>'message','생산원가 저장에 실패했습니다.');end if;
    perform pda_private.sync_product_costs(pid);
    delete from pda_private.product_cost_context where transaction_id=txid_current();
    if public.dbmt_erp_has_permission(p_token,'transactions','view') then
      result:=result||jsonb_build_object('costLinkedTransactions',coalesce((select jsonb_agg(raw order by id) from public.transactions
        where deleted_at is null and raw->>'_productionCostProductionId'=pid),'[]'::jsonb));
    end if;
  end if;
  return result;
end;
$$;

create or replace function pda_private.protect_product_cost_snapshot()
returns trigger language plpgsql security definer set search_path='' as $$
declare fields text[]:=array['stockUnitPrice','productionCost','productionCostAmount','_productionCostStatus','_productionCostProductionId','_productionCostSourceId','_productionCostUpdatedAt','_pdaProvisional'];
begin
  if old.raw ? '_productionCostStatus' and not exists(select 1 from pda_private.product_cost_context c where c.transaction_id=txid_current()
    and(c.production_id=old.raw->>'_productionCostProductionId' or exists(select 1 from public.pda_packages u where u.label_id=old.raw->>'_pdaLabelId' and u.production_id=c.production_id))) then
    -- An office may still have the pre-settlement row open while editing its sales price.
    new.stock_unit_price:=old.stock_unit_price;
    new.raw:=(new.raw-fields)||(select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(old.raw) where key=any(fields));
    if old.type='입고' and old.raw ? '_pdaLabelId' then new.price:=old.price;new.amount:=old.amount;new.raw:=new.raw||jsonb_build_object('price',old.price,'amount',old.amount);end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_pda_cost_snapshot_guard on public.transactions;
create trigger trg_pda_cost_snapshot_guard before update on public.transactions for each row execute function pda_private.protect_product_cost_snapshot();

create or replace function pda_private.protect_pending_labels()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.key='labelPrintLogs' and exists(
    with logs as materialized(select e,count(*) over(partition by e->>'id') copies from jsonb_array_elements(new.payload) e)
    select 1 from pda_private.pending_product_labels p join public.pda_packages u on u.label_id=p.label_id
      left join logs l on l.e->>'id'=p.label_id where p.resolved_at is null and(l.e is null or l.copies<>1 or l.e->>'status'='void'
      or l.e->>'code'<>u.code or public.dbmt_safe_numeric(l.e->>'labelWeight')<>u.weight or l.e->'workOrderSnapshot' is distinct from u.label_snapshot)
  ) then raise exception '가출고·입고 확인된 라벨은 삭제하거나 생산정보를 변경할 수 없습니다.';end if;
  if new.key='workOrders' and exists(select 1 from pda_private.pending_product_labels p where p.resolved_at is null
    and not exists(select 1 from jsonb_array_elements(new.payload) e where e->>'id'=p.work_order_id)) then
    raise exception '가출고 라벨이 있는 작업지시는 삭제할 수 없습니다.';end if;
  return new;
end;
$$;
drop trigger if exists trg_pda_pending_labels on public.app_data;
create trigger trg_pda_pending_labels before update on public.app_data for each row when(old.key in ('labelPrintLogs','workOrders')) execute function pda_private.protect_pending_labels();

-- Apply narrow, checked changes to the current guarded functions, retaining prior fixes.
do $patch$
declare d text;a text;b text;
begin
  select pg_get_functiondef('public.dbmt_stock_row_write_lock()'::regprocedure) into d;
  if position('pending_product_labels' in d)=0 then
    if position(E'begin\n' in d)=0 then raise exception 'Unexpected stock source guard';end if;
    d:=replace(d,E'begin\n',E'begin\n'||$b$
  if tg_op<>'DELETE' and new.raw->>'_pdaProvisional'='true' and new.raw ? '_pdaRequestId'
    and((tg_op='UPDATE' and old.raw->>'_pdaProvisional'='true' and old.raw->>'_pdaRequestId'=new.raw->>'_pdaRequestId') or exists(select 1 from public.pda_batches b where b.id::text=new.raw->>'_pdaRequestId' and b.result='{}'::jsonb))
    and exists(select 1 from pda_private.pending_product_labels p join public.pda_packages u on u.label_id=p.label_id
    where p.label_id=new.raw->>'_pdaLabelId' and p.resolved_at is null and u.production_id is null) then
    perform pg_advisory_xact_lock(36100910);return new;
  end if;
$b$);execute d;
  end if;
  select pg_get_functiondef('pda_private.protect_transaction()'::regprocedure) into d;
  if position('가출고 식별정보' in d)=0 then
    d:=replace(d,E'begin\n',E'begin\n'||$b$
  if tg_op='INSERT' and new.raw ? '_pdaLabelId' and not(new.raw ? '_pdaRequestId')
    or tg_op='UPDATE' and not(old.raw ? '_pdaRequestId') and(new.raw ? '_pdaRequestId' or new.raw ? '_pdaLabelId' or new.raw->>'_pdaProvisional'='true') then
    raise exception '가출고 식별정보는 PDA에서만 생성할 수 있습니다.';
  end if;
$b$);
  end if;
  a:=$a$if tg_op='UPDATE' and old.raw ? '_pdaRequestId' then$a$;
  b:=a||$b$
    if exists(select 1 from pda_private.product_cost_context c where c.transaction_id=txid_current()
      and exists(select 1 from public.pda_packages u where u.label_id=old.raw->>'_pdaLabelId' and u.production_id=c.production_id)) then
      v_columns:=v_columns||array['stock_unit_price'];v_fields:=v_fields||array['stockUnitPrice','productionCost','productionCostAmount','_productionCostStatus','_productionCostProductionId','_productionCostSourceId','_productionCostUpdatedAt','_pdaProvisional'];
      if old.type='입고' then v_columns:=v_columns||array['price','amount'];v_fields:=v_fields||array['price','amount'];end if;
      if old.raw->>'_pdaProvisional'='true' then v_fields:=v_fields||array['stockRowId'];end if;
    end if;
$b$;
  if position('_productionCostStatus' in d)=0 then
    if position(a in d)=0 then raise exception 'Unexpected PDA transaction guard';end if;execute replace(d,a,b);
  end if;
  select pg_get_functiondef('pda_private.protect_registered_stock()'::regprocedure) into d;
  a:=$a$if tg_op<>'INSERT' then v_old:=to_jsonb(old); end if;$a$;
  b:=$b$
  if tg_op<>'DELETE' and new.raw->>'_pdaProvisional'='true' and new.raw ? '_pdaRequestId'
    and((tg_op='UPDATE' and old.raw->>'_pdaProvisional'='true' and old.raw->>'_pdaRequestId'=new.raw->>'_pdaRequestId') or exists(select 1 from public.pda_batches b where b.id::text=new.raw->>'_pdaRequestId' and b.result='{}'::jsonb))
    and exists(select 1 from pda_private.pending_product_labels p join public.pda_packages u on u.label_id=p.label_id
    where p.label_id=new.raw->>'_pdaLabelId' and p.resolved_at is null and u.production_id is null) then return new;end if;
  if exists(select 1 from pda_private.product_cost_context c where c.transaction_id=txid_current() and(
    (tg_op<>'DELETE' and new.prod_id=c.production_id) or(tg_op<>'INSERT' and old.prod_id=c.production_id)
    or(tg_op<>'INSERT' and old.raw->>'_pdaProvisional'='true' and exists(select 1 from public.pda_packages u where u.label_id=old.raw->>'_pdaLabelId' and u.production_id=c.production_id)))) then
    if tg_op='DELETE' then return old;else return new;end if;
  end if;
$b$||a;
  if position('product_cost_context' in d)=0 then if position(a in d)=0 then raise exception 'Unexpected PDA stock guard';end if;execute replace(d,a,b);end if;
  select pg_get_functiondef('pda_private.protect_production()'::regprocedure) into d;
  if position('product_cost_context' in d)=0 then
    d:=replace(d,E'begin\n',E'begin\n'||$b$  if tg_op='UPDATE' and new.deleted_at is not null and exists(select 1 from pda_private.product_cost_context where transaction_id=txid_current() and production_id=old.id and mode='edit') then return new;end if;
$b$);
    d:=replace(d,$a$array['price','amount','note']$a$,$a$array['price','amount','note','stockUnitPrice']$a$);execute d;
  end if;
  select pg_get_functiondef('public.dbmt_validate_production_stock_rows(jsonb,text)'::regprocedure) into d;
  a:=$a$if round(public.dbmt_safe_numeric(v_row->>'price'))<>round(public.dbmt_safe_numeric(v_new->>'price')) then$a$;
  b:=$b$if round(public.dbmt_safe_numeric(v_row->>'price'))<>round(public.dbmt_safe_numeric(v_new->>'price'))
    and not exists(select 1 from pda_private.product_cost_context where transaction_id=txid_current() and production_id=v_old_id and mode='edit') then$b$;
  if position('product_cost_context' in d)=0 then if position(a in d)=0 then raise exception 'Unexpected production cost validator';end if;execute replace(d,a,b);end if;
end;
$patch$;

revoke all on all functions in schema pda_private from public,anon,authenticated;
revoke all on function public.dbmt_label_complete_production_before_pda_cost(text,text,jsonb,jsonb),public.dbmt_erp_save_production_before_pda_cost(text,jsonb,jsonb,text) from public,anon,authenticated;
revoke all on function public.dbmt_label_complete_production_reviewed(text,text,jsonb,jsonb),public.dbmt_erp_save_production(text,jsonb,jsonb,text) from public;
grant execute on function public.dbmt_label_complete_production_reviewed(text,text,jsonb,jsonb),public.dbmt_erp_save_production(text,jsonb,jsonb,text) to anon,authenticated;

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
    if v_data->>'state'='in_stock' and coalesce(v_data->>'productionPending','false')<>'true' then
      if v_data->>'location'<>p_location then raise exception '현재 재고 지점은 %입니다. 선택 지점을 확인해주세요.',v_data->>'location'; end if;
      v_remaining:=pda_private.balance(v_source,p_location);
      select coalesce(sum(weight),0) into v_reserved from public.pda_packages
        where state='in_stock' and source_stock_row_id=v_source and location=p_location and label_id<>v_data->>'labelId';
      if v_remaining-v_reserved+0.005<(v_data->>'weight')::numeric then
        raise exception '이 라벨에 배정할 재고가 부족합니다. ERP 수기 출고·사용·이동 내역을 확인해주세요: %',v_data->>'product';
      end if;
    end if;
    v_cost:=case when v_data->>'productionPending'='true' then null else coalesce(nullif(v_data#>>'{_source,stockUnitPrice}','')::numeric,nullif(v_data#>>'{_source,price}','')::numeric,0) end;
    if v_data->>'productionPending'='true' then
      insert into public.pda_packages(label_id,code,production_id,original_stock_row_id,source_stock_row_id,label_snapshot,weight,state,location)
        values(v_data->>'labelId',v_data->>'code',null,v_data->>'_originalStockRowId',v_source,v_data->'_snapshot',(v_data->>'weight')::numeric,'in_stock',p_location) on conflict do nothing;
      insert into pda_private.pending_product_labels(label_id,work_order_id,original_source)
        values(v_data->>'labelId',v_data->>'workOrderId',v_data->>'_originalStockRowId') on conflict do nothing;
    end if;
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
        'productionCost',v_cost,'productionCostAmount',round(v_cost*(v_data->>'weight')::numeric),
        '_productionCostStatus',case when v_data->>'productionPending'='true' then 'pending' else 'final' end,
        '_productionCostProductionId',v_data->>'_productionId','_productionCostSourceId',v_data->>'_originalStockRowId',
        '_pdaProvisional',coalesce((v_data->>'productionPending')::boolean,false),
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
notify pgrst,'reload schema';
