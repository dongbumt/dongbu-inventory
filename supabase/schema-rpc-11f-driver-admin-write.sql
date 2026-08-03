-- Administrator manual entry, correction, and soft deletion.

create or replace function public.dbmt_driver_admin_save_attendance(
  p_password text, p_id uuid, p_account_id uuid,
  p_start_at timestamptz, p_end_at timestamptz,
  p_start_region text, p_end_region text, p_break_minutes integer,
  p_start_location_text text, p_end_location_text text,
  p_note text, p_manual_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_id uuid := coalesce(p_id, extensions.gen_random_uuid());
  v_before jsonb;
  v_after jsonb;
  v_elapsed integer;
  v_break integer := greatest(0, coalesce(p_break_minutes, 0));
  v_actual integer;
  v_bonus integer := 0;
  v_recognized integer;
  v_status text := 'working';
begin
  if not public.dbmt_check_password(p_password) then raise exception 'invalid app password'; end if;
  if not exists(select 1 from public.driver_accounts where id = p_account_id) then
    raise exception '배송기사를 선택해주세요.';
  end if;
  if p_start_at is null then raise exception '출근시각을 입력해주세요.'; end if;
  if p_end_at is not null and p_end_at < p_start_at then
    raise exception '퇴근시각은 출근시각보다 빠를 수 없습니다.';
  end if;
  if btrim(coalesce(p_manual_reason,'')) = '' then raise exception '수기입력 또는 수정 사유를 입력해주세요.'; end if;

  if p_end_at is not null then
    v_elapsed := greatest(0, floor(extract(epoch from (p_end_at - p_start_at)) / 60)::integer);
    if v_break > v_elapsed then raise exception '휴게시간이 전체 근무시간보다 길 수 없습니다.'; end if;
    v_actual := v_elapsed - v_break;
    v_bonus := case when p_start_region = '인천' then 60 else 0 end
      + case when p_end_region = '인천' then 60 else 0 end;
    v_recognized := v_actual + v_bonus;
    v_status := 'completed';
  end if;

  select to_jsonb(d) into v_before from public.driver_attendance d where d.id = p_id;
  if p_id is null then
    insert into public.driver_attendance(
      id, account_id, work_date, start_at, end_at, start_region, end_region,
      start_location_text, end_location_text, break_minutes, actual_minutes,
      bonus_minutes, recognized_minutes, status, note, source, manual_reason
    ) values (
      v_id, p_account_id, timezone('Asia/Seoul', p_start_at)::date, p_start_at, p_end_at,
      case when p_start_region='인천' then '인천' else '기타' end,
      case when p_end_at is null then null when p_end_region='인천' then '인천' else '기타' end,
      nullif(btrim(coalesce(p_start_location_text,'')), ''),
      nullif(btrim(coalesce(p_end_location_text,'')), ''), v_break, v_actual,
      v_bonus, v_recognized, v_status, nullif(btrim(coalesce(p_note,'')), ''),
      'admin', btrim(p_manual_reason)
    );
  else
    update public.driver_attendance set account_id = p_account_id,
      work_date = timezone('Asia/Seoul', p_start_at)::date, start_at = p_start_at,
      end_at = p_end_at, start_region = case when p_start_region='인천' then '인천' else '기타' end,
      end_region = case when p_end_at is null then null when p_end_region='인천' then '인천' else '기타' end,
      start_location_text = coalesce(nullif(btrim(coalesce(p_start_location_text,'')), ''), start_location_text),
      end_location_text = coalesce(nullif(btrim(coalesce(p_end_location_text,'')), ''), end_location_text),
      break_minutes = v_break, actual_minutes = v_actual, bonus_minutes = v_bonus,
      recognized_minutes = v_recognized, status = v_status,
      note = nullif(btrim(coalesce(p_note,'')), ''),
      source = case when source='mobile' then 'mobile_edited' else source end,
      manual_reason = concat_ws(' / ', nullif(manual_reason,''), btrim(p_manual_reason)),
      updated_at = now() where id = p_id and deleted_at is null;
    if not found then raise exception '수정할 출퇴근 기록을 찾을 수 없습니다.'; end if;
  end if;

  select to_jsonb(d) into v_after from public.driver_attendance d where d.id = v_id;
  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values ('배송기사근태', case when p_id is null then '수기입력' else '수정' end,
    v_id::text, btrim(p_manual_reason), jsonb_build_object('before', v_before, 'after', v_after));
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$dbmt$;

create or replace function public.dbmt_driver_admin_delete_attendance(
  p_password text, p_id uuid, p_reason text
)
returns jsonb language plpgsql security definer set search_path = public, extensions as $dbmt$
declare v_before jsonb;
begin
  if not public.dbmt_check_password(p_password) then raise exception 'invalid app password'; end if;
  if btrim(coalesce(p_reason,'')) = '' then raise exception '삭제 사유를 입력해주세요.'; end if;
  select to_jsonb(d) into v_before from public.driver_attendance d
  where d.id = p_id and d.deleted_at is null for update;
  if v_before is null then raise exception '삭제할 기록을 찾을 수 없습니다.'; end if;
  update public.driver_attendance set deleted_at = now(), updated_at = now() where id = p_id;
  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values ('배송기사근태', '삭제', p_id::text, btrim(p_reason), v_before);
  return jsonb_build_object('ok', true, 'id', p_id);
end;
$dbmt$;

grant execute on function public.dbmt_driver_admin_save_attendance(
  text, uuid, uuid, timestamptz, timestamptz, text, text, integer, text, text, text, text
) to anon, authenticated;
grant execute on function public.dbmt_driver_admin_delete_attendance(text, uuid, text)
  to anon, authenticated;
notify pgrst, 'reload schema';
