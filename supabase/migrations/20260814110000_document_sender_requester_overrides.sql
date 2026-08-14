-- Keep one ERP legal company while allowing a fax sender profile to print a
-- distinct legacy requester identity on cold-storage request documents.
alter table public.document_sender_profiles
  add column if not exists document_name text,
  add column if not exists document_representative_name text,
  add column if not exists document_registration_no text,
  add column if not exists document_address text,
  add column if not exists document_phone text;

alter table public.document_sender_profiles
  drop constraint if exists document_sender_profiles_document_name_valid,
  drop constraint if exists document_sender_profiles_document_representative_valid,
  drop constraint if exists document_sender_profiles_document_registration_valid,
  drop constraint if exists document_sender_profiles_document_address_valid,
  drop constraint if exists document_sender_profiles_document_phone_valid,
  add constraint document_sender_profiles_document_name_valid check (
    document_name is null
    or (document_name = btrim(document_name) and char_length(document_name) between 1 and 200)
  ),
  add constraint document_sender_profiles_document_representative_valid check (
    document_representative_name is null
    or (document_representative_name = btrim(document_representative_name) and char_length(document_representative_name) between 1 and 100)
  ),
  add constraint document_sender_profiles_document_registration_valid check (
    document_registration_no is null or document_registration_no ~ '^[0-9]{10}$'
  ),
  add constraint document_sender_profiles_document_address_valid check (
    document_address is null
    or (document_address = btrim(document_address) and char_length(document_address) between 1 and 500)
  ),
  add constraint document_sender_profiles_document_phone_valid check (
    document_phone is null
    or (document_phone = btrim(document_phone) and char_length(document_phone) between 3 and 40 and document_phone !~ '[[:cntrl:]]')
  );

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
  set document_name = '(주)동부축산유통',
      document_representative_name = '이동대',
      document_registration_no = '1378138748',
      document_address = '인천광역시 서구 가좌로96번길 11',
      document_phone = '032-579-3920',
      revision = revision + 1,
      updated_at = now()
  where id = v_before.id
  returning * into v_after;

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values (
    'document_sender_profile', 'update', v_after.id::text,
    '(주)동부축산유통 문서 요청자 정보 복원',
    jsonb_build_object(
      'before', to_jsonb(v_before),
      'after', to_jsonb(v_after),
      'source', 'legacy_cold_storage_request_profile',
      'authMode', 'deployment_migration'
    )
  );
end;
$dbmt$;

notify pgrst, 'reload schema';
