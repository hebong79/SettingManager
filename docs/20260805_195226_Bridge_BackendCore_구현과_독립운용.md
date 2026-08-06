# Bridge Backend-Core 구현 · baro_calory 독립 운용

| 항목 | 값 |
|---|---|
| 문서 | baro_calory 분석 · 벤더링 결정 · 브리지 능력 4종 구현 · 원격 배선 · 독립 운용 가이드 · 영향도 |
| 작성 | 2026-08-05 19:52:26 |
| 분석 대상 | `d:\Work\Parking3D\Agent\baro\baro_calory` (커밋 `a2d62b6`, 2026-08-05) |
| 짝 문서 | [구조 정렬](20260805_185800_구조정렬_my_setting_manager_구성반영.md) · [벤더링 규칙](../SettingMain/src/vendor/baro-profile/VENDOR.md) |

---

## 1. 질문에 대한 답 — 독립적으로 동작할 수 있는 부분

`baro_calory` 는 pnpm 모노레포이고, **의존성 경계가 이미 잘 그어져 있다.**

| 계층 | 규모 | 의존 | 복사 운용 |
|---|---|---|---|
| `packages/profile` | ~830줄 | **0개** | ✅ 파일만 옮기면 그대로 돈다 |
| `packages/cctv-client` | ~3,100줄 | `@baro/profile` + node 내장 | ✅ 네이티브 없음 |
| `apps/backend-core` | ~7,000줄 | **`sharp`**(네이티브) + 위 둘 | ⚠ 설치 필요 |

`packages/profile/src/index.mjs` 상단이 규칙을 못 박아 두었다 — *"외부 의존 0. DOM/fs/네트워크
금지 — Node 와 브라우저가 같은 파일을 실행한다."* 그래서 **광학·조준 기하 전부**(줌→화각
`hfovFromZoomPos`, 픽셀↔PTZ `pixelToPtzDelta`, 월드→픽셀 투영, 캘리브레이션 솔버
`buildCalibration`)가 아무 데나 떼어 놓을 수 있는 상태로 격리돼 있다.

**`sharp` 가 필요한 것은 이미지를 만지는 일뿐이다** — 크롭·파노라마 렌더·ZNCC 프레임 매칭.
이 경계가 이번 작업의 범위를 그대로 정해 주었다(§3).

---

## 2. 사용자 확정 결정

| # | 질문 | 결정 |
|---|---|---|
| E1 | 복사 방식 | **`profile` 벤더링** — `SettingMain/src/vendor/baro-profile/` |
| E2 | 브리지 범위 | **sharp 없이 되는 것 전부** |
| E3 | 원격 배선 | **vehicleBox·slotCreate 둘 다 배선** |
| E4 | 저장 형식 | **backend-core 형식 그대로** |

---

## 3. 무엇을 브리지가 갖게 됐나

| 능력 | 이전 | 지금 | 근거 |
|---|---|---|---|
| `center` | ✅ | ✅ | 드라이버 |
| **`centerBox`** | ❌ 501 | ✅ **자체 계산** | 벤더링한 `pixelToPtzDelta` + 실측 화각표 역보간 |
| **`discoveryPresets`** | ❌ 501 | ✅ 자체 저장소 | `discovery-store.mjs` 형식 |
| **`discoveryPoints`** | ❌ 501 | ✅ 자체 저장소 | 〃 |
| **`slotCreate`** | ❌ 이름만 | ✅ 자체 저장소 | `spot-store.mjs` 형식 |
| **`vehicleBox`** | ❌ 이름만 | ✅ 사이드카 소비 | `object3d-client.mjs` 와이어 |
| `calibration` | ❌ | ❌ **사유 정정** | ZNCC 프레임 매칭에 sharp 필요 |
| `plateHoming` | ❌ | ❌ **사유 정정** | 크롭·VLM 가시성 판정에 sharp 필요 |

앞의 두 미지원 사유가 바뀐 것이 중요하다. 예전에는 *"아직 지원하지 않습니다 (2단계 예정)"*
였는데, 이는 **일정의 문제처럼 읽힌다.** 실제로는 런타임 의존성 0 원칙과 맞바꾼 결과이므로
사유를 *"네이티브 이미지 처리가 필요합니다"* 로 고쳤다. 읽는 사람이 "기다리면 되는 것"과
"설계상 저쪽 몫인 것"을 구별할 수 있어야 한다.

### 3.1 벤더링 — 왜 다시 짜지 않았나

