-- Production whiteboard pages sent from the standalone label PC.
-- The label PIN can save pages, while ERP personal permissions control viewing.

create table if not exists public.production_board_pages (
  board_date date not null,
  page_no integer not null,
  page_id text not null,
  body_text text not null default '',
  drawing_data_url text not null default '',
  source_width integer not null default 1200,
  source_height integer not null default 900,
  text_font_size numeric(8,2) not null default 36,
  text_line_height numeric(8,2) not null default 56,
  text_padding numeric(8,2) not null default 32,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (board_date, page_no),
  constraint production_board_pages_page_no_chk check (page_no between 1 and 100),
  constraint production_board_pages_page_id_chk check (page_id ~ '^[A-Za-z0-9_-]{5,80}$'),
  constraint production_board_pages_size_chk check (
    source_width between 100 and 10000 and source_height between 100 and 10000
  ),
  constraint production_board_pages_text_style_chk check (
    text_font_size between 8 and 120
    and text_line_height between 8 and 240
    and text_padding between 0 and 300
  ),
  constraint production_board_pages_revision_chk check (revision >= 1)
);

create index if not exists idx_production_board_pages_updated
  on public.production_board_pages(updated_at desc);

alter table public.production_board_pages enable row level security;
revoke all on public.production_board_pages from public, anon, authenticated;

insert into public.erp_permission_catalog(menu_code, menu_name, sort_order, active, updated_at)
values ('production_board', '생산현황 보드', 135, true, now())
on conflict (menu_code) do update
set menu_name = excluded.menu_name,
    sort_order = excluded.sort_order,
    active = true,
    updated_at = now();

insert into public.erp_role_permissions(
  role_id, menu_code, can_view, can_create, can_update, can_delete,
  can_close, can_api_send, can_admin, updated_at
)
select r.id, 'production_board', true, true, true, true, true, true, true, now()
from public.erp_roles r
where lower(r.code) = 'system_admin'
on conflict (role_id, menu_code) do update
set can_view = true,
    can_create = true,
    can_update = true,
    can_delete = true,
    can_close = true,
    can_api_send = true,
    can_admin = true,
    updated_at = now();

create or replace function public.dbmt_label_production_board_save(
  p_pin text,
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
begin
  if public.dbmt_check_label_print_pin(p_pin) is not true then
    raise exception '라벨전용 PIN이 맞지 않습니다.';
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

  if v_page_no not between 1 and 100 then
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

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values (
    'production_board',
    'save',
    v_board_date::text || ':' || v_page_no::text,
    v_board_date::text || ' 생산현황 ' || v_page_no::text || '페이지 저장',
    jsonb_build_object('boardDate', v_board_date, 'pageNo', v_page_no, 'revision', v_revision)
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

create or replace function public.dbmt_erp_get_production_board(
  p_token text,
  p_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_selected_date date := p_date;
begin
  perform public.dbmt_erp_authorize_legacy(p_token, 'production_board', 'view');

  if v_selected_date is null then
    select max(board_date) into v_selected_date
    from public.production_board_pages;
  end if;

  return jsonb_build_object(
    'selectedDate', v_selected_date,
    'dates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'boardDate', grouped.board_date,
        'pageCount', grouped.page_count,
        'updatedAt', grouped.updated_at
      ) order by grouped.board_date desc)
      from (
        select board_date, count(*)::integer as page_count, max(updated_at) as updated_at
        from public.production_board_pages
        group by board_date
        order by board_date desc
        limit 180
      ) grouped
    ), '[]'::jsonb),
    'pages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'boardDate', board_date,
        'pageNo', page_no,
        'pageId', page_id,
        'text', body_text,
        'drawing', drawing_data_url,
        'sourceWidth', source_width,
        'sourceHeight', source_height,
        'textFontSize', text_font_size,
        'textLineHeight', text_line_height,
        'textPadding', text_padding,
        'revision', revision,
        'updatedAt', updated_at
      ) order by page_no)
      from public.production_board_pages
      where board_date = v_selected_date
    ), '[]'::jsonb)
  );
end;
$dbmt$;

revoke all on function public.dbmt_label_production_board_save(text, jsonb) from public;
revoke all on function public.dbmt_erp_get_production_board(text, date) from public;

grant execute on function public.dbmt_label_production_board_save(text, jsonb) to anon, authenticated;
grant execute on function public.dbmt_erp_get_production_board(text, date) to anon, authenticated;

notify pgrst, 'reload schema';
