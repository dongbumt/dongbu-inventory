-- Keep the operator's work-order title as the production journal note.
-- Patch the deployed stock-row version of the completion function in place.
do $dbmt$
declare
  v_def text;
  v_suffix text := ''' / 라벨 생산완료''';
  v_occurrences integer;
begin
  select pg_get_functiondef('public.dbmt_label_complete_production(text,text,jsonb)'::regprocedure)
    into v_def;
  if v_def is null then raise exception '라벨 생산완료 함수를 찾을 수 없습니다.'; end if;
  v_occurrences := (length(v_def)-length(replace(v_def,v_suffix,''))) / length(v_suffix);
  if v_occurrences=1 then
    execute replace(v_def,v_suffix,'''''');
  elsif v_occurrences<>0 then
    raise exception '라벨 생산일보 비고 계산 형식을 확인해주세요.';
  end if;
end;
$dbmt$;

-- Only clean untouched, active label journals with the exact old auto-note.
-- Keep the original completion baseline and any office-edited notes for audit.
with changed as (
  update public.production_entries p
  set raw=jsonb_set(p.raw,'{note}',to_jsonb(left(p.raw->>'note',
    length(p.raw->>'note')-length(' / 라벨 생산완료'))),true)
  from public.label_production_completions c
  where c.production_id=p.id and p.deleted_at is null
    and p.raw->>'note'=c.baseline->>'note'
    and right(p.raw->>'note',length(' / 라벨 생산완료'))=' / 라벨 생산완료'
  returning p.id
)
insert into public.change_logs(entity,action,entity_id,summary,payload)
select '생산일보','비고 자동문구 제거',id,'라벨 생산일보 비고의 자동 추가 문구 제거',
  jsonb_build_object('source','20260929090000_label_completion_note') from changed;

notify pgrst,'reload schema';
