-- Checklist reads must not contend on erp_user_sessions.last_used_at.
-- Permission/session expiry checks remain enforced; no document data is changed.
create or replace function public.dbmt_erp_get_doc_checks(p_token text)
returns jsonb language plpgsql stable security definer set search_path='' as $fn$
declare v_checks jsonb;
begin
  if public.dbmt_erp_has_permission(p_token,'document_check','view') is not true then
    raise exception '서류체크 조회 권한 또는 로그인 상태를 확인해주세요.';
  end if;
  select payload into v_checks from public.app_data where key='docChecks';
  v_checks:=coalesce(v_checks,'{}'::jsonb);
  if jsonb_typeof(v_checks)<>'object' then raise exception '서류 수령 상태의 저장 형식을 확인해주세요.';end if;
  return jsonb_build_object('docChecks',v_checks);
end;
$fn$;

CREATE OR REPLACE FUNCTION public.dbmt_erp_get_document_request_delivery(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if public.dbmt_erp_has_permission(p_token,'document_check','view') is not true then
    raise exception '서류체크 조회 권한 또는 로그인 상태를 확인해주세요.';
  end if;
  return coalesce((
    with documents as (
      select l.id,l.created_at,l.channel,l.status,l.provider_status,
        jsonb_build_object(
          'lot',upper(regexp_replace(btrim(coalesce(d->>'lot','')),'[\s‐‑‒–—―-]','','g')),
          'product',btrim(coalesce(d->>'product','')),
          'origin',btrim(coalesce(d->>'origin','')),
          'date',replace(btrim(coalesce(d->>'date','')),'/','-'),
          'trader',btrim(l.trader)) as identity
      from public.document_request_logs l
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(l.documents)='array' then l.documents else '[]'::jsonb end
      ) d
      where jsonb_typeof(d)='object' and l.channel in ('email','fax')
        and (btrim(coalesce(d->>'lot',''))<>'' or btrim(coalesce(d->>'product',''))<>'')
    ), keyed as (
      select *,case when identity->>'lot'<>''
        then jsonb_build_array('lot',identity->>'lot')
        else jsonb_build_array('row',identity->>'date',identity->>'product',identity->>'origin',identity->>'trader')
        end as document_key from documents
    ), latest as (
      select distinct on (document_key,channel) * from keyed
        order by document_key,channel,created_at desc,id desc
    ), success as (
      select distinct on (document_key,channel) * from keyed where status in ('sent','accepted')
        order by document_key,channel,created_at desc,id desc
    )
    select jsonb_agg(jsonb_build_object(
      'identity',a.identity,'channel',a.channel,
      'latest',jsonb_build_object('id',a.id::text,'created_at',a.created_at,'status',a.status,'provider_status',a.provider_status),
      'success',case when s.id is null then null else jsonb_build_object('id',s.id::text,'created_at',s.created_at,'status',s.status,'provider_status',s.provider_status) end
    ) order by a.document_key,a.channel)
    from latest a left join success s on s.document_key=a.document_key and s.channel=a.channel
  ),'[]'::jsonb);
end;
$function$
;

create or replace function public.dbmt_erp_get_document_request_logs(p_token text,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path='' as $fn$
begin
  if public.dbmt_erp_has_permission(p_token,'document_check','view') is not true then
    raise exception '서류체크 조회 권한 또는 로그인 상태를 확인해주세요.';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(rows)) from (
      select id,created_at,channel,trader,recipient,recipient_name,
        subject,document_count,documents,status,provider,provider_message_id,provider_status,error_message
      from public.document_request_logs order by created_at desc,id desc
      limit least(greatest(coalesce(p_limit,100),1),500)
    ) rows
  ),'[]'::jsonb);
end;
$fn$;

create or replace function public.dbmt_erp_get_document_request_log_detail(p_token text,p_id bigint)
returns jsonb language plpgsql stable security definer set search_path='' as $fn$
declare v_log jsonb;
begin
  if public.dbmt_erp_has_permission(p_token,'document_check','view') is not true then
    raise exception '서류체크 조회 권한 또는 로그인 상태를 확인해주세요.';
  end if;
  select to_jsonb(l) into v_log from public.document_request_logs l where l.id=p_id;
  if v_log is null then return jsonb_build_object('ok',false,'message','발송 이력을 찾을 수 없습니다.');end if;
  return jsonb_build_object('ok',true,'log',v_log);
end;
$fn$;

revoke all on function public.dbmt_erp_get_doc_checks(text) from public;
revoke all on function public.dbmt_erp_get_document_request_delivery(text) from public;
revoke all on function public.dbmt_erp_get_document_request_logs(text,integer) from public;
revoke all on function public.dbmt_erp_get_document_request_log_detail(text,bigint) from public;
grant execute on function public.dbmt_erp_get_doc_checks(text),
  public.dbmt_erp_get_document_request_delivery(text),
  public.dbmt_erp_get_document_request_logs(text,integer),
  public.dbmt_erp_get_document_request_log_detail(text,bigint) to anon,authenticated;
notify pgrst,'reload schema';
