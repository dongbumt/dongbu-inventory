-- Preserve the current save RPC and include gender/grade in its duplicate check.
do $migration$
declare
  definition text := pg_get_functiondef('public.dbmt_erp_save_label_product(text,jsonb)'::regprocedure);
  brand_check constant text := $sql$and lower(btrim(coalesce(e->>'brand','')))=lower(coalesce(v_brand,''))$sql$;
  grade_check constant text := $sql$and lower(regexp_replace(coalesce(e->>'grade',''), '[[:space:]]+', '', 'g')) = lower(regexp_replace(coalesce(v_grade,''), '[[:space:]]+', '', 'g'))$sql$;
begin
  if length(definition) - length(replace(definition, brand_check, '')) <> length(brand_check)
    or strpos(definition, grade_check) > 0 then
    raise exception 'Unexpected product save duplicate check';
  end if;
  execute replace(definition, brand_check, brand_check || chr(10) || '      ' || grade_check);
end;
$migration$;
