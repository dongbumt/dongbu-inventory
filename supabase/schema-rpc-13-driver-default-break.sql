-- Apply the standard 60-minute lunch break to completed mobile attendance records.

with updated as (
  update public.driver_attendance
  set break_minutes = 60,
      actual_minutes = greatest(0,
        floor(extract(epoch from (end_at - start_at)) / 60)::integer - 60),
      recognized_minutes = greatest(0,
        floor(extract(epoch from (end_at - start_at)) / 60)::integer - 60)
        + coalesce(bonus_minutes, 0),
      updated_at = now()
  where source in ('mobile', 'mobile_edited')
    and end_at is not null
    and deleted_at is null
    and coalesce(break_minutes, 0) = 0
    and end_at - start_at >= interval '60 minutes'
  returning id
)
insert into public.change_logs(entity, action, summary, payload)
select '배송기사근태', '휴게시간보정',
  '모바일 완료 기록의 기본 휴게시간을 60분으로 보정',
  jsonb_build_object('count', count(*))
from updated;
