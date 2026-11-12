-- Journals are read from the existing stock postings, never posted a second time.
insert into public.erp_permission_catalog(menu_code,menu_name,sort_order)
values ('customer_ledger','거래처원장',82),('product_ledger','상품원장',83)
on conflict(menu_code) do nothing;
insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete)
select role_id,'customer_ledger',can_view,can_create,can_update,can_delete
from public.erp_role_permissions where menu_code='transactions'
on conflict(role_id,menu_code) do nothing;
insert into public.erp_role_permissions(role_id,menu_code,can_view)
select role_id,'product_ledger',can_view from public.erp_role_permissions where menu_code='stock'
on conflict(role_id,menu_code) do nothing;

create schema if not exists erp_ledger_private;
revoke all on schema erp_ledger_private from public;
create table erp_ledger_private.accounts(
  partner_id uuid primary key references public.business_partners(id),
  opening_date date not null,
  opening_ar numeric(16,0) not null check(opening_ar between 0 and 9999999999999),
  opening_ap numeric(16,0) not null check(opening_ap between 0 and 9999999999999),
  revision bigint not null default 1,
  updated_at timestamptz not null default clock_timestamp()
);
create table erp_ledger_private.entries(
  id uuid primary key,
  partner_id uuid not null references erp_ledger_private.accounts(partner_id),
  date date not null,
  kind text not null check(kind in ('receipt','payment')),
  amount numeric(16,0) not null check(amount between 1 and 9999999999999),
  note text not null default '' check(length(note)<=500),
  revision bigint not null default 1,
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz
);
create index ledger_entries_partner_date on erp_ledger_private.entries(partner_id,date,id) where deleted_at is null;
-- The FK also needs an index covering soft-deleted rows.
create index ledger_entries_partner on erp_ledger_private.entries(partner_id);
alter table erp_ledger_private.accounts enable row level security;
alter table erp_ledger_private.entries enable row level security;
revoke all on erp_ledger_private.accounts,erp_ledger_private.entries from public,anon,authenticated;

create function erp_ledger_private.snapshot(p_token text,p_kind text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if p_kind is null or p_kind not in ('customer','product') then raise exception '조회할 원장을 선택해주세요.';end if;
  perform public.dbmt_erp_authorize_legacy(p_token,case p_kind when 'customer' then 'customer_ledger' else 'product_ledger' end,'view');
  -- One statement: production descriptions, postings and settlements share a snapshot.
  return (select jsonb_build_object('ok',true,'loadedAt',clock_timestamp(),
    'partners',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'code',b.code,'name',b.name,'active',b.active,
      'aliases',coalesce((select jsonb_agg(a.alias_name) from public.business_partner_aliases a where a.business_partner_id=b.id),'[]'::jsonb)) order by b.name,b.id)
      from public.business_partners b),'[]'::jsonb),
    'products',coalesce((select payload from public.app_data where key='labelProducts'),'[]'::jsonb),
    'transactions',coalesce((select jsonb_agg((t.raw-'_serverAudit'-'_pdaRawBoxes')||jsonb_build_object(
      'id',t.id,'date',t.date,'type',t.type,'product',t.product,'trader',t.trader,
      'weight',t.weight,'price',t.price,'amount',t.amount,'_prodId',coalesce(t.prod_id,t.raw->>'_prodId'),
      'businessPartnerId',coalesce(t.business_partner_id::text,t.raw->>'businessPartnerId','')) order by t.date,t.id)
      from public.transactions t where t.deleted_at is null),'[]'::jsonb),
    'production',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'date',p.work_date,
      'job_no',p.raw->>'job_no','job_type',p.raw->>'job_type','note',p.raw->>'note') order by p.work_date,p.id)
      from public.production_entries p where p.deleted_at is null),'[]'::jsonb),
    'accounts',case when p_kind='customer' then coalesce((select jsonb_agg(to_jsonb(a)) from erp_ledger_private.accounts a),'[]'::jsonb) else '[]'::jsonb end,
    'entries',case when p_kind='customer' then coalesce((select jsonb_agg(to_jsonb(e) order by e.date,e.id)
      from erp_ledger_private.entries e where deleted_at is null),'[]'::jsonb) else '[]'::jsonb end));
end;$$;

