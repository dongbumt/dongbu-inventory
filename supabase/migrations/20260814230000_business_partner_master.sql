-- M03: normalized business-partner master with stable IDs and personal permissions.

create sequence if not exists public.business_partner_code_seq start 1;

create table if not exists public.business_partners (
  id uuid primary key default extensions.gen_random_uuid(),
  code text not null,
  name text not null,
  trade_type text,
  category text,
  legal_name text,
  business_registration_no text,
  registration_no_normalized text,
  representative_name text,
  manager_name text,
  manager_phone text,
  phone text,
  email text,
  fax text,
  fax_alt text,
  address text,
  business_type text,
  business_items text,
  payment_terms text,
  payment_due_days integer,
  credit_limit numeric(18,2) not null default 0,
  active boolean not null default true,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_partners_code_valid check (code = btrim(code) and code ~ '^[A-Z][A-Z0-9_-]{2,39}$'),
  constraint business_partners_name_valid check (name = btrim(name) and char_length(name) between 1 and 100),
  constraint business_partners_trade_type_valid check (
    trade_type is null or trade_type in ('매입','매출','매입/매출','보관(냉동창고)')
  ),
  constraint business_partners_registration_normalized_valid check (
    registration_no_normalized is null or registration_no_normalized ~ '^[0-9]{10}$'
  ),
  constraint business_partners_payment_due_days_valid check (
    payment_due_days is null or payment_due_days between 0 and 3650
  ),
  constraint business_partners_text_lengths_valid check (
    char_length(coalesce(category,'')) <= 100
    and char_length(coalesce(legal_name,'')) <= 150
    and char_length(coalesce(business_registration_no,'')) <= 30
    and char_length(coalesce(representative_name,'')) <= 100
    and char_length(coalesce(manager_name,'')) <= 100
    and char_length(coalesce(manager_phone,'')) <= 40
    and char_length(coalesce(phone,'')) <= 40
    and char_length(coalesce(email,'')) <= 200
    and char_length(coalesce(fax,'')) <= 40
    and char_length(coalesce(fax_alt,'')) <= 40
    and char_length(coalesce(address,'')) <= 300
    and char_length(coalesce(business_type,'')) <= 150
    and char_length(coalesce(business_items,'')) <= 150
    and char_length(coalesce(payment_terms,'')) <= 200
  ),
  constraint business_partners_credit_limit_valid check (credit_limit >= 0)
);

create unique index if not exists uq_business_partners_code_lower on public.business_partners(lower(code));
create unique index if not exists uq_business_partners_name_lower on public.business_partners(lower(name));
create unique index if not exists uq_business_partners_registration_normalized
  on public.business_partners(registration_no_normalized) where registration_no_normalized is not null;
create index if not exists idx_business_partners_active_name on public.business_partners(active, name);

create table if not exists public.business_partner_aliases (
  id uuid primary key default extensions.gen_random_uuid(),
  business_partner_id uuid not null references public.business_partners(id) on delete restrict,
  alias_name text not null,
  created_at timestamptz not null default now(),
  constraint business_partner_aliases_name_valid check (
    alias_name = btrim(alias_name) and char_length(alias_name) between 1 and 100
  )
);
create unique index if not exists uq_business_partner_aliases_name_lower
  on public.business_partner_aliases(lower(alias_name));
create index if not exists idx_business_partner_aliases_partner
  on public.business_partner_aliases(business_partner_id);

create table if not exists public.business_partner_identifiers (
  id uuid primary key default extensions.gen_random_uuid(),
  business_partner_id uuid not null references public.business_partners(id) on delete restrict,
  provider text not null,
  identifier_type text not null,
  identifier_value text not null,
  active boolean not null default true,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_partner_identifiers_provider_valid check (
    provider = btrim(provider) and provider ~ '^[a-z][a-z0-9_]{1,39}$'
  ),
  constraint business_partner_identifiers_type_valid check (
    identifier_type = btrim(identifier_type) and identifier_type ~ '^[a-z][a-z0-9_]{1,59}$'
  ),
  constraint business_partner_identifiers_value_valid check (
    identifier_value = btrim(identifier_value) and char_length(identifier_value) between 1 and 200
  )
);
create unique index if not exists uq_business_partner_identifiers_key
  on public.business_partner_identifiers(business_partner_id, provider, identifier_type);
