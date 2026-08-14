-- M01 single-company, business-site, warehouse and document-sender master data.
--
-- The browser never accesses these tables directly. It uses password-gated,
-- revision-checked RPC functions until per-user authorization is introduced.
-- The companies table is intentionally a singleton. A business site can be a
-- registered place of business or an inventory location such as an owned,
-- leased, or third-party cold-storage warehouse.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.companies (
  id uuid primary key default extensions.gen_random_uuid(),
  singleton_guard boolean not null default true,
  code text not null,
  legal_name text not null,
  display_name text not null,
  english_name text,
  representative_name text not null,
  corporate_registration_no text,
  seal_asset_key text,
  logo_asset_key text,
  is_primary boolean not null default true,
  active boolean not null default true,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint companies_code_format check (
    code = lower(btrim(code))
    and code ~ '^[a-z][a-z0-9_-]{1,49}$'
  ),
  constraint companies_legal_name_valid check (
    legal_name = btrim(legal_name)
    and char_length(legal_name) between 1 and 200
  ),
  constraint companies_display_name_valid check (
    display_name = btrim(display_name)
    and char_length(display_name) between 1 and 200
  ),
  constraint companies_english_name_valid check (
    english_name is null
    or (english_name = btrim(english_name) and char_length(english_name) between 1 and 200)
  ),
  constraint companies_representative_name_valid check (
    representative_name = btrim(representative_name)
    and char_length(representative_name) between 1 and 100
  ),
  constraint companies_corporate_registration_no_valid check (
    corporate_registration_no is null
    or corporate_registration_no ~ '^[0-9]{13}$'
  ),
  constraint companies_seal_asset_key_valid check (
    seal_asset_key is null
    or (
      char_length(seal_asset_key) between 1 and 200
      and seal_asset_key ~ '^[A-Za-z0-9][A-Za-z0-9_./-]*$'
      and seal_asset_key !~ '(^/|[.][.]|//)'
    )
  ),
  constraint companies_logo_asset_key_valid check (
    logo_asset_key is null
    or (
      char_length(logo_asset_key) between 1 and 200
      and logo_asset_key ~ '^[A-Za-z0-9][A-Za-z0-9_./-]*$'
      and logo_asset_key !~ '(^/|[.][.]|//)'
    )
  ),
  constraint companies_singleton_guard_true check (singleton_guard),
  constraint companies_singleton_is_primary check (is_primary),
  constraint companies_primary_must_be_active check (not is_primary or active),
  constraint companies_revision_positive check (revision > 0)
);

create unique index if not exists idx_companies_code
  on public.companies(lower(code));
create unique index if not exists idx_companies_singleton
  on public.companies(singleton_guard);
create index if not exists idx_companies_active
  on public.companies(active, code);

create table if not exists public.business_sites (
  id uuid primary key default extensions.gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  code text not null,
  name text not null,
  site_type text not null default 'office',
  ownership_type text not null default 'owned',
  inventory_location boolean not null default false,
  operator_trader_key text,
  operator_name text,
  business_registration_no text,
  postal_code text,
  road_address text not null,
  detail_address text,
  english_address text,
  business_type text,
  business_items text,
  email text,
  phone text,
  fax text,
  mobile text,
  livestock_business_license_no text,
  is_head_office boolean not null default false,
  is_default_document_site boolean not null default false,
  active boolean not null default true,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_sites_code_format check (
    code = lower(btrim(code))
    and code ~ '^[a-z][a-z0-9_-]{1,49}$'
  ),
  constraint business_sites_name_valid check (
    name = btrim(name) and char_length(name) between 1 and 200
  ),
  constraint business_sites_type_valid check (
    site_type in ('head_office', 'office', 'factory', 'warehouse', 'external_warehouse', 'other')
  ),
  constraint business_sites_ownership_type_valid check (
    ownership_type in ('owned', 'leased', 'third_party')
  ),
  constraint business_sites_external_warehouse_owner_valid check (
    site_type <> 'external_warehouse' or ownership_type = 'third_party'
  ),
  constraint business_sites_warehouse_is_inventory_location check (
    site_type not in ('warehouse', 'external_warehouse') or inventory_location
  ),
  constraint business_sites_operator_trader_key_valid check (
    operator_trader_key is null
    or (
      operator_trader_key = btrim(operator_trader_key)
      and char_length(operator_trader_key) between 1 and 200
      and operator_trader_key !~ '[[:cntrl:]]'
    )
  ),
  constraint business_sites_operator_name_valid check (
    operator_name is null
    or (operator_name = btrim(operator_name) and char_length(operator_name) between 1 and 200)
  ),
  constraint business_sites_registration_no_valid check (
    business_registration_no is null or business_registration_no ~ '^[0-9]{10}$'
  ),
  constraint business_sites_head_office_registration_required check (
    not is_head_office or business_registration_no is not null
  ),
  constraint business_sites_head_office_type_valid check (
    site_type <> 'head_office' or is_head_office
  ),
  constraint business_sites_head_office_is_internal check (
    not is_head_office or (site_type <> 'external_warehouse' and ownership_type <> 'third_party')
  ),
  constraint business_sites_document_default_is_internal check (
    not is_default_document_site or (
      site_type <> 'external_warehouse'
      and ownership_type <> 'third_party'
      and business_registration_no is not null
    )
  ),
  constraint business_sites_postal_code_valid check (
    postal_code is null or postal_code ~ '^[0-9]{5}$'
  ),
  constraint business_sites_road_address_valid check (
    road_address = btrim(road_address)
    and char_length(road_address) between 1 and 500
  ),
  constraint business_sites_detail_address_valid check (
    detail_address is null
    or (detail_address = btrim(detail_address) and char_length(detail_address) between 1 and 300)
  ),
  constraint business_sites_english_address_valid check (
    english_address is null
    or (english_address = btrim(english_address) and char_length(english_address) between 1 and 500)
  ),
  constraint business_sites_business_type_valid check (
    business_type is null
    or (business_type = btrim(business_type) and char_length(business_type) between 1 and 200)
  ),
  constraint business_sites_business_items_valid check (
    business_items is null
    or (business_items = btrim(business_items) and char_length(business_items) between 1 and 300)
  ),
  constraint business_sites_email_valid check (
    email is null
    or (
      email = btrim(email)
      and char_length(email) between 3 and 254
      and email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    )
  ),
  constraint business_sites_phone_valid check (
    phone is null
    or (phone = btrim(phone) and char_length(phone) between 3 and 40 and phone !~ '[[:cntrl:]]')
  ),
  constraint business_sites_fax_valid check (
    fax is null
    or (fax = btrim(fax) and char_length(fax) between 3 and 40 and fax !~ '[[:cntrl:]]')
  ),
  constraint business_sites_mobile_valid check (
    mobile is null
    or (mobile = btrim(mobile) and char_length(mobile) between 3 and 40 and mobile !~ '[[:cntrl:]]')
  ),
  constraint business_sites_license_no_valid check (
    livestock_business_license_no is null
    or (
      livestock_business_license_no = btrim(livestock_business_license_no)
      and char_length(livestock_business_license_no) between 1 and 100
    )
  ),
  constraint business_sites_head_office_must_be_active check (not is_head_office or active),
  constraint business_sites_default_must_be_active check (not is_default_document_site or active),
  constraint business_sites_revision_positive check (revision > 0)
);

create unique index if not exists idx_business_sites_company_code
  on public.business_sites(company_id, lower(code));
create unique index if not exists idx_business_sites_registration_no
  on public.business_sites(business_registration_no)
  where business_registration_no is not null;
