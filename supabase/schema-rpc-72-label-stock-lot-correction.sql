-- Correct a completed label output's LOT without changing its physical labels.
-- All bindings, journal postings and audit records commit in one transaction.
-- Existing downstream/PDA stock guards remain authoritative.
do $$ begin
  if to_regprocedure('public.dbmt_erp_save_production_before_lot_correction(text,jsonb,jsonb,text)') is null then
    alter function public.dbmt_erp_save_production(text,jsonb,jsonb,text) rename to dbmt_erp_save_production_before_lot_correction;
  end if;
end $$;

create or replace function public.dbmt_erp_save_production(p_token text,p_entry jsonb default null,
  p_transaction_rows jsonb default '[]'::jsonb,p_replace_id text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=public.dbmt_erp_session_user(p_token);
  v_id text:=coalesce(nullif(btrim(p_replace_id),''),p_entry->>'id');
  v_old jsonb; v_entry jsonb:=case when jsonb_typeof(p_entry)='object' then p_entry-'_labelLotCorrections' else p_entry end; v_row jsonb; v_next jsonb;
  v_proofs jsonb:=coalesce(p_entry->'_labelLotCorrections','[]'::jsonb); v_proof jsonb;
  v_changes jsonb:='[]'::jsonb; v_assignments jsonb; v_group jsonb;
  v_count integer; v_weight numeric; v_result jsonb;
begin
  if v_user is null then
    return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.');
  end if;
  perform pg_advisory_xact_lock(36100910);
  select raw into v_old from public.production_entries where id=v_id and deleted_at is null for update;
  if v_entry is null or v_entry='null'::jsonb or v_old is null
    or not exists(select 1 from public.label_production_completions where production_id=v_id) then
    return public.dbmt_erp_save_production_before_lot_correction(p_token,v_entry,p_transaction_rows,p_replace_id);
  end if;
  if public.dbmt_erp_has_permission(p_token,'production','update') is not true then
    return public.dbmt_erp_permission_denied(v_user,'production','update');
  end if;
  if jsonb_typeof(v_proofs) is distinct from 'array' or jsonb_typeof(v_entry->'outputs') is distinct from 'array' then
    raise exception '이력번호 수정 정보를 확인해주세요. 생산일보를 다시 불러오세요.';
  end if;
  if jsonb_array_length(v_proofs)>500 or exists(select 1 from jsonb_array_elements(v_proofs) e
    where jsonb_typeof(e) is distinct from 'object' or jsonb_typeof(e->'stockRowId') is distinct from 'string'
      or coalesce(e->>'stockRowId','')='' or jsonb_typeof(e->'fromLot') is distinct from 'string'
      or jsonb_typeof(e->'toLot') is distinct from 'string' or btrim(e->>'toLot')=''
      or length(e->>'toLot')>100 or btrim(e->>'toLot')<>e->>'toLot'
      or e-array['stockRowId','fromLot','toLot']<>'{}'::jsonb)
    or exists(select 1 from jsonb_array_elements(v_proofs) e group by e->>'stockRowId' having count(*)>1) then
    raise exception '이력번호 수정 정보를 확인해주세요.';
  end if;
  v_entry:=public.dbmt_prepare_label_stock_rows(v_entry,v_old);
  -- Validate the submitted original LOT, including a replay after a lost response.
  for v_proof in select e from jsonb_array_elements(v_proofs) e loop
    select count(*),jsonb_agg(o)->0 into v_count,v_row from jsonb_array_elements(v_old->'outputs') o
      where o->>'stockRowId'=v_proof->>'stockRowId';
    if v_count<>1 or coalesce(v_row->>'lot','') not in (v_proof->>'fromLot',v_proof->>'toLot') then
      raise exception '다른 PC에서 이력번호가 변경되었습니다. 생산일보를 다시 불러오세요.';
    end if;
    select count(*),jsonb_agg(o)->0 into v_count,v_next from jsonb_array_elements(v_entry->'outputs') o
      where o->>'stockRowId'=v_proof->>'stockRowId';
    if v_count<>1 or v_next->>'lot' is distinct from v_proof->>'toLot' then
      raise exception '수정할 생산품과 이력번호가 일치하지 않습니다.';
    end if;
  end loop;
  for v_row in select o from jsonb_array_elements(v_old->'outputs') o where coalesce(o->>'stockRowId','')<>'' loop
    select count(*),jsonb_agg(o)->0 into v_count,v_next from jsonb_array_elements(v_entry->'outputs') o
      where o->>'stockRowId'=v_row->>'stockRowId';
    if v_count<>1 or coalesce(v_row->>'lot','')=coalesce(v_next->>'lot','') then continue; end if;
    select e into v_proof from jsonb_array_elements(v_proofs) e where e->>'stockRowId'=v_row->>'stockRowId';
    if v_proof is null or v_proof->>'fromLot' is distinct from coalesce(v_row->>'lot','')
      or v_proof->>'toLot' is distinct from v_next->>'lot' then
      raise exception '라벨 분할 생산품의 이력번호는 최신 화면에서 변경 내용을 확인한 뒤 저장해주세요.';
    end if;
    if (label_stock_private.identity(v_row)-'lot') is distinct from (label_stock_private.identity(v_next)-'lot')
      or public.dbmt_safe_numeric(v_row->>'qty')<>public.dbmt_safe_numeric(v_next->>'qty')
      or v_row->'boxCount' is distinct from v_next->'boxCount' then
      raise exception '이력번호 정정 시 라벨 생산품의 품목·중량·박스수·원산지·규격·생산일·창고는 함께 변경할 수 없습니다.';
    end if;
    v_changes:=v_changes||jsonb_build_array(v_proof);
  end loop;
  if jsonb_array_length(v_changes)>0 then
    -- Validate dependencies BEFORE temporarily rebinding any label identity.
    perform public.dbmt_validate_production_stock_rows(v_entry,v_id);
    if exists(select 1 from public.pda_packages where production_id=v_id) then
      raise exception 'PDA로 처리한 라벨이 연결된 생산일보는 이력번호를 정정할 수 없습니다. 처리 내역을 먼저 확인해주세요.';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('label',label,'stockRowId',stock_row_id,
      'identity',row_identity,'problem',problem)),'[]'::jsonb)
      into v_assignments from label_stock_private.assignments(v_id);
    for v_proof in select e from jsonb_array_elements(v_changes) e loop
      select o into v_row from jsonb_array_elements(v_old->'outputs') o where o->>'stockRowId'=v_proof->>'stockRowId';
      select o into v_next from jsonb_array_elements(v_entry->'outputs') o where o->>'stockRowId'=v_proof->>'stockRowId';
      select coalesce(jsonb_agg(e),'[]'::jsonb),count(*),coalesce(sum(public.dbmt_safe_numeric(e#>>'{label,labelWeight}')),0)
        into v_group,v_count,v_weight from jsonb_array_elements(v_assignments) e where e->>'stockRowId'=v_proof->>'stockRowId';
      if v_count=0 or v_weight<>public.dbmt_safe_numeric(v_row->>'qty')
        or (v_row->>'boxCount' is not null and v_count<>public.dbmt_safe_numeric(v_row->>'boxCount'))
        or exists(select 1 from jsonb_array_elements(v_group) e where e->>'problem' is not null
          or e->'identity' is distinct from label_stock_private.identity(v_row)) then
        raise exception '생산품과 출력 라벨 연결정보가 일치하지 않습니다. 최신 생산일보를 확인해주세요.';
      end if;
      -- Preserve the issued snapshot/code. Only its current inventory identity changes.
      insert into public.label_stock_assignments(production_id,label_id,stock_row_id,label_snapshot,row_identity,weight)
        select v_id,e#>>'{label,id}',v_proof->>'stockRowId',label_stock_private.log_snapshot(e->'label'),
          label_stock_private.identity(v_next),public.dbmt_safe_numeric(e#>>'{label,labelWeight}')
        from jsonb_array_elements(v_group) e
        on conflict(production_id,label_id) do update set row_identity=excluded.row_identity,updated_at=clock_timestamp();
    end loop;
  end if;
  v_result:=public.dbmt_erp_save_production_before_lot_correction(p_token,v_entry,p_transaction_rows,p_replace_id);
  if jsonb_array_length(v_changes)>0 then
    if v_result->>'ok' is distinct from 'true' then
      raise exception '%',coalesce(v_result->>'message','이력번호 수정 저장에 실패했습니다.');
    end if;
    insert into public.change_logs(entity,action,entity_id,summary,payload)
      values('생산일보','라벨 이력번호 정정',v_id,format('라벨 생산품 이력번호 %s건 정정',jsonb_array_length(v_changes)),
        jsonb_build_object('userId',v_user,'changes',v_changes,'savedAt',clock_timestamp()));
  end if;
  return v_result;
end;
$$;
revoke all on function public.dbmt_erp_save_production_before_lot_correction(text,jsonb,jsonb,text) from public,anon,authenticated;
revoke all on function public.dbmt_erp_save_production(text,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.dbmt_erp_save_production(text,jsonb,jsonb,text) to anon,authenticated;

-- Display/use the corrected inventory LOT during PDA operations. The original
-- print snapshot stays untouched for reprints and registration integrity checks.
do $patch$
declare d text; a text:=$a$'lot',v_snap->>'lot','origin',v_snap->>'origin'$a$;
  b text:=$b$'lot',coalesce(v_source.raw->>'lot',v_row->>'lot',v_snap->>'lot'),'origin',v_snap->>'origin'$b$;
begin
  select pg_get_functiondef('pda_private.resolve(text)'::regprocedure) into d;
  if position(b in d)=0 then
    if (length(d)-length(replace(d,a,'')))/length(a)<>1 then raise exception 'Unexpected PDA LOT resolver definition'; end if;
    execute replace(d,a,b);
  end if;
end;
$patch$;
notify pgrst,'reload schema';
