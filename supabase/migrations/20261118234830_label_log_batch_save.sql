-- Keep the installed validation/locking/PDA guards and both RPC contracts intact.
-- Index the immutable ledger once, stage changes, then rebuild it only once.
do $migration$
declare
  definition text;
  patch text[];
begin
  if to_regprocedure('label_print_private.save_log_batch(text,jsonb,text)') is not null then
    return;
  end if;
  select pg_get_functiondef('public.dbmt_label_print_save_logs(text,jsonb)'::regprocedure)
    into definition;

  foreach patch slice 1 in array array[
    array[$old$v_logs jsonb; v_new jsonb;$old$,
      $new$v_batch_log_indices jsonb; v_batch_orders jsonb; v_batch_products jsonb;
  v_batch_added jsonb[] := array[]::jsonb[];
  v_batch_updated jsonb[] := array[]::jsonb[];
  v_batch_positions integer[] := array[]::integer[];
  v_logs jsonb; v_new jsonb;$new$],
    array[$old$  for v_new in select * from jsonb_array_elements(p_logs) loop$old$,
      $new$  -- Preserve first-match behavior and original order, including legacy rows.
  select coalesce(jsonb_object_agg(e->>'id',n::integer-1 order by n desc)
    filter(where e->>'id' is not null),'{}'::jsonb) into v_batch_log_indices
    from jsonb_array_elements(v_logs) with ordinality r(e,n);
  select coalesce(jsonb_object_agg(e->>'id',e order by n desc)
    filter(where e->>'id' is not null),'{}'::jsonb) into v_batch_orders
    from public.app_data a cross join lateral jsonb_array_elements(a.payload) with ordinality r(e,n)
    where a.key='workOrders';
  select coalesce(jsonb_object_agg(e->>'id',e order by n desc)
    filter(where e->>'id' is not null),'{}'::jsonb) into v_batch_products
    from public.app_data a cross join lateral jsonb_array_elements(a.payload) with ordinality r(e,n)
    where a.key='labelProducts';
  for v_new in select * from jsonb_array_elements(p_logs) loop$new$],
    array[$old$    select e, n::integer-1 into v_old, v_index from jsonb_array_elements(v_logs) with ordinality r(e,n) where e->>'id'=v_new->>'id';$old$,
      $new$    v_index := (v_batch_log_indices->>(v_new->>'id'))::integer;
    v_old := v_logs->v_index;$new$],
    array[$old$      select e into v_order from public.app_data a cross join lateral jsonb_array_elements(a.payload) e
        where a.key='workOrders' and e->>'id'=v_new->>'workOrderId';$old$,
      $new$      v_order := v_batch_orders->(v_new->>'workOrderId');$new$],
    array[$old$        select e into v_product from public.app_data a cross join lateral jsonb_array_elements(a.payload) e
          where a.key='labelProducts' and e->>'id'=v_new#>>'{workOrderSnapshot,labelProductId}';$old$,
      $new$        v_product := v_batch_products->(v_new#>>'{workOrderSnapshot,labelProductId}');$new$],
    array[$old$      select e into v_product from public.app_data a cross join lateral jsonb_array_elements(a.payload) e
        where a.key='labelProducts' and e->>'id'=v_order->>'labelProductId';$old$,
      $new$      v_product := v_batch_products->(v_order->>'labelProductId');$new$],
    array[$old$      v_logs := v_logs || jsonb_build_array(v_new);$old$,
      $new$      v_batch_added := array_append(v_batch_added,v_new);$new$],
    array[$old$      v_logs := jsonb_set(v_logs,array[v_index::text],v_merged);$old$,
      $new$      v_batch_positions := array_append(v_batch_positions,v_index);
      v_batch_updated := array_append(v_batch_updated,v_merged);$new$],
    array[$old$  if jsonb_array_length(v_logs)>5000 then$old$,
      $new$  if cardinality(v_batch_updated)>0 then
    select jsonb_agg(coalesce(u.e,l.e) order by l.n) into v_logs
      from jsonb_array_elements(v_logs) with ordinality l(e,n)
      left join unnest(v_batch_positions,v_batch_updated) u(position,e) on u.position=l.n-1;
  end if;
  if cardinality(v_batch_added)>0 then
    v_logs := v_logs || to_jsonb(v_batch_added);
  end if;
  if jsonb_array_length(v_logs)>5000 then$new$]
  ] loop
    if (length(definition)-length(replace(definition,patch[1],'')))/length(patch[1])<>1 then
      raise exception 'Unexpected label save definition; batch optimization was not installed: %',left(patch[1],90);
    end if;
    definition := replace(definition,patch[1],patch[2]);
  end loop;
  -- The scoped client must never construct then discard a multi-megabyte full-ledger response.
  patch := array[
    $old$  return jsonb_build_object('ok',true,'logs',v_logs,'completions',public.dbmt_label_completion_status());$old$,
    $new$  if p_work_order_id is null then
    return jsonb_build_object('ok',true,'logs',v_logs,'completions',public.dbmt_label_completion_status());
  end if;
  return jsonb_build_object('ok',true,
    'logs',coalesce((select jsonb_agg(e order by n) from jsonb_array_elements(v_logs) with ordinality r(e,n)
      where e->>'workOrderId'=p_work_order_id),'[]'::jsonb),
    'completions',public.dbmt_label_completion_status(),
    'logScope',jsonb_build_object('workOrderId',p_work_order_id),
    'logSummaries',label_print_private.outer_log_summaries(v_logs));$new$
  ];
  if strpos(definition,patch[1])=0 then raise exception 'Unexpected label save response definition'; end if;
  definition := replace(definition,patch[1],patch[2]);
  definition := regexp_replace(definition,'^CREATE OR REPLACE FUNCTION[^\n]*',
    'CREATE OR REPLACE FUNCTION label_print_private.save_log_batch(p_pin text, p_logs jsonb, p_work_order_id text)');
  definition := replace(definition,'SECURITY DEFINER','SECURITY INVOKER');
  execute definition;
end;
$migration$;

revoke all on function label_print_private.save_log_batch(text,jsonb,text) from public,anon,authenticated;

create or replace function public.dbmt_label_print_save_logs(p_pin text,p_logs jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions as $function$
begin
  return label_print_private.save_log_batch(p_pin,p_logs,null);
end;
$function$;

create or replace function public.dbmt_label_print_save_logs(p_pin text,p_logs jsonb,p_work_order_id text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $function$
begin
  if public.dbmt_check_label_print_pin(p_pin) is not true then raise exception '라벨전용 PIN이 맞지 않습니다.'; end if;
  if p_work_order_id is null or btrim(p_work_order_id)='' or length(p_work_order_id)>120 then
    raise exception '작업지시 식별값을 확인해주세요.';
  end if;
  if jsonb_typeof(p_logs) is distinct from 'array' then raise exception '라벨 출력이력 형식을 확인해주세요.'; end if;
  if exists(select 1 from jsonb_array_elements(p_logs) e where e->>'workOrderId' is distinct from p_work_order_id) then
    raise exception '선택한 작업지시의 라벨만 저장할 수 있습니다.';
  end if;
  return label_print_private.save_log_batch(p_pin,p_logs,p_work_order_id);
end;
$function$;

-- PostgREST hoists RPC timeouts before execution. Only label-history writes get
-- a bounded I/O allowance; role/global timeouts and all other ERP RPCs stay intact.
alter function public.dbmt_label_print_save_logs(text,jsonb) set statement_timeout='15s';
alter function public.dbmt_label_print_save_logs(text,jsonb,text) set statement_timeout='15s';

notify pgrst,'reload schema';
