-- M04 product-code registry.
-- Product codes are six numeric characters. 1xxxxx is beef, 2xxxxx is pork,
-- and 3xxxxx is other livestock. Issued codes are immutable and never reused.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.product_code_sequences (
  species_prefix smallint primary key,
  last_suffix integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint product_code_sequences_prefix_valid check (species_prefix between 1 and 3),
  constraint product_code_sequences_suffix_valid check (last_suffix between 0 and 99999)
);

create table if not exists public.product_code_registry (
  product_id text primary key,
  product_code text not null unique,
  species_prefix smallint not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint product_code_registry_product_id_valid check (
    product_id = btrim(product_id) and char_length(product_id) between 1 and 200
  ),
  constraint product_code_registry_prefix_valid check (species_prefix between 1 and 3),
  constraint product_code_registry_code_valid check (
    product_code ~ '^[123][0-9]{5}$'
    and substring(product_code from 1 for 1)::smallint = species_prefix
  )
);

create table if not exists public.product_master_backups (
  id bigserial primary key,
  backup_key text not null unique,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  constraint product_master_backups_key_valid check (
    backup_key = btrim(backup_key) and char_length(backup_key) between 1 and 100
  )
);

create index if not exists idx_product_code_registry_active
  on public.product_code_registry(deleted_at, product_code);

insert into public.product_code_sequences(species_prefix, last_suffix)
values (1,0),(2,0),(3,0)
on conflict (species_prefix) do nothing;

alter table public.product_code_sequences enable row level security;
alter table public.product_code_registry enable row level security;
alter table public.product_master_backups enable row level security;

revoke all on table public.product_code_sequences from public, anon, authenticated;
revoke all on table public.product_code_registry from public, anon, authenticated;
revoke all on table public.product_master_backups from public, anon, authenticated;
revoke all on table public.product_code_sequences from service_role;
revoke all on table public.product_code_registry from service_role;
revoke all on table public.product_master_backups from service_role;
grant select on table public.product_code_sequences to service_role;
grant select on table public.product_code_registry to service_role;
grant select on table public.product_master_backups to service_role;

create or replace function public.dbmt_product_species_prefix(p_meat_type text)
returns smallint
language sql
immutable
set search_path = public, extensions
as $dbmt$
  select case btrim(coalesce(p_meat_type,''))
    when '소고기' then 1::smallint
    when '돼지고기' then 2::smallint
    else 3::smallint
  end
$dbmt$;

