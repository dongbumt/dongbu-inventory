-- M02 phase 3-2: enforce personal permissions and atomic writes for production journals.

create or replace function public.dbmt_erp_save_production(
  p_token text,
  p_entry jsonb default null,
  p_transaction_rows jsonb default '[]'::jsonb,
  p_replace_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_user_id uuid := public.dbmt_erp_session_user(p_token);
  v_user public.erp_users%rowtype;
  v_role public.erp_roles%rowtype;
  v_rows jsonb := coalesce(p_transaction_rows, '[]'::jsonb);
  v_has_entry boolean := p_entry is not null and p_entry <> 'null'::jsonb;
  v_entry_id text;
  v_replace_id text := nullif(btrim(coalesce(p_replace_id, '')), '');
  v_required_action text;
  v_audit jsonb;
  v_transaction_count integer;
  v_deleted_usage_count integer := 0;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'session_expired', 'message', '개인 사용자 로그인이 만료되었습니다.');
  end if;
  if jsonb_typeof(v_rows) <> 'array' then
    raise exception '생산 연계 거래 형식이 올바르지 않습니다.';
  end if;
  v_transaction_count := jsonb_array_length(v_rows);
  if v_transaction_count > 500 then
    raise exception '생산 연계 거래는 한 번에 500건까지 처리할 수 있습니다.';
  end if;

  if v_has_entry then
    if jsonb_typeof(p_entry) <> 'object' then raise exception '생산일보 형식이 올바르지 않습니다.'; end if;
    v_entry_id := nullif(btrim(coalesce(p_entry->>'id', '')), '');
    if v_entry_id is null or length(v_entry_id) > 120 then raise exception '생산일보 식별값을 확인해주세요.'; end if;
    if public.dbmt_safe_date(coalesce(p_entry->>'date', p_entry->>'workDate')) is null then
      raise exception '생산 작업일을 확인해주세요.';
    end if;
    if v_replace_id is null and exists (
      select 1 from public.production_entries where id = v_entry_id and deleted_at is null
    ) then
      v_replace_id := v_entry_id;
    end if;
    v_required_action := case when v_replace_id is null then 'create' else 'update' end;
    if v_replace_id is not null and not exists (
      select 1 from public.production_entries where id = v_replace_id and deleted_at is null
    ) then
      raise exception '수정할 생산일보를 찾을 수 없습니다. 새로고침 후 다시 시도해주세요.';
    end if;
    if exists (
      select 1 from public.production_entries
      where id = v_entry_id and deleted_at is null and id <> coalesce(v_replace_id, '')
    ) then
      raise exception '이미 사용 중인 생산일보 식별값입니다.';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_rows) r(elem)
      where jsonb_typeof(r.elem) <> 'object'
        or nullif(btrim(coalesce(r.elem->>'id', '')), '') is null
        or length(r.elem->>'id') > 120
        or coalesce(r.elem->>'_prodId', '') <> v_entry_id
        or (
          public.dbmt_safe_bool(r.elem->>'_isProdUse', false)
          = public.dbmt_safe_bool(r.elem->>'_isProdOut', false)
        )
        or public.dbmt_safe_bool(r.elem->>'_isStockAdjust', false)
        or (public.dbmt_safe_bool(r.elem->>'_isProdUse', false) and coalesce(r.elem->>'type', '') <> '사용')
        or (public.dbmt_safe_bool(r.elem->>'_isProdOut', false) and coalesce(r.elem->>'type', '') <> '생산입고')
    ) then
      raise exception '생산 연계 거래의 식별값 또는 구분이 올바르지 않습니다.';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_rows) r(elem)
      join public.transactions t on t.id = r.elem->>'id'
      where t.deleted_at is null
        and coalesce(t.prod_id, t.raw->>'_prodId', '') not in (v_entry_id, coalesce(v_replace_id, v_entry_id))
    ) then
      raise exception '다른 거래내역에서 이미 사용 중인 생산 연계 식별값입니다.';
    end if;
  else
    if v_replace_id is null then raise exception '삭제할 생산일보가 없습니다.'; end if;
    if v_transaction_count <> 0 then raise exception '생산일보 삭제 요청에 신규 거래가 포함되어 있습니다.'; end if;
    if not exists (
      select 1 from public.production_entries where id = v_replace_id and deleted_at is null
    ) then
      raise exception '삭제할 생산일보를 찾을 수 없습니다. 새로고침 후 다시 시도해주세요.';
    end if;
    v_entry_id := v_replace_id;
    v_required_action := 'delete';
  end if;

  if public.dbmt_erp_has_permission(p_token, 'production', v_required_action) is not true then
    return public.dbmt_erp_permission_denied(v_user_id, 'production', v_required_action);
  end if;
  select * into v_user from public.erp_users where id = v_user_id;
  select * into v_role from public.erp_roles where id = v_user.role_id;
  v_audit := jsonb_build_object(
    'authMode', 'personal_session', 'userId', v_user.id,
    'loginId', v_user.login_id, 'displayName', v_user.display_name,
    'roleCode', v_role.code, 'savedAt', clock_timestamp()
  );

  if v_replace_id is not null then
    update public.production_entries
    set deleted_at = now(), updated_at = now()
    where id = v_replace_id and deleted_at is null;
    update public.transactions
    set deleted_at = now(), updated_at = now()
    where deleted_at is null and (prod_id = v_replace_id or raw->>'_prodId' = v_replace_id);
  end if;

  if not v_has_entry then
    update public.submaterial_usages
    set deleted_at = now(), updated_at = now()
    where production_id = v_replace_id and deleted_at is null;
    get diagnostics v_deleted_usage_count = row_count;
  else
    insert into public.production_entries(
      id, work_date, product, lot, output_weight, raw, updated_at, deleted_at
    ) values (
      v_entry_id,
      public.dbmt_safe_date(coalesce(p_entry->>'date', p_entry->>'workDate')),
      coalesce(p_entry->>'product', p_entry#>>'{outputs,0,product}'),
      coalesce(p_entry->>'lot', p_entry#>>'{outputs,0,lot}'),
      (select coalesce(sum(public.dbmt_safe_numeric(o->>'qty')), 0)
       from jsonb_array_elements(coalesce(p_entry->'outputs', '[]'::jsonb)) outputs(o)),
      p_entry || jsonb_build_object('_serverAudit', v_audit), now(), null
    )
    on conflict (id) do update set
      work_date = excluded.work_date, product = excluded.product, lot = excluded.lot,
      output_weight = excluded.output_weight, raw = excluded.raw,
      updated_at = now(), deleted_at = null;

    insert into public.transactions (
      id, date, type, product, origin, packunit, trader, storage, lot, proddate,
      weight, price, amount, note, is_user, is_prod_use, is_prod_out, prod_id,
      is_stock_adjust, stock_before, stock_actual, stock_unit_price, stock_proddate,
      source_stock_key, stock_location, from_location, to_location, raw, updated_at, deleted_at
    )
    select
      elem->>'id', public.dbmt_safe_date(elem->>'date'), elem->>'type', elem->>'product',
      elem->>'origin', elem->>'packunit', elem->>'trader', elem->>'storage', elem->>'lot',
      public.dbmt_safe_date(elem->>'proddate'), public.dbmt_safe_numeric(elem->>'weight'),
      public.dbmt_safe_numeric(elem->>'price'), public.dbmt_safe_numeric(elem->>'amount'),
      elem->>'note', true, public.dbmt_safe_bool(elem->>'_isProdUse', false),
      public.dbmt_safe_bool(elem->>'_isProdOut', false), v_entry_id, false, null, null,
      public.dbmt_safe_numeric(elem->>'stockUnitPrice'), public.dbmt_safe_date(elem->>'stockProddate'),
      elem->>'sourceStockKey', elem->>'stockLocation', elem->>'fromLocation', elem->>'toLocation',
      elem || jsonb_build_object('_serverAudit', v_audit), now(), null
    from jsonb_array_elements(v_rows) rows(elem)
    on conflict (id) do update set
      date = excluded.date, type = excluded.type, product = excluded.product,
      origin = excluded.origin, packunit = excluded.packunit, trader = excluded.trader,
      storage = excluded.storage, lot = excluded.lot, proddate = excluded.proddate,
      weight = excluded.weight, price = excluded.price, amount = excluded.amount,
      note = excluded.note, is_user = true, is_prod_use = excluded.is_prod_use,
      is_prod_out = excluded.is_prod_out, prod_id = excluded.prod_id,
      is_stock_adjust = false, stock_before = null, stock_actual = null,
      stock_unit_price = excluded.stock_unit_price, stock_proddate = excluded.stock_proddate,
      source_stock_key = excluded.source_stock_key, stock_location = excluded.stock_location,
      from_location = excluded.from_location, to_location = excluded.to_location,
      raw = excluded.raw, updated_at = now(), deleted_at = null;
  end if;

  update public.erp_user_sessions set last_used_at = now()
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values ('생산일보', case v_required_action when 'create' then '저장' when 'update' then '수정' else '삭제' end,
    v_entry_id, coalesce(p_entry->>'date', p_entry->>'workDate', ''),
    jsonb_build_object(
      'userId', v_user.id, 'loginId', v_user.login_id,
      'displayName', v_user.display_name, 'roleCode', v_role.code,
      'authMode', 'personal_session', 'productionId', v_entry_id,
      'transactionCount', v_transaction_count, 'deletedSubmaterialUsageCount', v_deleted_usage_count
    ));
  return jsonb_build_object(
    'ok', true, 'action', v_required_action, 'productionId', v_entry_id,
    'transactions', v_transaction_count, 'deletedSubmaterialUsages', v_deleted_usage_count
  );
end;
$dbmt$;

revoke all on function public.dbmt_erp_save_production(text, jsonb, jsonb, text) from public;
grant execute on function public.dbmt_erp_save_production(text, jsonb, jsonb, text) to anon, authenticated;

revoke all on function public.dbmt_upsert_production(text, jsonb) from public, anon, authenticated;
revoke all on function public.dbmt_delete_production(text, text) from public, anon, authenticated;
revoke all on function public.dbmt_sync_production(text, jsonb) from public, anon, authenticated;
grant execute on function public.dbmt_upsert_production(text, jsonb) to service_role;
grant execute on function public.dbmt_delete_production(text, text) to service_role;
grant execute on function public.dbmt_sync_production(text, jsonb) to service_role;

notify pgrst, 'reload schema';
