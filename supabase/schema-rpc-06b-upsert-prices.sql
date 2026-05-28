-- DBMT ERP RPC - price row upsert

create or replace function public.dbmt_upsert_prices(p_password text, p_rows jsonb)
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
    null
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as t(elem)
  on conflict (id) do update set
    product = excluded.product,
    origin = excluded.origin,
    trader = excluded.trader,
    price = excluded.price,
    raw = excluded.raw,
    updated_at = now(),
    deleted_at = null;

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  select 'price', 'upsert',
    coalesce(nullif(elem->>'id', ''), 'price_' || md5(elem::text)),
    'Price upserted', elem
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as t(elem);

  return jsonb_build_object('ok', true, 'prices', incoming_count);
end;
$dbmt$;

grant execute on function public.dbmt_upsert_prices(text, jsonb) to anon, authenticated;
