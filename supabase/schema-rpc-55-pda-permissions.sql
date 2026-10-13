-- PDA permissions are independent of office transaction/stock menu permissions.
insert into public.erp_permission_catalog(menu_code,menu_name,sort_order)
values('pda','PDA 입출고',75)
on conflict(menu_code) do nothing;

-- Lock roles like the role editor; old forms must refresh after the new row is seeded.
do $$
begin
  perform id from public.erp_roles order by id for update;
end;
$$;
with seeded as (
  insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create)
  select r.id,'pda',
    r.system_role or (coalesce(t.can_view,false) and coalesce(s.can_view,false)),
    r.system_role or (coalesce(t.can_view,false) and coalesce(s.can_view,false) and coalesce(t.can_create,false))
  from public.erp_roles r
  left join public.erp_role_permissions t on t.role_id=r.id and t.menu_code='transactions'
  left join public.erp_role_permissions s on s.role_id=r.id and s.menu_code='stock'
  on conflict(role_id,menu_code) do nothing
  returning role_id
)
update public.erp_roles r set revision=r.revision+1,updated_at=now()
from seeded where r.id=seeded.role_id;

create or replace function pda_private.authorize(p_token text,p_write boolean default false)
returns uuid language plpgsql security invoker set search_path='' as $$
declare v_user uuid:=public.dbmt_erp_session_user(p_token);
begin
  if v_user is null then raise exception using errcode='28000',message='ERP 사용자 로그인이 만료되었습니다. 다시 로그인해주세요.'; end if;
  if public.dbmt_erp_has_permission(p_token,'pda','view') is not true
    or (p_write and public.dbmt_erp_has_permission(p_token,'pda','create') is not true) then
    raise exception using errcode='42501',message='PDA 입출고 조회·등록 권한을 확인해주세요.';
  end if;
  return v_user;
end;
$$;

create or replace function public.dbmt_pda_bootstrap(p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform pda_private.authorize(p_token);
  return jsonb_build_object('ok',true,'locations',pda_private.locations(),
    'canSave',public.dbmt_erp_has_permission(p_token,'pda','create'),
    'partners',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name)
      from public.business_partners where active and trade_type in ('매출','매입/매출')),'[]'::jsonb));
end;
$$;

revoke all on function pda_private.authorize(text,boolean) from public,anon,authenticated;
revoke all on function public.dbmt_pda_bootstrap(text) from public,anon,authenticated;
grant execute on function public.dbmt_pda_bootstrap(text) to anon,authenticated;
notify pgrst,'reload schema';
