-- Regroup issued labels without changing physical stock or their shipment state.
-- Only this authenticated RPC can create the transaction-scoped capability.
create table label_stock_private.pda_split_context(
  transaction_xid bigint primary key,production_id text not null,
  source_id text not null,target_id text not null,label_ids jsonb not null,
  expected_entry jsonb not null
);
alter table label_stock_private.pda_split_context enable row level security;
revoke all on label_stock_private.pda_split_context from public,anon,authenticated;

create function label_stock_private.pda_split_problem(p_production text,p_source text)
returns text language plpgsql stable security invoker set search_path='' as $$
begin
  if exists(select 1 from public.pda_packages p where p.production_id=p_production
    and p.original_stock_row_id=p_source and (p.state='split' or exists(
      select 1 from pda_private.weight_split_labels c where c.label_id=p.label_id))) then
    return '중량분할한 바코드가 포함된 생산품은 이 화면에서 행 분할할 수 없습니다. 중량분할 이력을 확인해주세요.';
  end if;
  if exists(with assignments as materialized(select * from label_stock_private.assignments(p_production))
    select 1 from public.pda_packages p where p.production_id=p_production and p.original_stock_row_id=p_source
    and not exists(select 1 from assignments a
      where a.problem is null and a.stock_row_id=p_source and a.label->>'id'=p.label_id
        and a.label->>'code'=p.code and a.label->'workOrderSnapshot'=p.label_snapshot
        and public.dbmt_safe_numeric(a.label->>'labelWeight')=p.weight)) then
    return 'PDA 바코드와 생산품 라벨 연결정보가 일치하지 않습니다. 최신 내역을 확인해주세요.';
  end if;
  return null;
end;
$$;

