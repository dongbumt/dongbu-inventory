-- Flexible driver attendance: raw GPS, admin corrections, and mid-shift events.

alter table public.driver_attendance
  add column if not exists start_region text not null default '기타',
  add column if not exists end_region text,
  add column if not exists start_location_text text,
  add column if not exists end_location_text text,
  add column if not exists source text not null default 'mobile',
  add column if not exists manual_reason text,
  add column if not exists deleted_at timestamptz;

alter table public.driver_attendance alter column start_latitude drop not null;
alter table public.driver_attendance alter column start_longitude drop not null;

update public.driver_attendance d set
  start_region = coalesce(l.region, d.start_region),
  start_location_text = coalesce(nullif(d.start_location_text, ''), l.name)
from public.driver_locations l
where d.start_location_id = l.id;

update public.driver_attendance d set
  end_region = coalesce(l.region, d.end_region),
  end_location_text = coalesce(nullif(d.end_location_text, ''), l.name)
from public.driver_locations l
where d.end_location_id = l.id;

drop index if exists public.idx_driver_attendance_one_open;
create unique index idx_driver_attendance_one_open
  on public.driver_attendance(account_id)
  where end_at is null and deleted_at is null;

create table if not exists public.driver_events (
  id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid not null references public.driver_accounts(id),
  attendance_id uuid not null references public.driver_attendance(id),
  event_type text not null check (event_type in ('location_share', 'lunch_start', 'lunch_end')),
  event_at timestamptz not null default now(),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  accuracy_m double precision,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_driver_events_attendance
  on public.driver_events(attendance_id, event_at desc);
create index if not exists idx_driver_events_account
  on public.driver_events(account_id, event_at desc);

alter table public.driver_events enable row level security;
revoke all on public.driver_events from anon, authenticated;

notify pgrst, 'reload schema';
