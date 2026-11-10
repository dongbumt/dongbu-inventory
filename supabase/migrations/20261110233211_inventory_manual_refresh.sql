-- Read only the ledgers needed by the transaction/stock refresh buttons.
create function public.dbmt_erp_get_inventory_snapshot(p_token text,p_menu text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if p_menu is null or p_menu not in ('transactions','stock') then
    raise exception '거래내역 또는 재고현황 메뉴를 선택해주세요.';end if;
  perform public.dbmt_erp_authorize_legacy(p_token,p_menu,'view');
  -- A single statement keeps production entries and their postings consistent.
  return (select jsonb_build_object('ok',true,
    'transactions',coalesce((select jsonb_agg(t.raw||jsonb_build_object('id',t.id) order by t.date nulls last,t.id)
      from public.transactions t where t.deleted_at is null),'[]'::jsonb),
    'prod',case when public.dbmt_erp_has_permission(p_token,'production','view') is true then
      coalesce((select jsonb_agg(p.raw||jsonb_build_object('id',p.id) order by p.work_date nulls last,p.id)
        from public.production_entries p where p.deleted_at is null),'[]'::jsonb) else null end,
    'loadedAt',clock_timestamp()));
end;
$$;
revoke all on function public.dbmt_erp_get_inventory_snapshot(text,text) from public,anon,authenticated;
grant execute on function public.dbmt_erp_get_inventory_snapshot(text,text) to anon,authenticated;
notify pgrst,'reload schema';
