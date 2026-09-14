# 부자재 LOT 실사 저장

`schema-rpc-40-submaterial-stock-count.sql`과 `migrations/20260914090000_submaterial_stock_count.sql`은 같은 설치 내용입니다. 개인 로그인, 기존 부자재 사용 저장 RPC와 변경이력 저장 RPC가 먼저 설치되어 있어야 합니다. 새 테이블이나 기존 실사자료의 변환 없이 `app_data.subMaterialCounts` 배열을 사용합니다.

| RPC | 입력 | 주요 응답 |
| --- | --- | --- |
| `dbmt_erp_get_submaterial_stock` | `p_token` | `items`, `lots`, `counts`, `usages`, `countsRevision` |
| `dbmt_erp_save_submaterial_count` | `p_token`, `p_record` | 위 스냅샷 + `count`, `currentQty`, `logEntry` |
| `dbmt_erp_delete_submaterial_count` | `p_token`, `p_count_id`, `p_expected_revision` | 위 스냅샷 + `currentQty`, `logEntry` |

저장 요청은 `{id, lotId, qty, expectedSystemQty, manager, note}`를 전달합니다. `id`는 실사창을 열 때 한 번 만들고 통신 실패 시 재사용합니다. 같은 ID와 내용으로 재시도하면 기존 실사를 반환하고, 내용이 다르면 `count_id_conflict`를 반환합니다. 삭제한 ID를 다시 보내도 실사를 복원하지 않습니다.

실제수량은 0 이상이며 수량은 소수 여섯 자리까지 허용합니다. 서버가 입고 LOT의 원장과 사용이력, 기존 조정량으로 현재고를 계산하고 `expectedSystemQty`와 비교합니다. 일자는 한국 현재일, `createdAt`은 UTC ISO 시각이며, `adjustmentQty = qty - systemQty`를 서버에서 정합니다.

응답의 `ok`를 반드시 확인한 다음 로컬 배열을 교체합니다. `stock_conflict`는 `currentQty`와 최신 스냅샷을 함께 반환하므로 화면의 전산재고를 갱신하고 사용자의 재확인을 받습니다. 삭제에는 조회한 `countsRevision`을 보내며, 달라졌으면 `counts_conflict`입니다. 이미 사용한 증가 조정량을 삭제해 재고가 음수가 되는 경우 `count_in_use`로 거절합니다.

기존 품목단위 실사는 `lotId` 없는 원문을 그대로 유지하고 삭제만 전용 RPC에서 수행합니다. 일반 `dbmt_erp_save_app_data` 호출은 기존 실사의 품목 ID·코드·이름·규격·단위만 병합할 수 있습니다. 오래된 배열에서 빠진 서버 실사는 보존하며, 실사 추가와 날짜·수량·조정값 등의 변경은 거절합니다. 실사의 등록·삭제에는 각각 기존 `submaterials/create`, `submaterials/delete` 권한을 적용합니다.

입고·실사·품목 쓰기와 부자재 사용이력 쓰기는 동일한 데이터베이스 잠금을 사용합니다. 생산일보 삭제로 사용이력이 삭제되는 경우도 포함합니다. 실사/사용 이력이 있는 LOT의 일반 삭제는 거절합니다. 사용이력 저장도 최신 LOT 잔량을 검증하므로 실사 뒤에 도착한 오래된 사용 요청이 재고를 음수로 만들면 전체 저장을 취소합니다. 이미 존재하는 음수 재고는 더 악화시키지 않는 정정만 허용합니다.

검증은 프로젝트 루트에서 `supabase/tests/check-submaterial-stock-count-db.ps1`을 실행합니다. 연결정보는 메모리 환경변수만 사용하고, SQL 설치와 가상자료 변경은 항상 롤백합니다. 이 검증 도구에는 배포 모드가 없습니다.
