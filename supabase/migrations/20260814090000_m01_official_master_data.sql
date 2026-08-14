-- M01 verified official company/site data.
-- Sources confirmed by the operator:
--  * business registration certificate issued 2026-08-06
--  * meat packaging business license issued 2025-12-29
--  * HACCP certificate issued 2026-02-04

do $dbmt$
declare
  v_company_id uuid;
  v_site_id uuid;
begin
  if exists (select 1 from public.companies) then
    raise exception 'M01 official master data requires an empty companies table';
  end if;

  insert into public.companies (
    code, legal_name, display_name, representative_name,
    corporate_registration_no, seal_asset_key,
    is_primary, active
  ) values (
    'dongbumt', '주식회사 동부엠티', '동부엠티', '이창성',
    '1201110960816', 'assets/company-seal.png',
    true, true
  )
  returning id into v_company_id;

  insert into public.business_sites (
    company_id, code, name, site_type, ownership_type,
    inventory_location, business_registration_no,
    road_address, detail_address, business_type, business_items,
    email, phone, fax, livestock_business_license_no,
    is_head_office, is_default_document_site, active
  ) values (
    v_company_id, 'processing_plant', '가공장', 'factory', 'owned',
    true, '4958801108',
    '인천광역시 검단구 소담2로 36', '2동 201호 (금곡동)',
    '도매 및 소매업, 제조업',
    '축산물유통전문, 식육포장처리업, 축산물무역업',
    'dongbumt1812@hanmail.net', '032-766-1812', '032-232-1812', '제2025-0293093호',
    true, true, true
  )
  returning id into v_site_id;

  insert into public.business_site_identifiers (
    business_site_id, provider, identifier_type, identifier_value,
    valid_from, valid_to, active
  ) values
    (v_site_id, 'local_government', 'meat_packaging_license', '2025-0293093', '2025-12-29', null, true),
    (v_site_id, 'haccp', 'certificate_no', '2026-3-0071', '2026-02-04', '2029-02-03', true);

  insert into public.document_sender_profiles (
    code, label, business_site_id, reply_email, reply_fax,
    seal_asset_key, secret_alias, is_default, active
  ) values
    (
      'dongbumt', '주식회사 동부엠티', v_site_id,
      'dongbumt1812@hanmail.net', '032-232-1812',
      'assets/company-seal.png', 'dongbumt', true, true
    ),
    (
      'dongbu_distribution', '(주)동부축산유통', v_site_id,
      null, '032-578-0108',
      'assets/company-seal-trading.png', 'dongbu_distribution', false, true
    );

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values (
    'company_master', 'verified_seed', v_company_id::text,
    '단일 법인·가공장·허가·HACCP·발신 프로필 기준정보 등록',
    jsonb_build_object(
      'source', 'operator_verified_documents',
      'authMode', 'deployment_migration',
      'companyCode', 'dongbumt',
      'siteCode', 'processing_plant'
    )
  );
end;
$dbmt$;

notify pgrst, 'reload schema';
