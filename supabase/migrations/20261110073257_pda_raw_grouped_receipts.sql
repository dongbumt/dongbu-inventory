-- Keep one stock source per compatible receipt group, not per physical box.
-- Package identities and the original receipt rows remain in the private audit.
create table pda_private.raw_receipt_context (
  transaction_xid bigint not null, transaction_id text not null,
  primary key(transaction_xid,transaction_id)
);
create table pda_private.raw_receipt_changes (
  id uuid primary key default extensions.gen_random_uuid(),
  action text not null, source_id text not null, user_id uuid,
  before_rows jsonb not null, packages jsonb not null,
  created_at timestamptz not null default now()
);
alter table pda_private.raw_receipt_context enable row level security;
alter table pda_private.raw_receipt_changes enable row level security;
revoke all on pda_private.raw_receipt_context,pda_private.raw_receipt_changes from public,anon,authenticated;
alter table pda_private.raw_packages drop constraint raw_packages_state_check;
alter table pda_private.raw_packages add constraint raw_packages_state_check check(state in ('in_stock','shipped','cancelled'));

create function pda_private.raw_receipt_has_dependencies(p_sources text[],p_receipts text[])
returns boolean language sql stable security invoker set search_path='' as $$
  select exists(select 1 from public.transactions t where t.deleted_at is null
    and t.raw->>'stockRowId'=any(p_sources) and not(t.id=any(p_receipts)))
  or exists(select 1 from public.production_entries p where p.deleted_at is null
    and exists(select 1 from jsonb_array_elements(coalesce(p.raw->'inputs','[]'::jsonb)) i
      where i->>'stockRowId'=any(p_sources)))
  or exists(select 1 from public.app_data a cross join unnest(p_sources) s
    where a.key in ('workOrders','labelPrintLogs')
      and jsonb_path_exists(a.payload,'$.**.stockRowId ? (@ == $source)',jsonb_build_object('source',s)))
  or exists(select 1 from public.transactions t join public.transactions r on r.id=any(p_receipts)
    where t.deleted_at is null and t.type in ('출고','사용','재고이동','재고조정')
      and coalesce(t.raw->>'stockRowId','')='' and t.product=r.product
      and coalesce(t.lot,'')=coalesce(r.lot,'') and (t.date is null or t.date>=r.date));
$$;

-- A transaction-scoped allowlist cannot be supplied by a browser or a SQL GUC.
do $patch$
declare d text;
begin
  select replace(pg_get_functiondef('pda_private.protect_raw_stock()'::regprocedure),E'\r\n',E'\n') into d;
  if position(E'begin\n' in d)=0 then raise exception 'Unexpected raw stock guard';end if;
  d:=replace(d,E'begin\n',E'begin\n'||$body$
  if tg_op='UPDATE' and old.type='입고' and exists(select 1 from pda_private.raw_receipt_context c
    where c.transaction_xid=txid_current() and c.transaction_id=old.id) then return new;end if;
$body$);
  execute d;
end $patch$;

create function pda_private.raw_group_receipts(p_batch uuid)
returns integer language plpgsql security invoker set search_path='' as $$
declare
  g record; first_row public.transactions%rowtype; total_weight numeric; total_amount numeric;
  boxes jsonb; originals jsonb; packages jsonb; v_result jsonb; groups integer:=0;
