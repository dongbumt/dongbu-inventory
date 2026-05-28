-- DBMT ERP Supabase core schema
-- Step 1: create the minimum tables needed to move away from Google Sheets safely.
-- Run this in Supabase Dashboard > SQL Editor.

create table if not exists public.transactions (
  id text primary key,
  date date,
  type text,
  product text,
  origin text,
  packunit text,
  trader text,
  storage text,
  lot text,
  proddate date,
  weight numeric,
  price numeric,
  amount numeric,
  note text,
  is_user boolean default true,
  is_prod_use boolean default false,
  is_prod_out boolean default false,
  prod_id text,
  is_stock_adjust boolean default false,
  stock_before numeric,
  stock_actual numeric,
  stock_unit_price numeric,
  stock_proddate date,
  source_stock_key text,
  stock_location text,
  from_location text,
  to_location text,
  raw jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_transactions_date on public.transactions(date);
create index if not exists idx_transactions_type on public.transactions(type);
create index if not exists idx_transactions_product on public.transactions(product);
create index if not exists idx_transactions_lot on public.transactions(lot);
create index if not exists idx_transactions_active on public.transactions(deleted_at) where deleted_at is null;

create table if not exists public.production_entries (
  id text primary key,
  work_date date,
  product text,
  lot text,
  output_weight numeric,
  raw jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_production_entries_work_date on public.production_entries(work_date);
create index if not exists idx_production_entries_product on public.production_entries(product);
create index if not exists idx_production_entries_lot on public.production_entries(lot);
create index if not exists idx_production_entries_active on public.production_entries(deleted_at) where deleted_at is null;

create table if not exists public.prices (
  id text primary key,
  product text,
  origin text,
  trader text,
  price numeric,
  raw jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_prices_product on public.prices(product);
create index if not exists idx_prices_trader on public.prices(trader);
create index if not exists idx_prices_active on public.prices(deleted_at) where deleted_at is null;

create table if not exists public.change_logs (
  id bigserial primary key,
  at timestamptz not null default now(),
  entity text not null,
  action text not null,
  entity_id text,
  summary text,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists idx_change_logs_at on public.change_logs(at desc);
create index if not exists idx_change_logs_entity on public.change_logs(entity, entity_id);

-- Auxiliary ERP data that is still JSON-based in the current app.
-- This lets us migrate safely first, then normalize one menu at a time later.
create table if not exists public.app_data (
  key text primary key,
  payload jsonb not null default 'null'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.migration_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  source text,
  transactions_count integer default 0,
  production_count integer default 0,
  prices_count integer default 0,
  app_data_keys_count integer default 0,
  note text
);

alter table public.transactions enable row level security;
alter table public.production_entries enable row level security;
alter table public.prices enable row level security;
alter table public.change_logs enable row level security;
alter table public.app_data enable row level security;
alter table public.migration_runs enable row level security;

-- Important:
-- RLS is enabled but no public access policy is created here.
-- The browser app will not be allowed to read/write these tables until we add
-- a proper access method in the next step.
