-- New labels use the confirmed slaughterhouse on the work order.
-- Existing label updates keep their original immutable snapshot.
create or replace function label_print_private.validate_blend_label_snapshot(p_order jsonb,p_snapshot jsonb)
returns void language plpgsql security invoker set search_path='' as $function$
begin
  if regexp_replace(normalize(coalesce(p_snapshot->>'product',''),NFKC),U&'[[:space:]\FEFF]+','','g')<>'우민찌(지방15%)' then
    if p_snapshot ? 'slaughterhouseName' or p_snapshot ? 'slaughterhouseLot' then
      raise exception '이 품목의 라벨에는 도축장 정보를 적용할 수 없습니다.';
    end if;
    return;
  end if;

  if jsonb_typeof(p_order->'slaughterhouseName') is distinct from 'string'
    or jsonb_typeof(p_order->'slaughterhouseLot') is distinct from 'string'
    or regexp_replace(p_order->>'slaughterhouseName',U&'[[:space:]\FEFF]+','','g')=''
    or regexp_replace(p_order->>'slaughterhouseLot',U&'[[:space:]\FEFF]+','','g')='' then
    raise exception '우민찌 작업지시의 한우지방 이력번호와 도축장을 확인해주세요.';
  end if;

  if p_order->'slaughterhouseName' is distinct from p_snapshot->'slaughterhouseName'
    or p_order->'slaughterhouseLot' is distinct from p_snapshot->'slaughterhouseLot' then
    raise exception '우민찌 작업지시의 한우지방 정보가 변경되었습니다. 새로고침 후 출력하세요.';
  end if;
end;
$function$;

revoke all on function label_print_private.validate_blend_label_snapshot(jsonb,jsonb) from public,anon,authenticated,service_role;

-- Insert after existing product/lot checks and only before a fresh label write.
do $migration$
declare
  patch record;
  definition text;
begin
  for patch in
    select * from (values
      ('label_print_private.save_log_batch(text,jsonb,text)'::regprocedure,
       'v_batch_added := array_append(v_batch_added,v_new);',
       'perform label_print_private.validate_blend_label_snapshot(v_order,v_new->''workOrderSnapshot'');'),
      ('public.dbmt_label_save_inner_prints(text,jsonb)'::regprocedure,
       'insert into label_print_private.inner_print_logs(id,work_order_id,code,lot,weight,status,data)',
       'perform label_print_private.validate_blend_label_snapshot(v_order,v_log->''workOrderSnapshot'');')
    ) as patches(signature,anchor,validation)
  loop
    definition := pg_get_functiondef(patch.signature);
    if strpos(definition,patch.validation)>0 then continue; end if;
    if (length(definition)-length(replace(definition,patch.anchor,'')))/length(patch.anchor)<>1 then
      raise exception 'Unexpected label save definition: %',patch.signature;
    end if;
    execute replace(definition,patch.anchor,patch.validation||E'\n    '||patch.anchor);
  end loop;
end;
$migration$;
