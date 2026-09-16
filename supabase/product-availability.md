# 품목 사용 여부

품목관리에서 목록의 **수정 → 사용 여부 → 사용안함 → 수정 저장**으로 변경합니다.
목록의 사용 여부 필터로 사용안함 품목만 조회하고, 같은 방법으로 다시 사용으로 전환할 수 있습니다.

- 기존 품목의 `isActive`가 없으면 사용으로 처리합니다. 일괄 데이터 갱신은 하지 않습니다.
- 사용안함은 거래내역의 입고·출고·일괄 입력과 생산일보의 원료 재고·생산품 선택 목록에서 제외하는 설정입니다. 공용 선택창을 쓰는 작업지시에서도 제외됩니다.
- 품목을 삭제하지 않으며, 기존 거래·생산일보·재고 계산·라벨 이력은 그대로 유지합니다. 과거 기록 수정 시 원래 저장된 사용안함 품목도 유지됩니다.
- 재고에 품목 ID가 없으면 원산지·포장단위·브랜드 등으로 대조합니다. 같은 이름의 사용 품목이 함께 있는 모호한 재고나 미등록 과거 재고는 임의로 숨기지 않습니다.
- 서버의 개인 사용자 권한 검사와 감사 기록을 유지합니다. 이전 화면에서 사용 여부를 생략하여 저장해도 기존 사용안함을 임의로 사용으로 되돌리지 않습니다.

## 배포와 검증

`schema-rpc-43-product-availability.sql`과 `migrations/20260916100000_product_availability.sql`은 동일합니다.
새 화면을 배포하기 전에 서버 저장 RPC를 적용합니다. 실제 품목 및 거래 데이터의 변경은 필요하지 않습니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/check-product-availability-db.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools/check-product-availability-db.ps1 -Apply
node tools/test-product-availability.cjs
node tools/test-label-production.cjs
node tools/test-workorder-label.cjs
node tools/test-production-row-stock.cjs --browser
```

DB 검증의 가상 사용자·품목·로그는 항상 롤백하며, `-Apply`는 검증 통과 후 함수 정의만 커밋합니다. 브라우저 검증은 격리된 DOM 및 가상 저장 응답을 사용하고, 실제 업무 데이터 저장이나 인쇄를 실행하지 않습니다.
