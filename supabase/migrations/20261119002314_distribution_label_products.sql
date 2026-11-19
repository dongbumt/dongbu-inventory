-- Independent label-only catalog. Never enters labelProducts or stock/work-order masters.
insert into public.erp_permission_catalog(menu_code,menu_name,sort_order)
values('distribution_products','동부축산유통 품목관리',31) on conflict(menu_code) do nothing;
insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete)
select r.id,'distribution_products',true,true,true,true from public.erp_roles r
where r.system_role or exists(select 1 from public.erp_role_permissions p where p.role_id=r.id and p.menu_code='access_control' and p.can_admin)
on conflict(role_id,menu_code) do nothing;

create schema erp_distribution_private;
revoke all on schema erp_distribution_private from public,anon,authenticated;
create table erp_distribution_private.products(
  id uuid primary key default gen_random_uuid(),
  name text not null check(length(name) between 1 and 200),
  itemno text not null default '' check(length(itemno)<=80),
  origin text not null default '' check(length(origin)<=100),
  brand text not null default '' check(length(brand)<=200),
  grade text not null default '' check(length(grade)<=100),
  packunit text not null default '' check(length(packunit)<=100),
  meattype text not null default '돼지고기' check(meattype in ('소고기','돼지고기','양고기','닭고기','오리고기','기타')),
  ingredient_details text not null default '' check(length(ingredient_details)<=1000),
  storage text not null default '냉동' check(storage in ('냉동','냉장')),
  shelfdays integer not null default 365 check(shelfdays between 1 and 3650),
  revision integer not null default 1,
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz
);
alter table erp_distribution_private.products enable row level security;
create policy no_direct_client_access on erp_distribution_private.products for all to anon,authenticated using(false) with check(false);
revoke all on erp_distribution_private.products from public,anon,authenticated;
create trigger dbmt_collect_write_session after insert or update or delete on erp_distribution_private.products
  for each row execute function erp_session_private.collect_write_session();
create constraint trigger dbmt_commit_write_sessions after insert or update or delete on erp_distribution_private.products
  deferrable initially deferred for each row execute function erp_session_private.commit_write_sessions();

create function erp_distribution_private.product_json(p erp_distribution_private.products)
returns jsonb language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('id',p.id,'name',p.name,'itemno',p.itemno,'kind','제품','origin',p.origin,
    'brand',p.brand,'grade',p.grade,'packunit',p.packunit,'meattype',p.meattype,'ingredientDetails',p.ingredient_details,
    'storage',p.storage,'shelfdays',p.shelfdays,'revision',p.revision,'updatedAt',p.updated_at,'isActive',p.deleted_at is null);
$$;

