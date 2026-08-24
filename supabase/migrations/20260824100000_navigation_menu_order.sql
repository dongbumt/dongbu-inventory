-- Align the permission catalog with the grouped ERP navigation.
-- Menu codes stay unchanged so existing role permissions remain connected.
update public.erp_permission_catalog as catalog
set menu_name = menu.menu_name,
    sort_order = menu.sort_order,
    updated_at = now()
from (values
  ('schedule', '일정관리', 10),
  ('company_master', '법인·사업장·창고', 20),
  ('label_products', '품목관리', 30),
  ('traders', '거래처 관리', 40),
  ('prices', '단가표', 50),
  ('transactions', '거래내역', 60),
  ('stock', '재고현황', 70),
  ('invoice', '거래명세서', 80),
  ('submaterials', '부자재 관리', 90),
  ('cold_storage_request', '냉동창고 요청', 100),
  ('samsung', '삼성웰스토리', 110),
  ('production', '생산일보', 120),
  ('production_loss', '생산 로스율', 130),
  ('workorders', '작업지시', 140),
  ('label', '라벨출력', 150),
  ('label_print', '라벨전용', 160),
  ('expense_settings', '경비 설정', 170),
  ('cost_calculator', '원가계산기', 180),
  ('cost_compare', '생산원가비교', 190),
  ('quotation', '견적서 작성', 200),
  ('inbound_inspection', '입고검사일지', 210),
  ('shipment_log', '출고검사일지', 220),
  ('document_check', '서류체크', 230),
  ('employees', '직원정보', 240),
  ('attendance', '근태관리', 250),
  ('driver_attendance', '배송기사근태', 260),
  ('expenses', '지출관리', 270),
  ('access_control', '사용자·역할·권한', 280),
  ('mobile_admin', '모바일 관리자', 290),
  ('import', '엑셀 가져오기', 300),
  ('factory_sim', '확장공장 시뮬레이터', 310),
  ('change_log', '변경이력', 320)
) as menu(menu_code, menu_name, sort_order)
where catalog.menu_code = menu.menu_code;

notify pgrst, 'reload schema';
