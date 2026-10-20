-- Store the exact outgoing body without changing any historical delivery records.
alter table public.document_request_logs add column if not exists content_snapshot jsonb;
do $check$
begin
  if not exists(select 1 from pg_constraint where conrelid='public.document_request_logs'::regclass and conname='document_request_content_object') then
    alter table public.document_request_logs add constraint document_request_content_object
      check(content_snapshot is null or jsonb_typeof(content_snapshot)='object');
  end if;
end;
$check$;
comment on column public.document_request_logs.content_snapshot is '발송 시점의 메일 본문 또는 팩스 요청서 원본과 발신정보. 기존 이력은 원본 미보관.';

create or replace function public.dbmt_erp_get_document_request_log_detail(p_token text,p_id bigint)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v_log jsonb;
begin
  perform public.dbmt_erp_authorize_legacy(p_token,'document_check','view');
  select to_jsonb(l) into v_log from public.document_request_logs l where l.id=p_id;
  if v_log is null then return jsonb_build_object('ok',false,'message','발송 이력을 찾을 수 없습니다.');end if;
  return jsonb_build_object('ok',true,'log',v_log);
end;
$fn$;
revoke all on function public.dbmt_erp_get_document_request_log_detail(text,bigint) from public;
grant execute on function public.dbmt_erp_get_document_request_log_detail(text,bigint) to anon,authenticated;
notify pgrst,'reload schema';
