-- Driver-initiated lunch and location-share events.

create or replace function public.dbmt_driver_event(
  p_token text, p_event_type text, p_latitude double precision,
  p_longitude double precision, p_accuracy_m double precision, p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_account_id uuid := public.dbmt_driver_session_account(p_token);
  v_att public.driver_attendance%rowtype;
  v_last_break text;
  v_id uuid;
  v_message text;
begin
  if v_account_id is null then raise exception '로그인이 만료되었습니다.'; end if;
  if p_event_type not in ('location_share','lunch_start','lunch_end') then
    raise exception '잘못된 기록 종류입니다.';
  end if;
  if p_latitude not between -90 and 90 or p_longitude not between -180 and 180 then
    raise exception 'GPS 위치를 확인할 수 없습니다.';
  end if;
  select * into v_att from public.driver_attendance
  where account_id = v_account_id and end_at is null and deleted_at is null
  order by start_at desc limit 1;
  if v_att.id is null then raise exception '출근 기록 후 사용할 수 있습니다.'; end if;

  select event_type into v_last_break from public.driver_events
  where attendance_id = v_att.id and event_type in ('lunch_start','lunch_end')
  order by event_at desc limit 1;
  if p_event_type = 'lunch_start' and v_last_break = 'lunch_start' then
    raise exception '점심시간이 이미 시작되어 있습니다.';
  end if;
  if p_event_type = 'lunch_end' and coalesce(v_last_break, '') <> 'lunch_start' then
    raise exception '먼저 점심 시작을 기록해주세요.';
  end if;

  insert into public.driver_events(
    account_id, attendance_id, event_type, latitude, longitude, accuracy_m, note
  ) values (
    v_account_id, v_att.id, p_event_type, p_latitude, p_longitude,
    p_accuracy_m, nullif(btrim(coalesce(p_note,'')), '')
  ) returning id into v_id;

  v_message := case p_event_type when 'location_share' then '현재 위치가 공유되었습니다.'
    when 'lunch_start' then '점심 시작이 기록되었습니다.' else '점심 종료가 기록되었습니다.' end;
  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values ('배송기사근태', case p_event_type when 'location_share' then '위치공유'
    when 'lunch_start' then '점심시작' else '점심종료' end, v_id::text, v_message,
    jsonb_build_object('attendanceId', v_att.id, 'latitude', p_latitude,
      'longitude', p_longitude, 'accuracyM', p_accuracy_m));
  return jsonb_build_object('ok', true, 'id', v_id, 'message', v_message, 'eventAt', now());
end;
$dbmt$;

grant execute on function public.dbmt_driver_event(
  text, text, double precision, double precision, double precision, text
) to anon, authenticated;
notify pgrst, 'reload schema';