begin
  perform pg_advisory_xact_lock(36100910);
  for g in
    select array_agg(t.id order by t.id) ids,array_agg(t.raw->>'stockRowId' order by t.id) sources
    from public.transactions t where t.deleted_at is null and t.type='입고'
      and t.raw->>'_pdaRawRequestId'=p_batch::text and t.raw->>'_pdaAction'='receive'
      and not(t.raw ? '_pdaRawBoxes')
    group by t.raw-array['id','weight','amount','boxCount','stockRowId','_pdaRawPackageId',
      '_pdaCode','_barcodeRule','_barcodeCalculatedWeight','_serverAudit']
    having count(*)>1
  loop
    if pda_private.raw_receipt_has_dependencies(g.sources,g.ids) then continue;end if;
    if exists(select 1 from pda_private.raw_packages p where p.source_id=any(g.sources)
      and (p.state<>'in_stock' or not exists(select 1 from pda_private.raw_events e
        where e.batch_id=p_batch and e.package_id=p.id and e.action='receive' and e.transaction_id=any(g.ids)))) then continue;end if;
    -- Only migrate untouched, one-box sources; do not guess at partially used history.
    if exists(select 1 from public.transactions t where t.id=any(g.ids) and
      ((t.raw->>'boxCount')::numeric<>1 or (select count(*) from pda_private.raw_packages p where p.source_id=t.raw->>'stockRowId')<>1
      or (select sum(p.weight) from pda_private.raw_packages p where p.source_id=t.raw->>'stockRowId') is distinct from t.weight)) then continue;end if;
    select * into first_row from public.transactions where id=g.ids[1] for update;
    select sum(t.weight),sum(t.amount),jsonb_agg(to_jsonb(t) order by t.id)
      into total_weight,total_amount,originals from public.transactions t where t.id=any(g.ids);
    select jsonb_agg(to_jsonb(p) order by p.id),jsonb_agg(jsonb_build_object('id',p.id,'barcode',p.barcode,
      'weight',p.weight,'originalTransactionId',t.id) order by t.id) into packages,boxes
      from pda_private.raw_packages p join public.transactions t on t.raw->>'stockRowId'=p.source_id where t.id=any(g.ids);
    insert into pda_private.raw_receipt_changes(action,source_id,before_rows,packages)
      values('group',first_row.raw->>'stockRowId',originals,packages);
    insert into pda_private.raw_receipt_context select txid_current(),unnest(g.ids);
    update public.transactions set weight=total_weight,amount=total_amount,
      raw=raw||jsonb_build_object('weight',total_weight,'amount',total_amount,'boxCount',cardinality(g.ids),
        '_pdaRawBoxes',boxes,'_pdaRawMergedIds',to_jsonb(g.ids[2:cardinality(g.ids)])),updated_at=clock_timestamp()
      where id=first_row.id;
    update pda_private.raw_packages set source_id=first_row.raw->>'stockRowId',revision=revision+1,updated_at=clock_timestamp()
      where source_id=any(g.sources);
    update public.transactions set deleted_at=clock_timestamp(),updated_at=clock_timestamp(),
      raw=raw||jsonb_build_object('_pdaRawMergedInto',first_row.id) where id=any(g.ids) and id<>first_row.id;
    delete from pda_private.raw_receipt_context where transaction_xid=txid_current() and transaction_id=any(g.ids);
    -- Keep event transaction IDs as the original per-box audit trail. API results point to the active receipt.
    select b.result into v_result from pda_private.raw_batches b where b.id=p_batch;
    update pda_private.raw_batches set result=v_result||jsonb_build_object('items',
      (select jsonb_agg(case when i->>'transactionId'=any(g.ids) then i||jsonb_build_object(
        'originalTransactionId',i->>'transactionId','transactionId',first_row.id,'stockRowId',first_row.raw->>'stockRowId') else i end order by n)
        from jsonb_array_elements(v_result->'items') with ordinality a(i,n))) where id=p_batch;
    groups:=groups+1;
    insert into public.change_logs(entity,action,entity_id,summary,payload) values('PDA 원료육','입고 합산',first_row.id,
      format('%s %s / 이력번호 %s / %s박스 / %sKG',first_row.date,first_row.product,first_row.lot,cardinality(g.ids),total_weight),
      jsonb_build_object('batchId',p_batch,'receiptId',first_row.id,'originalIds',g.ids,'weight',total_weight,'amount',total_amount));
  end loop;
  return groups;
end;
$$;

-- Preserve the validated barcode parser/commit implementation and all its checks.
alter function public.dbmt_pda_raw_commit(text,uuid,text,text,uuid,date,jsonb,text,text,text,numeric,text)
  rename to raw_commit_before_receipt_groups;
alter function public.raw_commit_before_receipt_groups(text,uuid,text,text,uuid,date,jsonb,text,text,text,numeric,text)
  set schema pda_private;
