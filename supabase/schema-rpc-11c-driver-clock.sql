-- GPS clock in/out at any location. The server time is authoritative.

drop function if exists public.dbmt_driver_clock(
  text, text, double precision, double precision, double precision, integer
);
drop function if exists public.dbmt_driver_clock(
  text, text, double precision, double precision, double precision, integer, text
);

create or replace function public.dbmt_driver_clock(
  p_token text, p_action text, p_latitude double precision,
  p_longitude double precision, p_accuracy_m double precision,
  p_break_minutes integer default 60, p_region text default '기타',
  p_location_text text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_account_id uuid := public.dbmt_driver_session_account(p_token);
  v_att public.driver_attendance%rowtype;
  v_elapsed integer;
  v_break integer := greatest(60, coalesce(p_break_minutes, 60));
  v_bonus integer := 0;
  v_region text := case when p_region = '인천' then '인천' else '기타' end;
  v_location_text text;
begin
  if v_account_id is null then raise exception '로그인이 만료되었습니다.'; end if;
  if p_action not in ('start','end') then raise exception '잘못된 처리입니다.'; end if;
  if p_latitude not between -90 and 90 or p_longitude not between -180 and 180 then
    raise exception 'GPS 위치를 확인할 수 없습니다.';
  end if;
  v_location_text := coalesce(nullif(left(btrim(coalesce(p_location_text, '')), 80), ''),
    case when v_region = '인천' then '인천시' else '주소 확인 불가' end);

  if p_action = 'start' then
    select * into v_att from public.driver_attendance
    where account_id = v_account_id and end_at is null and deleted_at is null limit 1;
    if v_att.id is not null then
      return jsonb_build_object('ok', true, 'message', '이미 근무가 시작되어 있습니다.',
        'locationName', coalesce(v_att.start_location_text, 'GPS 위치'));
    end if;
    insert into public.driver_attendance(
      account_id, work_date, start_at, start_latitude, start_longitude,
      start_accuracy_m, start_region, start_location_text, source
    ) values (
      v_account_id, timezone('Asia/Seoul', now())::date, now(), p_latitude,
      p_longitude, p_accuracy_m, v_region, v_location_text, 'mobile'
    ) returning * into v_att;
    insert into public.change_logs(entity, action, entity_id, summary, payload)
    values ('배송기사근태', '출근', v_att.id::text, v_location_text, to_jsonb(v_att));
    return jsonb_build_object('ok', true, 'message', '출근이 기록되었습니다.',
      'locationName', v_location_text, 'attendanceId', v_att.id);
  end if;

  select * into v_att from public.driver_attendance
  where account_id = v_account_id and end_at is null and deleted_at is null
  order by start_at desc limit 1 for update;
  if v_att.id is null then raise exception '먼저 출근을 기록해주세요.'; end if;

  if coalesce((select event_type = 'lunch_start' from public.driver_events
    where attendance_id = v_att.id and event_type in ('lunch_start','lunch_end')
    order by event_at desc limit 1), false) then
    insert into public.driver_events(account_id, attendance_id, event_type, latitude, longitude, accuracy_m, note)
    values (v_account_id, v_att.id, 'lunch_end', p_latitude, p_longitude, p_accuracy_m, '퇴근 시 자동 종료');
  end if;

  select greatest(v_break, coalesce(sum(greatest(0,
    floor(extract(epoch from (paired.end_at - s.event_at)) / 60)::integer)), 0)) into v_break
  from public.driver_events s
  join lateral (select min(e.event_at) as end_at from public.driver_events e
    where e.attendance_id = s.attendance_id and e.event_type = 'lunch_end'
      and e.event_at > s.event_at) paired on paired.end_at is not null
  where s.attendance_id = v_att.id and s.event_type = 'lunch_start';

  v_elapsed := greatest(0, floor(extract(epoch from (now() - v_att.start_at)) / 60)::integer);
  if v_break > v_elapsed then raise exception '휴게시간이 전체 근무시간보다 길 수 없습니다.'; end if;
  v_bonus := case when v_att.start_region = '인천' then 60 else 0 end
    + case when v_region = '인천' then 60 else 0 end;

  update public.driver_attendance set end_at = now(), end_latitude = p_latitude,
    end_longitude = p_longitude, end_accuracy_m = p_accuracy_m,
    end_region = v_region, end_location_text = v_location_text,
    break_minutes = v_break, actual_minutes = v_elapsed - v_break,
    bonus_minutes = v_bonus, recognized_minutes = v_elapsed - v_break + v_bonus,
    status = 'completed', updated_at = now() where id = v_att.id returning * into v_att;
  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values ('배송기사근태', '퇴근', v_att.id::text, v_location_text, to_jsonb(v_att));
  return jsonb_build_object('ok', true, 'message', '퇴근이 기록되었습니다.',
    'locationName', v_location_text, 'bonusMinutes', v_bonus);
end;
$dbmt$;

grant execute on function public.dbmt_driver_clock(
  text, text, double precision, double precision, double precision, integer, text, text
) to anon, authenticated;
notify pgrst, 'reload schema';
