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
