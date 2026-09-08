-- Only the cropped temperature slip is stored; the full camera photo is never uploaded.
-- Driver ownership and office driver_attendance/view permission are enforced server-side.
create table if not exists public.driver_temperature_records (
  id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid not null references public.driver_accounts(id),
  request_id uuid not null,
  employee_name text not null,
  record_date date not null,
  vehicle_no text not null check (length(vehicle_no) between 1 and 32),
  note text not null default '' check (length(note) <= 200),
  image_data bytea not null check (octet_length(image_data) between 100 and 2097152),
  image_width integer not null check (image_width between 100 and 1600),
  image_height integer not null check (image_height between 100 and 16000),
  created_at timestamptz not null default now(),
  unique (account_id, request_id),
  check (image_width::bigint * image_height <= 12000000)
);
create index if not exists idx_driver_temperature_date on public.driver_temperature_records(record_date desc, created_at desc, id);
create index if not exists idx_driver_temperature_account on public.driver_temperature_records(account_id, record_date desc);
alter table public.driver_temperature_records enable row level security;
revoke all on public.driver_temperature_records from public, anon, authenticated;

create or replace function public.dbmt_driver_save_temperature_record(p_token text, p_record jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $dbmt$
declare
  v_account_id uuid := public.dbmt_driver_session_account(p_token);
  v_request_id uuid;
  v_date date;
  v_vehicle text := btrim(coalesce(p_record->>'vehicleNo',''));
  v_note text := btrim(coalesce(p_record->>'note',''));
  v_data_url text := coalesce(p_record->>'image','');
  v_image bytea;
  v_width integer;
  v_height integer;
  v_id uuid;
  v_existing public.driver_temperature_records%rowtype;
begin
  if v_account_id is null then raise exception '기사 로그인이 만료되었습니다. 다시 로그인해주세요.'; end if;
  if jsonb_typeof(p_record) is distinct from 'object' then raise exception '온도기록지 정보가 올바르지 않습니다.'; end if;
  v_request_id := nullif(p_record->>'requestId','')::uuid;
  v_date := public.dbmt_safe_date(p_record->>'date');
  v_width := (p_record->>'width')::integer;
  v_height := (p_record->>'height')::integer;
  if v_request_id is null or v_date is null then raise exception '기록일과 전송번호를 확인해주세요.'; end if;
  if v_date < date '2000-01-01' or v_date > timezone('Asia/Seoul',now())::date + 1 then raise exception '기록일을 확인해주세요.'; end if;
  if length(v_vehicle) not between 1 and 32 or length(v_note) > 200 then raise exception '차량번호(32자 이내)와 비고(200자 이내)를 확인해주세요.'; end if;
  if v_width is null or v_height is null or v_width not between 100 and 1600 or v_height not between 100 and 16000
    or v_width::bigint * v_height > 12000000 then raise exception '기록지 이미지 크기를 확인해주세요.'; end if;
  if length(v_data_url) > 2796230 or left(v_data_url,23) <> 'data:image/jpeg;base64,' then raise exception '잘라낸 JPG 기록지만 전송할 수 있습니다(최대 2MB).'; end if;
  v_image := decode(substr(v_data_url,24), 'base64');
  if octet_length(v_image) not between 100 and 2097152
    or substring(v_image from 1 for 2) <> decode('ffd8','hex')
    or substring(v_image from octet_length(v_image)-1 for 2) <> decode('ffd9','hex') then raise exception '올바른 JPG 기록지가 아닙니다.'; end if;

  -- Retries reuse the request UUID. They can never overwrite an earlier upload.
  insert into public.driver_temperature_records(account_id,request_id,employee_name,record_date,vehicle_no,note,image_data,image_width,image_height)
  select v_account_id,v_request_id,a.employee_name,v_date,v_vehicle,v_note,v_image,v_width,v_height
  from public.driver_accounts a where a.id = v_account_id
  on conflict (account_id,request_id) do nothing returning id into v_id;
  if v_id is null then
    select * into v_existing from public.driver_temperature_records where account_id=v_account_id and request_id=v_request_id;
    if v_existing.image_data <> v_image or v_existing.record_date <> v_date or v_existing.vehicle_no <> v_vehicle
      or v_existing.note <> v_note or v_existing.image_width <> v_width or v_existing.image_height <> v_height then
      raise exception '이미 전송된 요청입니다. 새 기록지는 다시 촬영해서 전송해주세요.';
    end if;
    v_id := v_existing.id;
  end if;
  return jsonb_build_object('ok',true,'id',v_id,'message','온도기록지가 사무실로 전송되었습니다.');
end;
$dbmt$;

create or replace function public.dbmt_temperature_record_list(p_token text, p_client text, p_from date, p_to date, p_offset integer default 0, p_search text default '')
returns jsonb language plpgsql security definer set search_path = public, extensions as $dbmt$
declare
  v_account_id uuid;
  v_rows jsonb;
  v_count bigint;
begin
  if p_client = 'driver' then
    v_account_id := public.dbmt_driver_session_account(p_token);
    if v_account_id is null then raise exception '기사 로그인이 만료되었습니다.'; end if;
  elsif p_client = 'erp' then
    if public.dbmt_erp_has_permission(p_token,'driver_attendance','view') is not true then raise exception '배송기사근태 조회 권한이 없습니다. 다시 로그인하거나 관리자에게 문의해주세요.'; end if;
  else raise exception '올바르지 않은 조회 구분입니다.';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to-p_from > 366 then raise exception '조회기간은 1년 이내로 선택해주세요.'; end if;
  if p_offset is null or p_offset < 0 or p_offset > 100000 then raise exception '조회 위치가 올바르지 않습니다.'; end if;
  if length(coalesce(p_search,'')) > 100 then raise exception '검색어는 100자 이내로 입력해주세요.'; end if;
  select count(*) into v_count from public.driver_temperature_records r
    where r.record_date between p_from and p_to and (v_account_id is null or r.account_id=v_account_id)
    and (coalesce(p_search,'')='' or strpos(lower(r.employee_name || ' ' || r.vehicle_no),lower(p_search))>0);
  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc,q.id desc),'[]'::jsonb) into v_rows from (
    select r.id,r.employee_name,r.record_date,r.vehicle_no,r.note,r.image_width,r.image_height,r.created_at
    from public.driver_temperature_records r
    where r.record_date between p_from and p_to and (v_account_id is null or r.account_id=v_account_id)
      and (coalesce(p_search,'')='' or strpos(lower(r.employee_name || ' ' || r.vehicle_no),lower(p_search))>0)
    order by r.created_at desc,r.id desc limit 50 offset p_offset
  ) q;
  return jsonb_build_object('ok',true,'rows',v_rows,'total',v_count);
