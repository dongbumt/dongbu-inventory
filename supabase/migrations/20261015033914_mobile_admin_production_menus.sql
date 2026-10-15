-- Mobile administrators use their own session tokens. These endpoints do not
-- grant ERP user permissions or permit writes to work orders or stock.
create or replace function public.dbmt_mobile_admin_production_schedule(p_token text,p_start date,p_end date)
returns jsonb language plpgsql security definer set search_path='' as $dbmt$
declare v_account uuid:=public.dbmt_mobile_admin_session_account(p_token);v_events jsonb;
begin
  if v_account is null then raise exception '로그인이 만료되었습니다.'; end if;
  if p_start is null or p_end is null or p_end<p_start or p_end-p_start>62 then
    raise exception '생산일정 조회 기간은 최대 63일입니다.';
  end if;
  select coalesce(jsonb_agg(to_jsonb(s) order by s.date,s.created_at,s.id),'[]'::jsonb)
    into v_events from public.production_schedule s where date between p_start and p_end;
  return jsonb_build_object('ok',true,'events',v_events);
end;
$dbmt$;

create or replace function public.dbmt_mobile_admin_save_production_schedule(
  p_token text,p_id uuid,p_record jsonb,p_revision integer default null
)
returns jsonb language plpgsql security definer set search_path='' as $dbmt$
declare
  v_account uuid:=public.dbmt_mobile_admin_session_account(p_token);
  v_old public.production_schedule%rowtype;v_row public.production_schedule%rowtype;
  v_date date;v_qty numeric;v_product text;v_trader text;v_note text;v_status text;
begin
  if v_account is null then raise exception '로그인이 만료되었습니다.'; end if;
  if p_record is null or jsonb_typeof(p_record)<>'object' then raise exception '생산일정 입력 형식을 확인해주세요.'; end if;
  v_date:=public.dbmt_safe_date(p_record->>'date');
  v_product:=btrim(coalesce(p_record->>'product',''));v_trader:=btrim(coalesce(p_record->>'trader',''));
  v_note:=btrim(coalesce(p_record->>'note',''));v_status:=coalesce(p_record->>'status','planned');
  if v_date is null then raise exception '생산예정일을 입력해주세요.'; end if;
  if length(v_product) not between 1 and 200 then raise exception '생산예정 품목을 200자 이내로 입력해주세요.'; end if;
  if length(v_trader)>200 or length(v_note)>500 then raise exception '거래처는 200자, 비고는 500자 이내로 입력해주세요.'; end if;
  if v_status not in ('planned','completed') then raise exception '생산일정 상태를 확인해주세요.'; end if;
  if p_record->>'qty' is not null then
    if jsonb_typeof(p_record->'qty')<>'number' then raise exception '예정수량은 숫자로 입력해주세요.'; end if;
    v_qty:=(p_record->>'qty')::numeric;
    if v_qty<=0 or v_qty>999999999 or round(v_qty,2)<>v_qty then raise exception '예정수량은 0보다 큰 수로 소수 둘째 자리까지 입력해주세요.'; end if;
  end if;
  if p_id is null then
    if p_revision is not null then raise exception '새 일정에는 수정번호를 지정할 수 없습니다.'; end if;
    insert into public.production_schedule(date,product,qty,trader,note,status)
      values(v_date,v_product,v_qty,v_trader,v_note,v_status) returning * into v_row;
  else
    select * into v_old from public.production_schedule where id=p_id for update;
    if not found then raise exception '수정할 생산일정을 찾을 수 없습니다. 새로고침해주세요.'; end if;
    if p_revision is distinct from v_old.revision then raise exception '다른 사용자가 이 일정을 변경했습니다. 새로고침 후 다시 수정해주세요.'; end if;
    update public.production_schedule set date=v_date,product=v_product,qty=v_qty,trader=v_trader,note=v_note,
      status=v_status,revision=revision+1,updated_at=clock_timestamp() where id=p_id returning * into v_row;
  end if;
  insert into public.change_logs(entity,action,entity_id,summary,payload)
    values('생산일정',case when p_id is null then '등록' else '수정' end,v_row.id::text,v_row.date::text||' / '||v_row.product,
      jsonb_build_object('mobileAdminId',v_account,'authMode','mobile_admin_session',
        'before',case when p_id is null then null else to_jsonb(v_old) end,'after',to_jsonb(v_row)));
  return jsonb_build_object('ok',true,'event',to_jsonb(v_row));
end;
$dbmt$;

create or replace function public.dbmt_mobile_admin_delete_production_schedule(p_token text,p_id uuid,p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $dbmt$
declare v_account uuid:=public.dbmt_mobile_admin_session_account(p_token);v_old public.production_schedule%rowtype;
begin
  if v_account is null then raise exception '로그인이 만료되었습니다.'; end if;
  select * into v_old from public.production_schedule where id=p_id for update;
  if not found then raise exception '삭제할 생산일정을 찾을 수 없습니다. 새로고침해주세요.'; end if;
  if p_revision is distinct from v_old.revision then raise exception '다른 사용자가 이 일정을 변경했습니다. 새로고침 후 다시 수정해주세요.'; end if;
  delete from public.production_schedule where id=p_id;
  insert into public.change_logs(entity,action,entity_id,summary,payload)
    values('생산일정','삭제',p_id::text,v_old.date::text||' / '||v_old.product,
      jsonb_build_object('mobileAdminId',v_account,'authMode','mobile_admin_session','before',to_jsonb(v_old)));
  return jsonb_build_object('ok',true,'id',p_id);
end;
$dbmt$;

-- Work orders are deliberately exposed through a read endpoint only.
create or replace function public.dbmt_mobile_admin_work_orders(p_token text,p_start date,p_end date)
returns jsonb language plpgsql security definer set search_path='' as $dbmt$
declare v_account uuid:=public.dbmt_mobile_admin_session_account(p_token);v_orders jsonb;
begin
  if v_account is null then raise exception '로그인이 만료되었습니다.'; end if;
  if p_start is null or p_end is null or p_end<p_start or p_end-p_start>365 then
    raise exception '작업지시 조회 기간은 최대 366일입니다.';
  end if;
  select coalesce(jsonb_agg(e order by e->>'date' desc,e->>'updatedAt' desc,e->>'id'),'[]'::jsonb)
    into v_orders from public.app_data a cross join lateral jsonb_array_elements(a.payload) e
    where a.key='workOrders' and public.dbmt_safe_date(e->>'date') between p_start and p_end;
  return jsonb_build_object('ok',true,'orders',v_orders);
end;
$dbmt$;

revoke all on function public.dbmt_mobile_admin_production_schedule(text,date,date) from public,anon,authenticated;
revoke all on function public.dbmt_mobile_admin_save_production_schedule(text,uuid,jsonb,integer) from public,anon,authenticated;
revoke all on function public.dbmt_mobile_admin_delete_production_schedule(text,uuid,integer) from public,anon,authenticated;
revoke all on function public.dbmt_mobile_admin_work_orders(text,date,date) from public,anon,authenticated;
grant execute on function public.dbmt_mobile_admin_production_schedule(text,date,date) to anon,authenticated;
grant execute on function public.dbmt_mobile_admin_save_production_schedule(text,uuid,jsonb,integer) to anon,authenticated;
grant execute on function public.dbmt_mobile_admin_delete_production_schedule(text,uuid,integer) to anon,authenticated;
grant execute on function public.dbmt_mobile_admin_work_orders(text,date,date) to anon,authenticated;
notify pgrst,'reload schema';
