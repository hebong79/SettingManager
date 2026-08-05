# 10 설계서 — `my_setting_manager_구성.md` 구조 정렬

- 작성: 2026-08-05
- 근거 문서: `docs/my_think/my_setting_manager_구성.md`
- 대상: `SettingMain/`
- 범위 결정(사용자 확정): **계약·골격까지**. 미구현은 501 확정답 + `capabilities:false` 로 정직하게 노출한다.

---

## 사용자 확정 결정 (임의 변경 금지)

| # | 질문 | 결정 |
|---|---|---|
| D1 | 작업 범위 | **계약·골격까지.** 능력 자리·클라이언트 계층을 만들되 미구현은 501 |
| D2 | `LocalCoreProvider` 명칭 | **`bridge` 로 리네임** (md 의 "Bridge Backend-Core"). 구 설정값 `"local"` 은 읽기 호환 유지 |
| D3 | API 계층(VPD/LPD/LPR) | **HTTP 클라이언트 계층 신설.** LPR 은 서비스가 없으므로 미설정 시 501 |
| D4 | 3D 육면체 | **SettingManager 가 자체 계산** (`domain/` 순수 로직) |

---

## as-is ↔ md 대조 (실측)

| md 항목 | 현재 대응 | 상태 |
|---|---|---|
| Web Client | `web/` | ✅ |
| Setting Agent (Manager) | `SettingMain/` | ✅ |
| Backend-Core | `src/core/remote/remoteCoreProvider.ts` | ⚠ 캘리브·센터링·호밍만 |
| Bridge Backend-Core | `src/core/local/localCoreProvider.ts` | ⚠ 이름 불일치 + 센터링만 |
| 카메라/시뮬레이션 접속 | `src/devices/` · `src/media/` | ✅ |
| 주차면 3D 육면체화 | — | ❌ 없음 |
| 주차면 관리 및 매핑 | `src/store/slotStore.ts` | ⚠ 목록 읽기만 |
| API 계층 VPD/LPD/LPR | `Sub/vpd_api` · `Sub/lpd_api` (별도 파이썬) | ❌ SettingMain 이 호출하지 않음. LPR 부재 |

---

## M1 — `local` → `bridge` 리네임

| 파일 | 변경 |
|---|---|
| `src/core/local/` → `src/core/bridge/` | 디렉토리 이동(`cameraLease.ts` 동반) |
| `localCoreProvider.ts` → `bridgeCoreProvider.ts` | `LocalCoreProvider` → `BridgeCoreProvider`, `name = 'bridge'` |
| `src/core/coreProvider.ts` | `CoreProviderName = 'remote' \| 'bridge'` |
| `src/config/types.ts` | `CoreProviderChoice = 'bridge' \| 'remote'` |
| `src/config/normalize.ts` | `normalizeCore` 가 **`'local'` 을 `'bridge'` 로 접어 읽는다**(구 `config.json` 호환). 기본값 `'bridge'` |
| `src/core/providerFactory.ts` | import·생성자명 갱신 |
| `web/options.html` · `web/options.js` | `<option value="bridge">`, 태그 문구 |
| `config/config.json` · `config.example.json` | `core.provider: "bridge"` |
| `src/mcp/routeCatalog.ts` | notes 의 `local·remote` → `bridge·remote` |
| 테스트 | `test/localCoreProvider.test.ts` → `bridgeCoreProvider.test.ts`, 기대값 `'local'` → `'bridge'` |

**건드리지 않는 것**: `src/api/routes/presetRoutes.ts:64` 의 `source: 'local'` — 주차면 출처(시뮬 vs 로컬 파일)이고 코어 구현과 **다른 개념**이다.

**검증**: `normalizeCore({provider:'local'}).provider === 'bridge'` / 기존 `config.json` 로드가 깨지지 않음 / 전체 테스트 그린.

---

## M2 — 코어 능력 2종 계약 추가

md 의 Backend-Core·Bridge 하위 항목 5개 중 **차량 3D 육면체 관리 · 주차면 생성** 두 개가 계약에 없다.

- `CORE_CAPABILITY_NAMES` 에 `'vehicleBox'`, `'slotCreate'` 추가.
- 두 구현 모두 `supported` 에 **사유와 함께 `ok:false`** 를 싣는다.
  - remote: backend-core 의 대응 API 경로가 **미확인**이라는 사유(추측 금지).
  - bridge: 미구현이라는 사유.
- **포트(메서드)는 만들지 않는다.** 요청/응답 shape 이 확정되지 않았고, 지어낸 시그니처는
  나중에 실측과 어긋나면 전부 다시 깎아야 한다. 능력 이름만으로도 `GET /api/core/capabilities` 가
  "이 두 가지는 아직 아무도 못 한다"를 정직하게 답한다.

