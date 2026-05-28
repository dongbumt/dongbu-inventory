-- DBMT ERP RPC - transaction row upsert

create or replace function public.dbmt_upsert_transactions(p_password text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  incoming_count integer := jsonb_array_length(coalesce(p_rows, '[]'::jsonb));
begin
  if not public.dbmt_check_password(p_password) then
    raise exception 'invalid app password';
  end if;

  insert into public.transactions (
    id, date, type, product, origin, packunit, trader, storage, lot, proddate,
    weight, price, amount, note, is_user, is_prod_use, is_prod_out, prod_id,
    is_stock_adjust, stock_before, stock_actual, stock_unit_price, stock_proddate,
    source_stock_key, stock_location, from_location, to_location, raw, updated_at, deleted_at
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
    now(),
    null
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as t(elem)
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
    deleted_at = null;

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  select 'transaction', 'upsert',
    coalesce(nullif(elem->>'id', ''), 'tx_' || md5(elem::text)),
    'Transaction upserted', elem
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as t(elem);

  return jsonb_build_object('ok', true, 'transactions', incoming_count);
end;
$dbmt$;

grant execute on function public.dbmt_upsert_transactions(text, jsonb) to anon, authenticated;
