-- DBMT ERP Supabase RPC setup - 01 config and helper functions

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.app_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_config enable row level security;

insert into public.app_config(key, value)
values ('app_password_sha256', 'e982589ecbd4d4445fe66f211a86ef19a9b0da59cce20381e77e351963febc63')
on conflict (key) do update
set value = excluded.value,
    updated_at = now();

create or replace function public.dbmt_safe_date(value text)
returns date
language plpgsql
immutable
as $dbmt$
begin
  if value is null or btrim(value) = '' then
    return null;
  end if;

  begin
    return replace(btrim(value), '/', '-')::date;
  exception when others then
    return null;
  end;
end;
$dbmt$;

create or replace function public.dbmt_safe_numeric(value text)
returns numeric
language plpgsql
immutable
as $dbmt$
begin
  if value is null or btrim(value) = '' then
    return null;
  end if;

  begin
    return replace(btrim(value), ',', '')::numeric;
  exception when others then
    return null;
  end;
end;
$dbmt$;

create or replace function public.dbmt_safe_bool(value text, default_value boolean default false)
returns boolean
language plpgsql
immutable
as $dbmt$
declare
  v text := lower(btrim(coalesce(value, '')));
begin
  if v = '' then
    return default_value;
  end if;
  if v in ('true', 't', '1', 'yes', 'y') then
    return true;
  end if;
  if v in ('false', 'f', '0', 'no', 'n') then
    return false;
  end if;
  return default_value;
end;
$dbmt$;

create or replace function public.dbmt_check_password(p_password text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $dbmt$
  select encode(extensions.digest(coalesce(p_password, ''), 'sha256'), 'hex') =
         (select value from public.app_config where key = 'app_password_sha256');
$dbmt$;

grant execute on function public.dbmt_check_password(text) to anon, authenticated;
