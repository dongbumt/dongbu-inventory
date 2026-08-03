-- Delivery driver attendance - administrator location management.

create or replace function public.dbmt_driver_admin_save_location(
  p_password text, p_id uuid, p_name text, p_address text,
  p_region text, p_latitude double precision, p_longitude double precision,
  p_radius_m integer default 200, p_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare v_id uuid := coalesce(p_id, extensions.gen_random_uuid());
begin
  if not public.dbmt_check_password(p_password) then
    raise exception 'invalid app password';
  end if;
  if btrim(coalesce(p_name,'')) = '' then raise exception 'location name is required'; end if;
  if p_latitude not between -90 and 90 or p_longitude not between -180 and 180 then
    raise exception 'invalid coordinates';
  end if;
  if p_radius_m not between 50 and 2000 then raise exception 'radius must be 50-2000m'; end if;

  insert into public.driver_locations(
    id, name, address, region, latitude, longitude, radius_m, active
  ) values (
    v_id, btrim(p_name), btrim(coalesce(p_address,'')),
    case when p_region = '인천' then '인천' else '기타' end,
    p_latitude, p_longitude, p_radius_m, p_active
  )
  on conflict (id) do update set
    name = excluded.name, address = excluded.address, region = excluded.region,
    latitude = excluded.latitude, longitude = excluded.longitude,
    radius_m = excluded.radius_m, active = excluded.active, updated_at = now();

  insert into public.change_logs(entity, action, entity_id, summary)
  values ('배송기사근태', '근무장소저장', v_id::text, btrim(p_name));
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$dbmt$;

create or replace function public.dbmt_driver_distance_m(
  p_lat1 double precision, p_lon1 double precision,
  p_lat2 double precision, p_lon2 double precision
)
returns double precision
language sql
immutable
as $dbmt$
  select 6371000 * 2 * asin(sqrt(least(1,
    power(sin(radians(p_lat2 - p_lat1) / 2), 2) +
    cos(radians(p_lat1)) * cos(radians(p_lat2)) *
    power(sin(radians(p_lon2 - p_lon1) / 2), 2)
  )));
$dbmt$;

grant execute on function public.dbmt_driver_admin_save_location(
  text, uuid, text, text, text, double precision, double precision, integer, boolean
) to anon, authenticated;
revoke all on function public.dbmt_driver_distance_m(
  double precision, double precision, double precision, double precision
) from public, anon, authenticated;
