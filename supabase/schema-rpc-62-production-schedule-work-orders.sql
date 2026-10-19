-- One read model for manual plans and live work-order projections. No copies,
-- backfill, stock postings or changes to production completion are performed.
create or replace function public.dbmt_production_schedule_events(p_start date,p_end date)
returns jsonb language sql stable security invoker set search_path='' as $fn$
  with orders as (
    select e as data,public.dbmt_safe_date(e->>'date') as work_date
      from public.app_data a cross join lateral jsonb_array_elements(
        case when jsonb_typeof(a.payload)='array' then a.payload else '[]'::jsonb end) e
      where a.key='workOrders'
  ),events as (
    select to_jsonb(s)||jsonb_build_object('source','manual','readonly',false) as data
      from public.production_schedule s where s.date between p_start and p_end
    union all
    select jsonb_build_object(
      'id','work-order:'||(o.data->>'id'),'workOrderId',o.data->>'id','source','work_order','readonly',true,
      'date',o.work_date,'product',o.data->>'product',
      'qty',case when p.id is not null then p.output_weight else nullif(public.dbmt_safe_numeric(o.data->>'inputWeight'),0) end,
      'inputQty',nullif(public.dbmt_safe_numeric(o.data->>'inputWeight'),0),
      'trader',coalesce(o.data->>'trader',''),'note',coalesce(o.data->>'title',''),
      'status',case when p.id is not null then 'completed' else 'planned' end,
      'carryTo',o.data#>>'{_carryoverTo,date}','carryFrom',o.data#>>'{_carryoverFrom,date}',
      'revision',md5(jsonb_build_object('order',o.data,'production',p.raw)::text))
      from orders o
      left join public.label_production_completions c on c.work_order_id=o.data->>'id'
      left join public.production_entries p on p.id=c.production_id and p.deleted_at is null
      where o.work_date between p_start and p_end and nullif(o.data->>'id','') is not null
        and nullif(btrim(o.data->>'product'),'') is not null
        -- An unstarted forwarded parent is history; only its new child is planned.
        and (not(o.data ? '_carryoverTo') or p.id is not null)
  )
  select coalesce(jsonb_agg(data order by data->>'date',data->>'product',data->>'id'),'[]'::jsonb) from events;
$fn$;
revoke all on function public.dbmt_production_schedule_events(date,date) from public,anon,authenticated;

create or replace function public.dbmt_erp_get_production_schedule(p_token text,p_start date,p_end date)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v_user uuid:=public.dbmt_erp_session_user(p_token);
begin
  if v_user is null then return jsonb_build_object('ok',false,'message','개인 사용자 로그인이 만료되었습니다.');end if;
  if public.dbmt_erp_has_permission(p_token,'production_schedule','view') is not true then
    return public.dbmt_erp_permission_denied(v_user,'production_schedule','view');end if;
  if p_start is null or p_end is null or p_end<p_start or p_end-p_start>62 then
    raise exception '조회 기간을 확인해주세요. 한 번에 최대 63일까지 조회할 수 있습니다.';end if;
  return jsonb_build_object('ok',true,'events',public.dbmt_production_schedule_events(p_start,p_end));
end;
$fn$;

create or replace function public.dbmt_mobile_admin_production_schedule(p_token text,p_start date,p_end date)
returns jsonb language plpgsql security definer set search_path='' as $fn$
begin
  if public.dbmt_mobile_admin_session_account(p_token) is null then raise exception '로그인이 만료되었습니다.';end if;
  if p_start is null or p_end is null or p_end<p_start or p_end-p_start>62 then
    raise exception '생산일정 조회 기간은 최대 63일입니다.';end if;
  return jsonb_build_object('ok',true,'events',public.dbmt_production_schedule_events(p_start,p_end));
end;
$fn$;
revoke all on function public.dbmt_erp_get_production_schedule(text,date,date) from public;
revoke all on function public.dbmt_mobile_admin_production_schedule(text,date,date) from public;
grant execute on function public.dbmt_erp_get_production_schedule(text,date,date) to anon,authenticated;
grant execute on function public.dbmt_mobile_admin_production_schedule(text,date,date) to anon,authenticated;
notify pgrst,'reload schema';
