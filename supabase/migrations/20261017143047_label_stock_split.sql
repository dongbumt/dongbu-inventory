-- Split a completed production output by its existing physical outer labels.
-- Installation does not rewrite historical journals, labels or stock postings.
create schema if not exists label_stock_private;
revoke all on schema label_stock_private from public,anon,authenticated;

create table if not exists public.label_stock_assignments (
  production_id text not null references public.production_entries(id),
  label_id text not null,
  stock_row_id text not null,
  label_snapshot jsonb not null,
  row_identity jsonb not null,
  weight numeric not null check(weight>0 and weight=round(weight,2)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(production_id,label_id)
);
create index if not exists idx_label_stock_assignments_row on public.label_stock_assignments(production_id,stock_row_id);
create table if not exists public.label_stock_split_requests (
  id uuid primary key,
  user_id uuid not null references public.erp_users(id),
  production_id text not null references public.production_entries(id),
  request jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.label_stock_assignments enable row level security;
alter table public.label_stock_split_requests enable row level security;
revoke all on public.label_stock_assignments,public.label_stock_split_requests from public,anon,authenticated;

create or replace function label_stock_private.identity(p_row jsonb)
returns jsonb language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('product',coalesce(p_row->>'product',''),
    'productId',coalesce(p_row->>'productId',''),'labelProductId',coalesce(p_row->>'labelProductId',''),
    'productCode',coalesce(p_row->>'productCode',''),'lot',coalesce(p_row->>'lot',''),
    'origin',coalesce(p_row->>'origin',''),'packunit',coalesce(p_row->>'packunit',''),
    'proddate',public.dbmt_safe_date(p_row->>'proddate'),'grade',coalesce(p_row->>'grade',''),
    'stockLocation',coalesce(nullif(p_row->>'stockLocation',''),'가공장'));
$$;

create or replace function label_stock_private.log_snapshot(p_log jsonb)
returns jsonb language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('id',p_log->>'id','code',p_log->>'code',
    'workOrderId',p_log->>'workOrderId','labelWeight',p_log->'labelWeight',
    'workOrderSnapshot',p_log->'workOrderSnapshot');
$$;

-- Resolve only the current completion generation. Persisted bindings take
-- precedence over product matching once identical output rows are split.
create or replace function label_stock_private.assignments(p_production_id text)
returns table(label jsonb,stock_row_id text,row_identity jsonb,problem text)
language plpgsql security invoker set search_path='' as $$
declare
  v_entry jsonb; v_completion public.label_production_completions%rowtype;
  v_log jsonb; v_id text; v_count integer; v_code_count integer; v_row jsonb;
  v_binding public.label_stock_assignments%rowtype;
begin
  select raw into v_entry from public.production_entries where id=p_production_id and deleted_at is null;
  select * into v_completion from public.label_production_completions where production_id=p_production_id;
  if v_entry is null or v_completion.production_id is null then return; end if;
  -- Parse the bounded print ledger once. Repeated full JSON scans per label
  -- would make large print batches needlessly quadratic.
  for v_id,v_count,v_log,v_code_count in
    with logs as materialized (
      select e,count(*) over(partition by e->>'code') code_count
      from public.app_data a cross join lateral jsonb_array_elements(a.payload) e where a.key='labelPrintLogs'
    ) select i.value,count(l.e)::integer,(jsonb_agg(l.e) filter(where l.e is not null))->0,max(l.code_count)::integer
      from jsonb_array_elements_text(v_completion.log_ids) i left join logs l on l.e->>'id'=i.value group by i.value
  loop
    label:=null; stock_row_id:=null; row_identity:=null; problem:=null;
    label:=v_log;
    if v_count<>1 or coalesce(v_log->>'workOrderId','')<>v_completion.work_order_id
      or coalesce(v_log->>'status','active')='void'
      or coalesce(v_log->>'code','') !~ '^DB[0-9]{10}-[0-9A-Z]{1,6}$'
      or public.dbmt_safe_numeric(v_log->>'labelWeight')<=0
      or public.dbmt_safe_numeric(v_log->>'labelWeight')<>round(public.dbmt_safe_numeric(v_log->>'labelWeight'),2)
      or v_code_count<>1 then
      problem:='생산완료 당시 라벨 출력이력을 정확히 확인할 수 없습니다.';
      return next; continue;
    end if;
    select * into v_binding from public.label_stock_assignments
      where production_id=p_production_id and label_id=v_id;
    if found then
      stock_row_id:=v_binding.stock_row_id; row_identity:=v_binding.row_identity;
      if v_binding.label_snapshot is distinct from label_stock_private.log_snapshot(v_log)
        or v_binding.weight<>public.dbmt_safe_numeric(v_log->>'labelWeight') then
        problem:='분할 이후 라벨 원본이 변경되었습니다. 사무실에서 확인해주세요.';
      end if;
    else
      select count(*),jsonb_agg(o)->0 into v_count,v_row from jsonb_array_elements(v_entry->'outputs') o
      where o->>'product'=v_log#>>'{workOrderSnapshot,product}'
        and coalesce(o->>'lot','')=coalesce(v_log#>>'{workOrderSnapshot,lot}','')
        and coalesce(o->>'origin','')=coalesce(v_log#>>'{workOrderSnapshot,origin}','')
        and coalesce(o->>'packunit','')=coalesce(v_log#>>'{workOrderSnapshot,packunit}','')
        and public.dbmt_safe_date(o->>'proddate') is not distinct from public.dbmt_safe_date(v_log#>>'{workOrderSnapshot,mfgdate}')
        and (coalesce(v_log#>>'{workOrderSnapshot,labelProductId}','')=''
          or o->>'labelProductId'=v_log#>>'{workOrderSnapshot,labelProductId}')
        and coalesce(o->>'grade','')=coalesce(v_log#>>'{workOrderSnapshot,grade}','');
      if v_count<>1 or coalesce(v_row->>'stockRowId','')='' then
        problem:='라벨과 생산품 재고행을 하나로 연결할 수 없습니다. 기존 분할·품목 변경 내역을 확인해주세요.';
      else
        stock_row_id:=v_row->>'stockRowId'; row_identity:=label_stock_private.identity(v_row);
      end if;
    end if;
    return next;
  end loop;
end;
$$;

create or replace function label_stock_private.snapshot(p_production_id text,p_stock_row_id text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_production public.production_entries%rowtype; v_completion public.label_production_completions%rowtype;
  v_row jsonb; v_labels jsonb; v_all jsonb; v_version text; v_reason text; v_count integer;
  v_total numeric;
begin
  select * into v_production from public.production_entries where id=p_production_id and deleted_at is null;
  if not found then raise exception '생산일보가 삭제되었거나 변경되었습니다. 다시 조회해주세요.'; end if;
  select * into v_completion from public.label_production_completions where production_id=p_production_id;
  if not found then raise exception '라벨 생산완료로 등록된 생산일보만 분할할 수 있습니다.'; end if;
  select count(*),jsonb_agg(o)->0 into v_count,v_row from jsonb_array_elements(v_production.raw->'outputs') o
    where o->>'stockRowId'=p_stock_row_id and coalesce(p_stock_row_id,'')<>'';
  if v_count<>1 then raise exception '분할할 생산품 재고행을 다시 선택해주세요.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('label',label,'stockRowId',stock_row_id,
    'identity',row_identity,'problem',problem) order by label->>'id'),'[]'::jsonb)
    into v_all from label_stock_private.assignments(p_production_id);
  select e->>'problem' into v_reason from jsonb_array_elements(v_all) e where e->>'problem' is not null limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('id',e#>>'{label,id}','code',e#>>'{label,code}',
      'weight',public.dbmt_safe_numeric(e#>>'{label,labelWeight}'),'printedAt',e#>>'{label,printedAt}',
      'batchId',coalesce(e#>>'{label,batchId}',''),'copyNo',e#>'{label,copyNo}')
      order by e#>>'{label,printedAt}',e#>>'{label,id}'),'[]'::jsonb),
      coalesce(sum(public.dbmt_safe_numeric(e#>>'{label,labelWeight}')),0)
    into v_labels,v_total from jsonb_array_elements(v_all) e where e->>'stockRowId'=p_stock_row_id;
  v_count:=jsonb_array_length(v_labels);
  if v_reason is null and exists(select 1 from jsonb_array_elements(v_all) e
    where e->>'stockRowId'=p_stock_row_id and e->'identity'<>label_stock_private.identity(v_row)) then
    v_reason:='분할된 생산품의 품목·LOT·원산지·규격·생산일·창고가 라벨 연결정보와 다릅니다.';
  end if;
  if v_reason is null and (v_total<>public.dbmt_safe_numeric(v_row->>'qty')
    or (v_row->>'boxCount' is not null and public.dbmt_safe_numeric(v_row->>'boxCount')<>v_count)) then
    v_reason:='생산일보 중량·박스수와 출력 라벨 합계가 다릅니다. 기존 수정 내역을 확인해주세요.';
  end if;
  if v_reason is null and v_count<2 then v_reason:='라벨이 2장 이상인 생산품만 분할할 수 있습니다.'; end if;
  if v_reason is null and jsonb_array_length(v_production.raw->'inputs')+jsonb_array_length(v_production.raw->'outputs')>=500 then
    v_reason:='생산일보의 투입·생산 항목은 합계 500건까지만 등록할 수 있습니다.';
  end if;
  select count(*),jsonb_agg(to_jsonb(t))->0 into v_count,v_all from public.transactions t
    where deleted_at is null and raw->>'stockRowId'=p_stock_row_id and type='생산입고'
      and coalesce(prod_id,raw->>'_prodId','')=p_production_id;
  if v_reason is null and (v_count<>1 or public.dbmt_safe_numeric(v_all->>'weight')<>public.dbmt_safe_numeric(v_row->>'qty')
    or label_stock_private.identity(v_all->'raw')<>label_stock_private.identity(v_row)
    or (v_row->>'boxCount' is not null and public.dbmt_safe_numeric(v_all#>>'{raw,boxCount}')<>public.dbmt_safe_numeric(v_row->>'boxCount'))) then
    v_reason:='생산일보와 연결된 입고 재고원본이 일치하지 않습니다. 다시 조회해주세요.';
  end if;
  if v_reason is null and exists(select 1 from public.transactions t where deleted_at is null
    and raw->>'stockRowId'=p_stock_row_id and not(type='생산입고' and coalesce(prod_id,raw->>'_prodId','')=p_production_id)) then
    v_reason:='출고·사용·이동·조정 또는 작업지시에 연결된 생산품은 분할할 수 없습니다.';
  end if;
  if v_reason is null and exists(select 1 from public.app_data a
    cross join lateral jsonb_array_elements(case when jsonb_typeof(a.payload)='array' then a.payload else '[]'::jsonb end) e
    cross join lateral jsonb_array_elements(public.dbmt_work_order_source_inputs(e)) source
    where a.key='workOrders' and source#>>'{sourceStock,stockRowId}'=p_stock_row_id) then
    v_reason:='출고·사용·이동·조정 또는 작업지시에 연결된 생산품은 분할할 수 없습니다.';
  end if;
  if exists(select 1 from public.pda_packages where production_id=p_production_id) then
    v_reason:='PDA로 처리한 라벨이 연결된 생산일보는 분할할 수 없습니다.';
  end if;
  select encode(extensions.digest(jsonb_build_object('entry',v_production.raw,'updatedAt',v_production.updated_at,
    'completion',to_jsonb(v_completion),'labels',v_labels,'posting',v_all,
    'bindings',(select coalesce(jsonb_agg(to_jsonb(m) order by m.label_id),'[]'::jsonb)
      from public.label_stock_assignments m where m.production_id=p_production_id and m.stock_row_id=p_stock_row_id))::text,'sha256'),'hex') into v_version;
  return jsonb_build_object('ok',true,'version',v_version,'canSplit',v_reason is null,'reason',coalesce(v_reason,''),
    'productionId',p_production_id,'stockRowId',p_stock_row_id,'product',v_row->>'product',
    'row',v_row,'labels',v_labels,'totalWeight',v_total,'boxCount',jsonb_array_length(v_labels));
end;
$$;

-- Mapped physical labels constrain their journal rows even when an old office
-- browser calls the ordinary production editor. No client-set bypass is used.
-- Soft deletion keeps generation history and is still guarded by existing PDA
-- and downstream stock guards; cancellation/resubmission remains supported.
create or replace function label_stock_private.protect_production()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_group record; v_row jsonb; v_count integer;
begin
  if tg_op='DELETE' then
    if exists(select 1 from public.label_stock_assignments where production_id=old.id) then
      raise exception '라벨 분할 이력이 있는 생산일보 원본은 완전히 삭제할 수 없습니다.';
    end if;
    return old;
  end if;
  if new.deleted_at is not null then return new; end if;
  for v_group in select stock_row_id,sum(weight) weight,count(*) boxes from public.label_stock_assignments
    where production_id=new.id group by stock_row_id loop
    select count(*),jsonb_agg(o)->0 into v_count,v_row from jsonb_array_elements(new.raw->'outputs') o
      where o->>'stockRowId'=v_group.stock_row_id;
    if v_count<>1 or public.dbmt_safe_numeric(v_row->>'qty')<>v_group.weight
      or v_row->>'boxCount' is null or public.dbmt_safe_numeric(v_row->>'boxCount')<>v_group.boxes
      or exists(select 1 from public.label_stock_assignments m where m.production_id=new.id
        and m.stock_row_id=v_group.stock_row_id and m.row_identity<>label_stock_private.identity(v_row)) then
      raise exception '라벨 분할된 생산품의 품목·중량·박스수·재고번호는 직접 변경할 수 없습니다. 라벨 분할 기능을 이용해주세요.';
    end if;
  end loop;
  return new;
end;
$$;
drop trigger if exists trg_label_stock_production_guard on public.production_entries;
create trigger trg_label_stock_production_guard before insert or update or delete on public.production_entries
  for each row execute function label_stock_private.protect_production();

create or replace function public.dbmt_erp_get_label_split(p_token text,p_production_id text,p_stock_row_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb;
begin
  if public.dbmt_erp_session_user(p_token) is null then raise exception using errcode='28000',message='개인 사용자 로그인이 만료되었습니다.'; end if;
  if public.dbmt_erp_has_permission(p_token,'production','view') is not true then
    raise exception using errcode='42501',message='생산일보 조회 권한이 필요합니다.';
  end if;
  perform pg_advisory_xact_lock(36100910);
  v_result:=label_stock_private.snapshot(p_production_id,p_stock_row_id);
  if public.dbmt_erp_has_permission(p_token,'production','update') is not true then
    v_result:=v_result||jsonb_build_object('canSplit',false,'reason','생산일보 수정 권한이 필요합니다.');
  end if;
  return v_result;
end;
$$;

create or replace function public.dbmt_erp_split_label_stock(p_token text,p_production_id text,p_stock_row_id text,
  p_label_ids jsonb,p_version text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=public.dbmt_erp_session_user(p_token); v_ids jsonb; v_request jsonb;
  v_previous public.label_stock_split_requests%rowtype; v_state jsonb; v_entry jsonb;
  v_outputs jsonb; v_row jsonb; v_selected numeric; v_boxes integer; v_total_boxes integer;
  v_new_row_id text:='stock_'||replace(extensions.gen_random_uuid()::text,'-',''); v_result jsonb;
begin
  if v_user is null then raise exception using errcode='28000',message='개인 사용자 로그인이 만료되었습니다.'; end if;
  if public.dbmt_erp_has_permission(p_token,'production','view') is not true
    or public.dbmt_erp_has_permission(p_token,'production','update') is not true then
    raise exception using errcode='42501',message='생산일보 조회·수정 권한이 필요합니다.';
  end if;
  if p_request_id is null or jsonb_typeof(p_label_ids) is distinct from 'array' then raise exception '분할 요청번호와 라벨 목록을 확인해주세요.'; end if;
  if jsonb_array_length(p_label_ids) not between 1 and 5000 or exists(select 1 from jsonb_array_elements(p_label_ids) e
    where jsonb_typeof(e)<>'string' or coalesce(e#>>'{}','')='' or length(e#>>'{}')>150)
    or exists(select 1 from jsonb_array_elements_text(p_label_ids) e group by e having count(*)>1) then
    raise exception '분리할 라벨을 중복 없이 선택해주세요.';
  end if;
  select jsonb_agg(e order by e) into v_ids from jsonb_array_elements_text(p_label_ids) e;
  v_request:=jsonb_build_object('productionId',p_production_id,'stockRowId',p_stock_row_id,'labelIds',v_ids,'version',p_version);
  perform pg_advisory_xact_lock(36100910);
  perform pg_advisory_xact_lock(40100914);
  select * into v_previous from public.label_stock_split_requests where id=p_request_id;
  if found then
    if v_previous.user_id<>v_user or v_previous.request<>v_request then raise exception '같은 요청번호로 다른 내용을 저장할 수 없습니다.'; end if;
    return v_previous.result||jsonb_build_object('alreadySaved',true,
      'cancelled',not exists(select 1 from public.production_entries where id=p_production_id and deleted_at is null),
      'entry',(select raw from public.production_entries where id=p_production_id and deleted_at is null),
      'transactionRows',coalesce((select jsonb_agg(raw order by id) from public.transactions where deleted_at is null
        and coalesce(prod_id,raw->>'_prodId','')=p_production_id),'[]'::jsonb));
  end if;
  v_state:=label_stock_private.snapshot(p_production_id,p_stock_row_id);
  if coalesce(p_version,'')='' or p_version<>v_state->>'version' then
    raise exception '생산일보 또는 라벨 정보가 변경되었습니다. 다시 조회해주세요.';
  end if;
  if v_state->>'canSplit'<>'true' then raise exception '%',v_state->>'reason'; end if;
  if jsonb_array_length(v_ids)>=jsonb_array_length(v_state->'labels') then raise exception '분리할 라벨을 일부만 선택해주세요.'; end if;
  if exists(select 1 from jsonb_array_elements_text(v_ids) i where not exists(
    select 1 from jsonb_array_elements(v_state->'labels') l where l->>'id'=i)) then
    raise exception '선택한 라벨이 이 생산품 재고에 속하지 않습니다. 다시 조회해주세요.';
  end if;
  select sum(public.dbmt_safe_numeric(l->>'weight')),count(*) into v_selected,v_boxes
    from jsonb_array_elements(v_state->'labels') l where v_ids ? (l->>'id');
  v_total_boxes:=jsonb_array_length(v_state->'labels');
  select raw into v_entry from public.production_entries where id=p_production_id and deleted_at is null for update;
  v_row:=v_state->'row';
  -- Bind only this explicitly selected output, never historical unrelated data.
  insert into public.label_stock_assignments(production_id,label_id,stock_row_id,label_snapshot,row_identity,weight)
    select p_production_id,label->>'id',p_stock_row_id,label_stock_private.log_snapshot(label),row_identity,
      public.dbmt_safe_numeric(label->>'labelWeight') from label_stock_private.assignments(p_production_id)
      where stock_row_id=p_stock_row_id
    on conflict(production_id,label_id) do nothing;
  update public.label_stock_assignments set stock_row_id=v_new_row_id,updated_at=clock_timestamp()
    where production_id=p_production_id and stock_row_id=p_stock_row_id and v_ids ? label_id;
  select jsonb_agg(case when o->>'stockRowId'=p_stock_row_id then o||jsonb_build_object(
    'qty',public.dbmt_safe_numeric(o->>'qty')-v_selected,'boxCount',v_total_boxes-v_boxes,
    'amount',round(public.dbmt_safe_numeric(o->>'price')*(public.dbmt_safe_numeric(o->>'qty')-v_selected))) else o end order by n)
    into v_outputs from jsonb_array_elements(v_entry->'outputs') with ordinality a(o,n);
  v_outputs:=v_outputs||jsonb_build_array(v_row||jsonb_build_object('stockRowId',v_new_row_id,
    'qty',v_selected,'boxCount',v_boxes,'amount',round(public.dbmt_safe_numeric(v_row->>'price')*v_selected)));
  v_entry:=v_entry||jsonb_build_object('outputs',v_outputs);
  -- Keep the existing authoritative journal validation, input quantities and
  -- cost basis. Per-output monetary rounding remains the normal ERP rule.
  v_result:=public.dbmt_erp_save_production(p_token,v_entry,'[]'::jsonb,p_production_id);
  if v_result->>'ok' is distinct from 'true' then raise exception '%',coalesce(v_result->>'message','생산품 분할을 저장하지 못했습니다.'); end if;
  v_result:=jsonb_build_object('ok',true,'productionId',p_production_id,'remainingStockRowId',p_stock_row_id,
    'splitStockRowId',v_new_row_id,'entry',(select raw from public.production_entries where id=p_production_id),
    'transactionRows',coalesce((select jsonb_agg(raw order by id) from public.transactions where deleted_at is null
      and coalesce(prod_id,raw->>'_prodId','')=p_production_id),'[]'::jsonb));
  insert into public.label_stock_split_requests(id,user_id,production_id,request,result)
    values(p_request_id,v_user,p_production_id,v_request,v_result);
  insert into public.change_logs(entity,action,entity_id,summary,payload) values('생산일보','라벨 분할',p_production_id,
    format('%s / %s KG / %s박스 분할',v_row->>'product',v_selected,v_boxes),
    jsonb_build_object('authMode','personal_session','userId',v_user,'requestId',p_request_id,
      'originalStockRowId',p_stock_row_id,'splitStockRowId',v_new_row_id,'labelIds',v_ids,
      'weight',v_selected,'boxCount',v_boxes));
  return v_result;
end;
$$;

-- Existing barcodes and print snapshots stay unchanged. PDA lookup resolves
-- the active generation's persisted row before falling back for legacy stock.
do $patch$
declare v_definition text; v_old text; v_new text;
begin
  select pg_get_functiondef('pda_private.resolve(text)'::regprocedure) into v_definition;
  v_old:=$old$case when v_unit.label_id is not null then o->>'stockRowId'=v_unit.original_stock_row_id else$old$;
  v_new:=$new$case when v_unit.label_id is not null then o->>'stockRowId'=v_unit.original_stock_row_id
      when exists(select 1 from public.label_stock_assignments m where m.production_id=v_production.id and m.label_id=v_log->>'id') then
        o->>'stockRowId'=(select m.stock_row_id from public.label_stock_assignments m where m.production_id=v_production.id and m.label_id=v_log->>'id'
          and m.label_snapshot=label_stock_private.log_snapshot(v_log) and m.weight=public.dbmt_safe_numeric(v_log->>'labelWeight'))
      else$new$;
  if position(v_new in v_definition)=0 then
    if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
      raise exception 'Unexpected PDA label resolver definition';
    end if;
    execute replace(v_definition,v_old,v_new);
  end if;
end;
$patch$;

revoke all on all functions in schema label_stock_private from public,anon,authenticated;
revoke all on function public.dbmt_erp_get_label_split(text,text,text),
  public.dbmt_erp_split_label_stock(text,text,text,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.dbmt_erp_get_label_split(text,text,text),
  public.dbmt_erp_split_label_stock(text,text,text,jsonb,text,uuid) to anon,authenticated;
notify pgrst,'reload schema';
