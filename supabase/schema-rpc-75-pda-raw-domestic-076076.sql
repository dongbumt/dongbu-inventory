-- Photo-verified domestic ITF/QR payload 07607600224004601707009477: 17.07KG.
-- Add only the verified 076076 prefix; keep parser identity, historical rules and traceability separate.
create or replace function pda_private.raw_parse(p_code text,p_rule text default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare
  v text:=pda_private.raw_code(p_code); s text; ai text; val text; n integer; lim integer;
  fields jsonb:='{}'::jsonb; r jsonb; w numeric; source numeric; factor numeric:=1;
  rule text; key text; gtin text; barcode_lot text; mfg text; expiry text; review boolean:=false;
  check_sum integer; i integer; weights integer:=0; is_gs boolean:=left(v,2) in ('00','01','02');
begin
  if is_gs then
    if coalesce(p_rule,'') not in ('','gs1') then raise exception 'GS1 바코드는 GS1 자동 판독을 선택해주세요.'; end if;
    s:=v;
    while s<>'' loop
      if left(s,1)=chr(29) then s:=substr(s,2);continue; end if;
      ai:=left(s,2); lim:=null; n:=null;
      if ai='00' then n:=18;
      elsif ai in ('01','02') then n:=14;
      elsif ai in ('11','13','15','16','17') then n:=6;
      elsif ai='20' then n:=2;
      elsif left(s,4) ~ '^(310|320|330)[0-5]$' then ai:=left(s,4);n:=6;
      elsif ai in ('10','21') then lim:=20;
      elsif ai in ('30','37') then lim:=8;
      elsif ai ~ '^9[0-9]$' then lim:=30;
      elsif left(s,3) in ('240','241','250','251') then ai:=left(s,3);lim:=30;
      else raise exception '아직 지원하지 않거나 구분자가 없는 GS1 항목입니다: %',left(s,4); end if;
      s:=substr(s,length(ai)+1);
      if n is not null then
        val:=left(s,n);if length(val)<>n or val !~ '^[0-9]+$' then raise exception 'GS1 고정 항목 길이를 확인해주세요: %',ai; end if;
        s:=substr(s,n+1);
      else
        val:=split_part(s,chr(29),1);
        if length(val) not between 1 and lim then raise exception 'GS1 가변 항목 구분자와 길이를 확인해주세요: %',ai; end if;
        s:=substr(s,length(val)+1);
      end if;
      if fields ? ai then raise exception '중복된 GS1 항목입니다: %',ai; end if;
      fields:=fields||jsonb_build_object(ai,val);
      if ai in ('00','01','02') then
        check_sum:=0;
        for i in 1..length(val)-1 loop check_sum:=check_sum+substr(val,i,1)::integer*case when (length(val)-i)%2=1 then 3 else 1 end; end loop;
        if (10-check_sum%10)%10<>right(val,1)::integer then raise exception 'GTIN/SSCC 체크숫자가 일치하지 않습니다.'; end if;
      end if;
      if left(ai,3) in ('310','320') then
        weights:=weights+1;source:=val::numeric/power(10,right(ai,1)::integer);
        factor:=case when left(ai,3)='320' then 0.45359237 else 1 end;
        w:=round(source*factor,2); rule:='GS1 '||ai; review:=left(ai,3)='320';
      end if;
    end loop;
    if weights<>1 or not(fields ? '01' or fields ? '02') then raise exception 'GS1 품목번호와 순중량(310n/320n)을 하나씩 포함한 박스 바코드가 필요합니다.'; end if;
    gtin:=coalesce(fields->>'01',fields->>'02');barcode_lot:=fields->>'10';
    mfg:=pda_private.raw_date(coalesce(fields->>'11',fields->>'13'));
    expiry:=pda_private.raw_date(coalesce(fields->>'17',fields->>'15'));
    key:=case when fields ? '00' then 'GS1:00:'||(fields->>'00')
      when fields ? '21' then 'GS1:'||gtin||':21:'||(fields->>'21') else 'GS1:'||fields::text end;
  else
    if v !~ '^[0-9]+$' then raise exception '검증된 GS1 또는 숫자형 SM 중량 바코드만 지원합니다.'; end if;
    rule:=nullif(p_rule,'');
    -- Only these domestic patterns were also checked against supplied photographs.
    if rule is null and v ~ '^076623[0-9]{20}$' then rule:='26|17|4|2|1.00000000|3'; end if;
    if rule is null and v ~ '^076076[0-9]{20}$' then rule:='26|17|4|2|1.00000000|1'; end if;
    if rule is null and v ~ '^2[0-9]{5}122040[0-9]{10}$' then rule:='22|19|4|2|1.00000000|2'; end if;
    select definition into r from pda_private.raw_rules where rule_key=rule;
    if r is null then raise exception '검증된 SM 판독형식을 선택해주세요. 길이만으로 임의 판독하지 않습니다.'; end if;
    n:=(r->>'WgtStartPos')::integer;lim:=(r->>'WgtLength')::integer;
    if n<1 or length(v)<>(r->>'BarcodeLength')::integer or n+lim-1>length(v) then raise exception '선택한 SM 형식과 바코드 길이·중량 위치가 맞지 않습니다.'; end if;
    val:=substr(v,n,lim);factor:=(r->>'ConvFactor')::numeric;
    source:=val::numeric/power(10,(r->>'WgtDecimal')::integer);
    w:=round(round(source*factor,(r->>'WgtDecimal')::integer),2);
    review:=true;key:='SM:'||v;rule:='SM '||rule;
  end if;
  if w is null or w<=0 or w>1000 then raise exception '박스 중량 허용범위(0 초과~1,000KG)를 벗어났습니다.'; end if;
  return jsonb_build_object('id',encode(extensions.digest(key,'sha256'),'hex'),'code',v,'rule',rule,
    'weight',w,'calculatedWeight',w,'sourceWeight',source,'conversion',factor,'requiresReview',review,
    'barcodeLot',barcode_lot,'gtin',gtin,'mfgdate',mfg,'expdate',expiry,'fields',fields,
    'ruleKey',case when is_gs then 'gs1' else substr(rule,4) end);
end;
$$;
