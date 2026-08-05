# 03 검증 리포트 — Park3D RPC 카메라 드라이버(`kind: "park3d-rpc"`)

- 작성: 검증자(qa-tester)
- 입력: `_workspace/01_architect_plan.md`(2판), `_workspace/02_developer_changes.md`
- 저장소: `d:\Work\Parking3D\Agent\baro\SettingManager`, 서비스 루트 `SettingMain/`

---

## 결론 요약

**구현은 계획대로 동작한다. 실기 응답 shape 과 코드·모킹이 모두 일치한다.** 회귀 0건.
다만 **결함 1건(중간)** 을 발견했다 — park3d 의 zoom 클램프가 `/api/ptz/*` 의 `limited` 에 보고되지 않아,
줌 한계에서 "눌러도 안 움직이는데 아무 신호가 없는" 상태가 된다.

---

## 실행 명령 / 결과 요약

### 1) 구현자 보고 재현 (검증자가 직접 실행)

```
$ cd SettingMain && npm run typecheck
> tsc -p tsconfig.json --noEmit
(오류 없음 — 통과)

$ npx vitest run
 Test Files  1 failed | 21 passed (22)
      Tests  1 failed | 325 passed (326)
```

**통과 325 / 실패 1 / 스킵 0** — 구현자 보고(325 pass / 1 fail)와 **정확히 일치**한다. 자기 보고가 정확했다.

- 착수 전 기준선(리더 실측) 291 pass / 1 fail → 신규 34건 그린, **회귀 0건**.
  (내역: `park3dRpcClient.test.ts` 22 + `optionsPark3dUi.test.ts` 5 + `normalize.test.ts` 보강 7 = 34)
- 유일한 red 는 기준선과 **동일한** `test/powershellSafeDiagnostic.test.ts` —
  `scripts/test-settingmanager-safe.ps1` 이 `git status` 상 **삭제(D)** 상태다. 범위 밖이므로 손대지 않았다.

### 2) 검증자가 추가한 테스트 반영 후 (최종)

```
$ npm run typecheck   → 통과
$ npx vitest run
 Test Files  1 failed | 22 passed (23)
      Tests  1 failed | 336 passed (337)
```

**통과 336 / 실패 1 / 스킵 0.** 실패 1건은 위와 같은 범위 밖 기존 red 하나뿐이다.

신규 파일: `SettingMain/test/park3dRpcServerRoutes.test.ts` (11건, 전부 그린) — 아래 §미작성 검증 보완 참조.

---

## 계획 성공 기준 대조

| 단계 | 검증 항목 | 결과 |
|---|---|---|
| 1 | getPtz 환산 `{41.5, 20.1000003…, 1.57990992…}` → `{4150, 2010, 158}` | ✅ 충족 (실기 응답과 대조 완료) |
| 1 | URL 이 정확히 `{baseUrl}/rpc`, POST, JSON-RPC 2.0 봉투 | ✅ 충족 |
| 1 | 인증 헤더 부재 + `PARK3D_RPC_TOKEN` 설정해도 되살아나지 않음 | ✅ 충족 |
| 1 | goPtz raw→도 역환산 `{camId:1, pan:41.5, tilt:20.1, zoom:1.58}` | ✅ 충족 |
| 1 | zoom 클램프 raw 100~3600 → 전송 1 / 36 | ✅ 충족 (단, **결함 1** 참조) |
| 1 | RPC error 봉투가 HTTP 200 이어도 던진다 | ✅ 충족 |
| 1 | 404 `route_handler_not_found` 를 undefined 로 흘리지 않는다 | ✅ 충족 |
| 1 | getSnapshot `img_bytes` base64 → JPEG SOI 검증 | ✅ 충족 |
| 1 | HTTP 401 → 오류에 `401` 노출 | ✅ 충족 |
| 1 | camId 미설정 → 400, fetch 미호출 | ✅ 충족 |
| 1 | `listSlots()===[]`, `centerPoint` 속성 없음 | ✅ 충족 |
| 2 | `npm run typecheck` 통과 / `never` 소진 검사 유지 | ✅ 충족 (`driverFactory.ts:40`) |
| 2 | `createDriver` 가 park3d-rpc 드라이버 반환 | ✅ 충족 |
| 3 | `camId` 양의 정수만, 아니면 필드 미생성 | ✅ 충족 |
| 3 | `token` 키 조용히 버림 | ✅ 충족 |
| 3 | `server.test.ts:154` 키 집합 그린 유지 | ✅ 충족 (파일 무수정 + 그린) |
| 3 | `PUT /api/settings` 왕복에서 kind·camId 유지 | ✅ **검증자가 HTTP 레벨로 보강** (구현자는 `mergeSettings` 순수계층으로만 대체했었다) |
| 3 | `/api/settings` 응답에 camId 조건부 노출 | ✅ **검증자가 HTTP 레벨로 보강** |
| 4 | `config.json` → `normalizeConfig` → kind·camId·`/stream` | ✅ 충족 (아래 끝-to-끝 추적) |
| 4 | `streamTransportFor` → `http-mjpeg` | ✅ 충족 |
| 4 | (실기) 연결 테스트 성공 | ⚠ **부분** — 라이브 서버 읽기 호출로 값 일치는 확인. 브라우저 화면 확인은 리더 몫 |
| 4 | (실기) PTZ 이동 1회 | ⛔ **미검증** — `cam.setPTZ` 금지 지시 준수 |
| 4 | (실기) `/stream` MJPEG 재생 | ⚠ **부분** — `GET /stream` → 200 `multipart/x-mixed-replace; boundary=park3dframe` 확인. 화면 재생은 리더 몫 |
| 5 | `portPairWarning` kind 게이트 실제 평가 | ✅ 충족 (오탐 소멸 확인) |
| 5 | `fieldKind` 부재 유지 | ✅ 충족 |
| 6 | `mcpServer.test.ts` 그린 | ✅ 충족 |
| 6 | `GET /api/device-preset-capability` → 501 | ✅ **검증자가 채움** (구현자 미작성 항목) |
| 6 | `GET /api/core/capabilities` → `center.ok===false` + 사유 | ✅ 충족 (검증자가 HTTP 레벨로도 보강) |
| 6 | 전체 그린, `server.test.ts` 무수정 | ✅ 충족 |

