# 주차면 탐색 화면 카메라 제어형 레이아웃 설계

## 개정 이력

- 2026-08-01: 최초 작성. 기존 `_workspace/01_architect_plan.md`가 없어 새 문서로 작성했다.

## 범위

- `SettingMain/web/discovery.html`의 주차면 탐색 화면을 기존 `SettingMain/web/index.html`의 카메라 제어 화면과 같은 정보구조로 재배치한다. 데스크톱에서는 **좌측 대상 선택·탐색 조작 / 우측 넓은 영상**, 좁은 화면에서는 한 열로 전환한다.
- 목표는 제공된 화면의 픽셀 단위 복제가 아니라, 기존 카메라 제어 화면이 가진 열 비율, 카드 위계, 영상 우선순위, 반응형 전환 원칙을 탐색 화면에 적용하는 것이다. 현재 색상, 글꼴, 카드, 버튼, 16:9 영상 스타일은 `SettingMain/web/app.css`의 기존 공통 규칙을 재사용한다.
- DOM 구조는 다음 순서와 ID를 사용한다.
  1. `<main>` 아래 `<div class="layout discovery-layout">`를 둔다.
  2. 첫째 자식은 대상 카드 `<section id="discoveryTarget" class="card">`다. 현재 `#cameraSelect`, `#activateCamera`, `#capability`, `#cameraNote`를 그대로 보존한다.
  3. 둘째 자식은 우측 영상 영역 `<aside id="discoveryViewer" class="discovery-view" aria-label="선택 카메라 영상">`이며, 그 안에 영상 카드 `<section class="card discovery-stream-card">`를 둔다. `#streamTag`, `#stream`, `#streamPlaceholder`, `#streamStart`, `#streamStop`, `#snapshotOnce`를 그대로 보존한다.
  4. 셋째 자식은 기존 `<div id="advanced">`다. 내부 카드 순서는 **탐색 프리셋 → 주차면 점 → 자동 작업**으로 유지한다. 모든 기존 입력·버튼 ID를 유지해 `discovery.js`의 직접 ID 조회와 `#advanced` 하위 제어 비활성화가 계속 동작하게 한다.
- 데스크톱 CSS는 `.discovery-layout`에 `grid-template-columns: minmax(320px, 420px) minmax(0, 1fr)`와 `grid-template-areas: "target viewer" "advanced viewer"`를 적용한다. `#discoveryTarget`, `#discoveryViewer`, `#advanced`를 각각 해당 영역에 연결한다. 공통 `.layout`과 동일한 최대 폭 1500px 및 16px 열 간격을 쓰되, 카드의 기존 `margin-bottom`과 겹치지 않도록 탐색 전용 grid의 세로 gap은 0으로 둔다.
- 우측 영상 영역은 1100px 초과 화면에서만 `position: sticky`와 상단 고정 헤더+본문 여백을 피하는 top offset을 사용한다. `position: fixed`는 사용하지 않는다. 고정 좌표 레이어는 본문을 덮고 반응형 전환·상태 토스트·키보드 확대 시 충돌하므로, 여기서 말하는 “고정 영상 패널”은 우측 열에 머무는 sticky 패널을 뜻한다.
- 내부 스크롤은 만들지 않는다. `#discoveryViewer`와 `#advanced`에 `min-width: 0`을 적용해 grid 최소 콘텐츠 폭 때문에 가로 스크롤이 생기지 않게 하고, 페이지 자체가 세로 스크롤을 담당한다. 영상은 기존 `.viewport`의 `aspect-ratio: 16 / 9`와 `object-fit: contain`을 유지해 자르거나 늘리지 않는다.
- 1100px 이하에서는 `grid-template-columns: 1fr`, `grid-template-areas: "target" "viewer" "advanced"`로 전환하고 sticky를 해제한다. 이 순서는 현재 정적 계약인 **대상 선택 → 카메라 뷰 → 고급 탐색 조작**을 모바일 및 보조기술의 읽기 순서에서도 보존한다.
- 영상 버튼 영역은 영상 카드의 viewport 다음 `.body.discovery-stream-actions`에 두고 기존 시작 → 정지 → 스냅샷 순서를 유지한다. 데스크톱·모바일 모두 행의 끝, 즉 카드 우측 하단에 정렬하되 `position: fixed/absolute`로 영상 위에 겹치지 않는다. 버튼에 `type="button"`과 `aria-controls="stream"`를 부여하는 범위까지 포함하며, 네이티브 `disabled` 상태는 유지한다.
- 접근성은 기존 label-for 연결, `#cameraNote[aria-live="polite"]`, `#streamTag[aria-live="polite"]`, 영상의 한국어 `alt`, focus outline을 보존한다. 페이지 상태 영역 `#status`에는 `role="status"`, `aria-live="polite"`, `aria-atomic="true"`를 명시해 비시각 사용자도 비동기 오류·완료를 알 수 있게 한다. 색상만으로 가용 상태를 전달하지 않고 기존 문구와 disabled 상태를 함께 유지한다.
- `SettingMain/web/discovery.js`의 스트림 수명주기를 재사용한다. 시작/스냅샷 전에 기존 연결을 정리하고 cache-busting URL을 생성하며, 오류·카메라 선택 변경·`refreshCameras()`·`pagehide`에서 `onerror`, `src`, `.live`, poller를 해제한다. ID를 보존하므로 레이아웃만을 위해 이 로직을 재작성하지 않는다.
- 기존 사용자 변경은 보존한다. 현재 작업 트리의 `discovery.html/js`는 untracked 사용자 산출물이고 `app.css`, `index.html`, 서버·테스트·문서에도 미커밋 변경이 있으므로, 개발자는 파일 전체 교체나 포맷 일괄 변경 없이 관련 DOM/CSS/정적 테스트 구간만 최소 수정한다. `index.html`과 `control.js`는 비교 기준이며 변경 대상이 아니다.

