-- DBMT ERP Supabase RPC access layer
-- Run this after schema-core.sql.
--
-- This keeps table RLS enabled and exposes only password-checked RPC functions
-- to the browser app.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.app_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_config enable row level security;

insert into public.app_config(key, value)
values ('app_password_sha256', 'e982589ecbd4d4445fe66f211a86ef19a9b0da59cce20381e77e351963febc63')
on conflict (key) do update
set value = excluded.value,
    updated_at = now();

create or replace function public.dbmt_safe_date(value text)
returns date
language plpgsql
immutable
as $$
begin
  if value is null or btrim(value) = '' then
    return null;
  end if;

  begin
    return replace(btrim(value), '/', '-')::date;
  exception when others then
    return null;
  end;
end;
$$;

create or replace function public.dbmt_safe_numeric(value text)
returns numeric
language plpgsql
immutable
as $$
begin
  if value is null or btrim(value) = '' then
    return null;
  end if;

  begin
    return replace(btrim(value), ',', '')::numeric;
  exception when others then
    return null;
  end;
end;
$$;

create or replace function public.dbmt_safe_bool(value text, default_value boolean default false)
returns boolean
language plpgsql
immutable
as $$
declare
  v text := lower(btrim(coalesce(value, '')));
begin
  if v = '' then
    return default_value;
  end if;
  if v in ('true', 't', '1', 'yes', 'y') then
    return true;
  end if;
  if v in ('false', 'f', '0', 'no', 'n') then
    return false;
  end if;
  return default_value;
end;
$$;