create index if not exists idx_business_partner_identifiers_value
  on public.business_partner_identifiers(provider, identifier_type, identifier_value) where active;

alter table public.business_partners enable row level security;
alter table public.business_partner_aliases enable row level security;
alter table public.business_partner_identifiers enable row level security;

revoke all on table public.business_partners from public, anon, authenticated;
revoke all on table public.business_partner_aliases from public, anon, authenticated;
revoke all on table public.business_partner_identifiers from public, anon, authenticated;
revoke all on sequence public.business_partner_code_seq from public, anon, authenticated;

-- Import only the ERP's existing trader master. This is not an SM-data migration.
with source_rows as (
  select btrim(e.key) as name, e.value as info,
    regexp_replace(coalesce(e.value->>'regno',''), '[^0-9]', '', 'g') as reg_digits
  from public.app_data a
  cross join lateral jsonb_each(case when jsonb_typeof(a.payload) = 'object' then a.payload else '{}'::jsonb end) e
  where a.key = 'traderInfoMap'
    and btrim(e.key) <> ''
    and coalesce(e.value->>'alias','false') <> 'true'
), prepared as (
  select *, count(*) over (partition by nullif(reg_digits,'')) as reg_count
  from source_rows
)
insert into public.business_partners(
  code, name, trade_type, category, legal_name, business_registration_no,
  registration_no_normalized, representative_name, manager_name, manager_phone,
  phone, email, fax, fax_alt, address, business_type, business_items,
  payment_terms, payment_due_days, credit_limit, active
)
select
  'BP-' || lpad(nextval('public.business_partner_code_seq')::text, 6, '0'),
  left(name,100),
  case when info->>'tradeType' in ('매입','매출','매입/매출','보관(냉동창고)') then info->>'tradeType' end,
  nullif(left(btrim(coalesce(info->>'category','')),100),''),
  nullif(left(btrim(coalesce(info->>'fullname','')),150),''),
  nullif(left(btrim(coalesce(info->>'regno','')),30),''),
  case when length(reg_digits)=10 and reg_count=1 then reg_digits end,
  nullif(left(btrim(coalesce(info->>'ceo','')),100),''),
  nullif(left(btrim(coalesce(info->>'manager','')),100),''),
  nullif(left(btrim(coalesce(info->>'managerPhone','')),40),''),
  nullif(left(btrim(coalesce(info->>'phone','')),40),''),
  nullif(left(btrim(coalesce(info->>'email','')),200),''),
  nullif(left(btrim(coalesce(info->>'fax','')),40),''),
  nullif(left(btrim(coalesce(info->>'faxAlt','')),40),''),
  nullif(left(btrim(coalesce(info->>'addr','')),300),''),
  nullif(left(btrim(coalesce(info->>'biz','')),150),''),
  nullif(left(btrim(coalesce(info->>'businessItems','')),150),''),
  nullif(left(btrim(coalesce(info->>'paymentTerms','')),200),''),
  case when coalesce(info->>'paymentDueDays','') ~ '^[0-9]{1,4}$'
    then least((info->>'paymentDueDays')::integer,3650) end,
  case when coalesce(info->>'creditLimit','') ~ '^[0-9]+([.][0-9]+)?$'
    then (info->>'creditLimit')::numeric else 0 end,
  coalesce((info->>'active')::boolean,true)
from prepared
on conflict do nothing;

