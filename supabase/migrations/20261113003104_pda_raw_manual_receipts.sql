-- Manual boxes join the same atomic receipt as scanned boxes. No free-text reason is required.
create table pda_private.raw_manual_labels(
  barcode text primary key check(barcode ~ '^DR1[0-9]{26}$'),
  input_weight numeric not null check(input_weight>0 and input_weight<=10000 and input_weight=round(input_weight,6)),
  input_unit text not null check(input_unit in ('KG','LB')),
  weight numeric(16,2) not null check(weight>0 and weight<=1000),
  user_id uuid not null references public.erp_users(id),
  request_id uuid not null references pda_private.raw_batches(id) deferrable initially deferred,
  created_at timestamptz not null default clock_timestamp(),
  check(weight=round(input_weight*case when input_unit='LB' then 0.45359237 else 1 end,2))
);
create index idx_raw_manual_labels_user on pda_private.raw_manual_labels(user_id);
create index idx_raw_manual_labels_request on pda_private.raw_manual_labels(request_id);
alter table pda_private.raw_manual_labels enable row level security;
revoke all on pda_private.raw_manual_labels from public,anon,authenticated;

create function pda_private.raw_manual_parse(p_code text,p_rule text)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v text:=btrim(coalesce(p_code,''),E' \r\n\t'); m pda_private.raw_manual_labels%rowtype;
begin
  if left(v,3) in (']C0',']C1',']d2',']Q3',']I0') then v:=substr(v,4);end if;
  if left(v,3)='DR1' or p_rule='manual:v1' then
    if v !~ '^DR1[0-9]{26}$' or coalesce(p_rule,'manual:v1')<>'manual:v1' then
      raise exception '수기입고 내부바코드를 확인해주세요.';end if;
    select * into m from pda_private.raw_manual_labels where barcode=v;
    if not found then raise exception '입고 저장되지 않은 수기입고 내부바코드입니다.';end if;
    return jsonb_build_object('id',encode(extensions.digest('MANUAL:'||v,'sha256'),'hex'),
      'code',v,'ruleKey','manual:v1','rule','바코드 훼손 수기입고',
      'weight',m.weight,'calculatedWeight',m.weight,'sourceWeight',m.input_weight,
      'manualWeight',m.input_weight,'manualUnit',m.input_unit,
      'conversion',case when m.input_unit='LB' then 0.45359237 else 1 end,'requiresReview',false,
      'fields','{}'::jsonb,'gtin',null,'barcodeLot',null,'mfgdate',null,'expdate',null);
  end if;
  raise exception '수기입고 내부바코드를 확인해주세요.';
end;
$$;
revoke all on function pda_private.raw_manual_parse(text,text) from public,anon,authenticated;

do $patch$
declare d text;a text:=E'begin\n';
begin
  select replace(pg_get_functiondef('pda_private.raw_parse(text,text)'::regprocedure),E'\r\n',E'\n') into d;
  if position(a in d)=0 or position('raw_manual_parse' in d)>0 then raise exception 'Unexpected raw parser';end if;
  execute replace(d,a,a||$body$
  if p_rule='manual:v1' or regexp_replace(btrim(coalesce(p_code,''),E' \r\n\t'),'^\](C0|C1|d2|Q3|I0)','') ~ '^DR1' then
    return pda_private.raw_manual_parse(p_code,p_rule);end if;
$body$);
end $patch$;

alter function public.dbmt_pda_raw_commit(text,uuid,text,text,uuid,date,jsonb,text,text,text,numeric,text)
  rename to raw_commit_before_manual;
alter function public.raw_commit_before_manual(text,uuid,text,text,uuid,date,jsonb,text,text,text,numeric,text)
  set schema pda_private;
revoke all on function pda_private.raw_commit_before_manual(text,uuid,text,text,uuid,date,jsonb,text,text,text,numeric,text) from public,anon,authenticated;

