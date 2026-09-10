-- Install after 36. Full journal editing; retain immutable transfer provenance and idempotency.
create or replace function public.dbmt_label_production_transactions(p_entry jsonb)
returns jsonb language sql security definer set search_path = public, extensions as $dbmt$
  select coalesce(jsonb_agg(
    (e - array['qty','manualPrice']) || jsonb_build_object(
      'samsungVendorId',coalesce(e#>>'{samsung,vendorId}',''),
      'samsungVendorName',coalesce(e#>>'{samsung,vendorName}',''),
      'samsungProductRowId',coalesce(e#>>'{samsung,productRowId}',''),
      'samsungProductId',coalesce(e#>>'{samsung,productId}',''),
      'samsungProductName',coalesce(e#>>'{samsung,productName}',''),
      'samsungSpec',coalesce(e#>>'{samsung,spec}',''),
      'id','tx_' || (p_entry->>'id') || '_' || kind || '_' || (n-1)::text,
      'date',replace(p_entry->>'date','/','-'), 'type',case when kind='use' then '사용' else '생산입고' end,
      'weight',e->'qty','trader',case when kind='use' then '' else '생산작업' end,
      'stockLocation',coalesce(nullif(e->>'stockLocation',''),'가공장'),
      'stockProddate',coalesce(e->>'proddate',''),
      'stockUnitPrice',coalesce(e->'stockUnitPrice',e->'price','0'::jsonb),
      '_isUser',true,'_isProdUse',kind='use','_isProdOut',kind='out','_prodId',p_entry->>'id',
      'note',coalesce(p_entry->>'job_type','생산') || case when kind='use' then '작업 ' else '완료 ' end ||
        (p_entry->>'date') || ' #' || (p_entry->>'job_no') ||
        case when coalesce(p_entry->>'note','')='' then '' else ' / ' || (p_entry->>'note') end
    ) order by kind,n
  ),'[]'::jsonb)
  from (
    select e,n,'use' kind from jsonb_array_elements(p_entry->'inputs') with ordinality a(e,n)
    union all
    select e,n,'out' kind from jsonb_array_elements(p_entry->'outputs') with ordinality a(e,n)
  ) rows;
$dbmt$;

create or replace function public.dbmt_erp_save_production(p_token text,p_entry jsonb default null,p_transaction_rows jsonb default '[]'::jsonb,p_replace_id text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $dbmt$
declare
  v_user_id uuid := public.dbmt_erp_session_user(p_token);
  v_completion public.label_production_completions%rowtype;
  v_entry jsonb := p_entry; v_rows jsonb; v_result jsonb; v_inputs jsonb; v_outputs jsonb;
begin
  if v_user_id is null then
    return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.');
  end if;
  select * into v_completion from public.label_production_completions
    where production_id in (p_entry->>'id',p_replace_id) limit 1;
  if v_completion.work_order_id is null or p_entry is null or p_entry='null'::jsonb then
    if v_completion.work_order_id is null and p_entry ? '_labelCompletion' then
      raise exception '라벨 생산완료 정보는 직접 등록할 수 없습니다.';
    end if;
    return public.dbmt_erp_save_production_before_label(p_token,p_entry,p_transaction_rows,p_replace_id);
  end if;
  if public.dbmt_erp_has_permission(p_token,'production','update') is not true then
    return public.dbmt_erp_permission_denied(v_user_id,'production','update');
  end if;
  -- The record's identity stays stable so editing cannot transfer its completion
  -- marker to a different journal or allow the same work order to post again.
  if p_entry->>'id' is distinct from v_completion.production_id
    or (nullif(btrim(p_replace_id),'') is not null and p_replace_id<>v_completion.production_id) then
    raise exception '전송된 생산일보의 식별값은 변경할 수 없습니다.';
  end if;
  if jsonb_typeof(p_entry->'inputs') is distinct from 'array'
    or jsonb_typeof(p_entry->'outputs') is distinct from 'array' then
    raise exception '투입 및 생산 항목 형식을 확인해주세요.';
  end if;
  if jsonb_array_length(p_entry->'inputs')+jsonb_array_length(p_entry->'outputs') not between 1 and 500 then
    raise exception '투입 또는 생산 항목을 1건 이상, 합계 500건 이하로 입력해주세요.';
  end if;
  if exists(select 1 from jsonb_array_elements((p_entry->'inputs') || (p_entry->'outputs')) e
    where jsonb_typeof(e)<>'object' or coalesce(btrim(e->>'product'),'')=''
      or jsonb_typeof(e->'qty') is distinct from 'number' or public.dbmt_safe_numeric(e->>'qty')<=0
      or jsonb_typeof(e->'price') is distinct from 'number') then
    raise exception '품목·중량·단가를 확인해주세요. 중량은 0보다 커야 합니다.';
  end if;
  -- Respect edited prices, including the normal form's automatic/manual costing.
  -- Always regenerate inventory from the edited journal, including old clients
  -- that send no postings. Never restore the initial transfer's quantities.
  select coalesce(jsonb_agg(e || jsonb_build_object('amount',
    public.dbmt_safe_numeric(e->>'qty')*public.dbmt_safe_numeric(e->>'price')) order by n),'[]'::jsonb)
    into v_inputs from jsonb_array_elements(p_entry->'inputs') with ordinality r(e,n);
  select coalesce(jsonb_agg(e || jsonb_build_object('amount',
    ceil(public.dbmt_safe_numeric(e->>'qty')*public.dbmt_safe_numeric(e->>'price'))) order by n),'[]'::jsonb)
    into v_outputs from jsonb_array_elements(p_entry->'outputs') with ordinality r(e,n);
  v_entry := p_entry || jsonb_build_object('inputs',v_inputs,'outputs',v_outputs,
    '_labelCompletion',v_completion.baseline->'_labelCompletion');
  v_rows := public.dbmt_label_production_transactions(v_entry);
  v_result := public.dbmt_erp_save_production_before_label(p_token,v_entry,v_rows,v_completion.production_id);
  return v_result || case when v_result->>'ok'='true' then jsonb_build_object(
    'entry',(select raw from public.production_entries where id=v_completion.production_id),
    'transactionRows',coalesce((select jsonb_agg(raw order by id) from public.transactions
      where prod_id=v_completion.production_id and deleted_at is null),'[]'::jsonb)
  ) else '{}'::jsonb end;
end;
$dbmt$;

-- Show the current journal date/number after an office edit. Keep original
-- baseline, printed snapshots and completion timestamp unchanged for audit.
create or replace function public.dbmt_label_completion_status()
returns jsonb language sql security definer set search_path = public, extensions as $dbmt$
  select coalesce(jsonb_agg(jsonb_build_object(
    'workOrderId', c.work_order_id, 'productionId', c.production_id,
    'completedAt', c.completed_at, 'date', coalesce(p.raw->>'date',c.baseline->>'date'),
    'jobNo', coalesce(p.raw->>'job_no',c.baseline->>'job_no'), 'deleted', p.deleted_at is not null
  )), '[]'::jsonb)
  from public.label_production_completions c join public.production_entries p on p.id=c.production_id;
$dbmt$;
revoke all on function public.dbmt_label_completion_status() from public,anon,authenticated;
revoke all on function public.dbmt_label_production_transactions(jsonb) from public,anon,authenticated;
revoke all on function public.dbmt_erp_save_production_before_label(text,jsonb,jsonb,text) from public,anon,authenticated;
revoke all on function public.dbmt_erp_save_production(text,jsonb,jsonb,text) from public;
grant execute on function public.dbmt_erp_save_production(text,jsonb,jsonb,text) to anon,authenticated;
notify pgrst,'reload schema';
