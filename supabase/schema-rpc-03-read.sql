-- DBMT ERP Supabase RPC setup - 03 read function

create or replace function public.dbmt_get_all(p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
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
$dbmt$;

grant execute on function public.dbmt_get_all(text) to anon, authenticated;

-- Tables remain inaccessible directly through the publishable key because RLS
-- has no public table policies. Use RPC functions only.
