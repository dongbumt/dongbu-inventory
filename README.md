# 동부엠티 ERP

정적 HTML 화면과 Google Apps Script 백엔드로 구성된 ERP 도구입니다.

## 배포 설정

### 1. Apps Script 스크립트 속성

Apps Script 편집기에서 **프로젝트 설정 > 스크립트 속성**에 아래 값을 등록합니다.

| 속성명 | 필수 | 용도 |
| --- | --- | --- |
| `SHEET_ID` | 필수 | ERP 데이터를 저장할 Google Sheets 문서 ID |
| `EKAPE_TRACE_SERVICE_KEY` | 선택 | 축산물이력제 `traceNoSearch` 조회용 serviceKey |
| `MTRACE_USER_ID` | 선택 | mtrace 일괄 조회 userId |
| `MTRACE_API_KEY` | 선택 | mtrace 일괄 조회 apiKey, 별도 `EKAPE_TRACE_SERVICE_KEY`가 없을 때 fallback |

민감 값은 소스 코드에 직접 넣지 않습니다.

### 2. 화면의 Google Sheets 연동 URL

`index.html`을 처음 열면 Apps Script 웹앱 URL을 입력하는 설정 화면이 표시됩니다.
한 번 저장하면 브라우저 `localStorage`에 보관됩니다.

URL 형식:

```text
https://script.google.com/macros/s/.../exec
```

오프라인으로 사용할 경우 설정 화면에서 **오프라인으로 사용**을 선택합니다.

## Apps Script 자동 배포

이 프로젝트는 `clasp`로 `Code.gs`와 `appsscript.json`만 Apps Script에 업로드하도록 설정되어 있습니다.

초기 1회 준비:

```powershell
npm install -g @google/clasp
clasp login
Copy-Item .clasp.json.example .clasp.json
```

그 다음 `.clasp.json`의 `scriptId` 값을 Apps Script 프로젝트의 스크립트 ID로 바꿉니다.

업로드:

```powershell
.\tools\deploy-appsscript.ps1
```

업로드 후 새 버전까지 생성:

```powershell
.\tools\deploy-appsscript.ps1 -CreateVersion
```

기존 웹앱 배포 URL까지 같은 주소로 갱신:

```powershell
.\tools\deploy-appsscript.ps1 -DeploymentId "기존_배포_ID"
```

배포 ID는 `clasp deployments` 또는 Apps Script의 **배포 관리** 화면에서 확인합니다.

## 배송기사 모바일 근태

배송기사는 아래 전용 화면에서 기사별 아이디와 비밀번호로 로그인한 뒤 GPS 출퇴근을 기록합니다.

```text
https://dongbumt.github.io/dongbu-inventory/driver-attendance.html
```

Supabase SQL Editor에서 다음 파일을 번호순으로 한 번씩 실행합니다.

1. `supabase/schema-rpc-09a-driver-tables.sql`
2. `supabase/schema-rpc-09b-driver-admin.sql`
3. `supabase/schema-rpc-09c-driver-locations.sql`
4. `supabase/schema-rpc-09d-driver-login.sql`
5. `supabase/schema-rpc-09e-driver-state.sql`
6. `supabase/schema-rpc-09f-driver-clock.sql`
7. `supabase/schema-rpc-11a-driver-flexible-tables.sql`
8. `supabase/schema-rpc-11b-driver-state.sql`
9. `supabase/schema-rpc-11c-driver-clock.sql`
10. `supabase/schema-rpc-11d-driver-events.sql`
11. `supabase/schema-rpc-11e-driver-admin-data.sql`
12. `supabase/schema-rpc-11f-driver-admin-write.sql`
13. `supabase/schema-rpc-12-driver-region-bonus.sql`
14. `supabase/schema-rpc-13-driver-default-break.sql`
15. `supabase/schema-rpc-14-driver-address-label.sql`
16. `supabase/schema-rpc-15-driver-region-from-address.sql`
17. `supabase/schema-rpc-16-driver-break-minimum.sql`
18. `supabase/schema-rpc-17a-mobile-admin-tables.sql`
19. `supabase/schema-rpc-17b-mobile-admin-login.sql`
20. `supabase/schema-rpc-17c-mobile-admin-accounts.sql`
21. `supabase/schema-rpc-17d-mobile-admin-data.sql`
22. `supabase/schema-rpc-17e-mobile-admin-driver-week.sql`
23. `supabase/schema-rpc-17f-mobile-admin-schedule-write.sql`

ERP의 `배송기사근태` 메뉴에서 기사 계정을 설정합니다. 근무장소 사전등록은 필요하지 않으며 모바일 버튼을 누른 서버시각과 GPS 좌표가 기록됩니다. 현재 좌표는 모바일에서 시·구 단위의 간단 주소로 변환되어 화면에 표시됩니다. 관리자 화면에서는 누락 기록 수기입력과 기존 기록 수정·삭제를 할 수 있습니다. 기사 비밀번호는 해시로만 저장되며 모바일 로그인에는 만료되는 별도 세션 토큰을 사용합니다.

## 모바일 관리자

관리자는 아래 전용 화면에서 관리자 아이디와 숫자 4자리 비밀번호로 로그인해 ERP 데이터를 조회합니다.

```text
https://dongbumt.github.io/dongbu-inventory/mobile-admin.html
```

ERP의 `모바일 관리자` 메뉴에서 계정을 등록하거나 사용 중지할 수 있습니다. 로그인 세션은 해당 브라우저에 저장되어 자동로그인됩니다. 일정관리는 모바일에서 한 건씩 안전하게 등록·수정할 수 있으며, 거래내역·생산일보·재고현황·배송기사근태·직원정보·지출관리는 조회할 수 있습니다.