create function erp_distribution_private.list_products(p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=public.dbmt_erp_session_user(p_token);result jsonb;
begin
  if actor is null then return jsonb_build_object('ok',false,'message','개인 사용자 로그인이 만료되었습니다.');end if;
  if public.dbmt_erp_has_permission(p_token,'distribution_products','view') is not true
    and public.dbmt_erp_has_permission(p_token,'label','view') is not true then
    return public.dbmt_erp_permission_denied(actor,'distribution_products','view');end if;
  select coalesce(jsonb_agg(erp_distribution_private.product_json(p) order by p.name,p.brand,p.id),'[]'::jsonb)
    into result from erp_distribution_private.products p where p.deleted_at is null;
  return jsonb_build_object('ok',true,'products',result);
end;
$$;

create function erp_distribution_private.save_product(p_token text,p_id uuid,p_record jsonb,p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=public.dbmt_erp_session_user(p_token);action text:=case when p_id is null then 'create' else 'update' end;
  old_row erp_distribution_private.products;new_row erp_distribution_private.products;
  days numeric;report_key text;
begin
  if actor is null then return jsonb_build_object('ok',false,'message','개인 사용자 로그인이 만료되었습니다.');end if;
  if public.dbmt_erp_has_permission(p_token,'distribution_products','view') is not true then
    return public.dbmt_erp_permission_denied(actor,'distribution_products','view');end if;
  if public.dbmt_erp_has_permission(p_token,'distribution_products',action) is not true then
    return public.dbmt_erp_permission_denied(actor,'distribution_products',action);end if;
  if p_record is null or jsonb_typeof(p_record)<>'object' then raise exception '품목 입력 형식을 확인해주세요.';end if;
  if p_id is not null then
    select * into old_row from erp_distribution_private.products where id=p_id and deleted_at is null for update;
    if not found then raise exception '수정할 품목이 없습니다. 목록을 새로고침해주세요.';end if;
    if p_revision is distinct from old_row.revision then raise exception '다른 사용자가 이 품목을 변경했습니다. 목록을 새로고침 후 다시 수정해주세요.';end if;
  elsif p_revision is not null then raise exception '신규 품목에는 수정번호를 지정할 수 없습니다.';end if;
  if jsonb_typeof(p_record->'shelfdays') is distinct from 'number' then raise exception '소비기한 일수는 1~3650 사이 정수로 입력해주세요.';end if;
  days:=(p_record->>'shelfdays')::numeric;
  if days<1 or days>3650 or days<>trunc(days) then raise exception '소비기한 일수는 1~3650 사이 정수로 입력해주세요.';end if;
  report_key:=upper(regexp_replace(coalesce(p_record->>'itemno',''),'[[:space:]-]','','g'));
  if report_key<>'' and exists(select 1 from public.app_data a cross join lateral jsonb_array_elements(a.payload) p
    where a.key='labelProducts' and upper(regexp_replace(coalesce(p->>'itemno',''),'[[:space:]-]','','g'))=report_key) then
    raise exception '동부엠티에 등록된 품목보고번호는 사용할 수 없습니다. 동부축산유통 번호를 입력해주세요.';
  end if;
  new_row.id:=coalesce(p_id,gen_random_uuid());new_row.name:=btrim(coalesce(p_record->>'name',''));
  new_row.itemno:=btrim(coalesce(p_record->>'itemno',''));new_row.origin:=btrim(coalesce(p_record->>'origin',''));
  new_row.brand:=btrim(coalesce(p_record->>'brand',''));new_row.grade:=btrim(coalesce(p_record->>'grade',''));
  new_row.packunit:=btrim(coalesce(p_record->>'packunit',''));new_row.meattype:=btrim(coalesce(p_record->>'meattype',''));
  new_row.ingredient_details:=btrim(coalesce(p_record->>'ingredientDetails',''));
  new_row.storage:=btrim(coalesce(p_record->>'storage',''));new_row.shelfdays:=days::integer;
  new_row.revision:=coalesce(old_row.revision,0)+1;new_row.updated_at:=clock_timestamp();
  if new_row.name='' then raise exception '제품명을 입력해주세요.';end if;
  if p_id is null then
    insert into erp_distribution_private.products select new_row.* returning * into new_row;
  else
    update erp_distribution_private.products set name=new_row.name,itemno=new_row.itemno,origin=new_row.origin,brand=new_row.brand,
      grade=new_row.grade,packunit=new_row.packunit,meattype=new_row.meattype,ingredient_details=new_row.ingredient_details,
      storage=new_row.storage,shelfdays=new_row.shelfdays,revision=new_row.revision,updated_at=new_row.updated_at
      where id=p_id returning * into new_row;
  end if;
  insert into public.change_logs(entity,action,entity_id,summary,payload)
    values('동부축산유통 품목',case when p_id is null then '등록' else '수정' end,new_row.id::text,new_row.name,
      jsonb_build_object('actor',actor,'before',case when p_id is null then null else erp_distribution_private.product_json(old_row) end,
        'after',erp_distribution_private.product_json(new_row)));
  return jsonb_build_object('ok',true,'product',erp_distribution_private.product_json(new_row));
end;
$$;

create function erp_distribution_private.delete_product(p_token text,p_id uuid,p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=public.dbmt_erp_session_user(p_token);old_row erp_distribution_private.products;
begin
  if actor is null then return jsonb_build_object('ok',false,'message','개인 사용자 로그인이 만료되었습니다.');end if;
  if public.dbmt_erp_has_permission(p_token,'distribution_products','view') is not true then return public.dbmt_erp_permission_denied(actor,'distribution_products','view');end if;
  if public.dbmt_erp_has_permission(p_token,'distribution_products','delete') is not true then return public.dbmt_erp_permission_denied(actor,'distribution_products','delete');end if;
  select * into old_row from erp_distribution_private.products where id=p_id and deleted_at is null for update;
  if not found then raise exception '삭제할 품목이 없습니다. 목록을 새로고침해주세요.';end if;
  if p_revision is distinct from old_row.revision then raise exception '다른 사용자가 이 품목을 변경했습니다. 목록을 새로고침해주세요.';end if;
  update erp_distribution_private.products set deleted_at=clock_timestamp(),updated_at=clock_timestamp(),revision=revision+1 where id=p_id;
  insert into public.change_logs(entity,action,entity_id,summary,payload)
    values('동부축산유통 품목','삭제',p_id::text,old_row.name,jsonb_build_object('actor',actor,'before',erp_distribution_private.product_json(old_row)));
  return jsonb_build_object('ok',true,'id',p_id);
end;
$$;

-- Definer code stays in an unexposed schema. Public API wrappers only invoke it.
revoke all on all functions in schema erp_distribution_private from public,anon,authenticated;
grant usage on schema erp_distribution_private to anon,authenticated;
grant execute on function erp_distribution_private.list_products(text),
  erp_distribution_private.save_product(text,uuid,jsonb,integer),erp_distribution_private.delete_product(text,uuid,integer) to anon,authenticated;
create function public.dbmt_erp_get_distribution_products(p_token text)
returns jsonb language sql security invoker set search_path='' as $$select erp_distribution_private.list_products(p_token)$$;
create function public.dbmt_erp_save_distribution_product(p_token text,p_id uuid,p_record jsonb,p_revision integer default null)
returns jsonb language sql security invoker set search_path='' as $$select erp_distribution_private.save_product(p_token,p_id,p_record,p_revision)$$;
create function public.dbmt_erp_delete_distribution_product(p_token text,p_id uuid,p_revision integer)
returns jsonb language sql security invoker set search_path='' as $$select erp_distribution_private.delete_product(p_token,p_id,p_revision)$$;
revoke all on function public.dbmt_erp_get_distribution_products(text),public.dbmt_erp_save_distribution_product(text,uuid,jsonb,integer),
  public.dbmt_erp_delete_distribution_product(text,uuid,integer) from public,anon,authenticated;
grant execute on function public.dbmt_erp_get_distribution_products(text),public.dbmt_erp_save_distribution_product(text,uuid,jsonb,integer),
  public.dbmt_erp_delete_distribution_product(text,uuid,integer) to anon,authenticated;
notify pgrst,'reload schema';
