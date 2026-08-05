# 구조 정렬 — `my_setting_manager_구성.md` 반영

| 항목 | 값 |
|---|---|
| 문서 | 구성도 대조 · 변경 목록 · 신규 클래스 설명 · 검증 결과 · 영향도 분석 |
| 작성 | 2026-08-05 18:58:00 |
| 근거 | `docs/my_think/my_setting_manager_구성.md` · 사용자 확정 결정 4건 |
| 설계서 | `_workspace/10_structure_align_plan.md` |
| 범위 | **계약·골격까지.** 미구현은 501 확정 답 + `capabilities:false` 로 정직하게 노출 |

---

## 1. 사용자 확정 결정 (임의 변경 금지)

| # | 질문 | 결정 |
|---|---|---|
| D1 | 작업 범위 | **계약·골격까지** |
| D2 | `LocalCoreProvider` 명칭 | **`bridge` 로 리네임** (구성도의 "Bridge Backend-Core"). 옛 설정값 `"local"` 은 읽기 호환 유지 |
| D3 | API 계층(VPD/LPD/LPR) | **HTTP 클라이언트 계층 신설.** LPR 은 대응 서비스가 없으므로 501 |
| D4 | 3D 육면체 | **SettingManager 가 자체 계산** (`domain/` 순수 로직) |

---

## 2. 구성도 ↔ 코드 대조 (작업 후)

| 구성도 항목 | 코드 | 상태 |
|---|---|---|
| Web Client | `SettingMain/web/` | ✅ |
| Setting Agent (Manager) | `SettingMain/` | ✅ |
| **Backend-Core** | `src/core/remote/remoteCoreProvider.ts` | 캘리브레이션·센터라이징·호밍 ✅ / 차량 육면체·주차면 생성은 **능력 이름만** (사유와 함께 미지원) |
| **Bridge Backend-Core** | `src/core/bridge/bridgeCoreProvider.ts` | 이름 일치 ✅ / 센터링만 구현, 나머지 501 |
| 카메라/시뮬레이션 접속 | `src/devices/` · `src/media/` | ✅ |
| **주차면 3D 육면체화** | `src/domain/slotBox.ts` | 압출 계산 ✅ / 픽셀→월드 변환은 **미구현**(캘리브레이션 산출물 필요) |
| 주차면 관리 및 매핑 | `src/store/slotStore.ts` | 목록 읽기만 — **매핑은 이번 범위 밖** |
| **API 계층 VPD·LPD·LPR** | `src/detectors/` + `POST /api/detectors/:name/detect` | VPD·LPD ✅ / LPR 501 |

---

## 3. 변경 목록

### 3.1 `local` → `bridge` 리네임 (D2)

| 대상 | 변경 |
|---|---|
| `src/core/local/` → `src/core/bridge/` | 디렉토리 이동 (`cameraLease.ts` 동반, `git mv` 로 이력 보존) |
| `localCoreProvider.ts` → `bridgeCoreProvider.ts` | `LocalCoreProvider` → `BridgeCoreProvider`, `name = 'bridge'` |
| `src/core/coreProvider.ts` | `CoreProviderName = 'remote' \| 'bridge'` |
| `src/config/types.ts` | `CoreProviderChoice = 'bridge' \| 'remote'` |
| `src/config/normalize.ts` | `normalizeCore` 가 **`'local'` 을 `'bridge'` 로 접어 읽는다.** 기본값 `'bridge'` |
| `src/core/providerFactory.ts` | import·생성자명 |
| `web/options.html` · `web/options.js` | `<option value="bridge">브리지 코어…`, 태그 문구 |
| `config/config.json` · `config.example.json` | `core.provider: "bridge"` (example 에는 `core` 블록 신설) |
| `src/mcp/routeCatalog.ts` · `src/api/routes/coreRoutes.ts` | 주석·notes 문구 |
| 사용자 노출 문구 | "자체 코어" → "브리지 코어" (오류 사유 6종) |

