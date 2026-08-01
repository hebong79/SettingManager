# QA 보고서 — 주차면 탐색 카메라 제어형 레이아웃

## 판정

**통과.** 계획서의 정적 구조·반응형·안전 계약과 독립 자동 검증이 모두 통과했다. 실제 13030 서버는 기존 프로세스를 유지한 채 GET 요청만 수행했다.

## 검토 범위

- 설계: `_workspace/01_architect_plan.md`
- 구현 기록: `_workspace/02_developer_changes.md`
- 직접 변경 범위: `SettingMain/web/discovery.html`, `SettingMain/web/app.css`, `SettingMain/test/server.test.ts`
- 보존 경계: `SettingMain/web/discovery.js`, `SettingMain/src/api/server.ts`, `SettingMain/src/clients/backendCoreClient.ts` 및 관련 격리 테스트

## 독립 실행 결과

| 명령 | 결과 |
| --- | --- |
| `SettingMain`: `npm run typecheck` | 통과 (exit 0) |
| `SettingMain`: `npm run test` | 통과 — 9 파일, 178/178 테스트 |
| `SettingMain`: `npm run build` | 통과 (exit 0) |
| 저장소 루트: `git diff --check` | 통과 (exit 0, CRLF 변환 경고만 존재) |

## 레이아웃·접근성 검증

- `/discovery` 실제 GET 응답은 200이며, `.layout.discovery-layout`의 direct child가 `#discoveryTarget → #discoveryViewer → #advanced` 순서임을 확인했다.
- 실제 `/app.css` GET 응답에서 데스크톱은 `minmax(320px, 420px) minmax(0, 1fr)`와 `"target viewer" / "advanced viewer"` grid area를 사용한다.
- 1101px 이상에서만 `#discoveryViewer { position: sticky; top: 72px; }`이고, 1100px 이하에서는 한 열 `target → viewer → advanced` 및 `position: static`으로 해제한다.
- `#discoveryViewer`, `#advanced`의 `min-width: 0`, 영상 버튼 우측 정렬, 16:9/`object-fit: contain`, `#status`·`#streamTag`의 live-region 속성과 각 영상 버튼의 `type="button"`, `aria-controls="stream"`을 확인했다.
- `server.test.ts`의 정적 회귀 테스트가 위 HTML/CSS 구조, 모든 `discovery.js` 소비 ID의 단일 존재, 버튼·ARIA 계약을 함께 고정하며 전체 테스트에서 통과했다.

## 안전 계약 검증

- 클라이언트 gate: `discovery.js`는 선택 카메라 ID가 활성 ID와 같고 `kind === 'backend-core'`일 때만 고급 기능을 연다. 비가용이면 고급 native control을 disabled로 두며 `centerBox`는 항상 disabled다.
- 서버 gate: `src/api/server.ts`의 `handleDiscovery()`는 활성 카메라가 BackendCore가 아니면 409를 반환하고, `/api/center-box`는 BackendCore에서도 501을 반환한다.
- 격리 `server.test.ts`는 Hucoms의 discovery/calibration/center/home/tour 경로 409, center-box 501, BackendCore capability 422 전달을 검증한다. 격리 `backendCoreClient.test.ts`는 BackendCore 409/422 보존 및 VLA tour의 `saveSpots:false` body 전달을 검증한다. 모두 이번 178개 통과 결과에 포함된다.
- 실제 13030의 `/api/cameras`는 GET으로만 확인했다. 활성 카메라는 `simulator-1`(Hucoms)이며 BackendCore 카메라는 없었다. PTZ, goto, center, calibration, home, tour, 활성 카메라 변경 및 POST 제어 명령은 전혀 실행하지 않았다. `/api/stream`·`/api/snapshot`도 호출하지 않았다.

## 실제 화면 검증 한계

- 인앱 브라우저 제어 표면(`iab`)이 현재 제공되지 않아 1440px/1100px/768px/390px의 렌더링, sticky 스크롤 동작, 키보드 focus와 오버플로를 직접 관찰하지 못했다.
- 대체로 기존 13030 서버에서 `/discovery`, `/app.css`, `/api/cameras`를 읽기 전용 GET으로 확인하고, HTML/CSS 정적 계약 및 Vitest로 검증했다. 실제 BackendCore 장비도 구성되어 있지 않아 고급 기능의 실환경 UI 동작은 미검증이다.

## 변경·프로세스 보존

- QA는 소스·테스트·설정을 수정하지 않았고, 이 보고서만 추가했다.
- 포트 13030의 기존 리스너(PID 6100)를 종료하거나 재시작하지 않았다.