create unique index if not exists idx_business_sites_one_active_head_office
  on public.business_sites(company_id)
  where is_head_office and active;
create unique index if not exists idx_business_sites_one_active_document_default
  on public.business_sites(company_id)
  where is_default_document_site and active;
create index if not exists idx_business_sites_company_active
  on public.business_sites(company_id, active, code);
create index if not exists idx_business_sites_inventory_locations
  on public.business_sites(active, site_type, code)
  where inventory_location;

create table if not exists public.business_site_identifiers (
  id uuid primary key default extensions.gen_random_uuid(),
  business_site_id uuid not null references public.business_sites(id) on delete restrict,
  provider text not null,
  identifier_type text not null,
  identifier_value text not null,
  valid_from date,
  valid_to date,
  active boolean not null default true,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_site_identifiers_provider_valid check (
    provider = lower(btrim(provider))
    and provider ~ '^[a-z][a-z0-9_-]{1,49}$'
  ),
  constraint business_site_identifiers_type_valid check (
    identifier_type = lower(btrim(identifier_type))
    and identifier_type ~ '^[a-z][a-z0-9_-]{1,59}$'
    and identifier_type !~ '(secret|password|passwd|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|user[_-]?id|login[_-]?id|sys[_-]?id|system[_-]?id)'
  ),
  constraint business_site_identifiers_value_valid check (
    identifier_value = btrim(identifier_value)
    and char_length(identifier_value) between 1 and 200
    and identifier_value !~ '[[:cntrl:]]'
  ),
  constraint business_site_identifiers_date_order check (
    valid_from is null or valid_to is null or valid_to >= valid_from
  ),
  constraint business_site_identifiers_revision_positive check (revision > 0)
);

create unique index if not exists idx_business_site_identifiers_active_type
  on public.business_site_identifiers(business_site_id, provider, identifier_type)
  where active;
create unique index if not exists idx_business_site_identifiers_active_value
  on public.business_site_identifiers(provider, identifier_type, identifier_value)
  where active;
create index if not exists idx_business_site_identifiers_site
  on public.business_site_identifiers(business_site_id, active, provider, identifier_type);

create table if not exists public.document_sender_profiles (
  id uuid primary key default extensions.gen_random_uuid(),
  code text not null,
  label text not null,
  business_site_id uuid references public.business_sites(id) on delete restrict,
  reply_email text,
  reply_fax text,
  seal_asset_key text,
  secret_alias text not null,
  is_default boolean not null default false,
  active boolean not null default true,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_sender_profiles_code_format check (
    code = lower(btrim(code))
    and code ~ '^[a-z][a-z0-9_-]{1,49}$'
  ),
  constraint document_sender_profiles_label_valid check (
    label = btrim(label) and char_length(label) between 1 and 200
  ),
  constraint document_sender_profiles_reply_email_valid check (
    reply_email is null
    or (
      reply_email = btrim(reply_email)
      and char_length(reply_email) between 3 and 254
      and reply_email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    )
  ),
  constraint document_sender_profiles_reply_fax_valid check (
    reply_fax is null
    or (
      reply_fax = btrim(reply_fax)
      and char_length(reply_fax) between 3 and 40
      and reply_fax !~ '[[:cntrl:]]'
    )
  ),
  constraint document_sender_profiles_seal_asset_key_valid check (
    seal_asset_key is null
    or (
      char_length(seal_asset_key) between 1 and 200
      and seal_asset_key ~ '^[A-Za-z0-9][A-Za-z0-9_./-]*$'
      and seal_asset_key !~ '(^/|[.][.]|//)'
    )
  ),
  constraint document_sender_profiles_secret_alias_valid check (
    secret_alias = lower(btrim(secret_alias))
    and secret_alias ~ '^[a-z][a-z0-9_]{1,49}$'
  ),
  constraint document_sender_profiles_default_must_be_active check (not is_default or active),
  constraint document_sender_profiles_revision_positive check (revision > 0)
);

create unique index if not exists idx_document_sender_profiles_code
  on public.document_sender_profiles(lower(code));
create unique index if not exists idx_document_sender_profiles_one_active_default
  on public.document_sender_profiles(is_default)
  where is_default and active;
create index if not exists idx_document_sender_profiles_site_active
  on public.document_sender_profiles(business_site_id, active, code);

alter table public.companies enable row level security;
alter table public.business_sites enable row level security;
alter table public.business_site_identifiers enable row level security;
alter table public.document_sender_profiles enable row level security;

revoke all on table public.companies, public.business_sites, public.business_site_identifiers,
  public.document_sender_profiles
  from public, anon, authenticated;
revoke all on table public.companies, public.business_sites, public.business_site_identifiers,
  public.document_sender_profiles
  from service_role;
grant select on table public.companies, public.business_sites, public.business_site_identifiers,
  public.document_sender_profiles
  to service_role;

create or replace function public.dbmt_get_company_master(p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_companies jsonb;
  v_sender_profiles jsonb;
begin
  if public.dbmt_check_password(p_password) is not true then
    raise exception 'invalid app password';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', c.id,
      'code', c.code,
      'legalName', c.legal_name,
      'displayName', c.display_name,
      'englishName', c.english_name,
      'representativeName', c.representative_name,
      'corporateRegistrationNo', c.corporate_registration_no,
      'sealAssetKey', c.seal_asset_key,
      'logoAssetKey', c.logo_asset_key,
      'isPrimary', c.is_primary,
      'active', c.active,
      'revision', c.revision,
      'createdAt', c.created_at,
      'updatedAt', c.updated_at,
      'sites', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', s.id,
            'companyId', s.company_id,
            'code', s.code,
            'name', s.name,
            'siteType', s.site_type,
            'ownershipType', s.ownership_type,
            'inventoryLocation', s.inventory_location,
            'operatorTraderKey', s.operator_trader_key,
            'operatorName', s.operator_name,
            'businessRegistrationNo', s.business_registration_no,
            'postalCode', s.postal_code,
            'roadAddress', s.road_address,
            'detailAddress', s.detail_address,
            'englishAddress', s.english_address,
            'businessType', s.business_type,
            'businessItems', s.business_items,
            'email', s.email,
            'phone', s.phone,
            'fax', s.fax,
            'mobile', s.mobile,
            'livestockBusinessLicenseNo', s.livestock_business_license_no,
            'isHeadOffice', s.is_head_office,
            'isDefaultDocumentSite', s.is_default_document_site,
            'active', s.active,
            'revision', s.revision,
            'createdAt', s.created_at,
            'updatedAt', s.updated_at,
            'identifiers', coalesce((
              select jsonb_agg(
                jsonb_build_object(
                  'id', i.id,
                  'businessSiteId', i.business_site_id,
                  'provider', i.provider,
                  'identifierType', i.identifier_type,
                  'identifierValue', i.identifier_value,
                  'validFrom', i.valid_from,
                  'validTo', i.valid_to,
                  'active', i.active,
                  'revision', i.revision,
                  'createdAt', i.created_at,
                  'updatedAt', i.updated_at
                )
                order by i.active desc, i.provider, i.identifier_type, i.valid_from nulls first, i.id
              )
              from public.business_site_identifiers i
              where i.business_site_id = s.id
            ), '[]'::jsonb)
          )
          order by s.active desc, s.is_default_document_site desc,
            s.is_head_office desc, s.code, s.id
        )
        from public.business_sites s
        where s.company_id = c.id
      ), '[]'::jsonb)
    )
    order by c.active desc, c.is_primary desc, c.code, c.id
  ), '[]'::jsonb)
  into v_companies
  from public.companies c;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', p.id,
      'code', p.code,
      'label', p.label,
      'businessSiteId', p.business_site_id,
      'replyEmail', p.reply_email,
      'replyFax', p.reply_fax,
      'sealAssetKey', p.seal_asset_key,
      'secretAlias', p.secret_alias,
      'isDefault', p.is_default,
      'active', p.active,
      'revision', p.revision,
      'createdAt', p.created_at,
      'updatedAt', p.updated_at
    )
    order by p.active desc, p.is_default desc, p.code, p.id
  ), '[]'::jsonb)
  into v_sender_profiles
  from public.document_sender_profiles p;

  return jsonb_build_object(
    'schemaVersion', 2,
    'serverTime', clock_timestamp(),
    'company', case when jsonb_array_length(v_companies) = 0 then null else v_companies->0 end,
    'companies', v_companies,
    'documentSenderProfiles', v_sender_profiles
  );