create or replace function public.dbmt_ensure_product_codes(p_products jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_products jsonb := coalesce(p_products, '[]'::jsonb);
  v_result jsonb := '[]'::jsonb;
  v_seen_ids text[] := array[]::text[];
  v_row record;
  v_item jsonb;
  v_id text;
  v_incoming_code text;
  v_prefix smallint;
  v_suffix integer;
  v_code text;
  v_registry public.product_code_registry%rowtype;
begin
  if jsonb_typeof(v_products) <> 'array' then
    raise exception '품목 데이터 형식이 올바르지 않습니다.';
  end if;
  if jsonb_array_length(v_products) > 10000 then
    raise exception '품목은 최대 10,000개까지 관리할 수 있습니다.';
  end if;

  for v_row in
    select value as item, ordinality as ord
    from jsonb_array_elements(v_products) with ordinality
    order by ordinality
  loop
    v_item := v_row.item;
    if jsonb_typeof(v_item) <> 'object' then
      raise exception '품목 데이터에 올바르지 않은 항목이 있습니다.';
    end if;
    v_id := nullif(btrim(coalesce(v_item->>'id','')), '');
    if v_id is null or v_id = any(v_seen_ids) then
      loop
        v_id := 'lp_' || encode(extensions.gen_random_bytes(12), 'hex');
        exit when not (v_id = any(v_seen_ids))
          and not exists(select 1 from public.product_code_registry where product_id=v_id);
      end loop;
    end if;
    if char_length(v_id) > 200 then
      raise exception '품목 ID가 너무 깁니다.';
    end if;
    v_seen_ids := array_append(v_seen_ids, v_id);
    v_prefix := public.dbmt_product_species_prefix(v_item->>'meattype');
    v_incoming_code := nullif(btrim(coalesce(v_item->>'productCode','')), '');

    select * into v_registry
    from public.product_code_registry
    where product_id=v_id
    for update;

    if v_registry.product_id is null then
      update public.product_code_sequences
      set last_suffix=last_suffix+1, updated_at=now()
      where species_prefix=v_prefix and last_suffix<99999
      returning last_suffix into v_suffix;
      if v_suffix is null then
        raise exception '%번 축종의 제품코드를 더 이상 발급할 수 없습니다.', v_prefix;
      end if;
      v_code := v_prefix::text || lpad(v_suffix::text,5,'0');
      insert into public.product_code_registry(product_id,product_code,species_prefix)
      values(v_id,v_code,v_prefix)
      returning * into v_registry;
    else
      if v_registry.deleted_at is not null then
        raise exception '삭제된 품목 ID는 다시 사용할 수 없습니다.';
      end if;
      if v_registry.species_prefix <> v_prefix then
        raise exception '제품코드 %의 육종은 변경할 수 없습니다. 다른 육종은 새 품목으로 등록해주세요.', v_registry.product_code;
      end if;
      v_code := v_registry.product_code;
    end if;

    if v_incoming_code is not null and v_incoming_code <> v_code then
      raise exception '제품코드는 직접 변경할 수 없습니다.';
    end if;
    v_item := jsonb_set(v_item,'{id}',to_jsonb(v_id),true);
    v_item := jsonb_set(v_item,'{productCode}',to_jsonb(v_code),true);
    v_result := v_result || jsonb_build_array(v_item);
  end loop;
  return v_result;
end;
$dbmt$;

-- Give every existing product one permanent code in its current registration order.
insert into public.app_data(key,payload,updated_at)
values('labelProducts','[]'::jsonb,now())
on conflict(key) do nothing;

insert into public.product_master_backups(backup_key,payload)
select 'pre_product_codes_20260817090000',payload
from public.app_data where key='labelProducts'
on conflict(backup_key) do nothing;

update public.app_data
set payload=public.dbmt_ensure_product_codes(payload), updated_at=now()
where key='labelProducts';

create or replace function public.dbmt_erp_save_label_product(
  p_token text,
  p_record jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_user_id uuid := public.dbmt_erp_session_user(p_token);
  v_user public.erp_users%rowtype;
  v_role public.erp_roles%rowtype;
  v_products jsonb;
  v_record jsonb;
  v_before jsonb;
  v_saved jsonb;
  v_logs jsonb;
  v_log jsonb;
  v_id text;
  v_name text;
  v_brand text;
  v_factory_no text;
  v_part_code text;
  v_part_name text;
  v_part_scheme text;
  v_origin text;
  v_kind text;
  v_tax_type text;
  v_meat_type text;
  v_storage text;
  v_pack_unit text;
  v_item_no text;
  v_grade text;
  v_action text;
  v_shelf_days integer;
begin
  if v_user_id is null then
    return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.');
  end if;
  if jsonb_typeof(coalesce(p_record,'{}'::jsonb)) <> 'object' then
    raise exception '품목 입력 형식이 올바르지 않습니다.';
  end if;
  if exists(
    select 1 from jsonb_object_keys(coalesce(p_record,'{}'::jsonb)) k
    where k not in (
      'id','productCode','name','brand','factoryNo','nationalPartCode','nationalPartName',
      'nationalPartScheme','origin','kind','taxType','meattype','storage','shelfdays',
      'packunit','itemno','grade'
    )
  ) then
    raise exception '지원하지 않는 품목 입력항목이 있습니다.';
  end if;

  insert into public.app_data(key,payload,updated_at)
  values('labelProducts','[]'::jsonb,now())
  on conflict(key) do nothing;
  select case when jsonb_typeof(payload)='array' then payload else '[]'::jsonb end
  into v_products
  from public.app_data where key='labelProducts' for update;
  v_products := public.dbmt_ensure_product_codes(v_products);

  v_id := nullif(btrim(coalesce(p_record->>'id','')), '');
  if v_id is null then
    loop
      v_id := 'lp_' || encode(extensions.gen_random_bytes(12),'hex');
      exit when not exists(select 1 from jsonb_array_elements(v_products) e where e->>'id'=v_id)
        and not exists(select 1 from public.product_code_registry where product_id=v_id);
    end loop;
  end if;
  select e into v_before from jsonb_array_elements(v_products) e where e->>'id'=v_id limit 1;
  v_action := case when v_before is null then 'create' else 'update' end;
  if public.dbmt_erp_has_permission(p_token,'label_products',v_action) is not true then
    return public.dbmt_erp_permission_denied(v_user_id,'label_products',v_action);
  end if;

  v_name := btrim(coalesce(p_record->>'name',''));
  v_brand := nullif(btrim(coalesce(p_record->>'brand','')),'');
  v_factory_no := nullif(btrim(coalesce(p_record->>'factoryNo','')),'');
  v_part_code := upper(nullif(btrim(coalesce(p_record->>'nationalPartCode','')),''));
  v_part_name := nullif(btrim(coalesce(p_record->>'nationalPartName','')),'');
  v_part_scheme := nullif(btrim(coalesce(p_record->>'nationalPartScheme','')),'');
  v_origin := nullif(btrim(coalesce(p_record->>'origin','')),'');
  v_kind := coalesce(nullif(btrim(coalesce(p_record->>'kind','')),''),'원료육');
  v_tax_type := case when btrim(coalesce(p_record->>'taxType',''))='과세' then '과세' else '면세' end;
  v_meat_type := coalesce(nullif(btrim(coalesce(p_record->>'meattype','')),''),'돼지고기');
  v_storage := coalesce(nullif(btrim(coalesce(p_record->>'storage','')),''),'냉동');
  v_pack_unit := nullif(btrim(coalesce(p_record->>'packunit','')),'');
  v_item_no := nullif(btrim(coalesce(p_record->>'itemno','')),'');
  v_grade := nullif(btrim(coalesce(p_record->>'grade','')),'');
  begin
    v_shelf_days := coalesce(nullif(btrim(coalesce(p_record->>'shelfdays','')),'')::integer,365);
  exception when invalid_text_representation then
    raise exception '소비기한은 숫자로 입력해주세요.';
  end;

  if char_length(v_name) not between 1 and 200 then raise exception '제품명은 1~200자로 입력해주세요.'; end if;
  if v_brand is not null and char_length(v_brand)>100 then raise exception '브랜드는 100자 이내로 입력해주세요.'; end if;
  if v_factory_no is not null and char_length(v_factory_no)>100 then raise exception '공장넘버는 100자 이내로 입력해주세요.'; end if;
  if v_origin is not null and char_length(v_origin)>100 then raise exception '원산지는 100자 이내로 입력해주세요.'; end if;
  if v_kind not in ('원료육','제품') then raise exception '품목 유형을 확인해주세요.'; end if;
  if v_meat_type not in ('소고기','돼지고기','기타 축종') then raise exception '육종을 확인해주세요.'; end if;
  if v_storage not in ('냉동','냉장') then raise exception '보관방법을 확인해주세요.'; end if;
  if v_shelf_days not between 1 and 3650 then raise exception '소비기한은 1~3650일로 입력해주세요.'; end if;
  if v_meat_type in ('소고기','돼지고기') and coalesce(v_part_code,'')='' then
    raise exception '소고기와 돼지고기는 국가부위코드를 선택해주세요.';
  end if;
  if v_part_code is not null and v_part_code !~ '^[A-Z0-9]{2,20}$' then
    raise exception '국가부위코드 형식을 확인해주세요.';
  end if;
  if v_meat_type='기타 축종' then
    v_part_code:=null; v_part_name:=null; v_part_scheme:=null;
  end if;
  if exists(
    select 1 from jsonb_array_elements(v_products) e
    where e->>'id'<>v_id
      and lower(btrim(coalesce(e->>'name','')))=lower(v_name)
      and lower(btrim(coalesce(e->>'brand','')))=lower(coalesce(v_brand,''))
      and lower(btrim(coalesce(e->>'factoryNo','')))=lower(coalesce(v_factory_no,''))
      and upper(btrim(coalesce(e->>'nationalPartCode','')))=upper(coalesce(v_part_code,''))
      and lower(btrim(coalesce(e->>'origin','')))=lower(coalesce(v_origin,''))
      and btrim(coalesce(e->>'kind','원료육'))=v_kind
      and btrim(coalesce(e->>'meattype','돼지고기'))=v_meat_type
      and btrim(coalesce(e->>'storage','냉동'))=v_storage
      and coalesce(nullif(e->>'shelfdays','')::integer,0)=v_shelf_days
      and lower(btrim(coalesce(e->>'packunit','')))=lower(coalesce(v_pack_unit,''))
  ) then
    raise exception '이미 같은 품목이 등록되어 있습니다.';
  end if;

  v_record := jsonb_build_object(
    'id',v_id,
    'productCode',nullif(btrim(coalesce(p_record->>'productCode','')),''),
    'name',v_name,
    'brand',coalesce(v_brand,''),
    'factoryNo',coalesce(v_factory_no,''),
    'nationalPartCode',coalesce(v_part_code,''),
    'nationalPartName',coalesce(v_part_name,''),
    'nationalPartScheme',coalesce(v_part_scheme,''),
    'origin',coalesce(v_origin,''),
    'kind',v_kind,
    'taxType',v_tax_type,
    'meattype',v_meat_type,
    'storage',v_storage,
    'shelfdays',v_shelf_days,
    'packunit',coalesce(v_pack_unit,''),
    'itemno',coalesce(v_item_no,''),
    'grade',coalesce(v_grade,'')
  );

  if v_before is null then
    v_products := v_products || jsonb_build_array(v_record);
  else
    select coalesce(jsonb_agg(case when e->>'id'=v_id then v_record else e end order by ord),'[]'::jsonb)
    into v_products
    from jsonb_array_elements(v_products) with ordinality q(e,ord);
  end if;
  v_products := public.dbmt_ensure_product_codes(v_products);
  select e into v_saved from jsonb_array_elements(v_products) e where e->>'id'=v_id limit 1;
  update public.app_data set payload=v_products,updated_at=now() where key='labelProducts';

  select * into v_user from public.erp_users where id=v_user_id;
  select * into v_role from public.erp_roles where id=v_user.role_id;
  v_log := jsonb_build_object(
    'id','cl_user_'||encode(extensions.gen_random_bytes(8),'hex'),'at',clock_timestamp(),
    'menu','품목관리','action',case when v_action='create' then '저장' else '수정' end,
    'target',v_name,'summary','품목 '||case when v_action='create' then '저장: ' else '수정: ' end||
      coalesce(v_saved->>'productCode','')||' '||v_name,
    'refId',v_id,'authMode','personal_session','userId',v_user.id,'userName',v_user.display_name,
    'userLoginId',v_user.login_id,'roleCode',v_role.code,'roleName',v_role.name
  );
  insert into public.app_data(key,payload,updated_at) values('dataChangeLogs','[]'::jsonb,now()) on conflict(key) do nothing;
  select case when jsonb_typeof(payload)='array' then payload else '[]'::jsonb end into v_logs
  from public.app_data where key='dataChangeLogs' for update;
  update public.app_data set payload=jsonb_build_array(v_log)||v_logs,updated_at=now() where key='dataChangeLogs';
  insert into public.change_logs(entity,action,entity_id,summary,payload)
  values('품목관리',case when v_action='create' then '등록' else '수정' end,v_id,
    coalesce(v_saved->>'productCode','')||' '||v_name,
    jsonb_build_object('before',v_before,'after',v_saved,'userId',v_user.id,'loginId',v_user.login_id,
      'roleCode',v_role.code,'authMode','personal_session'));
  update public.erp_user_sessions set last_used_at=now()
  where token_hash=encode(extensions.digest(coalesce(p_token,''),'sha256'),'hex');
  return jsonb_build_object('ok',true,'products',v_products,'product',v_saved,'logEntry',v_log);
end;
$dbmt$;

create or replace function public.dbmt_erp_delete_label_product(
  p_token text,
  p_product_id text,
  p_business_registration_no text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_user_id uuid := public.dbmt_erp_session_user(p_token);
  v_user public.erp_users%rowtype;
  v_role public.erp_roles%rowtype;
  v_products jsonb;
  v_before jsonb;
  v_logs jsonb;
  v_log jsonb;
  v_id text := btrim(coalesce(p_product_id,''));
  v_business_no text := regexp_replace(coalesce(p_business_registration_no,''),'[^0-9]','','g');
begin
  if v_user_id is null then
    return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.');
  end if;
  if public.dbmt_erp_has_permission(p_token,'label_products','delete') is not true then
    return public.dbmt_erp_permission_denied(v_user_id,'label_products','delete');
  end if;
  if v_id='' then raise exception '삭제할 품목을 선택해주세요.'; end if;
  if length(v_business_no)<>10 or not exists(
    select 1
    from public.business_sites s
    join public.companies c on c.id=s.company_id
    where c.active and s.active
      and s.site_type<>'external_warehouse' and s.ownership_type<>'third_party'
      and s.business_registration_no=v_business_no
  ) then
    raise exception '사업자등록번호가 일치하지 않아 삭제하지 않았습니다.';
  end if;

  insert into public.app_data(key,payload,updated_at)
  values('labelProducts','[]'::jsonb,now()) on conflict(key) do nothing;
  select case when jsonb_typeof(payload)='array' then payload else '[]'::jsonb end
  into v_products from public.app_data where key='labelProducts' for update;
  v_products := public.dbmt_ensure_product_codes(v_products);
  select e into v_before from jsonb_array_elements(v_products) e where e->>'id'=v_id limit 1;
  if v_before is null then raise exception '삭제할 품목을 찾을 수 없습니다.'; end if;
  select coalesce(jsonb_agg(e order by ord),'[]'::jsonb) into v_products
  from jsonb_array_elements(v_products) with ordinality q(e,ord)
  where e->>'id'<>v_id;
  update public.app_data set payload=v_products,updated_at=now() where key='labelProducts';
  update public.product_code_registry set deleted_at=coalesce(deleted_at,now()) where product_id=v_id;

  select * into v_user from public.erp_users where id=v_user_id;
  select * into v_role from public.erp_roles where id=v_user.role_id;
  v_log := jsonb_build_object(
    'id','cl_user_'||encode(extensions.gen_random_bytes(8),'hex'),'at',clock_timestamp(),
    'menu','품목관리','action','삭제','target',coalesce(v_before->>'name',''),
    'summary','품목 삭제: '||coalesce(v_before->>'productCode','')||' '||coalesce(v_before->>'name',''),
    'refId',v_id,'authMode','personal_session','userId',v_user.id,'userName',v_user.display_name,
    'userLoginId',v_user.login_id,'roleCode',v_role.code,'roleName',v_role.name
  );
  insert into public.app_data(key,payload,updated_at) values('dataChangeLogs','[]'::jsonb,now()) on conflict(key) do nothing;
  select case when jsonb_typeof(payload)='array' then payload else '[]'::jsonb end into v_logs
  from public.app_data where key='dataChangeLogs' for update;
  update public.app_data set payload=jsonb_build_array(v_log)||v_logs,updated_at=now() where key='dataChangeLogs';
  insert into public.change_logs(entity,action,entity_id,summary,payload)
  values('품목관리','삭제',v_id,coalesce(v_before->>'productCode','')||' '||coalesce(v_before->>'name',''),
    jsonb_build_object('before',v_before,'after',null,'userId',v_user.id,'loginId',v_user.login_id,
      'roleCode',v_role.code,'authMode','personal_session'));
  update public.erp_user_sessions set last_used_at=now()
  where token_hash=encode(extensions.digest(coalesce(p_token,''),'sha256'),'hex');
  return jsonb_build_object('ok',true,'products',v_products,'deletedProduct',v_before,'logEntry',v_log);
end;
$dbmt$;

-- Product master writes now require a personal session and the dedicated RPC.
create or replace function public.dbmt_import_app_data(p_password text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path=public,extensions
as $dbmt$
declare
  row_count integer:=0;
  payload_keys text[]:=array[]::text[];
begin
  if public.dbmt_check_password(p_password) is not true then raise exception 'invalid app password'; end if;
  if coalesce(p_payload,'{}'::jsonb) ? 'scheduleEvents' then raise exception '일정 변경은 개인 사용자 로그인이 필요합니다.'; end if;
  if coalesce(p_payload,'{}'::jsonb) ? 'traderInfoMap' then raise exception '거래처 변경은 개인 사용자 로그인이 필요합니다.'; end if;
  if coalesce(p_payload,'{}'::jsonb) ? 'labelProducts' then raise exception '품목 변경은 개인 사용자 로그인이 필요합니다.'; end if;
  select count(*),coalesce(array_agg(e.key order by e.key),array[]::text[])
  into row_count,payload_keys
  from jsonb_each(coalesce(p_payload,'{}'::jsonb)) e(key,value);
  if row_count>8 then raise exception 'bulk app data save blocked: refresh the ERP page before saving'; end if;
  insert into public.app_data(key,payload,updated_at)
  select key,value,now() from jsonb_each(coalesce(p_payload,'{}'::jsonb))
  on conflict(key) do update set payload=excluded.payload,updated_at=now();
  insert into public.change_logs(entity,action,summary,payload)
  values('migration','import_app_data','App data imported',jsonb_build_object('count',row_count,'keys',to_jsonb(payload_keys)));
  return jsonb_build_object('ok',true,'appData',row_count,'keys',to_jsonb(payload_keys));
end;
$dbmt$;

revoke all on function public.dbmt_product_species_prefix(text) from public, anon, authenticated;
revoke all on function public.dbmt_ensure_product_codes(jsonb) from public, anon, authenticated;
revoke all on function public.dbmt_erp_save_label_product(text,jsonb) from public;
revoke all on function public.dbmt_erp_delete_label_product(text,text,text) from public;
grant execute on function public.dbmt_erp_save_label_product(text,jsonb) to anon, authenticated;
grant execute on function public.dbmt_erp_delete_label_product(text,text,text) to anon, authenticated;
grant execute on function public.dbmt_import_app_data(text,jsonb) to anon, authenticated;

notify pgrst,'reload schema';
