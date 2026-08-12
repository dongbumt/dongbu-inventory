grant select on table public.app_data to service_role;

create or replace function public.dbmt_cold_storage_public_write(
  p_action text, p_record jsonb default null, p_record_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  requests jsonb := '[]'::jsonb;
  logs jsonb := '[]'::jsonb;
  target_record jsonb;
  record_id text := coalesce(p_record->>'id', p_record_id, '');
  existed boolean := false;
  log_action text;
  requester_name text;
  item_count integer := 0;
  log_entry jsonb;
begin
  if p_action not in ('save', 'delete') or record_id !~ '^csr_[A-Za-z0-9_]+$' then
    raise exception 'invalid cold storage request';
  end if;
  insert into public.app_data(key, payload, updated_at) values ('coldStorageRequests', '[]'::jsonb, now()) on conflict (key) do nothing;
  select case when jsonb_typeof(payload) = 'array' then payload else '[]'::jsonb end into requests
  from public.app_data where key = 'coldStorageRequests' for update;
  select exists(select 1 from jsonb_array_elements(requests) elem where elem->>'id' = record_id) into existed;
  if p_action = 'save' then
    target_record := p_record;
    requests := jsonb_build_array(p_record) || coalesce((select jsonb_agg(elem) from jsonb_array_elements(requests) elem where elem->>'id' <> record_id), '[]'::jsonb);
    log_action := case when existed then '수정' else '저장' end;
  else
    select elem into target_record from jsonb_array_elements(requests) elem where elem->>'id' = record_id limit 1;
    requests := coalesce((select jsonb_agg(elem) from jsonb_array_elements(requests) elem where elem->>'id' <> record_id), '[]'::jsonb);
    log_action := '삭제';
  end if;
  update public.app_data set payload = requests, updated_at = now() where key = 'coldStorageRequests';
  if target_record is not null then
    requester_name := case when target_record->>'requesterId' = 'dongbu_distribution' then '(주)동부축산유통' else '주식회사 동부엠티' end;
    item_count := jsonb_array_length(coalesce(target_record->'items', '[]'::jsonb));
    log_entry := jsonb_build_object(
      'id', 'chg_' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text || '_' || substr(md5(random()::text), 1, 8),
      'at', to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'menu', '냉동창고 요청', 'action', log_action,
      'target', coalesce(target_record->>'warehouse', '냉동창고 요청'),
      'summary', concat_ws(' / ', target_record->>'requestDate', target_record->>'requestType', requester_name, target_record->>'warehouse', '품목 ' || item_count || '건'),
      'refId', record_id
    );
    insert into public.app_data(key, payload, updated_at) values ('dataChangeLogs', '[]'::jsonb, now()) on conflict (key) do nothing;
    select case when jsonb_typeof(payload) = 'array' then payload else '[]'::jsonb end into logs
    from public.app_data where key = 'dataChangeLogs' for update;
    update public.app_data set payload = jsonb_build_array(log_entry) || logs, updated_at = now() where key = 'dataChangeLogs';
  end if;
  return jsonb_build_object('ok', true, 'id', record_id, 'deleted', p_action = 'delete' and existed);
end;
$dbmt$;

revoke all on function public.dbmt_cold_storage_public_write(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.dbmt_cold_storage_public_write(text, jsonb, text) to service_role;
revoke insert, update on table public.app_data from service_role;
