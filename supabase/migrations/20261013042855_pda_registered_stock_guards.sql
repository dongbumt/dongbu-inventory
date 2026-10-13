-- Preserve physical-package allocations when older ERP screens write the same source.
-- Unregistered stock retains its existing behavior. No business rows are changed.
create index if not exists idx_pda_packages_original_source on public.pda_packages(original_stock_row_id);
create index if not exists idx_pda_packages_any_source on public.pda_packages(source_stock_row_id);

create or replace function pda_private.movement_delta(p_row jsonb,p_location text)
returns numeric language sql immutable security invoker set search_path='' as $$
  select case when p_row->>'deleted_at' is not null then 0 else case
    when p_row->>'type' in ('입고','생산입고','재고조정') and coalesce(nullif(p_row->>'stock_location',''),'가공장')=p_location then public.dbmt_safe_numeric(p_row->>'weight')
    when p_row->>'type' in ('출고','사용') and coalesce(nullif(p_row->>'stock_location',''),'가공장')=p_location then -public.dbmt_safe_numeric(p_row->>'weight')
    else 0 end
    + case when p_row->>'type'='재고이동' then
      case when coalesce(nullif(p_row->>'from_location',''),'가공장')=p_location then -public.dbmt_safe_numeric(p_row->>'weight') else 0 end
      + case when coalesce(nullif(p_row->>'to_location',''),'가공장')=p_location then public.dbmt_safe_numeric(p_row->>'weight') else 0 end
    else 0 end end;
$$;

create or replace function pda_private.protect_registered_stock()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_old jsonb:='{}'::jsonb; v_new jsonb:='{}'::jsonb; v_source text; v_location text;
  v_balance numeric; v_held numeric; v_exempt text:='';
begin
  if tg_op<>'INSERT' then v_old:=to_jsonb(old); end if;
  if tg_op<>'DELETE' then v_new:=to_jsonb(new); end if;
  -- INSERT ... ON CONFLICT receives its actual validation in the UPDATE trigger.
  if tg_op='INSERT' and exists(select 1 from public.transactions where id=new.id) then return new; end if;
  if v_new#>>'{raw,_pdaRequestId}' is not null then
    v_exempt:=coalesce(v_new#>>'{raw,_pdaLabelId}','');
  end if;
  for v_source in select distinct s from unnest(array[v_old#>>'{raw,stockRowId}',v_new#>>'{raw,stockRowId}']) s where coalesce(s,'')<>'' loop
    -- Acquire before inspecting registration: a PDA may have registered a box while this write waited.
    perform pg_advisory_xact_lock(36100910);
    if not exists(select 1 from public.pda_packages where source_stock_row_id=v_source or original_stock_row_id=v_source) then continue; end if;
    for v_location in select distinct coalesce(nullif(s,''),'가공장') from unnest(array[
      v_old->>'stock_location',v_old->>'from_location',v_old->>'to_location',
      v_new->>'stock_location',v_new->>'from_location',v_new->>'to_location']) s loop
      v_balance:=pda_private.balance(v_source,v_location)
        -case when v_old#>>'{raw,stockRowId}'=v_source then pda_private.movement_delta(v_old,v_location) else 0 end
        +case when v_new#>>'{raw,stockRowId}'=v_source then pda_private.movement_delta(v_new,v_location) else 0 end;
      select coalesce(sum(weight),0) into v_held from public.pda_packages
        where source_stock_row_id=v_source and state='in_stock' and location=v_location and label_id<>v_exempt;
      if v_balance+0.005<v_held then
        raise exception 'PDA 추적 재고가 부족하거나 등록된 박스 몫을 차감하는 요청입니다. 해당 박스는 PDA에서 출고해주세요. 지점: %',v_location;
      end if;
    end loop;
  end loop;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists trg_pda_transaction_stock_guard on public.transactions;
create trigger trg_pda_transaction_stock_guard before insert or update or delete on public.transactions
  for each row execute function pda_private.protect_registered_stock();
revoke all on function pda_private.movement_delta(jsonb,text),pda_private.protect_registered_stock() from public,anon,authenticated;
notify pgrst,'reload schema';
