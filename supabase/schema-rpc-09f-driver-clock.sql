-- Delivery driver attendance - GPS clock in/out.

create or replace function public.dbmt_driver_clock(
  p_token text, p_action text, p_latitude double precision,
  p_longitude double precision, p_accuracy_m double precision,
  p_break_minutes integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_account_id uuid := public.dbmt_driver_session_account(p_token);
  v_location public.driver_locations%rowtype;
  v_distance double precision;
  v_att public.driver_attendance%rowtype;
  v_elapsed integer;
  v_break integer := greatest(0, coalesce(p_break_minutes, 0));
  v_bonus integer := 0;
  v_start_region text;
begin
  if v_account_id is null then raise exception '로그인이 만료되었습니다.'; end if;
  if p_action not in ('start','end') then raise exception '잘못된 처리입니다.'; end if;
  if p_latitude not between -90 and 90 or p_longitude not between -180 and 180 then
    raise exception 'GPS 위치를 확인할 수 없습니다.';
  end if;
  if coalesce(p_accuracy_m, 9999) > 300 then
    raise exception 'GPS 정확도가 낮습니다. 실외에서 다시 시도해주세요.';
  end if;

  select l.* into v_location
  from public.driver_locations l where l.active
  order by public.dbmt_driver_distance_m(
    p_latitude, p_longitude, l.latitude, l.longitude
  ) limit 1;
  if v_location.id is not null then
    v_distance := public.dbmt_driver_distance_m(
      p_latitude, p_longitude, v_location.latitude, v_location.longitude
    );
  end if;
  if v_location.id is null or v_distance > v_location.radius_m then
    raise exception '등록된 근무장소 반경 밖입니다.';
  end if;

  if p_action = 'start' then
    select * into v_att from public.driver_attendance
    where account_id = v_account_id and end_at is null limit 1;
    if v_att.id is not null then
      return jsonb_build_object('ok', true, 'message', '이미 근무가 시작되어 있습니다.',
        'locationName', v_location.name);
    end if;
    insert into public.driver_attendance(
      account_id, work_date, start_at, start_location_id,
      start_latitude, start_longitude, start_accuracy_m
    ) values (
      v_account_id, timezone('Asia/Seoul', now())::date, now(), v_location.id,
      p_latitude, p_longitude, p_accuracy_m
    ) returning * into v_att;
    insert into public.change_logs(entity, action, entity_id, summary)
    values ('배송기사근태', '출근', v_att.id::text, v_location.name);
    return jsonb_build_object('ok', true, 'message', '출근이 기록되었습니다.',
      'locationName', v_location.name, 'attendanceId', v_att.id);
  end if;

  select * into v_att from public.driver_attendance
  where account_id = v_account_id and end_at is null
  order by start_at desc limit 1 for update;
  if v_att.id is null then raise exception '먼저 출근을 기록해주세요.'; end if;
  v_elapsed := greatest(0, floor(extract(epoch from (now() - v_att.start_at)) / 60)::integer);
  if v_break > v_elapsed then raise exception '휴게시간이 전체 근무시간보다 길 수 없습니다.'; end if;
  select region into v_start_region from public.driver_locations
  where id = v_att.start_location_id;
  if v_start_region = '인천' and v_location.region = '인천' then v_bonus := 60; end if;

  update public.driver_attendance set
    end_at = now(), end_location_id = v_location.id,
    end_latitude = p_latitude, end_longitude = p_longitude,
    end_accuracy_m = p_accuracy_m, break_minutes = v_break,
    actual_minutes = v_elapsed - v_break, bonus_minutes = v_bonus,
    recognized_minutes = v_elapsed - v_break + v_bonus,
    status = 'completed', updated_at = now()
  where id = v_att.id;
  insert into public.change_logs(entity, action, entity_id, summary)
  values ('배송기사근태', '퇴근', v_att.id::text,
    v_location.name || case when v_bonus = 60 then ' / 인천 가산 60분' else '' end);
  return jsonb_build_object('ok', true, 'message', '퇴근이 기록되었습니다.',
    'locationName', v_location.name, 'bonusMinutes', v_bonus);
end;
$dbmt$;

grant execute on function public.dbmt_driver_clock(
  text, text, double precision, double precision, double precision, integer
) to anon, authenticated;

notify pgrst, 'reload schema';
