-- Mobile administrator accounts and persistent sessions.

create table if not exists public.mobile_admin_accounts (
  id uuid primary key default extensions.gen_random_uuid(),
  display_name text not null,
  login_id text not null,
  pin_hash text not null,
  active boolean not null default true,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_mobile_admin_accounts_login_id
  on public.mobile_admin_accounts(lower(login_id));

create table if not exists public.mobile_admin_sessions (
  token_hash text primary key,
  account_id uuid not null references public.mobile_admin_accounts(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create index if not exists idx_mobile_admin_sessions_expiry
  on public.mobile_admin_sessions(expires_at);

alter table public.mobile_admin_accounts enable row level security;
alter table public.mobile_admin_sessions enable row level security;

revoke all on public.mobile_admin_accounts, public.mobile_admin_sessions
  from anon, authenticated;

create or replace function public.dbmt_mobile_admin_session_account(p_token text)
returns uuid
language sql
security definer
set search_path = public, extensions
as $dbmt$
  select s.account_id
  from public.mobile_admin_sessions s
  join public.mobile_admin_accounts a on a.id = s.account_id and a.active
  where s.token_hash = encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex')
    and s.expires_at > now();
$dbmt$;

revoke all on function public.dbmt_mobile_admin_session_account(text)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