revoke all on function pda_private.raw_commit_before_receipt_groups(text,uuid,text,text,uuid,date,jsonb,text,text,text,numeric,text) from public,anon,authenticated;
do $patch$
declare d text;a text;b text;
begin
  select replace(pg_get_functiondef('pda_private.raw_commit_before_receipt_groups(text,uuid,text,text,uuid,date,jsonb,text,text,text,numeric,text)'::regprocedure),E'\r\n',E'\n') into d;
  a:='if pack.id is not null then raise exception ''이미 등록한 원료육 바코드입니다.';
  b:='if pack.id is not null and pack.state<>''cancelled'' then raise exception ''이미 등록한 원료육 바코드입니다.';
  if position(a in d)=0 then raise exception 'Unexpected duplicate receipt guard';end if;d:=replace(d,a,b);
  a:='on conflict(id) do update set state=excluded.state,work_date=excluded.work_date,revision=pda_private.raw_packages.revision+1,updated_at=clock_timestamp();';
  b:='on conflict(id) do update set state=excluded.state,work_date=excluded.work_date,revision=pda_private.raw_packages.revision+1,updated_at=clock_timestamp(),
        product_id=excluded.product_id,snapshot=excluded.snapshot,weight=excluded.weight,source_id=excluded.source_id,location=excluded.location;';
  if position(a in d)=0 then raise exception 'Unexpected raw package upsert';end if;execute replace(d,a,b);
  select replace(pg_get_functiondef('public.dbmt_pda_raw_lookup(text,text,text)'::regprocedure),E'\r\n',E'\n') into d;
  if position('if found then' in d)=0 or position('''revision'',0' in d)=0 then raise exception 'Unexpected raw lookup';end if;
  d:=replace(d,'if found then','if found and pack.state<>''cancelled'' then');
  d:=replace(d,'v_parsed||pack.snapshot||','v_parsed||(pack.snapshot-''id'')||');
  d:=replace(d,'''registered'',false,''revision'',0','''registered'',false,''revision'',coalesce(pack.revision,0)');execute d;
end $patch$;

create function public.dbmt_pda_raw_commit(p_token text,p_request_id uuid,p_mode text,p_location text,
  p_trader_id uuid,p_date date,p_items jsonb,p_product_id text default null,p_lot text default '',
  p_source_id text default null,p_price numeric default 0,p_note text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  result:=pda_private.raw_commit_before_receipt_groups(p_token,p_request_id,p_mode,p_location,p_trader_id,p_date,
    p_items,p_product_id,p_lot,p_source_id,p_price,p_note);
  if result->>'alreadySaved'='true' then return result;end if;
  if p_mode='inbound' and coalesce(p_source_id,'')='' then
    perform pda_private.raw_group_receipts(p_request_id);
    select b.result into result from pda_private.raw_batches b where b.id=p_request_id;
  end if;
  return result;
end;
$$;
revoke all on function public.dbmt_pda_raw_commit(text,uuid,text,text,uuid,date,jsonb,text,text,text,numeric,text) from public,anon,authenticated;
grant execute on function public.dbmt_pda_raw_commit(text,uuid,text,text,uuid,date,jsonb,text,text,text,numeric,text) to anon,authenticated;

-- Use the normal ERP delete API, so the PC and mobile flows have identical safeguards.
alter function public.dbmt_erp_save_transactions(text,jsonb,jsonb) rename to erp_save_transactions_before_raw_receipts;
alter function public.erp_save_transactions_before_raw_receipts(text,jsonb,jsonb) set schema pda_private;
revoke all on function pda_private.erp_save_transactions_before_raw_receipts(text,jsonb,jsonb) from public,anon,authenticated;
create function public.dbmt_erp_save_transactions(p_token text,p_rows jsonb default '[]'::jsonb,p_delete_ids jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  usr uuid:=public.dbmt_erp_session_user(p_token); receipt public.transactions%rowtype;
  ids text[]; sources text[]; packages jsonb; result jsonb; cancelled jsonb:='[]'::jsonb;
begin
  if usr is null then return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.');end if;
  if jsonb_typeof(coalesce(p_rows,'[]'::jsonb)) is distinct from 'array'
    or jsonb_typeof(coalesce(p_delete_ids,'[]'::jsonb)) is distinct from 'array'
    or jsonb_array_length(coalesce(p_rows,'[]'::jsonb))>500 or jsonb_array_length(coalesce(p_delete_ids,'[]'::jsonb))>500 then
    raise exception '거래내역은 한 번에 500건까지 올바른 목록으로 처리해주세요.';end if;
  if jsonb_array_length(coalesce(p_delete_ids,'[]'::jsonb))>0 then
    if public.dbmt_erp_has_permission(p_token,'transactions','delete') is not true then
      return public.dbmt_erp_permission_denied(usr,'transactions','delete');end if;
    perform pg_advisory_xact_lock(36100910);
    if exists(select 1 from public.transactions t where t.deleted_at is not null and t.raw ? '_pdaRawMergedInto'
      and t.id in(select jsonb_array_elements_text(p_delete_ids))) then
      raise exception '합산된 입고입니다. 새로고침한 뒤 합계 입고 행에서 삭제해주세요.';end if;
    for receipt in select t.* from public.transactions t where t.deleted_at is null and t.type='입고'
      and t.raw ? '_pdaRawRequestId' and t.raw->>'_pdaAction'='receive'
      and t.id in(select jsonb_array_elements_text(p_delete_ids)) order by t.id for update
    loop
      if exists(select 1 from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) r where r->>'id'=receipt.id) then
        raise exception '같은 입고를 수정과 삭제로 동시에 요청할 수 없습니다.';end if;
      ids:=array[receipt.id];sources:=array[receipt.raw->>'stockRowId'];
      if coalesce(sources[1],'')='' or pda_private.raw_receipt_has_dependencies(sources,ids)
        or exists(select 1 from pda_private.raw_packages p where p.source_id=sources[1] and p.state<>'in_stock') then
        raise exception '이미 출고·생산 사용·이동 또는 작업지시에 연결된 PDA 입고는 삭제할 수 없습니다. 연결 내역을 먼저 확인해주세요.';end if;
      select jsonb_agg(to_jsonb(p) order by p.id) into packages from pda_private.raw_packages p where p.source_id=sources[1];
      if packages is null or (select sum(p.weight) from pda_private.raw_packages p where p.source_id=sources[1]) is distinct from receipt.weight then
        raise exception '입고 중량과 바코드 연결을 확인할 수 없어 삭제하지 않았습니다.';end if;
      insert into pda_private.raw_receipt_changes(action,source_id,user_id,before_rows,packages)
        values('cancel',sources[1],usr,jsonb_build_array(to_jsonb(receipt)),packages);
      insert into pda_private.raw_receipt_context values(txid_current(),receipt.id);
      update pda_private.raw_packages set state='cancelled',revision=revision+1,updated_at=clock_timestamp() where source_id=sources[1];
      update pda_private.raw_batches b set result=b.result||jsonb_build_object('cancelledTransactionIds',
        coalesce(b.result->'cancelledTransactionIds','[]'::jsonb)||jsonb_build_array(receipt.id))
        where b.id::text=receipt.raw->>'_pdaRawRequestId';
      cancelled:=cancelled||jsonb_build_array(receipt.id);
      insert into public.change_logs(entity,action,entity_id,summary,payload) values('PDA 원료육','입고 삭제',receipt.id,
        format('%s %s / 이력번호 %s / %s박스 / %sKG',receipt.date,receipt.product,receipt.lot,jsonb_array_length(packages),receipt.weight),
        jsonb_build_object('userId',usr,'receiptId',receipt.id,'stockRowId',sources[1],'boxCount',jsonb_array_length(packages),'weight',receipt.weight));
    end loop;
  end if;
  result:=pda_private.erp_save_transactions_before_raw_receipts(p_token,p_rows,p_delete_ids);
  -- Any failure must roll back package cancellations as well as transaction changes.
  if result->>'ok' is distinct from 'true' then raise exception '%',coalesce(result->>'message','거래내역 저장 권한을 확인해주세요.');end if;
  delete from pda_private.raw_receipt_context where transaction_xid=txid_current();
  return result||jsonb_build_object('cancelledRawReceipts',cancelled);
end;
$$;
revoke all on function public.dbmt_erp_save_transactions(text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.dbmt_erp_save_transactions(text,jsonb,jsonb) to anon,authenticated;
revoke all on function pda_private.raw_receipt_has_dependencies(text[],text[]),pda_private.raw_group_receipts(uuid) from public,anon,authenticated;

-- Backfill only unused compatible receipts. No product labels, used sources, or quantities are discarded.
do $backfill$
declare batch uuid;
begin
  for batch in select b.id from pda_private.raw_batches b where b.request->>'mode'='inbound'
    and coalesce(b.request->>'sourceId','')='' order by b.id loop
    perform pda_private.raw_group_receipts(batch);
  end loop;
end $backfill$;
notify pgrst,'reload schema';
