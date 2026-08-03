-- Prevent stale browser tabs from overwriting every auxiliary data set at once.
-- Normal saves send one changed key plus dataChangeLogs. Multi-record HR cleanup
-- can send up to five keys, so eight leaves room without permitting legacy
-- full-app payloads (currently 18 keys).

create or replace function public.dbmt_import_app_data(p_password text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  row_count integer := 0;
  payload_keys text[] := array[]::text[];
begin
  if not public.dbmt_check_password(p_password) then
    raise exception 'invalid app password';
  end if;

  select count(*), coalesce(array_agg(e.key order by e.key), array[]::text[])
    into row_count, payload_keys
  from jsonb_each(coalesce(p_payload, '{}'::jsonb)) as e(key, value);

  if row_count > 8 then
    raise exception 'bulk app data save blocked: refresh the ERP page before saving';
  end if;

  insert into public.app_data(key, payload, updated_at)
  select key, value, now()
  from jsonb_each(coalesce(p_payload, '{}'::jsonb))
  on conflict (key) do update set
    payload = excluded.payload,
    updated_at = now();

  insert into public.change_logs(entity, action, summary, payload)
  values (
    'migration',
    'import_app_data',
    'App data imported',
    jsonb_build_object('count', row_count, 'keys', to_jsonb(payload_keys))
  );

  return jsonb_build_object('ok', true, 'appData', row_count, 'keys', to_jsonb(payload_keys));
end;
$dbmt$;

grant execute on function public.dbmt_import_app_data(text, jsonb) to anon, authenticated;
