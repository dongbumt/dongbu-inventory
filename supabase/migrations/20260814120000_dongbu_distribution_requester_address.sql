-- Operator-confirmed document address for the legacy Dongbu Distribution
-- requester profile. This changes future documents only; saved snapshots stay
-- immutable.
do $dbmt$
declare
  v_before public.document_sender_profiles%rowtype;
  v_after public.document_sender_profiles%rowtype;
begin
  select * into strict v_before
  from public.document_sender_profiles
  where code = 'dongbu_distribution'
  for update;

  update public.document_sender_profiles
  set document_address = '인천광역시 서해구 가좌로96번길 11',
      revision = revision + 1,
      updated_at = now()
  where id = v_before.id
  returning * into v_after;

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values (
    'document_sender_profile', 'update', v_after.id::text,
    '(주)동부축산유통 문서 요청자 주소 변경',
    jsonb_build_object(
      'before', to_jsonb(v_before),
      'after', to_jsonb(v_after),
      'source', 'operator_confirmed_address',
      'authMode', 'deployment_migration'
    )
  );
end;
$dbmt$;

notify pgrst, 'reload schema';
