-- Add or edit one schedule event without replacing the complete event array.

create or replace function public.dbmt_mobile_admin_save_schedule(
  p_token text, p_id text, p_date date, p_text text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_account_id uuid := public.dbmt_mobile_admin_session_account(p_token);
  v_events jsonb;
  v_event jsonb;
  v_id text := nullif(btrim(coalesce(p_id,'')), '');
  v_action text := '일정수정';
begin
  if v_account_id is null then raise exception '로그인이 만료되었습니다.'; end if;
  if p_date is null then raise exception '일정 날짜를 입력해주세요.'; end if;
  if btrim(coalesce(p_text,'')) = '' then raise exception '일정 내용을 입력해주세요.'; end if;
  if length(btrim(p_text)) > 300 then raise exception '일정 내용은 300자 이내로 입력해주세요.'; end if;

  insert into public.app_data(key, payload, updated_at)
  values ('scheduleEvents', '[]'::jsonb, now())
  on conflict (key) do nothing;
  select case when jsonb_typeof(payload) = 'array' then payload else '[]'::jsonb end
    into v_events from public.app_data where key = 'scheduleEvents' for update;

  if v_id is null then
    v_id := 'schedule_' || encode(extensions.gen_random_bytes(10), 'hex');
    v_event := jsonb_build_object('id', v_id, 'date', p_date::text, 'text', btrim(p_text));
    v_events := v_events || jsonb_build_array(v_event);
    v_action := '일정등록';
  else
    if not exists (select 1 from jsonb_array_elements(v_events) as rows(e) where e->>'id' = v_id) then
      raise exception '수정할 일정을 찾을 수 없습니다. 새로고침 후 다시 시도해주세요.';
    end if;
    select coalesce(jsonb_agg(case when e->>'id' = v_id then
      e || jsonb_build_object('date', p_date::text, 'text', btrim(p_text))
      else e end order by ord), '[]'::jsonb) into v_events
    from jsonb_array_elements(v_events) with ordinality as rows(e, ord);
    select e into v_event from jsonb_array_elements(v_events) as rows(e)
    where e->>'id' = v_id limit 1;
  end if;

  update public.app_data set payload = v_events, updated_at = now()
  where key = 'scheduleEvents';
  update public.mobile_admin_sessions set last_used_at = now()
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values ('일정관리', v_action, v_id, p_date::text || ' / ' || btrim(p_text),
    jsonb_build_object('mobileAdminId', v_account_id, 'event', v_event));

  return jsonb_build_object('ok', true, 'event', v_event, 'events', v_events);
end;
$dbmt$;

grant execute on function public.dbmt_mobile_admin_save_schedule(text, text, date, text)
  to anon, authenticated;
notify pgrst, 'reload schema';