create or replace function public.dbmt_check_password(p_password text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select encode(extensions.digest(coalesce(p_password, ''), 'sha256'), 'hex') =
         (select value from public.app_config where key = 'app_password_sha256');
$$;

create or replace function public.dbmt_import_all(p_password text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  tx_count integer := 0;
  prod_count integer := 0;
  price_count integer := 0;
  app_count integer := 0;
  run_id bigint;
begin
  if not public.dbmt_check_password(p_password) then
    raise exception 'invalid app password';
  end if;

  insert into public.migration_runs(source, note)
  values ('google_sheets_or_local_json', 'dbmt_import_all started')
  returning id into run_id;

  with rows as (
    select elem
    from jsonb_array_elements(coalesce(p_payload->'transactions', '[]'::jsonb)) as t(elem)
  )
  insert into public.transactions (
    id, date, type, product, origin, packunit, trader, storage, lot, proddate,
    weight, price, amount, note,
    is_user, is_prod_use, is_prod_out, prod_id, is_stock_adjust,
    stock_before, stock_actual, stock_unit_price, stock_proddate,
    source_stock_key, stock_location, from_location, to_location,
    raw, updated_at, deleted_at
  )
  select
    coalesce(nullif(elem->>'id', ''), 'tx_' || md5(elem::text)),
    public.dbmt_safe_date(elem->>'date'),
    elem->>'type',
    elem->>'product',
    elem->>'origin',
    elem->>'packunit',
    elem->>'trader',
    elem->>'storage',
    elem->>'lot',
    public.dbmt_safe_date(elem->>'proddate'),
    public.dbmt_safe_numeric(elem->>'weight'),
    public.dbmt_safe_numeric(elem->>'price'),
    public.dbmt_safe_numeric(elem->>'amount'),
    elem->>'note',
    public.dbmt_safe_bool(elem->>'_isUser', true),
    public.dbmt_safe_bool(elem->>'_isProdUse', false),
    public.dbmt_safe_bool(elem->>'_isProdOut', false),
    elem->>'_prodId',
    public.dbmt_safe_bool(elem->>'_isStockAdjust', false),
    public.dbmt_safe_numeric(elem->>'stockBefore'),
    public.dbmt_safe_numeric(elem->>'stockActual'),
    public.dbmt_safe_numeric(elem->>'stockUnitPrice'),
    public.dbmt_safe_date(elem->>'stockProddate'),
    elem->>'sourceStockKey',
    elem->>'stockLocation',
    elem->>'fromLocation',
    elem->>'toLocation',
    elem,
    coalesce(public.dbmt_safe_date(elem->>'updatedAt')::timestamptz, now()),
    public.dbmt_safe_date(elem->>'deletedAt')::timestamptz
  from rows
  on conflict (id) do update set
    date = excluded.date,
    type = excluded.type,
    product = excluded.product,
    origin = excluded.origin,
    packunit = excluded.packunit,
    trader = excluded.trader,
    storage = excluded.storage,
    lot = excluded.lot,
    proddate = excluded.proddate,
    weight = excluded.weight,
    price = excluded.price,
    amount = excluded.amount,
    note = excluded.note,
    is_user = excluded.is_user,
    is_prod_use = excluded.is_prod_use,
    is_prod_out = excluded.is_prod_out,
    prod_id = excluded.prod_id,
    is_stock_adjust = excluded.is_stock_adjust,
    stock_before = excluded.stock_before,
    stock_actual = excluded.stock_actual,
    stock_unit_price = excluded.stock_unit_price,
    stock_proddate = excluded.stock_proddate,
    source_stock_key = excluded.source_stock_key,
    stock_location = excluded.stock_location,
    from_location = excluded.from_location,
    to_location = excluded.to_location,
    raw = excluded.raw,
    updated_at = now(),
    deleted_at = excluded.deleted_at;

  get diagnostics tx_count = row_count;

  with rows as (
    select elem
    from jsonb_array_elements(coalesce(p_payload->'prod', '[]'::jsonb)) as t(elem)
  )
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
    coalesce(public.dbmt_safe_date(elem->>'updatedAt')::timestamptz, now()),
    public.dbmt_safe_date(elem->>'deletedAt')::timestamptz
  from rows
  on conflict (id) do update set
    work_date = excluded.work_date,
    product = excluded.product,
    lot = excluded.lot,
    output_weight = excluded.output_weight,
    raw = excluded.raw,
    updated_at = now(),
    deleted_at = excluded.deleted_at;

  get diagnostics prod_count = row_count;

  with rows as (
    select elem
    from jsonb_array_elements(coalesce(p_payload->'prices', '[]'::jsonb)) as t(elem)
  )
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
    coalesce(public.dbmt_safe_date(elem->>'updatedAt')::timestamptz, now()),
    public.dbmt_safe_date(elem->>'deletedAt')::timestamptz
  from rows
  on conflict (id) do update set
    product = excluded.product,
    origin = excluded.origin,
    trader = excluded.trader,
    price = excluded.price,
    raw = excluded.raw,
    updated_at = now(),
    deleted_at = excluded.deleted_at;

  get diagnostics price_count = row_count;

  with rows as (
    select key, value
    from jsonb_each(coalesce(p_payload->'appData', '{}'::jsonb))
  )
  insert into public.app_data(key, payload, updated_at)
  select key, value, now()
  from rows
  on conflict (key) do update set
    payload = excluded.payload,
    updated_at = now();

  get diagnostics app_count = row_count;

  update public.migration_runs
  set finished_at = now(),
      transactions_count = tx_count,
      production_count = prod_count,
      prices_count = price_count,
      app_data_keys_count = app_count,
      note = 'dbmt_import_all completed'
  where id = run_id;

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values (
    'migration',
    'import_all',
    run_id::text,
    'Initial/import batch completed',
    jsonb_build_object(
      'transactions', tx_count,
      'prod', prod_count,
      'prices', price_count,
      'appData', app_count
    )
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
$$;

create or replace function public.dbmt_get_all(p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.dbmt_check_password(p_password) then
    raise exception 'invalid app password';
  end if;

  return jsonb_build_object(
    'transactions',
      coalesce((
        select jsonb_agg(raw order by date nulls last, id)
        from public.transactions
        where deleted_at is null
      ), '[]'::jsonb),
    'prod',
      coalesce((
        select jsonb_agg(raw order by work_date nulls last, id)
        from public.production_entries
        where deleted_at is null
      ), '[]'::jsonb),
    'prices',
      coalesce((
        select jsonb_agg(raw order by product nulls last, trader nulls last, id)
        from public.prices
        where deleted_at is null
      ), '[]'::jsonb),
    'appData',
      coalesce((
        select jsonb_object_agg(key, payload)
        from public.app_data
      ), '{}'::jsonb)
  );
end;
$$;

grant execute on function public.dbmt_check_password(text) to anon, authenticated;
grant execute on function public.dbmt_import_all(text, jsonb) to anon, authenticated;
grant execute on function public.dbmt_get_all(text) to anon, authenticated;

-- Tables remain inaccessible directly through the publishable key because RLS
-- has no public table policies. Use the RPC functions above.
