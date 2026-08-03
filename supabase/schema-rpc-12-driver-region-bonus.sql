-- Recalculate completed attendance using independent Incheon start/end bonuses.

with updated as (
  update public.driver_attendance
  set bonus_minutes =
        case when start_region = '인천' then 60 else 0 end
        + case when end_region = '인천' then 60 else 0 end,
      recognized_minutes = case when actual_minutes is null then null else
        actual_minutes
        + case when start_region = '인천' then 60 else 0 end
        + case when end_region = '인천' then 60 else 0 end end,
      updated_at = now()
  where end_at is not null and deleted_at is null
  returning id
)
insert into public.change_logs(entity, action, summary, payload)
select '배송기사근태', '인천가산재계산',
  '출근·퇴근 인천 가산시간을 각각 60분 기준으로 재계산',
  jsonb_build_object('count', count(*))
from updated;
