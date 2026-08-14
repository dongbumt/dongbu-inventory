-- Register the verified Dongbum MT logo asset in the single-company master.
do $dbmt$
declare
  v_before public.companies%rowtype;
  v_after public.companies%rowtype;
begin
  select * into strict v_before
  from public.companies
  where code = 'dongbumt'
  for update;

  update public.companies
  set logo_asset_key = 'assets/company-logo.png',
      revision = revision + 1,
      updated_at = now()
  where id = v_before.id
  returning * into v_after;

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values (
    'company', 'update', v_after.id::text, '동부엠티 공식 로고 자산 등록',
    jsonb_build_object(
      'before', to_jsonb(v_before),
      'after', to_jsonb(v_after),
      'source', 'operator_provided_ai',
      'authMode', 'deployment_migration'
    )
  );
end;
$dbmt$;
