-- Production amounts are whole won.  Preserve all existing journals while
-- changing only future calculations from upward rounding to normal rounding.
-- These function bodies are layered by the production stock-row migration, so
-- replace the live inner functions without altering rows or stock balances.
do $dbmt$
declare
  v_def text;
  v_ceil text := 'ceil(public.dbmt_safe_numeric(e->>''qty'')*public.dbmt_safe_numeric(e->>''price''))';
  v_round text := 'round(public.dbmt_safe_numeric(e->>''qty'')*public.dbmt_safe_numeric(e->>''price''))';
begin
  select pg_get_functiondef('public.dbmt_erp_save_production_before_stock_rows(text,jsonb,jsonb,text)'::regprocedure)
    into v_def;
  if v_def is null then
    raise exception '생산일보 금액 계산 함수를 찾을 수 없습니다.';
  end if;
  if strpos(v_def, v_ceil) > 0 then
    execute replace(v_def, v_ceil, v_round);
  elsif strpos(v_def, v_round) = 0 then
    raise exception '생산일보 금액 계산 형식을 확인해주세요.';
  end if;
end;
$dbmt$;

do $dbmt$
declare
  v_def text;
  v_ceil text := 'ceil(v_price*public.dbmt_safe_numeric(e->>''qty''))';
  v_round text := 'round(v_price*public.dbmt_safe_numeric(e->>''qty''))';
begin
  select pg_get_functiondef('public.dbmt_label_complete_production(text,text,jsonb)'::regprocedure)
    into v_def;
  if v_def is null then
    raise exception '라벨 생산완료 금액 계산 함수를 찾을 수 없습니다.';
  end if;
  if strpos(v_def, v_ceil) > 0 then
    execute replace(v_def, v_ceil, v_round);
  elsif strpos(v_def, v_round) = 0 then
    raise exception '라벨 생산완료 금액 계산 형식을 확인해주세요.';
  end if;
end;
$dbmt$;

notify pgrst, 'reload schema';