## 가정 / 확인 필요

- `SettingMain/`을 TypeScript(Node ESM) 서비스 루트로 본다. `SettingMain/package.json`, `SettingMain/tsconfig.json`, `SettingMain/vitest.config.ts`가 모두 존재하며 Node 20+, `type: module`, NodeNext/strict, Vitest Node 환경을 이미 규정하므로 부트스트랩은 필요하지 않다.
- 데스크톱/모바일 전환점은 기존 카메라 제어 화면과 같은 1100px을 사용한다. 새 디자인 시스템이나 추가 breakpoint는 도입하지 않는다.
- sticky top offset은 실제 topbar와 본문 여백을 피하는 탐색 전용 값으로 두되, 구현자가 브라우저에서 100%/200% 확대 및 헤더 줄바꿈을 확인해 겹침이 있으면 탐색 전용 CSS 값만 조정한다. 헤더 높이를 전역 고정값으로 강제하지 않는다.
- 확인 필요: 마스터가 말한 “우측 넓은 고정 영상 패널”을 화면 viewport에 `position: fixed`로 붙이는 의미가 아니라, 데스크톱의 우측 grid 열에서 스크롤 중 유지되는 sticky 카드로 해석했다. fixed overlay가 필수 요구라면 겹침·폭 계산·모바일 해제 계약을 별도로 승인받아야 한다.
- 확인 필요: 현재 실행 설정에는 문서상 BackendCore 카메라가 없어 활성 BackendCore 실제 화면과 고급 동작의 브라우저 검증이 불가능할 수 있다. 이 경우 Hucoms 비활성 상태와 모킹 테스트까지만 성공으로 기록하고 BackendCore 실환경 항목은 미검증으로 남긴다.
- 확인 필요: 외부 `AgentVLA/ParkAgent/SettingAgent`의 UI나 API 계약은 이번 레이아웃에 필요하지 않으며 확정하지 않는다. 이후 그 계약을 요구한다면 실제 코드 또는 문서의 구체 경로를 먼저 확인해야 한다.

## 보존 계약

- 고급 기능의 클라이언트 gate는 `선택 camera.id === activeCameraId && camera.kind === 'backend-core'`일 때만 열린다. 비가용 상태에서도 `#advanced`는 숨기지 않고 모든 하위 native input/select/button을 disabled로 보여 준다.
- 서버는 `SettingMain/src/api/server.ts`의 `handleDiscovery()`에서 활성 카메라만 사용하고 비-BackendCore에 HTTP 409를 반환한다. UI 배치나 CSS로 이 방어를 완화하지 않는다.
- `BackendCoreClient`가 외부 409/422/501을 보존하는 계약, discovery point가 x/y만 저장해 `#centerBox`가 항상 disabled이고 서버가 501을 반환하는 계약, VLA tour가 `saveSpots:false`를 강제하는 계약을 변경하지 않는다.
- Hucoms 또는 아직 활성화하지 않은 BackendCore 후보에서도 영상 읽기는 `#cameraSelect`의 선택 ID를 명시한 기존 `/api/stream?cameraId=...` 및 `/api/snapshot?cameraId=...`만 사용한다. 영상 보기만으로 `/api/cameras/active`, PTZ, preset goto, center, calibration, plate-home, tour를 호출하지 않는다. 활성 카메라 변경은 `#activateCamera`의 명시적 조작으로만 수행한다.
- 자동 재생·자동 재연결을 추가하지 않는다. 페이지를 여는 것만으로 카메라를 점유하지 않으며, 오류 후에는 사용자 조작으로 다시 시작한다.

