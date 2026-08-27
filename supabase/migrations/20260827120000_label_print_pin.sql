-- Dedicated four-digit PIN for the standalone label-print screen.
-- Only a bcrypt hash is stored; the label PIN is not the shared ERP password.

insert into public.app_config(key, value, updated_at)
values (
  'label_print_pin_hash',
  '$2a$12$kv2wBM60JbwD6BTHN3mC1u7YboW5blrkMAsC1/89ds/g47FS/WxUq',
  now()
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();

create or replace function public.dbmt_check_label_print_pin(p_pin text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $dbmt$
  select coalesce(
    coalesce(p_pin, '') ~ '^[0-9]{4}$'
    and extensions.crypt(
      coalesce(p_pin, ''),
      (select value from public.app_config where key = 'label_print_pin_hash')
    ) = (select value from public.app_config where key = 'label_print_pin_hash'),
    false
  );
$dbmt$;

create or replace function public.dbmt_label_print_get_data(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
begin
  if public.dbmt_check_label_print_pin(p_pin) is not true then
    raise exception '라벨전용 PIN이 맞지 않습니다.';
  end if;

  return jsonb_build_object(
    'appData', jsonb_build_object(
      'workOrders', coalesce(
        (select payload from public.app_data where key = 'workOrders'),
        '[]'::jsonb
      ),
      'labelProducts', coalesce(
        (select payload from public.app_data where key = 'labelProducts'),
        '[]'::jsonb
      ),
      'labelPrintLogs', coalesce(
        (select payload from public.app_data where key = 'labelPrintLogs'),
        '[]'::jsonb
      )
    )
  );
end;
$dbmt$;

create or replace function public.dbmt_label_print_get_company_master(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
begin
  if public.dbmt_check_label_print_pin(p_pin) is not true then
    raise exception '라벨전용 PIN이 맞지 않습니다.';
  end if;

  perform set_config('dbmt.personal_authorized', 'true', true);
  return public.dbmt_get_company_master('');
end;
$dbmt$;

create or replace function public.dbmt_label_print_save_logs(
  p_pin text,
  p_logs jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_logs jsonb := coalesce(p_logs, '[]'::jsonb);
begin
  if public.dbmt_check_label_print_pin(p_pin) is not true then
    raise exception '라벨전용 PIN이 맞지 않습니다.';
  end if;
  if jsonb_typeof(v_logs) <> 'array' then
    raise exception '라벨 출력이력 형식이 올바르지 않습니다.';
  end if;
  if jsonb_array_length(v_logs) > 5000 then
    raise exception '라벨 출력이력은 5,000건까지 저장할 수 있습니다.';
  end if;

  insert into public.app_data(key, payload, updated_at)
  values ('labelPrintLogs', v_logs, now())
  on conflict (key) do update
  set payload = excluded.payload,
      updated_at = now();

  insert into public.change_logs(entity, action, summary, payload)
  values (
    'label_print',
    'save_logs',
    'Standalone label print logs saved',
    jsonb_build_object('count', jsonb_array_length(v_logs))
  );

  return jsonb_build_object('ok', true, 'count', jsonb_array_length(v_logs));
end;
$dbmt$;

revoke all on function public.dbmt_check_label_print_pin(text) from public, anon, authenticated;
revoke all on function public.dbmt_label_print_get_data(text) from public;
revoke all on function public.dbmt_label_print_get_company_master(text) from public;
revoke all on function public.dbmt_label_print_save_logs(text, jsonb) from public;

grant execute on function public.dbmt_label_print_get_data(text) to anon, authenticated;
grant execute on function public.dbmt_label_print_get_company_master(text) to anon, authenticated;
grant execute on function public.dbmt_label_print_save_logs(text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