---

## 경계면 교차 비교 결과

### A. `park3dRpcClient.ts` 파싱 ↔ **실서버 응답 원문** (읽기 전용 라이브 호출)

`http://192.168.0.125:13510` 에 **토큰 헤더 없이** 직접 호출한 실측이다. `cam.setPTZ` 는 호출하지 않았다.

| 호출 | 실측 결과 | 코드의 기대 | 일치 |
|---|---|---|---|
| `GET /health` | `200 {"ok": true}` | (사용 안 함) | — |
| `POST /rpc cam.list {}` | `200` `result.cameras[]` — camId 1·2 두 대, 각 `{camId,name,pos{x,y,z},pan,tilt,zoom}` | (사용 안 함, D3) | — |
| `POST /rpc cam.getPTZ {camId:1}` | `200` `result: {pan:41.5, tilt:20.100000381469727, zoom:1.5799099206924438}` | `result.pan/tilt/zoom` 직접 읽음 (`park3dRpcClient.ts:63-65`) | ✅ |
| `POST /rpc cam.getPTZ {}` | **HTTP 200** + `error{code:-32000, message:"필수 파라미터 누락: camId"}` | error 를 `!res.ok` **보다 먼저** 검사 (`:136`) | ✅ **핵심** |
| `POST /rpc cam.getPTZ {camId:99}` | **HTTP 200** + `error{code:-32000, message:"카메라 없음: camId=99"}` | 동일 분기로 오류화 | ✅ |
| `POST /rpc cam.captureJPG {camId:1}` | `200` `result: {img_bytes, width:1280, height:720, format:"jpg", camId:1}` — `img_bytes` 는 `/9j/4AAQ…` **`data:` 접두 없는 순수 base64**, 디코드 97,947 B, SOI `ffd8` | `result.img_bytes` 만 읽고 SOI 검증 (`:88-96`) | ✅ |
| `POST /stream/rpc` (경로 오배선 재현) | `404 {"errorCode":"errors.com.epicgames.httpserver.route_handler_not_found"}` | `!res.ok` 분기가 잡아 던짐 (`:141`) | ✅ |
| `GET /stream` | `200 multipart/x-mixed-replace; boundary=park3dframe` | 무인증 MJPEG 중계 | ✅ |
| `GET /rpc/catalog` | `200`, 79 메서드 | — | ✅ |