## 단계

### 1. 기존 계약을 고정하는 테스트 보강

- `SettingMain/test/server.test.ts`의 기존 `/discovery` 정적 계약에 탐색 전용 grid wrapper, `#discoveryTarget`, `#discoveryViewer`, `#advanced` 및 DOM 순서를 추가한다.
- `app.css`를 읽는 정적 회귀 검증으로 데스크톱 2열 grid area, viewer sticky, `min-width: 0`, 1100px 이하 1열 순서와 sticky 해제를 고정한다. 현재 Node 환경을 유지하고 DOM/CSS 테스트만을 위해 jsdom이나 새 의존성을 추가하지 않는다.
- 기존 영상 수명주기, BackendCore 이중 gate, Hucoms 409, center-box 501, 409/422 전달 테스트를 유지한다.

검증 가능 성공 기준:

- 변경 전 새 레이아웃 계약 테스트가 실패해 요구가 기존 구현과 구분된다.
- 테스트가 exact 픽셀이나 색상을 고정하지 않고 구조, 영역 배치, breakpoint, sticky 해제, 보존 ID와 호출 안전 경계만 검증한다.
- 기존 사용자 추가 테스트를 삭제·완화하지 않는다.

### 2. 탐색 HTML 정보구조 재배치

- 위에서 정한 3개 direct child 구조로 `discovery.html`만 재배치한다. 기존 텍스트, 입력, 버튼, ID, disabled/title, `/options` 안내와 `#advanced` 가시성을 보존한다.
- 영상 viewport를 카메라 제어 페이지처럼 카드 heading 바로 아래에 두고, 버튼 body를 그 아래 우측 정렬 대상으로 분리한다.
- 접근성 속성을 보강하되 탭 순서 조작용 양수 `tabindex`, ARIA로 네이티브 disabled를 흉내 내는 패턴, 자동 focus 이동은 도입하지 않는다.

검증 가능 성공 기준:

- `/discovery` HTML에서 모든 기존 `discovery.js` 참조 ID가 정확히 한 번 존재한다.
- DOM/탭 순서는 대상 선택 → 영상 읽기 조작 → 탐색 프리셋 → 주차면 점 → 자동 작업이며, `#stream*`는 `#advanced` 밖에 있고 `#advanced`는 hidden이 아니다.
- Hucoms 상태에서도 영상 시작/정지/스냅샷만 선택 카메라 기준으로 사용 가능하고 고급 입력은 disabled다.

### 3. 탐색 전용 CSS grid·sticky·반응형 적용

- `app.css`에 `.discovery-*` 및 탐색 ID로 한정한 규칙만 추가한다. 기존 `.layout`, `.card`, `.viewport`, `.row`는 재사용하고 카메라 제어/옵션 페이지의 전역 규칙은 바꾸지 않는다.
- 데스크톱은 왼쪽 320~420px, 오른쪽 가변 폭, sticky 영상으로 만들고, 작은 화면에서는 대상 → 영상 → 조작의 한 열과 normal positioning으로 되돌린다.
- 영상 버튼은 카드 하단 우측 정렬만 하며 overlay/fixed 및 별도 내부 overflow를 만들지 않는다.

검증 가능 성공 기준:

- 1440px급 화면에서 대상·고급 카드가 왼쪽 열에 순서대로 있고 영상 카드가 오른쪽 남은 폭을 사용한다. 페이지를 왼쪽 콘텐츠 끝까지 스크롤해도 영상 카드가 topbar를 침범하지 않고 우측 열에 유지된다.
- 1100px 이하와 390px 폭에서 한 열로 전환되고 가로 스크롤, 카드 겹침, 잘린 버튼/입력, sticky 잔존이 없다.
- 영상은 16:9 안에서 contain으로 표시되고 버튼은 영상 위를 가리지 않으며 카드 우측 하단에 정렬된다.
- `/`, `/options`의 폭, 열 수, 카드 및 영상 배치에는 시각 회귀가 없다.

