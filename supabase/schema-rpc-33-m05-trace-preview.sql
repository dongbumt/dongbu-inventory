-- M05 T02 foundation: read-only reporting candidate preview and duplicate guard.
-- No institution API is called and previewing data never creates a queue row.

insert into public.erp_permission_catalog(menu_code, menu_name, sort_order, active, updated_at)
values ('trace_integration', '이력연계', 225, true, now())
on conflict (menu_code) do update set
  menu_name = excluded.menu_name,
  sort_order = excluded.sort_order,
  active = true,
  updated_at = now();

insert into public.erp_role_permissions(
  role_id, menu_code, can_view, can_create, can_update, can_delete,
  can_close, can_api_send, can_admin
)
select r.id, 'trace_integration', true, true, true, true, true, true, true
from public.erp_roles r
where r.system_role or lower(r.code) = 'admin'
on conflict (role_id, menu_code) do update set
  can_view = true, can_create = true, can_update = true, can_delete = true,
  can_close = true, can_api_send = true, can_admin = true;

insert into public.erp_role_permissions(
  role_id, menu_code, can_view, can_create, can_update, can_delete,
  can_close, can_api_send, can_admin
)
select r.id, 'trace_integration', true, false, false, false, true, false, false
from public.erp_roles r
where lower(r.code) = 'ceo'
on conflict (role_id, menu_code) do nothing;

create table if not exists public.trace_submission_registry (
  id uuid primary key default extensions.gen_random_uuid(),
  provider text not null,
  report_type text not null,
  source_key text not null,
  idempotency_key text not null,
  source_fingerprint text not null,
  external_reference_no text,
  status text not null default 'draft',
  request_snapshot jsonb not null default '{}'::jsonb,
  response_snapshot jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0,
  last_error text,
  created_by uuid references public.erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_attempted_at timestamptz,
  completed_at timestamptz,
  constraint trace_submission_registry_provider_valid check (
    provider in ('meatwatch', 'domestic_cattle', 'domestic_pig')
  ),
  constraint trace_submission_registry_report_type_valid check (
    report_type in ('sale', 'transfer', 'process', 'adjustment', 'bundle', 'inbound', 'outbound', 'packaging')
  ),
  constraint trace_submission_registry_source_key_valid check (
    source_key = btrim(source_key) and char_length(source_key) between 3 and 180
  ),
  constraint trace_submission_registry_idempotency_key_valid check (
    idempotency_key ~ '^[0-9a-f]{64}$'
  ),
  constraint trace_submission_registry_external_ref_valid check (
    external_reference_no is null
    or (external_reference_no = btrim(external_reference_no) and char_length(external_reference_no) between 1 and 50)
  ),
  constraint trace_submission_registry_status_valid check (
    status in ('draft', 'queued', 'sending', 'succeeded', 'failed', 'correction_required', 'cancelled')
  ),
  constraint trace_submission_registry_attempt_count_valid check (attempt_count >= 0)
);

create unique index if not exists uq_trace_submission_registry_source
  on public.trace_submission_registry(provider, report_type, source_key);
create unique index if not exists uq_trace_submission_registry_idempotency
  on public.trace_submission_registry(idempotency_key);
create unique index if not exists uq_trace_submission_registry_external_reference
  on public.trace_submission_registry(external_reference_no)
  where external_reference_no is not null;
create index if not exists idx_trace_submission_registry_status
  on public.trace_submission_registry(status, updated_at desc);

alter table public.trace_submission_registry enable row level security;
revoke all on table public.trace_submission_registry from public, anon, authenticated;

create or replace function public.dbmt_trace_idempotency_key(
  p_provider text,
  p_report_type text,
  p_source_key text
)
returns text
language sql
immutable
strict
set search_path = public, extensions
as $dbmt$
  select encode(
    extensions.digest(
      lower(btrim(p_provider)) || '|' || lower(btrim(p_report_type)) || '|' || btrim(p_source_key),
      'sha256'
    ),
    'hex'
  );
