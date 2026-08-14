-- M02 phase 3-3: enforce the Excel-import/create permission on transaction imports.

create or replace function public.dbmt_erp_import_transactions(
  p_token text,
  p_rows jsonb
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
  v_rows jsonb := coalesce(p_rows, '[]'::jsonb);
  v_row_count integer;
  v_audit jsonb;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'session_expired', 'message', '개인 사용자 로그인이 만료되었습니다.');
  end if;
  if public.dbmt_erp_has_permission(p_token, 'import', 'create') is not true then
    return public.dbmt_erp_permission_denied(v_user_id, 'import', 'create');
  end if;
  if jsonb_typeof(v_rows) <> 'array' then raise exception '엑셀 가져오기 형식이 올바르지 않습니다.'; end if;
  v_row_count := jsonb_array_length(v_rows);
  if v_row_count < 1 then raise exception '가져올 거래내역이 없습니다.'; end if;
  if v_row_count > 2000 then raise exception '엑셀 거래내역은 한 번에 2,000건까지 가져올 수 있습니다.'; end if;
  if exists (
    select 1 from jsonb_array_elements(v_rows) r(elem)
    where jsonb_typeof(r.elem) <> 'object'
      or nullif(btrim(coalesce(r.elem->>'id', '')), '') is null
      or length(r.elem->>'id') > 120
      or public.dbmt_safe_date(r.elem->>'date') is null
      or nullif(btrim(coalesce(r.elem->>'product', '')), '') is null
      or coalesce(r.elem->>'type', '') not in ('입고', '사용', '출고')
      or public.dbmt_safe_bool(r.elem->>'_isProdUse', false)
      or public.dbmt_safe_bool(r.elem->>'_isProdOut', false)
      or public.dbmt_safe_bool(r.elem->>'_isStockAdjust', false)
  ) then
    raise exception '엑셀 거래내역의 날짜, 구분, 품목 또는 식별값을 확인해주세요.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_rows) r(elem)
    join public.transactions t on t.id = r.elem->>'id'
  ) then
    raise exception '이미 사용 중인 거래 식별값이 포함되어 있습니다. 새로고침 후 다시 가져와주세요.';
  end if;

  select * into v_user from public.erp_users where id = v_user_id;
  select * into v_role from public.erp_roles where id = v_user.role_id;
  v_audit := jsonb_build_object(
    'authMode', 'personal_session', 'source', 'excel_import',
    'userId', v_user.id, 'loginId', v_user.login_id,
    'displayName', v_user.display_name, 'roleCode', v_role.code,
    'savedAt', clock_timestamp()
  );

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
    elem->>'note', true, false, false, null, false, null, null,
    public.dbmt_safe_numeric(elem->>'stockUnitPrice'), public.dbmt_safe_date(elem->>'stockProddate'),
    elem->>'sourceStockKey', elem->>'stockLocation', elem->>'fromLocation', elem->>'toLocation',
    elem || jsonb_build_object('_serverAudit', v_audit), now(), null
  from jsonb_array_elements(v_rows) rows(elem);

  update public.erp_user_sessions set last_used_at = now()
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  insert into public.change_logs(entity, action, summary, payload)
  values ('엑셀 가져오기', '저장', format('거래내역 %s건 가져오기', v_row_count),
    jsonb_build_object(
      'userId', v_user.id, 'loginId', v_user.login_id,
      'displayName', v_user.display_name, 'roleCode', v_role.code,
      'authMode', 'personal_session', 'count', v_row_count
    ));
  return jsonb_build_object('ok', true, 'transactions', v_row_count);
end;
$dbmt$;

revoke all on function public.dbmt_erp_import_transactions(text, jsonb) from public;
grant execute on function public.dbmt_erp_import_transactions(text, jsonb) to anon, authenticated;

-- Legacy migration/import functions remain available only to trusted server maintenance.
revoke all on function public.dbmt_import_transactions(text, jsonb) from public, anon, authenticated;
revoke all on function public.dbmt_import_production(text, jsonb) from public, anon, authenticated;
revoke all on function public.dbmt_import_prices(text, jsonb) from public, anon, authenticated;
grant execute on function public.dbmt_import_transactions(text, jsonb) to service_role;
grant execute on function public.dbmt_import_production(text, jsonb) to service_role;
grant execute on function public.dbmt_import_prices(text, jsonb) to service_role;

notify pgrst, 'reload schema';