구성도의 Bridge 원칙은 *"Backend-Core에 없는 건 새로 제작"* 이다. **있는 것을 다시 짜는 것은
그 원칙이 아니다.** 조준 기하는 실기 112샘플 골든 픽스처로 고정된 계산이고, 상류
`index.mjs` 의 규칙 2번이 *"여기 있는 계산을 다른 곳에 복제하지 않는다(과거 6중 분기의 재발
방지)"* 라고 명시한다. 베껴 쓰면 그 금지를 정확히 어기는 것이다.

그래서 **7파일을 그대로 복사**하고 손대지 않는다. 규칙과 갱신 절차는
[`VENDOR.md`](../SettingMain/src/vendor/baro-profile/VENDOR.md) 에 있고,
`test/vendorProfile.test.ts` 가 ① 파일 sha256 지문 ② 대표 계산값을 지킨다.

`npm 워크스페이스로 참조하지 않은 이유가 곧 "독립 운용"이다` — 이 디렉토리가 있으면
**`baro_calory` 저장소가 없는 기계에서도 SettingManager 가 혼자 선다.**

타입은 우리가 따로 쓴 `index.d.mts` 가 준다(남의 `.mjs` 는 타입 주석이 없어 tsc 추론이
필수 인자를 놓친다). 상류 파일을 고치는 것이 아니므로 벤더링 규칙을 깨지 않는다.

### 3.2 `centerBox` — 순수 계산으로 세운 박스 줌

backend-core 는 이것을 **드라이버의 하드웨어 기능**(`boxZoom` 능력)으로 처리하고, 그래서
원격 코어에서는 지금도 501 이다(discovery point 에 box 좌표가 없다). 브리지는 다르게 푼다 —
**계산으로 세운다.**

```
① 박스 중앙 → pixelToPtzDelta(현재 화각, 현재 틸트)  → pan/tilt 델타   ← 벤더링
② 목표 화각 = 현재 화각 × max(박스폭/1920, 박스높이/1080)
③ 목표 화각 → 줌 눈금                                                  ← 역보간(신규)
④ goPtz(현재 + 델타, 목표 줌) → 정착 대기
```

②에서 가로·세로 중 **큰 쪽**을 쓴다. 작은 쪽을 쓰면 박스가 화면 밖으로 잘린다.

③의 역보간(`src/core/bridge/zoomTable.ts`)만 새로 만들었다 — 상류에는 없다. 상류는 줌을
정하고 화각을 읽기만 하면 됐지만, 박스 줌은 "이만큼 보고 싶다"에서 눈금을 거꾸로 찾아야 한다.
표 밖으로는 외삽하지 않고 양 끝에서 멈춘다(실제 렌즈가 포화한다).

**실측 화각표가 없는 기기에서는 켜지 않는다.** 내장 표(`ZOOM_HFOV_TABLE`)는 cam-001 한 대의
곡선이라 다른 렌즈·다른 줌 눈금에 쓰면 조준이 수 배 어긋난다. 그래서 `camera.intrinsics.zoomHfov`
가 있을 때만 능력이 켜지고, 없으면 **무엇을 채워야 하는지 말하는 501** 이 나간다.
(근거: baro_calory `docs/architecture.md` §광학은 선언한 기기만 갖습니다.)

### 3.3 저장소 — backend-core 파일을 그대로 읽고 쓴다

| 파일 | 상류 대응 |
|---|---|
| `config/discovery-<cameraId>.json` | `discovery-store.mjs` |
| `config/spots-<cameraId>.json` | `spot-store.mjs` |

형식을 그대로 따른 이유는 **커미셔닝을 한쪽에서 시작해 다른 쪽에서 이어받을 수 있어야**
하기 때문이다. 테스트가 상류 형식 원문(우리가 만들지 않는 `slug`·`detector`·`judge` 포함)을
넣고, 우리가 수정한 뒤에도 그 필드가 살아남는지 확인한다 — 사라지면 되돌려 줄 수 없다.

한 가지만 상류와 다르게 했다: **원자적 쓰기**. 상류 `spot-store.mjs` 는 그냥 `writeFile`
이지만 여기서는 임시파일+rename 이다. 형식 호환은 파일 *내용*의 문제이고 쓰는 방식은
아니므로, 이 강화는 호환을 깨지 않는다.

### 3.4 `vehicleBox` — 사이드카 소비