**판정: 모킹이 실제와 다른 shape 을 굳히고 있지 않다.**
`test/park3dRpcClient.test.ts:19` 의 `LIVE_GET_PTZ` 상수는 실서버 원문과 값까지 동일하고,
"오류를 HTTP 200 으로 보낸다"는 가장 위험한 특성도 모킹에 정확히 반영돼 있다.
`cam.captureJPG` 는 실제로 `img_bytes` 외에 `width/height/format/camId` 를 더 주지만,
드라이버가 `img_bytes` 만 읽으므로 문제되지 않는다(모킹이 좁은 쪽으로 틀린 것이지 다른 쪽으로 틀린 게 아니다).

### B. 드라이버 ↔ `CameraDriver` 인터페이스 ↔ 호출자

| 호출자 | 기대하는 표면 | 결과 |
|---|---|---|
| `settingsRoutes.ts:75-78` 연결테스트 | `createDriver(...).getPtz()` → `toView()` | ✅ raw 정수를 주므로 `toView` 의 도 환산이 성립 |
| `ptzRoutes.ts:13,26,44` | `getPtz`/`goPtz(target, speed?)` | ✅ 시그니처 일치(`speed` 는 의도적 무시) / ⚠ **결함 1** |
| `localCoreProvider.ts:54` | `typeof driver.centerPoint === 'function'` | ✅ 속성 자체가 없어 자동으로 `center.ok=false` |
| `frameSource.ts:28-38` | `streamUrl` 이 `http://` → `http-mjpeg`, 드라이버 미사용 | ✅ 폴링 경로를 타지 않음 |
| `frameSource.ts:44` / `GET /api/snapshot` | `getSnapshot(): Promise<Buffer>` | ✅ HTTP 레벨로 실제 JPEG 반환 확인 |
| `devicePresetRoutes.ts:23,34` | `kind !== 'hucoms'` → 501 | ✅ 501, RPC 호출 0회 |
| `web/control.js:37` | `camera.kind` 표시 | ✅ 문자열 표시뿐 |

`kind` 를 분기하는 지점을 전수 조사(`grep`)한 결과 `devicePresetRoutes.ts:23,34` 와 `web/options.js:79,99` 가 전부이며,
park3d-rpc 를 모르는 채 남은 분기는 **없다**.

### C. `config.json` → 정규화 → 팩토리 → 드라이버 → 실제 RPC params (끝에서 끝까지)

```
config.json simulator-2.camId = 1                        (config/config.json:61)
  → normalizeCamera: positiveInt(1) → {..., camId: 1}     (normalize.ts:29-31,47,59)
  → CameraConfig.camId?: number                           (types.ts:32)
  → createDriver case 'park3d-rpc': camId: camera.camId   (driverFactory.ts:35)
  → Park3DRpcClientOptions.camId                          (park3dRpcClient.ts:30)
  → requireCamId() → params.camId                         (park3dRpcClient.ts:60,148-154)
  → 와이어: {"method":"cam.getPTZ","params":{"camId":1}}
```
**끊기는 지점 없음.** HTTP 레벨(`POST /api/cameras/sim-2/test`)에서 실제 전송 body 의 `params.camId === 1` 을
검증자 신규 테스트로 고정했다. `camId` 를 0 으로 지운 초안에서는 **RPC 호출 0회 + 400** 임도 함께 고정했다.

또한 `config.json` 을 `normalizeConfig` 에 실제로 통과시켜 확인:
`kind='park3d-rpc'`, `camId=1`, `streamUrl` 이 `/stream` 으로 끝남, `streamTransportFor → 'http-mjpeg'`.

### D. `web/options.js` 포트짝 경고 ↔ 실제 `simulator-2` 설정값

`portPairWarning` 본문을 `new Function` 으로 **실제 평가**한 결과:

| 입력 | 결과 |
|---|---|
| `('http://192.168.0.125:13510', 'http://192.168.0.125:13510/stream', 'park3d-rpc')` | `''` — **오탐 소멸 확인** |
| `('http://h:8081','http://h:8091','hucoms')` | `''` (정상 짝, 기존 동작 유지) |
| `('http://h:8081','http://h:8095','hucoms')` | `⚠ … 8091 …` (기존 경고 유지) |
| `('http://h:8081','http://h:8095')` — kind 없음 | `⚠ … 8091 …` (옛 호출부 호환) |

게이트 전이었다면 제어 13510 / 영상 13510 은 `13520 ≠ 13510` 이라 **항상** 거짓 경고가 떴다. 지금은 뜨지 않는다.
`selected()?.kind` 는 `/api/settings` 응답(`toPublicCamera` 가 이미 `kind` 를 싣는다)에서 오므로 새 API 배선이 없다 — 계획대로다.

