-- Exact price-table identity, matching the existing browser product/origin/trader rules.
create or replace function public.dbmt_price_identity_key(p_product text, p_origin text, p_trader text)
returns text
language sql immutable
set search_path = ''
as $sql$
  with parts as (
    select lower(regexp_replace(coalesce(p_product,''), '[[:space:] ]+', '', 'g')) as product,
      lower(regexp_replace(coalesce(p_origin,''), '[[:space:] ]+', '', 'g')) as origin,
      lower(regexp_replace(coalesce(p_trader,''), '[[:space:] ]+', '', 'g')) as trader
  )
  select jsonb_build_array(product, case origin
    when '미국' then '미국산' when 'usa' then '미국산' when 'us' then '미국산'
    when '호주' then '호주산'
    when '국내' then '국내산' when '국산' then '국내산' when '한국' then '국내산'
    when '덴마크산' then '덴마크' when '독일산' then '독일' when '스페인산' then '스페인'
    when '오스트리아산' then '오스트리아' when '칠레산' then '칠레'
    else origin end, trader)::text from parts;
$sql$;
revoke all on function public.dbmt_price_identity_key(text,text,text) from public, anon, authenticated;

-- One short transaction serializes price writes, checks exact keys, and reuses existing IDs.
-- A conflicting price requires the user's confirmation of the current server value/version.
create or replace function public.dbmt_erp_save_outbound_prices(
  p_token text, p_rows jsonb, p_expected jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_input jsonb;
  v_catalog jsonb;
  v_product_names jsonb;
  v_product text;
  v_origin text;
  v_trader text;
  v_price numeric;
  v_key text;
  v_seen jsonb := '{}'::jsonb;
  v_existing public.prices%rowtype;
  v_count integer;
  v_row jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_changes jsonb := '[]'::jsonb;
  v_conflicts jsonb := '[]'::jsonb;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
begin
  perform public.dbmt_erp_authorize_legacy(p_token, 'transactions', 'view');
  if public.dbmt_erp_has_permission(p_token,'prices','create') is not true
    and public.dbmt_erp_has_permission(p_token,'prices','update') is not true then
    raise exception '단가표를 등록하거나 수정할 권한이 없습니다.';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_typeof(p_expected) is distinct from 'array' then
    raise exception '단가 저장 형식이 올바르지 않습니다.';
  end if;
  if jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 500 or jsonb_array_length(p_expected) > 500 then
    raise exception '출고 단가는 한 번에 1~500건까지 저장할 수 있습니다.';
  end if;
  select payload into v_catalog from public.app_data where key='labelProducts';
  if jsonb_typeof(v_catalog) is distinct from 'array' then raise exception '품목관리 정보를 확인할 수 없습니다.'; end if;
  select jsonb_object_agg(public.dbmt_price_identity_key(item->>'name','',''),item->>'name')
    into v_product_names from jsonb_array_elements(v_catalog) item where coalesce(item->>'name','')<>'';
  lock table public.prices in share row exclusive mode;
  for v_input in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_input) <> 'object' then raise exception '단가 항목 형식이 올바르지 않습니다.'; end if;
    v_product := v_product_names ->> public.dbmt_price_identity_key(v_input->>'product','','');
    v_origin := btrim(coalesce(v_input->>'origin',''));
    v_trader := btrim(coalesce(v_input->>'trader',''));
    if coalesce(v_product,'')='' then raise exception '품목관리에 등록된 품목만 단가표에 저장할 수 있습니다.'; end if;
    if regexp_replace(v_trader, '[[:space:] ]+', '', 'g')='' then raise exception '거래처를 입력해주세요.'; end if;
    if jsonb_typeof(v_input->'price') is distinct from 'number' then raise exception '출고 단가는 숫자로 입력해주세요.'; end if;
    v_price := (v_input->>'price')::numeric;
    if v_price <= 0 then raise exception '출고 단가는 0보다 커야 합니다.'; end if;
    v_key := public.dbmt_price_identity_key(v_product,v_origin,v_trader);
    if v_seen ? v_key then
      if (v_seen->>v_key)::numeric <> v_price then raise exception '같은 품목·원산지·거래처의 단가가 서로 다릅니다.'; end if;
      continue;
    end if;
    v_seen := v_seen || jsonb_build_object(v_key,v_price);
    select count(*) into v_count from public.prices p where p.deleted_at is null
      and public.dbmt_price_identity_key(p.product,p.origin,p.trader)=v_key;
    if v_count > 1 then raise exception '% / % / %: 단가표에 기존 중복 항목이 있습니다. 단가표에서 정리한 후 저장해주세요.',v_product,v_origin,v_trader; end if;
    select * into v_existing from public.prices p where p.deleted_at is null
      and public.dbmt_price_identity_key(p.product,p.origin,p.trader)=v_key;
    if v_existing.id is null then
      if public.dbmt_erp_has_permission(p_token,'prices','create') is not true then raise exception '새 단가를 등록할 권한이 없습니다.'; end if;
      v_row := jsonb_build_object('id','price_' || gen_random_uuid()::text,'product',v_product,'origin',v_origin,'trader',v_trader,'price',v_price);
      v_changes := v_changes || jsonb_build_array(v_row);
      v_inserted := v_inserted + 1;
    else
      v_row := coalesce(v_existing.raw,'{}'::jsonb) || jsonb_build_object('id',v_existing.id,'product',v_existing.product,'origin',v_existing.origin,'trader',v_existing.trader,'price',v_existing.price);
      if v_existing.price is not distinct from v_price then
        v_skipped := v_skipped + 1;
      else
        if public.dbmt_erp_has_permission(p_token,'prices','update') is not true then raise exception '기존 단가를 수정할 권한이 없습니다.'; end if;
        if not exists(select 1 from jsonb_array_elements(p_expected) e where e->>'id'=v_existing.id
          and e->'oldPrice' is not distinct from coalesce(to_jsonb(v_existing.price),'null'::jsonb)
          and e->>'updatedAt' is not distinct from v_existing.updated_at::text
          and public.dbmt_price_identity_key(e->>'product',e->>'origin',e->>'trader')=v_key
          and e->'price'=to_jsonb(v_price)) then
          v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('id',v_existing.id,'product',v_product,'origin',v_origin,'trader',v_trader,
            'oldPrice',v_existing.price,'price',v_price,'updatedAt',v_existing.updated_at::text));
        end if;
        v_row := v_row || jsonb_build_object('price',v_price);
        v_changes := v_changes || jsonb_build_array(v_row);
        v_updated := v_updated + 1;
      end if;
    end if;
    v_rows := v_rows || jsonb_build_array(v_row);
  end loop;
  if jsonb_array_length(v_conflicts)>0 then
    return jsonb_build_object('ok',false,'confirmationRequired',true,'conflicts',v_conflicts);
  end if;
  if jsonb_array_length(v_changes)>0 then perform public.dbmt_upsert_prices('',v_changes); end if;
  return jsonb_build_object('ok',true,'rows',v_rows,'changedRows',v_changes,'inserted',v_inserted,'updated',v_updated,'skipped',v_skipped);
end;
$function$;
revoke all on function public.dbmt_erp_save_outbound_prices(text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.dbmt_erp_save_outbound_prices(text,jsonb,jsonb) to anon, authenticated;
