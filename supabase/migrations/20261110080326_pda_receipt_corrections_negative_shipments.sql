-- Correct receipt book values without inventing different weights inside scanned barcodes.
create function pda_private.correct_raw_receipt(p_user uuid,p_row jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  receipt public.transactions%rowtype; partner public.business_partners%rowtype;
  kg numeric; unit_price numeric; scanned numeric; packages jsonb; updated jsonb; audit jsonb;
  editable text[]:=array['weight','price','amount','trader','traderId','note','_serverAudit','_pdaRawEditRevision'];
begin
  perform pg_advisory_xact_lock(36100910);
  select * into receipt from public.transactions where id=p_row->>'id' and deleted_at is null
    and type='입고' and raw ? '_pdaRawRequestId' and raw->>'_pdaAction'='receive' for update;
  if not found then raise exception '수정할 PDA 원료육 입고를 찾을 수 없습니다. 새로고침해주세요.';end if;
  if coalesce(p_row->>'_pdaRawEditRevision','0')!~'^[0-9]{1,9}$'
    or coalesce(p_row->>'_pdaRawEditRevision','0')<>coalesce(receipt.raw->>'_pdaRawEditRevision','0') then
    raise exception '다른 사용자가 입고를 수정했습니다. 새로고침한 뒤 다시 수정해주세요.';end if;
  if (p_row-editable) is distinct from (receipt.raw-editable) then
    raise exception 'PDA 입고는 입고처·단가·합계중량·비고를 수정할 수 있습니다. 품목·이력번호·박스수·지점은 기존 연결을 유지해주세요.';end if;
  kg:=(p_row->>'weight')::numeric;unit_price:=(p_row->>'price')::numeric;
  if kg is null or kg not between 0.01 and 10000000 or kg<>round(kg,2)
    or unit_price is null or unit_price not between 0 and 1000000000 or length(coalesce(p_row->>'note',''))>500 then
    raise exception '합계중량은 0 초과 소수 둘째 자리까지, 단가는 0 이상의 숫자로 입력해주세요.';end if;
  select * into partner from public.business_partners where name=btrim(p_row->>'trader')
    and ((active and trade_type in ('매입','매입/매출')) or (name=receipt.trader and id::text=receipt.raw->>'traderId'));
  if not found then raise exception '등록된 매입 또는 매입/매출 입고처를 선택해주세요.';end if;
  if (select count(*) from public.business_partners where name=partner.name and active and trade_type in ('매입','매입/매출'))>1 then
    raise exception '동일한 이름의 입고처가 여러 개입니다. 거래처 정보를 확인해주세요.';end if;
  select sum(p.weight),jsonb_agg(to_jsonb(p) order by p.id) into scanned,packages
    from pda_private.raw_packages p where p.source_id=receipt.raw->>'stockRowId';
  if scanned is null then raise exception '입고 바코드 연결을 확인할 수 없어 수정하지 않았습니다.';end if;
  select jsonb_build_object('authMode','personal_session','userId',p_user,'displayName',u.display_name,
    'loginId',u.login_id,'savedAt',clock_timestamp()) into audit from public.erp_users u where u.id=p_user;
  insert into pda_private.raw_receipt_changes(action,source_id,user_id,before_rows,packages)
    values('correct',receipt.raw->>'stockRowId',p_user,jsonb_build_array(to_jsonb(receipt)),packages);
  insert into pda_private.raw_receipt_context values(txid_current(),receipt.id);
  update public.transactions set weight=kg,price=unit_price,amount=round(kg*unit_price),trader=partner.name,
    note=coalesce(p_row->>'note',''),stock_unit_price=unit_price,updated_at=clock_timestamp(),
    raw=raw||jsonb_build_object('weight',kg,'price',unit_price,'amount',round(kg*unit_price),
      'trader',partner.name,'traderId',partner.id,'note',coalesce(p_row->>'note',''),'stockUnitPrice',unit_price,
      '_pdaRawScannedWeight',scanned,'_pdaRawWeightDelta',kg-scanned,
      '_pdaRawEditRevision',coalesce((raw->>'_pdaRawEditRevision')::integer,0)+1,'_serverAudit',audit)
    where id=receipt.id returning raw into updated;
  delete from pda_private.raw_receipt_context where transaction_xid=txid_current() and transaction_id=receipt.id;
  insert into public.change_logs(entity,action,entity_id,summary,payload) values('PDA 원료육','입고 수정',receipt.id,
    format('%s %s / 이력번호 %s / 입고처 %s → %s / 중량 %s → %sKG / 단가 %s → %s원',
      receipt.date,receipt.product,receipt.lot,receipt.trader,partner.name,receipt.weight,kg,receipt.price,unit_price),
    audit||jsonb_build_object('before',receipt.raw,'after',updated,'scannedWeight',scanned));
  return updated;
end;
$$;
revoke all on function pda_private.correct_raw_receipt(uuid,jsonb) from public,anon,authenticated;

alter function public.dbmt_erp_save_transactions(text,jsonb,jsonb) rename to erp_save_transactions_before_receipt_corrections;
alter function public.erp_save_transactions_before_receipt_corrections(text,jsonb,jsonb) set schema pda_private;
revoke all on function pda_private.erp_save_transactions_before_receipt_corrections(text,jsonb,jsonb) from public,anon,authenticated;
create function public.dbmt_erp_save_transactions(p_token text,p_rows jsonb default '[]'::jsonb,p_delete_ids jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare usr uuid:=public.dbmt_erp_session_user(p_token); row jsonb; ordinary jsonb:='[]'::jsonb;
  corrections jsonb:='[]'::jsonb; result jsonb;
begin
  if usr is null then return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.');end if;
  if jsonb_typeof(coalesce(p_rows,'[]'::jsonb)) is distinct from 'array'
    or jsonb_typeof(coalesce(p_delete_ids,'[]'::jsonb)) is distinct from 'array'
    or jsonb_array_length(coalesce(p_rows,'[]'::jsonb))>500 or jsonb_array_length(coalesce(p_delete_ids,'[]'::jsonb))>500 then
    raise exception '거래내역은 한 번에 500건까지 올바른 목록으로 처리해주세요.';end if;
  if exists(select 1 from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) r join public.transactions t
    on t.id=r->>'id' where t.deleted_at is null and t.type='입고' and t.raw ? '_pdaRawRequestId' and t.raw->>'_pdaAction'='receive')
    and public.dbmt_erp_has_permission(p_token,'transactions','update') is not true then
    return public.dbmt_erp_permission_denied(usr,'transactions','update');end if;
  for row in select r from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) r loop
    if exists(select 1 from public.transactions t where t.id=row->>'id' and t.deleted_at is null
      and t.type='입고' and t.raw ? '_pdaRawRequestId' and t.raw->>'_pdaAction'='receive') then
      if exists(select 1 from jsonb_array_elements_text(coalesce(p_delete_ids,'[]'::jsonb)) d where d=row->>'id') then
        raise exception '같은 입고를 수정과 삭제로 동시에 요청할 수 없습니다.';end if;
      corrections:=corrections||jsonb_build_array(pda_private.correct_raw_receipt(usr,row));
    else ordinary:=ordinary||jsonb_build_array(row);end if;
  end loop;
  result:=pda_private.erp_save_transactions_before_receipt_corrections(p_token,ordinary,p_delete_ids);
  if result->>'ok' is distinct from 'true' and jsonb_array_length(corrections)>0 then
    raise exception '%',coalesce(result->>'message','거래내역 저장 권한을 확인해주세요.');end if;
  return result||jsonb_build_object('updatedRawReceipts',corrections,
    'transactions',coalesce((result->>'transactions')::integer,0)+jsonb_array_length(corrections));
