-- DBMT ERP RPC import - transactions

create or replace function public.dbmt_import_transactions(p_password text, p_rows jsonb)
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
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as t(elem)
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

  insert into public.change_logs(entity, action, summary, payload)
  values ('migration', 'import_transactions', 'Transactions imported', jsonb_build_object('count', row_count));

  return jsonb_build_object('ok', true, 'transactions', row_count);
end;
$dbmt$;

grant execute on function public.dbmt_import_transactions(text, jsonb) to anon, authenticated;