create function public.dbmt_pda_raw_commit(p_token text,p_request_id uuid,p_mode text,p_location text,
  p_trader_id uuid,p_date date,p_items jsonb,p_product_id text default null,p_lot text default '',
  p_source_id text default null,p_price numeric default 0,p_note text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare usr uuid:=pda_private.authorize(p_token,true); item jsonb; normalized jsonb:='[]'::jsonb;
  v_result jsonb; code text; amount numeric; unit text; w numeric; m pda_private.raw_manual_labels%rowtype;
begin
  if p_request_id is null or p_mode is null or p_mode not in ('inbound','outbound')
    or jsonb_typeof(p_items) is distinct from 'array' then raise exception '입출고 목록을 확인해주세요.';end if;
  if jsonb_array_length(p_items) not between 1 and 200 then raise exception '1~200박스씩 처리해주세요.';end if;
  perform pg_advisory_xact_lock(36100910);
  for item in select i from jsonb_array_elements(p_items) i loop
    if item->>'rule'='manual:v1' and p_mode='inbound' then
      code:=item->>'barcode';unit:=item->>'manualUnit';
      if jsonb_typeof(item) is distinct from 'object' or code is null or code !~ '^DR1[0-9]{26}$'
        or unit is null or unit not in ('KG','LB') or jsonb_typeof(item->'manualWeight') is distinct from 'number'
        or item-array['barcode','revision','rule','labelWeight','checked','manualWeight','manualUnit']<>'{}'::jsonb then
        raise exception '수기입고 중량과 단위를 확인해주세요.';end if;
      amount:=(item->>'manualWeight')::numeric;
      if amount<=0 or amount>10000 or amount<>round(amount,6) then raise exception '수기입고 중량을 확인해주세요.';end if;
      w:=round(amount*case when unit='LB' then 0.45359237 else 1 end,2);
      if w<=0 or w>1000 or jsonb_typeof(item->'labelWeight') is distinct from 'number'
        or (item->>'labelWeight')::numeric is distinct from w then
        raise exception '수기입고 KG 환산중량(소수점 둘째 자리)을 확인해주세요.';end if;
      select * into m from pda_private.raw_manual_labels where barcode=code;
      if found then
        if m.input_weight<>amount or m.input_unit<>unit or m.weight<>w then
          raise exception '발급된 내부바코드의 원입력 중량·단위는 변경할 수 없습니다.';end if;
      else
        insert into pda_private.raw_manual_labels(barcode,input_weight,input_unit,weight,user_id,request_id)
          values(code,amount,unit,w,usr,p_request_id);
      end if;
      normalized:=normalized||jsonb_build_array(item-array['manualWeight','manualUnit']);
    else normalized:=normalized||jsonb_build_array(item);end if;
  end loop;
  v_result:=pda_private.raw_commit_before_manual(p_token,p_request_id,p_mode,p_location,p_trader_id,p_date,
    normalized,p_product_id,p_lot,p_source_id,p_price,p_note);
  if v_result->>'alreadySaved'='true' then return v_result;end if;
  -- Persist printable identifiers in the result/history, never issue a second stock movement for printing.
  select v_result||jsonb_build_object('items',jsonb_agg(i||case when ml.barcode is not null then
    jsonb_build_object('barcode',ml.barcode,'manualWeight',ml.input_weight,'manualUnit',ml.input_unit,
      'entryKind','manual','entryReason','바코드 훼손 수기입고') else '{}'::jsonb end order by n)) into v_result
    from jsonb_array_elements(v_result->'items') with ordinality a(i,n)
    left join pda_private.raw_packages p on p.id=i->>'id'
    left join pda_private.raw_manual_labels ml on ml.barcode=p.barcode;
  update pda_private.raw_batches b set result=v_result where b.id=p_request_id;
  return v_result;
end;
$$;
revoke all on function public.dbmt_pda_raw_commit(text,uuid,text,text,uuid,date,jsonb,text,text,text,numeric,text) from public,anon,authenticated;
grant execute on function public.dbmt_pda_raw_commit(text,uuid,text,text,uuid,date,jsonb,text,text,text,numeric,text) to anon,authenticated;
notify pgrst,'reload schema';
