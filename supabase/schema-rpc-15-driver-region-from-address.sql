-- Recalculate mobile Incheon bonuses from the GPS-derived short address.

with normalized as (
  select id,
    case
      when coalesce(start_location_text, '') ~ '^인천시( |$)' then '인천'
      when coalesce(start_location_text, '') ~ '^(서울시|부산시|대구시|광주시|대전시|울산시|세종시|경기도|강원도|충청북도|충청남도|전북도|전라북도|전남도|전라남도|경상북도|경상남도|제주도)( |$)' then '기타'
      else start_region
    end as start_region_new,
    case
      when coalesce(end_location_text, '') ~ '^인천시( |$)' then '인천'
      when coalesce(end_location_text, '') ~ '^(서울시|부산시|대구시|광주시|대전시|울산시|세종시|경기도|강원도|충청북도|충청남도|전북도|전라북도|전남도|전라남도|경상북도|경상남도|제주도)( |$)' then '기타'
      else end_region
    end as end_region_new
  from public.driver_attendance
  where deleted_at is null and source in ('mobile', 'mobile_edited')
), updated as (
  update public.driver_attendance d
  set start_region = n.start_region_new,
      end_region = n.end_region_new,
      bonus_minutes = case when n.start_region_new = '인천' then 60 else 0 end
        + case when n.end_region_new = '인천' then 60 else 0 end,
      recognized_minutes = case when d.actual_minutes is null then null else
        d.actual_minutes
        + case when n.start_region_new = '인천' then 60 else 0 end
        + case when n.end_region_new = '인천' then 60 else 0 end end,
      updated_at = now()
  from normalized n
  where d.id = n.id
    and (d.start_region is distinct from n.start_region_new
      or d.end_region is distinct from n.end_region_new
      or d.bonus_minutes is distinct from
        (case when n.start_region_new = '인천' then 60 else 0 end
          + case when n.end_region_new = '인천' then 60 else 0 end))
  returning d.id
)
insert into public.change_logs(entity, action, summary, payload)
select '배송기사근태', '인천가산보정',
  'GPS 주소 기준으로 출퇴근 지역과 인천 가산시간을 보정',
  jsonb_build_object('count', count(*))
from updated;