### E. 역방향 왕복 (`goPtz(getPtz())`)

```
서버 실값        20.100000381469727°
 → getPtz()      round(2010.0000038…) = 2010 (raw)
 → goPtz(2010)   2010/100 = 20.1  ← 서버로 나가는 값
```
**원래 값과 다르다.** zoom 도 `1.5799099206924438 → 158 → 1.58` 로 달라진다.

- pan/tilt 오차: **3.8e-7 도** — 물리적으로 무의미하다.
- zoom 오차: **배율 0.00009** — 무의미하다.
- **고정점이다**: 한 번 양자화된 뒤(20.1)에는 다시 읽어도 2010, 다시 보내도 20.1 이라 **반복해도 더 흐르지 않는다.**
  즉 왕복을 반복해도 값이 조금씩 밀려나는 드리프트는 발생하지 않는다.

**판정: 허용 가능.** raw 계약이 0.01 도/0.01 배 해상도인 이상 불가피한 양자화이고, 드리프트가 없으므로 안전하다.
다만 "화면에 보이는 raw 는 장비 실값이 아니라 0.01 로 반올림된 값"이라는 점은 문서에 남겨야 한다.
이 성질을 `test/park3dRpcServerRoutes.test.ts` 의 `역방향 왕복` 케이스로 고정해 두었다.

---

## 발견 결함

### 결함 1 (심각도: **중간**) — park3d 의 zoom 클램프가 `limited` 에 보고되지 않는다

- **위치**: `SettingMain/src/devices/park3d/park3dRpcClient.ts:77` (드라이버 내부 클램프)
  ↔ `SettingMain/src/api/routes/ptzRoutes.ts:26,44` (`limitedAxes` / nudge 의 `limited` 판정)
- **원인**: `limitedAxes()` 와 `nudge()` 는 공유 `ZOOM_RANGE = [0, 65535]`(Hucoms 것, `src/domain/ptz.ts:29`)로만 판정한다.
  park3d 의 실제 유효범위 `[100, 3600]` 은 **드라이버 안에만** 있어(설계 D1) 라우트가 알지 못한다.
- **재현 (실제 실행해 확인한 출력)**:

```
limitedAxes({pan:0,tilt:0,zoom:50})    = []      ← 잘렸다고 보고하지 않는다
  실제 전송 zoom = 1     (raw 100. 요청 raw 50 이 잘렸다)

limitedAxes({pan:0,tilt:0,zoom:9999})  = []      ← 잘렸다고 보고하지 않는다
  실제 전송 zoom = 36    (raw 3600. 요청 raw 9999 가 잘렸다)

nudge({zoom:3600}, 'zoom', +500).zoom = 4100 (≠ 3600)
  → ptzRoutes.ts:44 의 limited 판정 = []        ← 잘렸다고 보고하지 않는다
  실제 전송 zoom = 36    (카메라는 움직이지 않는다)
```

- **기대값**: `POST /api/ptz/absolute {zoom:9999}` → 응답 `limited: ['zoom']`
- **실제값**: `limited: []`
- **왜 문제인가**: `ptzRoutes.ts:30` 스스로 *"잘린 축은 숨기지 않는다 — 착지가 어긋났다는 유일한 신호다"* 라고 못 박고 있다.
  park3d 는 그 원칙이 깨진 유일한 드라이버다. 특히 nudge 경로에서 **줌이 이미 최대(36배)일 때 버튼을 눌러도
  카메라는 안 움직이고 `limited` 도 비어 있어 화면에 아무 신호가 없다** — 이 저장소가 과거에 실제로 겪었다고
  주석에 기록해 둔 "버튼이 동작하지 않는다" 증상과 같은 모양이다.
- **완화 요인(그래서 '높음'이 아니다)**: 응답의 `ptz` 는 `waitForSettle` 로 **장비에서 되읽은 값**이라
  사용자가 숫자칸을 유심히 보면 목표와 다르다는 것은 알 수 있다. 조용한 오동작이지 데이터 손상은 아니다.
- **책임 소재**: 구현 실수가 아니라 **설계 계약의 빈틈**이다. 설계 D1("변환·클램프는 드라이버 안에 가둔다")은
  `limitedAxes` 가 기기별 범위를 모른다는 결과를 검토하지 않았다. 따라서 **설계자에게도 함께 보고한다.**
