-- Allow the deployed Edge Function's service role to manage only the existing
-- tables used by the public cold-storage request page. RLS and anon table
-- restrictions remain unchanged.

grant select, insert, update on table public.app_data to service_role;
grant insert on table public.change_logs to service_role;