end;
$$;
revoke all on function public.dbmt_erp_save_transactions(text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.dbmt_erp_save_transactions(text,jsonb,jsonb) to anon,authenticated;

create function pda_private.negative_pda_stock(p_batch uuid,p_raw boolean)
returns jsonb language sql stable security invoker set search_path='' as $$
  select coalesce(jsonb_agg(s order by s.product,s.lot),'[]'::jsonb) from (
    select distinct t.raw->>'stockRowId' "stockRowId",t.product,t.lot,coalesce(nullif(t.stock_location,''),'가공장') location,
      pda_private.balance(t.raw->>'stockRowId',coalesce(nullif(t.stock_location,''),'가공장')) weight
    from public.transactions t where t.deleted_at is null and t.type='출고'
      and t.raw->>case when p_raw then '_pdaRawRequestId' else '_pdaRequestId' end=p_batch::text
      and coalesce(t.raw->>'_pdaProvisional','false')<>'true'
  ) s where s.weight< -0.005;
$$;
revoke all on function pda_private.negative_pda_stock(uuid,boolean) from public,anon,authenticated;

-- Only genuine, currently committing PDA shipments bypass quantity reservations.
-- Duplicate barcodes, source identity, permissions and immutable scan checks stay intact.
do $patch$
declare d text;a text;b text;
begin
  select replace(pg_get_functiondef('pda_private.protect_raw_stock()'::regprocedure),E'\r\n',E'\n') into d;
  d:=replace(d,E'begin\n',E'begin\n'||$body$
  if tg_op='INSERT' and new.type='출고' and new.raw->>'_pdaAction'='ship' and exists(
    select 1 from pda_private.raw_batches b where b.id::text=new.raw->>'_pdaRawRequestId'
      and b.result='{}'::jsonb and b.request->>'mode'='outbound') then return new;end if;
$body$);
  a:='for source in select distinct v from unnest';
  if position(a in d)=0 then raise exception 'Unexpected raw reservation guard';end if;
  d:=replace(d,a,$body$
  if tg_op='UPDATE' and new.deleted_at is not distinct from old.deleted_at and new.type=old.type and new.weight=old.weight
    and new.stock_location is not distinct from old.stock_location and new.from_location is not distinct from old.from_location
    and new.to_location is not distinct from old.to_location and new.raw->>'stockRowId' is not distinct from old.raw->>'stockRowId' then return new;end if;
  for source in select distinct v from unnest$body$);execute d;
  select replace(pg_get_functiondef('pda_private.protect_registered_stock()'::regprocedure),E'\r\n',E'\n') into d;
  d:=replace(d,E'begin\n',E'begin\n'||$body$
  if tg_op='INSERT' and new.type='출고' and new.raw->>'_pdaAction'='ship' and exists(
    select 1 from public.pda_batches b where b.id::text=new.raw->>'_pdaRequestId'
      and b.result='{}'::jsonb and b.request->>'mode'='outbound') then return new;end if;
  if tg_op='UPDATE' and new.deleted_at is not distinct from old.deleted_at and new.type=old.type and new.weight=old.weight
    and new.stock_location is not distinct from old.stock_location and new.from_location is not distinct from old.from_location
    and new.to_location is not distinct from old.to_location and new.raw->>'stockRowId' is not distinct from old.raw->>'stockRowId' then return new;end if;
$body$);execute d;
  select replace(pg_get_functiondef('public.dbmt_stock_row_write_lock()'::regprocedure),E'\r\n',E'\n') into d;
  a:='if coalesce(v_result_stock,0)<-0.005 then';
  b:='if coalesce(v_result_stock,0)<-0.005 and not exists(select 1 from pda_private.raw_receipt_context c
          where c.transaction_xid=txid_current() and c.transaction_id=old.id) then';
  if position(a in d)=0 then raise exception 'Unexpected source quantity guard';end if;execute replace(d,a,b);
  select replace(pg_get_functiondef('pda_private.erp_save_transactions_before_receipt_corrections(text,jsonb,jsonb)'::regprocedure),E'\r\n',E'\n') into d;
  a:='is distinct from receipt.weight then';b:='is distinct from coalesce((receipt.raw->>''_pdaRawScannedWeight'')::numeric,receipt.weight) then';
  if position(a in d)=0 then raise exception 'Unexpected receipt cancellation weight check';end if;execute replace(d,a,b);
  select replace(pg_get_functiondef('pda_private.raw_commit_before_receipt_groups(text,uuid,text,text,uuid,date,jsonb,text,text,text,numeric,text)'::regprocedure),E'\r\n',E'\n') into d;
  a:='if pda_private.balance(source_id,p_location)-held+0.005<w then raise exception ''원료육 재고가 부족합니다. 수기 출고·사용·이동을 확인해주세요.''; end if;';
  if position(a in d)=0 then raise exception 'Unexpected raw outbound quantity check';end if;
  d:=replace(d,a,'-- A registered physical box may ship past the corrected book balance.');
  a:='update pda_private.raw_batches set result=v_result where id=p_request_id;';
  b:='v_result:=v_result||jsonb_build_object(''negativeStock'',pda_private.negative_pda_stock(p_request_id,true));'||E'\n  '||a;
  if position(a in d)=0 then raise exception 'Unexpected raw batch result';end if;execute replace(d,a,b);
  select replace(pg_get_functiondef('public.dbmt_pda_commit(text,uuid,text,text,uuid,date,jsonb,text)'::regprocedure),E'\r\n',E'\n') into d;
  a:='if v_remaining-v_reserved+0.005<(v_data->>''weight'')::numeric then';
  b:='if p_mode<>''outbound'' and v_remaining-v_reserved+0.005<(v_data->>''weight'')::numeric then';
  if position(a in d)=0 then raise exception 'Unexpected product outbound quantity check';end if;d:=replace(d,a,b);
  a:='update public.pda_batches set result=v_result where id=p_request_id;';
  b:='v_result:=v_result||jsonb_build_object(''negativeStock'',pda_private.negative_pda_stock(p_request_id,false));'||E'\n  '||a;
  if position(a in d)=0 then raise exception 'Unexpected product batch result';end if;execute replace(d,a,b);
end $patch$;

-- Later production-cost settlement must not reject an already accepted negative shipment.
create or replace function pda_private.check_product_balances(p_production text)
returns void language plpgsql security invoker set search_path='' as $$
begin
  if exists(select 1 from public.pda_packages p where p.production_id=p_production
    group by p.source_stock_row_id,p.location
    having pda_private.balance(p.source_stock_row_id,p.location)+0.005<sum(case when p.state='in_stock' then p.weight else 0 end)
    and not exists(select 1 from public.transactions t where t.deleted_at is null and t.type='출고'
      and t.raw ? '_pdaRequestId' and t.raw->>'stockRowId'=p.source_stock_row_id
      and coalesce(nullif(t.stock_location,''),'가공장')=p.location)) then
    raise exception '제품 재고와 PDA 박스 중량이 일치하지 않습니다. 전체 작업을 취소했습니다.';end if;
end;
$$;
revoke all on function pda_private.check_product_balances(text) from public,anon,authenticated;
notify pgrst,'reload schema';
