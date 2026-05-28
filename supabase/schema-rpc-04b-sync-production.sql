-- DBMT ERP RPC sync - production entries

create or replace function public.dbmt_sync_production(p_password text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  incoming_count integer := jsonb_array_length(coalesce(p_rows, '[]'::jsonb));
  existing_count integer := 0;
begin
  if not public.dbmt_check_password(p_password) then
    raise exception 'invalid app password';
  end if;

  select count(*) into existing_count
  from public.production_entries
  where deleted_at is null;

  if existing_count > 0 and incoming_count < floor(existing_count * 0.8) then
    raise exception 'incoming production count is too small: % / %', incoming_count, existing_count;
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
    null
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as t(elem)
  on conflict (id) do update set
    work_date = excluded.work_date,
    product = excluded.product,
    lot = excluded.lot,
    output_weight = excluded.output_weight,
    raw = excluded.raw,
    updated_at = now(),
    deleted_at = null;

  update public.production_entries t
  set deleted_at = now(), updated_at = now()
  where t.deleted_at is null
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r(elem)
      where coalesce(nullif(r.elem->>'id', ''), 'prod_' || md5(r.elem::text)) = t.id
    );

  return jsonb_build_object('ok', true, 'prod', incoming_count);
end;
$dbmt$;

grant execute on function public.dbmt_sync_production(text, jsonb) to anon, authenticated;
