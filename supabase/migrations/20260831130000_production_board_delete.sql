-- Delete one transmitted production-board page with ERP personal permissions.
-- Remaining page numbers are compacted so the viewer continues to show 1..N.

create or replace function public.dbmt_erp_delete_production_board_page(
  p_token text,
  p_board_date date,
  p_page_no integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $dbmt$
declare
  v_user_id uuid := public.dbmt_erp_session_user(p_token);
  v_user public.erp_users%rowtype;
  v_role public.erp_roles%rowtype;
  v_deleted jsonb;
  v_move_page_no integer;
  v_page_count integer;
  v_selected_page_no integer;
begin
  if v_user_id is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'session_expired',
      'message', '개인 사용자 로그인이 만료되었습니다.'
    );
  end if;
  if public.dbmt_erp_has_permission(p_token, 'production_board', 'delete') is not true then
    return public.dbmt_erp_permission_denied(v_user_id, 'production_board', 'delete');
  end if;
  if p_board_date is null or p_page_no is null or p_page_no not between 1 and 100 then
    raise exception '삭제할 생산현황 페이지 정보가 올바르지 않습니다.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('production_board:' || p_board_date::text, 0));

  select to_jsonb(page_row)
  into v_deleted
  from public.production_board_pages page_row
  where page_row.board_date = p_board_date
    and page_row.page_no = p_page_no
  for update;

  if v_deleted is null then
    raise exception '삭제할 생산현황 페이지를 찾을 수 없습니다. 새로고침 후 다시 시도해주세요.';
  end if;

  delete from public.production_board_pages
  where board_date = p_board_date
    and page_no = p_page_no;

  for v_move_page_no in
    select page_no
    from public.production_board_pages
    where board_date = p_board_date
      and page_no > p_page_no
    order by page_no
  loop
    update public.production_board_pages
    set page_no = v_move_page_no - 1
    where board_date = p_board_date
      and page_no = v_move_page_no;
  end loop;

  select count(*)::integer, max(page_no)
  into v_page_count, v_selected_page_no
  from public.production_board_pages
  where board_date = p_board_date;
  v_selected_page_no := least(p_page_no, coalesce(v_selected_page_no, 0));

  select * into v_user from public.erp_users where id = v_user_id;
  select * into v_role from public.erp_roles where id = v_user.role_id;

  update public.erp_user_sessions
  set last_used_at = now()
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');

  insert into public.change_logs(entity, action, entity_id, summary, payload)
  values (
    'production_board',
    'delete',
    p_board_date::text || ':' || p_page_no::text,
    p_board_date::text || ' 생산현황 ' || p_page_no::text || '페이지 삭제',
    jsonb_build_object(
      'boardDate', p_board_date,
      'pageNo', p_page_no,
      'deletedPage', v_deleted,
      'remainingPageCount', v_page_count,
      'authMode', 'personal_session',
      'userId', v_user.id,
      'loginId', v_user.login_id,
      'displayName', v_user.display_name,
      'roleCode', v_role.code
    )
  );

  return jsonb_build_object(
    'ok', true,
    'boardDate', p_board_date,
    'deletedPageNo', p_page_no,
    'selectedPageNo', v_selected_page_no,
    'remainingPageCount', v_page_count
  );
end;
$dbmt$;

revoke all on function public.dbmt_erp_delete_production_board_page(text, date, integer) from public;
grant execute on function public.dbmt_erp_delete_production_board_page(text, date, integer) to anon, authenticated;

notify pgrst, 'reload schema';