- **권고(이번 범위에서 고칠지는 리더 판단)**: 세 방향이 있고 각각 대가가 다르다.
  1. `CameraDriver` 에 선택 메서드 `zoomRange?(): [number, number]` 를 두고 `ptzRoutes` 가 있으면 그것으로 판정 —
     정공법이지만 인터페이스를 넓힌다.
  2. `goPtz` 가 잘린 축을 반환하도록 시그니처 변경 — 파급이 크다.
  3. 지금은 고치지 않고 **알려진 한계로 문서화** — 범위를 지키는 선택. 다만 documenter 가 반드시 적어야 한다.

---

## 관찰 사항 (결함 아님, 기록용)

1. **zoom 한 눈금이 park3d 에서는 매우 크다.** `web/control.js:225-229` 의 `stepDelta` 는 `step × 100` 을 raw 델타로 쓴다.
   기본 step 1 이면 raw 100 인데, park3d 에서 raw 100 = **배율 1.0 만큼의 점프**다(1배→2배→3배).
   Hucoms(0~65535)에서는 미세 조정이던 같은 눈금이 park3d 에서는 거친 조작이 된다. 범위 밖 UX 개선 후보.
2. **`toPublicCamera` 가 `camId` 를 공개한다** — 의도된 동작이며(비밀이 아님) `camId` 가 있는 카메라에만 키가 생겨
   `server.test.ts:154` 의 키 집합을 넓히지 않는다. HTTP 레벨로 직접 확인했다.
3. **`scripts/test-settingmanager-safe.ps1` 은 `git status` 상 삭제(D) 상태**다. 기존 red 의 원인이며 범위 밖이라 손대지 않았다.
   `scripts/run-hermes-role.ps1`·`setup-hermes-role-profiles.ps1` 도 함께 삭제 상태다 — 이번 작업과 무관하지만 리더가 인지할 필요가 있다.

---

## 금지선 확인

| 항목 | 확인 방법 | 결과 |
|---|---|---|
| `test/server.test.ts` 무수정 | `git diff --stat -- SettingMain/test/server.test.ts` → **출력 없음**, `git status --porcelain` → **출력 없음** | ✅ 한 줄도 안 바뀜 |
| `test/server.test.ts` 그린 | `npx vitest run` → `test/server.test.ts (84 tests)` ✓ | ✅ 84건 전부 그린 |
| 인증 코드 부재 | `grep -rniE "X-Park3D-Token\|PARK3D_RPC_TOKEN\|hasToken\|\btoken\b" src web config` | ✅ **소스·설정에 0건.** 매치된 3곳은 전부 *"없음을 검사하는"* 테스트 코드다 (`park3dRpcClient.test.ts:89,92-93`, `normalize.test.ts:82-83`) |
| `cam.setPTZ` 실기 미호출 | 검증자의 라이브 호출은 `/health`·`cam.list`·`cam.getPTZ`·`cam.captureJPG`·`/rpc/catalog`·`GET /stream` 뿐 | ✅ 카메라를 움직이지 않았다 |
| 범위 밖 red 미수정 | `test/powershellSafeDiagnostic.test.ts` 및 `scripts/` 미변경 | ✅ |
| 느슨한 통과 없음 | 신규 테스트는 기대값을 낮추지 않았다. 유일한 신규 테스트 수정은 **검증자 자신의 하네스 결함**(fake fetch 가 Hucoms CGI 대조군에 응답하지 않아 타임아웃)이며 제품 코드를 감싸주지 않았다 | ✅ |

---

## 미작성 검증 보완 — `GET /api/device-preset-capability` → 501

구현자가 *"서버 하네스가 필요한데 `test/server.test.ts` 가 불가침이라 못 만들었다"* 고 밝힌 항목을 채웠다.

**신규 파일**: `SettingMain/test/park3dRpcServerRoutes.test.ts` (11건, 전부 그린)
`test/server.test.ts` 의 하네스 패턴(임시 디렉토리 + `createServer` + `fetchImpl` 주입 + `settleOptions.sleep` 무력화)을
**복제**했고 원본 파일은 열어 읽기만 했다. fake fetch 는 Park3D JSON-RPC 와이어를 흉내 내며,
"오류도 HTTP 200 으로 돌려준다"는 실측 특성을 그대로 재현한다(모킹 근거를 파일 머리 주석에 명시).

