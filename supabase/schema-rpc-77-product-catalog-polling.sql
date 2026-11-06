-- Same private-session boundary as the ERP bootstrap, without loading other data.
-- Unchanged polls read only the indexed catalog row's modification timestamp.
create or replace function public.dbmt_erp_get_label_products(
  p_token text, p_revision text default null
)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare
  v_revision text;
  v_products jsonb;
begin
  perform public.dbmt_erp_authorize_legacy(p_token,null,'view');
  select a.updated_at::text,
    case when p_revision is distinct from a.updated_at::text then a.payload end
  into v_revision,v_products
  from public.app_data a where a.key='labelProducts';
  v_revision:=coalesce(v_revision,'empty');
  if p_revision=v_revision then
    return jsonb_build_object('ok',true,'unchanged',true,'revision',v_revision);
  end if;
  v_products:=coalesce(v_products,'[]'::jsonb);
  if jsonb_typeof(v_products)<>'array' then raise exception '품목 목록 형식을 확인해주세요.'; end if;
  return jsonb_build_object('ok',true,'revision',v_revision,'products',v_products);
end;
$function$;
revoke all on function public.dbmt_erp_get_label_products(text,text) from public;
grant execute on function public.dbmt_erp_get_label_products(text,text) to anon,authenticated;
notify pgrst,'reload schema';
