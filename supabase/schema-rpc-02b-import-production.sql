-- DBMT ERP RPC import - production entries

create or replace function public.dbmt_import_production(p_password text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  row_count integer := jsonb_array_length(coalesce(p_rows, '[]'::jsonb));
begin
  if not public.dbmt_check_password(p_password) then
    raise exception 'invalid app password';
  end if;

  insert into public.production_entries (
    id, work_date, product, lot, output_weight, raw, updated_at, deleted_at
  )
  select
    coalesce(nullif(elem->>'id', ''), 'prod_' || md5(elem::text)),
    public.dbmt_safe_date(coalesce(elem->>'date', elem->>'workDate')),
    coalesce(elem->>'product', elem#>>'{outputs,0,product}'),
    coalesce(elem->>'lot', elem#>>'{outputs,0,lot}'),
    (
      select sum(public.dbmt_safe_numeric(o->>'qty'))
      from jsonb_array_elements(coalesce(elem->'outputs', '[]'::jsonb)) as out_rows(o)
    ),
    elem,
    now(),
    public.dbmt_safe_date(elem->>'deletedAt')::timestamptz
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as t(elem)
  on conflict (id) do update set
    work_date = excluded.work_date,
    product = excluded.product,
    lot = excluded.lot,
    output_weight = excluded.output_weight,
    raw = excluded.raw,
    updated_at = now(),
    deleted_at = excluded.deleted_at;

  insert into public.change_logs(entity, action, summary, payload)
  values ('migration', 'import_production', 'Production entries imported', jsonb_build_object('count', row_count));

  return jsonb_build_object('ok', true, 'prod', row_count);
end;
$dbmt$;

grant execute on function public.dbmt_import_production(text, jsonb) to anon, authenticated;
