-- Install after the personal-login and submaterial-usage RPCs. No business rows
-- are migrated: legacy item-wide counts and all certificate metadata stay intact.
do $dbmt$ begin
  if to_regprocedure('public.dbmt_erp_save_app_data(text,jsonb)') is null
    or to_regprocedure('public.dbmt_erp_save_submaterial_usages(text,jsonb,jsonb)') is null then
    raise exception '개인 로그인 및 부자재 사용 저장 기능을 먼저 설치해주세요.';
  end if;
end $dbmt$;

-- Counts, lot/master edits and usage/production deletions share one write lock.
create or replace function public.dbmt_submaterial_write_lock()
returns trigger language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  perform pg_advisory_xact_lock(40100914);
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$dbmt$;
drop trigger if exists trg_submaterial_usage_lock on public.submaterial_usages;
create trigger trg_submaterial_usage_lock before insert or update or delete on public.submaterial_usages
  for each row execute function public.dbmt_submaterial_write_lock();
drop trigger if exists trg_submaterial_app_data_lock on public.app_data;
create trigger trg_submaterial_app_data_lock before insert or update on public.app_data
  for each row when (new.key in ('subMaterialItems','subMaterialLots','subMaterialCounts'))
  execute function public.dbmt_submaterial_write_lock();

create or replace function public.dbmt_submaterial_lot_stock(p_lot_id text)
returns numeric language sql security definer set search_path=public,extensions as $dbmt$
  select round(public.dbmt_safe_numeric(lot->>'qty'),6)
    - round(coalesce((select sum(qty) from public.submaterial_usages where lot_id=p_lot_id and deleted_at is null),0),6)
    + round(coalesce((select sum(public.dbmt_safe_numeric(c->>'adjustmentQty'))
      from public.app_data a cross join lateral jsonb_array_elements(a.payload) c
      where a.key='subMaterialCounts' and nullif(c->>'lotId','')=p_lot_id),0),6)
  from public.app_data a cross join lateral jsonb_array_elements(a.payload) lot
  where a.key='subMaterialLots' and lot->>'id'=p_lot_id;
$dbmt$;

create or replace function public.dbmt_submaterial_stock_snapshot()
returns jsonb language sql security definer set search_path=public,extensions as $dbmt$
  select jsonb_build_object('ok',true,
    'items',coalesce((select payload from public.app_data where key='subMaterialItems'),'[]'::jsonb),
    'lots',coalesce((select payload from public.app_data where key='subMaterialLots'),'[]'::jsonb),
    'counts',coalesce((select payload from public.app_data where key='subMaterialCounts'),'[]'::jsonb),
    'countsRevision',md5(coalesce((select payload from public.app_data where key='subMaterialCounts'),'[]'::jsonb)::text),
    'usages',coalesce((select jsonb_agg(raw || jsonb_build_object('id',id) order by work_date nulls last,id)
      from public.submaterial_usages where deleted_at is null),'[]'::jsonb));
$dbmt$;

