-- Reuse the standalone label login for production-board transmission.
-- The browser stores only an opaque, short-lived token; the label PIN is not stored.

create table if not exists public.label_print_sessions (
  token_hash text primary key,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create index if not exists idx_label_print_sessions_expiry
  on public.label_print_sessions(expires_at);

alter table public.label_print_sessions enable row level security;
revoke all on public.label_print_sessions from public, anon, authenticated;

create or replace function public.dbmt_label_print_login(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_token text;
  v_expires_at timestamptz := now() + interval '12 hours';
begin
  if public.dbmt_check_label_print_pin(p_pin) is not true then
    raise exception '라벨전용 PIN이 맞지 않습니다.';
  end if;

  delete from public.label_print_sessions where expires_at <= now();
  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.label_print_sessions(token_hash, expires_at)
  values (
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    v_expires_at
  );

  return jsonb_build_object(
    'ok', true,
    'token', v_token,
    'expiresAt', v_expires_at
  );
end;
$dbmt$;

create or replace function public.dbmt_label_production_board_save_session(
  p_session_token text,
  p_page jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_token_hash text := encode(extensions.digest(coalesce(p_session_token, ''), 'sha256'), 'hex');
  v_date_text text := btrim(coalesce(p_page->>'boardDate', ''));
  v_board_date date;
  v_page_no integer;
  v_page_id text := btrim(coalesce(p_page->>'pageId', ''));
  v_body_text text := coalesce(p_page->>'text', '');
  v_drawing text := coalesce(p_page->>'drawing', '');
  v_source_width integer;
  v_source_height integer;
  v_font_size numeric;
  v_line_height numeric;
  v_padding numeric;
  v_revision bigint;
  v_updated_at timestamptz;
begin
  if not exists (
    select 1
    from public.label_print_sessions
    where token_hash = v_token_hash
      and expires_at > now()
  ) then
    raise exception '라벨전용 로그인이 만료되었습니다. 라벨전용 화면에서 다시 로그인해주세요.';
  end if;

  if jsonb_typeof(coalesce(p_page, '{}'::jsonb)) <> 'object' then
    raise exception '생산현황 페이지 형식이 올바르지 않습니다.';
  end if;
  if v_date_text !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception '생산현황 일자가 올바르지 않습니다.';
  end if;

  begin
    v_board_date := v_date_text::date;
    v_page_no := (p_page->>'pageNo')::integer;
    v_source_width := coalesce((p_page->>'sourceWidth')::integer, 1200);
    v_source_height := coalesce((p_page->>'sourceHeight')::integer, 900);
    v_font_size := coalesce((p_page->>'textFontSize')::numeric, 36);
    v_line_height := coalesce((p_page->>'textLineHeight')::numeric, 56);
    v_padding := coalesce((p_page->>'textPadding')::numeric, 32);
  exception when others then
    raise exception '생산현황 페이지 정보가 올바르지 않습니다.';
  end;

  if v_page_no is null or v_page_no not between 1 and 100 then
    raise exception '페이지 번호는 1부터 100까지 사용할 수 있습니다.';
  end if;
  if v_page_id !~ '^[A-Za-z0-9_-]{5,80}$' then
    raise exception '생산현황 페이지 ID가 올바르지 않습니다.';
  end if;
  if length(v_body_text) > 50000 then
    raise exception '생산현황 글자 내용이 너무 깁니다.';
  end if;
  if octet_length(v_drawing) > 8000000 then
    raise exception '생산현황 그림 용량이 너무 큽니다.';
  end if;
  if v_drawing <> '' and left(v_drawing, 22) <> 'data:image/png;base64,' then
    raise exception '생산현황 그림 형식이 올바르지 않습니다.';
  end if;
  if v_source_width not between 100 and 10000
     or v_source_height not between 100 and 10000
     or v_font_size not between 8 and 120
     or v_line_height not between 8 and 240
     or v_padding not between 0 and 300 then
    raise exception '생산현황 화면 크기 정보가 올바르지 않습니다.';
  end if;

  insert into public.production_board_pages(
    board_date, page_no, page_id, body_text, drawing_data_url,
    source_width, source_height, text_font_size, text_line_height, text_padding
  ) values (
    v_board_date, v_page_no, v_page_id, v_body_text, v_drawing,
    v_source_width, v_source_height, v_font_size, v_line_height, v_padding
  )
  on conflict (board_date, page_no) do update
  set page_id = excluded.page_id,
      body_text = excluded.body_text,
      drawing_data_url = excluded.drawing_data_url,
      source_width = excluded.source_width,
      source_height = excluded.source_height,
      text_font_size = excluded.text_font_size,
      text_line_height = excluded.text_line_height,
      text_padding = excluded.text_padding,
      revision = public.production_board_pages.revision + 1,
      updated_at = now()
  returning revision, updated_at into v_revision, v_updated_at;

  update public.label_print_sessions
  set last_used_at = now()
  where token_hash = v_token_hash;

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values (
    'production_board',
    'save',
    v_board_date::text || ':' || v_page_no::text,
    v_board_date::text || ' 생산현황 ' || v_page_no::text || '페이지 저장',
    jsonb_build_object(
      'boardDate', v_board_date,
      'pageNo', v_page_no,
      'revision', v_revision,
      'authMode', 'label_session'
    )
  );

  return jsonb_build_object(
    'ok', true,
    'boardDate', v_board_date,
    'pageNo', v_page_no,
    'revision', v_revision,
    'updatedAt', v_updated_at
  );
end;
$dbmt$;

revoke all on function public.dbmt_label_print_login(text) from public;
revoke all on function public.dbmt_label_production_board_save_session(text, jsonb) from public;

grant execute on function public.dbmt_label_print_login(text) to anon, authenticated;
grant execute on function public.dbmt_label_production_board_save_session(text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
