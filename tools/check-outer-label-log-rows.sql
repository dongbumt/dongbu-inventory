-- Run after the outer-label migration, in a rollback-only database transaction.
-- The inner block also rolls back its temporary PIN and records on success.
do $check$
declare
  pin text := '0927';
  fixture text := 'qa_outer_' || replace(gen_random_uuid()::text,'-','');
  code_prefix text := 'DB9912312359-';
  order_a text := fixture || '_a';
  order_b text := fixture || '_b';
  work_a jsonb;
  work_b jsonb;
  label_a jsonb;
  label_b jsonb;
  label_a2 jsonb;
  label_a3 jsonb;
  label_a4 jsonb;
  reprint_a jsonb;
  void_a2 jsonb;
  response jsonb;
  revision_a bigint;
  revision_a2 bigint;
  revision_reprint bigint;
  physical_a text;
  physical_b text;
  physical_a2 text;
  archive_before text;
begin
  begin
    if has_table_privilege('anon','label_print_private.outer_print_logs','select')
      or has_table_privilege('authenticated','label_print_private.outer_print_logs','update') then
      raise exception 'Private history table is exposed';
    end if;
    select md5(payload::text)||':'||ctid::text||':'||xmin::text into archive_before
      from public.app_data where key='labelPrintLogs';

    insert into public.app_config(key,value,updated_at)
      values('label_print_pin_hash',extensions.crypt(pin,extensions.gen_salt('bf',4)),clock_timestamp())
      on conflict (key) do update set value=excluded.value,updated_at=excluded.updated_at;
    work_a:=jsonb_build_object('id',order_a,'date','2026-11-24','product','테스트 제품','lot','테스트-LOT',
      'origin','국내산','grade','','mfgdate','2026-11-24','inputWeight',100,
      'sourceStock',jsonb_build_object('product','테스트 원료','lot','테스트-LOT','origin','국내산'));
    work_b:=work_a||jsonb_build_object('id',order_b);
    insert into public.app_data(key,payload,updated_at)
      values('workOrders',jsonb_build_array(work_a,work_b),clock_timestamp())
      on conflict (key) do update set payload=public.app_data.payload||excluded.payload,updated_at=excluded.updated_at;
    label_a:=jsonb_build_object('id',fixture||'_a1','workOrderId',order_a,
      'code',code_prefix||upper(left(md5(fixture||'_a1'),6)),'product','테스트 제품','lot','테스트-LOT',
      'status','active','labelWeight',5,'reprintCount',0,
      'printedAt','2026-11-24T00:00:00Z','workOrderSnapshot',work_a||jsonb_build_object('weight',5));
    label_b:=label_a||jsonb_build_object('id',fixture||'_b1','workOrderId',order_b,
      'code',code_prefix||upper(left(md5(fixture||'_b1'),6)),'workOrderSnapshot',work_b||jsonb_build_object('weight',5));
    label_a2:=label_a||jsonb_build_object('id',fixture||'_a2','code',code_prefix||upper(left(md5(fixture||'_a2'),6)));
    label_a3:=label_a||jsonb_build_object('id',fixture||'_a3','code',code_prefix||upper(left(md5(fixture||'_a3'),6)));
    label_a4:=label_a3||jsonb_build_object('id',fixture||'_a4');

    response:=public.dbmt_label_print_get_data(pin,order_a);
    if response#>>'{logScope,revision}' is distinct from '0'
      or response#>'{appData,labelPrintLogs}' is distinct from '[]'::jsonb then
      raise exception 'Empty order must have an empty log set and revision zero';
    end if;
    response:=public.dbmt_label_print_save_logs_delta(pin,jsonb_build_array(label_a),order_a,0);
    revision_a:=(response#>>'{logScope,revision}')::bigint;
    if response->'ok' is distinct from 'true'::jsonb or response ? 'logs'
      or response#>>'{logScope,workOrderId}' is distinct from order_a
      or response->'changedLogs' is distinct from jsonb_build_array(label_a) or coalesce(revision_a,0)<=0 then
      raise exception 'First write did not return one canonical new record';
    end if;
    select ctid::text||':'||xmin::text||':'||revision into strict physical_a
      from label_print_private.outer_print_logs where id=label_a->>'id';

    response:=public.dbmt_label_print_save_logs_delta(pin,jsonb_build_array(label_b),order_b,0);
    if response->'changedLogs' is distinct from jsonb_build_array(label_b) then
      raise exception 'Separate order write was not scoped';
    end if;
    select ctid::text||':'||xmin::text||':'||revision into strict physical_b
      from label_print_private.outer_print_logs where id=label_b->>'id';
    response:=public.dbmt_label_print_save_logs_delta(pin,jsonb_build_array(label_a2),order_a,revision_a);
    revision_a2:=(response#>>'{logScope,revision}')::bigint;
    if response->'changedLogs' is distinct from jsonb_build_array(label_a2)
      or coalesce(revision_a2,0)<=revision_a then raise exception 'Follow-up write resent the previous label'; end if;
    if (select ctid::text||':'||xmin::text||':'||revision from label_print_private.outer_print_logs
      where id=label_a->>'id') is distinct from physical_a then raise exception 'Prior label row was rewritten'; end if;
    select ctid::text||':'||xmin::text||':'||revision into strict physical_a2
      from label_print_private.outer_print_logs where id=label_a2->>'id';

    response:=public.dbmt_label_print_save_logs_delta(pin,jsonb_build_array(label_a2),order_a,revision_a2);
    if response->'changedLogs' is distinct from jsonb_build_array(label_a2)
      or response#>>'{logScope,revision}' is distinct from revision_a2::text
      or (select ctid::text||':'||xmin::text||':'||revision from label_print_private.outer_print_logs
        where id=label_a2->>'id') is distinct from physical_a2 then
      raise exception 'Exact retry rewrote the label or lost the canonical response';
    end if;
    response:=public.dbmt_label_print_save_logs_delta(pin,jsonb_build_array(label_a2),order_a,0);
    if response->'changedLogs' is distinct from jsonb_build_array(label_a,label_a2) then
      raise exception 'A stale revision did not catch up in original history order';
    end if;

    reprint_a:=label_a||jsonb_build_object('reprintCount',1,'lastReprintedAt','2026-11-24T01:00:00Z');
    response:=public.dbmt_label_print_save_logs_delta(pin,jsonb_build_array(reprint_a),order_a,revision_a2);
    revision_reprint:=(response#>>'{logScope,revision}')::bigint;
    if response->'changedLogs' is distinct from jsonb_build_array(reprint_a)
      or coalesce(revision_reprint,0)<=revision_a2 then
      raise exception 'Reprint failed to preserve the original barcode and snapshot';
    end if;
    if (select ctid::text||':'||xmin::text||':'||revision from label_print_private.outer_print_logs
      where id=label_a2->>'id') is distinct from physical_a2 then raise exception 'Reprint rewrote unrelated label'; end if;

    void_a2:=label_a2||jsonb_build_object('status','void','voidedAt','2026-11-24T01:01:00Z','voidReason','테스트 취소');
    response:=public.dbmt_label_print_save_logs_delta(pin,jsonb_build_array(void_a2),order_a,revision_reprint);
    if response->'changedLogs' is distinct from jsonb_build_array(void_a2)
      or response->'logSummaries' is distinct from jsonb_build_array(jsonb_build_object(
        'workOrderId',order_a,'count',1,'totalCount',2,'weight',5)) then
      raise exception 'Void did not preserve the row and update the scoped totals';
    end if;
    response:=public.dbmt_label_print_save_logs_delta(pin,jsonb_build_array(label_a2),order_a,(response#>>'{logScope,revision}')::bigint);
    if response->'changedLogs' is distinct from jsonb_build_array(void_a2) then
      raise exception 'A stale retry resurrected an already void label';
    end if;
    response:=pda_private.resolve(label_a->>'code');
    if response->>'labelId' is distinct from label_a->>'id'
      or response->'weight' is distinct from '5'::jsonb
      or response->'_snapshot' is distinct from label_a->'workOrderSnapshot' then
      raise exception 'PDA barcode did not resolve to the original snapshot after reprint';
    end if;
    begin
      perform pda_private.resolve(label_a2->>'code');
      raise exception 'PDA resolved a voided label';
    exception when raise_exception then
      if position('삭제되었거나' in sqlerrm)=0 then raise; end if;
    end;

    begin
      perform public.dbmt_label_print_save_logs_delta(pin,jsonb_build_array(label_b),order_a,0);
      raise exception 'Scope mismatch was accepted';
    exception when raise_exception then
      if position('선택한 작업지시' in sqlerrm)=0 then raise; end if;
    end;
    begin
      perform public.dbmt_label_print_save_logs_delta(pin,jsonb_build_array(
        label_a||jsonb_build_object('labelWeight',10)),order_a,0);
      raise exception 'Label metadata overwrite was accepted';
    exception when raise_exception then
      if position('변경할 수 없습니다' in sqlerrm)=0 then raise; end if;
    end;
    begin
      perform public.dbmt_label_print_save_logs_delta(pin,jsonb_build_array(label_a3,label_a4),order_a,0);
      raise exception 'Duplicate barcode batch was accepted';
    exception when raise_exception then
      if position('중복된 라벨 고유번호' in sqlerrm)=0 then raise; end if;
    end;
    if exists(select 1 from label_print_private.outer_print_logs where id in (label_a3->>'id',label_a4->>'id')) then
      raise exception 'Duplicate barcode batch left a partial write';
    end if;
    begin
      perform public.dbmt_label_print_save_logs_delta('0000',jsonb_build_array(label_a3),order_a,0);
      raise exception 'Unauthenticated write was accepted';
    exception when raise_exception then
      if position('PIN' in sqlerrm)=0 then raise; end if;
    end;

    response:=public.dbmt_label_print_get_data(pin,order_a);
    if response#>'{appData,labelPrintLogs}' is distinct from jsonb_build_array(reprint_a,void_a2)
      or (public.dbmt_label_print_save_logs(pin,'[]'::jsonb,order_a))->'logs' is distinct from jsonb_build_array(reprint_a,void_a2)
      or ((public.dbmt_label_print_save_logs(pin,'[]'::jsonb))->'logs' @> jsonb_build_array(reprint_a,void_a2,label_b)) is distinct from true then
      raise exception 'Legacy reader or writer response lost persisted history';
    end if;
    if (select ctid::text||':'||xmin::text||':'||revision from label_print_private.outer_print_logs
      where id=label_b->>'id') is distinct from physical_b then raise exception 'Unrelated order was rewritten'; end if;
    if (select md5(payload::text)||':'||ctid::text||':'||xmin::text from public.app_data
      where key='labelPrintLogs') is distinct from archive_before then raise exception 'Historical archive was rewritten'; end if;

    raise exception using errcode='ZX001',message='Rollback successful outer-label verification fixtures';
  exception when sqlstate 'ZX001' then
    raise notice 'PASS: delta, scoped catch-up, retry, preserved physical rows and archive, reprint, void, and atomic validation';
  end;
end;
$check$;

-- Run after the outer-label migration. QA fixtures and the temporary PIN are
-- enclosed in a subtransaction that always rolls back, even on success.
do $reader_qa$
declare
  prefix text:='qor_'||substr(replace(gen_random_uuid()::text,'-',''),1,10);
  qa_role uuid:=gen_random_uuid();
  qa_user uuid:=gen_random_uuid();
  qa_token text:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
  qa_pin text:='0927';
  d date:=(now() at time zone 'Asia/Seoul')::date;
  order_id text:=prefix||'_order';
  child_id text:=prefix||'_child';
  source_id text:=prefix||'_raw_stock';
  product_id text:=prefix||'_master';
  product_name text:=prefix||'_product';
  barcode_a text:='DB'||to_char(d,'YYMMDD')||'1159-A'||upper(substr(md5(prefix||'a'),1,5));
  barcode_b text:='DB'||to_char(d,'YYMMDD')||'1159-B'||upper(substr(md5(prefix||'b'),1,5));
  barcode_c text:='DB'||to_char(d,'YYMMDD')||'1159-C'||upper(substr(md5(prefix||'c'),1,5));
  a_id text:=prefix||'_a';
  b_id text:=prefix||'_b';
  c_id text:=prefix||'_c';
  order_row jsonb;
  child_order jsonb;
  a jsonb;
  b jsonb;
  c jsonb;
  status jsonb;
  production_key text;
  completed_ids jsonb;
  posted_stock text;
begin
  begin
    update public.app_config set value=extensions.crypt(qa_pin,extensions.gen_salt('bf'))
      where key='label_print_pin_hash';
    if not found then raise exception 'QA setup: label PIN not initialized'; end if;

    insert into public.erp_roles(id,code,name) values(qa_role,prefix,'Outer readers QA');
    insert into public.erp_users(id,login_id,display_name,password_hash,role_id)
      values(qa_user,prefix,'Outer readers QA','unused',qa_role);
    insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete)
      select qa_role,menu,true,true,true,true
      from unnest(array['pda','production','transactions','stock','label','workorders']) menu;
    insert into public.erp_user_sessions(token_hash,user_id,expires_at)
      values(encode(extensions.digest(qa_token,'sha256'),'hex'),qa_user,now()+interval '10 minutes');

    insert into public.transactions(id,date,type,product,origin,lot,weight,price,amount,stock_location,raw)
      values(prefix||'_raw_receipt',d,'입고',prefix||'_raw','국내산','RAW',100,1000,100000,'가공장',
        jsonb_build_object('id',prefix||'_raw_receipt','date',d,'type','입고','product',prefix||'_raw',
          'origin','국내산','lot','RAW','weight',100,'price',1000,'amount',100000,'stockRowId',source_id,
          'stockLocation','가공장','_isUser',true));
    order_row:=jsonb_build_object('id',order_id,'date',d,'product',product_name,'labelProductId',product_id,
      'inputWeight',100,'weight',20,'lot','QA-LOT','origin','국내산','packunit','20KG','grade','',
      'mfgdate',d,'expdate',d+364,'temptype','냉동',
      'sourceStock',jsonb_build_object('key',prefix||'_raw','stockRowId',source_id,'stockLocation','가공장',
        'product',prefix||'_raw','price',1000,'stock',100,'origin','국내산','lot','RAW'));
    child_order:=order_row||jsonb_build_object('id',child_id,'_carryoverFrom',jsonb_build_object('id',order_id));
    update public.app_data set payload=payload||jsonb_build_array(order_row,child_order)
      where key='workOrders';
    update public.app_data set payload=payload||jsonb_build_array(jsonb_build_object(
      'id',product_id,'name',product_name,'taxType','면세','packunit','20KG')) where key='labelProducts';

    a:=jsonb_build_object('id',a_id,'code',barcode_a,'workOrderId',order_id,'product',product_name,
      'lot','QA-LOT','labelWeight',20,'inputWeight',100,'status','active','sizeKey','7x10',
      'printedAt',now(),'reprintCount',0,'workOrderSnapshot',order_row);
    b:=a||jsonb_build_object('id',b_id,'code',barcode_b);
    c:=a||jsonb_build_object('id',c_id,'code',barcode_c,'workOrderId',child_id,
      'workOrderSnapshot',child_order||jsonb_build_object('historicalSource',jsonb_build_object('stockRowId',prefix||'_only_in_label')));
    insert into label_print_private.outer_print_logs(id,work_order_id,code,data)
      values(a_id,order_id,barcode_a,a),(b_id,order_id,barcode_b,b),(c_id,child_id,barcode_c,c);

    status:=public.dbmt_work_order_carry_state(order_id);
    if status->>'labelBoxes' is distinct from '2' or (status->>'labelKg')::numeric is distinct from 40
      or status->>'canCarry' is distinct from 'false' then
      raise exception 'QA carry state: normalized label count/weight or completion guard did not match';
    end if;
    if pda_private.raw_receipt_has_dependencies(array[prefix||'_only_in_label'],array[]::text[]) is distinct from true then
      raise exception 'QA raw receipt: a reference confined to a normalized label snapshot was missed';
    end if;
    begin
      perform public.dbmt_erp_cancel_work_order_carryover(qa_token,child_id,md5(child_order::text));
      raise exception 'QA carry cancellation: printed child was cancellable' using errcode='PZ002';
    exception when raise_exception then
      if sqlerrm not like '%이미 라벨 출력%' then raise; end if;
    end;

    status:=public.dbmt_pda_lookup(qa_token,pda_private.print_code(barcode_a))->'item';
    if status->>'labelId' is distinct from a_id or status->>'code' is distinct from barcode_a
      or status->>'productionPending' is distinct from 'true' or (status->>'weight')::numeric is distinct from 20 then
      raise exception 'QA pending PDA lookup: normalized barcode or snapshot was missed';
    end if;
    status:=public.dbmt_pda_commit(qa_token,gen_random_uuid(),'inbound','가공장',null,d,
      jsonb_build_array(jsonb_build_object('barcode',barcode_a,'revision',(status->>'revision')::integer)),'Outer readers QA');
    if status->>'count' is distinct from '1' or not exists(
      select 1 from pda_private.pending_product_labels where label_id=a_id and resolved_at is null) then
      raise exception 'QA PDA: an actual pending package was not linked to the printed label';
    end if;
    begin
      perform public.dbmt_label_print_save_logs(qa_pin,jsonb_build_array(a||'{"status":"void"}'::jsonb),order_id);
      raise exception 'QA pending PDA: void was accepted' using errcode='PZ002';
    exception when raise_exception then
      if sqlerrm not like '%가출고%' and sqlerrm not like '%입고 확인%' then raise; end if;
    end;

    status:=public.dbmt_label_complete_production_reviewed(qa_pin,order_id,jsonb_build_array(a_id,b_id),null);
    production_key:=status->>'productionId';
    select log_ids into completed_ids from public.label_production_completions where production_id=production_key;
    if production_key is null or completed_ids is distinct from jsonb_build_array(a_id,b_id) then
      raise exception 'QA production completion: the normalized label IDs did not reach the journal';
    end if;
    status:=public.dbmt_pda_lookup(qa_token,barcode_a)->'item';
    posted_stock:=status->>'stockRowId';
    if status->>'labelId' is distinct from a_id or status->>'costStatus' is distinct from 'final'
      or status->>'registered' is distinct from 'true' or posted_stock is null then
      raise exception 'QA completed PDA lookup: existing barcode, registered package, or cost was lost';
    end if;
    if (select count(*) from label_stock_private.assignments(production_key) l
      where l.stock_row_id=posted_stock and l.problem is null and l.label->>'id' in (a_id,b_id))<>2 then
      raise exception 'QA label-to-stock assignments: production labels no longer map to the same stock row';
    end if;

    status:=public.dbmt_label_weight_search(null,qa_token,barcode_b,'가공장',product_name,0);
    if status->>'count' is distinct from '1' or status#>>'{rows,0,code}' is distinct from barcode_b then
      raise exception 'QA weight split search: completed normalized barcode was missed';
    end if;
    status:=public.dbmt_label_weight_split(null,qa_token,gen_random_uuid(),barcode_b,0,'가공장','[5,15]');
    if jsonb_array_length(status->'labels') is distinct from 2
      or status#>'{labels,0,workOrderSnapshot}' is distinct from order_row
      or status#>'{labels,1,workOrderSnapshot}' is distinct from order_row then
      raise exception 'QA weight split: original label snapshot was not reused';
    end if;
    begin
      perform public.dbmt_label_print_save_logs(qa_pin,jsonb_build_array(b||'{"reprintCount":1}'::jsonb),order_id);
      raise exception 'QA split root: reprint was accepted' using errcode='PZ002';
    exception when raise_exception then
      if sqlerrm not like '%분할 완료%' then raise; end if;
    end;
    if (select l.data from label_print_private.outer_print_logs l where l.id=b_id) is distinct from b then
      raise exception 'QA split root: original barcode or snapshot was changed';
    end if;

    raise notice 'PASS: normalized PDA lookup/registration, pending void guard, production linkage, carry guards, stock assignments and weight split.';
    raise exception 'Rollback outer reader fixtures' using errcode='PZ001';
  exception when sqlstate 'PZ001' then
    null;
  end;
end $reader_qa$;