`src/detectors/object3dClient.ts`. 상류의 경계를 그대로 지킨다 —
봉투(`cameraId`·`capturedAt`·`count`·`model`·`latencyMs`)는 우리 어휘, `detections[]`·
`calibration` 은 **사이드카 어휘 그대로**(`position_m`·`dimensions_m`·`yaw`).
개명하면 사이드카 로그와 대조가 안 되고 좌표계 규약이 두 벌이 된다.

오류 `code` 도 뭉개지 않는다 — `no_calibration`→422(운영자가 파일 하나 놓으면 끝),
`model_unavailable`→501(이 호스트에 런타임 없음), 나머지→502. 뭉개면 "캘리브레이션 파일
하나 없음"이 "3D 서비스 죽음"으로 보고된다.

**`DetectorName`(vpd·lpd·lpr)에 넣지 않았다.** 그 셋은 구성도의 *API 계층*이라는 상자이고,
object3d 는 코어 능력을 채우는 사이드카다. 한 목록에 넣으면 `GET /api/detectors` 가 코어
능력을 API 계층인 양 보고한다.

---

## 4. 원격(backend-core) 배선 — 이제 둘 다 켜졌다

지난 작업에서 *"아직 확인하지 못했습니다"* 로 남겼던 두 능력의 경로를 소스에서 찾았다.

| 능력 | 경로 | 근거 |
|---|---|---|
| `vehicleBox` | `POST /api/discovery/object3d` · `GET …/status` | `control-api.mjs:530-604` |
| `slotCreate` | `GET·POST /api/spots` · `POST /api/spots/:id/goto` · `DELETE /api/spots/:id` | `control-api.mjs:485-520` |

원격의 `centerBox` 는 **여전히 501 이다.** 상류에 하드웨어 박스줌 경로는 있지만
discovery point 가 box 좌표를 저장하지 않아 개별 센터+줌 계약이 없다 — 그 사유는 그대로 둔다.
그래서 지금은 **브리지가 원격보다 하나 더 하는 능력이 생겼다**(구성도의 *"없는 건 새로 제작"*
원칙이 처음으로 실제로 성립한 지점이다).

---

## 5. 새 REST 라우트

| 메서드 · 경로 | 설명 |
|---|---|
| `GET /api/core/vehicle-box/status` | 3D 준비 상태. 사이드카가 죽어 있어도 200 으로 사실 |
| `POST /api/core/vehicle-box` | 지금 프레임의 차량 3D 육면체. 본문 없음, **카메라를 움직이지 않는다** |
| `GET /api/core/slots` | 커미셔닝 주차면 목록 |
| `POST /api/core/slots` | `{x, y, name?, box?}` — 지금 자세를 클로즈업으로 저장 |
| `POST /api/core/slots/:id/goto` | 그 조준해로 이동 |
| `DELETE /api/core/slots/:id` | 삭제 |

> **`/api/core/slots` 와 `/api/slots` 는 다른 것이다.** 후자는 시뮬레이터·로컬 파일이 주는
> 주차면 **목록**이고, 전자는 사람이 "이 픽셀을 이 자세로 찍는다"고 확정해 저장한 커미셔닝
> 산출물이다. 같은 낱말을 쓰지만 출처도 수명도 달라 경로를 갈라 두었다.

---

## 6. 새 설정

```json
"object3d": { "baseUrl": "", "model": "object3d-primary", "timeoutMs": 30000 },
"cameras": [{ "…": "…", "intrinsics": { "zoomHfov": [{ "z": 0, "h": 57.14 }, …] } }]
```

| 필드 | 없으면 |
|---|---|
| `object3d.baseUrl` | `vehicleBox` 능력이 꺼지고 사유가 뜬다 |
| `cameras[].intrinsics.zoomHfov` | `centerBox` 능력이 꺼지고 사유가 뜬다 |

`intrinsics` 는 **쓸 수 있는 표일 때만** 만들어진다 — 앵커 2개 미만이거나 z 가 오름차순이
아니면 보간이 성립하지 않으므로 고쳐 주지 않고 없는 것으로 둔다. 반쯤 맞는 표로 조준하면
조용히 빗나가고, 그 실패는 화면에 아무 흔적도 남기지 않는다.

**`config.example.json` 의 예시 곡선은 cam-001 실측값이며 다른 카메라에 복사하면 안 된다** —
예시 파일에도 그 경고를 적어 두었다.

---

## 7. baro_calory 를 복사해 독립 운용하기

### 7.1 지금 상태 — profile 만 복사돼 있다

```
SettingMain/src/vendor/baro-profile/     ← @baro/profile v0.2.1 (7파일, 의존성 0)
```

