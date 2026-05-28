-- DBMT ERP RPC import - prices

create or replace function public.dbmt_import_prices(p_password text, p_rows jsonb)
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
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as t(elem)
  on conflict (id) do update set
    product = excluded.product,
    origin = excluded.origin,
    trader = excluded.trader,
    price = excluded.price,
    raw = excluded.raw,
    updated_at = now(),
    deleted_at = excluded.deleted_at;

  insert into public.change_logs(entity, action, summary, payload)
  values ('migration', 'import_prices', 'Prices imported', jsonb_build_object('count', row_count));

  return jsonb_build_object('ok', true, 'prices', row_count);
end;
$dbmt$;

grant execute on function public.dbmt_import_prices(text, jsonb) to anon, authenticated;
