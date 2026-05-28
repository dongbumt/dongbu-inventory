-- DBMT ERP RPC import - auxiliary app data

create or replace function public.dbmt_import_app_data(p_password text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  row_count integer := 0;
begin
  if not public.dbmt_check_password(p_password) then
    raise exception 'invalid app password';
  end if;

  insert into public.app_data(key, payload, updated_at)
  select key, value, now()
  from jsonb_each(coalesce(p_payload, '{}'::jsonb))
  on conflict (key) do update set
    payload = excluded.payload,
    updated_at = now();

  select count(*) into row_count
  from jsonb_each(coalesce(p_payload, '{}'::jsonb));

  insert into public.change_logs(entity, action, summary, payload)
  values ('migration', 'import_app_data', 'App data imported', jsonb_build_object('count', row_count));

  return jsonb_build_object('ok', true, 'appData', row_count);
end;
$dbmt$;

grant execute on function public.dbmt_import_app_data(text, jsonb) to anon, authenticated;
