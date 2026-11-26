-- Return the unreserved portion of each selected PDA raw receipt for manual shipping.
create function public.dbmt_erp_get_bulk_outbound_raw_stock(p_token text, p_sources jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid := public.dbmt_erp_session_user(p_token);
begin
  if v_user is null then
    return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.');
  end if;
  if public.dbmt_erp_has_permission(p_token,'transactions','view') is not true
    or public.dbmt_erp_has_permission(p_token,'transactions','create') is not true then
    return jsonb_build_object('ok',false,'code','permission_denied','message','거래내역 조회·등록 권한이 필요합니다.');
  end if;
  if jsonb_typeof(p_sources) is distinct from 'array' then
    raise exception '출고 재고원본은 올바른 목록으로 조회해주세요.';
  end if;
  if jsonb_array_length(p_sources)>500 or exists (
    select 1 from jsonb_array_elements(p_sources) s
    where jsonb_typeof(s) is distinct from 'object'
      or jsonb_typeof(s->'stockRowId') is distinct from 'string'
      or length(btrim(s->>'stockRowId')) not between 1 and 120
      or (s ? 'stockLocation' and jsonb_typeof(s->'stockLocation') not in ('string','null'))
  ) then
    raise exception '출고 재고원본은 한 번에 500건까지 올바른 목록으로 조회해주세요.';
  end if;

  return (
    with requested as (
      select distinct btrim(s->>'stockRowId') source_id,
        coalesce(nullif(btrim(s->>'stockLocation'),''),'가공장') location
      from jsonb_array_elements(p_sources) s
    )
    select jsonb_build_object('ok',true,'rows',coalesce(jsonb_agg(jsonb_build_object(
      'stockRowId',r.source_id,'stockLocation',r.location,
      'availableWeight',greatest(0,pda_private.balance(r.source_id,r.location)-held.weight),
      'reservedBoxes',held.boxes
    ) order by r.source_id,r.location),'[]'::jsonb))
    from requested r
    cross join lateral (
      select coalesce(sum(p.weight),0) weight,count(*) boxes
      from pda_private.raw_packages p
      where p.source_id=r.source_id and p.location=r.location and p.state='in_stock'
    ) held
    where exists (
      select 1 from public.transactions t
      where t.deleted_at is null and t.type='입고' and t.raw->>'stockRowId'=r.source_id
        and coalesce(t.raw->>'stockRowId','')<>''
        and t.raw ? '_pdaRawRequestId' and t.raw->>'_pdaAction'='receive'
    ) and (held.boxes>0 or exists (
      select 1 from public.transactions t
      where t.deleted_at is null and t.raw->>'stockRowId'=r.source_id and coalesce(t.raw->>'stockRowId','')<>'' and (
        coalesce(nullif(t.stock_location,''),'가공장')=r.location
        or (t.type='재고이동' and r.location in (coalesce(nullif(t.from_location,''),'가공장'),
          coalesce(nullif(t.to_location,''),'가공장')))
      )
    ))
  );
end;
$$;

revoke all on function public.dbmt_erp_get_bulk_outbound_raw_stock(text,jsonb) from public,anon,authenticated;
grant execute on function public.dbmt_erp_get_bulk_outbound_raw_stock(text,jsonb) to anon,authenticated;
notify pgrst,'reload schema';
