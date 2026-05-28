-- DBMT ERP Supabase RPC setup - 02 import function, simple/safe version
-- Use this instead of schema-rpc-02-import.sql if the dashboard cuts long SQL.

create or replace function public.dbmt_import_all(p_password text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  tx_count integer := jsonb_array_length(coalesce(p_payload->'transactions', '[]'::jsonb));
  prod_count integer := jsonb_array_length(coalesce(p_payload->'prod', '[]'::jsonb));
  price_count integer := jsonb_array_length(coalesce(p_payload->'prices', '[]'::jsonb));
  app_count integer := 0;
  run_id bigint;
begin
  if not public.dbmt_check_password(p_password) then
    raise exception 'invalid app password';
  end if;

  insert into public.migration_runs(source, note)
  values ('google_sheets_or_local_json', 'dbmt_import_all simple started')
  returning id into run_id;

  insert into public.transactions (
    id, date, type, product, origin, trader, lot, weight, price, amount,
    raw, updated_at, deleted_at
  )
  select
    coalesce(nullif(elem->>'id', ''), 'tx_' || md5(elem::text)),
    public.dbmt_safe_date(elem->>'date'),
    elem->>'type',
    elem->>'product',
    elem->>'origin',
    elem->>'trader',
    elem->>'lot',
    public.dbmt_safe_numeric(elem->>'weight'),
    public.dbmt_safe_numeric(elem->>'price'),
    public.dbmt_safe_numeric(elem->>'amount'),
    elem,
    now(),
    public.dbmt_safe_date(elem->>'deletedAt')::timestamptz
  from jsonb_array_elements(coalesce(p_payload->'transactions', '[]'::jsonb)) as t(elem)
  on conflict (id) do update set
    date = excluded.date,
    type = excluded.type,
    product = excluded.product,
    origin = excluded.origin,
    trader = excluded.trader,
    lot = excluded.lot,
    weight = excluded.weight,
    price = excluded.price,
    amount = excluded.amount,
    raw = excluded.raw,
    updated_at = now(),
    deleted_at = excluded.deleted_at;

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
  from jsonb_array_elements(coalesce(p_payload->'prod', '[]'::jsonb)) as t(elem)
  on conflict (id) do update set
    work_date = excluded.work_date,
    product = excluded.product,
    lot = excluded.lot,
    output_weight = excluded.output_weight,
    raw = excluded.raw,
    updated_at = now(),
    deleted_at = excluded.deleted_at;

  insert into public.prices (
    id, product, origin, trader, price, raw, updated_at, deleted_at
  )
  select
    coalesce(nullif(elem->>'id', ''), 'price_' || md5(elem::text)),
    elem->>'product',
    elem->>'origin',
    elem->>'trader',
    public.dbmt_safe_numeric(elem->>'price'),
    elem,
    now(),
    public.dbmt_safe_date(elem->>'deletedAt')::timestamptz
  from jsonb_array_elements(coalesce(p_payload->'prices', '[]'::jsonb)) as t(elem)
  on conflict (id) do update set
    product = excluded.product,
    origin = excluded.origin,
    trader = excluded.trader,
    price = excluded.price,
    raw = excluded.raw,
    updated_at = now(),
    deleted_at = excluded.deleted_at;

  insert into public.app_data(key, payload, updated_at)
  select key, value, now()
  from jsonb_each(coalesce(p_payload->'appData', '{}'::jsonb))
  on conflict (key) do update set
    payload = excluded.payload,
    updated_at = now();

  select count(*) into app_count
  from jsonb_each(coalesce(p_payload->'appData', '{}'::jsonb));

  update public.migration_runs
  set finished_at = now(),
      transactions_count = tx_count,
      production_count = prod_count,
      prices_count = price_count,
      app_data_keys_count = app_count,
      note = 'dbmt_import_all simple completed'
  where id = run_id;

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values (
    'migration',
    'import_all',
    run_id::text,
    'Import batch completed',
    jsonb_build_object('transactions', tx_count, 'prod', prod_count, 'prices', price_count, 'appData', app_count)
  );

  return jsonb_build_object(
    'ok', true,
    'migrationRunId', run_id,
    'transactions', tx_count,
    'prod', prod_count,
    'prices', price_count,
    'appData', app_count
  );
end;
$dbmt$;

grant execute on function public.dbmt_import_all(text, jsonb) to anon, authenticated;
