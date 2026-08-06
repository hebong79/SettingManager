# 08. 설계 — park3d-rpc 제어/영상 포트 분리 정정

브랜치: `fix/park3d-stream-port-per-camera`

## 1. 사실 확정 (라이브 실측, 192.168.0.125 · 2026-08-06)

| 요청 | 13510 | 13601 / 13602 |
|---|---|---|
| `POST /rpc` cam.getPTZ | 200 `{"result":{"pan":113.8,"tilt":6,"zoom":2.9}}` | 200 `multipart/x-mixed-replace; boundary=park3dframe` — **영상이 온다** |
| `GET /stream` | 200 multipart (HEAD 는 404 — UE 서버가 HEAD 미처리) | 200 multipart |

- 제어(RPC)는 **서버 하나: 13510**. 카메라 대수와 무관하다.
- 영상은 **카메라별 포트 13601~13650 = 13600 + camId** (camId 1-based). 마스터 확정.
- **오진 위험**: 스트림 포트는 경로를 보지 않고 무조건 MJPEG 를 돌려준다. 제어 URL 에 13601 을 적으면
  404 가 아니라 200 + 영상이 와서 `park3dRpcClient.ts:131` 의 `Park3D RPC 응답을 해석할 수 없습니다` 로만
  드러난다 — "연결은 되는데 PTZ 만 안 먹는" 형태라 원인을 짚기 어렵다. 화면에서 미리 잡는 이유다.

## 2. 옛 전제("제어=영상 같은 포트")가 박힌 곳 — 전수

| 파일:라인 | 내용 | 처리 |
|---|---|---|
| `web/optionsDb.js:151-158` | 중복된 JSDoc 2개, "park3d-rpc 는 같은 포트라 규칙 미적용" | 새 규칙으로 재작성 |
| `web/optionsDb.js:164` | `if (kind === 'park3d-rpc') return '';` — 무조건 통과 | park3d 전용 검증으로 교체 |
| `web/optionsDb.js:184` | 힌트 "같은 포트의 /stream 을 중계합니다" | "카메라별 포트 13600 + camId" |
| `config/config.example.json:84,91` | `_comment` 및 `streamUrl: 13510/stream` | 13601 (camId 1) + 설명 정정 |
| `src/devices/park3d/park3dRpcClient.ts:10` | "`GET /stream` 200" — 같은 포트 뉘앙스 | 영상은 별 포트임을 명시 |
| `test/optionsPark3dUi.test.ts:36-38,49-51` | 옛 전제를 **고정**하는 단언 | 새 사실로 교체 |
| `test/park3dRpcServerRoutes.test.ts:85-86` | 주석 "제어·영상이 같은 포트" + 픽스처 | 13601 로 정정 |
| `test/park3dRpcClient.test.ts:209` | 픽스처 `13510/stream` (camId 1) | 13601 로 정정 |
| `docs/20260805_003651_*.md:252,263` | 당시 사실로 기록된 문서 | **덮어쓰지 않는다** — 상단에 정정 각주 + 신규 문서 링크 |

## 3. 변경 설계

### 3-1. `portPairWarning(controlUrl, streamUrl, kind, camId)` — 인자 1개 추가

park3d-rpc 분기를 **통과에서 검증으로** 바꾼다. 두 가지를 본다:

1. 제어 URL 포트가 13601~13650 → `⚠ 13601 은 영상 포트입니다 — 제어 URL 에는 RPC 서버 포트(예: 13510)를 적으십시오`
2. 영상 포트 ≠ 13600 + camId → `⚠ camId 2 의 영상 포트는 13602 입니다 — 지금 13605 는 다른 카메라를 봅니다`

제약: 이 함수는 **최상위 순수 함수를 유지**하고 상수도 **함수 본문 안**에 둔다.
테스트가 `function portPairWarning` ~ 열 0 의 `}` 까지 본문만 떼어 `new Function` 으로 평가하므로,
바깥 상수를 참조하면 ReferenceError 로 죽는다.

hucoms/backend-core 의 `영상 = 제어 + 10` 분기는 **문자 그대로 보존**한다.

### 3-2. `streamHint()` — kind 를 저장값이 아니라 화면값에서 읽는다

현재 `const kind = selected()?.kind` 는 **저장된 행**을 본다. 그런데 302줄에 `camKind` 의 `change` →
`streamHint` 배선이 이미 있다 — 종류를 바꿔도 힌트가 옛 종류로 계산되어 배선이 헛돈다.
새 경고가 종류에 따라 갈리므로 이 불일치를 두면 경고 자체가 거짓이 된다. `$('camKind').value` 로 바꾼다
(`renderEditor` 가 `camKind` 를 채운 **뒤** `streamHint()` 를 부르므로 안전하고, `draft()` 와도 같은 출처가 된다).

camId 도 같은 이유로 `$('camPark3d').value` — 저장 전 편집 중인 값이 화면 경고에 반영되어야 한다.
`camPark3d` 에 `input` → `streamHint` 배선을 추가한다(지금은 없어서 camId 를 고쳐도 경고가 안 갱신된다).

## 4. 검증 기준 (성공 조건)

| # | 단계 | 검증 |
|---|---|---|
| 1 | `portPairWarning` 교체 | `optionsPark3dUi.test.ts` 에서 본문을 실제 평가 — 제어 13601 경고 / 영상 13605(camId 2) 경고 / 13602(camId 2) 무경고 / camId 미입력 무경고 |
| 2 | hucoms 회귀 없음 | 기존 3건(8091 무경고, 8095 경고, kind 없는 옛 호출부) 그대로 통과 |
| 3 | `streamHint` 배선 | 소스에 `$('camKind').value`, `$('camPark3d')` 인자·`input` 배선 존재 |
| 4 | 문구 정정 | 소스에 "같은 포트" 문자열이 남아 있지 않음 |
| 5 | 전체 회귀 | `npm run typecheck` + `npm run test` 전체 통과 |

## 5. 확인 필요

없음 — 포트 공식(13600 + camId)과 작업 범위는 마스터가 확정했다.