create function label_stock_private.save_pda_split(p_token text,p_entry jsonb,p_production text,
  p_source text,p_target text,p_ids jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  actor uuid:=public.dbmt_erp_session_user(p_token);old_entry jsonb;receipt public.transactions%rowtype;
  remaining jsonb;selected jsonb;new_raw jsonb;new_id text:='tx_label_group_'||replace(extensions.gen_random_uuid()::text,'-','');
  stamp timestamptz:=clock_timestamp();
begin
  if actor is null or public.dbmt_erp_has_permission(p_token,'production','update') is not true then
    raise exception using errcode='42501',message='생산일보 수정 권한이 필요합니다.';end if;
  select raw into old_entry from public.production_entries where id=p_production and deleted_at is null for update;
  select o into remaining from jsonb_array_elements(p_entry->'outputs') o where o->>'stockRowId'=p_source;
  select o into selected from jsonb_array_elements(p_entry->'outputs') o where o->>'stockRowId'=p_target;
  if old_entry is null or (old_entry-'outputs') is distinct from (p_entry-'outputs')
    or remaining is null or selected is null or p_source=p_target then raise exception '생산품 분할 정보를 확인해주세요.';end if;
  select * into strict receipt from public.transactions where deleted_at is null and type='생산입고'
    and coalesce(prod_id,raw->>'_prodId')=p_production and raw->>'stockRowId'=p_source for update;
  insert into label_stock_private.pda_split_context values(txid_current(),p_production,p_source,p_target,p_ids,p_entry);
  insert into pda_private.product_cost_context values(txid_current(),p_production,'edit',actor);
  -- Do not replace the journal: unchanged input postings and all other output IDs stay exact.
  update public.production_entries set raw=p_entry,updated_at=stamp where id=p_production;
  update public.transactions set weight=(remaining->>'qty')::numeric,amount=(remaining->>'amount')::numeric,
    raw=raw||jsonb_build_object('weight',remaining->'qty','amount',remaining->'amount','boxCount',remaining->'boxCount')
      ||case when raw ? 'productionCostAmount' then jsonb_build_object('productionCostAmount',round(price*(remaining->>'qty')::numeric)) else '{}'::jsonb end,
    updated_at=stamp where id=receipt.id;
  new_raw:=receipt.raw||jsonb_build_object('id',new_id,'stockRowId',p_target,'weight',selected->'qty',
    'amount',selected->'amount','boxCount',selected->'boxCount');
  if new_raw ? '_productionCostSourceId' then new_raw:=new_raw||jsonb_build_object('_productionCostSourceId',p_target);end if;
  if new_raw ? 'productionCostAmount' then new_raw:=new_raw||jsonb_build_object('productionCostAmount',round(receipt.price*(selected->>'qty')::numeric));end if;
  insert into public.transactions select (jsonb_populate_record(null::public.transactions,to_jsonb(receipt)||jsonb_build_object(
    'id',new_id,'weight',selected->'qty','amount',selected->'amount','raw',new_raw,'updated_at',stamp))).*;
  -- Returns retain their own receipt source; only their original production/cost attribution moves.
  update public.pda_packages set original_stock_row_id=p_target,
    source_stock_row_id=case when source_stock_row_id=p_source then p_target else source_stock_row_id end,
    revision=revision+1,updated_at=stamp
    where production_id=p_production and original_stock_row_id=p_source and p_ids ? label_id;
  update public.transactions set raw=raw
    ||case when raw->>'stockRowId'=p_source then jsonb_build_object('stockRowId',p_target) else '{}'::jsonb end
    ||case when raw->>'_productionCostSourceId'=p_source then jsonb_build_object('_productionCostSourceId',p_target) else '{}'::jsonb end,
    updated_at=stamp
    where deleted_at is null and p_ids ? (raw->>'_pdaLabelId')
      and (raw->>'stockRowId'=p_source or raw->>'_productionCostSourceId'=p_source);
  perform pda_private.sync_product_costs(p_production);
  delete from pda_private.product_cost_context where transaction_id=txid_current();
  delete from label_stock_private.pda_split_context where transaction_xid=txid_current();
  return jsonb_build_object('ok',true);
end;
$$;

create function label_stock_private.linked_transactions(p_token text,p_production text)
returns jsonb language sql stable security invoker set search_path='' as $$
  select case when public.dbmt_erp_has_permission(p_token,'transactions','view') then
    coalesce((select jsonb_agg(t.raw order by t.id) from public.transactions t
      join public.pda_packages p on p.label_id=t.raw->>'_pdaLabelId'
      where t.deleted_at is null and t.raw ? '_pdaLabelId' and p.production_id=p_production),
      '[]'::jsonb) else '[]'::jsonb end;
$$;

do $patch$
declare d text;a text;b text;
begin
  select replace(pg_get_functiondef('label_stock_private.snapshot(text,text)'::regprocedure),E'\r\n',E'\n') into d;
  a:=$a$and not(type='생산입고' and coalesce(prod_id,raw->>'_prodId','')=p_production_id))$a$;
  b:=$b$and not(type='생산입고' and coalesce(prod_id,raw->>'_prodId','')=p_production_id)
    and not(t.type in ('출고','입고','재고이동') and exists(select 1 from public.pda_packages p
      where p.label_id=t.raw->>'_pdaLabelId' and p.production_id=p_production_id
        and p.original_stock_row_id=p_stock_row_id and t.raw ? '_pdaRequestId')))$b$;
  if position(a in d)=0 then raise exception 'Unexpected split dependency guard';end if;d:=replace(d,a,b);
  a:=$a$if exists(select 1 from public.pda_packages where production_id=p_production_id) then
    v_reason:='PDA로 처리한 라벨이 연결된 생산일보는 분할할 수 없습니다.';
  end if;$a$;
  b:=$b$if v_reason is null then v_reason:=label_stock_private.pda_split_problem(p_production_id,p_stock_row_id);end if;$b$;
  if position(a in d)=0 then raise exception 'Unexpected split PDA guard';end if;d:=replace(d,a,b);
  a:=$a$'batchId',coalesce(e#>>'{label,batchId}',''),'copyNo',e#>'{label,copyNo}')$a$;
  b:=$b$'batchId',coalesce(e#>>'{label,batchId}',''),'copyNo',e#>'{label,copyNo}',
      'pdaState',(select p.state from public.pda_packages p where p.label_id=e#>>'{label,id}'))$b$;
  if position(a in d)=0 then raise exception 'Unexpected split label fields';end if;d:=replace(d,a,b);
  a:=$a$'completion',to_jsonb(v_completion),'labels',v_labels,'posting',v_all,$a$;
  b:=a||$b$
    'packages',(select coalesce(jsonb_agg(to_jsonb(p) order by p.label_id),'[]'::jsonb)
      from public.pda_packages p where p.production_id=p_production_id and p.original_stock_row_id=p_stock_row_id),
    'movements',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb)
      from (select t.* from public.transactions t where t.deleted_at is null and t.raw->>'stockRowId'=p_stock_row_id
        union select t.* from public.transactions t join public.pda_packages p on p.label_id=t.raw->>'_pdaLabelId'
          where t.deleted_at is null and t.raw ? '_pdaLabelId' and p.production_id=p_production_id
            and p.original_stock_row_id=p_stock_row_id) t),$b$;
  if position(a in d)=0 then raise exception 'Unexpected split version';end if;execute replace(d,a,b);

  select pg_get_functiondef('pda_private.protect_production()'::regprocedure) into d;
  a:=E'begin\n';b:=a||$b$  if tg_op='UPDATE' and new.deleted_at is null and exists(
    select 1 from label_stock_private.pda_split_context c where c.transaction_xid=txid_current()
      and c.production_id=old.id and new.id=old.id and new.raw=c.expected_entry) then return new;end if;
$b$;
  execute replace(d,a,b);

  select pg_get_functiondef('pda_private.protect_transaction()'::regprocedure) into d;
  a:=$a$if tg_op='UPDATE' and old.raw ? '_pdaRequestId' then$a$;
  b:=a||$b$
    if exists(select 1 from label_stock_private.pda_split_context c where c.transaction_xid=txid_current()
      and c.label_ids ? (old.raw->>'_pdaLabelId')
      and (new.raw->>'stockRowId' is not distinct from old.raw->>'stockRowId'
        or (old.raw->>'stockRowId'=c.source_id and new.raw->>'stockRowId'=c.target_id))) then
      v_fields:=v_fields||array['stockRowId','_productionCostSourceId'];end if;
$b$;
  if position(a in d)=0 then raise exception 'Unexpected PDA movement guard';end if;execute replace(d,a,b);

  select pg_get_functiondef('pda_private.protect_registered_stock()'::regprocedure) into d;
  a:=E'begin\n';b:=a||$b$  if tg_op<>'DELETE' and exists(select 1 from label_stock_private.pda_split_context c
    where c.transaction_xid=txid_current() and (
      (new.prod_id=c.production_id and new.type='생산입고' and new.raw->>'stockRowId' in(c.source_id,c.target_id))
      or (tg_op='UPDATE' and c.label_ids ? (old.raw->>'_pdaLabelId') and new.raw->>'_pdaLabelId'=old.raw->>'_pdaLabelId')))
    then return new;end if;
$b$;
  execute replace(d,a,b);

  select pg_get_functiondef('public.dbmt_erp_split_label_stock(text,text,text,jsonb,text,uuid)'::regprocedure) into d;
  a:=$a$v_result:=public.dbmt_erp_save_production(p_token,v_entry,'[]'::jsonb,p_production_id);$a$;
  b:=$b$if exists(select 1 from public.pda_packages where production_id=p_production_id) then
    v_result:=label_stock_private.save_pda_split(p_token,v_entry,p_production_id,p_stock_row_id,v_new_row_id,v_ids);
  else
    v_result:=public.dbmt_erp_save_production(p_token,v_entry,'[]'::jsonb,p_production_id);
  end if;$b$;
  if position(a in d)=0 then raise exception 'Unexpected production split writer';end if;execute replace(d,a,b);
  select pg_get_functiondef('public.dbmt_erp_split_label_stock(text,text,text,jsonb,text,uuid)'::regprocedure) into d;
  a:=$a$'entry',(select raw from public.production_entries where id=p_production_id and deleted_at is null),$a$;
  b:=a||E'\n      ''linkedTransactions'',label_stock_private.linked_transactions(p_token,p_production_id),';
  if position(a in d)=0 then raise exception 'Unexpected split retry result';end if;d:=replace(d,a,b);
  a:=$a$insert into public.label_stock_split_requests(id,user_id,production_id,request,result)$a$;
  b:=$b$v_result:=v_result||jsonb_build_object('linkedTransactions',label_stock_private.linked_transactions(p_token,p_production_id));
  $b$||a;
  if position(a in d)=0 then raise exception 'Unexpected split result';end if;execute replace(d,a,b);
end;
$patch$;
revoke all on all functions in schema label_stock_private from public,anon,authenticated;
notify pgrst,'reload schema';
