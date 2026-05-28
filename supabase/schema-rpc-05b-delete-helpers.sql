-- DBMT ERP RPC - row delete helpers

create or replace function public.dbmt_delete_transaction(p_password text, p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
begin
  if not public.dbmt_check_password(p_password) then
    raise exception 'invalid app password';
  end if;

  update public.transactions
  set deleted_at = now(), updated_at = now()
  where id = p_id and deleted_at is null;

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values ('transaction', 'delete', p_id, 'Transaction deleted', jsonb_build_object('id', p_id));

  return jsonb_build_object('ok', true, 'id', p_id);
end;
$dbmt$;
grant execute on function public.dbmt_delete_transaction(text, text) to anon, authenticated;

create or replace function public.dbmt_delete_production(p_password text, p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
begin
  if not public.dbmt_check_password(p_password) then
    raise exception 'invalid app password';
  end if;

  update public.production_entries
  set deleted_at = now(), updated_at = now()
  where id = p_id and deleted_at is null;

  update public.transactions
  set deleted_at = now(), updated_at = now()
  where deleted_at is null and (prod_id = p_id or raw->>'_prodId' = p_id);

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values ('production', 'delete', p_id, 'Production entry deleted', jsonb_build_object('id', p_id));

  return jsonb_build_object('ok', true, 'id', p_id);
end;
$dbmt$;
grant execute on function public.dbmt_delete_production(text, text) to anon, authenticated;

create or replace function public.dbmt_delete_price(p_password text, p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
begin
  if not public.dbmt_check_password(p_password) then
    raise exception 'invalid app password';
  end if;

  update public.prices
  set deleted_at = now(), updated_at = now()
  where id = p_id and deleted_at is null;

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values ('price', 'delete', p_id, 'Price deleted', jsonb_build_object('id', p_id));

  return jsonb_build_object('ok', true, 'id', p_id);
end;
$dbmt$;
grant execute on function public.dbmt_delete_price(text, text) to anon, authenticated;