create or replace function public.dbmt_erp_get_submaterial_stock(p_token text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  if public.dbmt_erp_session_user(p_token) is null then
    return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.');
  end if;
  if public.dbmt_erp_has_permission(p_token,'submaterials','view') is not true
    and public.dbmt_erp_has_permission(p_token,'production','view') is not true then
    return public.dbmt_erp_permission_denied(public.dbmt_erp_session_user(p_token),'submaterials','view');
  end if;
  perform pg_advisory_xact_lock(40100914);
  return public.dbmt_submaterial_stock_snapshot();
end;
$dbmt$;

create or replace function public.dbmt_submaterial_count_log(p_token text,p_action text,p_count jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
declare v_user public.erp_users%rowtype; v_role public.erp_roles%rowtype; v_log jsonb;
begin
  select * into v_user from public.erp_users where id=public.dbmt_erp_session_user(p_token);
  select * into v_role from public.erp_roles where id=v_user.role_id;
  v_log:=jsonb_build_object('id','cl_smcount_' || encode(extensions.gen_random_bytes(10),'hex'),
    'at',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'menu','부자재 관리','action',p_action,'target',coalesce(p_count->>'itemName','') || ' / ' || coalesce(p_count->>'lot','품목 실사'),
    'summary',case when coalesce(p_count->>'lotId','')='' then '기존 품목 실사 ' else '부자재 LOT 실사 ' end || p_action || ': ' ||
      coalesce(p_count->>'itemName','') || ' / ' || coalesce(p_count->>'lot','') ||
      ' / 실제 ' || coalesce(p_count->>'qty','0') || ' / 조정 ' || coalesce(p_count->>'adjustmentQty','0'),
    'refId',p_count->>'id','authMode','personal_session','userId',v_user.id,'userName',v_user.display_name,
    'userLoginId',v_user.login_id,'roleCode',v_role.code,'roleName',v_role.name);
  perform public.dbmt_erp_append_change_logs(p_token,jsonb_build_array(v_log));
  insert into public.change_logs(entity,action,entity_id,summary,payload)
    values('부자재 실사',p_action,p_count->>'id',v_log->>'summary',jsonb_build_object('count',p_count,'userId',v_user.id,'authMode','personal_session'));
  return v_log;
end;
$dbmt$;

create or replace function public.dbmt_erp_save_submaterial_count(p_token text,p_record jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
declare v_user_id uuid:=public.dbmt_erp_session_user(p_token); v_id text; v_lot_id text; v_lot jsonb; v_item jsonb;
  v_counts jsonb; v_count jsonb; v_existing jsonb; v_current numeric; v_qty numeric; v_expected numeric;
  v_manager text; v_note text; v_log jsonb; v_today text:=to_char(clock_timestamp() at time zone 'Asia/Seoul','YYYY-MM-DD');
begin
  if v_user_id is null then return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.'); end if;
  if public.dbmt_erp_has_permission(p_token,'submaterials','create') is not true then
    return public.dbmt_erp_permission_denied(v_user_id,'submaterials','create');
  end if;
  if jsonb_typeof(p_record) is distinct from 'object' then raise exception '실사 입력 형식을 확인해주세요.'; end if;
  v_lot_id:=nullif(btrim(p_record->>'lotId'),'');
  v_id:=nullif(btrim(p_record->>'id'),'');
  if v_id is null then v_id:='smcount_' || replace(extensions.gen_random_uuid()::text,'-',''); end if;
  if v_id!~'^[A-Za-z0-9_-]{1,120}$' or v_lot_id is null or length(v_lot_id)>120 then raise exception '실사 또는 LOT 식별값을 확인해주세요.'; end if;
  if jsonb_typeof(p_record->'qty') is distinct from 'number'
    or jsonb_typeof(p_record->'expectedSystemQty') is distinct from 'number' then
    raise exception '실제 재고와 전산재고는 숫자로 입력해주세요.';
  end if;
  v_qty:=public.dbmt_safe_numeric(p_record->>'qty');
  v_expected:=public.dbmt_safe_numeric(p_record->>'expectedSystemQty');
  if v_qty<0 or v_qty<>round(v_qty,6) or v_expected<>round(v_expected,6) then
    raise exception '실제 재고는 0 이상, 수량은 소수 여섯 자리 이내로 입력해주세요.';
  end if;
  v_manager:=btrim(coalesce(p_record->>'manager','')); v_note:=btrim(coalesce(p_record->>'note',''));
  perform pg_advisory_xact_lock(40100914);
  v_counts:=coalesce((select payload from public.app_data where key='subMaterialCounts'),'[]'::jsonb);
  select e into v_existing from jsonb_array_elements(v_counts) e where e->>'id'=v_id;
  if v_existing is not null then
    if v_existing->>'lotId'=v_lot_id and public.dbmt_safe_numeric(v_existing->>'qty')=v_qty
      and coalesce(v_existing->>'manager','')=v_manager and coalesce(v_existing->>'note','')=v_note then
      return public.dbmt_submaterial_stock_snapshot() || jsonb_build_object('alreadySaved',true,'count',v_existing,'currentQty',public.dbmt_submaterial_lot_stock(v_lot_id));
    end if;
    return public.dbmt_submaterial_stock_snapshot() || jsonb_build_object('ok',false,'code','count_id_conflict','message','같은 실사 요청의 내용이 변경되었습니다. 실사창을 다시 열어주세요.','currentQty',public.dbmt_submaterial_lot_stock(v_lot_id));
  end if;
  if exists(select 1 from public.change_logs where entity='부자재 실사' and action='삭제' and entity_id=v_id) then
    return public.dbmt_submaterial_stock_snapshot() || jsonb_build_object('ok',false,'code','count_deleted','message','이미 삭제한 실사 요청입니다. 실사창을 다시 열어주세요.');
  end if;
  select e into v_lot from public.app_data a cross join lateral jsonb_array_elements(a.payload) e
    where a.key='subMaterialLots' and e->>'id'=v_lot_id;
  if v_lot is null then return public.dbmt_submaterial_stock_snapshot() || jsonb_build_object('ok',false,'code','lot_not_found','message','선택한 입고 LOT이 없습니다. 새로고침 후 다시 선택해주세요.'); end if;
  if public.dbmt_safe_date(v_lot->>'date')>(v_today::date) then raise exception '입고일 이후에 실사를 등록해주세요.'; end if;
  select e into v_item from public.app_data a cross join lateral jsonb_array_elements(a.payload) e
    where a.key='subMaterialItems' and e->>'id'=v_lot->>'itemId';
  v_current:=public.dbmt_submaterial_lot_stock(v_lot_id);
  if v_expected is distinct from v_current then
    return public.dbmt_submaterial_stock_snapshot() || jsonb_build_object('ok',false,'code','stock_conflict','message','전산재고가 변경되었습니다. 최신 재고와 조정수량을 확인한 뒤 다시 저장해주세요.','currentQty',v_current);
  end if;
  v_count:=jsonb_build_object('id',v_id,'date',v_today,'lotId',v_lot_id,'lot',coalesce(v_lot->>'lot',''),
    'itemId',coalesce(v_lot->>'itemId',''),'itemCode',coalesce(v_item->>'code',v_lot->>'itemCode',''),
    'itemName',coalesce(v_item->>'name',v_lot->>'itemName',''),'itemSpec',coalesce(v_item->>'spec',v_lot->>'itemSpec',''),
    'qty',v_qty,'systemQty',v_current,'adjustmentQty',v_qty-v_current,'unit',coalesce(nullif(v_lot->>'unit',''),v_item->>'unit',''),
    'manager',v_manager,'note',v_note,'createdAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  insert into public.app_data(key,payload,updated_at) values('subMaterialCounts',v_counts || jsonb_build_array(v_count),now())
    on conflict(key) do update set payload=excluded.payload,updated_at=now();
  v_log:=public.dbmt_submaterial_count_log(p_token,'저장',v_count);
  return public.dbmt_submaterial_stock_snapshot() || jsonb_build_object('count',v_count,'currentQty',v_qty,'logEntry',v_log);
end;
$dbmt$;

create or replace function public.dbmt_erp_delete_submaterial_count(p_token text,p_count_id text,p_expected_revision text default null)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
declare v_user_id uuid:=public.dbmt_erp_session_user(p_token); v_counts jsonb; v_count jsonb; v_log jsonb;
  v_current numeric; v_after numeric; v_lot_id text;
begin
  if v_user_id is null then return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.'); end if;
  if public.dbmt_erp_has_permission(p_token,'submaterials','delete') is not true then
    return public.dbmt_erp_permission_denied(v_user_id,'submaterials','delete');
  end if;
  perform pg_advisory_xact_lock(40100914);
  v_counts:=coalesce((select payload from public.app_data where key='subMaterialCounts'),'[]'::jsonb);
  select e into v_count from jsonb_array_elements(v_counts) e where e->>'id'=p_count_id;
  if v_count is null then return public.dbmt_submaterial_stock_snapshot() || jsonb_build_object('alreadyDeleted',true); end if;
  if p_expected_revision is not null and p_expected_revision<>md5(v_counts::text) then
    return public.dbmt_submaterial_stock_snapshot() || jsonb_build_object('ok',false,'code','counts_conflict','message','실사 이력이 변경되었습니다. 최신 이력을 확인한 뒤 다시 삭제해주세요.');
  end if;
  v_lot_id:=nullif(v_count->>'lotId','');
  if v_lot_id is not null then
    v_current:=public.dbmt_submaterial_lot_stock(v_lot_id);
    v_after:=v_current-public.dbmt_safe_numeric(v_count->>'adjustmentQty');
    if v_after<0 and v_after<v_current then
      return public.dbmt_submaterial_stock_snapshot() || jsonb_build_object('ok',false,'code','count_in_use','message','실사로 늘어난 재고가 이미 사용되었습니다. 사용내역을 먼저 확인해주세요.','currentQty',v_current,'qtyAfterDelete',v_after);
    end if;
  end if;
  select coalesce(jsonb_agg(e order by n),'[]'::jsonb) into v_counts
    from jsonb_array_elements(v_counts) with ordinality a(e,n) where e->>'id' is distinct from p_count_id;
  update public.app_data set payload=v_counts,updated_at=now() where key='subMaterialCounts';
  v_log:=public.dbmt_submaterial_count_log(p_token,'삭제',v_count);
  return public.dbmt_submaterial_stock_snapshot() || jsonb_build_object('currentQty',v_after,'logEntry',v_log);
end;
$dbmt$;

-- Existing item edits may update descriptive snapshots, but an old browser's
-- full array must never erase a newer count or alter its inventory adjustment.
do $dbmt$ begin
  if to_regprocedure('public.dbmt_erp_save_app_data_before_submaterial_counts(text,jsonb)') is null then
    alter function public.dbmt_erp_save_app_data(text,jsonb) rename to dbmt_erp_save_app_data_before_submaterial_counts;
  end if;
end $dbmt$;
create or replace function public.dbmt_erp_save_app_data(p_token text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
declare v_payload jsonb:=p_payload; v_current jsonb; v_new jsonb; v_old jsonb; v_row jsonb;
  v_merged jsonb:='[]'::jsonb; v_metadata jsonb; v_result jsonb;
  v_fields text[]:=array['itemId','itemCode','itemName','itemSpec','unit'];
begin
  if public.dbmt_erp_session_user(p_token) is null then raise exception '개인 사용자 로그인이 만료되었습니다.'; end if;
  if p_payload ?| array['subMaterialItems','subMaterialLots','subMaterialCounts'] then
    perform pg_advisory_xact_lock(40100914);
  end if;
  if p_payload ? 'subMaterialLots' then
    if jsonb_typeof(p_payload->'subMaterialLots') is distinct from 'array' then raise exception '부자재 입고 형식을 확인해주세요.'; end if;
    if exists(select 1 from public.app_data a cross join lateral jsonb_array_elements(a.payload) old_lot
      where a.key='subMaterialLots'
        and not exists(select 1 from jsonb_array_elements(p_payload->'subMaterialLots') new_lot where new_lot->>'id'=old_lot->>'id')
        and (exists(select 1 from public.submaterial_usages where deleted_at is null and lot_id=old_lot->>'id')
          or exists(select 1 from public.app_data counts cross join lateral jsonb_array_elements(counts.payload) c
            where counts.key='subMaterialCounts' and c->>'lotId'=old_lot->>'id'))
    ) then raise exception '사용 또는 실사 이력이 있는 입고 LOT은 삭제할 수 없습니다. 최신 자료를 확인해주세요.'; end if;
  end if;
  if p_payload ? 'subMaterialCounts' then
    v_new:=p_payload->'subMaterialCounts';
    if jsonb_typeof(v_new) is distinct from 'array' then raise exception '부자재 실사 형식을 확인해주세요.'; end if;
    v_current:=coalesce((select payload from public.app_data where key='subMaterialCounts'),'[]'::jsonb);
    if exists(select 1 from jsonb_array_elements(v_new) e group by e->>'id' having count(*)>1) then
      raise exception '중복된 실사 식별값입니다.';
    end if;
    for v_row in select e from jsonb_array_elements(v_new) e loop
      select e into v_old from jsonb_array_elements(v_current) e where e->>'id'=v_row->>'id';
      if v_old is null then raise exception '실사 등록·삭제는 재고현황의 실사 기능을 사용해주세요. 새로고침 후 다시 시도해주세요.'; end if;
      -- Empty optional fields are equivalent to missing fields on legacy rows.
      if jsonb_strip_nulls((v_row-v_fields)-array['lotId','lot','systemQty','adjustmentQty'])
          is distinct from jsonb_strip_nulls((v_old-v_fields)-array['lotId','lot','systemQty','adjustmentQty'])
        or coalesce(v_row->>'lotId','')<>coalesce(v_old->>'lotId','')
        or coalesce(v_row->>'lot','')<>coalesce(v_old->>'lot','')
        or nullif(v_row->>'systemQty','')::numeric is distinct from nullif(v_old->>'systemQty','')::numeric
        or nullif(v_row->>'adjustmentQty','')::numeric is distinct from nullif(v_old->>'adjustmentQty','')::numeric then
        raise exception '실사의 날짜·수량·조정값은 일반 저장으로 변경할 수 없습니다. 최신 자료를 불러와주세요.';
      end if;
      if coalesce(v_old->>'lotId','')<>'' and coalesce(v_row->>'itemId','')<>coalesce(v_old->>'itemId','') then
        raise exception 'LOT 실사의 품목 연결은 변경할 수 없습니다.';
      end if;
    end loop;
    for v_old in select e from jsonb_array_elements(v_current) e loop
      select e into v_row from jsonb_array_elements(v_new) e where e->>'id'=v_old->>'id';
      v_metadata:='{}'::jsonb;
      if v_row is not null then
        select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into v_metadata
          from jsonb_each(v_row) where key=any(v_fields);
      end if;
      v_merged:=v_merged || jsonb_build_array(v_old || v_metadata);
    end loop;
    v_payload:=jsonb_set(v_payload,'{subMaterialCounts}',v_merged);
  end if;
  v_result:=public.dbmt_erp_save_app_data_before_submaterial_counts(p_token,v_payload);
  return v_result || case when p_payload ? 'subMaterialCounts' then jsonb_build_object('counts',v_merged,'countsRevision',md5(v_merged::text)) else '{}'::jsonb end;
end;
$dbmt$;

-- A usage draft opened before an inventory count must not overdraw the count's
-- new balance. Keep the original production permission/audit implementation.
do $dbmt$ begin
  if to_regprocedure('public.dbmt_erp_save_submaterial_usages_before_stock_count(text,jsonb,jsonb)') is null then
    alter function public.dbmt_erp_save_submaterial_usages(text,jsonb,jsonb) rename to dbmt_erp_save_submaterial_usages_before_stock_count;
  end if;
end $dbmt$;
create or replace function public.dbmt_erp_save_submaterial_usages(p_token text,p_rows jsonb default '[]'::jsonb,p_delete_ids jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
declare v_lot_ids text[]; v_lot_id text; v_before jsonb:='{}'::jsonb; v_prior numeric; v_after numeric; v_result jsonb;
begin
  if public.dbmt_erp_session_user(p_token) is null
    or jsonb_typeof(coalesce(p_rows,'[]'::jsonb)) is distinct from 'array'
    or jsonb_typeof(coalesce(p_delete_ids,'[]'::jsonb)) is distinct from 'array' then
    return public.dbmt_erp_save_submaterial_usages_before_stock_count(p_token,p_rows,p_delete_ids);
  end if;
  perform pg_advisory_xact_lock(40100914);
  select coalesce(array_agg(distinct lot_id),array[]::text[]) into v_lot_ids from (
    select nullif(e->>'lotId','') lot_id from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) e
    union
    select u.lot_id from public.submaterial_usages u where u.deleted_at is null
      and (exists(select 1 from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) e where e->>'id'=u.id)
        or exists(select 1 from jsonb_array_elements(coalesce(p_delete_ids,'[]'::jsonb)) e where e#>>'{}'=u.id))
  ) ids where lot_id is not null;
  foreach v_lot_id in array v_lot_ids loop
    v_before:=v_before || jsonb_build_object(v_lot_id,public.dbmt_submaterial_lot_stock(v_lot_id));
  end loop;
  v_result:=public.dbmt_erp_save_submaterial_usages_before_stock_count(p_token,p_rows,p_delete_ids);
  if v_result->>'ok' is distinct from 'true' then return v_result; end if;
  if exists(select 1 from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) e
    where not exists(select 1 from public.app_data a cross join lateral jsonb_array_elements(a.payload) lot
      where a.key='subMaterialLots' and lot->>'id'=e->>'lotId'
        and (coalesce(lot->>'itemId','')='' or lot->>'itemId'=e->>'itemId'))
  ) then raise exception '사용할 입고 LOT 또는 품목 연결을 찾을 수 없습니다. 최신 재고를 다시 확인해주세요.'; end if;
  foreach v_lot_id in array v_lot_ids loop
    v_prior:=(v_before->>v_lot_id)::numeric;
    v_after:=public.dbmt_submaterial_lot_stock(v_lot_id);
    if v_after<0 and v_after<coalesce(v_prior,0) then
      raise exception '부자재 LOT 가용재고가 변경되었습니다. 최신 재고를 확인한 뒤 사용수량을 다시 입력해주세요.';
    end if;
  end loop;
  return v_result;
end;
$dbmt$;

revoke all on function public.dbmt_submaterial_write_lock() from public,anon,authenticated;
revoke all on function public.dbmt_submaterial_lot_stock(text) from public,anon,authenticated;
revoke all on function public.dbmt_submaterial_stock_snapshot() from public,anon,authenticated;
revoke all on function public.dbmt_submaterial_count_log(text,text,jsonb) from public,anon,authenticated;
revoke all on function public.dbmt_erp_save_app_data_before_submaterial_counts(text,jsonb) from public,anon,authenticated;
revoke all on function public.dbmt_erp_save_submaterial_usages_before_stock_count(text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.dbmt_erp_get_submaterial_stock(text) from public;
revoke all on function public.dbmt_erp_save_submaterial_count(text,jsonb) from public;
revoke all on function public.dbmt_erp_delete_submaterial_count(text,text,text) from public;
revoke all on function public.dbmt_erp_save_app_data(text,jsonb) from public;
revoke all on function public.dbmt_erp_save_submaterial_usages(text,jsonb,jsonb) from public;
grant execute on function public.dbmt_erp_get_submaterial_stock(text) to anon,authenticated;
grant execute on function public.dbmt_erp_save_submaterial_count(text,jsonb) to anon,authenticated;
grant execute on function public.dbmt_erp_delete_submaterial_count(text,text,text) to anon,authenticated;
grant execute on function public.dbmt_erp_save_app_data(text,jsonb) to anon,authenticated;
grant execute on function public.dbmt_erp_save_submaterial_usages(text,jsonb,jsonb) to anon,authenticated;
notify pgrst,'reload schema';
