-- Keep immutable scan history while cancelling only the latest physical shipment.
create table pda_private.product_shipment_cancellations(
  transaction_id text primary key references public.transactions(id),
  event_id uuid not null unique references public.pda_package_events(id),
  batch_id uuid not null references public.pda_batches(id),
  user_id uuid not null references public.erp_users(id),
  transaction_xid bigint not null,
  before_transaction jsonb not null,before_package jsonb not null,after_package jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create index product_shipment_cancellations_batch on pda_private.product_shipment_cancellations(batch_id);
create index product_shipment_cancellations_user on pda_private.product_shipment_cancellations(user_id);
alter table pda_private.product_shipment_cancellations enable row level security;
revoke all on pda_private.product_shipment_cancellations from public,anon,authenticated;

create function pda_private.cancel_product_shipment(p_user uuid,p_id text)
returns text language plpgsql security invoker set search_path='' as $$
declare shipment public.transactions%rowtype;pack public.pda_packages%rowtype;
  event public.pda_package_events%rowtype;latest uuid;stamp timestamptz;after_pack jsonb;restore_location text;
begin
  perform pg_advisory_xact_lock(36100910);
  select * into shipment from public.transactions where id=p_id and type='출고'
    and raw ? '_pdaRequestId' and raw ? '_pdaLabelId' for update;
  if not found then raise exception '삭제할 PDA 제품 출고를 찾을 수 없습니다. 새로고침해주세요.';end if;
  if shipment.deleted_at is not null then
    if exists(select 1 from pda_private.product_shipment_cancellations where transaction_id=p_id) then return p_id;end if;
    raise exception '이미 삭제된 출고입니다. 새로고침해주세요.';
  end if;
  select * into pack from public.pda_packages where label_id=shipment.raw->>'_pdaLabelId' for update;
  select * into event from public.pda_package_events where transaction_id=p_id and action='ship';
  if pack.label_id is null or event.id is null or event.label_id<>pack.label_id
    or event.batch_id::text is distinct from shipment.raw->>'_pdaRequestId'
    or pack.state<>'shipped' or pack.weight is distinct from shipment.weight
    or pack.code is distinct from shipment.raw->>'_pdaCode'
    or pack.source_stock_row_id is distinct from shipment.raw->>'stockRowId'
    or pack.location is distinct from coalesce(nullif(shipment.stock_location,''),'가공장') then
    raise exception '이미 반입했거나 바코드·재고 연결 상태가 달라진 출고입니다. 후속 처리 내역을 먼저 확인해주세요.';end if;
  select e.id into latest from public.pda_package_events e where e.label_id=pack.label_id
    and not exists(select 1 from pda_private.product_shipment_cancellations c where c.event_id=e.id)
    order by (e.after_state->>'revision')::integer desc,e.created_at desc,e.id desc limit 1;
  if latest is distinct from event.id then
    raise exception '반입·재출고 등 후속 처리 내역이 있는 출고는 삭제할 수 없습니다. 최신 처리부터 확인해주세요.';end if;
  restore_location:=nullif(event.before_state->>'location','');
  if restore_location is null then
    select coalesce(nullif(t.stock_location,''),'가공장') into restore_location from public.transactions t
      where t.deleted_at is null and t.type in ('입고','생산입고') and t.raw->>'stockRowId'=pack.source_stock_row_id;
  end if;
  restore_location:=coalesce(restore_location,case when pack.production_id is null then '가공장' else pack.location end);
  stamp:=clock_timestamp();
  after_pack:=to_jsonb(pack)||jsonb_build_object('state','in_stock','location',restore_location,'revision',pack.revision+1,'updated_at',stamp);
  insert into pda_private.product_shipment_cancellations(transaction_id,event_id,batch_id,user_id,transaction_xid,
    before_transaction,before_package,after_package)
    values(p_id,event.id,event.batch_id,p_user,txid_current(),to_jsonb(shipment),to_jsonb(pack),after_pack);
  update public.transactions set deleted_at=stamp,updated_at=stamp,
    raw=raw||jsonb_build_object('_pdaShipmentCancelledAt',stamp,'_pdaShipmentCancelledBy',p_user) where id=p_id;
  -- Keep the current source: production completion may have replaced a pending source.
  update public.pda_packages set state='in_stock',location=restore_location,revision=revision+1,updated_at=stamp where label_id=pack.label_id;
  update public.pda_batches set result=result||jsonb_build_object('cancelledTransactionIds',
    coalesce(result->'cancelledTransactionIds','[]'::jsonb)||jsonb_build_array(p_id)) where id=event.batch_id;
  return p_id;
end;
$$;
revoke all on function pda_private.cancel_product_shipment(uuid,text) from public,anon,authenticated;

do $patch$
declare d text;a text;b text;
begin
  select replace(pg_get_functiondef('pda_private.protect_transaction()'::regprocedure),E'\r\n',E'\n') into d;
  a:=$a$if tg_op='UPDATE' and old.raw ? '_pdaRequestId' then$a$;
  b:=a||$b$
    if old.type='출고' and old.deleted_at is null and new.deleted_at is not null and exists(
      select 1 from pda_private.product_shipment_cancellations c where c.transaction_id=old.id and c.transaction_xid=txid_current()) then
      v_columns:=v_columns||array['deleted_at'];v_fields:=v_fields||array['_pdaShipmentCancelledAt','_pdaShipmentCancelledBy'];
    end if;
$b$;
  if position(a in d)=0 then raise exception 'Unexpected PDA product transaction guard';end if;execute replace(d,a,b);
  select replace(pg_get_functiondef('pda_private.protect_registered_stock()'::regprocedure),E'\r\n',E'\n') into d;
  if position(E'begin\n' in d)=0 then raise exception 'Unexpected PDA product stock guard';end if;
  execute replace(d,E'begin\n',E'begin\n'||$b$
  if tg_op='UPDATE' and old.type='출고' and old.deleted_at is null and new.deleted_at is not null and exists(
    select 1 from pda_private.product_shipment_cancellations c where c.transaction_id=old.id and c.transaction_xid=txid_current()) then return new;end if;
$b$);
  select replace(pg_get_functiondef('public.dbmt_pda_commit(text,uuid,text,text,uuid,date,jsonb,text)'::regprocedure),E'\r\n',E'\n') into d;
  a:=$a$where e.label_id=v_data->>'labelId' and (b.request->>'date')::date>p_date$a$;
  b:=a||' and not exists(select 1 from pda_private.product_shipment_cancellations c where c.event_id=e.id)';
  if position(a in d)=0 then raise exception 'Unexpected PDA product movement date guard';end if;execute replace(d,a,b);
end $patch$;

alter function public.dbmt_erp_save_transactions(text,jsonb,jsonb) rename to erp_save_transactions_before_shipment_cancellations;
alter function public.erp_save_transactions_before_shipment_cancellations(text,jsonb,jsonb) set schema pda_private;
revoke all on function pda_private.erp_save_transactions_before_shipment_cancellations(text,jsonb,jsonb) from public,anon,authenticated;
create function public.dbmt_erp_save_transactions(p_token text,p_rows jsonb default '[]'::jsonb,p_delete_ids jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare usr uuid:=public.dbmt_erp_session_user(p_token);shipment public.transactions%rowtype;
  ordinary_deletes jsonb;cancelled jsonb:='[]'::jsonb;before_rows jsonb:='[]'::jsonb;result jsonb;sample jsonb;
begin
  if usr is null then return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.');end if;
  if jsonb_typeof(coalesce(p_rows,'[]'::jsonb)) is distinct from 'array'
    or jsonb_typeof(coalesce(p_delete_ids,'[]'::jsonb)) is distinct from 'array'
    or jsonb_array_length(coalesce(p_rows,'[]'::jsonb))>500 or jsonb_array_length(coalesce(p_delete_ids,'[]'::jsonb))>500 then
    raise exception '거래내역은 한 번에 500건까지 올바른 목록으로 처리해주세요.';end if;
  if exists(select 1 from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) r
    join pda_private.product_shipment_cancellations c on c.transaction_id=r->>'id') then
    raise exception '삭제된 PDA 출고는 재사용할 수 없습니다. 바코드를 다시 조회하여 신규 출고해주세요.';end if;
  if jsonb_array_length(coalesce(p_delete_ids,'[]'::jsonb))>0 then
    if public.dbmt_erp_has_permission(p_token,'transactions','delete') is not true then
      return public.dbmt_erp_permission_denied(usr,'transactions','delete');end if;
    perform public.dbmt_erp_authorize_legacy(p_token,'transactions','delete');
    perform pg_advisory_xact_lock(36100910);
    for shipment in select t.* from public.transactions t where t.id in(select jsonb_array_elements_text(p_delete_ids))
      and t.type='출고' and t.raw ? '_pdaRequestId' and t.raw ? '_pdaLabelId' order by t.id for update
    loop
      if exists(select 1 from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) r where r->>'id'=shipment.id) then
        raise exception '같은 출고를 수정과 삭제로 동시에 요청할 수 없습니다.';end if;
      if shipment.deleted_at is null then before_rows:=before_rows||jsonb_build_array(shipment.raw);end if;
      cancelled:=cancelled||jsonb_build_array(pda_private.cancel_product_shipment(usr,shipment.id));
    end loop;
  end if;
  select coalesce(jsonb_agg(d),'[]'::jsonb) into ordinary_deletes from jsonb_array_elements(coalesce(p_delete_ids,'[]'::jsonb)) d
    where not(cancelled ? (d#>>'{}'));
  result:=pda_private.erp_save_transactions_before_shipment_cancellations(p_token,p_rows,ordinary_deletes);
  if result->>'ok' is distinct from 'true' and jsonb_array_length(cancelled)>0 then
    raise exception '%',coalesce(result->>'message','거래내역 저장 권한을 확인해주세요.');end if;
  if jsonb_array_length(before_rows)>0 then
    sample:=before_rows->0;
    insert into public.change_logs(entity,action,entity_id,summary,payload) values('PDA 제품','출고 삭제',sample->>'id',
      format('%s %s / 거래처 %s / 이력번호 %s / %s박스 · %sKG 출고 취소',sample->>'date',sample->>'product',
        sample->>'trader',sample->>'lot',jsonb_array_length(before_rows),
        (select sum((r->>'weight')::numeric) from jsonb_array_elements(before_rows) r)),
      jsonb_build_object('userId',usr,'transactionIds',cancelled,'before',before_rows));
  end if;
  return result||jsonb_build_object('cancelledPdaShipments',cancelled);
end;
$$;
revoke all on function public.dbmt_erp_save_transactions(text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.dbmt_erp_save_transactions(text,jsonb,jsonb) to anon,authenticated;
notify pgrst,'reload schema';
