-- Pin the helper's name resolution like the ERP's other public functions.
alter function public.dbmt_work_order_source_inputs(jsonb) set search_path=public,extensions;