$dbmt$;

create or replace function public.dbmt_erp_trace_preview(
  p_token text,
  p_from date default null,
  p_to date default null,
  p_provider text default 'all',
  p_status text default 'all',
  p_query text default '',
  p_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_user_id uuid := public.dbmt_erp_session_user(p_token);
  v_from date := coalesce(p_from, current_date - 30);
  v_to date := coalesce(p_to, current_date);
  v_provider text := lower(btrim(coalesce(p_provider, 'all')));
  v_status text := lower(btrim(coalesce(p_status, 'all')));
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 1000);
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception '개인 사용자 로그인이 만료되었습니다.';
  end if;
  if public.dbmt_erp_has_permission(p_token, 'trace_integration', 'view') is not true then
    raise exception '이력연계를 조회할 권한이 없습니다.';
  end if;
  if v_from > v_to then
    raise exception '조회 시작일은 종료일보다 늦을 수 없습니다.';
  end if;
  if v_to - v_from > 370 then
    raise exception '조회 기간은 최대 1년까지 선택할 수 있습니다.';
  end if;
  if v_provider not in ('all', 'meatwatch', 'domestic') then
    raise exception '연계기관 조회 조건을 확인해주세요.';
  end if;
  if v_status not in ('all', 'ready', 'review', 'excluded', 'registered', 'sent') then
    raise exception '준비상태 조회 조건을 확인해주세요.';
  end if;

  with product_rows as (
    select e.item
    from public.app_data a
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(a.payload) = 'array' then a.payload else '[]'::jsonb end
    ) e(item)
    where a.key = 'labelProducts'
  ),
  site_identifiers as (
    select
      max(i.identifier_value) filter (
        where i.provider = 'meatwatch' and i.identifier_type in ('warehouse_manage_no', 'partner_manage_no')
      ) as meatwatch_manage_no,
      max(i.identifier_value) filter (
        where i.provider = 'mtrace' and i.identifier_type in ('corp_no', 'business_manage_no')
      ) as mtrace_corp_no
    from public.companies c
    join public.business_sites s on s.company_id = c.id and s.active
    left join public.business_site_identifiers i
      on i.business_site_id = s.id and i.active
      and (i.valid_from is null or i.valid_from <= v_to)
      and (i.valid_to is null or i.valid_to >= v_from)
    where c.is_primary and c.active
  ),
  source_rows as (
    select t.*,
      coalesce(nullif(t.raw->>'labelProductId', ''), nullif(t.raw->>'productId', '')) as label_product_id
    from public.transactions t
    where t.deleted_at is null
      and t.date between v_from and v_to
  ),
  enriched as (
    select s.*,
      p.item as product_meta,
      coalesce(
        nullif(p.item->>'meattype', ''),
        case
          when coalesce(nullif(s.raw->>'productCode', ''), p.item->>'productCode', '') like '1%' then '소고기'
          when coalesce(nullif(s.raw->>'productCode', ''), p.item->>'productCode', '') like '2%' then '돼지고기'
          else null
        end
      ) as meat_type,
      coalesce(nullif(s.raw->>'productCode', ''), p.item->>'productCode', '') as product_code,
      coalesce(nullif(s.raw->>'nationalPartCode', ''), p.item->>'nationalPartCode', '') as national_part_code,
      bp.business_partner_id,
      bp.meatwatch_partner_no,
      bp.meatwatch_warehouse_no,
      bp.mtrace_corp_no,
      si.meatwatch_manage_no as own_meatwatch_manage_no,
      si.mtrace_corp_no as own_mtrace_corp_no
    from source_rows s
    left join lateral (
      select pr.item
      from product_rows pr
      where (s.label_product_id <> '' and pr.item->>'id' = s.label_product_id)
         or (
           lower(btrim(coalesce(pr.item->>'name', ''))) = lower(btrim(coalesce(s.product, '')))
           and lower(btrim(coalesce(pr.item->>'origin', ''))) = lower(btrim(coalesce(s.origin, '')))
         )
      order by case when s.label_product_id <> '' and pr.item->>'id' = s.label_product_id then 0 else 1 end
      limit 1
    ) p on true
    left join lateral (
      select
        partner.id as business_partner_id,
        max(identifier.identifier_value) filter (
          where identifier.provider = 'meatwatch' and identifier.identifier_type = 'partner_manage_no'
        ) as meatwatch_partner_no,
        max(identifier.identifier_value) filter (
          where identifier.provider = 'meatwatch' and identifier.identifier_type = 'warehouse_manage_no'
        ) as meatwatch_warehouse_no,
        max(identifier.identifier_value) filter (
          where identifier.provider = 'mtrace' and identifier.identifier_type = 'corp_no'
        ) as mtrace_corp_no
      from public.business_partners partner
      left join public.business_partner_identifiers identifier
        on identifier.business_partner_id = partner.id and identifier.active
      where partner.active
        and (
          lower(partner.name) = lower(btrim(coalesce(s.trader, '')))
          or exists (
            select 1 from public.business_partner_aliases alias
            where alias.business_partner_id = partner.id
              and lower(alias.alias_name) = lower(btrim(coalesce(s.trader, '')))
          )
        )
      group by partner.id, partner.name
      order by case when lower(partner.name) = lower(btrim(coalesce(s.trader, ''))) then 0 else 1 end
      limit 1
    ) bp on true
    cross join site_identifiers si
  ),
  classified as (
    select e.*,
      case
        when e.meat_type = '소고기' and e.origin like '%국내%' then 'domestic_cattle'
        when e.meat_type = '돼지고기' and e.origin like '%국내%' then 'domestic_pig'
        when e.meat_type in ('소고기', '돼지고기') and coalesce(e.origin, '') <> '' then 'meatwatch'
        else 'unsupported'
      end as provider_code,
      case
        when e.origin not like '%국내%' and e.type = '출고' then 'sale'
        when e.origin not like '%국내%' and e.type = '재고이동' then 'transfer'
        when e.origin not like '%국내%' and e.type in ('사용', '생산입고') then 'process'
        when e.origin not like '%국내%' and (e.type = '재고조정' or e.is_stock_adjust) then 'adjustment'
        when e.origin not like '%국내%' and e.type = '입고' then 'lookup_only'
        when e.origin like '%국내%' and e.type = '입고' then 'inbound'
        when e.origin like '%국내%' and e.type = '출고' then 'outbound'
        when e.origin like '%국내%' and e.type in ('사용', '생산입고') then 'packaging'
        else 'unsupported'
      end as report_type_code,
      case
        when e.type in ('사용', '생산입고') and nullif(e.prod_id, '') is not null then 'prod:' || e.prod_id
        else 'tx:' || e.id
      end as source_key
    from enriched e
    where e.meat_type in ('소고기', '돼지고기')
       or nullif(btrim(coalesce(e.lot, '')), '') is not null
  ),
  keyed as (
    select c.*,
      case c.provider_code
        when 'meatwatch' then 'MeatWatch'
        when 'domestic_cattle' then '국내산 소'
        when 'domestic_pig' then '국내산 돼지'
        else '판정 필요'
      end as provider_label,
      case c.report_type_code
        when 'sale' then '판매'
        when 'transfer' then '이동'
        when 'process' then '가공'
        when 'adjustment' then '조정'
        when 'bundle' then '묶음'
        when 'inbound' then '입고'
        when 'outbound' then '출고'
        when 'packaging' then '포장'
        when 'lookup_only' then '조회자료'
        else '판정 필요'
      end as report_type_label,
      public.dbmt_trace_idempotency_key(
        c.provider_code,
        c.report_type_code,
        c.source_key
      ) as idempotency_key,
      encode(extensions.digest(concat_ws('|',
        c.id, c.date::text, c.type, c.product, c.origin, c.trader, c.lot,
        c.weight::text, c.from_location, c.to_location, c.raw::text
      ), 'sha256'), 'hex') as source_fingerprint
    from classified c
  ),
  judged as (
    select k.*,
      registry.id as registry_id,
      registry.status as registry_status,
      registry.external_reference_no,
      registry.source_fingerprint as registered_fingerprint,
      case
        when k.provider_code = 'unsupported' or k.report_type_code = 'unsupported' then 'excluded'
        when k.report_type_code = 'lookup_only' then 'excluded'
        when nullif(btrim(coalesce(k.lot, '')), '') is null then 'review'
        when k.date is null or coalesce(k.weight, 0) <= 0 then 'review'
        when k.report_type_code in ('process', 'packaging') then 'review'
        when k.report_type_code = 'adjustment' then 'review'
        when k.report_type_code = 'transfer'
          and (nullif(k.from_location, '') is null or nullif(k.to_location, '') is null) then 'review'
        when k.report_type_code = 'transfer' and nullif(k.own_meatwatch_manage_no, '') is null then 'review'
        when k.provider_code = 'meatwatch' and k.report_type_code = 'sale'
          and nullif(k.meatwatch_partner_no, '') is null then 'review'
        when k.provider_code in ('domestic_cattle', 'domestic_pig')
          and k.report_type_code in ('inbound', 'outbound')
          and nullif(k.mtrace_corp_no, '') is null then 'review'
        else 'ready'
      end as base_status,
      concat_ws(' · ',
        case when k.provider_code = 'unsupported' then '소·돼지 이력대상 품목인지 확인 필요' end,
        case when k.report_type_code = 'unsupported' then '현재 거래구분은 신고유형으로 연결되지 않음' end,
        case when k.report_type_code = 'lookup_only' then '수입육 입고는 이력조회 자료이며 판매·이동 신고대상에서는 제외' end,
        case when nullif(btrim(coalesce(k.lot, '')), '') is null then '이력번호 없음' end,
        case when k.date is null then '거래일자 없음' end,
        case when coalesce(k.weight, 0) <= 0 then '중량 확인 필요' end,
        case when k.report_type_code in ('process', 'packaging') then '생산 투입·생산품을 작업 단위로 묶는 기능 필요' end,
        case when k.report_type_code = 'adjustment' then '기관 조정 사유코드 선택 기능 필요' end,
        case when k.report_type_code = 'transfer'
          and (nullif(k.from_location, '') is null or nullif(k.to_location, '') is null)
          then '이동 출발·도착 사업장 확인 필요' end,
        case when k.report_type_code = 'transfer' and nullif(k.own_meatwatch_manage_no, '') is null
          then '법인·사업장에 MeatWatch 관리번호 등록 필요' end,
        case when k.provider_code = 'meatwatch' and k.report_type_code = 'sale'
          and nullif(k.meatwatch_partner_no, '') is null
          then '거래처에 MeatWatch 관리번호 등록 필요' end,
        case when k.provider_code in ('domestic_cattle', 'domestic_pig')
          and k.report_type_code in ('inbound', 'outbound') and nullif(k.mtrace_corp_no, '') is null
          then '거래처에 이력제 법인번호 등록 필요' end
      ) as base_reason
    from keyed k
    left join public.trace_submission_registry registry
      on registry.provider = k.provider_code
      and registry.report_type = k.report_type_code
      and registry.source_key = k.source_key
  ),
  resolved as (
    select j.*,
      case
        when j.registry_id is not null and j.registered_fingerprint <> j.source_fingerprint then 'review'
        when j.registry_status = 'succeeded' then 'sent'
        when j.registry_status in ('draft', 'queued', 'sending', 'failed', 'correction_required', 'cancelled') then 'registered'
        else j.base_status
      end as integration_status,
      concat_ws(' · ',
        nullif(j.base_reason, ''),
        case when j.registry_id is not null and j.registered_fingerprint <> j.source_fingerprint
          then '대기열 등록 후 원자료가 변경되어 정정 필요' end,
        case when j.registry_status = 'failed' then '이전 전송 실패 기록 있음' end,
        case when j.registry_status = 'correction_required' then '기관 정정 필요 상태' end
      ) as reason,
      case
        when j.provider_code = 'meatwatch' and j.report_type_code = 'sale' then j.meatwatch_partner_no
        when j.provider_code in ('domestic_cattle', 'domestic_pig') then j.mtrace_corp_no
        when j.report_type_code = 'transfer' then j.own_meatwatch_manage_no
        else null
      end as target_identifier
    from judged j
  ),
  filtered_base as (
    select r.*
    from resolved r
    where (v_provider = 'all'
      or (v_provider = 'meatwatch' and r.provider_code = 'meatwatch')
      or (v_provider = 'domestic' and r.provider_code in ('domestic_cattle', 'domestic_pig')))
      and (
        v_query = ''
        or lower(concat_ws(' ', r.date::text, r.type, r.product, r.product_code, r.origin,
          r.trader, r.lot, r.provider_label, r.report_type_label, r.reason)) like '%' || v_query || '%'
      )
  ),
  visible as (
    select f.*
    from filtered_base f
    where v_status = 'all' or f.integration_status = v_status
  ),
  limited_rows as (
    select * from visible
    order by date desc, id desc
    limit v_limit
  )
  select jsonb_build_object(
    'ok', true,
    'fromDate', v_from,
    'toDate', v_to,
    'summary', jsonb_build_object(
      'total', (select count(*) from filtered_base),
      'ready', (select count(*) from filtered_base where integration_status = 'ready'),
      'review', (select count(*) from filtered_base where integration_status = 'review'),
      'excluded', (select count(*) from filtered_base where integration_status = 'excluded'),
      'registered', (select count(*) from filtered_base where integration_status = 'registered'),
      'sent', (select count(*) from filtered_base where integration_status = 'sent'),
      'matched', (select count(*) from visible)
    ),
    'hasMore', (select count(*) from visible) > v_limit,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'transactionId', lr.id,
        'date', lr.date,
        'transactionType', lr.type,
        'product', lr.product,
        'productCode', lr.product_code,
        'meatType', lr.meat_type,
        'origin', lr.origin,
        'trader', lr.trader,
        'lot', lr.lot,
        'weight', lr.weight,
        'fromLocation', lr.from_location,
        'toLocation', lr.to_location,
        'provider', lr.provider_code,
        'providerLabel', lr.provider_label,
        'reportType', lr.report_type_code,
        'reportTypeLabel', lr.report_type_label,
        'status', lr.integration_status,
        'reason', coalesce(nullif(lr.reason, ''), '전송 준비자료 확인 완료'),
        'sourceKey', lr.source_key,
        'idempotencyKey', lr.idempotency_key,
        'targetIdentifier', coalesce(lr.target_identifier, ''),
        'registryStatus', coalesce(lr.registry_status, ''),
        'externalReferenceNo', coalesce(lr.external_reference_no, ''),
        'updatedAt', lr.updated_at
      ) order by lr.date desc, lr.id desc)
      from limited_rows lr
    ), '[]'::jsonb)
  ) into v_result;

  update public.erp_user_sessions
  set last_used_at = now()
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');

  return v_result;
end;
$dbmt$;

revoke all on function public.dbmt_trace_idempotency_key(text, text, text) from public, anon, authenticated;
revoke all on function public.dbmt_erp_trace_preview(text, date, date, text, text, text, integer) from public;
grant execute on function public.dbmt_erp_trace_preview(text, date, date, text, text, text, integer) to anon, authenticated;

notify pgrst, 'reload schema';
