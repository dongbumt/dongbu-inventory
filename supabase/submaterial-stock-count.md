# 부자재 LOT 실사 저장

`schema-rpc-40-submaterial-stock-count.sql`과 `migrations/20260914090000_submaterial_stock_count.sql`은 같은 설치 내용입니다. 개인 로그인, 기존 부자재 사용 저장 RPC와 변경이력 저장 RPC가 먼저 설치되어 있어야 합니다. 새 테이블이나 기존 실사자료의 변환 없이 `app_data.subMaterialCounts` 배열을 사용합니다.

| RPC | 입력 | 주요 응답 |
| --- | --- | --- |
| `dbmt_erp_get_submaterial_stock` | `p_token` | `items`, `lots`, `counts`, `usages`, `countsRevision` |
| `dbmt_erp_save_submaterial_count` | `p_token`, `p_record` | 위 스냅샷 + `count`, `currentQty`, `logEntry` |
| `dbmt_erp_save_submaterial_item_count` | `p_token`, `p_record` | 위 스냅샷 + `itemCountId`, `allocations`, `currentQty` |
| `dbmt_erp_delete_submaterial_count` | `p_token`, `p_count_id`, `p_expected_revision` | 위 스냅샷 + `currentQty`, `logEntry` |

저장 요청은 `{id, lotId, qty, expectedSystemQty, manager, note}`를 전달합니다. `id`는 실사창을 열 때 한 번 만들고 통신 실패 시 재사용합니다. 같은 ID와 내용으로 재시도하면 기존 실사를 반환하고, 내용이 다르면 `count_id_conflict`를 반환합니다. 삭제한 ID를 다시 보내도 실사를 복원하지 않습니다.

실제수량은 0 이상이며 수량은 소수 여섯 자리까지 허용합니다. 서버가 입고 LOT의 원장과 사용이력, 기존 조정량으로 현재고를 계산하고 `expectedSystemQty`와 비교합니다. 일자는 한국 현재일, `createdAt`은 UTC ISO 시각이며, `adjustmentQty = qty - systemQty`를 서버에서 정합니다.

응답의 `ok`를 반드시 확인한 다음 로컬 배열을 교체합니다. `stock_conflict`는 `currentQty`와 최신 스냅샷을 함께 반환하므로 화면의 전산재고를 갱신하고 사용자의 재확인을 받습니다. 삭제에는 조회한 `countsRevision`을 보내며, 달라졌으면 `counts_conflict`입니다. 이미 사용한 증가 조정량을 삭제해 재고가 음수가 되는 경우 `count_in_use`로 거절합니다.

기존 품목단위 실사는 `lotId` 없는 원문을 그대로 유지하고 삭제만 전용 RPC에서 수행합니다. 일반 `dbmt_erp_save_app_data` 호출은 기존 실사의 품목 ID·코드·이름·규격·단위만 병합할 수 있습니다. 오래된 배열에서 빠진 서버 실사는 보존하며, 실사 추가와 날짜·수량·조정값 등의 변경은 거절합니다. 실사의 등록·삭제에는 각각 기존 `submaterials/create`, `submaterials/delete` 권한을 적용합니다.

입고·실사·품목 쓰기와 부자재 사용이력 쓰기는 동일한 데이터베이스 잠금을 사용합니다. 생산일보 삭제로 사용이력이 삭제되는 경우도 포함합니다. 실사/사용 이력이 있는 LOT의 일반 삭제는 거절합니다. 사용이력 저장도 최신 LOT 잔량을 검증하므로 실사 뒤에 도착한 오래된 사용 요청이 재고를 음수로 만들면 전체 저장을 취소합니다. 이미 존재하는 음수 재고는 더 악화시키지 않는 정정만 허용합니다.

검증은 프로젝트 루트에서 `supabase/tests/check-submaterial-stock-count-db.ps1`을 실행합니다. 연결정보는 메모리 환경변수만 사용하고, SQL 설치와 가상자료 변경은 항상 롤백합니다. 이 검증 도구에는 배포 모드가 없습니다.

## 품목별 합계 실사

`migrations/20261113100445_submaterial_item_stock_counts.sql`은 품목별 합계에 ‘실사’를 추가합니다. 기준은 선택한 품목에 연결된 LOT 잔량 합계이며, 과거 품목 실사 원문을 LOT에 재배분하거나 입고·생산 사용기록을 변경하지 않습니다.

합계 실재고와 전산재고의 차이만 반영합니다. 감소는 오래된 입고 LOT의 양수 잔량을 0까지 줄인 다음 다음 LOT으로 넘어갑니다. 증가는 가장 오래된 LOT에 전량 반영하며 소진된 LOT도 포함합니다. 입고일이 같으면 생성시각, 입고 ID 순서로 정렬합니다. 입고일이 없는 LOT은 날짜가 있는 LOT 다음에 배치합니다. 입고 LOT이 없거나 미래 입고일·서로 다른 단위가 섞여 있으면 합계 실사를 차단합니다.

요청 형식은 `{id, itemId, qty, expectedSystemQty, expectedLots, manager, note}`입니다. `expectedLots`는 입고 ID를 키로 하는 `{qty, date, createdAt, unit}` 객체입니다. 전체 합계가 같더라도 LOT 잔량·구성·입고순서가 달라졌으면 `stock_conflict`로 거절합니다. 조회한 최신 재고로 조정 예정 내역을 갱신한 뒤 다시 저장해야 합니다.

서버는 기존 부자재 쓰기와 동일한 트랜잭션 잠금 안에서 모든 LOT 조정과 변경이력을 저장합니다. 배열에는 일반 LOT 실사와 같은 `qty`, `systemQty`, `adjustmentQty`를 넣으며 `itemCountId`, `itemCountQty`, `itemCountSystemQty`, `itemCountAdjustmentQty`로 한 건의 합계 실사를 연결합니다. 첫 기록에는 재시도 확인용 `itemCountRequest`, `itemCountIds`도 보존합니다. 차이가 0이어도 실사 이력은 남습니다.

동일한 요청 ID·내용으로 재시도하면 중복 반영하지 않습니다. 이미 삭제한 요청은 재시도해도 복원하지 않습니다. 이력 삭제는 기존 삭제 RPC를 사용하며, 연결된 어느 LOT 기록을 삭제하더라도 같은 합계 실사의 모든 조정을 함께 취소합니다. 증가한 재고가 이미 사용되어 취소 시 재고가 더 음수가 되면 전체 취소를 거절합니다. 예전 LOT별 실사와 과거 품목 실사의 삭제 방식은 유지합니다.

신규 저장 API는 `SECURITY INVOKER` 공개 래퍼와 비공개 스키마의 권한 검증 함수로 구성합니다. 테이블을 새로 만들거나 기존 자료를 변환하지 않습니다. `submaterials/create`, `submaterials/delete` 권한과 개인 세션 검증을 사용합니다.

검증: `tools/check-submaterial-item-count-db.ps1`은 새 설치와 가상 사용자·재고를 트랜잭션 안에서 검사하고 롤백합니다. 배포 후에는 `-Deployed`로 설치를 건너뛰고 같은 검사를 롤백합니다. `tools/test-submaterial-item-count.cjs`와 기존 `tools/test-submaterial-lot-stock.cjs`는 가상자료로 화면·재시도·충돌·기존 LOT 기능을 검사합니다.