이것만으로 **브리지의 계산 능력 전부가 baro_calory 없이 선다.** `npm install` 도 필요 없다.

갱신은 `VENDOR.md` 의 절차를 따른다 — 파일을 덮어쓰고 테스트를 돌리면 지문 불일치로
실패하며, 원문을 확인한 뒤 지문을 옮겨 적는다. **지문을 먼저 고치고 복사하는 순서는 금지다**
(그러면 검사가 아무것도 지키지 않는다).

### 7.2 더 필요할 때 — 무엇을 얼마나 가져오나

| 원하는 것 | 가져올 것 | 비용 |
|---|---|---|
| 지금의 브리지 능력 6종 | **이미 있음** | 0 |
| IDIS · FlexWATCH 카메라 · 가상 PTZ | `packages/cctv-client` (~3,100줄) | 네이티브 없음. SettingManager 자체 드라이버와 계층이 겹치므로 **정리 설계가 먼저 필요하다** |
| 캘리브레이션 · 번호판 호밍 | `apps/backend-core` 전체 | **`sharp` 설치.** 런타임 의존성 0 원칙이 깨진다 |

### 7.3 backend-core 인스턴스를 옆에 띄우는 운용

캘리브레이션·호밍이 필요하면 코드를 옮기는 것보다 **backend-core 를 그대로 띄우고 원격
코어로 붙이는 편**이 낫다. 그 경로는 이미 있다.

```bash
cd d:/Work/Parking3D/Agent/baro/baro_calory
pnpm install                 # sharp 포함
node apps/backend-core/src/server.mjs
```

그 다음 SettingManager 옵션에서 시뮬레이터 URL 을 그 주소로 두고,
`core.perCamera` 로 **그 카메라만** 원격으로 돌리면 된다.

```json
"core": { "provider": "bridge", "perCamera": { "real-camera-1": "remote" } }
```

능력 6종은 브리지가 로컬에서 처리하고, 캘리브레이션이 필요한 기기만 backend-core 를 쓴다 —
**경로와 화면은 어느 쪽이든 같다.**

---

## 8. 검증 (실제 실행)

### 8.1 유닛·통합

```
Test Files  1 failed | 29 passed (30)
     Tests  1 failed | 420 passed (421)
```

`tsc --noEmit` 오류 0. 실패 1건은 이 작업 이전부터 있던 선재 결함이다
(`scripts/test-settingmanager-safe.ps1` 삭제 — 커밋되지 않은 워킹트리 상태).

**신규 테스트 45건**

| 파일 | 건수 | 무엇을 지키나 |
|---|---|---|
| `test/vendorProfile.test.ts` | 15 | 벤더링 지문(sha256 7파일) · 상류와 같은 계산 · 짐벌 기하 성질 |
| `test/zoomTable.test.ts` | 6 | 역보간 왕복 · 외삽 금지 · 단조성 |
| `test/bridgeStores.test.ts` | 15 | backend-core 파일 형식 왕복 · 상류 전용 필드 보존 · 깨진 파일은 던짐 |
| `test/bridgeCoreServerRoutes.test.ts` | 16 | 능력 6종 점등 · 박스 줌 계산 · 하드웨어 박스줌 미사용 · 주차면 CRUD · 사이드카 어휘 보존 |

### 8.2 실기 기동 (임시 설정으로 실제 서버 부팅)

| 확인 | 결과 |
|---|---|
| `GET /api/core/capabilities` | `center`·`centerBox`·`discoveryPresets`·`discoveryPoints` 켜짐 |
| `POST /api/core/discovery/presets` | `p-1` 생성, PTZ 가 상류 필드명으로 저장 |
| `POST …/points` | `pt-1` 생성 |
| 저장 파일 | `discovery-cam-a.json` 이 **backend-core 스키마 그대로** |
| `POST /api/core/vehicle-box` (미설정) | **501** + 채워야 할 설정 키를 지목 |

### 8.3 작업 중 잡은 결함 2건

**① 능력 이름 오배치 (적합성 스위트가 잡음)** — `discoveryPoints` 실패에 `discoveryPresets`
라벨이 실렸다. 저장소 헬퍼가 고정 능력명으로 오류를 던지고 있었다. 점 조작 실패가 프리셋
사유로 보고되면 화면이 엉뚱한 안내를 낸다. 헬퍼가 호출자의 능력명을 받도록 고쳤다.
**이 버그를 잡은 것은 리뷰가 아니라 `checkUnsupportedRejects` 의 capability 일치 검사다.**

