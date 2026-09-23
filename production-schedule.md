# 생산일정

생산관리 → 생산일정에서 날짜별 생산예정 품목을 관리합니다.

- 생산예정일과 품목명은 필수입니다. 등록 품목명을 검색하거나 직접 입력할 수 있습니다.
- 예정수량(KG)은 미정으로 둘 수 있습니다. 거래처와 비고는 선택 사항입니다.
- 같은 날 같은 품목도 여러 건 등록할 수 있습니다. 달력의 품목을 누르면 날짜·수량·상태 등을 수정합니다.
- 완료 표시는 일정 상태만 변경합니다. 재고·작업지시·생산일보를 자동 생성하지 않습니다.
- 새 메뉴 권한은 설치 시 기존 생산일보의 조회·등록·수정·삭제 권한을 복사합니다. 이후 권한관리에서 별도로 설정할 수 있습니다.
- 로그인한 사용자가 서버에 건별로 저장하며, 다른 사용자가 먼저 수정한 건은 최신 내용을 다시 확인해야 합니다.

## 구현 및 배포

화면은 `production-schedule.js`와 `styles/production-schedule.css`, 데이터는 Supabase `production_schedule` 테이블을 사용합니다. 기존 일반 일정과 별도 저장합니다.

`supabase/schema-rpc-46-production-schedule.sql`과 동일한 마이그레이션은 `supabase/migrations/20260923090000_production_schedule.sql`입니다. 날짜 범위 조회·등록/수정·삭제 RPC는 개인 로그인과 `production_schedule` 메뉴 권한을 검증하고 변경 이력을 기록합니다. 브라우저의 테이블 직접 접근은 차단합니다.

검증: `node tools/test-production-schedule.cjs` (Playwright/Chrome 필요), `./tools/check-production-schedule-db.ps1`.

서버 배포: `./tools/check-production-schedule-db.ps1 -Deploy`. 가상 데이터 검증을 롤백한 뒤 스키마만 적용합니다. 웹 파일은 GitHub Pages로 배포합니다.