**옛 값 호환이 왜 필요한가.** 이미 돌고 있는 설치의 `config.json` 은 `"local"` 을 들고 있다.
접어 읽지 않으면 그 값이 조용히 버려지고 기본값으로 떨어지는데, **기기별 재정의(`perCamera`)를
걸어 둔 사용자**는 자기 카메라가 왜 다른 구현으로 도는지 알 방법이 없다.
실기 기동으로 확인했다 — `{"core":{"provider":"local"}}` 설정이 `GET /api/settings` 에서
`{"provider":"bridge"}` 로 나온다.

**건드리지 않은 것**: `src/api/routes/presetRoutes.ts:64` 의 `source: 'local'`.
주차면 출처(시뮬레이터 vs 로컬 파일)이며 코어 구현과 **전혀 다른 개념**이다.

### 3.2 코어 능력 2종 계약 추가

`CORE_CAPABILITY_NAMES` 가 6 → **8개**가 됐다: `vehicleBox`(차량 3D 육면체 관리) · `slotCreate`(주차면 생성).

두 구현 모두 사유와 함께 `ok:false` 를 답한다.

| 구현 | 사유 |
|---|---|
| remote | `backend-core 의 차량 3D 육면체 API 를 아직 확인하지 못했습니다` |
| bridge | `브리지 코어는 아직 차량 3D 육면체 관리를 지원하지 않습니다` |

**포트(메서드)는 만들지 않았다.** 요청·응답 모양이 확정되지 않았고, 지어낸 시그니처는
실측과 어긋나는 순간 소비자까지 전부 다시 깎게 만든다. 이름만으로도
`GET /api/core/capabilities` 가 "이 둘은 아직 아무도 못 한다"를 정직하게 답한다.

이 "이름은 있고 포트는 없는" 상태가 방치되지 않도록 적합성 스위트에 규칙을 하나 더 넣었다 —
**실행 표면이 없는 능력을 `ok:true` 로 답하면 위반**이다(`test/coreProviderConformance.ts`).
나중에 포트를 만들면서 `INVOKE` 프로브를 빠뜨리면 그 순간 빨간불이 켜진다.

### 3.3 주차면 3D 육면체화 — `src/domain/slotBox.ts` (신규)

순수 기하. 외부 I/O 없음.

| 이름 | 설명 |
|---|---|
| `Point3` | 월드 좌표 한 점(m). **+Z 가 위** — 언리얼과 같은 축 방향 |
| `SlotFloor` | 바닥 4점. **차례가 곧 변**이다(0-1, 1-2, 2-3, 3-0) |
| `SlotBox` | `floor` · `ceiling` · `height` · `vertices`(바닥 4 → 천장 4, 8정점) |
| `buildSlotBox(floor, height)` | 바닥을 +Z 로 압출. 4점 아님 · 비유한 좌표 · `height ≤ 0` 은 `SlotBoxError`(400) |
| `SlotBoxError` | `statusCode = 400` — 라우트에 붙일 때 500 으로 새지 않게 |

**의도적으로 만들지 않은 것 — 픽셀 → 월드 변환.** 카메라 캘리브레이션의 산출물이 있어야
가능하고 아직 그 산출물이 없다. 없는 값을 지어내 좌표를 만들면 화면에는 그럴듯한 육면체가
그려지지만 실제 주차면과는 아무 관계 없는 도형이 된다.

바닥이 평면인지·볼록인지도 검사하지 않는다. 압출 결과는 바닥을 그대로 옮긴 것이라 바닥이
어그러져 있으면 육면체도 같은 만큼 어그러지는데, 그 왜곡은 **입력의 문제**다.
여기서 조용히 보정하면 어디서 틀어졌는지 추적할 수 없게 된다.

**아직 어떤 라우트에도 붙어 있지 않다.** 입력(월드 좌표 주차면)을 만들어 줄 상류가 없기 때문이다.

### 3.4 API 계층 — `src/detectors/` (신규)

