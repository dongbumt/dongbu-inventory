-- DBMT ERP - production-linked submaterial usage ledger
-- Run once in Supabase Dashboard > SQL Editor.

create table if not exists public.submaterial_usages (
  id text primary key,
  production_id text not null,
  work_date date,
  item_id text,
  lot_id text,
  qty numeric not null default 0,
  raw jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_submaterial_usages_production
  on public.submaterial_usages(production_id);
create index if not exists idx_submaterial_usages_work_date
  on public.submaterial_usages(work_date);
create index if not exists idx_submaterial_usages_lot
  on public.submaterial_usages(lot_id);
create index if not exists idx_submaterial_usages_active
  on public.submaterial_usages(deleted_at) where deleted_at is null;

alter table public.submaterial_usages enable row level security;

create or replace function public.dbmt_get_submaterial_usages(p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
begin
  if not public.dbmt_check_password(p_password) then
    raise exception 'invalid app password';
  end if;

  return coalesce((
    select jsonb_agg(raw || jsonb_build_object('id', id)
      order by work_date nulls last, id)
    from public.submaterial_usages
    where deleted_at is null
  ), '[]'::jsonb);
end;
$dbmt$;

create or replace function public.dbmt_upsert_submaterial_usages(
  p_password text,
  p_rows jsonb
)
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

  insert into public.submaterial_usages (
    id, production_id, work_date, item_id, lot_id, qty, raw, updated_at, deleted_at
  )
  select
    coalesce(nullif(elem->>'id', ''), 'smuse_' || md5(elem::text)),
    elem->>'productionId',
    public.dbmt_safe_date(coalesce(elem->>'workDate', elem->>'date')),
    elem->>'itemId',
    elem->>'lotId',
    public.dbmt_safe_numeric(elem->>'qty'),
    elem,
    now(),
    null
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as t(elem)
  on conflict (id) do update set
    production_id = excluded.production_id,
    work_date = excluded.work_date,
    item_id = excluded.item_id,
    lot_id = excluded.lot_id,
    qty = excluded.qty,
    raw = excluded.raw,
    updated_at = now(),
    deleted_at = null;

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  select 'submaterial_usage', 'upsert', elem->>'id',
    'Submaterial usage upserted', elem
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as t(elem);

  return jsonb_build_object('ok', true, 'submaterialUsages', incoming_count);
end;
$dbmt$;

create or replace function public.dbmt_delete_submaterial_usage(
  p_password text,
  p_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
begin
  if not public.dbmt_check_password(p_password) then
    raise exception 'invalid app password';
  end if;

  update public.submaterial_usages
  set deleted_at = now(), updated_at = now()
  where id = p_id and deleted_at is null;

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values ('submaterial_usage', 'delete', p_id, 'Submaterial usage deleted',
    jsonb_build_object('id', p_id));

  return jsonb_build_object('ok', true, 'id', p_id);
end;
$dbmt$;

grant execute on function public.dbmt_get_submaterial_usages(text)
  to anon, authenticated;
grant execute on function public.dbmt_upsert_submaterial_usages(text, jsonb)
  to anon, authenticated;
grant execute on function public.dbmt_delete_submaterial_usage(text, text)
  to anon, authenticated;
