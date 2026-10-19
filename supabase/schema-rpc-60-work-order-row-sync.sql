-- Keep the existing JSON records and label snapshots intact. Only the selected
-- work order is changed, under the shared app_data row lock. Old bulk clients
-- cannot replace the list once the row API is installed.
create or replace function public.dbmt_work_order_snapshot(p_rows jsonb)
returns jsonb language sql immutable security invoker set search_path='' as $fn$
  select jsonb_build_object('ok',true,'revision',md5(p_rows::text),'rows',p_rows,
    'versions',coalesce((select jsonb_object_agg(e->>'id',md5(e::text))
      from jsonb_array_elements(p_rows) e where nullif(e->>'id','') is not null),'{}'::jsonb));
$fn$;
revoke all on function public.dbmt_work_order_snapshot(jsonb) from public,anon,authenticated;

create or replace function public.dbmt_erp_get_work_orders(p_token text,p_revision text default null)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v_rows jsonb;
begin
  if public.dbmt_erp_has_permission(p_token,'workorders','view') is not true then
    raise exception '작업지시 조회 권한 또는 로그인 상태를 확인해주세요.';
  end if;
  select payload into v_rows from public.app_data where key='workOrders';
  v_rows:=coalesce(v_rows,'[]'::jsonb);
  if jsonb_typeof(v_rows)<>'array' then raise exception '작업지시 목록 형식을 확인해주세요.'; end if;
  if p_revision=md5(v_rows::text) then return jsonb_build_object('ok',true,'unchanged',true,'revision',p_revision); end if;
  return public.dbmt_work_order_snapshot(v_rows);
end;
$fn$;

create or replace function public.dbmt_erp_write_work_order(
  p_token text,p_row jsonb,p_expected_version text default null,p_delete boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v_rows jsonb; v_old jsonb; v_id text; v_action text;
begin
  if public.dbmt_erp_has_permission(p_token,'workorders','view') is not true then
    raise exception '작업지시 조회 권한 또는 로그인 상태를 확인해주세요.';
  end if;
  if jsonb_typeof(p_row) is distinct from 'object' or p_delete is null then
    raise exception '작업지시 저장 형식을 확인해주세요.';
  end if;
  v_id:=p_row->>'id';
  if nullif(btrim(v_id),'') is null or length(v_id)>200 then raise exception '작업지시 식별값을 확인해주세요.'; end if;
  insert into public.app_data(key,payload) values('workOrders','[]'::jsonb) on conflict(key) do nothing;
  select payload into v_rows from public.app_data where key='workOrders' for update;
  if jsonb_typeof(v_rows)<>'array' then raise exception '작업지시 목록 형식을 확인해주세요.'; end if;
  if (select count(*) from jsonb_array_elements(v_rows) e where e->>'id'=v_id)>1 then
    raise exception '작업지시 식별값이 중복되어 저장할 수 없습니다.';
  end if;
  select e into v_old from jsonb_array_elements(v_rows) e where e->>'id'=v_id;
  v_action:=case when p_delete then 'delete' when p_expected_version is null then 'create' else 'update' end;
  if public.dbmt_erp_has_permission(p_token,'workorders',v_action) is not true then
    raise exception '작업지시 등록·수정·삭제 권한을 확인해주세요.';
  end if;
  -- Exact retries after a lost response succeed without creating a second row.
  if (not p_delete and v_old=p_row) or (p_delete and v_old is null) then
    return public.dbmt_work_order_snapshot(v_rows)||jsonb_build_object('id',v_id,'deleted',p_delete);
  end if;
  if (v_old is null and p_expected_version is not null)
    or (v_old is not null and p_expected_version is distinct from md5(v_old::text)) then
    return jsonb_build_object('ok',false,'conflict',true,'message',
      '다른 PC에서 이 작업지시가 변경되거나 삭제되었습니다. 작성 내용은 유지됩니다. 목록에서 최신 작업지시를 확인해주세요.');
  end if;
  if not p_delete then
    if nullif(p_row->>'date','') is null or nullif(btrim(p_row->>'product'),'') is null then
      raise exception '작업일과 생산물 제품명을 입력해주세요.';
    end if;
    if octet_length(p_row::text)>200000 then raise exception '작업지시 입력 내용이 너무 큽니다.'; end if;
    perform public.dbmt_work_order_source_inputs(p_row);
  end if;
  if p_delete then
    select coalesce(jsonb_agg(e order by n),'[]'::jsonb) into v_rows
      from jsonb_array_elements(v_rows) with ordinality a(e,n) where e->>'id' is distinct from v_id;
  elsif v_old is null then v_rows:=jsonb_build_array(p_row)||v_rows;
  else
    select jsonb_agg(case when e->>'id'=v_id then p_row else e end order by n) into v_rows
      from jsonb_array_elements(v_rows) with ordinality a(e,n);
  end if;
  update public.app_data set payload=v_rows,updated_at=now() where key='workOrders';
  insert into public.change_logs(entity,action,summary,payload)
    values('workorders',v_action,'Work order row saved',jsonb_build_object('id',v_id,'userId',public.dbmt_erp_session_user(p_token)));
  return public.dbmt_work_order_snapshot(v_rows)||jsonb_build_object('id',v_id,'deleted',p_delete);
end;
$fn$;

-- Preserve all existing authorization, limits and other auxiliary categories.
do $migration$
declare v_definition text; v_marker text;
begin
  select pg_get_functiondef('public.dbmt_import_app_data(text,jsonb)'::regprocedure) into v_definition;
  if position('작업지시는 건별 저장을 사용해주세요' in v_definition)=0 then
    v_marker:=substring(v_definition from 'if row_count[[:space:]]*>[[:space:]]*8 then');
    if v_marker is null then raise exception 'Unexpected app data import definition'; end if;
    v_definition:=replace(v_definition,v_marker,
      'if p_payload ? ''workOrders'' then raise exception ''작업지시는 건별 저장을 사용해주세요. 브라우저를 새로고침한 후 다시 시도해주세요.''; end if; '||v_marker);
    execute v_definition;
  end if;
end;
$migration$;
revoke all on function public.dbmt_erp_get_work_orders(text,text) from public;
revoke all on function public.dbmt_erp_write_work_order(text,jsonb,text,boolean) from public;
grant execute on function public.dbmt_erp_get_work_orders(text,text) to anon,authenticated;
grant execute on function public.dbmt_erp_write_work_order(text,jsonb,text,boolean) to anon,authenticated;
notify pgrst,'reload schema';
