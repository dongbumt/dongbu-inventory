-- M02 completion: protect production-linked submaterial usage writes with the
-- personal production permissions while preserving the existing ERP screen.

create or replace function public.dbmt_erp_save_submaterial_usages(
  p_token text,
  p_rows jsonb default '[]'::jsonb,
  p_delete_ids jsonb default '[]'::jsonb
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
  v_delete_ids jsonb := coalesce(p_delete_ids, '[]'::jsonb);
  v_upsert_count integer;
  v_requested_delete_count integer;
  v_deleted_count integer := 0;
  v_audit jsonb;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'session_expired', 'message', '개인 사용자 로그인이 만료되었습니다.');
  end if;
  if jsonb_typeof(v_rows) <> 'array' or jsonb_typeof(v_delete_ids) <> 'array' then
    raise exception '부자재 사용 요청 형식이 올바르지 않습니다.';
  end if;

  v_upsert_count := jsonb_array_length(v_rows);
  v_requested_delete_count := jsonb_array_length(v_delete_ids);
  if v_upsert_count > 500 or v_requested_delete_count > 500 then
    raise exception '부자재 사용내역은 한 번에 500건까지 처리할 수 있습니다.';
  end if;
  if v_upsert_count < 1 and v_requested_delete_count < 1 then
    raise exception '저장하거나 삭제할 부자재 사용내역이 없습니다.';
  end if;

  if v_upsert_count > 0
     and public.dbmt_erp_has_permission(p_token, 'production', 'update') is not true then
    return public.dbmt_erp_permission_denied(v_user_id, 'production', 'update');
  end if;
  if v_requested_delete_count > 0
     and public.dbmt_erp_has_permission(p_token, 'production', 'delete') is not true then
    return public.dbmt_erp_permission_denied(v_user_id, 'production', 'delete');
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_rows) rows(elem)
    where jsonb_typeof(elem) <> 'object'
       or nullif(btrim(coalesce(elem->>'id', '')), '') is null
       or length(elem->>'id') > 120
       or nullif(btrim(coalesce(elem->>'productionId', '')), '') is null
       or length(elem->>'productionId') > 120
       or public.dbmt_safe_date(coalesce(elem->>'workDate', elem->>'date')) is null
       or nullif(btrim(coalesce(elem->>'itemId', '')), '') is null
       or nullif(btrim(coalesce(elem->>'lotId', '')), '') is null
       or coalesce(public.dbmt_safe_numeric(elem->>'qty'), 0) <= 0
  ) then
    raise exception '부자재 사용내역의 작업일, 품목, LOT 또는 수량을 확인해주세요.';
  end if;
  if exists (
    select elem->>'id'
    from jsonb_array_elements(v_rows) rows(elem)
    group by elem->>'id'
    having count(*) > 1
  ) then
    raise exception '중복된 부자재 사용 식별값이 포함되어 있습니다.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_rows) rows(elem)
    join public.submaterial_usages usage on usage.id = elem->>'id'
    where usage.production_id <> elem->>'productionId'
  ) then
    raise exception '다른 생산일보의 부자재 사용 식별값은 변경할 수 없습니다.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_delete_ids) rows(elem)
    where jsonb_typeof(elem) <> 'string'
       or nullif(btrim(elem#>>'{}'), '') is null
       or length(elem#>>'{}') > 120
  ) then
    raise exception '삭제할 부자재 사용 식별값을 확인해주세요.';
  end if;

  select * into v_user from public.erp_users where id = v_user_id;
  select * into v_role from public.erp_roles where id = v_user.role_id;
  v_audit := jsonb_build_object(
    'authMode', 'personal_session', 'userId', v_user.id,
    'loginId', v_user.login_id, 'displayName', v_user.display_name,
    'roleCode', v_role.code, 'savedAt', clock_timestamp()
  );

  insert into public.submaterial_usages (
    id, production_id, work_date, item_id, lot_id, qty, raw, updated_at, deleted_at
  )
  select
    elem->>'id', elem->>'productionId',
    public.dbmt_safe_date(coalesce(elem->>'workDate', elem->>'date')),
    elem->>'itemId', elem->>'lotId', public.dbmt_safe_numeric(elem->>'qty'),
    elem || jsonb_build_object('_serverAudit', v_audit), now(), null
  from jsonb_array_elements(v_rows) rows(elem)
  on conflict (id) do update set
    production_id = excluded.production_id,
    work_date = excluded.work_date,
    item_id = excluded.item_id,
    lot_id = excluded.lot_id,
    qty = excluded.qty,
    raw = excluded.raw,
    updated_at = now(),
    deleted_at = null;

  update public.submaterial_usages usage
  set deleted_at = now(), updated_at = now()
  where usage.deleted_at is null
    and usage.id in (select value from jsonb_array_elements_text(v_delete_ids));
  get diagnostics v_deleted_count = row_count;

  update public.erp_user_sessions set last_used_at = now()
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  insert into public.change_logs(entity, action, summary, payload)
  values ('부자재 사용', '저장',
    format('저장 %s건 / 삭제 %s건', v_upsert_count, v_deleted_count),
    jsonb_build_object(
      'userId', v_user.id, 'loginId', v_user.login_id,
      'displayName', v_user.display_name, 'roleCode', v_role.code,
      'authMode', 'personal_session', 'upsertCount', v_upsert_count,
      'requestedDeleteCount', v_requested_delete_count,
      'deletedCount', v_deleted_count, 'deleteIds', v_delete_ids
    ));

  return jsonb_build_object(
    'ok', true, 'submaterialUsages', v_upsert_count,
    'deleted', v_deleted_count
  );
end;
$dbmt$;

revoke all on function public.dbmt_erp_save_submaterial_usages(text, jsonb, jsonb) from public;
grant execute on function public.dbmt_erp_save_submaterial_usages(text, jsonb, jsonb) to anon, authenticated;

-- The browser now uses the personal-session RPC above. Keep the old writers
-- only for trusted maintenance and older database repair scripts.
revoke all on function public.dbmt_upsert_submaterial_usages(text, jsonb)
  from public, anon, authenticated;
revoke all on function public.dbmt_delete_submaterial_usage(text, text)
  from public, anon, authenticated;
grant execute on function public.dbmt_upsert_submaterial_usages(text, jsonb)
  to service_role;
grant execute on function public.dbmt_delete_submaterial_usage(text, text)
  to service_role;

notify pgrst, 'reload schema';