end;
$dbmt$;

create or replace function public.dbmt_temperature_record_image(p_token text, p_client text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $dbmt$
declare
  v_account_id uuid;
  v_row public.driver_temperature_records%rowtype;
begin
  if p_client = 'driver' then
    v_account_id := public.dbmt_driver_session_account(p_token);
    if v_account_id is null then raise exception '기사 로그인이 만료되었습니다.'; end if;
  elsif p_client = 'erp' then
    if public.dbmt_erp_has_permission(p_token,'driver_attendance','view') is not true then raise exception '배송기사근태 조회 권한이 없습니다.'; end if;
  else raise exception '올바르지 않은 조회 구분입니다.';
  end if;
  select * into v_row from public.driver_temperature_records where id=p_id and (v_account_id is null or account_id=v_account_id);
  if v_row.id is null then raise exception '온도기록지를 찾을 수 없거나 조회 권한이 없습니다.'; end if;
  return jsonb_build_object('ok',true,'id',v_row.id,'employee_name',v_row.employee_name,'record_date',v_row.record_date,
    'vehicle_no',v_row.vehicle_no,'note',v_row.note,'image_width',v_row.image_width,'image_height',v_row.image_height,
    'image','data:image/jpeg;base64,' || replace(encode(v_row.image_data,'base64'),E'\n',''));
end;
$dbmt$;

revoke all on function public.dbmt_driver_save_temperature_record(text,jsonb) from public;
revoke all on function public.dbmt_temperature_record_list(text,text,date,date,integer,text) from public;
revoke all on function public.dbmt_temperature_record_image(text,text,uuid) from public;
grant execute on function public.dbmt_driver_save_temperature_record(text,jsonb) to anon,authenticated;
grant execute on function public.dbmt_temperature_record_list(text,text,date,date,integer,text) to anon,authenticated;
grant execute on function public.dbmt_temperature_record_image(text,text,uuid) to anon,authenticated;
notify pgrst, 'reload schema';
