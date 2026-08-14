-- Fail closed when the password verifier row is missing or a partial deployment
-- leaves app_config without app_password_sha256.

create or replace function public.dbmt_check_password(p_password text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $dbmt$
  select coalesce(
    encode(extensions.digest(coalesce(p_password, ''), 'sha256'), 'hex') =
      (select value from public.app_config where key = 'app_password_sha256'),
    false
  );
$dbmt$;

revoke all on function public.dbmt_check_password(text) from public;
grant execute on function public.dbmt_check_password(text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
