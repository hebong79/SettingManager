# 개발 변경 기록 — 주차면 탐색 카메라 제어형 레이아웃

## 구현 범위와 계획 추적

`_workspace/01_architect_plan.md`의 1~4단계 범위만 구현했다. `discovery.js`, 서버 API, 클라이언트, 설정, 의존성은 변경하지 않았다.

| 계획 단계 | 변경 파일 | 구현 내용 |
| --- | --- | --- |
| 1. 기존 계약을 고정하는 테스트 보강 | `SettingMain/test/server.test.ts` | `/discovery`의 `discovery-layout` direct-child 순서, 영상 버튼 접근성 속성, 상태 영역 ARIA 및 탐색 전용 CSS grid/sticky/mobile 정적 계약을 추가했다. `discovery.js`가 직접 소비하는 모든 ID가 HTML에 정확히 한 번 존재하는지도 검증한다. 기존 BackendCore 이중 gate, Hucoms 409, center-box 501, 오류 전달 검증은 보존했다. |
| 2. 탐색 HTML 정보구조 재배치 | `SettingMain/web/discovery.html` | `.layout.discovery-layout`의 direct child를 `#discoveryTarget`, `#discoveryViewer`, `#advanced` 순서로 재배치했다. 기존 제어 ID와 고급 카드 순서를 보존했고, 영상 버튼을 viewport 아래의 `.body.discovery-stream-actions`로 옮겼다. `#status`의 상태 ARIA를 명시했다. |
| 3. 탐색 전용 CSS grid·sticky·반응형 적용 | `SettingMain/web/app.css` | 탐색 전용 grid area, 좌측 320~420px/우측 가변 열, 1101px 이상 sticky viewer, 1100px 이하 target→viewer→advanced 한 열, `min-width: 0`, 고급 카드 full width와 영상 카드 하단 우측 버튼 정렬만 추가했다. 기존 전역 레이아웃·영상 규칙은 바꾸지 않았다. |
| 4. 자동 테스트와 비파괴 실제 검증 | 아래 검증 결과 | 타입 검사, 전체 Vitest, 빌드, `git diff --check`를 실행했다. |

## 구현 결정

- viewer의 “고정”은 설계의 해석을 따라 `position: sticky; top: 72px`로 구현했다. `fixed`/overlay/내부 스크롤은 사용하지 않았다.
- `#discoveryViewer`와 `#advanced`에 `min-width: 0`을 부여해 grid 최소 콘텐츠 폭에 의한 가로 스크롤을 방지했다.
- 시작·정지·스냅샷 버튼에 `type="button"` 및 `aria-controls="stream"`을 추가했으며 native `disabled` 상태와 기존 ID를 유지했다.
- 스트림 lifecycle과 BackendCore gate의 구현은 변경하지 않았다. 레이아웃 변경만으로 안전 계약이 유지되며, 기존 정적 테스트도 함께 통과한다.

## 계획과 다른 점

- 없음.

## 검증 경계면

- `SettingMain/`에서 `npm run typecheck` 통과.
- `SettingMain/`에서 `npm run test` 통과: 9 파일, 178 테스트.
- `SettingMain/`에서 `npm run build` 통과.
- 저장소에서 `git diff --check` 통과. 기존 작업 트리의 다른 미커밋 변경은 수정하거나 되돌리지 않았다.
- 정적 HTML/CSS 계약은 `SettingMain/test/server.test.ts`에서 검증했다. 서버 API, BackendCore/Hucoms gate, centerBox 미지원 및 스트림 lifecycle은 이 변경에서 코드 수정 없이 기존 회귀 테스트로 보존 확인했다.

## 미검증

- 로컬 서버 및 브라우저의 1440px/1100px/768px/390px, 200% 확대 시각 검증은 이 개발 단계에서 실행하지 않았다. QA 단계에서 비파괴 방식으로 확인해야 한다.
- 운영 카메라의 PTZ, preset goto, center, calibration, home, VLA tour 및 활성 카메라 변경은 실행하지 않았다.
