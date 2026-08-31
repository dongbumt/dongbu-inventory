-- Keep transmitted production-board pages when a browser starts with a fresh
-- local page number. A stable page_id updates the same page; a new page_id is
-- appended after the latest server page for that date.

create unique index if not exists uq_production_board_pages_date_page_id
  on public.production_board_pages(board_date, page_id);

create or replace function public.dbmt_production_board_save_standalone(
  p_page jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
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
  v_existing_page boolean := false;
begin
  if jsonb_typeof(coalesce(p_page, '{}'::jsonb)) <> 'object' then
    raise exception '생산현황 페이지 형식이 올바르지 않습니다.';
  end if;
  if v_date_text !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception '생산현황 일자가 올바르지 않습니다.';
  end if;

  begin
    v_board_date := v_date_text::date;
    v_source_width := coalesce((p_page->>'sourceWidth')::integer, 1200);
    v_source_height := coalesce((p_page->>'sourceHeight')::integer, 900);
    v_font_size := coalesce((p_page->>'textFontSize')::numeric, 36);
    v_line_height := coalesce((p_page->>'textLineHeight')::numeric, 56);
    v_padding := coalesce((p_page->>'textPadding')::numeric, 32);
  exception when others then
    raise exception '생산현황 페이지 정보가 올바르지 않습니다.';
  end;

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

  perform pg_advisory_xact_lock(hashtextextended('production_board:' || v_board_date::text, 0));

  select page_no
  into v_page_no
  from public.production_board_pages
  where board_date = v_board_date
    and page_id = v_page_id
  for update;
  v_existing_page := found;

  if v_existing_page then
    update public.production_board_pages
    set body_text = v_body_text,
        drawing_data_url = v_drawing,
        source_width = v_source_width,
        source_height = v_source_height,
        text_font_size = v_font_size,
        text_line_height = v_line_height,
        text_padding = v_padding,
        revision = revision + 1,
        updated_at = now()
    where board_date = v_board_date
      and page_id = v_page_id
    returning revision, updated_at into v_revision, v_updated_at;
  else
    select coalesce(max(page_no), 0) + 1
    into v_page_no
    from public.production_board_pages
    where board_date = v_board_date;

    if v_page_no > 100 then
      raise exception '하루에 저장할 수 있는 생산현황 페이지는 최대 100페이지입니다.';
    end if;

    insert into public.production_board_pages(
      board_date, page_no, page_id, body_text, drawing_data_url,
      source_width, source_height, text_font_size, text_line_height, text_padding
    ) values (
      v_board_date, v_page_no, v_page_id, v_body_text, v_drawing,
      v_source_width, v_source_height, v_font_size, v_line_height, v_padding
    )
    returning revision, updated_at into v_revision, v_updated_at;
  end if;

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values (
    'production_board',
    case when v_existing_page then 'update' else 'save' end,
    v_board_date::text || ':' || v_page_no::text,
    v_board_date::text || ' 생산현황 ' || v_page_no::text ||
      case when v_existing_page then '페이지 수정' else '페이지 저장' end,
    jsonb_build_object(
      'boardDate', v_board_date,
      'pageNo', v_page_no,
      'pageId', v_page_id,
      'revision', v_revision,
      'created', not v_existing_page,
      'authMode', 'standalone_no_login'
    )
  );

  return jsonb_build_object(
    'ok', true,
    'boardDate', v_board_date,
    'pageNo', v_page_no,
    'pageId', v_page_id,
    'revision', v_revision,
    'created', not v_existing_page,
    'updatedAt', v_updated_at
  );
end;
$dbmt$;

revoke all on function public.dbmt_production_board_save_standalone(jsonb) from public;
grant execute on function public.dbmt_production_board_save_standalone(jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