| 파일 | 설명 |
|---|---|
| `detectorTypes.ts` | `DetectorName`(`vpd`·`lpd`·`lpr`) · `Detection` · `DetectorResult` · `DetectorClient` 계약 · `DetectorError`(502) · `DetectorUnsupportedError`(501) · `zipDetections` |
| `multipart.ts` | 파일 1개짜리 `multipart/form-data` 본문 조립. **런타임 의존성 0** 을 지키기 위해 손으로 만든다 |
| `uploadJpeg.ts` | VPD·LPD 공용 업로드. 본문을 `text()` 로 **1회** 읽고 `!res.ok` → JSON 파싱 순으로 분기 |
| `vpdClient.ts` | `POST {base}/vpd/api/v2/det/imgupload` → 축정렬 `bbox` |
| `lpdClient.ts` | `POST {base}/lpd/api/v1/imgupload` → 회전 상자 `polygon`(TL→TR→BR→BL) |
| `detectorFactory.ts` | **검출기 분기가 있는 유일한 지점.** `detectorUnavailableReason()` + `createDetector()` |

**실측 계약 (추측 아님)**

| 검출기 | 경로 | 응답 | 근거 |
|---|---|---|---|
| VPD | `POST /vpd/api/v2/det/imgupload` (multipart `file`) → 201 | `{success, id, bboxes:[[x1,y1,x2,y2]], masks, confidences, classes}` | `Sub/vpd_api/routers/yolo.py:32-100` · `schemas/yolo.py` |
| LPD | `POST /lpd/api/v1/imgupload` (multipart `file`) → 201 | `{success, id, polygons:[[[x,y]×4]], confidences, classes}` | `Sub/lpd_api/routers/yolo.py:33-102` · `schemas/yolo.py:12-15` |
| LPR | — | **서비스 없음** | `Sub/` 아래에 대응 디렉토리가 없다 |

**LPR 에 클라이언트 클래스를 만들지 않은 이유.** VPD·LPD 를 본떠 `/lpr/api/v1/imgupload` 같은
경로를 지어내면 컴파일도 되고 테스트도 그 상상대로 통과한다. 그러나 실제 서비스가 생기는 날
계약이 어긋나 있어도 **아무도 알아채지 못한다.** 대신 판정 함수 한 곳에서 501 로 거절한다.

**응답 봉투 통일.** VPD 는 축정렬 상자, LPD 는 회전 상자로 모양이 다르다. 상위 계층이 그
차이로 분기하지 않도록 `Detection` 하나로 정리하되, **검출기가 실제로 준 쪽만 싣는다** —
`bbox` 가 없는데 `[0,0,0,0]` 을 채우면 화면 왼쪽 위에 유령 상자가 그려진다.

`confidences[]`·`classes[]` 는 검출과 평행한 배열이다. 길이가 어긋나도 **짝을 밀지 않고**
없는 자리를 `0`·`''` 로 둔다 — 밀면 3번 상자에 5번 신뢰도가 붙는다.

### 3.5 라우트 2건 (신규)

| 메서드 · 경로 | 설명 |
|---|---|
| `GET /api/detectors` | 검출기 3종의 `available` + 못 쓰는 `reason` |
| `POST /api/detectors/:name/detect` | 대상 카메라 스냅샷 1장을 그 검출기로 |

> **범위 초과 고지.** 사용자 답변(D3)은 "클라이언트 계층 신설"이었고 라우트는 언급되지 않았다.
> 라우트 2건을 붙인 이유는 **CLAUDE.md 3항(동작 확인)** — 호출자가 없으면 이 계층이 실제로
> 도는지 확인할 방법이 없다. 원치 않으면 `detectorRoutes.ts` 와 `server.ts` 의 등록 1줄,
> `routeCatalog.ts` 의 2건만 떼어내면 클라이언트 계층은 그대로 남는다.

**이미지를 요청 본문으로 받지 않는다.** 브라우저가 프레임을 받아 되올려 보내면 같은 그림이
망을 두 번 건너고, 그 사이 카메라가 움직이면 "언제 찍힌 그림인지" 아무도 답할 수 없다.

### 3.6 설정 확장

