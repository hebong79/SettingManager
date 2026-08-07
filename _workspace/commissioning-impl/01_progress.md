# 커미셔닝 3컴포넌트 — 구현 워크스페이스

- 브랜치: `feat/commissioning-impl` (설계 브랜치 `feat/commissioning-components` 에서 분기)
- 설계서: [docs/20260807_112349_커미셔닝_3컴포넌트_설계서.md](../../docs/20260807_112349_커미셔닝_3컴포넌트_설계서.md)

## 진행

- [x] **M0 프로파일 기반** — `src/profiles/` (types·store·gate·drift·sink) + `/api/profiles` + 벤더 타입 선언 정정
- [x] **A 캘리브레이션** — `src/calibration/` (jpegSize·frameDecode·frameMatch·sweepPlan·cameraLock·job·component)
- [x] **B 센터라이징** — `src/centering/` (aimChain·softwareCentering·zoomTable·component)
- [x] **C 차량 3D 육면체** — `src/vehiclebox/` (object3dClient 이동·store·component) + 스키마 v6
- [x] 브리지 위임 배선 + 라우트 + MCP 카탈로그
- [x] 웹 화면 (`/calibration` · `/vehiclebox`)
- [x] 테스트 + typecheck — **810건 중 790 통과, 새로 깨진 것 0건**(기존 실패 20건은 손대지 않음)
- [x] 구현 문서 [20260807_122453](../../docs/20260807_122453_커미셔닝_3컴포넌트_구현.md)
- [ ] 커밋

## 설계에서 바뀐 것 (구현하며 드러난 사실)

| # | 무엇 | 왜 |
|---|---|---|
| 1 | **`boxProjection` 없음** | 사이드카가 `segments` 를 이미 이미지 좌표로 준다. 설계 단계에서 확인해 모듈째 삭제 |
| 2 | **`CameraDriver.zoomRange?` 추가** | 설계서는 "드라이버 계약 불변"이라 했으나, 부분 표 게이트(12배 과회전 방지)를 물으려면 기기가 자기 범위를 선언해야 한다. **선택 필드**라 기존 드라이버는 무영향 |
| 3 | **`zoomTable.ts` 이동** | `core/bridge/` → `centering/`. 박스 줌은 센터라이징 소관이라 컴포넌트 자기완결이 된다. `test/zoomTable.test.ts` 의 import 한 줄만 바뀜 |
| 4 | **런타임 적용본은 `config.json` 이 아니라 DB** | 이 저장소는 카메라 정본이 `camera_info` 다. 자리가 다를 뿐 규칙(적용 먼저·발행 나중)은 상류와 같다 |
| 5 | **`FrameDecoder.probe()` 메모이즈** | `capabilities()` 는 화면이 폴링하는 경로다. 물을 때마다 spawn 하면 버튼 그리는 데 초당 여러 번 프로세스가 뜬다 |
| 6 | **컴포넌트는 프로세스당 하나** | `createCoreProvider` 는 요청마다 불린다. 거기서 만들면 20분짜리 스윕 기록이 폴링마다 사라진다 → `createCoreComponents()` 분리 |
| 7 | **캘리브 `status`·`stop` 은 미지원 기기에서도 답한다** | 적합성 스위트의 판정 대상은 **행위**다. 읽기에 501 을 내면 화면이 잡 패널을 아예 못 그린다 |

## 구현하며 확인된 살아 있던 결함

`BridgeCoreProvider.center()` 가 클릭 픽셀을 **게인 없이** 넘기고 있었다 → `CenteringComponent.center()` 가
`aimPixel()` 을 통과시키고 응답에 `gain` 을 싣는다. 1 이면 "보정이 없었다"는 것도 사실로 보고한다.

## 아직 막혀 있는 것 (승인 대기)

1. 실카메라 20분 점유 스윕 — 목·시뮬 검증은 막지 않음
2. `object3d` 사이드카 기동 + `cameras/<기기id>.json` — 우리 코드 검증은 목으로 가능
3. 프로파일 발행본 git 추적 여부
