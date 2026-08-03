-- Delivery driver attendance - tables and base helpers.
-- Run once in Supabase Dashboard > SQL Editor.

create table if not exists public.driver_accounts (
  id uuid primary key default extensions.gen_random_uuid(),
  employee_id text not null unique,
  employee_name text not null,
  login_id text not null,
  password_hash text not null,
  active boolean not null default true,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_driver_accounts_login_id
  on public.driver_accounts(lower(login_id));

create table if not exists public.driver_locations (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null,
  address text,
  region text not null default '기타',
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  radius_m integer not null default 200 check (radius_m between 50 and 2000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.driver_sessions (
  token_hash text primary key,
  account_id uuid not null references public.driver_accounts(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create table if not exists public.driver_attendance (
  id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid not null references public.driver_accounts(id),
  work_date date not null,
  start_at timestamptz not null,
  end_at timestamptz,
  start_location_id uuid references public.driver_locations(id),
  end_location_id uuid references public.driver_locations(id),
  start_latitude double precision not null,
  start_longitude double precision not null,
  start_accuracy_m double precision,
  end_latitude double precision,
  end_longitude double precision,
  end_accuracy_m double precision,
  break_minutes integer not null default 0,
  actual_minutes integer,
  bonus_minutes integer not null default 0,
  recognized_minutes integer,
  status text not null default 'working' check (status in ('working', 'completed')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_driver_attendance_one_open
  on public.driver_attendance(account_id) where end_at is null;
create index if not exists idx_driver_attendance_week
  on public.driver_attendance(work_date, account_id);
create index if not exists idx_driver_sessions_expiry
  on public.driver_sessions(expires_at);

alter table public.driver_accounts enable row level security;
alter table public.driver_locations enable row level security;
alter table public.driver_sessions enable row level security;
alter table public.driver_attendance enable row level security;

revoke all on public.driver_accounts, public.driver_locations,
  public.driver_sessions, public.driver_attendance from anon, authenticated;
