-- M02 phase 2: enforce the stock/update permission for inventory adjustments.

create or replace function public.dbmt_erp_save_stock_adjust(p_token text, p_record jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_user_id uuid := public.dbmt_erp_session_user(p_token);
  v_user public.erp_users%rowtype;
  v_role public.erp_roles%rowtype;
  v_id text := nullif(btrim(coalesce(p_record->>'id', '')), '');
  v_date date := public.dbmt_safe_date(p_record->>'date');
  v_product text := btrim(coalesce(p_record->>'product', ''));
  v_origin text := btrim(coalesce(p_record->>'origin', ''));
  v_packunit text := btrim(coalesce(p_record->>'packunit', ''));
  v_location text := btrim(coalesce(p_record->>'stockLocation', ''));
  v_lot text := btrim(coalesce(p_record->>'lot', ''));
  v_proddate date := public.dbmt_safe_date(p_record->>'proddate');
  v_price numeric := public.dbmt_safe_numeric(p_record->>'price');
  v_current numeric := public.dbmt_safe_numeric(p_record->>'stockBefore');
  v_actual numeric := public.dbmt_safe_numeric(p_record->>'stockActual');
  v_diff numeric;
  v_note text := btrim(coalesce(p_record->>'note', ''));
  v_transaction jsonb;
  v_log_entry jsonb;
  v_logs jsonb;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'session_expired', 'message', '개인 사용자 로그인이 만료되었습니다.');
  end if;
  if public.dbmt_erp_has_permission(p_token, 'stock', 'update') is not true then
    return public.dbmt_erp_permission_denied(v_user_id, 'stock', 'update');
  end if;
  if jsonb_typeof(coalesce(p_record, '{}'::jsonb)) <> 'object' then raise exception '재고 정리 값이 올바르지 않습니다.'; end if;
  if v_date is null then raise exception '재고 정리 날짜를 입력해주세요.'; end if;
  if v_product = '' or length(v_product) > 200 then raise exception '품목 정보를 확인해주세요.'; end if;
  if v_location = '' or length(v_location) > 120 then raise exception '재고 지점을 확인해주세요.'; end if;
  if length(v_origin) > 100 or length(v_packunit) > 60 or length(v_lot) > 120 then raise exception '재고 식별정보가 너무 깁니다.'; end if;
  if v_current is null or v_actual is null then raise exception '현재 재고와 실제 재고를 숫자로 입력해주세요.'; end if;
  v_price := coalesce(v_price, 0);
  if v_price < 0 then raise exception '단가는 0 이상이어야 합니다.'; end if;
  v_diff := round(v_actual - v_current, 2);
  if abs(v_diff) < 0.01 then raise exception '현재 재고와 실제 재고가 같습니다.'; end if;
  if length(v_note) > 500 then raise exception '메모는 500자 이내로 입력해주세요.'; end if;
  if v_id is null then v_id := 'stock_adjust_' || encode(extensions.gen_random_bytes(10), 'hex'); end if;
  if v_id !~ '^[A-Za-z0-9_-]{1,100}$' then raise exception '재고 정리 식별값이 올바르지 않습니다.'; end if;

  select * into v_user from public.erp_users where id = v_user_id;
  select * into v_role from public.erp_roles where id = v_user.role_id;

  v_transaction := jsonb_strip_nulls(jsonb_build_object(
    'id', v_id, 'date', v_date::text, 'type', '재고조정', 'trader', '재고정리',
    'product', v_product, 'origin', v_origin, 'storage', '', 'packunit', v_packunit,
    'stockLocation', v_location, 'lot', v_lot, 'proddate', v_proddate,
    'stockProddate', v_proddate, 'stockUnitPrice', v_price,
    'weight', v_diff, 'price', v_price, 'amount', round(v_diff * v_price),
    'note', v_note, '_isUser', true, '_isStockAdjust', true,
    'stockBefore', v_current, 'stockActual', v_actual,
    'audit', jsonb_build_object(
      'authMode', 'personal_session', 'userId', v_user.id,
      'loginId', v_user.login_id, 'displayName', v_user.display_name,
      'roleCode', v_role.code, 'savedAt', clock_timestamp()
    )
  ));

  insert into public.transactions(
    id, date, type, product, origin, packunit, trader, storage, lot, proddate,
    weight, price, amount, note, is_user, is_stock_adjust, stock_before,
    stock_actual, stock_unit_price, stock_proddate, stock_location, raw, updated_at, deleted_at
  ) values (
    v_id, v_date, '재고조정', v_product, v_origin, v_packunit, '재고정리', '', v_lot, v_proddate,
    v_diff, v_price, round(v_diff * v_price), v_note, true, true, v_current,
    v_actual, v_price, v_proddate, v_location, v_transaction, now(), null
  );

  v_log_entry := jsonb_build_object(
    'id', 'cl_user_' || encode(extensions.gen_random_bytes(8), 'hex'),
    'at', clock_timestamp(), 'menu', '재고현황', 'action', '재고정리',
    'target', v_product, 'summary', v_location || ' / ' || v_product || ' / ' ||
      v_current::text || 'KG → ' || v_actual::text || 'KG', 'refId', v_id,
    'authMode', 'personal_session', 'userId', v_user.id,
    'userName', v_user.display_name, 'userLoginId', v_user.login_id,
    'roleCode', v_role.code, 'roleName', v_role.name
  );
  insert into public.app_data(key, payload, updated_at)
  values ('dataChangeLogs', '[]'::jsonb, now()) on conflict (key) do nothing;
  select case when jsonb_typeof(payload) = 'array' then payload else '[]'::jsonb end
  into v_logs from public.app_data where key = 'dataChangeLogs' for update;
  update public.app_data set payload = jsonb_build_array(v_log_entry) || v_logs, updated_at = now()
  where key = 'dataChangeLogs';

  update public.erp_user_sessions set last_used_at = now()
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values ('재고현황', '재고정리', v_id, v_log_entry->>'summary',
    jsonb_build_object('userId', v_user.id, 'loginId', v_user.login_id,
      'displayName', v_user.display_name, 'roleCode', v_role.code,
      'authMode', 'personal_session', 'transaction', v_transaction));

  return jsonb_build_object('ok', true, 'transaction', v_transaction, 'logEntry', v_log_entry);
end;
$dbmt$;

revoke all on function public.dbmt_erp_save_stock_adjust(text, jsonb) from public;
grant execute on function public.dbmt_erp_save_stock_adjust(text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
