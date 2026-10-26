-- Read-only per-document delivery summary across the complete saved history.
-- Existing delivery logs, bodies and document receipt checks remain untouched.
create or replace function public.dbmt_erp_get_document_request_delivery(p_token text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
begin
  perform public.dbmt_erp_authorize_legacy(p_token,'document_check','view');
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
$fn$;
revoke all on function public.dbmt_erp_get_document_request_delivery(text) from public;
grant execute on function public.dbmt_erp_get_document_request_delivery(text) to anon,authenticated;
notify pgrst,'reload schema';
