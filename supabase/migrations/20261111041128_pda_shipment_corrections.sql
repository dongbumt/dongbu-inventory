-- Grant narrowly scoped customer edits without changing scanned boxes or their costs.
create table pda_private.shipment_edit_context(
  transaction_xid bigint not null,transaction_id text not null,
  primary key(transaction_xid,transaction_id)
);
alter table pda_private.shipment_edit_context enable row level security;
revoke all on pda_private.shipment_edit_context from public,anon,authenticated;

create function pda_private.correct_product_shipment(p_user uuid,p_row jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  shipment public.transactions%rowtype;partner public.business_partners%rowtype;
  unit_price numeric;updated jsonb;audit jsonb;
  editable text[]:=array['price','amount','trader','traderId','note','_serverAudit','_pdaShipmentEditRevision'];
  settled text[]:=array['stockUnitPrice','productionCost','productionCostAmount','_productionCostStatus',
    '_productionCostProductionId','_productionCostSourceId','_productionCostUpdatedAt','_pdaProvisional','stockRowId'];
begin
  perform pg_advisory_xact_lock(36100910);
  select * into shipment from public.transactions where id=p_row->>'id' and deleted_at is null
    and type='출고' and raw ? '_pdaRequestId' and raw ? '_pdaLabelId' for update;
  if not found then raise exception '수정할 PDA 제품 출고를 찾을 수 없습니다. 새로고침해주세요.';end if;
  if coalesce(p_row->>'_pdaShipmentEditRevision','0')!~'^[0-9]{1,9}$'
    or coalesce(p_row->>'_pdaShipmentEditRevision','0')<>coalesce(shipment.raw->>'_pdaShipmentEditRevision','0') then
    raise exception '다른 사용자가 출고를 수정했습니다. 새로고침한 뒤 다시 수정해주세요.';end if;
  if (p_row-editable-settled) is distinct from (shipment.raw-editable-settled) then
    raise exception 'PDA 제품 출고는 거래처·단가·비고만 수정할 수 있습니다. 품목·중량·바코드 연결은 유지해주세요.';end if;
  unit_price:=(p_row->>'price')::numeric;
  if unit_price is null or unit_price not between 0 and 1000000000 or length(coalesce(p_row->>'note',''))>500 then
    raise exception '출고 단가는 0 이상의 숫자로, 비고는 500자 이내로 입력해주세요.';end if;
  select * into partner from public.business_partners where name=btrim(p_row->>'trader')
    and ((active and trade_type in ('매출','매입/매출')) or (name=shipment.trader and id::text=shipment.raw->>'traderId'));
  if not found then raise exception '등록된 매출 또는 매입/매출 거래처를 선택해주세요.';end if;
  if (select count(*) from public.business_partners where name=partner.name and active and trade_type in ('매출','매입/매출'))>1 then
    raise exception '동일한 이름의 거래처가 여러 개입니다. 거래처 정보를 확인해주세요.';end if;
  select jsonb_build_object('authMode','personal_session','userId',p_user,'displayName',u.display_name,
    'loginId',u.login_id,'savedAt',clock_timestamp()) into audit from public.erp_users u where u.id=p_user;
  insert into pda_private.shipment_edit_context values(txid_current(),shipment.id);
  update public.transactions set price=unit_price,amount=round(weight*unit_price),trader=partner.name,
    note=coalesce(p_row->>'note',''),updated_at=clock_timestamp(),
    raw=raw||jsonb_build_object('price',unit_price,'amount',round(weight*unit_price),'trader',partner.name,
      'traderId',partner.id,'note',coalesce(p_row->>'note',''),
      '_pdaShipmentEditRevision',coalesce((raw->>'_pdaShipmentEditRevision')::integer,0)+1,'_serverAudit',audit)
    where id=shipment.id returning raw||jsonb_build_object('id',id) into updated;
  delete from pda_private.shipment_edit_context where transaction_xid=txid_current() and transaction_id=shipment.id;
  return updated;
end;
$$;
revoke all on function pda_private.correct_product_shipment(uuid,jsonb) from public,anon,authenticated;

do $patch$
declare d text;a text;b text;
begin
  select replace(pg_get_functiondef('pda_private.protect_transaction()'::regprocedure),E'\r\n',E'\n') into d;
  a:=$a$if old.type='출고' then v_columns:=v_columns||array['price','amount']; v_fields:=v_fields||array['price','amount']; end if;$a$;
  b:=a||$b$
    if old.type='출고' and exists(select 1 from pda_private.shipment_edit_context c
      where c.transaction_xid=txid_current() and c.transaction_id=old.id) then
      v_columns:=v_columns||array['trader'];v_fields:=v_fields||array['trader','traderId','_pdaShipmentEditRevision'];
    end if;
$b$;
  if position(a in d)=0 then raise exception 'Unexpected PDA product transaction guard';end if;
  execute replace(d,a,b);
end $patch$;

alter function public.dbmt_erp_save_transactions(text,jsonb,jsonb) rename to erp_save_transactions_before_shipment_corrections;
alter function public.erp_save_transactions_before_shipment_corrections(text,jsonb,jsonb) set schema pda_private;
revoke all on function pda_private.erp_save_transactions_before_shipment_corrections(text,jsonb,jsonb) from public,anon,authenticated;
create function public.dbmt_erp_save_transactions(p_token text,p_rows jsonb default '[]'::jsonb,p_delete_ids jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare usr uuid:=public.dbmt_erp_session_user(p_token);row jsonb;prior jsonb;ordinary jsonb:='[]'::jsonb;
  corrections jsonb:='[]'::jsonb;before_rows jsonb:='[]'::jsonb;result jsonb;sample jsonb;
begin
  if usr is null then return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.');end if;
  if jsonb_typeof(coalesce(p_rows,'[]'::jsonb)) is distinct from 'array'
    or jsonb_typeof(coalesce(p_delete_ids,'[]'::jsonb)) is distinct from 'array'
    or jsonb_array_length(coalesce(p_rows,'[]'::jsonb))>500 or jsonb_array_length(coalesce(p_delete_ids,'[]'::jsonb))>500 then
    raise exception '거래내역은 한 번에 500건까지 올바른 목록으로 처리해주세요.';end if;
  if exists(select 1 from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) r join public.transactions t
    on t.id=r->>'id' where t.deleted_at is null and t.type='출고' and t.raw ? '_pdaRequestId' and t.raw ? '_pdaLabelId')
    and public.dbmt_erp_has_permission(p_token,'transactions','update') is not true then
    return public.dbmt_erp_permission_denied(usr,'transactions','update');end if;
  if exists(select 1 from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) r group by r->>'id' having count(*)>1) then
    raise exception '같은 거래내역을 중복으로 수정할 수 없습니다.';end if;
  for row in select r from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) r loop
    if exists(select 1 from public.transactions t where t.id=row->>'id' and t.deleted_at is null
      and t.type='출고' and t.raw ? '_pdaRequestId' and t.raw ? '_pdaLabelId') then
      if exists(select 1 from jsonb_array_elements_text(coalesce(p_delete_ids,'[]'::jsonb)) d where d=row->>'id') then
        raise exception '같은 출고를 수정과 삭제로 동시에 요청할 수 없습니다.';end if;
      perform public.dbmt_erp_authorize_legacy(p_token,'transactions','update');
      perform pg_advisory_xact_lock(36100910);
      select raw into prior from public.transactions where id=row->>'id' for update;
      before_rows:=before_rows||jsonb_build_array(prior);
      corrections:=corrections||jsonb_build_array(pda_private.correct_product_shipment(usr,row));
    else ordinary:=ordinary||jsonb_build_array(row);end if;
  end loop;
  result:=pda_private.erp_save_transactions_before_shipment_corrections(p_token,ordinary,p_delete_ids);
  if result->>'ok' is distinct from 'true' and jsonb_array_length(corrections)>0 then
    raise exception '%',coalesce(result->>'message','거래내역 저장 권한을 확인해주세요.');end if;
  if jsonb_array_length(corrections)>0 then
    sample:=corrections->0;
    insert into public.change_logs(entity,action,entity_id,summary,payload) values('PDA 제품','출고 수정',sample->>'id',
      format('%s %s / 이력번호 %s / %s박스 / 거래처 %s → %s / 단가 %s → %s원',
        sample->>'date',sample->>'product',sample->>'lot',jsonb_array_length(corrections),
        before_rows->0->>'trader',sample->>'trader',before_rows->0->>'price',sample->>'price'),
      jsonb_build_object('before',before_rows,'after',corrections,'userId',usr));
  end if;
  return result||jsonb_build_object('updatedPdaShipments',corrections,
    'transactions',coalesce((result->>'transactions')::integer,0)+jsonb_array_length(corrections));
end;
$$;
revoke all on function public.dbmt_erp_save_transactions(text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.dbmt_erp_save_transactions(text,jsonb,jsonb) to anon,authenticated;
notify pgrst,'reload schema';
