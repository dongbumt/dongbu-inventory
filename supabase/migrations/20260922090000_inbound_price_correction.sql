-- Allow purchase-cost corrections on linked inbound stock.
-- Permanent source IDs keep quantity allocation intact; saved sales and
-- production cost snapshots are not rewritten by a purchase-price correction.
do $dbmt$ begin
  if to_regprocedure('public.dbmt_stock_row_write_lock()') is null then
    raise exception '재고원본 추적 설치 전에 생산품 행별 재고(39)를 먼저 설치해주세요.';
  end if;
end $dbmt$;

create or replace function public.dbmt_stock_row_write_lock()
returns trigger language plpgsql security definer set search_path=public,extensions as $dbmt$
declare
  v_source_id text;
  v_previous_source_id text;
  v_has_links boolean;
  v_result_stock numeric;
begin
  if (tg_op<>'DELETE' and coalesce(new.raw->>'stockRowId','')<>'')
    or (tg_op<>'INSERT' and coalesce(old.raw->>'stockRowId','')<>'') then
    -- Source creation, source selection and production completion use one lock.
    perform pg_advisory_xact_lock(36100910);
  end if;

  if tg_op='DELETE' then return old; end if;

  v_source_id:=btrim(coalesce(new.raw->>'stockRowId',''));
  if new.deleted_at is null and v_source_id<>'' then
    if length(v_source_id)>120 then
      raise exception '재고원본 식별값을 확인해주세요.';
    end if;
    if new.type='생산입고' then
      if not exists(select 1 from public.production_entries p
        cross join lateral jsonb_array_elements(coalesce(p.raw->'outputs','[]'::jsonb)) e
        where p.deleted_at is null and p.id=coalesce(new.prod_id,new.raw->>'_prodId')
          and e->>'stockRowId'=v_source_id) then
        raise exception '생산일보의 재고원본을 찾을 수 없습니다.';
      end if;
    elsif new.type='입고' then
      -- A new inbound row is a source. Do not reuse its identifier for another
      -- inbound/production source even when product, LOT and cost are identical.
      if exists(select 1 from public.transactions t where t.deleted_at is null
        and t.id<>new.id and t.type in ('입고','생산입고')
        and t.raw->>'stockRowId'=v_source_id) then
        raise exception '이미 다른 입고 또는 생산품에 사용 중인 재고원본 식별값입니다.';
      end if;
    elsif not exists(select 1 from public.transactions t where t.deleted_at is null
      and t.type in ('입고','생산입고') and t.raw->>'stockRowId'=v_source_id) then
      raise exception '선택한 재고원본을 찾을 수 없습니다. 새로고침 후 다시 선택해주세요.';
    end if;
  end if;

  -- A tracked ordinary inbound row may be edited until it is used. Once a
  -- later row references it, its identity may not be silently changed or
  -- removed, and its quantity cannot be reduced below linked movements.
  if tg_op='UPDATE' and old.deleted_at is null and old.type='입고' then
    v_previous_source_id:=btrim(coalesce(old.raw->>'stockRowId',''));
    if v_previous_source_id<>'' then
      select exists(select 1 from public.transactions t where t.deleted_at is null
        and t.id<>old.id and t.raw->>'stockRowId'=v_previous_source_id) into v_has_links;
      if v_has_links then
        if new.deleted_at is not null then
          raise exception '출고·사용·이동에 연결된 입고 재고원본은 삭제할 수 없습니다.';
        end if;
        if new.type<>'입고' or btrim(coalesce(new.raw->>'stockRowId',''))<>v_previous_source_id then
          raise exception '출고·사용·이동에 연결된 입고 재고원본은 변경하거나 해제할 수 없습니다.';
        end if;
        if new.product is distinct from old.product or new.lot is distinct from old.lot
          or new.origin is distinct from old.origin or new.packunit is distinct from old.packunit
          or coalesce(new.stock_location,'가공장') is distinct from coalesce(old.stock_location,'가공장') then
          raise exception '연결된 입고 재고원본의 품목·LOT·원산지·규격·보관장소는 변경할 수 없습니다.';
        end if;
        select coalesce(new.weight,0) + coalesce(sum(
          case when t.type in ('출고','사용') then -t.weight
               when t.type='재고조정' then t.weight
               else 0 end),0)
          into v_result_stock
        from public.transactions t
        where t.deleted_at is null and t.id<>old.id and t.raw->>'stockRowId'=v_previous_source_id;
        if coalesce(v_result_stock,0)<-0.005 then
          raise exception '이미 출고·사용·조정한 중량보다 입고중량을 줄일 수 없습니다.';
        end if;
      end if;
    end if;
  end if;
  return new;
end;
$dbmt$;

notify pgrst,'reload schema';