create or replace function public.dbmt_business_partner_json(p_id uuid)
returns jsonb
language sql
security definer
set search_path = public, extensions
as $dbmt$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', p.id, 'code', p.code, 'name', p.name,
    'tradeType', coalesce(p.trade_type,''), 'category', coalesce(p.category,''),
    'fullname', coalesce(p.legal_name,''), 'regno', coalesce(p.business_registration_no,''),
    'ceo', coalesce(p.representative_name,''), 'manager', coalesce(p.manager_name,''),
    'managerPhone', coalesce(p.manager_phone,''), 'phone', coalesce(p.phone,''),
    'email', coalesce(p.email,''), 'fax', coalesce(p.fax,''), 'faxAlt', coalesce(p.fax_alt,''),
    'addr', coalesce(p.address,''), 'biz', coalesce(p.business_type,''),
    'businessItems', coalesce(p.business_items,''), 'paymentTerms', coalesce(p.payment_terms,''),
    'paymentDueDays', p.payment_due_days, 'creditLimit', p.credit_limit,
    'active', p.active, 'revision', p.revision,
    'identifiers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'provider', i.provider, 'identifierType', i.identifier_type,
        'identifierValue', i.identifier_value, 'revision', i.revision
      ) order by i.provider, i.identifier_type)
      from public.business_partner_identifiers i
      where i.business_partner_id = p.id and i.active
    ), '[]'::jsonb),
    'aliases', coalesce((
      select jsonb_agg(a.alias_name order by a.alias_name)
      from public.business_partner_aliases a where a.business_partner_id = p.id
    ), '[]'::jsonb)
  ))
  from public.business_partners p where p.id = p_id;
$dbmt$;

create or replace function public.dbmt_refresh_trader_info_map()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare v_map jsonb;
begin
  with rows as (
    select p.name as map_key, p.id, false as is_alias from public.business_partners p
    union all
    select a.alias_name, a.business_partner_id, true
    from public.business_partner_aliases a
  )
  select coalesce(jsonb_object_agg(r.map_key,
    public.dbmt_business_partner_json(r.id) || jsonb_build_object('alias',r.is_alias)
  ), '{}'::jsonb) into v_map
  from rows r;

  insert into public.app_data(key,payload,updated_at)
  values ('traderInfoMap',v_map,now())
  on conflict (key) do update set payload=excluded.payload, updated_at=now();
  return v_map;
end;
$dbmt$;

select public.dbmt_refresh_trader_info_map();

alter table public.transactions add column if not exists business_partner_id uuid;
alter table public.prices add column if not exists business_partner_id uuid;
do $dbmt$
begin
  if not exists (select 1 from pg_constraint where conname='transactions_business_partner_fk') then
    alter table public.transactions add constraint transactions_business_partner_fk
      foreign key (business_partner_id) references public.business_partners(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname='prices_business_partner_fk') then
    alter table public.prices add constraint prices_business_partner_fk
      foreign key (business_partner_id) references public.business_partners(id) on delete restrict;
  end if;
end;
$dbmt$;
create index if not exists idx_transactions_business_partner on public.transactions(business_partner_id);
create index if not exists idx_prices_business_partner on public.prices(business_partner_id);

create or replace function public.dbmt_assign_business_partner()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare v_id uuid;
begin
  if btrim(coalesce(new.trader,'')) = '' then
    new.business_partner_id := null;
  elsif new.business_partner_id is null or tg_op='INSERT'
    or new.trader is distinct from old.trader then
    select x.id into v_id from (
      select p.id, 0 as priority from public.business_partners p
      where lower(p.name)=lower(btrim(new.trader))
      union all
      select a.business_partner_id, 1 from public.business_partner_aliases a
      where lower(a.alias_name)=lower(btrim(new.trader))
      order by priority limit 1
    ) x;
    new.business_partner_id := v_id;
  end if;
  new.raw := coalesce(new.raw,'{}'::jsonb) || jsonb_build_object(
    'businessPartnerId', case when new.business_partner_id is null then '' else new.business_partner_id::text end
  );
  return new;
end;
$dbmt$;

drop trigger if exists trg_transactions_assign_business_partner on public.transactions;
create trigger trg_transactions_assign_business_partner
before insert or update of trader,business_partner_id on public.transactions
for each row execute function public.dbmt_assign_business_partner();
drop trigger if exists trg_prices_assign_business_partner on public.prices;
create trigger trg_prices_assign_business_partner
before insert or update of trader,business_partner_id on public.prices
for each row execute function public.dbmt_assign_business_partner();

update public.transactions t set business_partner_id=p.id,
  raw=coalesce(t.raw,'{}'::jsonb)||jsonb_build_object('businessPartnerId',p.id::text)
from public.business_partners p
where t.business_partner_id is null and btrim(coalesce(t.trader,''))<>''
  and lower(btrim(t.trader))=lower(p.name);
update public.prices t set business_partner_id=p.id,
  raw=coalesce(t.raw,'{}'::jsonb)||jsonb_build_object('businessPartnerId',p.id::text)
