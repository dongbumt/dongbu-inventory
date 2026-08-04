-- Remove coordinate text from existing attendance labels while preserving GPS columns.

with updated as (
  update public.driver_attendance
  set start_location_text = case
        when coalesce(start_location_text, '') ~ '^GPS [-0-9]'
          then case when start_region = '인천' then '인천시' else '주소 정보 없음' end
        else start_location_text end,
      end_location_text = case
        when coalesce(end_location_text, '') ~ '^GPS [-0-9]'
          then case when end_region = '인천' then '인천시' else '주소 정보 없음' end
        else end_location_text end,
      updated_at = now()
  where deleted_at is null
    and (coalesce(start_location_text, '') ~ '^GPS [-0-9]'
      or coalesce(end_location_text, '') ~ '^GPS [-0-9]')
  returning id
)
insert into public.change_logs(entity, action, summary, payload)
select '배송기사근태', '위치표기보정',
  '기존 GPS 좌표 문구를 간단 지역명으로 보정',
  jsonb_build_object('count', count(*))
from updated;
