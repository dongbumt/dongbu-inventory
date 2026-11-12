-- A production posting and its raw-material box lifecycle commit together.
-- Installing this migration never completes or changes an existing journal.
select pg_advisory_xact_lock(36100910);

create table pda_private.raw_production_context(
  transaction_id bigint primary key,
  mode text not null check(mode in ('label','erp','cancel')),
  production_id text,work_order_id text,actor uuid,previous_inputs jsonb not null default '[]'::jsonb
);
create table pda_private.raw_production_packages(
  package_id text primary key references pda_private.raw_packages(id),
  production_id text not null references public.production_entries(id),
  source_id text not null,location text not null,
  assigned_at timestamptz not null default clock_timestamp()
);
create index idx_raw_production_packages_journal on pda_private.raw_production_packages(production_id,source_id,location);
alter table pda_private.raw_production_context enable row level security;
alter table pda_private.raw_production_packages enable row level security;
revoke all on pda_private.raw_production_context,pda_private.raw_production_packages from public,anon,authenticated;
alter table pda_private.raw_packages drop constraint raw_packages_state_check;
alter table pda_private.raw_packages add constraint raw_packages_state_check check(state in ('in_stock','shipped','cancelled','used'));

create function pda_private.raw_production_allowed(p_posting jsonb)
returns boolean language sql stable security invoker set search_path='' as $$
  select coalesce(p_posting->>'type','')='사용'
    and coalesce(p_posting->>'prod_id',p_posting#>>'{raw,_prodId}','')<>''
    and coalesce(p_posting#>>'{raw,stockRowId}','')<>''
    and exists(select 1 from pda_private.raw_packages where source_id=p_posting#>>'{raw,stockRowId}')
    and exists(select 1 from pda_private.raw_production_context c where c.transaction_id=txid_current() and (
      (c.mode in ('erp','cancel') and c.production_id=coalesce(p_posting->>'prod_id',p_posting#>>'{raw,_prodId}'))
      or (c.mode='label' and exists(select 1 from public.production_entries p
        where p.id=coalesce(p_posting->>'prod_id',p_posting#>>'{raw,_prodId}')
          and p.raw#>>'{_labelCompletion,workOrderId}'=c.work_order_id))));
$$;
revoke all on function pda_private.raw_production_allowed(jsonb) from public,anon,authenticated;

-- Only the existing, authenticated production RPCs can create this capability.
-- Ordinary transactions and PDA shipment permissions remain unchanged.
do $patch$
declare d text;anchor text;
begin
  select pg_get_functiondef('pda_private.protect_raw_stock()'::regprocedure) into d;
  anchor:='if tg_op=''INSERT'' and exists(select 1 from public.transactions where id=new.id) then return new; end if;';
  if position(anchor in d)=0 then raise exception 'Unexpected raw stock guard; production installation aborted.';end if;
  d:=replace(d,anchor,anchor||$body$
  if pda_private.raw_production_allowed(before) or pda_private.raw_production_allowed(after) then
    if tg_op='DELETE' then return old;end if;return new;
  end if;
  if ((before->>'type'='사용' and coalesce(before->>'prod_id',before#>>'{raw,_prodId}','')<>'')
    or (after->>'type'='사용' and coalesce(after->>'prod_id',after#>>'{raw,_prodId}','')<>''))
    and exists(select 1 from pda_private.raw_packages p
      where p.source_id in (before#>>'{raw,stockRowId}',after#>>'{raw,stockRowId}')) then
    raise exception 'PDA 원료육의 생산투입은 생산일보에서 수정하거나 취소해주세요. 박스 사용 상태도 함께 반영해야 합니다.';
  end if;
$body$);
  execute d;
end $patch$;

create function pda_private.sync_raw_production(p_production text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  ctx pda_private.raw_production_context%rowtype;g record;candidate record;
  before_boxes jsonb;after_boxes jsonb;details jsonb:='[]'::jsonb;
  selected text[];wanted numeric;qty numeric;previous_qty numeric;reserved numeric;balance numeric;covered numeric;needed numeric;
  found_count integer;source_name text;source_lot text;
begin
  select * into ctx from pda_private.raw_production_context where transaction_id=txid_current();
  if not found or not coalesce(ctx.production_id=p_production or (ctx.mode='label' and exists(
    select 1 from public.production_entries p where p.id=p_production
      and p.raw#>>'{_labelCompletion,workOrderId}'=ctx.work_order_id)),false) then
    raise exception 'PDA 원료육의 생산 사용 처리 권한을 확인할 수 없습니다.';
  end if;
  perform pg_advisory_xact_lock(36100910);
  if exists(select 1 from pda_private.raw_production_packages a join pda_private.raw_packages p on p.id=a.package_id
    where a.production_id=p_production and (p.state not in ('used','shipped') or p.source_id<>a.source_id or p.location<>a.location)) then
    raise exception '생산에 사용한 원료 박스의 연결이 변경되었습니다. 사무실에서 확인해주세요.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('packageId',a.package_id,'sourceId',a.source_id,'location',a.location,
    'barcode',p.barcode,'scannedWeight',p.weight,'packageState',p.state) order by a.package_id),'[]'::jsonb)
    into before_boxes from pda_private.raw_production_packages a join pda_private.raw_packages p on p.id=a.package_id
    where a.production_id=p_production;
  for g in
    select distinct s.source_id,s.location from (
      select a.source_id,a.location from pda_private.raw_production_packages a where a.production_id=p_production
      union
      select t.raw->>'stockRowId',coalesce(nullif(t.stock_location,''),'가공장') from public.transactions t
        where t.deleted_at is null and t.type='사용' and coalesce(t.prod_id,t.raw->>'_prodId')=p_production
          and coalesce(t.raw->>'stockRowId','')<>''
          and exists(select 1 from pda_private.raw_packages p where p.source_id=t.raw->>'stockRowId')
    ) s order by s.source_id,s.location
  loop
    select coalesce(sum(t.weight),0),case when count(*)=0 then 0
      when count(*) filter(where t.raw->>'boxCount' is null or t.raw->>'boxCount'='')>0 then null
      else sum((t.raw->>'boxCount')::numeric) end into qty,wanted
      from public.transactions t where t.deleted_at is null and t.type='사용'
        and coalesce(t.prod_id,t.raw->>'_prodId')=p_production and t.raw->>'stockRowId'=g.source_id
        and coalesce(nullif(t.stock_location,''),'가공장')=g.location;
    if qty<0 or (wanted is not null and (wanted<0 or wanted<>trunc(wanted) or wanted>1000000)) then
      raise exception 'PDA 원료육 투입량과 박스수는 0 이상의 올바른 수량으로 입력해주세요.';
    end if;
    balance:=pda_private.balance(g.source_id,g.location);
    select p.snapshot->>'product',p.snapshot->>'lot' into source_name,source_lot
      from pda_private.raw_packages p where p.source_id=g.source_id limit 1;
    select coalesce(sum((e->>'weight')::numeric),0) into previous_qty
      from jsonb_array_elements(ctx.previous_inputs) e where e->>'sourceId'=g.source_id and e->>'location'=g.location;
    if balance< -0.005 and qty>previous_qty then
      raise exception '생산투입 후 원료육 재고가 부족합니다. 품목: %, 이력번호: %, 지점: %, 잔량: %KG',source_name,source_lot,g.location,balance;
    end if;
    -- Include this journal's existing boxes virtually; unchanged edits keep
    -- their exact bindings and do not invalidate a PDA scan unnecessarily.
    select coalesce(sum(p.weight),0) into reserved from pda_private.raw_packages p
      where p.source_id=g.source_id and p.location=g.location and (p.state='in_stock' or exists(
        select 1 from pda_private.raw_production_packages a where a.package_id=p.id and a.production_id=p_production));
    -- Box assignments are management links within this exact receipt source,
    -- not proof of the physical barcode used. Honour explicit box counts even
    -- when scanned weights differ from corrected/book weights. Unknown counts
    -- use the input quantity less any unboxed remainder available beforehand.
    needed:=greatest(0,qty-greatest(0,balance+qty-reserved));
    selected:=array[]::text[];covered:=0;found_count:=0;
    for candidate in
      select p.id,p.weight from pda_private.raw_packages p
        left join pda_private.raw_production_packages a on a.package_id=p.id and a.production_id=p_production
      where p.source_id=g.source_id and p.location=g.location and (p.state='in_stock' or a.package_id is not null)
      order by (a.package_id is not null) desc,random()
      for update of p
    loop
      exit when (wanted is not null and found_count>=wanted) or (wanted is null and covered+0.005>=needed);
      selected:=array_append(selected,candidate.id);covered:=covered+candidate.weight;found_count:=found_count+1;
    end loop;
    if (wanted is not null and found_count<wanted) or (wanted is null and covered+0.005<needed) then
      raise exception '투입 박스수로는 PDA 원료육 재고를 맞출 수 없습니다. 품목: %, 이력번호: %. 박스수를 확인하거나 비워두면 필요한 박스만 자동 연결합니다.',source_name,source_lot;
    end if;
    update pda_private.raw_packages p set state='in_stock',revision=revision+1,updated_at=clock_timestamp()
      where exists(select 1 from pda_private.raw_production_packages a where a.package_id=p.id
        and a.production_id=p_production and a.source_id=g.source_id and a.location=g.location)
        and p.state='used' and not(p.id=any(selected));
    delete from pda_private.raw_production_packages a where a.production_id=p_production
      and a.source_id=g.source_id and a.location=g.location and not(a.package_id=any(selected));
    update pda_private.raw_packages p set state='used',revision=revision+1,updated_at=clock_timestamp()
      where p.id=any(selected) and p.state='in_stock';
    insert into pda_private.raw_production_packages(package_id,production_id,source_id,location)
      select id,p_production,g.source_id,g.location from unnest(selected) id on conflict(package_id) do nothing;
    if exists(select 1 from unnest(selected) id left join pda_private.raw_production_packages a on a.package_id=id
      where a.production_id is distinct from p_production) then raise exception '다른 생산에서 먼저 사용한 원료 박스입니다. 다시 조회해주세요.';end if;
    details:=details||jsonb_build_array(jsonb_build_object('sourceId',g.source_id,'location',g.location,
      'inputWeight',qty,'requestedBoxes',wanted,'usedBoxes',found_count,'packageIds',to_jsonb(selected),
      'looseWeight',round(balance-(reserved-covered),2)));
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('packageId',a.package_id,'sourceId',a.source_id,'location',a.location,
    'barcode',p.barcode,'scannedWeight',p.weight,'packageState',p.state) order by a.package_id),'[]'::jsonb)
    into after_boxes from pda_private.raw_production_packages a join pda_private.raw_packages p on p.id=a.package_id
    where a.production_id=p_production;
  if before_boxes is distinct from after_boxes then
    insert into public.change_logs(entity,action,entity_id,summary,payload) values('PDA 원료육','생산 사용 연동',p_production,
      format('생산투입 원료 박스 %s → %s개',jsonb_array_length(before_boxes),jsonb_array_length(after_boxes)),
      jsonb_build_object('productionId',p_production,'authMode',ctx.mode,'actor',ctx.actor,
        'beforeBoxes',before_boxes,'afterBoxes',after_boxes,'sources',details));
  end if;
  return jsonb_build_object('productionId',p_production,'boxes',after_boxes,'sources',details);
end;
$$;
revoke all on function pda_private.sync_raw_production(text) from public,anon,authenticated;

alter function public.dbmt_label_complete_production_reviewed(text,text,jsonb,jsonb) rename to label_complete_before_raw_use;
alter function public.label_complete_before_raw_use(text,text,jsonb,jsonb) set schema pda_private;
alter function public.dbmt_erp_save_production(text,jsonb,jsonb,text) rename to save_production_before_raw_use;
alter function public.save_production_before_raw_use(text,jsonb,jsonb,text) set schema pda_private;
alter function public.dbmt_label_cancel_production(text,text,text) rename to cancel_production_before_raw_use;
alter function public.cancel_production_before_raw_use(text,text,text) set schema pda_private;
revoke all on function pda_private.label_complete_before_raw_use(text,text,jsonb,jsonb),
  pda_private.save_production_before_raw_use(text,jsonb,jsonb,text),pda_private.cancel_production_before_raw_use(text,text,text)
  from public,anon,authenticated;

create function public.dbmt_label_complete_production_reviewed(p_pin text,p_work_order_id text,p_log_ids jsonb,p_confirmed_work_order jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;usage jsonb;
begin
  if public.dbmt_check_label_print_pin(p_pin) is not true then raise exception '라벨전용 PIN이 맞지 않습니다.';end if;
  perform pg_advisory_xact_lock(36100910);
  insert into pda_private.raw_production_context values(txid_current(),'label',null,p_work_order_id,null,
    coalesce((select jsonb_agg(jsonb_build_object('sourceId',t.raw->>'stockRowId','location',coalesce(nullif(t.stock_location,''),'가공장'),'weight',t.weight))
      from public.transactions t join public.label_production_completions c on c.production_id=t.prod_id
      where c.work_order_id=p_work_order_id and t.type='사용' and t.deleted_at is null),'[]'::jsonb));
  result:=pda_private.label_complete_before_raw_use(p_pin,p_work_order_id,p_log_ids,p_confirmed_work_order);
  if result->>'ok'='true' then usage:=pda_private.sync_raw_production(result->>'productionId');end if;
  delete from pda_private.raw_production_context where transaction_id=txid_current();
  return result||jsonb_build_object('pdaRawUsage',usage);
end;
$$;
create function public.dbmt_erp_save_production(p_token text,p_entry jsonb default null,p_transaction_rows jsonb default '[]'::jsonb,p_replace_id text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;usage jsonb;usr uuid:=public.dbmt_erp_session_user(p_token);
  pid text:=coalesce(nullif(btrim(p_replace_id),''),p_entry->>'id');
begin
  if usr is null then return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.');end if;
  perform pg_advisory_xact_lock(36100910);
  insert into pda_private.raw_production_context values(txid_current(),'erp',pid,null,usr,
    coalesce((select jsonb_agg(jsonb_build_object('sourceId',t.raw->>'stockRowId','location',coalesce(nullif(t.stock_location,''),'가공장'),'weight',t.weight))
      from public.transactions t where coalesce(t.prod_id,t.raw->>'_prodId')=pid and t.type='사용' and t.deleted_at is null),'[]'::jsonb));
  result:=pda_private.save_production_before_raw_use(p_token,p_entry,p_transaction_rows,p_replace_id);
  if result->>'ok'='true' and pid is not null then usage:=pda_private.sync_raw_production(pid);end if;
  delete from pda_private.raw_production_context where transaction_id=txid_current();
  return result||jsonb_build_object('pdaRawUsage',usage);
end;
$$;
create function public.dbmt_label_cancel_production(p_pin text,p_work_order_id text,p_production_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;usage jsonb;
begin
  if public.dbmt_check_label_print_pin(p_pin) is not true then raise exception '라벨전용 PIN이 맞지 않습니다.';end if;
  perform pg_advisory_xact_lock(36100910);
  insert into pda_private.raw_production_context values(txid_current(),'cancel',p_production_id,p_work_order_id,null,
    coalesce((select jsonb_agg(jsonb_build_object('sourceId',t.raw->>'stockRowId','location',coalesce(nullif(t.stock_location,''),'가공장'),'weight',t.weight))
      from public.transactions t where coalesce(t.prod_id,t.raw->>'_prodId')=p_production_id and t.type='사용' and t.deleted_at is null),'[]'::jsonb));
  result:=pda_private.cancel_production_before_raw_use(p_pin,p_work_order_id,p_production_id);
  if result->>'ok'='true' then usage:=pda_private.sync_raw_production(p_production_id);end if;
  delete from pda_private.raw_production_context where transaction_id=txid_current();
  return result||jsonb_build_object('pdaRawUsage',usage);
end;
$$;
revoke all on function public.dbmt_label_complete_production_reviewed(text,text,jsonb,jsonb),
  public.dbmt_erp_save_production(text,jsonb,jsonb,text),public.dbmt_label_cancel_production(text,text,text) from public,anon,authenticated;
grant execute on function public.dbmt_label_complete_production_reviewed(text,text,jsonb,jsonb),
  public.dbmt_erp_save_production(text,jsonb,jsonb,text),public.dbmt_label_cancel_production(text,text,text) to anon,authenticated;

-- Random production bindings must not prevent a later scan of a real box.
-- Genuine PDA outbound may debit a used box once; existing negative-stock
-- handling reports the shortage. A shipped barcode remains non-repeatable.
do $patch$
declare d text;anchor text;
begin
  select pg_get_functiondef('pda_private.raw_commit_before_receipt_groups(text,uuid,text,text,uuid,date,jsonb,text,text,text,numeric,text)'::regprocedure) into d;
  anchor:='if pack.state<>''in_stock'' then raise exception ''이미 출고된 원료육 박스입니다.''; end if;';
  if position(anchor in d)=0 then raise exception 'Unexpected raw commit; production installation aborted.';end if;
  d:=replace(d,anchor,'if pack.state not in (''in_stock'',''used'') then raise exception ''이미 출고된 원료육 박스입니다.''; end if;');
  execute d;
end $patch$;
notify pgrst,'reload schema';