end;
$dbmt$;

create or replace function public.dbmt_save_company(
  p_password text,
  p_record jsonb,
  p_expected_revision bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_id uuid;
  v_id_text text;
  v_old public.companies%rowtype;
  v_new public.companies%rowtype;
  v_code text;
  v_legal_name text;
  v_display_name text;
  v_english_name text;
  v_representative_name text;
  v_corporate_raw text;
  v_corporate_registration_no text;
  v_seal_asset_key text;
  v_logo_asset_key text;
  v_is_primary boolean;
  v_active boolean;
  v_unknown_fields text;
  v_row_count integer;
  v_action text;
  v_record jsonb;
begin
  if public.dbmt_check_password(p_password) is not true then
    raise exception 'invalid app password';
  end if;
  if p_record is null or jsonb_typeof(p_record) <> 'object' then
    raise exception 'company record must be a JSON object';
  end if;

  select string_agg(f.key, ', ' order by f.key)
  into v_unknown_fields
  from jsonb_object_keys(p_record) as f(key)
  where not (f.key = any (array[
    'id', 'code', 'legalName', 'displayName', 'englishName',
    'representativeName', 'corporateRegistrationNo', 'sealAssetKey',
    'logoAssetKey', 'isPrimary', 'active'
  ]::text[]));
  if v_unknown_fields is not null then
    raise exception 'unsupported company fields: %', v_unknown_fields;
  end if;

  v_id_text := nullif(btrim(coalesce(p_record->>'id', '')), '');
  if v_id_text is not null and v_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'company id is invalid';
  end if;
  v_id := v_id_text::uuid;

  if v_id is null then
    if p_expected_revision is not null then
      raise exception 'expected revision must be null for a new company';
    end if;
    if exists (select 1 from public.companies) then
      raise exception 'this ERP supports exactly one company; update the existing company';
    end if;
  else
    if p_expected_revision is null or p_expected_revision < 1 then
      raise exception 'expected revision is required when updating a company';
    end if;
    select * into v_old
    from public.companies
    where id = v_id
    for update;
    if v_old.id is null then
      raise exception 'company not found';
    end if;
    if v_old.revision <> p_expected_revision then
      raise exception 'company was changed by another session; reload and try again';
    end if;
  end if;

  if p_record ? 'isPrimary' and jsonb_typeof(p_record->'isPrimary') <> 'boolean' then
    raise exception 'isPrimary must be a boolean';
  end if;
  if p_record ? 'active' and jsonb_typeof(p_record->'active') <> 'boolean' then
    raise exception 'active must be a boolean';
  end if;
  if p_record ? 'isPrimary' and (p_record->>'isPrimary')::boolean is not true then
    raise exception 'the single ERP company must be primary';
  end if;
  if p_record ? 'active' and (p_record->>'active')::boolean is not true then
    raise exception 'the single ERP company cannot be deactivated';
  end if;

  v_code := case when p_record ? 'code'
    then lower(btrim(coalesce(p_record->>'code', ''))) else v_old.code end;
  v_legal_name := case when p_record ? 'legalName'
    then btrim(coalesce(p_record->>'legalName', '')) else v_old.legal_name end;
  v_display_name := case when p_record ? 'displayName'
    then btrim(coalesce(p_record->>'displayName', '')) else v_old.display_name end;
  v_english_name := case when p_record ? 'englishName'
    then nullif(btrim(coalesce(p_record->>'englishName', '')), '') else v_old.english_name end;
  v_representative_name := case when p_record ? 'representativeName'
    then btrim(coalesce(p_record->>'representativeName', '')) else v_old.representative_name end;
  v_corporate_raw := case when p_record ? 'corporateRegistrationNo'
    then nullif(btrim(coalesce(p_record->>'corporateRegistrationNo', '')), '')
    else v_old.corporate_registration_no end;
  v_seal_asset_key := case when p_record ? 'sealAssetKey'
    then nullif(btrim(coalesce(p_record->>'sealAssetKey', '')), '') else v_old.seal_asset_key end;
  v_logo_asset_key := case when p_record ? 'logoAssetKey'
    then nullif(btrim(coalesce(p_record->>'logoAssetKey', '')), '') else v_old.logo_asset_key end;
  v_is_primary := true;
  v_active := true;

  if v_old.id is not null and v_code <> v_old.code then
    raise exception 'the company code cannot be changed';
  end if;
  if v_code is null or v_code !~ '^[a-z][a-z0-9_-]{1,49}$' then
    raise exception 'company code must be 2-50 lowercase letters, numbers, dash or underscore';
  end if;
  if v_legal_name is null or char_length(v_legal_name) not between 1 and 200 then
    raise exception 'legalName is required and must be at most 200 characters';
  end if;
  if v_display_name is null or char_length(v_display_name) not between 1 and 200 then
    raise exception 'displayName is required and must be at most 200 characters';
  end if;
  if v_representative_name is null or char_length(v_representative_name) not between 1 and 100 then
    raise exception 'representativeName is required and must be at most 100 characters';
  end if;
  if v_english_name is not null and char_length(v_english_name) > 200 then
    raise exception 'englishName must be at most 200 characters';
  end if;

  if v_corporate_raw is not null then
    if v_corporate_raw !~ '^[0-9[:space:]-]+$' then
      raise exception 'corporateRegistrationNo may contain only digits, spaces and dash';
    end if;
    v_corporate_registration_no := regexp_replace(v_corporate_raw, '[^0-9]', '', 'g');
    if v_corporate_registration_no !~ '^[0-9]{13}$' then
      raise exception 'corporateRegistrationNo must contain 13 digits';
    end if;
  end if;

  if v_seal_asset_key is not null and (
    char_length(v_seal_asset_key) > 200
    or v_seal_asset_key !~ '^[A-Za-z0-9][A-Za-z0-9_./-]*$'
    or v_seal_asset_key ~ '(^/|[.][.]|//)'
  ) then
    raise exception 'sealAssetKey must be a safe relative asset path';
  end if;
  if v_logo_asset_key is not null and (
    char_length(v_logo_asset_key) > 200
    or v_logo_asset_key !~ '^[A-Za-z0-9][A-Za-z0-9_./-]*$'
    or v_logo_asset_key ~ '(^/|[.][.]|//)'
  ) then
    raise exception 'logoAssetKey must be a safe relative asset path';
  end if;
  if exists (
    select 1 from public.companies c
    where lower(c.code) = v_code and (v_id is null or c.id <> v_id)
  ) then
    raise exception 'company code already exists';
  end if;
  if exists (
    select 1 from public.companies c
    where v_id is null or c.id <> v_id
  ) then
    raise exception 'this ERP supports exactly one company';
  end if;

  if v_id is null then
    insert into public.companies (
      code, legal_name, display_name, english_name, representative_name,
      corporate_registration_no, seal_asset_key, logo_asset_key,
      is_primary, active
    ) values (
      v_code, v_legal_name, v_display_name, v_english_name, v_representative_name,
      v_corporate_registration_no, v_seal_asset_key, v_logo_asset_key,
      v_is_primary, v_active
    ) returning * into v_new;
    v_action := 'insert';
  else
    update public.companies set
      code = v_code,
      legal_name = v_legal_name,
      display_name = v_display_name,
      english_name = v_english_name,
      representative_name = v_representative_name,
      corporate_registration_no = v_corporate_registration_no,
      seal_asset_key = v_seal_asset_key,
      logo_asset_key = v_logo_asset_key,
      is_primary = v_is_primary,
      active = v_active,
      revision = revision + 1,
      updated_at = now()
    where id = v_id and revision = p_expected_revision
    returning * into v_new;
    get diagnostics v_row_count = row_count;
    if v_row_count <> 1 then
      raise exception 'company was changed by another session; reload and try again';
    end if;
    v_action := 'update';
  end if;

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values (
    'company', v_action, v_new.id::text, v_new.legal_name,
    jsonb_build_object(
      'before', case when v_old.id is null then null else to_jsonb(v_old) end,
      'after', to_jsonb(v_new),
      'authMode', 'legacy_app_password'
    )
  );

  v_record := jsonb_build_object(
    'id', v_new.id,
    'code', v_new.code,
    'legalName', v_new.legal_name,
    'displayName', v_new.display_name,
    'englishName', v_new.english_name,
    'representativeName', v_new.representative_name,
    'corporateRegistrationNo', v_new.corporate_registration_no,
    'sealAssetKey', v_new.seal_asset_key,
    'logoAssetKey', v_new.logo_asset_key,
    'isPrimary', v_new.is_primary,
    'active', v_new.active,
    'revision', v_new.revision,
    'createdAt', v_new.created_at,
    'updatedAt', v_new.updated_at
  );
  return jsonb_build_object(
    'ok', true,
    'id', v_new.id,
    'revision', v_new.revision,
    'record', v_record
  );
end;
$dbmt$;

create or replace function public.dbmt_save_business_site(
  p_password text,
  p_record jsonb,
  p_expected_revision bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_id uuid;
  v_id_text text;
  v_company_id uuid;
  v_company_id_text text;
  v_company_active boolean;
  v_old public.business_sites%rowtype;
  v_new public.business_sites%rowtype;
  v_code text;
  v_name text;
  v_site_type text;
  v_ownership_type text;
  v_inventory_location boolean;
  v_operator_trader_key text;
  v_operator_name text;
  v_registration_raw text;
  v_business_registration_no text;
  v_postal_code text;
  v_road_address text;
  v_detail_address text;
  v_english_address text;
  v_business_type text;
  v_business_items text;
  v_email text;
  v_phone text;
  v_fax text;
  v_mobile text;
  v_license_no text;
  v_is_head_office boolean;
  v_is_default_document_site boolean;
  v_active boolean;
  v_unknown_fields text;
  v_row_count integer;
  v_action text;
  v_record jsonb;
begin
  if public.dbmt_check_password(p_password) is not true then
    raise exception 'invalid app password';
  end if;
  if p_record is null or jsonb_typeof(p_record) <> 'object' then
    raise exception 'business-site record must be a JSON object';
  end if;

  select string_agg(f.key, ', ' order by f.key)
  into v_unknown_fields
  from jsonb_object_keys(p_record) as f(key)
  where not (f.key = any (array[
    'id', 'companyId', 'code', 'name', 'siteType', 'ownershipType',
    'inventoryLocation', 'operatorTraderKey', 'operatorName', 'businessRegistrationNo',
    'postalCode', 'roadAddress', 'detailAddress', 'englishAddress',
    'businessType', 'businessItems', 'email', 'phone', 'fax', 'mobile',
    'livestockBusinessLicenseNo', 'isHeadOffice', 'isDefaultDocumentSite', 'active'
  ]::text[]));
  if v_unknown_fields is not null then
    raise exception 'unsupported business-site fields: %', v_unknown_fields;
  end if;

  v_id_text := nullif(btrim(coalesce(p_record->>'id', '')), '');
  if v_id_text is not null and v_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'business-site id is invalid';
  end if;
  v_id := v_id_text::uuid;

  if v_id is null then
    if p_expected_revision is not null then
      raise exception 'expected revision must be null for a new business site';
    end if;
  else
    if p_expected_revision is null or p_expected_revision < 1 then
      raise exception 'expected revision is required when updating a business site';
    end if;
    select * into v_old
    from public.business_sites
    where id = v_id
    for update;
    if v_old.id is null then
      raise exception 'business site not found';
    end if;
    if v_old.revision <> p_expected_revision then
      raise exception 'business site was changed by another session; reload and try again';
    end if;
  end if;

  if p_record ? 'isHeadOffice' and jsonb_typeof(p_record->'isHeadOffice') <> 'boolean' then
    raise exception 'isHeadOffice must be a boolean';
  end if;
  if p_record ? 'isDefaultDocumentSite' and jsonb_typeof(p_record->'isDefaultDocumentSite') <> 'boolean' then
    raise exception 'isDefaultDocumentSite must be a boolean';
  end if;
  if p_record ? 'inventoryLocation' and jsonb_typeof(p_record->'inventoryLocation') <> 'boolean' then
    raise exception 'inventoryLocation must be a boolean';
  end if;
  if p_record ? 'active' and jsonb_typeof(p_record->'active') <> 'boolean' then
    raise exception 'active must be a boolean';
  end if;

  v_company_id_text := case when p_record ? 'companyId'
    then nullif(btrim(coalesce(p_record->>'companyId', '')), '')
    else v_old.company_id::text end;
  if v_company_id_text is null then
    select c.id::text into v_company_id_text
    from public.companies c
    limit 1;
  end if;
  if v_company_id_text is null or v_company_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'companyId is required and must be a valid UUID';
  end if;
  v_company_id := v_company_id_text::uuid;
  if v_old.id is not null and v_company_id <> v_old.company_id then
    raise exception 'the single-company link of a business site cannot be changed';
  end if;

  v_code := case when p_record ? 'code'
    then lower(btrim(coalesce(p_record->>'code', ''))) else v_old.code end;
  v_name := case when p_record ? 'name'
    then btrim(coalesce(p_record->>'name', '')) else v_old.name end;
  v_site_type := case when p_record ? 'siteType'
    then lower(btrim(coalesce(p_record->>'siteType', ''))) else coalesce(v_old.site_type, 'office') end;
  v_ownership_type := case when p_record ? 'ownershipType'
    then lower(btrim(coalesce(p_record->>'ownershipType', '')))
    else coalesce(v_old.ownership_type,
      case when v_site_type = 'external_warehouse' then 'third_party' else 'owned' end)
    end;
  v_inventory_location := case when p_record ? 'inventoryLocation'
    then (p_record->>'inventoryLocation')::boolean
    else coalesce(v_old.inventory_location, v_site_type in ('warehouse', 'external_warehouse')) end;
  v_operator_trader_key := case when p_record ? 'operatorTraderKey'
    then nullif(btrim(coalesce(p_record->>'operatorTraderKey', '')), '')
    else v_old.operator_trader_key end;
  v_operator_name := case when p_record ? 'operatorName'
    then nullif(btrim(coalesce(p_record->>'operatorName', '')), '')
    else v_old.operator_name end;
  v_registration_raw := case when p_record ? 'businessRegistrationNo'
    then nullif(btrim(coalesce(p_record->>'businessRegistrationNo', '')), '')
    else v_old.business_registration_no end;
  v_postal_code := case when p_record ? 'postalCode'
    then nullif(replace(btrim(coalesce(p_record->>'postalCode', '')), '-', ''), '') else v_old.postal_code end;
  v_road_address := case when p_record ? 'roadAddress'
    then btrim(coalesce(p_record->>'roadAddress', '')) else v_old.road_address end;
  v_detail_address := case when p_record ? 'detailAddress'
    then nullif(btrim(coalesce(p_record->>'detailAddress', '')), '') else v_old.detail_address end;
  v_english_address := case when p_record ? 'englishAddress'
    then nullif(btrim(coalesce(p_record->>'englishAddress', '')), '') else v_old.english_address end;
  v_business_type := case when p_record ? 'businessType'
    then nullif(btrim(coalesce(p_record->>'businessType', '')), '') else v_old.business_type end;
  v_business_items := case when p_record ? 'businessItems'
    then nullif(btrim(coalesce(p_record->>'businessItems', '')), '') else v_old.business_items end;
  v_email := case when p_record ? 'email'
    then nullif(lower(btrim(coalesce(p_record->>'email', ''))), '') else v_old.email end;
  v_phone := case when p_record ? 'phone'
    then nullif(btrim(coalesce(p_record->>'phone', '')), '') else v_old.phone end;
  v_fax := case when p_record ? 'fax'
    then nullif(btrim(coalesce(p_record->>'fax', '')), '') else v_old.fax end;
  v_mobile := case when p_record ? 'mobile'
    then nullif(btrim(coalesce(p_record->>'mobile', '')), '') else v_old.mobile end;
  v_license_no := case when p_record ? 'livestockBusinessLicenseNo'
    then nullif(btrim(coalesce(p_record->>'livestockBusinessLicenseNo', '')), '')
    else v_old.livestock_business_license_no end;
  v_is_head_office := case when p_record ? 'isHeadOffice'
    then (p_record->>'isHeadOffice')::boolean else coalesce(v_old.is_head_office, false) end;
  v_is_default_document_site := case when p_record ? 'isDefaultDocumentSite'
    then (p_record->>'isDefaultDocumentSite')::boolean
    else coalesce(v_old.is_default_document_site, false) end;
  v_active := case when p_record ? 'active'
    then (p_record->>'active')::boolean else coalesce(v_old.active, true) end;

  if v_old.id is not null and v_code <> v_old.code then
    raise exception 'a business-site code cannot be changed; create another business site';
  end if;
  if v_code is null or v_code !~ '^[a-z][a-z0-9_-]{1,49}$' then
    raise exception 'business-site code must be 2-50 lowercase letters, numbers, dash or underscore';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 200 then
    raise exception 'business-site name is required and must be at most 200 characters';
  end if;
  if v_site_type not in ('head_office', 'office', 'factory', 'warehouse', 'external_warehouse', 'other') then
    raise exception 'siteType is invalid';
  end if;
  if v_ownership_type not in ('owned', 'leased', 'third_party') then
    raise exception 'ownershipType is invalid';
  end if;
  if v_site_type = 'external_warehouse' and v_ownership_type <> 'third_party' then
    raise exception 'an external warehouse must use third_party ownershipType';
  end if;
  if v_site_type in ('warehouse', 'external_warehouse') and not v_inventory_location then
    raise exception 'a warehouse must be an inventory location';
  end if;
  if v_operator_trader_key is not null and (
    char_length(v_operator_trader_key) > 200 or v_operator_trader_key ~ '[[:cntrl:]]'
  ) then
    raise exception 'operatorTraderKey must be at most 200 printable characters';
  end if;
  if v_operator_name is not null and char_length(v_operator_name) > 200 then
    raise exception 'operatorName must be at most 200 characters';
  end if;
  if v_registration_raw is not null then
    if v_registration_raw !~ '^[0-9[:space:]-]+$' then
      raise exception 'businessRegistrationNo may contain only digits, spaces and dash';
    end if;
    v_business_registration_no := regexp_replace(v_registration_raw, '[^0-9]', '', 'g');
    if v_business_registration_no !~ '^[0-9]{10}$' then
      raise exception 'businessRegistrationNo must contain 10 digits';
    end if;
  end if;
  if v_is_head_office and v_business_registration_no is null then
    raise exception 'the head office requires businessRegistrationNo';
  end if;
  if v_site_type = 'head_office' and not v_is_head_office then
    raise exception 'a head_office siteType must be marked as the head office';
  end if;
  if v_is_head_office and (v_site_type = 'external_warehouse' or v_ownership_type = 'third_party') then
    raise exception 'the head office must be an internal business site';
  end if;
  if v_is_default_document_site and (
    v_site_type = 'external_warehouse'
    or v_ownership_type = 'third_party'
    or v_business_registration_no is null
  ) then
    raise exception 'the default document site must be an internal registered business site';
  end if;
  if v_postal_code is not null and v_postal_code !~ '^[0-9]{5}$' then
    raise exception 'postalCode must contain 5 digits';
  end if;
  if v_road_address is null or char_length(v_road_address) not between 1 and 500 then
    raise exception 'roadAddress is required and must be at most 500 characters';
  end if;
  if v_detail_address is not null and char_length(v_detail_address) > 300 then
    raise exception 'detailAddress must be at most 300 characters';
  end if;
  if v_english_address is not null and char_length(v_english_address) > 500 then
    raise exception 'englishAddress must be at most 500 characters';
  end if;
  if v_business_type is not null and char_length(v_business_type) > 200 then
    raise exception 'businessType must be at most 200 characters';
  end if;
  if v_business_items is not null and char_length(v_business_items) > 300 then
    raise exception 'businessItems must be at most 300 characters';
  end if;
  if v_email is not null and (
    char_length(v_email) > 254
    or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  ) then
    raise exception 'email is invalid';
  end if;
  if v_phone is not null and (char_length(v_phone) not between 3 and 40 or v_phone ~ '[[:cntrl:]]') then
    raise exception 'phone is invalid';
  end if;
  if v_fax is not null and (char_length(v_fax) not between 3 and 40 or v_fax ~ '[[:cntrl:]]') then
    raise exception 'fax is invalid';
  end if;
  if v_mobile is not null and (char_length(v_mobile) not between 3 and 40 or v_mobile ~ '[[:cntrl:]]') then
    raise exception 'mobile is invalid';
  end if;
  if v_license_no is not null and char_length(v_license_no) > 100 then
    raise exception 'livestockBusinessLicenseNo must be at most 100 characters';
  end if;
  if (v_is_head_office or v_is_default_document_site) and not v_active then
    raise exception 'a head office or default document site must be active';
  end if;

  select c.active into v_company_active
  from public.companies c
  where c.id = v_company_id;
  if not found then
    raise exception 'company not found';
  end if;
  if v_active and not v_company_active then
    raise exception 'an active business site requires an active company';
  end if;
  if not v_active and v_id is not null and exists (
    select 1 from public.business_site_identifiers
    where business_site_id = v_id and active
  ) then
    raise exception 'deactivate all site identifiers before deactivating the business site';
  end if;
  if not v_active and v_id is not null and exists (
    select 1 from public.document_sender_profiles
    where business_site_id = v_id and active
  ) then
    raise exception 'deactivate sender profiles linked to this business site first';
  end if;
  if v_id is not null
    and (v_site_type = 'external_warehouse' or v_ownership_type = 'third_party')
    and exists (
      select 1 from public.document_sender_profiles
      where business_site_id = v_id and active
    )
  then
    raise exception 'an active sender profile requires an internal business site';
  end if;
  if exists (
    select 1 from public.business_sites s
    where s.company_id = v_company_id and lower(s.code) = v_code
      and (v_id is null or s.id <> v_id)
  ) then
    raise exception 'business-site code already exists for this company';
  end if;
  if exists (
    select 1 from public.business_sites s
    where s.business_registration_no = v_business_registration_no
      and (v_id is null or s.id <> v_id)
  ) then
    raise exception 'businessRegistrationNo already exists';
  end if;
  if v_is_head_office and v_active and exists (
    select 1 from public.business_sites s
    where s.company_id = v_company_id and s.is_head_office and s.active
      and (v_id is null or s.id <> v_id)
  ) then
    raise exception 'another active head office already exists for this company';
  end if;
  if v_is_default_document_site and v_active and exists (
    select 1 from public.business_sites s
    where s.company_id = v_company_id and s.is_default_document_site and s.active
      and (v_id is null or s.id <> v_id)
  ) then
    raise exception 'another active default document site already exists for this company';
  end if;

  if v_id is null then
    insert into public.business_sites (
      company_id, code, name, site_type, ownership_type, inventory_location,
      operator_trader_key, operator_name, business_registration_no,
      postal_code, road_address, detail_address, english_address,
      business_type, business_items, email, phone, fax, mobile,
      livestock_business_license_no, is_head_office,
      is_default_document_site, active
    ) values (
      v_company_id, v_code, v_name, v_site_type, v_ownership_type, v_inventory_location,
      v_operator_trader_key, v_operator_name, v_business_registration_no,
      v_postal_code, v_road_address, v_detail_address, v_english_address,
      v_business_type, v_business_items, v_email, v_phone, v_fax, v_mobile,
      v_license_no, v_is_head_office, v_is_default_document_site, v_active
    ) returning * into v_new;
    v_action := 'insert';
  else
    update public.business_sites set
      code = v_code,
      name = v_name,
      site_type = v_site_type,
      ownership_type = v_ownership_type,
      inventory_location = v_inventory_location,
      operator_trader_key = v_operator_trader_key,
      operator_name = v_operator_name,
      business_registration_no = v_business_registration_no,
      postal_code = v_postal_code,
      road_address = v_road_address,
      detail_address = v_detail_address,
      english_address = v_english_address,
      business_type = v_business_type,
      business_items = v_business_items,
      email = v_email,
      phone = v_phone,
      fax = v_fax,
      mobile = v_mobile,
      livestock_business_license_no = v_license_no,
      is_head_office = v_is_head_office,
      is_default_document_site = v_is_default_document_site,
      active = v_active,
      revision = revision + 1,
      updated_at = now()
    where id = v_id and revision = p_expected_revision
    returning * into v_new;
    get diagnostics v_row_count = row_count;
    if v_row_count <> 1 then
      raise exception 'business site was changed by another session; reload and try again';
    end if;
    v_action := 'update';
  end if;

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values (
    'business_site', v_action, v_new.id::text, v_new.name,
    jsonb_build_object(
      'before', case when v_old.id is null then null else to_jsonb(v_old) end,
      'after', to_jsonb(v_new),
      'authMode', 'legacy_app_password'
    )
  );

  v_record := jsonb_build_object(
    'id', v_new.id,
    'companyId', v_new.company_id,
    'code', v_new.code,
    'name', v_new.name,
    'siteType', v_new.site_type,
    'ownershipType', v_new.ownership_type,
    'inventoryLocation', v_new.inventory_location,
    'operatorTraderKey', v_new.operator_trader_key,
    'operatorName', v_new.operator_name,
    'businessRegistrationNo', v_new.business_registration_no,
    'postalCode', v_new.postal_code,
    'roadAddress', v_new.road_address,
    'detailAddress', v_new.detail_address,
    'englishAddress', v_new.english_address,
    'businessType', v_new.business_type,
    'businessItems', v_new.business_items,
    'email', v_new.email,
    'phone', v_new.phone,
    'fax', v_new.fax,
    'mobile', v_new.mobile,
    'livestockBusinessLicenseNo', v_new.livestock_business_license_no,
    'isHeadOffice', v_new.is_head_office,
    'isDefaultDocumentSite', v_new.is_default_document_site,
    'active', v_new.active,
    'revision', v_new.revision,
    'createdAt', v_new.created_at,
    'updatedAt', v_new.updated_at
  );
  return jsonb_build_object(
    'ok', true,
    'id', v_new.id,
    'revision', v_new.revision,
    'record', v_record
  );
end;
$dbmt$;

create or replace function public.dbmt_save_business_site_identifier(
  p_password text,
  p_record jsonb,
  p_expected_revision bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_id uuid;
  v_id_text text;
  v_business_site_id uuid;
  v_business_site_id_text text;
  v_site_active boolean;
  v_old public.business_site_identifiers%rowtype;
  v_new public.business_site_identifiers%rowtype;
  v_provider text;
  v_identifier_type text;
  v_identifier_value text;
  v_valid_from_text text;
  v_valid_to_text text;
  v_valid_from date;
  v_valid_to date;
  v_active boolean;
  v_unknown_fields text;
  v_row_count integer;
  v_action text;
  v_record jsonb;
begin
  if public.dbmt_check_password(p_password) is not true then
    raise exception 'invalid app password';
  end if;
  if p_record is null or jsonb_typeof(p_record) <> 'object' then
    raise exception 'business-site identifier record must be a JSON object';
  end if;

  select string_agg(f.key, ', ' order by f.key)
  into v_unknown_fields
  from jsonb_object_keys(p_record) as f(key)
  where not (f.key = any (array[
    'id', 'businessSiteId', 'provider', 'identifierType', 'identifierValue',
    'validFrom', 'validTo', 'active'
  ]::text[]));
  if v_unknown_fields is not null then
    raise exception 'unsupported business-site identifier fields: %', v_unknown_fields;
  end if;

  v_id_text := nullif(btrim(coalesce(p_record->>'id', '')), '');
  if v_id_text is not null and v_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'business-site identifier id is invalid';
  end if;
  v_id := v_id_text::uuid;

  if v_id is null then
    if p_expected_revision is not null then
      raise exception 'expected revision must be null for a new business-site identifier';
    end if;
  else
    if p_expected_revision is null or p_expected_revision < 1 then
      raise exception 'expected revision is required when updating a business-site identifier';
    end if;
    select * into v_old
    from public.business_site_identifiers
    where id = v_id
    for update;
    if v_old.id is null then
      raise exception 'business-site identifier not found';
    end if;
    if v_old.revision <> p_expected_revision then
      raise exception 'business-site identifier was changed by another session; reload and try again';
    end if;
  end if;

  if p_record ? 'active' and jsonb_typeof(p_record->'active') <> 'boolean' then
    raise exception 'active must be a boolean';
  end if;

  v_business_site_id_text := case when p_record ? 'businessSiteId'
    then nullif(btrim(coalesce(p_record->>'businessSiteId', '')), '')
    else v_old.business_site_id::text end;
  if v_business_site_id_text is null
     or v_business_site_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'businessSiteId is required and must be a valid UUID';
  end if;
  v_business_site_id := v_business_site_id_text::uuid;

  v_provider := case when p_record ? 'provider'
    then lower(btrim(coalesce(p_record->>'provider', ''))) else v_old.provider end;
  v_identifier_type := case when p_record ? 'identifierType'
    then lower(btrim(coalesce(p_record->>'identifierType', ''))) else v_old.identifier_type end;
  v_identifier_value := case when p_record ? 'identifierValue'
    then btrim(coalesce(p_record->>'identifierValue', '')) else v_old.identifier_value end;
  v_valid_from_text := case when p_record ? 'validFrom'
    then nullif(btrim(coalesce(p_record->>'validFrom', '')), '') else v_old.valid_from::text end;
  v_valid_to_text := case when p_record ? 'validTo'
    then nullif(btrim(coalesce(p_record->>'validTo', '')), '') else v_old.valid_to::text end;
  v_active := case when p_record ? 'active'
    then (p_record->>'active')::boolean else coalesce(v_old.active, true) end;

  if v_old.id is not null and v_business_site_id <> v_old.business_site_id then
    raise exception 'an identifier cannot be moved to another business site';
  end if;
  if v_old.id is not null and (v_provider <> v_old.provider or v_identifier_type <> v_old.identifier_type) then
    raise exception 'provider and identifierType cannot be changed; deactivate this identifier and create another';
  end if;
  if v_provider is null or v_provider !~ '^[a-z][a-z0-9_-]{1,49}$' then
    raise exception 'provider must be 2-50 lowercase letters, numbers, dash or underscore';
  end if;
  if v_identifier_type is null or v_identifier_type !~ '^[a-z][a-z0-9_-]{1,59}$' then
    raise exception 'identifierType must be 2-60 lowercase letters, numbers, dash or underscore';
  end if;
  if v_identifier_type ~ '(secret|password|passwd|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|user[_-]?id|login[_-]?id|sys[_-]?id|system[_-]?id)' then
    raise exception 'secret credentials must be stored in Edge Function secrets, not site identifiers';
  end if;
  if v_identifier_value is null
     or char_length(v_identifier_value) not between 1 and 200
     or v_identifier_value ~ '[[:cntrl:]]' then
    raise exception 'identifierValue is required and must be at most 200 printable characters';
  end if;

  if v_valid_from_text is not null then
    if v_valid_from_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'validFrom must use YYYY-MM-DD';
    end if;
    begin
      v_valid_from := v_valid_from_text::date;
    exception when others then
      raise exception 'validFrom is not a valid date';
    end;
  end if;
  if v_valid_to_text is not null then
    if v_valid_to_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'validTo must use YYYY-MM-DD';
    end if;
    begin
      v_valid_to := v_valid_to_text::date;
    exception when others then
      raise exception 'validTo is not a valid date';
    end;
  end if;
  if v_valid_from is not null and v_valid_to is not null and v_valid_to < v_valid_from then
    raise exception 'validTo cannot be earlier than validFrom';
  end if;

  select s.active into v_site_active
  from public.business_sites s
  where s.id = v_business_site_id
  for share;
  if not found then
    raise exception 'business site not found';
  end if;
  if v_active and not v_site_active then
    raise exception 'an active identifier requires an active business site';
  end if;
  if v_active and exists (
    select 1 from public.business_site_identifiers i
    where i.business_site_id = v_business_site_id
      and i.provider = v_provider
      and i.identifier_type = v_identifier_type
      and i.active
      and (v_id is null or i.id <> v_id)
  ) then
    raise exception 'an active identifier of this provider and type already exists for the business site';
  end if;
  if v_active and exists (
    select 1 from public.business_site_identifiers i
    where i.provider = v_provider
      and i.identifier_type = v_identifier_type
      and i.identifier_value = v_identifier_value
      and i.active
      and (v_id is null or i.id <> v_id)
  ) then
    raise exception 'identifierValue is already assigned to another active business site';
  end if;

  if v_id is null then
    insert into public.business_site_identifiers (
      business_site_id, provider, identifier_type, identifier_value,
      valid_from, valid_to, active
    ) values (
      v_business_site_id, v_provider, v_identifier_type, v_identifier_value,
      v_valid_from, v_valid_to, v_active
    ) returning * into v_new;
    v_action := 'insert';
  else
    update public.business_site_identifiers set
      identifier_value = v_identifier_value,
      valid_from = v_valid_from,
      valid_to = v_valid_to,
      active = v_active,
      revision = revision + 1,
      updated_at = now()
    where id = v_id and revision = p_expected_revision
    returning * into v_new;
    get diagnostics v_row_count = row_count;
    if v_row_count <> 1 then
      raise exception 'business-site identifier was changed by another session; reload and try again';
    end if;
    v_action := 'update';
  end if;

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values (
    'business_site_identifier', v_action, v_new.id::text,
    v_new.provider || ' / ' || v_new.identifier_type,
    jsonb_build_object(
      'before', case when v_old.id is null then null else to_jsonb(v_old) end,
      'after', to_jsonb(v_new),
      'authMode', 'legacy_app_password'
    )
  );

  v_record := jsonb_build_object(
    'id', v_new.id,
    'businessSiteId', v_new.business_site_id,
    'provider', v_new.provider,
    'identifierType', v_new.identifier_type,
    'identifierValue', v_new.identifier_value,
    'validFrom', v_new.valid_from,
    'validTo', v_new.valid_to,
    'active', v_new.active,
    'revision', v_new.revision,
    'createdAt', v_new.created_at,
    'updatedAt', v_new.updated_at
  );
  return jsonb_build_object(
    'ok', true,
    'id', v_new.id,
    'revision', v_new.revision,
    'record', v_record
  );
end;
$dbmt$;

create or replace function public.dbmt_save_document_sender_profile(
  p_password text,
  p_record jsonb,
  p_expected_revision bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_id uuid;
  v_id_text text;
  v_business_site_id uuid;
  v_business_site_id_text text;
  v_business_site public.business_sites%rowtype;
  v_old public.document_sender_profiles%rowtype;
  v_new public.document_sender_profiles%rowtype;
  v_code text;
  v_label text;
  v_reply_email text;
  v_reply_fax text;
  v_seal_asset_key text;
  v_secret_alias text;
  v_is_default boolean;
  v_active boolean;
  v_unknown_fields text;
  v_row_count integer;
  v_action text;
  v_record jsonb;
begin
  if public.dbmt_check_password(p_password) is not true then
    raise exception 'invalid app password';
  end if;
  if p_record is null or jsonb_typeof(p_record) <> 'object' then
    raise exception 'document-sender profile must be a JSON object';
  end if;

  select string_agg(f.key, ', ' order by f.key)
  into v_unknown_fields
  from jsonb_object_keys(p_record) as f(key)
  where not (f.key = any (array[
    'id', 'code', 'label', 'businessSiteId', 'replyEmail', 'replyFax',
    'sealAssetKey', 'secretAlias', 'isDefault', 'active'
  ]::text[]));
  if v_unknown_fields is not null then
    raise exception 'unsupported document-sender profile fields: %', v_unknown_fields;
  end if;

  v_id_text := nullif(btrim(coalesce(p_record->>'id', '')), '');
  if v_id_text is not null and v_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'document-sender profile id is invalid';
  end if;
  v_id := v_id_text::uuid;

  if v_id is null then
    if p_expected_revision is not null then
      raise exception 'expected revision must be null for a new document-sender profile';
    end if;
  else
    if p_expected_revision is null or p_expected_revision < 1 then
      raise exception 'expected revision is required when updating a document-sender profile';
    end if;
    select * into v_old
    from public.document_sender_profiles
    where id = v_id
    for update;
    if v_old.id is null then
      raise exception 'document-sender profile not found';
    end if;
    if v_old.revision <> p_expected_revision then
      raise exception 'document-sender profile was changed by another session; reload and try again';
    end if;
  end if;

  if p_record ? 'isDefault' and jsonb_typeof(p_record->'isDefault') <> 'boolean' then
    raise exception 'isDefault must be a boolean';
  end if;
  if p_record ? 'active' and jsonb_typeof(p_record->'active') <> 'boolean' then
    raise exception 'active must be a boolean';
  end if;

  v_code := case when p_record ? 'code'
    then lower(btrim(coalesce(p_record->>'code', ''))) else v_old.code end;
  v_label := case when p_record ? 'label'
    then btrim(coalesce(p_record->>'label', '')) else v_old.label end;
  v_business_site_id_text := case when p_record ? 'businessSiteId'
    then nullif(btrim(coalesce(p_record->>'businessSiteId', '')), '')
    else v_old.business_site_id::text end;
  if v_business_site_id_text is not null
     and v_business_site_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'businessSiteId must be a valid UUID';
  end if;
  v_business_site_id := v_business_site_id_text::uuid;
  v_reply_email := case when p_record ? 'replyEmail'
    then nullif(lower(btrim(coalesce(p_record->>'replyEmail', ''))), '') else v_old.reply_email end;
  v_reply_fax := case when p_record ? 'replyFax'
    then nullif(btrim(coalesce(p_record->>'replyFax', '')), '') else v_old.reply_fax end;
  v_seal_asset_key := case when p_record ? 'sealAssetKey'
    then nullif(btrim(coalesce(p_record->>'sealAssetKey', '')), '') else v_old.seal_asset_key end;
  v_secret_alias := case when p_record ? 'secretAlias'
    then lower(btrim(coalesce(p_record->>'secretAlias', '')))
    else coalesce(v_old.secret_alias, v_code) end;
  v_is_default := case when p_record ? 'isDefault'
    then (p_record->>'isDefault')::boolean else coalesce(v_old.is_default, false) end;
  v_active := case when p_record ? 'active'
    then (p_record->>'active')::boolean else coalesce(v_old.active, true) end;

  if v_old.id is not null and v_code <> v_old.code then
    raise exception 'a document-sender profile code cannot be changed; create another profile';
  end if;
  if v_old.id is not null and v_secret_alias <> v_old.secret_alias then
    raise exception 'a document-sender profile secretAlias cannot be changed; rotate secrets under the existing alias or create another profile';
  end if;
  if v_code is null or v_code !~ '^[a-z][a-z0-9_-]{1,49}$' then
    raise exception 'code must be 2-50 lowercase letters, numbers, dash or underscore';
  end if;
  if v_label is null or char_length(v_label) not between 1 and 200 then
    raise exception 'label is required and must be at most 200 characters';
  end if;
  if v_reply_email is not null and (
    char_length(v_reply_email) > 254
    or v_reply_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  ) then
    raise exception 'replyEmail is invalid';
  end if;
  if v_reply_fax is not null and (
    char_length(v_reply_fax) not between 3 and 40 or v_reply_fax ~ '[[:cntrl:]]'
  ) then
    raise exception 'replyFax is invalid';
  end if;
  if v_seal_asset_key is not null and (
    char_length(v_seal_asset_key) > 200
    or v_seal_asset_key !~ '^[A-Za-z0-9][A-Za-z0-9_./-]*$'
    or v_seal_asset_key ~ '(^/|[.][.]|//)'
  ) then
    raise exception 'sealAssetKey must be a safe relative asset path';
  end if;
  if v_secret_alias is null or v_secret_alias !~ '^[a-z][a-z0-9_]{1,49}$' then
    raise exception 'secretAlias must be 2-50 lowercase letters, numbers or underscore';
  end if;
  if v_is_default and not v_active then
    raise exception 'the default document-sender profile must be active';
  end if;
  if v_business_site_id is not null then
    select * into v_business_site
    from public.business_sites s
    where s.id = v_business_site_id
    for share;
    if v_business_site.id is null
      or (v_active and not v_business_site.active)
      or v_business_site.site_type = 'external_warehouse'
      or v_business_site.ownership_type = 'third_party'
    then
      raise exception 'a document-sender profile requires an internal business site';
    end if;
  end if;
  if exists (
    select 1 from public.document_sender_profiles p
    where lower(p.code) = v_code and (v_id is null or p.id <> v_id)
  ) then
    raise exception 'document-sender profile code already exists';
  end if;
  if v_is_default and v_active and exists (
    select 1 from public.document_sender_profiles p
    where p.is_default and p.active and (v_id is null or p.id <> v_id)
  ) then
    raise exception 'another active default document-sender profile already exists';
  end if;

  if v_id is null then
    insert into public.document_sender_profiles (
      code, label, business_site_id, reply_email, reply_fax,
      seal_asset_key, secret_alias, is_default, active
    ) values (
      v_code, v_label, v_business_site_id, v_reply_email, v_reply_fax,
      v_seal_asset_key, v_secret_alias, v_is_default, v_active
    ) returning * into v_new;
    v_action := 'insert';
  else
    update public.document_sender_profiles set
      code = v_code,
      label = v_label,
      business_site_id = v_business_site_id,
      reply_email = v_reply_email,
      reply_fax = v_reply_fax,
      seal_asset_key = v_seal_asset_key,
      secret_alias = v_secret_alias,
      is_default = v_is_default,
      active = v_active,
      revision = revision + 1,
      updated_at = now()
    where id = v_id and revision = p_expected_revision
    returning * into v_new;
    get diagnostics v_row_count = row_count;
    if v_row_count <> 1 then
      raise exception 'document-sender profile was changed by another session; reload and try again';
    end if;
    v_action := 'update';
  end if;

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values (
    'document_sender_profile', v_action, v_new.id::text, v_new.label,
    jsonb_build_object(
      'before', case when v_old.id is null then null else to_jsonb(v_old) end,
      'after', to_jsonb(v_new),
      'authMode', 'legacy_app_password'
    )
  );

  v_record := jsonb_build_object(
    'id', v_new.id,
    'code', v_new.code,
    'label', v_new.label,
    'businessSiteId', v_new.business_site_id,
    'replyEmail', v_new.reply_email,
    'replyFax', v_new.reply_fax,
    'sealAssetKey', v_new.seal_asset_key,
    'secretAlias', v_new.secret_alias,
    'isDefault', v_new.is_default,
    'active', v_new.active,
    'revision', v_new.revision,
    'createdAt', v_new.created_at,
    'updatedAt', v_new.updated_at
  );
  return jsonb_build_object(
    'ok', true,
    'id', v_new.id,
    'revision', v_new.revision,
    'record', v_record
  );
end;
$dbmt$;

revoke all on function public.dbmt_get_company_master(text)
  from public, anon, authenticated;
revoke all on function public.dbmt_save_company(text, jsonb, bigint)
  from public, anon, authenticated;
revoke all on function public.dbmt_save_business_site(text, jsonb, bigint)
  from public, anon, authenticated;
revoke all on function public.dbmt_save_business_site_identifier(text, jsonb, bigint)
  from public, anon, authenticated;
revoke all on function public.dbmt_save_document_sender_profile(text, jsonb, bigint)
  from public, anon, authenticated;

grant execute on function public.dbmt_get_company_master(text)
  to anon, authenticated, service_role;
grant execute on function public.dbmt_save_company(text, jsonb, bigint)
  to anon, authenticated, service_role;
grant execute on function public.dbmt_save_business_site(text, jsonb, bigint)
  to anon, authenticated, service_role;
grant execute on function public.dbmt_save_business_site_identifier(text, jsonb, bigint)
  to anon, authenticated, service_role;
grant execute on function public.dbmt_save_document_sender_profile(text, jsonb, bigint)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