### 4. 자동 테스트와 비파괴 실제 검증

- `SettingMain/`에서 `npm run typecheck`, `npm run test`, `npm run build`, 저장소 루트에서 `git diff --check`를 실행한다.
- 가능한 경우 실제 로컬 SettingManager에서 `/discovery`, `/discovery.js`, `/app.css`, `/api/cameras`를 GET으로 확인하고, 브라우저를 1440px·1100px·768px·390px 및 200% 확대에서 확인한다.
- 브라우저 검증은 키보드 Tab/focus, disabled 상태, `aria-live`, 선택 변경 시 영상 정리, 시작→정지→스냅샷, `pagehide` 연결 종료를 확인한다. MJPEG 연결은 검증 후 반드시 정지한다.
- 운영 PTZ, preset goto, center, calibration, plate-home, VLA tour 및 활성 카메라 변경은 실제 검증에서 실행하지 않는다. `/api/discovery/*`의 409 확인도 GET처럼 상태를 바꾸지 않는 안전한 경로로 제한하고, 운영 카메라에 대한 이동성 요청은 별도 명시 승인이 있어야 한다.

검증 가능 성공 기준:

- typecheck/test/build/diff-check가 모두 exit 0이며 기존 전체 테스트가 통과한다.
- 실제 브라우저를 사용할 수 있으면 위 네 폭에서 desktop/mobile 배치, sticky 해제, 키보드 접근, 영상 수명주기가 관찰된다. 사용할 수 없거나 BackendCore가 없으면 해당 항목과 사유를 QA 보고서에 명시하고 성공으로 간주하지 않는다.
- 검증 중 설정 파일, 활성 카메라, 프리셋, discovery point, 작업 상태가 변경되지 않고 물리/시뮬 카메라 제어 명령이 전송되지 않는다.

## 영향 받는 파일/모듈

- 직접 수정 예정
  - `SettingMain/web/discovery.html`: 3영역 DOM 재배치, 탐색 전용 hook, 접근성 속성.
  - `SettingMain/web/app.css`: 탐색 화면에 한정한 grid area, sticky, 버튼 정렬, responsive 규칙.
  - `SettingMain/test/server.test.ts`: HTML/CSS 구조 및 기존 안전 계약 회귀 테스트.
- 읽고 회귀 확인하되 원칙적으로 수정하지 않음
  - `SettingMain/web/discovery.js`: ID 소비자, 스트림 수명주기, BackendCore gate/poller. 마크업 ID 보존으로 변경 불필요.
  - `SettingMain/web/index.html`, `SettingMain/web/control.js`: 좌우 정보구조와 영상 수명주기의 비교 기준.
  - `SettingMain/src/api/server.ts`: 선택 카메라 영상 라우팅, 활성 BackendCore 409 gate, center-box 501의 생산자.
  - `SettingMain/src/clients/backendCoreClient.ts`, `hucomsClient.ts`, `src/stream/*`: BackendCore 오류 보존 및 Hucoms/BackendCore 영상 읽기의 소비 경계.
- 변경 없음
  - `SettingMain/package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, config 파일 및 API/DTO.
  - 형제 `AgentVLA/ParkAgent/SettingAgent`, BackendCore 및 카메라/시뮬레이터 코드.

## 비범위

- 스크린샷 픽셀 복제, 새 테마/디자인 시스템, 카메라 제어 페이지·옵션 페이지 재설계.
- 새 API, DTO, 설정, 의존성, 빌드 구성, 인증, lease, 다중 탭 점유 조정.
- 스트림 프로토콜 변경(WebSocket/WebRTC/HLS), 자동 재생/재연결, 녹화, 다운로드, 오버레이, 다중 카메라 동시 영상.
- discovery CRUD·센터링·캘리브레이션·호밍·VLA 알고리즘 및 poll 주기 변경, center-box 활성화, BackendCore active device 동기화.
- 실제 운영 PTZ/프리셋 이동, center/calibration/home/tour 실행, 운영 config나 활성 카메라 변경.
- 근거 코드·문서 경로를 확인하지 않은 외부 SettingAgent 계약의 추정 또는 변경.