`AppConfig.detectors` 신설 — `{ vpd|lpd|lpr: { baseUrl, timeoutMs } }`.
기본 `baseUrl` 은 **빈 문자열**이고, 그 상태가 곧 "설정되지 않았다"다.
기본 URL 을 지어 넣지 않은 이유: 아무 데도 없는 주소로 15초를 기다린 뒤 나는 타임아웃보다
"설정되지 않았습니다"라는 즉답이 훨씬 빨리 원인을 알려 준다.

`timeoutMs` 기본값은 **15초**(카메라 제어 5초보다 넉넉하다) — 추론은 초 단위로 걸린다.

`/api/settings` 응답에는 **싣지 않았다.** 옵션 페이지가 편집하지 않고, 조회는
`GET /api/detectors` 가 사유까지 함께 답하는 쪽이 낫다.

---

## 4. 검증 (실제 실행)

### 4.1 유닛·통합 (`npm run typecheck` → `npm run test`)

```
Test Files  1 failed | 25 passed (26)
     Tests  1 failed | 368 passed (369)
```

`tsc --noEmit` 오류 0.

**실패 1건은 이 작업과 무관한 선재 결함**이다 —
`test/powershellSafeDiagnostic.test.ts` 가 읽는 `scripts/test-settingmanager-safe.ps1` 이
이 세션 **이전에** 삭제돼 있었다(`git status` 에 `D scripts/test-settingmanager-safe.ps1`,
마지막 커밋은 `47887d0`). 요청 범위 밖이므로 손대지 않았다. 조치는 둘 중 하나다 —
스크립트를 복원하거나(`git checkout -- scripts/`), 그 테스트를 함께 지운다.

**신규 테스트**

| 파일 | 건수 | 무엇을 지키나 |
|---|---|---|
| `test/slotBox.test.ts` | 8 | 압출이 +Z 로만 · 정점 차례 · 입력 불변 · 나쁜 입력을 조용히 보정하지 않음 |
| `test/detectors.test.ts` | 17 | 실측 경로·multipart 본문·응답 매핑 · 모자란 상자/폴리곤 배제 · 상류 오류 전파 · 가용성 판정 일치 |
| `test/detectorServerRoutes.test.ts` | 6 | 서버가 스냅샷을 찍어 보냄 · 미설정/미구현 501 · 알 수 없는 이름 404 |

모킹 응답은 **상류 소스의 예시 원문 그대로** 썼고 근거 경로를 테스트 주석에 남겼다.

### 4.2 실기 기동 (임시 설정으로 실제 서버 부팅)

| 확인 | 결과 |
|---|---|
| `core.provider: "local"` 로 기동 → `GET /api/settings` | `{"provider":"bridge"}` — **옛 값 호환 동작 확인** |
| `GET /api/core/capabilities` | 능력 **8종** 전부 응답, `vehicleBox`·`slotCreate` 가 사유와 함께 `ok:false` |
| `GET /api/detectors` | 3종 + 못 쓰는 사유 |
| `POST /api/detectors/lpd/detect` (미설정) | **501** `LPD 검출기가 설정되지 않았습니다 — …` |
| `POST /api/detectors/lpr/detect` | **501** `LPR 검출기는 아직 이 저장소에 구현이 없습니다 — …` |

### 4.3 실기 실행에서 잡은 결함 1건 (수정 완료)

**증상**: `POST /api/detectors/lpr/detect` 가 501 이 아니라 **502 `카메라 통신 실패`** 로 답했다.

**원인**: 초판은 `LprClient` 를 만들어 두고 `detect()` 안에서 501 을 던졌다. 그래서 라우트가
① 검출기 생성(성공) → ② **스냅샷 촬영**(카메라 불통 → 502) 순으로 진행해, 501 이어야 할
답이 카메라 오류로 뒤덮였다. **유닛 테스트는 가짜 fetch 가 항상 JPEG 을 돌려줘서 이 순서를
드러내지 못했다** — 실기 기동에서만 보였다.

