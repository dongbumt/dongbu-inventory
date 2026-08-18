-- Split the 3xxxxx product family into visible poultry, lamb and duck choices.
-- Product code issuance remains unchanged: every non-beef/non-pork item uses 3xxxxx.

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
  if v_meat_type not in ('소고기','돼지고기','가금류','양고기','오리고기','기타 축종') then raise exception '육종을 확인해주세요.'; end if;
  if v_storage not in ('냉동','냉장') then raise exception '보관방법을 확인해주세요.'; end if;
  if v_shelf_days not between 1 and 3650 then raise exception '소비기한은 1~3650일로 입력해주세요.'; end if;
  if v_meat_type in ('소고기','돼지고기') and coalesce(v_part_code,'')='' then
    raise exception '소고기와 돼지고기는 국가부위코드를 선택해주세요.';
  end if;
  if v_part_code is not null and v_part_code !~ '^[A-Z0-9]{2,20}$' then
    raise exception '국가부위코드 형식을 확인해주세요.';
  end if;
  if v_meat_type not in ('소고기','돼지고기') then
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

revoke all on function public.dbmt_erp_save_label_product(text,jsonb) from public;
grant execute on function public.dbmt_erp_save_label_product(text,jsonb) to anon, authenticated;

notify pgrst,'reload schema';
