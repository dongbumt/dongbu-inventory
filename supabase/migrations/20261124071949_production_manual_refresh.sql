-- Refresh production entries for the list's own view permission.
create or replace function public.dbmt_erp_get_inventory_snapshot(p_token text,p_menu text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if p_menu is null or p_menu not in ('transactions','stock','production') then
    raise exception '거래내역, 재고현황 또는 생산일보 메뉴를 선택해주세요.';
  end if;
  perform public.dbmt_erp_authorize_legacy(p_token,p_menu,'view');
  -- Read both ledgers in one statement when the role can also read stock or transactions.
  return (select jsonb_build_object('ok',true,
    'transactions',case when p_menu<>'production'
      or public.dbmt_erp_has_permission(p_token,'transactions','view') is true
      or public.dbmt_erp_has_permission(p_token,'stock','view') is true then
        coalesce((select jsonb_agg(t.raw||jsonb_build_object('id',t.id) order by t.date nulls last,t.id)
          from public.transactions t where t.deleted_at is null),'[]'::jsonb)
      else null end,
    'prod',case when p_menu='production' or public.dbmt_erp_has_permission(p_token,'production','view') is true then
      coalesce((select jsonb_agg(p.raw||jsonb_build_object('id',p.id) order by p.work_date nulls last,p.id)
        from public.production_entries p where p.deleted_at is null),'[]'::jsonb) else null end,
    'loadedAt',clock_timestamp()));
end;
$$;
notify pgrst,'reload schema';
