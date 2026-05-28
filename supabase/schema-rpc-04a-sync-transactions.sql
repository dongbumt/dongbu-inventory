-- DBMT ERP RPC sync - transactions

create or replace function public.dbmt_sync_transactions(p_password text, p_rows jsonb)
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
  from public.transactions
  where deleted_at is null;

  if existing_count > 0 and incoming_count < floor(existing_count * 0.8) then
    raise exception 'incoming transactions count is too small: % / %', incoming_count, existing_count;
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
    null
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
    deleted_at = null;

  update public.transactions t
  set deleted_at = now(), updated_at = now()
  where t.deleted_at is null
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r(elem)
      where coalesce(nullif(r.elem->>'id', ''), 'tx_' || md5(r.elem::text)) = t.id
    );

  return jsonb_build_object('ok', true, 'transactions', incoming_count);
end;
$dbmt$;

grant execute on function public.dbmt_sync_transactions(text, jsonb) to anon, authenticated;
