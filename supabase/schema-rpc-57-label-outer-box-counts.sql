-- Each saved active outer-label record represents one produced box.
-- Inner labels are not saved to labelPrintLogs; reprints update an existing record.
-- Keep historical completed/edited journals unchanged. New completions and
-- generation-aware resubmissions derive box counts from their active log set.
do $migration$
declare
  v_definition text;
  v_old text;
  v_new text;
  v_index integer;
  v_patterns text[] := array[
    $old$jsonb_build_object('qty',sum(public.dbmt_safe_numeric(e->>'labelWeight')))$old$,
    $old$'qty',v_base->'qty','samsung'$old$,
    $old$(e-'qty') || jsonb_build_object('qty',sum(public.dbmt_safe_numeric(e->>'qty')))$old$,
    $old$group by e-'qty') g;$old$
  ];
  v_replacements text[] := array[
    $new$jsonb_build_object('qty',sum(public.dbmt_safe_numeric(e->>'labelWeight')),'boxCount',count(*))$new$,
    $new$'qty',v_base->'qty','boxCount',v_base->'boxCount','samsung'$new$,
    $new$(e-array['qty','boxCount']) || jsonb_build_object('qty',sum(public.dbmt_safe_numeric(e->>'qty')),'boxCount',sum(public.dbmt_safe_numeric(e->>'boxCount')))$new$,
    $new$group by e-array['qty','boxCount']) g;$new$
  ];
begin
  select pg_get_functiondef('public.dbmt_label_complete_production(text,text,jsonb)'::regprocedure)
    into v_definition;
  -- Replace only the output aggregation; preserve current source validation,
  -- product selection, PIN checks, advisory locking and duplicate guards.
  for v_index in 1..array_length(v_patterns,1) loop
    v_old := v_patterns[v_index];
    v_new := v_replacements[v_index];
    if position(v_new in v_definition)>0 then continue; end if;
    if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
      raise exception 'Unexpected label completion definition at box-count patch %',v_index;
    end if;
    v_definition := replace(v_definition,v_old,v_new);
  end loop;
  execute v_definition;
end;
$migration$;

revoke all on function public.dbmt_label_complete_production(text,text,jsonb) from public;
grant execute on function public.dbmt_label_complete_production(text,text,jsonb) to anon,authenticated;
notify pgrst, 'reload schema';
