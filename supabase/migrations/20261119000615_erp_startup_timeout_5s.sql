-- Give the ERP startup read more time without raising the timeout for other RPCs.
alter function public.dbmt_erp_get_all(text, boolean) set statement_timeout = '5s';

notify pgrst, 'reload schema';