**② 테스트 하네스의 CGI 분기 순서** — 이동(`goptzfpos`)과 조회(`getptzfpos`)가 같은
`ptzf_status.cgi` 로 오는데 가짜 서버가 **경로로 먼저 갈라** 이동이 조회로 먹혔다.
"명령을 보냈는데 아무 일도 안 일어나는" 상태가 됐다. `action` 으로 가르도록 고치고 주석에
남겼다 — 실기 하네스를 쓰는 다음 사람이 같은 자리를 밟는다.

---

## 9. 영향도 분석

### 9.1 계약 변경 (의도됨)

| 대상 | 변경 | 조치 |
|---|---|---|
| **브리지의 탐색 경로** | 501 → **200** (자기 저장소가 답한다) | `server.test.ts` 의 해당 단정을 갱신. 변하지 않은 것은 *"조용히 원격으로 넘기지 않는다"* |
| `CoreProvider` 인터페이스 | `vehicleBox`·`parkingSlots` 포트 추가 | 구현체 둘 다 채웠다. 외부 구현체는 없다 |
| 적합성 스위트 `INVOKE` | `Partial<Record>` → **`Record`** | 능력을 새로 만들며 프로브를 빠뜨리면 **컴파일이 깨진다**. 런타임 가드보다 강한 보장이라 그 가드와 테스트는 제거했다 |
| `tsconfig.json` | `allowJs: true` + `src/vendor/**/*.mjs` | 벤더링한 `.mjs` 하나 때문이다. **`checkJs` 는 켜지 않았다** — 고치지 않기로 한 코드에 strict 를 들이대면 고치게 되고 그 순간 포크가 된다 |

### 9.2 안 깨지는 것 (확인함)

| 대상 | 결론 | 근거 |
|---|---|---|
| `/api/slots` · `slotStore` | 불변 — 새 주차면은 `/api/core/slots` 로 갈라 두었다 | `presetRoutes.ts` 무변경 |
| `src/devices/**` · `src/media/**` | 불변 — 브리지는 드라이버 계약 표면만 쓴다 | `getPtz`·`goPtz`·`getSnapshot` |
| `src/domain/ptz.ts` | 불변 — 저장 형식(`panpos`)↔계약 좌표(`pan`) 환산은 브리지 안에 갇혀 있다 | `fromStoredPtz`·`toStoredPtz` |
| 원격 코어의 기존 5종 | 불변 — 포트만 늘었다 | `remoteCoreProvider.test.ts` 17건 그린 |
| 런타임 의존성 | **여전히 0개** — 벤더링은 파일 복사이지 패키지 설치가 아니다 | `package.json` |
| 실제 `config/` 디렉토리 | **오염 없음** — `storeDir` 을 `ServerDeps` 로 뚫어 테스트가 임시 디렉토리를 쓰게 했다 | `git status config/` 깨끗 |

### 9.3 baro_calory 쪽

**변경 없음. 읽기만 했다.** 파일 7개를 복사했을 뿐 상류 저장소에는 한 글자도 쓰지 않았다.
상류가 `packages/profile` 을 고치면 이쪽 지문 검사가 어긋나는 것이 아니라 — 지문은
**복사본**의 것이므로 그대로 통과한다. 갱신은 사람이 `VENDOR.md` 절차로 당겨 온다.
즉 상류의 변경이 이쪽을 자동으로 깨뜨리지 않고, 대신 **자동으로 따라오지도 않는다.**
그 트레이드오프가 벤더링의 값이다.

---

## 10. 남은 일

| 항목 | 왜 지금 못 하나 |
|---|---|
| 브리지 캘리브레이션 · 번호판 호밍 | ZNCC 프레임 매칭·크롭에 네이티브 이미지 처리(`sharp`)가 필요. 런타임 의존성 0 원칙과 맞바꿔야 한다 |
| 원격 `centerBox` | 상류에 개별 센터+줌 계약이 없다(discovery point 가 box 를 저장하지 않는다) |
| `cctv-client` 벤더링 (IDIS·FlexWATCH·가상 PTZ) | SettingManager 자체 드라이버 계층과 겹친다 — 정리 설계가 먼저다 |
| 실측 `intrinsics` 채우기 | 기기별 캘리브레이션 산출물이 필요하다. backend-core 로 스윕을 돌려 발행본을 옮겨 오는 것이 지금의 경로다 |
| 웹 UI 의 박스 드래그·3D 표시 | 요청 범위 밖. 지금은 REST 로만 쓴다 |
