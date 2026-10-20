-- Optional account text; preserve existing records and older client updates.
alter table public.business_partners add column if not exists bank_account text;
do $constraint$
begin
  if not exists(select 1 from pg_constraint where conrelid='public.business_partners'::regclass and conname='business_partners_bank_account_valid') then
    alter table public.business_partners add constraint business_partners_bank_account_valid
      check (bank_account is null or (bank_account=btrim(bank_account) and char_length(bank_account)<=300));
  end if;
end;
$constraint$;
comment on column public.business_partners.bank_account is '거래계좌: 은행명 / 계좌번호 / 예금주 (선택 입력)';

CREATE OR REPLACE FUNCTION public.dbmt_business_partner_json(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
    'bankAccount', coalesce(p.bank_account,''),
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
$function$;

CREATE OR REPLACE FUNCTION public.dbmt_erp_save_business_partner(p_token text, p_record jsonb, p_expected_revision bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_user_id uuid := public.dbmt_erp_session_user(p_token);
  v_user public.erp_users%rowtype; v_role public.erp_roles%rowtype;
  v_old public.business_partners%rowtype; v_new public.business_partners%rowtype;
  v_id uuid; v_action text; v_name text; v_code text; v_trade_type text;
  v_regno text; v_regnorm text; v_email text; v_active boolean;
  v_due integer; v_credit numeric; v_identifier jsonb; v_map jsonb; v_bank_account text;
  v_log jsonb; v_logs jsonb; v_partner jsonb;
begin
  if v_user_id is null then return jsonb_build_object('ok',false,'code','session_expired','message','개인 사용자 로그인이 만료되었습니다.'); end if;
  if jsonb_typeof(coalesce(p_record,'{}'::jsonb)) <> 'object' then raise exception '거래처 입력 형식이 올바르지 않습니다.'; end if;
  if exists (select 1 from jsonb_object_keys(coalesce(p_record,'{}'::jsonb)) k
    where k not in ('id','name','tradeType','category','fullname','regno','ceo','manager','managerPhone','phone','email','fax','faxAlt','addr','biz','businessItems','paymentTerms','bankAccount','paymentDueDays','creditLimit','active','identifiers')) then
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
  -- Older browser versions omit bankAccount; preserve it on their updates.
  if p_record ? 'bankAccount' and jsonb_typeof(p_record->'bankAccount') not in ('string','null') then
    raise exception '거래계좌는 문자로 입력해주세요.'; end if;
  v_bank_account:=case when p_record ? 'bankAccount' then nullif(btrim(coalesce(p_record->>'bankAccount','')),'') else v_old.bank_account end;
  if char_length(v_bank_account)>300 then raise exception '거래계좌는 300자 이내로 입력해주세요.'; end if;
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
      business_items,payment_terms,payment_due_days,credit_limit,active,bank_account
    ) values (
      v_id,v_code,v_name,v_trade_type,nullif(btrim(coalesce(p_record->>'category','')),''),nullif(btrim(coalesce(p_record->>'fullname','')),''),v_regno,v_regnorm,
      nullif(btrim(coalesce(p_record->>'ceo','')),''),nullif(btrim(coalesce(p_record->>'manager','')),''),nullif(btrim(coalesce(p_record->>'managerPhone','')),''),
      nullif(btrim(coalesce(p_record->>'phone','')),''),v_email,nullif(btrim(coalesce(p_record->>'fax','')),''),nullif(btrim(coalesce(p_record->>'faxAlt','')),''),
      nullif(btrim(coalesce(p_record->>'addr','')),''),nullif(btrim(coalesce(p_record->>'biz','')),''),nullif(btrim(coalesce(p_record->>'businessItems','')),''),
      nullif(btrim(coalesce(p_record->>'paymentTerms','')),''),v_due,v_credit,v_active,v_bank_account
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
      bank_account=v_bank_account,revision=revision+1,updated_at=now()
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
$function$;

notify pgrst,'reload schema';
