-- Keep immutable print history and barcode bindings intact. Only read payloads change.
create or replace function public.dbmt_erp_get_all(p_token text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
begin
  perform public.dbmt_erp_authorize_legacy(p_token,null,'view');
  return jsonb_build_object(
    'transactions',coalesce((select jsonb_agg(raw||jsonb_build_object('id',id) order by date nulls last,id)
      from public.transactions where deleted_at is null),'[]'::jsonb),
    'prod',coalesce((select jsonb_agg(raw||jsonb_build_object('id',id) order by work_date nulls last,id)
      from public.production_entries where deleted_at is null),'[]'::jsonb),
    'prices',coalesce((select jsonb_agg(raw||jsonb_build_object('id',id) order by product nulls last,trader nulls last,id)
      from public.prices where deleted_at is null),'[]'::jsonb),
    'appData',coalesce((select jsonb_object_agg(key,payload) from public.app_data where key<>'labelPrintLogs'),'{}'::jsonb),
    'deferredAppData',jsonb_build_array('labelPrintLogs')
  );
end;
$dbmt$;
revoke all on function public.dbmt_erp_get_all(text) from public;
grant execute on function public.dbmt_erp_get_all(text) to anon,authenticated;

-- Invoker-only helper, called by the existing PIN-protected RPCs under their owner.
create or replace function label_print_private.outer_log_summaries(p_logs jsonb)
returns jsonb language sql immutable security invoker set search_path='' as $dbmt$
  select coalesce(jsonb_agg(jsonb_build_object('workOrderId',x.id,'count',x.active_count,
    'weight',x.weight,'totalCount',x.total_count) order by x.id),'[]'::jsonb)
  from (
    select e->>'workOrderId' as id,count(*) as total_count,
      count(*) filter(where coalesce(e->>'status','active')<>'void') as active_count,
      coalesce(sum(public.dbmt_safe_numeric(e->>'labelWeight'))
        filter(where coalesce(e->>'status','active')<>'void'),0) as weight
    from jsonb_array_elements(coalesce(p_logs,'[]'::jsonb)) e group by e->>'workOrderId'
  ) x;
$dbmt$;
revoke all on function label_print_private.outer_log_summaries(jsonb) from public,anon,authenticated;

-- The required second argument selects the small response. The original one-argument
-- RPC remains compatible with stations that have not refreshed their browser yet.
create or replace function public.dbmt_label_print_get_data(p_pin text,p_work_order_id text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
declare
  v_logs jsonb;
  v_orders jsonb;
begin
  if public.dbmt_check_label_print_pin(p_pin) is not true then raise exception '라벨전용 PIN이 맞지 않습니다.'; end if;
  if p_work_order_id is not null and (btrim(p_work_order_id)='' or length(p_work_order_id)>120) then
    raise exception '작업지시 식별값을 확인해주세요.';
  end if;
  select coalesce(payload,'[]'::jsonb) into v_orders from public.app_data where key='workOrders';
  if p_work_order_id is not null and not exists(select 1 from jsonb_array_elements(coalesce(v_orders,'[]'::jsonb)) e where e->>'id'=p_work_order_id) then
    raise exception '작업지시를 찾을 수 없습니다. 새로고침해주세요.';
  end if;
  select coalesce(payload,'[]'::jsonb) into v_logs from public.app_data where key='labelPrintLogs';
  return jsonb_build_object('appData',jsonb_build_object(
    'workOrders',coalesce(v_orders,'[]'::jsonb),
    'labelProducts',coalesce((select payload from public.app_data where key='labelProducts'),'[]'::jsonb),
    'labelPrintLogs',coalesce((select jsonb_agg(e) from jsonb_array_elements(coalesce(v_logs,'[]'::jsonb)) e
      where p_work_order_id is not null and e->>'workOrderId'=p_work_order_id),'[]'::jsonb)
  ),'logScope',jsonb_build_object('workOrderId',p_work_order_id),
    'logSummaries',label_print_private.outer_log_summaries(v_logs),
    'completions',public.dbmt_label_completion_status());
end;
$dbmt$;
revoke all on function public.dbmt_label_print_get_data(text,text) from public;
grant execute on function public.dbmt_label_print_get_data(text,text) to anon,authenticated;

-- Reuse all established immutable-label/PIN/concurrency checks, but return only
-- the selected work's records after save/reprint/void, never the full ledger.
create or replace function public.dbmt_label_print_save_logs(p_pin text,p_logs jsonb,p_work_order_id text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $dbmt$
declare
  v_result jsonb;
  v_logs jsonb;
begin
  if public.dbmt_check_label_print_pin(p_pin) is not true then raise exception '라벨전용 PIN이 맞지 않습니다.'; end if;
  if p_work_order_id is null or btrim(p_work_order_id)='' or length(p_work_order_id)>120 then
    raise exception '작업지시 식별값을 확인해주세요.';
  end if;
  if jsonb_typeof(p_logs) is distinct from 'array' then raise exception '라벨 출력이력 형식을 확인해주세요.'; end if;
  if exists(select 1 from jsonb_array_elements(p_logs) e where e->>'workOrderId' is distinct from p_work_order_id) then
    raise exception '선택한 작업지시의 라벨만 저장할 수 있습니다.';
  end if;
  v_result:=public.dbmt_label_print_save_logs(p_pin,p_logs);
  v_logs:=coalesce(v_result->'logs','[]'::jsonb);
  return (v_result-'logs')||jsonb_build_object(
    'logs',coalesce((select jsonb_agg(e) from jsonb_array_elements(v_logs) e where e->>'workOrderId'=p_work_order_id),'[]'::jsonb),
    'logScope',jsonb_build_object('workOrderId',p_work_order_id),
    'logSummaries',label_print_private.outer_log_summaries(v_logs));
end;
$dbmt$;
revoke all on function public.dbmt_label_print_save_logs(text,jsonb,text) from public;
grant execute on function public.dbmt_label_print_save_logs(text,jsonb,text) to anon,authenticated;
notify pgrst,'reload schema';