**검증**: `checkCapabilitiesShape` 가 능력 6→8개를 요구하게 되고, 두 구현 모두 통과.

---

## M3 — 주차면 3D 육면체화 (자체 계산, 순수 도메인)

`src/domain/slotBox.ts` — 외부 I/O 없음.

- `SlotFloorPolygon`: 바닥 4점 `{x,y,z}` (월드 좌표, m)
- `SlotBox`: `floor` + `height` + `vertices`(8점, 바닥 4 → 천장 4 순서)
- `buildSlotBox(floor, heightMeters): SlotBox` — 바닥 폴리곤을 +Z 로 압출한다.
- 유효성: 점 4개 정확히, 모든 좌표 유한수, `height > 0`. 아니면 `SlotBoxError`.

**하지 않는 것**: 픽셀 → 월드 변환. 캘리브레이션 산출물이 필요하고 그것이 아직 없다.
이 모듈은 **월드 좌표가 이미 있을 때의 압출**만 책임진다.

**검증**: 순수 함수 유닛테스트(정상 압출 · 점 개수 오류 · 높이 0/음수 · NaN).

---

## M4 — API 계층 (VPD · LPD · LPR)

### 실측 계약 (`Sub/` 소스에서 확인 — 추측 아님)

| 검출기 | 경로 | 응답 |
|---|---|---|
| VPD | `POST {base}/vpd/api/v2/det/imgupload` (multipart `file`) → 201 | `{success,id,bboxes:[[x1,y1,x2,y2]],masks,confidences,classes}` — 근거 `Sub/vpd_api/routers/yolo.py:32-100`, `schemas/yolo.py` |
| LPD | `POST {base}/lpd/api/v1/imgupload` (multipart `file`) → 201 | `{success,id,polygons:[[[x,y]×4]],confidences,classes}` (TL→TR→BR→BL) — 근거 `Sub/lpd_api/routers/yolo.py:33-102`, `schemas/yolo.py:12-15` |
| LPR | — | **서비스 없음.** 인터페이스만 두고 항상 501 |

### 파일

- `src/detectors/detectorTypes.ts` — `DetectorName`, `DetectorResult`, `DetectorClient` 계약, `DetectorUnsupportedError(501)`
- `src/detectors/vpdClient.ts` · `lpdClient.ts` · `lprClient.ts`
- `src/detectors/detectorFactory.ts` — 이름 → 클라이언트. `baseUrl` 이 비면 501("설정되지 않았습니다")
- `src/detectors/multipart.ts` — 런타임 의존성 0 원칙을 지키기 위한 최소 multipart 본문 조립
- `src/config/types.ts`·`normalize.ts` — `detectors: { vpd|lpd|lpr: { baseUrl, timeoutMs } }`
- `src/api/routes/detectorRoutes.ts`
  - `GET /api/detectors` — 세 검출기의 설정 상태(`configured`·`baseUrl`)
  - `POST /api/detectors/:name/detect` — 대상 카메라 스냅샷 1장을 그 검출기로 보낸다
- `src/mcp/routeCatalog.ts` — 위 2건 등재(카탈로그 정합성 테스트가 요구)

> **범위 초과 고지**: 사용자 답변은 "클라이언트 계층 신설"이었고 라우트는 언급되지 않았다.
> 라우트 2건을 붙이는 이유는 **CLAUDE.md 3항(동작 확인)** — 호출자가 없으면 이 계층이
> 실제로 도는지 확인할 방법이 없기 때문이다. 원치 않으면 라우트만 떼어내면 된다.

**검증**: 모킹 fetch 로 요청 URL·multipart 본문·응답 매핑, 미설정 501, 상류 오류 전파.

---

## M5 — 검증

`npm run typecheck` → `npm run test` 실제 실행. 기존 테스트 전부 그린 유지(리네임으로 인한 기대값 변경 외 회귀 0).

## M6 — 문서

`docs/yyyyMMdd_HHmmss_구조정렬_md구성반영.md` — 변경 목록 · 신규 클래스 설명 · 영향도 분석.

---

## 비범위 (하지 않을 것)

- backend-core 의 차량 육면체·주차면 생성 API 연동 (경로 미확인 — 실측 후 별건)
- 픽셀 → 월드 좌표 변환 / 캘리브레이션 자체 구현
- 주차면 ↔ 카메라 매핑 저장소 (md 의 "주차면 관리 및 매핑" 중 매핑 부분 — 키 정의가 미확정)
- LPR 서비스 구현
- 웹 UI 에 검출 결과 표시 화면 추가