from public.business_partners p
where t.business_partner_id is null and btrim(coalesce(t.trader,''))<>''
  and lower(btrim(t.trader))=lower(p.name);

create or replace function public.dbmt_get_business_partners(p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
begin
  if public.dbmt_check_password(p_password) is not true then raise exception 'invalid app password'; end if;
  return coalesce((select jsonb_agg(public.dbmt_business_partner_json(p.id) order by p.name)
    from public.business_partners p), '[]'::jsonb);
end;
$dbmt$;

create or replace function public.dbmt_erp_save_business_partner(
  p_token text, p_record jsonb, p_expected_revision bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_user_id uuid := public.dbmt_erp_session_user(p_token);
  v_user public.erp_users%rowtype; v_role public.erp_roles%rowtype;
  v_old public.business_partners%rowtype; v_new public.business_partners%rowtype;
  v_id uuid; v_action text; v_name text; v_code text; v_trade_type text;
  v_regno text; v_regnorm text; v_email text; v_active boolean;
  v_due integer; v_credit numeric; v_identifier jsonb; v_map jsonb;
  v_log jsonb; v_logs jsonb; v_partner jsonb;
begin
  if v_user_id is null then return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.'); end if;
  if jsonb_typeof(coalesce(p_record,'{}'::jsonb)) <> 'object' then raise exception '거래처 입력 형식이 올바르지 않습니다.'; end if;
  if exists (select 1 from jsonb_object_keys(coalesce(p_record,'{}'::jsonb)) k
    where k not in ('id','name','tradeType','category','fullname','regno','ceo','manager','managerPhone','phone','email','fax','faxAlt','addr','biz','businessItems','paymentTerms','paymentDueDays','creditLimit','active','identifiers')) then
    raise exception '지원하지 않는 거래처 입력항목이 있습니다.';
  end if;
  begin v_id := nullif(btrim(coalesce(p_record->>'id','')),'')::uuid;
  exception when invalid_text_representation then raise exception '거래처 ID 형식이 올바르지 않습니다.'; end;
  if v_id is null then v_action:='create'; else
    select * into v_old from public.business_partners where id=v_id for update;
    if v_old.id is null then raise exception '수정할 거래처를 찾을 수 없습니다.'; end if;
    if p_expected_revision is null or v_old.revision<>p_expected_revision then raise exception 'stale business partner revision'; end if;
    v_action:='update';
  end if;
  if public.dbmt_erp_has_permission(p_token,'traders',v_action) is not true then
    return public.dbmt_erp_permission_denied(v_user_id,'traders',v_action);
  end if;
  select * into v_user from public.erp_users where id=v_user_id;
  select * into v_role from public.erp_roles where id=v_user.role_id;

  v_name:=btrim(coalesce(p_record->>'name',''));
  if char_length(v_name) not between 1 and 100 then raise exception '거래처명은 1~100자로 입력해주세요.'; end if;
  v_trade_type:=nullif(btrim(coalesce(p_record->>'tradeType','')),'');
  if v_trade_type is not null and v_trade_type not in ('매입','매출','매입/매출','보관(냉동창고)') then raise exception '거래구분을 확인해주세요.'; end if;
  v_regno:=nullif(btrim(coalesce(p_record->>'regno','')),'');
  v_regnorm:=nullif(regexp_replace(coalesce(v_regno,''),'[^0-9]','','g'),'');
  if v_regnorm is not null and length(v_regnorm)<>10 then raise exception '사업자등록번호는 숫자 10자리로 입력해주세요.'; end if;
  v_email:=nullif(btrim(coalesce(p_record->>'email','')),'');
  if v_email is not null and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then raise exception '이메일 주소 형식을 확인해주세요.'; end if;
  begin
    v_due:=case when nullif(btrim(coalesce(p_record->>'paymentDueDays','')),'') is null then null else (p_record->>'paymentDueDays')::integer end;
    v_credit:=coalesce(nullif(btrim(coalesce(p_record->>'creditLimit','')),'')::numeric,0);
  exception when invalid_text_representation then raise exception '결제기일과 여신한도는 숫자로 입력해주세요.'; end;
  if v_due is not null and v_due not between 0 and 3650 then raise exception '결제기일은 0~3650일로 입력해주세요.'; end if;
  if v_credit<0 then raise exception '여신한도는 0원 이상이어야 합니다.'; end if;
  v_active:=coalesce((p_record->>'active')::boolean,true);
  if exists(select 1 from public.business_partners p where lower(p.name)=lower(v_name) and p.id is distinct from v_id) then raise exception '이미 등록된 거래처명입니다.'; end if;
  if exists(select 1 from public.business_partner_aliases a where lower(a.alias_name)=lower(v_name) and a.business_partner_id is distinct from v_id) then raise exception '다른 거래처의 이전 이름과 중복됩니다.'; end if;
  if v_regnorm is not null and exists(select 1 from public.business_partners p where p.registration_no_normalized=v_regnorm and p.id is distinct from v_id) then raise exception '이미 등록된 사업자등록번호입니다.'; end if;

  if v_id is null then
    v_id:=extensions.gen_random_uuid();
    v_code:='BP-'||lpad(nextval('public.business_partner_code_seq')::text,6,'0');
    insert into public.business_partners(
      id,code,name,trade_type,category,legal_name,business_registration_no,registration_no_normalized,
      representative_name,manager_name,manager_phone,phone,email,fax,fax_alt,address,business_type,
      business_items,payment_terms,payment_due_days,credit_limit,active
    ) values (
      v_id,v_code,v_name,v_trade_type,nullif(btrim(coalesce(p_record->>'category','')),''),nullif(btrim(coalesce(p_record->>'fullname','')),''),v_regno,v_regnorm,
      nullif(btrim(coalesce(p_record->>'ceo','')),''),nullif(btrim(coalesce(p_record->>'manager','')),''),nullif(btrim(coalesce(p_record->>'managerPhone','')),''),
      nullif(btrim(coalesce(p_record->>'phone','')),''),v_email,nullif(btrim(coalesce(p_record->>'fax','')),''),nullif(btrim(coalesce(p_record->>'faxAlt','')),''),
      nullif(btrim(coalesce(p_record->>'addr','')),''),nullif(btrim(coalesce(p_record->>'biz','')),''),nullif(btrim(coalesce(p_record->>'businessItems','')),''),
      nullif(btrim(coalesce(p_record->>'paymentTerms','')),''),v_due,v_credit,v_active
    );
  else
    delete from public.business_partner_aliases
    where business_partner_id=v_id and lower(alias_name)=lower(v_name);
    if lower(v_old.name)<>lower(v_name) and not exists(select 1 from public.business_partner_aliases where lower(alias_name)=lower(v_old.name)) then
      insert into public.business_partner_aliases(business_partner_id,alias_name) values(v_id,v_old.name);
    end if;
    update public.business_partners set
      name=v_name,trade_type=v_trade_type,category=nullif(btrim(coalesce(p_record->>'category','')),''),legal_name=nullif(btrim(coalesce(p_record->>'fullname','')),''),
      business_registration_no=v_regno,registration_no_normalized=v_regnorm,representative_name=nullif(btrim(coalesce(p_record->>'ceo','')),''),
      manager_name=nullif(btrim(coalesce(p_record->>'manager','')),''),manager_phone=nullif(btrim(coalesce(p_record->>'managerPhone','')),''),phone=nullif(btrim(coalesce(p_record->>'phone','')),''),
      email=v_email,fax=nullif(btrim(coalesce(p_record->>'fax','')),''),fax_alt=nullif(btrim(coalesce(p_record->>'faxAlt','')),''),address=nullif(btrim(coalesce(p_record->>'addr','')),''),
      business_type=nullif(btrim(coalesce(p_record->>'biz','')),''),business_items=nullif(btrim(coalesce(p_record->>'businessItems','')),''),
      payment_terms=nullif(btrim(coalesce(p_record->>'paymentTerms','')),''),payment_due_days=v_due,credit_limit=v_credit,active=v_active,
      revision=revision+1,updated_at=now()
    where id=v_id and revision=p_expected_revision returning * into v_new;
    if v_new.id is null then raise exception 'stale business partner revision'; end if;
  end if;

  update public.business_partner_identifiers set active=false,revision=revision+1,updated_at=now()
  where business_partner_id=v_id and active;
  if p_record ? 'identifiers' then
    if jsonb_typeof(p_record->'identifiers')<>'array' or jsonb_array_length(p_record->'identifiers')>20 then raise exception '기관 식별번호는 최대 20개까지 입력할 수 있습니다.'; end if;
    for v_identifier in select value from jsonb_array_elements(p_record->'identifiers') loop
      if btrim(coalesce(v_identifier->>'identifierValue',''))='' then continue; end if;
      if coalesce(v_identifier->>'provider','') !~ '^[a-z][a-z0-9_]{1,39}$'
        or coalesce(v_identifier->>'identifierType','') !~ '^[a-z][a-z0-9_]{1,59}$' then raise exception '기관 식별번호 코드 형식이 올바르지 않습니다.'; end if;
      insert into public.business_partner_identifiers(business_partner_id,provider,identifier_type,identifier_value,active)
      values(v_id,v_identifier->>'provider',v_identifier->>'identifierType',left(btrim(v_identifier->>'identifierValue'),200),true)
      on conflict (business_partner_id,provider,identifier_type) do update
      set identifier_value=excluded.identifier_value,active=true,revision=public.business_partner_identifiers.revision+1,updated_at=now();
    end loop;
  end if;

  select * into v_new from public.business_partners where id=v_id;
  v_partner:=public.dbmt_business_partner_json(v_id);
  v_map:=public.dbmt_refresh_trader_info_map();
  v_log:=jsonb_build_object(
    'id','cl_user_'||encode(extensions.gen_random_bytes(8),'hex'),'at',clock_timestamp(),
    'menu','거래처 관리','action',case when v_action='create' then '저장' else '수정' end,
    'target',v_name,'summary','거래처 정보 '||case when v_action='create' then '저장: ' else '수정: ' end||
      case when v_old.id is not null and v_old.name<>v_name then v_old.name||' → '||v_name else v_name end,
    'refId',v_id,'authMode','personal_session','userId',v_user.id,'userName',v_user.display_name,
    'userLoginId',v_user.login_id,'roleCode',v_role.code,'roleName',v_role.name
  );
  insert into public.app_data(key,payload,updated_at) values('dataChangeLogs','[]'::jsonb,now()) on conflict(key) do nothing;
  select case when jsonb_typeof(payload)='array' then payload else '[]'::jsonb end into v_logs from public.app_data where key='dataChangeLogs' for update;
  update public.app_data set payload=jsonb_build_array(v_log)||v_logs,updated_at=now() where key='dataChangeLogs';
  insert into public.change_logs(entity,action,entity_id,summary,payload)
  values('거래처 관리',case when v_action='create' then '등록' else '수정' end,v_id::text,v_name,
    jsonb_build_object('before',case when v_old.id is null then null else to_jsonb(v_old) end,'after',to_jsonb(v_new),'userId',v_user.id,'loginId',v_user.login_id,'roleCode',v_role.code,'authMode','personal_session'));
  update public.erp_user_sessions set last_used_at=now() where token_hash=encode(extensions.digest(coalesce(p_token,''),'sha256'),'hex');
  return jsonb_build_object('ok',true,'partner',v_partner,'traderInfoMap',v_map,'logEntry',v_log);
end;
$dbmt$;

create or replace function public.dbmt_erp_deactivate_business_partner(
  p_token text, p_id uuid, p_expected_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_user_id uuid:=public.dbmt_erp_session_user(p_token); v_user public.erp_users%rowtype; v_role public.erp_roles%rowtype;
  v_old public.business_partners%rowtype; v_new public.business_partners%rowtype; v_map jsonb; v_log jsonb; v_logs jsonb;
begin
  if v_user_id is null then return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.'); end if;
  if public.dbmt_erp_has_permission(p_token,'traders','delete') is not true then return public.dbmt_erp_permission_denied(v_user_id,'traders','delete'); end if;
  select * into v_old from public.business_partners where id=p_id for update;
  if v_old.id is null then raise exception '중지할 거래처를 찾을 수 없습니다.'; end if;
  if v_old.revision<>p_expected_revision then raise exception 'stale business partner revision'; end if;
  select * into v_user from public.erp_users where id=v_user_id; select * into v_role from public.erp_roles where id=v_user.role_id;
  update public.business_partners set active=false,revision=revision+1,updated_at=now()
  where id=p_id and revision=p_expected_revision returning * into v_new;
  if v_new.id is null then raise exception 'stale business partner revision'; end if;
  v_map:=public.dbmt_refresh_trader_info_map();
  v_log:=jsonb_build_object('id','cl_user_'||encode(extensions.gen_random_bytes(8),'hex'),'at',clock_timestamp(),
    'menu','거래처 관리','action','중지','target',v_old.name,'summary','거래처 사용 중지: '||v_old.name,'refId',p_id,
    'authMode','personal_session','userId',v_user.id,'userName',v_user.display_name,'userLoginId',v_user.login_id,'roleCode',v_role.code,'roleName',v_role.name);
  insert into public.app_data(key,payload,updated_at) values('dataChangeLogs','[]'::jsonb,now()) on conflict(key) do nothing;
  select case when jsonb_typeof(payload)='array' then payload else '[]'::jsonb end into v_logs from public.app_data where key='dataChangeLogs' for update;
  update public.app_data set payload=jsonb_build_array(v_log)||v_logs,updated_at=now() where key='dataChangeLogs';
  insert into public.change_logs(entity,action,entity_id,summary,payload) values('거래처 관리','중지',p_id::text,v_old.name,
    jsonb_build_object('before',to_jsonb(v_old),'after',to_jsonb(v_new),'userId',v_user.id,'loginId',v_user.login_id,'roleCode',v_role.code,'authMode','personal_session'));
  return jsonb_build_object('ok',true,'partner',public.dbmt_business_partner_json(p_id),'traderInfoMap',v_map,'logEntry',v_log);
end;
$dbmt$;

-- The normalized table is authoritative; old shared-password clients may not replace its projection.
create or replace function public.dbmt_import_app_data(p_password text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions
as $dbmt$
declare row_count integer:=0; payload_keys text[]:=array[]::text[];
begin
  if public.dbmt_check_password(p_password) is not true then raise exception 'invalid app password'; end if;
  if coalesce(p_payload,'{}'::jsonb) ? 'scheduleEvents' then raise exception '일정 변경은 개인 사용자 로그인이 필요합니다.'; end if;
  if coalesce(p_payload,'{}'::jsonb) ? 'traderInfoMap' then raise exception '거래처 변경은 개인 사용자 로그인이 필요합니다.'; end if;
  select count(*),coalesce(array_agg(e.key order by e.key),array[]::text[]) into row_count,payload_keys
  from jsonb_each(coalesce(p_payload,'{}'::jsonb)) e(key,value);
  if row_count>8 then raise exception 'bulk app data save blocked: refresh the ERP page before saving'; end if;
  insert into public.app_data(key,payload,updated_at) select key,value,now() from jsonb_each(coalesce(p_payload,'{}'::jsonb))
  on conflict(key) do update set payload=excluded.payload,updated_at=now();
  insert into public.change_logs(entity,action,summary,payload) values('migration','import_app_data','App data imported',jsonb_build_object('count',row_count,'keys',to_jsonb(payload_keys)));
  return jsonb_build_object('ok',true,'appData',row_count,'keys',to_jsonb(payload_keys));
end;
$dbmt$;

revoke all on function public.dbmt_business_partner_json(uuid) from public,anon,authenticated;
revoke all on function public.dbmt_refresh_trader_info_map() from public,anon,authenticated;
revoke all on function public.dbmt_assign_business_partner() from public,anon,authenticated;
revoke all on function public.dbmt_get_business_partners(text) from public;
revoke all on function public.dbmt_erp_save_business_partner(text,jsonb,bigint) from public;
revoke all on function public.dbmt_erp_deactivate_business_partner(text,uuid,bigint) from public;
grant execute on function public.dbmt_get_business_partners(text) to anon,authenticated;
grant execute on function public.dbmt_erp_save_business_partner(text,jsonb,bigint) to anon,authenticated;
grant execute on function public.dbmt_erp_deactivate_business_partner(text,uuid,bigint) to anon,authenticated;
grant execute on function public.dbmt_import_app_data(text,jsonb) to anon,authenticated;

notify pgrst,'reload schema';
