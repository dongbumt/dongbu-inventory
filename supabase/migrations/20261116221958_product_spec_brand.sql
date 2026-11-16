-- Brand snapshots belong to each spec; only exact existing catalog links are backfilled.
alter table public.product_specs add column brand text not null default '' check(length(brand)<=200);
update public.product_specs s set brand=btrim(coalesce(p->>'brand',''))
from public.app_data d cross join lateral jsonb_array_elements(d.payload) p
where d.key='labelProducts' and p->>'id'=s.material_product_id
  and length(btrim(coalesce(p->>'brand',''))) between 1 and 200;

create or replace function public.dbmt_erp_save_product_spec(
  p_token text,p_id uuid,p_record jsonb,p_revision integer default null
)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare
  v_user uuid:=public.dbmt_erp_session_user(p_token);
  v_action text:=case when p_id is null then 'create' else 'update' end;
  v_old public.product_specs%rowtype; v_row public.product_specs%rowtype;
  v_trader text;v_distribution text;v_material text;v_origin text;v_cutting text;v_inner text;v_outer text;v_note text;
  v_price_kg numeric;v_price_box numeric;v_monthly numeric;v_material_id text;v_brand text;v_catalog jsonb;v_product jsonb;
begin
  if v_user is null then return jsonb_build_object('ok',false,'message','개인 사용자 로그인이 만료되었습니다.'); end if;
  if public.dbmt_erp_has_permission(p_token,'product_specs','view') is not true then return public.dbmt_erp_permission_denied(v_user,'product_specs','view'); end if;
  if public.dbmt_erp_has_permission(p_token,'product_specs',v_action) is not true then return public.dbmt_erp_permission_denied(v_user,'product_specs',v_action); end if;
  if p_record is null or jsonb_typeof(p_record)<>'object' then raise exception '제품스펙 입력 형식을 확인해주세요.'; end if;
  if p_id is not null then
    select * into v_old from public.product_specs where id=p_id for update;
    if not found then raise exception '수정할 제품스펙을 찾을 수 없습니다. 새로고침해주세요.'; end if;
    if p_revision is distinct from v_old.revision then raise exception '다른 사용자가 이 스펙을 변경했습니다. 새로고침 후 다시 수정해주세요.'; end if;
  elsif p_revision is not null then raise exception '새 스펙에는 수정번호를 지정할 수 없습니다.';
  end if;
  v_trader:=btrim(coalesce(p_record->>'trader',''));v_material:=btrim(coalesce(p_record->>'material',''));
  v_brand:=case when p_record?'brand' then btrim(coalesce(p_record->>'brand','')) else coalesce(v_old.brand,'') end;
  v_distribution:=btrim(coalesce(p_record->>'distribution',''));v_origin:=btrim(coalesce(p_record->>'origin',''));
  v_cutting:=btrim(coalesce(p_record->>'cutting_spec',''));v_inner:=btrim(coalesce(p_record->>'inner_packaging_spec',p_record->>'packaging_spec',''));
  v_outer:=btrim(coalesce(p_record->>'outer_packaging_spec',''));v_note:=btrim(coalesce(p_record->>'note',''));
  v_material_id:=case when p_record?'material_product_id' then nullif(btrim(p_record->>'material_product_id'),'') else v_old.material_product_id end;
  if v_material_id is not null then
    if length(v_material_id)>120 then raise exception '등록 제품 또는 원료육을 다시 선택해주세요.'; end if;
    select payload into v_catalog from public.app_data where key='labelProducts' for share;
    select e into v_product from jsonb_array_elements(coalesce(v_catalog,'[]'::jsonb)) e where e->>'id'=v_material_id;
    if v_product is not null and btrim(coalesce(v_product->>'kind','')) in ('제품','원료육') and v_product->'isActive' is distinct from 'false'::jsonb then
      v_material:=btrim(coalesce(v_product->>'name',''));
      if not (p_record?'brand') and (p_id is null or v_material_id is distinct from v_old.material_product_id) then
        v_brand:=btrim(coalesce(v_product->>'brand',''));
      end if;
    elsif p_id is null or v_material_id is distinct from v_old.material_product_id or v_material is distinct from v_old.material then
      raise exception '품목관리에 등록된 사용 가능한 제품 또는 원료육을 선택해주세요.';
    end if;
  elsif p_record?'material_product_id' and (p_id is null or v_old.material_product_id is not null or v_material is distinct from v_old.material) then
    raise exception '품목관리에 등록된 제품 또는 원료육을 선택해주세요.';
  end if;
  if length(v_trader) not between 1 and 200 or length(v_material) not between 1 and 200 then raise exception '거래처와 원재료를 200자 이내로 입력해주세요.'; end if;
  if length(v_brand)>200 then raise exception '브랜드는 200자 이내로 입력해주세요.'; end if;
  if length(v_distribution)>200 then raise exception '유통은 200자 이내로 입력해주세요.'; end if;
  if length(v_origin)>100 or length(v_cutting)>300 or length(v_inner)>300 or length(v_outer)>300 or length(v_note)>1000 then raise exception '원산지·세절스펙·내포장 스펙·외포장 스펙·비고의 글자 수를 확인해주세요.'; end if;
  if p_record?'monthly_usage' and p_record->'monthly_usage'<>'null'::jsonb then
    if jsonb_typeof(p_record->'monthly_usage')<>'number' then raise exception '월사용량은 숫자로 입력해주세요.'; end if;
    v_monthly:=(p_record->>'monthly_usage')::numeric;
    if v_monthly<0 or v_monthly>999999999 or round(v_monthly,6)<>v_monthly then raise exception '월사용량은 0 이상, 소수 여섯 자리까지 입력해주세요.'; end if;
  end if;
  if p_record?'price_kg' and p_record->'price_kg'<>'null'::jsonb then
    if jsonb_typeof(p_record->'price_kg')<>'number' then raise exception 'KG 단가는 숫자로 입력해주세요.'; end if;
    v_price_kg:=(p_record->>'price_kg')::numeric;
    if v_price_kg<0 or v_price_kg>999999999 or round(v_price_kg,2)<>v_price_kg then raise exception 'KG 단가는 0 이상, 소수 둘째 자리까지 입력해주세요.'; end if;
  end if;
  if p_record?'price_box' and p_record->'price_box'<>'null'::jsonb then
    if jsonb_typeof(p_record->'price_box')<>'number' then raise exception 'BOX 단가는 숫자로 입력해주세요.'; end if;
    v_price_box:=(p_record->>'price_box')::numeric;
    if v_price_box<0 or v_price_box>999999999 or round(v_price_box,2)<>v_price_box then raise exception 'BOX 단가는 0 이상, 소수 둘째 자리까지 입력해주세요.'; end if;
  end if;
  if p_id is null then
    insert into public.product_specs(trader,distribution,material,brand,material_product_id,origin,cutting_spec,inner_packaging_spec,outer_packaging_spec,monthly_usage,price_kg,price_box,note)
    values(v_trader,v_distribution,v_material,v_brand,v_material_id,v_origin,v_cutting,v_inner,v_outer,v_monthly,v_price_kg,v_price_box,v_note) returning * into v_row;
  else
    update public.product_specs set trader=v_trader,material=v_material,brand=v_brand,material_product_id=v_material_id,origin=v_origin,cutting_spec=v_cutting,
      distribution=case when p_record?'distribution' then v_distribution else v_old.distribution end,inner_packaging_spec=v_inner,
      outer_packaging_spec=case when p_record?'outer_packaging_spec' then v_outer else v_old.outer_packaging_spec end,
      monthly_usage=case when p_record?'monthly_usage' then v_monthly else v_old.monthly_usage end,
      price_kg=v_price_kg,price_box=v_price_box,note=v_note,revision=revision+1,updated_at=clock_timestamp() where id=p_id returning * into v_row;
  end if;
  insert into public.change_logs(entity,action,entity_id,summary,payload) values('제품스펙',case when p_id is null then '등록' else '수정' end,
    v_row.id::text,v_row.trader||' / '||v_row.material,jsonb_build_object('userId',v_user,'authMode','personal_session','before',case when p_id is null then null else to_jsonb(v_old) end,'after',to_jsonb(v_row)));
  return jsonb_build_object('ok',true,'spec',to_jsonb(v_row)||jsonb_build_object('packaging_spec',v_row.inner_packaging_spec));
end;
$fn$;
notify pgrst,'reload schema';
