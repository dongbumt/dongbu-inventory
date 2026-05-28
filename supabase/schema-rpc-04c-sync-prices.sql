-- DBMT ERP RPC sync - prices

create or replace function public.dbmt_sync_prices(p_password text, p_rows jsonb)
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
  from public.prices
  where deleted_at is null;

  if existing_count > 0 and incoming_count < floor(existing_count * 0.8) then
    raise exception 'incoming prices count is too small: % / %', incoming_count, existing_count;
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

  update public.prices t
  set deleted_at = now(), updated_at = now()
  where t.deleted_at is null
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r(elem)
      where coalesce(nullif(r.elem->>'id', ''), 'price_' || md5(r.elem::text)) = t.id
    );

  return jsonb_build_object('ok', true, 'prices', incoming_count);
end;
$dbmt$;

grant execute on function public.dbmt_sync_prices(text, jsonb) to anon, authenticated;