담은 검증:
1. `GET /api/device-preset-capability?cameraId=sim-2` → **501**, RPC 호출 **0회**(kind 가드가 네트워크 이전에 걷어낸다)
2. `GET /api/cameras/sim-2/device-presets` → **501**
3. 대조군: hucoms 카메라는 같은 경로에서 501 이 **아니다** → 501 이 kind 때문임을 고정
4. `GET /api/core/capabilities?cameraId=sim-2` → `center.ok === false` + 사유 문구
5. `POST /api/cameras/sim-2/test` → `ok:true`, `kind:'park3d-rpc'`, `ptz {pan:4150,tilt:2010,zoom:158,panDeg:41.5,tiltDeg:20.1}`,
   전송 헤더가 `content-type` **하나뿐**
6. `GET /api/ptz?cameraId=sim-2` → 같은 raw
7. `GET /api/snapshot?cameraId=sim-2` → 실제 JPEG(SOI `ffd8`), `cam.captureJPG {camId:1}` 호출 확인
8. `camId` 를 지운 초안 → `ok:false`, 오류에 `camId`, **RPC 호출 0회**
9. `/api/settings` 에 `camId` 조건부 노출 + camId 없는 카메라의 키 집합 불변 (설계 3단계 검증 6)
10. `PUT /api/settings` 왕복에서 `kind`·`camId` 생존 (설계 3단계 검증 5)
11. 역방향 왕복의 0.01 양자화와 **고정점 성질**

---

## 미검증 항목과 사유

| 항목 | 사유 |
|---|---|
| `cam.setPTZ` 실기 동작 (가정 B: params·응답 형태) | **지시에 따라 호출하지 않았다** — 카메라가 실제로 움직인다. 리더가 사용자 승인 아래 별도 수행. 모킹으로는 형제 프로젝트 `RpcCameraClient.ts:65,115-121` 근거의 shape 만 고정돼 있다 |
| Park3D 의 zoom 실제 도달범위 및 범위 밖 값 처리(거부/클램프/수용) | 확인하려면 `cam.setPTZ` 가 필요하다. `[100,3600]` 의 근거는 여전히 형제 프로젝트 설정값(`camera.zoomMin=1/zoomMax=36`)뿐이다. `GET /rpc/catalog` 79 메서드를 훑었으나 범위를 알려주는 메서드가 **없다**(`cam.*` 18개: applyPreset·captureJPG·capturePNG·create·delete·get·getPTZ·list·loadPreset·savePreset·select·setFOV·setHeight·setPan·setPosition·setPTZ·setTilt·setZoom) |
| Park3D 의 tilt 실제 도달범위 vs 공유 `TILT_RANGE=[-2000,9000]` | **잠재 위험으로 남는다.** `clampPtz` 가 Hucoms 범위로 자르므로, Park3D 가 tilt -20°~90° 밖을 지원한다면 `goPtz(getPtz())` 왕복이 깨진다. `cam.list` 로 확인한 실제 2대는 tilt 20.1° / 6.0° 로 **모두 범위 안**이라 지금은 드러나지 않는다. 확인하려면 카메라를 움직여야 한다 |
| 브라우저에서 옵션 화면 「연결 테스트」 초록 표시 / PTZ 화면 이동 / 영상 탭 MJPEG 재생 | 실제 브라우저 조작이 필요하다. 다만 그 아래 계층(RPC 응답값·`/stream` 200 과 content-type·`portPairWarning` 반환값·`/api/snapshot` JPEG)은 전부 확인했다 |
| `cam.list` 기반 자동 발견, camId 2 등록, preset RPC | 설계 비범위 |

---

## 협업 전달

- **구현자(developer)**: 결함 1 은 구현 실수가 아니다. 고칠지 여부는 리더 판단이며, 고친다면 `ptzRoutes` 와 `CameraDriver` 를 함께 봐야 한다.
- **설계자(architect)**: 결함 1 은 D1("클램프는 드라이버 안에 가둔다")과 `ptzRoutes.ts:30`("잘린 축은 숨기지 않는다")이 **서로 모순**한 결과다. 계약 차원의 판단이 필요하다.
- **문서화(documenter)**: 이 리포트의 수치(**최종 336 pass / 1 fail / 0 skip**, 기존 red 1건은 범위 밖)와 §역방향 왕복(0.01 양자화·드리프트 없음), 결함 1, §미검증 항목만 인용할 것. **실기 PTZ 이동은 검증되지 않았다** — "동작 확인 완료"로 적으면 안 된다.
