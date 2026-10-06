-- Execute as one transaction against a migrated project; all QA records roll back.
begin;
do $qa$
declare
  v_role uuid;
  v_user uuid;
  v_token text:='qa_product_specs_' || extensions.gen_random_uuid()::text;
  v_suffix text:=substr(replace(extensions.gen_random_uuid()::text,'-',''),1,8);
  v_result jsonb;
  v_id uuid;
  v_revision integer;
begin
  insert into public.erp_roles(code,name)
  values('qa_ps_' || v_suffix,'QA 제품스펙') returning id into v_role;
  insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete)
  values(v_role,'product_specs',true,true,true,true);
  insert into public.erp_users(login_id,display_name,password_hash,role_id)
  values('qa_ps_' || v_suffix,'QA 제품스펙','qa-no-login',v_role) returning id into v_user;
  insert into public.erp_user_sessions(token_hash,user_id,expires_at)
  values(encode(extensions.digest(v_token,'sha256'),'hex'),v_user,now()+interval '10 minutes');

  v_result:=public.dbmt_erp_save_product_spec(v_token,null,jsonb_build_object(
    'trader','QA 거래처','material','QA 원재료','origin','국내산',
    'cutting_spec','3mm','inner_packaging_spec','1KG 진공',
    'outer_packaging_spec','10KG 박스','note','검증용',
    'price_kg',12000,'price_box',120000),null);
  if v_result->>'ok' is distinct from 'true' then raise exception 'Create failed: %',v_result; end if;
  v_id:=(v_result->'spec'->>'id')::uuid;
  v_revision:=(v_result->'spec'->>'revision')::integer;
  if (v_result->'spec'->>'inner_packaging_spec') is distinct from '1KG 진공'
     or (v_result->'spec'->>'outer_packaging_spec') is distinct from '10KG 박스' then
    raise exception 'Packaging fields were not saved independently: %',v_result;
  end if;

  v_result:=public.dbmt_erp_get_product_specs(v_token);
  if v_result->>'ok' is distinct from 'true'
     or not exists(select 1 from jsonb_array_elements(v_result->'specs') as s
       where s->>'id'=v_id::text and s->>'inner_packaging_spec'='1KG 진공'
         and s->>'outer_packaging_spec'='10KG 박스') then
    raise exception 'Get did not return both packaging fields: %',v_result;
  end if;

  -- A tab still using the former form may edit inner packaging; outer packaging must survive.
  v_result:=public.dbmt_erp_save_product_spec(v_token,v_id,jsonb_build_object(
    'trader','QA 거래처','material','QA 원재료','packaging_spec','1KG 실링'),v_revision);
  if v_result->>'ok' is distinct from 'true'
     or (v_result->'spec'->>'inner_packaging_spec') is distinct from '1KG 실링'
     or (v_result->'spec'->>'outer_packaging_spec') is distinct from '10KG 박스'
     or (v_result->'spec'->>'packaging_spec') is distinct from '1KG 실링' then
    raise exception 'Legacy edit lost a packaging field: %',v_result;
  end if;

  v_revision:=(v_result->'spec'->>'revision')::integer;
  v_result:=public.dbmt_erp_save_product_spec(v_token,v_id,jsonb_build_object(
    'trader','QA 거래처','material','QA 원재료','inner_packaging_spec','2KG 진공',
    'outer_packaging_spec',''),v_revision);
  if v_result->>'ok' is distinct from 'true'
     or (v_result->'spec'->>'inner_packaging_spec') is distinct from '2KG 진공'
     or (v_result->'spec'->>'outer_packaging_spec') is distinct from '' then
    raise exception 'Explicit outer packaging clear failed: %',v_result;
  end if;
end;
$qa$;
rollback;