**수정**: 가용성 판정을 `detectorUnavailableReason()` 한 곳으로 모으고, `createDetector()` 가
**호출 전에** 던지게 했다. `lprClient.ts` 는 삭제했다(판정이 한 곳으로 모이면서 죽은 코드가 됐다).
같은 함수를 `GET /api/detectors` 도 쓰므로 **화면이 "쓸 수 있다"고 그린 것은 반드시 호출된다.**

회귀 테스트를 넣었다 — `LPR 은 501 이고, 카메라를 두드리지 않는다`(`snapshotCalls === 0`).

---

## 5. 영향도 분석

### 5.1 깨지는 것 (조치 필요)

| 대상 | 영향 | 조치 |
|---|---|---|
| **운영 중인 `config.json`** | `core.provider: "local"` | **조치 불필요** — `bridge` 로 접혀 읽힌다. 다음 저장 때 `"bridge"` 로 바뀐다 |
| **`/api/core/capabilities` 소비자** | `supported` 키가 6 → 8개 | 키 집합을 **정확히** 단정하는 코드만 영향. `web/discovery.js:17` 은 필요한 능력만 골라 보므로 무사 |
| **외부 스크립트가 `provider === 'local'` 로 분기** | 이제 `'bridge'` | 저장소 안에는 없다. 저장소 밖 스크립트가 있다면 갱신 필요 |

### 5.2 안 깨지는 것 (확인함)

| 대상 | 결론 | 근거 |
|---|---|---|
| `src/api/routes/presetRoutes.ts` | 불변 — `source: 'local'` 은 주차면 출처이고 코어 구현이 아니다 | 64행 · `test/server.test.ts:409` 그린 유지 |
| `src/devices/**` · `src/media/**` | 불변 — 검출기는 드라이버의 `getSnapshot()` 만 소비한다 | `detectorRoutes.ts` |
| `src/domain/ptz.ts` · PTZ 라우트 · `web/control.js` | 불변 | 좌표 계약 미변경 |
| Park3D RPC 작업(같은 워킹트리의 미커밋 변경) | 불변 — `park3dRpcClient.test.ts` 는 import 경로만 바뀌었다 | 22 테스트 그린 |
| `src/mcp/tools.ts` | 불변 — 카탈로그 자료만 늘었고 도구 코드는 그대로다 | 라우트가 늘어도 MCP 파일은 안 바뀌는 설계 |
| 런타임 의존성 | **여전히 0개** — multipart 를 손으로 만든 이유 | `package.json` |

### 5.3 형제 프로젝트

| 프로젝트 | 영향 |
|---|---|
| `AgentVLA/ParkAgent/SettingAgent` | **없음.** 이 저장소의 내부 명칭 변경이고 둘 사이에 공유 코드가 없다 |
| `Sub/vpd_api` · `Sub/lpd_api` | **없음.** 읽기만 했다 — 소스에서 경로·응답 스키마를 확인해 클라이언트를 맞췄고, 파이썬 코드는 한 줄도 건드리지 않았다 |
| baro_calory `backend-core` | **없음.** 새 호출을 추가하지 않았다. `vehicleBox`·`slotCreate` 는 사유만 답한다 |

---

## 6. 남은 일 (이번 범위 밖)

| 항목 | 왜 지금 못 하나 |
|---|---|
| backend-core 의 차량 육면체·주차면 생성 연동 | API 경로·응답 **미확인**. 실측 후 포트를 설계해야 한다 |
| 픽셀 → 월드 좌표 변환 | 카메라 캘리브레이션 산출물이 없다 |
| 주차면 ↔ 카메라/프리셋 **매핑** 저장소 | 매핑 키의 정의가 확정되지 않았다 |
| LPR 서비스 | 대응 서비스 자체가 없다 |
| 웹 UI 의 검출 결과 표시 | 요청 범위 밖. 지금은 REST 로만 확인한다 |
| `scripts/test-settingmanager-safe.ps1` 복원 여부 | 선재 결함 — 판단이 필요하다(§4.1) |