create function erp_ledger_private.save_account(p_token text,p_partner uuid,p_date date,p_ar numeric,p_ap numeric,p_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid;old_row erp_ledger_private.accounts%rowtype;new_row erp_ledger_private.accounts%rowtype;
begin
  actor:=public.dbmt_erp_authorize_legacy(p_token,'customer_ledger','view');
  perform pg_advisory_xact_lock(hashtextextended('ledger:'||p_partner::text,0));
  select * into old_row from erp_ledger_private.accounts where partner_id=p_partner for update;
  perform public.dbmt_erp_authorize_legacy(p_token,'customer_ledger',case when old_row.partner_id is null then 'create' else 'update' end);
  if p_partner is null or not exists(select 1 from public.business_partners where id=p_partner) then raise exception '등록된 거래처를 선택해주세요.';end if;
  if p_date is null or p_ar is null or p_ap is null or p_ar<0 or p_ap<0 or p_ar>9999999999999 or p_ap>9999999999999
     or trunc(p_ar)<>p_ar or trunc(p_ap)<>p_ap then raise exception '기초일자와 0원 이상의 정수 잔액을 입력해주세요.';end if;
  if p_revision is distinct from old_row.revision then raise exception '다른 PC에서 기초잔액을 변경했습니다. 다시 조회해주세요.';end if;
  if exists(select 1 from erp_ledger_private.entries where partner_id=p_partner and deleted_at is null and date<p_date) then
    raise exception '등록된 수금·지급일보다 이후로 기초일자를 변경할 수 없습니다.';end if;
  insert into erp_ledger_private.accounts(partner_id,opening_date,opening_ar,opening_ap)
    values(p_partner,p_date,p_ar,p_ap)
    on conflict(partner_id) do update set opening_date=excluded.opening_date,opening_ar=excluded.opening_ar,
      opening_ap=excluded.opening_ap,revision=erp_ledger_private.accounts.revision+1,updated_at=clock_timestamp()
    returning * into new_row;
  insert into public.change_logs(entity,action,entity_id,summary,payload)
    values('거래처원장','기초잔액',p_partner::text,'거래처 기초잔액 저장',jsonb_build_object('userId',actor,
      'authMode','personal_session','before',case when old_row.partner_id is null then null else to_jsonb(old_row) end,'after',to_jsonb(new_row)));
  return jsonb_build_object('ok',true,'account',to_jsonb(new_row));
end;$$;

create function erp_ledger_private.save_entry(p_token text,p_id uuid,p_partner uuid,p_date date,p_kind text,p_amount numeric,p_note text,p_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid;old_row erp_ledger_private.entries%rowtype;new_row erp_ledger_private.entries%rowtype;start_date date;
begin
  actor:=public.dbmt_erp_authorize_legacy(p_token,'customer_ledger','view');
  if p_id is null or p_partner is null then raise exception '거래처와 등록번호를 확인해주세요.';end if;
  perform pg_advisory_xact_lock(hashtextextended('ledger:'||p_partner::text,0));
  select opening_date into start_date from erp_ledger_private.accounts where partner_id=p_partner for update;
  if start_date is null then raise exception '기초잔액을 먼저 등록해주세요. 확인된 잔액이 없으면 0원을 명시하여 등록할 수 있습니다.';end if;
  select * into old_row from erp_ledger_private.entries where id=p_id for update;
  perform public.dbmt_erp_authorize_legacy(p_token,'customer_ledger',case when p_revision is null then 'create' else 'update' end);
  if p_date is null or p_date<start_date then raise exception '수금·지급일은 기초일자 이후여야 합니다.';end if;
  if p_kind is null or p_kind not in ('receipt','payment') or p_amount is null or p_amount<1 or p_amount>9999999999999
     or trunc(p_amount)<>p_amount or length(coalesce(p_note,''))>500 then raise exception '구분, 1원 이상의 정수 금액, 500자 이내 비고를 확인해주세요.';end if;
  if old_row.id is not null and p_revision is null then
    -- A retry of the same creation is safe after a lost network response.
    if old_row.deleted_at is null and old_row.partner_id=p_partner and old_row.date=p_date and old_row.kind=p_kind
       and old_row.amount=p_amount and old_row.note=coalesce(p_note,'') then
      return jsonb_build_object('ok',true,'entry',to_jsonb(old_row));end if;
    raise exception '동일 등록번호가 이미 사용되었습니다. 다시 조회해주세요.';
  end if;
  if (p_revision is not null and old_row.id is null) or p_revision is distinct from old_row.revision
     or (old_row.id is not null and (old_row.partner_id<>p_partner or old_row.deleted_at is not null)) then
    raise exception '다른 PC에서 수금·지급 내역을 변경했습니다. 다시 조회해주세요.';end if;
  if old_row.id is null then
    insert into erp_ledger_private.entries(id,partner_id,date,kind,amount,note)
      values(p_id,p_partner,p_date,p_kind,p_amount,coalesce(p_note,'')) returning * into new_row;
  else
    update erp_ledger_private.entries set date=p_date,kind=p_kind,amount=p_amount,note=coalesce(p_note,''),
      revision=revision+1,updated_at=clock_timestamp() where id=p_id returning * into new_row;
  end if;
  insert into public.change_logs(entity,action,entity_id,summary,payload)
    values('거래처원장',case when old_row.id is null then '등록' else '수정' end,p_id::text,'수금·지급 내역 저장',
      jsonb_build_object('userId',actor,'authMode','personal_session','before',case when old_row.id is null then null else to_jsonb(old_row) end,'after',to_jsonb(new_row)));
  return jsonb_build_object('ok',true,'entry',to_jsonb(new_row));
end;$$;

create function erp_ledger_private.delete_entry(p_token text,p_id uuid,p_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid;old_row erp_ledger_private.entries%rowtype;
begin
  actor:=public.dbmt_erp_authorize_legacy(p_token,'customer_ledger','view');
  perform public.dbmt_erp_authorize_legacy(p_token,'customer_ledger','delete');
  select * into old_row from erp_ledger_private.entries where id=p_id for update;
  if old_row.id is null or p_revision is distinct from old_row.revision then raise exception '삭제할 내역이 변경되었습니다. 다시 조회해주세요.';end if;
  if old_row.deleted_at is not null then return jsonb_build_object('ok',true,'id',p_id);end if;
  update erp_ledger_private.entries set deleted_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_id;
  insert into public.change_logs(entity,action,entity_id,summary,payload)
    values('거래처원장','삭제',p_id::text,'수금·지급 내역 삭제',jsonb_build_object('userId',actor,'authMode','personal_session','before',to_jsonb(old_row)));
  return jsonb_build_object('ok',true,'id',p_id);
end;$$;

-- Public entry points remain invoker functions. Tables stay private and RLS-locked.
create function public.dbmt_erp_get_ledger_snapshot(p_token text,p_kind text)
returns jsonb language sql security invoker set search_path='' as $$select erp_ledger_private.snapshot(p_token,p_kind);$$;
create function public.dbmt_erp_save_ledger_account(p_token text,p_partner uuid,p_date date,p_ar numeric,p_ap numeric,p_revision bigint default null)
returns jsonb language sql security invoker set search_path='' as $$select erp_ledger_private.save_account(p_token,p_partner,p_date,p_ar,p_ap,p_revision);$$;
create function public.dbmt_erp_save_ledger_entry(p_token text,p_id uuid,p_partner uuid,p_date date,p_kind text,p_amount numeric,p_note text,p_revision bigint default null)
returns jsonb language sql security invoker set search_path='' as $$select erp_ledger_private.save_entry(p_token,p_id,p_partner,p_date,p_kind,p_amount,p_note,p_revision);$$;
create function public.dbmt_erp_delete_ledger_entry(p_token text,p_id uuid,p_revision bigint)
returns jsonb language sql security invoker set search_path='' as $$select erp_ledger_private.delete_entry(p_token,p_id,p_revision);$$;
revoke all on all functions in schema erp_ledger_private from public,anon,authenticated;
grant usage on schema erp_ledger_private to anon,authenticated;
grant execute on all functions in schema erp_ledger_private to anon,authenticated;
revoke all on function public.dbmt_erp_get_ledger_snapshot(text,text),public.dbmt_erp_save_ledger_account(text,uuid,date,numeric,numeric,bigint),
  public.dbmt_erp_save_ledger_entry(text,uuid,uuid,date,text,numeric,text,bigint),public.dbmt_erp_delete_ledger_entry(text,uuid,bigint) from public,anon,authenticated;
grant execute on function public.dbmt_erp_get_ledger_snapshot(text,text),public.dbmt_erp_save_ledger_account(text,uuid,date,numeric,numeric,bigint),
  public.dbmt_erp_save_ledger_entry(text,uuid,uuid,date,text,numeric,text,bigint),public.dbmt_erp_delete_ledger_entry(text,uuid,bigint) to anon,authenticated;
notify pgrst,'reload schema';
