# 01 설계서 — Park3D RPC 카메라 드라이버(`kind: "park3d-rpc"`) 신규 추가

- 작성: 설계자(architect)
- 대상 저장소: `D:\Work\Parking3D\Agent\baro\SettingManager`
- 서비스 루트: `SettingMain/` (부트스트랩 완료 상태 — `SettingMain/package.json`·`tsconfig.json`·`vitest.config.ts` 존재, 부트스트랩 단계 **불필요**)

---

## 개정 이력

| 판 | 변경 요약 | 사유 |
|---|---|---|
| 초판 | Park3D RPC 드라이버 신설 설계 6단계 | — |
| 2판 | **토큰 전면 삭제**(D2 폐기: `token` 설정 필드·`PARK3D_RPC_TOKEN` 폴백·`X-Park3D-Token` 헤더·`hasToken`·마스킹 로직 모두 미도입) / `cam.getPTZ` 성공 응답과 `/stream` 무인증 개방을 **가정 → 실측 사실**로 교체 / zoom 100~3600 만 `확인 필요` 유지 / `test/server.test.ts:154` 는 **손대지 않는다**(3단계에서 제거) | 사용자 지시 "토큰 없이 동작하도록" + 리더의 무헤더 실측 3건(200 응답). 지금 없는 인증을 미리 만드는 것은 CLAUDE.md 2항(추측성 코드 금지) 위반 |

---

## 범위

`config/config.json` 의 `simulator-2`(`http://192.168.0.125:13510`)는 Hucoms CGI 카메라가 아니라 언리얼 **Park3D JSON-RPC 서버**다.
현재 `kind:"hucoms"` 로 등록되어 있어 `HucomsClient.getPtz()` 가 `GET /cgi-bin/control/ptzf_status.cgi` 를 보내고, UE HTTP 서버가
`errors.com.epicgames.httpserver.route_handler_not_found` 로 404 를 돌려준다(웹 UI: "❌ 연결 실패 · 57ms · 카메라 HTTP 404").

이 설계는 **네 번째 카메라 종류 `park3d-rpc` 를 신설**하여 그 서버를 정식 프로토콜로 다룬다.

경계 원칙 — **변환은 드라이버 안에 갇힌다.**
`PtzRaw`·`clampPtz`·`toView`·PTZ 라우트·웹 UI 는 **한 줄도 바꾸지 않는다.** 상위 계층은 지금까지처럼 raw 정수(centi-deg)만 본다.
Park3D 가 쓰는 도(度) 실수 ↔ raw 정수 환산은 `Park3DRpcClient` 내부에서만 일어난다.

---

## 사용자 확정 결정 (임의 변경 금지)

| # | 결정 | 구체값 |
|---|------|--------|
| D1 | PTZ 단위는 raw 환산(×100) | pan/tilt: 도×100 centi-deg (41.5° ↔ 4150). zoom: 배율×100 (1.58 ↔ 158), 유효 raw 100~3600 |
| ~~D2~~ | ~~토큰은 config 필드 + 환경변수 폴백~~ → **2판에서 폐기** | **인증을 넣지 않는다.** 아래 D2' 참조 |
| D2' | **무인증 호출** (사용자 지시 + 실측) | `token` 설정 필드·`PARK3D_RPC_TOKEN` 폴백·`X-Park3D-Token` 헤더를 **모두 만들지 않는다** |
| D3 | `camId` 는 설정 필드 신설 | `simulator-2` 는 `camId: 1`. 카메라 2대를 모두 등록하지 않는다 |

### D2' — 왜 인증을 넣지 않는가 (근거)

사용자 지시: *"토큰 없이 동작할 수 있도록 만들어줘. (언리얼 시뮬레이터 서버는 토큰 없이 사용함)"*

리더가 **토큰 헤더 없이** 라이브 서버에 직접 호출해 확인한 실측 3건:

| 호출 | 결과 |
|---|---|
| `POST /rpc {"method":"cam.getPTZ","params":{"camId":1}}` | **HTTP 200** + `{"result":{"pan":41.5,"tilt":20.100000381469727,"zoom":1.5799099206924438}}` |
| `GET /rpc/catalog` | **200** |
| `GET /stream` | **200** `multipart/x-mixed-replace; boundary=park3dframe` |

즉 **이 서버는 무인증으로 열려 있다.** 형제 프로젝트(`SettingAgent`)가 `X-Park3D-Token` 을 배선한 것은 그쪽 사정이며,
지금 이 서버가 요구하지 않는 인증을 미리 만드는 것은 **CLAUDE.md 2항(추측성 코드 금지)** 위반이다.

**나중에 서버가 토큰을 강제하게 되면?** `POST /rpc` 가 401/403 을 돌려주고, 드라이버의 `!res.ok` 분기가
`HTTP 401 + 서버 본문 200자` 를 실은 `CameraDriverError` 로 그대로 드러낸다 — **조용히 실패하지 않는다.**
그때 필드를 추가하면 되고, 그 시점에는 "왜 필요한지"가 실측으로 확정되어 있다.

---

## 실측 계약 (리더가 라이브 서버 호출로 확인 — 추측 아님)

**인증 없음 — 아래 전부 토큰 헤더 없이 호출한 결과다(2판 실측).**

- `GET /health` → 200, 인증 불필요
- `POST /rpc` — JSON-RPC 2.0. **헤더는 `content-type: application/json` 뿐**
- `GET /rpc/catalog` → 200, `{methods:[…]}` 79개 (`cam.list cam.get cam.getPTZ cam.setPTZ cam.captureJPG …`)
- `GET /stream` → 200 `multipart/x-mixed-replace; boundary=park3dframe`
- `cam.list` 실응답: `{"cameras":[{"camId":1,"name":"Camera-1","pos":{…},"pan":41.5,"tilt":20.100000381469727,"zoom":1.5799099206924438}, …]}`
- **`cam.getPTZ` 성공 응답 실측(2판 확정)**: `POST /rpc {"method":"cam.getPTZ","params":{"camId":1}}` → HTTP 200 +
  `{"result":{"pan":41.5,"tilt":20.100000381469727,"zoom":1.5799099206924438}}`
  → **result 직하위에 `pan`·`tilt`·`zoom` 3키, 모두 실수.** 추정이 아니라 실측이다.
- `cam.getPTZ`/`cam.get` 를 params 없이 호출 → `{"error":{"code":-32000,"message":"필수 파라미터 누락: camId","data":null}}` → **camId 필수**

참고 구현(형제 프로젝트, 같은 서버를 호출):
- `d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent\src\clients\CRpcClient.ts` — 본문을 `text()` 로 **1회** 읽고 `body.error` → `!res.ok` 순으로 분기(주석 75~109행에 실패 이력)
- `d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent\src\clients\RpcCameraClient.ts:71,79` — `cam.captureJPG` 응답이 `{img_bytes: base64}`
- `d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent\src\clients\RpcCameraClient.ts:127-134` — `cam.getPTZ` 결과에서 `result.pan/tilt/zoom` 을 직접 읽는다(위 실측과 일치)
- `d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent\config\tools.config.json` — `camera.zoomMin=1 / zoomMax=36` (zoom 배율 범위 근거)
- ⚠ 형제의 `src\viewer\sourceRegistry.ts:27-29`(`X-Park3D-Token` 헤더)와 `src\config\toolsConfig.ts:296-301`(`resolveRpcToken`)은
  **이번 작업에서 따라 하지 않는다** — D2' 참조. 참고용으로만 남긴다.
- `d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent\docs\20260804_220116_언리얼RPC_카메라제어_경로복구_baseUrl과res_ok.md` — baseUrl 에 `/stream` 이 붙어 `/stream/rpc` 404 난 사고 기록. **`controlUrl` 에는 경로 접미사를 붙이지 않는다**(`/rpc`·`/health`·`/stream` 은 모두 루트 서비스)

---

## 리더 지시와 실제 코드의 차이 (코드로 확인한 사실)

리더 지시의 경로 일부는 실제와 다르다. **아래가 정본이다.**

| 리더 지시 | 실제 경로 | 확인 |
|---|---|---|
| `src/devices/park3d/park3dRpcClient.ts` | 그대로 사용 가능 (`src/devices/` 아래 `hucoms/`·`backendCore/` 하위 디렉토리 관례 존재) | ✅ |
| `src/devices/driverFactory.ts` | 동일 — `default:` 에 `const unknown: never = camera.kind` 소진 검사 있음(29~32행) | ✅ |
| `src/media/frameSource.ts` | 동일 | ✅ |
| `web/options.js` | 실제는 `SettingMain/web/options.js` | ✅ |
| `src/mcp/routeCatalog.ts` | 동일. 검증 테스트 파일명은 `routeCatalog.test.ts` 가 아니라 **`test/mcpServer.test.ts`**(15~24행이 `src/api/routes/*.ts` 를 스캔) | ⚠ 정정 |

추가로 코드에서 확인한 사실(계획에 반영됨):
- `src/core/local/localCoreProvider.ts:54` — `typeof ctx.driver.centerPoint === 'function'` 으로 능력을 판정한다. `centerPoint` 를 구현하지 않으면 **자동으로** `center` 능력이 `ok:false` 가 된다. 별도 배선 불필요.
- `src/api/routes/devicePresetRoutes.ts:23,34` — `camera.kind !== 'hucoms'` 이면 501. park3d-rpc 는 **자동으로** 장비 프리셋에서 배제된다. 변경 불필요.
- `test/optionsDiscoveryBackendCoreUi.test.ts` — 옵션 화면에 **kind 편집 필드를 두면 안 된다**고 못 박는다(`id="fieldKind"`, `['fieldKind','kind']`, `$('fieldKind')` 금지). 즉 kind 는 `config.json` 직접 편집으로만 바뀐다. 이번 작업도 **kind 입력칸을 추가하지 않는다.**
- `SettingMain/web/options.js` 의 `state.cameras` 는 `/api/settings` 응답이고 `toPublicCamera` 가 `kind` 를 이미 싣는다(`web/control.js:37` 이 `camera.kind` 사용). 즉 **웹 UI 는 이미 kind 를 알고 있다** — 5번 항목에 새 API 배선이 필요 없다.
- `test/server.test.ts:154` 가 공개 카메라의 **키 집합을 정확히** 검사한다: `['controlUrl','hasPassword','id','kind','label','streamUrl','timeoutMs','username']`.
  **2판: 토큰을 넣지 않으므로 이 테스트는 손대지 않는다.** 공개 키 집합은 그대로 유지되며, 이 테스트가 깨지면 **회귀다**
  (초판에서 "의도된 계약 변경 1건"으로 잡았던 항목은 취소됐다).

---

## 가정 / 확인 필요

- ~~**가정 A (PTZ 응답 shape)**~~ → **2판에서 실측으로 해소.** `cam.getPTZ {camId:1}` → `{"result":{"pan":41.5,"tilt":20.100000381469727,"zoom":1.5799099206924438}}`.
  result 직하위 3키·실수 확정. **드라이버는 세 값 중 하나라도 유한수가 아니면 `CameraDriverError` 를 던진다는 설계는 그대로 유지한다**(조용한 0 폴백 금지 — 미래의 스키마 변화를 침묵시키지 않기 위한 방어이며, 지금 계약을 의심해서가 아니다).
- ~~**확인 필요 1 (`/stream` 인증)**~~ → **2판에서 실측으로 해소.** 토큰 헤더 없이 `GET /stream` → 200 `multipart/x-mixed-replace; boundary=park3dframe`.
  `src/media/httpMjpeg.ts` 가 커스텀 헤더를 못 싣는 문제는 **애초에 발생하지 않는다.** 인증 없는 MJPEG 중계로 그대로 동작한다.
- **가정 B (setPTZ 파라미터·응답)**: `cam.setPTZ` params 는 `{camId, pan, tilt, zoom}`(도·배율), 응답은 `{ok:true}` 계열. 근거: `RpcCameraClient.ts:65,115-121`. 드라이버는 **`ok` 값을 성공 판정에 쓰지 않는다** — JSON-RPC `error` 부재 + `res.ok` 로만 판정한다(형제의 "result 부재를 근거로 쓰지 말라"는 주석 근거, `CRpcClient.ts:100-102`). 실기 확인은 4단계.
- **가정 C (camId 누락 시 동작)**: `park3d-rpc` 카메라에 `camId` 가 없으면 드라이버가 **400 으로 던진다**(임의로 1 을 넣지 않는다). 근거: 서버 자신이 `-32000 필수 파라미터 누락: camId` 로 거절하고, `CameraDriver` 주석이 "못 하는 기능은 지어내지 않고 던진다"는 규약을 명시(`src/devices/cameraDriver.ts:35-38`).
  **2판 보강: `simulator-2` 는 4단계에서 `camId:1` 을 설정에 명시하므로 정상 경로에서는 이 오류가 걸리지 않는다.** 이 throw 는 `config.json` 을 손으로 편집해 park3d-rpc 카메라를 추가하면서 `camId` 를 빠뜨린 경우에만 나타나고, 그때 "어느 카메라를 조작할지 모른 채 1번을 움직이는" 사고를 막아 준다.
- **확인 필요 (유지)**: zoom raw 유효범위 **100~3600** 의 근거는 형제의 `camera.zoomMin=1 / zoomMax=36` 설정값이다. Park3D 서버가 범위 밖 값을 실제로 어떻게 다루는지(거부·클램프·그대로 수용)는 **미확인** — 확인하려면 카메라를 실제로 움직여야 한다. 드라이버는 이 범위로 **자체 클램프**만 하고, 서버가 거부하면 그 오류를 그대로 전달한다.
- **확인 필요 (유지)**: `cam.captureJPG` 의 base64 가 `data:` 접두 없이 순수 base64 인지. 형제는 `Buffer.from(cap.img_bytes ?? '', 'base64')` 로 바로 디코드한다(`RpcCameraClient.ts:79`). 드라이버는 디코드 후 **JPEG SOI(`FF D8`) 검증**으로 이 불확실성을 잡는다.

---

## 단계

### 1단계 — `Park3DRpcClient` 신설
**파일**: `SettingMain/src/devices/park3d/park3dRpcClient.ts` (신규)

`CameraDriver`(`src/devices/cameraDriver.ts:39-49`)를 구현한다.

```
options: { cameraId, baseUrl, camId?, timeoutMs, fetchImpl? }     ← token 필드 없음(D2')
readonly kind = 'park3d-rpc'
```

- 생성자: `baseUrl` 이 비면 400 으로 던진다(HucomsClient 선례 31행). `baseUrl.replace(/\/+$/,'')` 로 후행 슬래시 제거.
- `private callRpc(method, params)`: `POST ${baseUrl}/rpc`, body `{jsonrpc:'2.0', id:1, method, params}`,
  헤더는 **`content-type: application/json` 뿐이다 — 인증 헤더를 보내지 않는다**(D2').
  타임아웃은 `AbortSignal.timeout(timeoutMs)`(HucomsClient 96행과 동일 관례).
  **본문은 `text()` 로 1회만 읽고**, ① JSON 파싱 실패 → 원문 200자를 실은 오류, ② `body.error` → `RPC 오류 [code]: message`,
  ③ `!res.ok` → `HTTP {status}` + 원문 200자, ④ 그 외 `body.result` 반환. **순서를 지킨다**(근거: `CRpcClient.ts:75-111` 주석 —
  순서를 바꾸면 404 본문이 `result:undefined` 로 조용히 통과해 먼 곳에서 TypeError 로 터진다).
- `private requireCamId()`: `camId` 가 양의 정수가 아니면 `CameraDriverError('… camId 를 설정하세요', 400)` (가정 C).
- `getPtz()`: `cam.getPTZ {camId}` → `{pan,tilt,zoom}`(도·배율) → **raw 로 환산**
  `pan: Math.round(pan*100)`, `tilt: Math.round(tilt*100)`, `zoom: Math.round(zoom*100)`. 유한수가 아니면 던진다(가정 A).
- `goPtz(target, speed?)`: 입력은 raw. ① `clampPtz(target)`(공유 도메인 — pan wrap·tilt 클램프) ② zoom raw 를 **100~3600 으로 자체 클램프**
  ③ `/100` 해서 `cam.setPTZ {camId, pan, tilt, zoom}` 호출. `speed` 인자는 **무시한다**(Park3D 계약에 속도 파라미터가 없다 — 주석으로 명시).
- `getSnapshot()`: `cam.captureJPG {camId}` → `img_bytes` base64 디코드 → **`FF D8` SOI 검증** 실패 시 던진다(HucomsClient 68-72행 선례).
- `listSlots()`: `return []` (주차면 개념 없음 — 오류가 아니다).
- **`centerPoint` 는 구현하지 않는다.** `CameraDriver` 의 선택 메서드이고 Park3D 에 대응 계약이 없다.
- **마스킹 로직은 만들지 않는다**(D2' — 감출 비밀 자체가 없다. HucomsClient 의 `mask` 는 쿼리스트링 평문 비밀번호 때문이고 여기엔 해당 사항이 없다).
  다만 오류 문구에 URL·서버 본문을 실을 때 **`baseUrl` 과 요청 경로만** 싣고 자격증명류를 새로 끌어오지 않는다는 기존 관례는 지킨다.

**검증 (모킹 유닛테스트, 실기 불필요)** — `SettingMain/test/park3dRpcClient.test.ts`:
1. `cam.getPTZ` 모킹 응답 **`{"result":{"pan":41.5,"tilt":20.100000381469727,"zoom":1.5799099206924438}}`**(리더 실측 원문 그대로 — 모킹 근거를 테스트 주석에 남긴다) → `getPtz()` === `{pan:4150, tilt:2010, zoom:158}`
2. 요청 검사: URL 이 정확히 `http://host:13510/rpc`(경로 중복 `/stream/rpc` 없음), method POST, body 가 `{jsonrpc:'2.0',id:1,method:'cam.getPTZ',params:{camId:1}}`
3. **인증 헤더 부재 검사**: 전송된 헤더에 `X-Park3D-Token` 이 **없다**(대소문자 무시). 헤더는 `content-type` 만 있다.
   `process.env.PARK3D_RPC_TOKEN` 을 설정해 두어도 **여전히 헤더가 붙지 않는다**(D2' 회귀 방지 — 환경변수가 조용히 되살아나지 않게 한다)
4. `goPtz({pan:4150,tilt:2010,zoom:158})` → `cam.setPTZ` params `{camId:1,pan:41.5,tilt:20.1,zoom:1.58}`
5. zoom 클램프: `goPtz(zoom: 50)` → 전송 zoom `1`, `goPtz(zoom: 9999)` → 전송 zoom `36`
6. 오류 봉투: `{"error":{"code":-32000,"message":"필수 파라미터 누락: camId"}}` 를 **HTTP 200 으로** 돌려줘도 `CameraDriverError` 로 던진다(메시지에 `-32000` 포함)
7. 404 + `{"errorCode":"errors.com.epicgames.httpserver.route_handler_not_found","errorMessage":""}` → 던진다. **`undefined` 를 정상 반환하지 않는다**(사고 재발 방지)
8. `getSnapshot()`: `{img_bytes: <FF D8 … base64>}` → Buffer 첫 두 바이트 `0xFF 0xD8`. SOI 아닌 base64 → 던진다
9. **401/403 미래 대비**: HTTP 401 + 임의 본문 → `CameraDriverError` 로 던지고 메시지에 `401` 이 보인다
   (서버가 나중에 인증을 켜면 조용히 실패하지 않고 즉시 드러난다는 D2' 의 근거를 테스트로 고정한다)
10. `camId` 미설정 → `getPtz()` 가 `statusCode===400` 으로 던진다. `fetch` 는 **호출되지 않는다**
11. `listSlots()` === `[]`, `centerPoint` 는 `undefined`(속성 자체가 없다)

---

### 2단계 — `driverFactory` kind 분기 + 타입 확장
**파일**: `SettingMain/src/devices/driverFactory.ts`, `SettingMain/src/config/types.ts`

`CameraKind` 를 `'hucoms' | 'backend-core' | 'park3d-rpc'` 로 넓히고, `createDriver` 에 `case 'park3d-rpc'` 를 추가해
`Park3DRpcClient` 를 `{cameraId: camera.id, baseUrl: camera.controlUrl, camId: camera.camId, timeoutMs: camera.timeoutMs, fetchImpl}` 로 만든다
(**`token` 은 넘기지 않는다** — 필드 자체가 없다, D2').
**둘을 같은 커밋에서 바꾼다** — `default:` 의 `const unknown: never = camera.kind` 가 타입만 넓히면 컴파일 오류를 낸다(그게 의도된 안전장치다).
`types.ts` 상단의 `CameraKind` 주석에 `park3d-rpc` 설명을 추가한다: 언리얼 Park3D JSON-RPC(`POST /rpc`), **Hucoms CGI 가 아니다**.

**검증 (모킹)**:
1. `npm run typecheck` 통과 — `never` 소진 검사가 살아 있음을 확인(케이스를 지우면 실패해야 한다)
2. `createDriver({kind:'park3d-rpc', …})` 가 `kind === 'park3d-rpc'` 인 드라이버를 돌려준다
3. 기존 `hucoms`·`backend-core` 분기 회귀 없음

---

### 3단계 — 설정 타입·정규화
**파일**: `SettingMain/src/config/types.ts`, `SettingMain/src/config/normalize.ts`
(**2판: `test/server.test.ts` 는 수정 대상에서 빠졌다** — 아래 참조)

`CameraConfig` 에 선택 필드 **1개**:
- `camId?: number` — park3d-rpc 전용. **1-based**
- ~~`token?: string`~~ → **만들지 않는다**(D2')

`normalize.ts`:
- `CAMERA_KINDS` 에 `'park3d-rpc'` 추가(5행)
- `normalizeCamera`: `camId` 는 **양의 정수일 때만** 싣는다(유효하지 않으면 필드를 만들지 않는다 — 기존 `int()` 헬퍼는 클램프라 부적합)
- **`PublicCamera`·`toPublicCamera` 는 손대지 않는다.** 감출 새 비밀이 없으므로 `hasToken` 도 없다.
  `camId` 는 비밀이 아니므로 기존 스프레드로 자연히 공개된다(값이 있는 카메라에만).
- **`mergeSettings` 도 손대지 않는다.** password 의 "빈 문자열 = 변경 없음" 규칙은 **그대로 유지**하고, token 용 대응 규칙은 추가하지 않는다.
  `camId` 는 일반 필드라 기존 `{...camera, ...change}` 병합으로 충분하다.

**검증 (모킹)** — `test/normalize.test.ts` 보강:
1. `normalizeCamera({id:'x', kind:'park3d-rpc'})?.kind === 'park3d-rpc'` (기존 "알 수 없는 kind 는 hucoms" 테스트는 그대로 통과해야 한다)
2. `normalizeCamera({id:'x', kind:'park3d-rpc', camId:'2'})` → `camId === 2`; `camId:0`·`camId:-1`·`camId:'abc'` → `camId` 필드 없음
3. `normalizeCamera({… token:'apark3d'})` 결과에 **`token` 키가 없다**(설정에 남은 옛 토큰 값이 있어도 조용히 버려진다 — D2')
4. **`test/server.test.ts:154` 의 공개 카메라 키 집합은 그대로 통과해야 한다**
   (`['controlUrl','hasPassword','id','kind','label','streamUrl','timeoutMs','username']`). 이 테스트가 깨지면 **회귀다** — 고칠 대상이 아니다
5. `PUT /api/settings` 로 `kind:'park3d-rpc'` 저장 → 다시 읽었을 때 유지(`server.test.ts` 628-630행 패턴)
6. `camId` 가 있는 카메라의 `/api/settings` 응답에는 `camId` 가 실리고, 없는 카메라에는 키가 없다

---

### 4단계 — 설정 파일 정정
**파일**: `SettingMain/config/config.json`, `SettingMain/config/config.example.json`

`config.json` 의 `simulator-2`:
```
kind:       "hucoms"                        → "park3d-rpc"
controlUrl: "http://192.168.0.125:13510"      (그대로 — 경로 접미사 금지)
streamUrl:  "http://192.168.0.125:13510"    → "http://192.168.0.125:13510/stream"
camId:      (없음)                          → 1
label:      "UE-시뮬2"                      → "Park3D 시뮬2 (RPC)"  ← 오해 재발 방지
```
**`token` 필드는 쓰지 않는다 — 존재하지 않는 필드다**(D2'). 환경변수도 필요 없다.
`config.example.json` 에는 `park3d-rpc` 예시 항목 1건을 추가한다(`kind`·`controlUrl`·`streamUrl`(`/stream`)·`camId:1`,
`username`/`password` 는 빈 문자열 — **이 종류는 인증을 쓰지 않는다**는 주석성 설명을 `_comment` 관례에 맞춰 곁들인다).
다른 3대(`real-camera-1/2`, `simulator-1`)는 **건드리지 않는다**.

**검증**:
- (모킹) 정정된 `config.json` 을 `normalizeConfig` 에 통과 → `simulator-2.kind === 'park3d-rpc'`, `camId === 1`, `streamUrl` 이 `/stream` 으로 끝난다
- (모킹) `streamTransportFor(simulator-2.streamUrl) === 'http-mjpeg'`
- (**실기 — 라이브 서버 필요**) 서비스 기동 → 옵션 화면에서 `simulator-2` 「연결 테스트」 → `✅ 연결 성공 · PTZ P 4150 / T 2010 / Z 158` 형태(현재 값에 따라 숫자는 다름). 404 문구가 사라진다. **환경변수·토큰을 아무것도 설정하지 않은 상태에서 성공해야 한다**(D2')
- (**실기**) 제어 화면에서 PTZ 이동 1회 → 화면의 pan/tilt 가 목표 근방으로 바뀐다 (가정 B 확인)
- (**실기**) 영상 탭에서 `/stream` MJPEG 가 재생된다 (무인증 스트림 확인)

---

### 5단계 — 웹 UI 포트짝 경고 오탐 제거
**파일**: `SettingMain/web/options.js` (78~105행)

`portPairWarning` 은 "UE 시뮬은 영상 포트 = 제어 포트 + 10" 규칙이다. Park3D 는 **제어와 영상이 같은 포트(13510)** 이므로
`simulator-2` 에서 항상 `⚠ 제어 13510 의 영상 포트는 13520 입니다` 라는 **거짓 경고**가 뜬다.

- `applyStreamHint()` 가 `selected()?.kind` 를 읽어 `portPairWarning(controlUrl, streamUrl, kind)` 로 넘긴다.
  `kind === 'park3d-rpc'` 면 `portPairWarning` 은 즉시 `''` 를 반환한다. **다른 kind 의 기존 경고 로직은 한 줄도 바꾸지 않는다.**
- 같은 함수의 http 안내 문구 `"(UE 시뮬 직결 포트 = 제어 포트 + 10)"` 도 park3d-rpc 에서는 오해를 부르므로
  이 kind 에서만 `"(Park3D 는 같은 포트의 /stream 을 중계합니다)"` 로 바꾼다.
- **kind 입력칸을 추가하지 않는다** — `test/optionsDiscoveryBackendCoreUi.test.ts` 가 `id="fieldKind"`·`$('fieldKind')` 부재를 검사한다.
  카메라의 `kind` 는 이미 `/api/settings` 응답(`toPublicCamera`)에 실려 `state.cameras` 에 들어 있다. **새 API 배선은 필요 없다.**

**검증 (모킹, 소스 스캔 방식)** — `test/optionsPark3dUi.test.ts` 신규(기존 `optionsDiscoveryBackendCoreUi.test.ts` 의 소스 문자열 검사 패턴을 따른다):
1. `options.js` 소스에 `'park3d-rpc'` 조기 반환이 존재하고, `portPairWarning` 호출이 kind 를 넘긴다
2. `options.js` 에 `id="fieldKind"`/`$('fieldKind')` 가 여전히 **없다**(기존 테스트도 그린 유지)
3. 가능하면 `portPairWarning` 을 그대로 평가해 `('http://h:13510','http://h:13510/stream','park3d-rpc') → ''`,
   `('http://h:8081','http://h:8091','hucoms') → ''`, `('http://h:8081','http://h:8095','hucoms') → 경고 문자열` 을 확인한다
   (모듈 최상단이 `./api.js` 를 import 하므로 직접 import 가 어려우면 1·2번의 소스 검사로 대체하고, 그 한계를 테스트 주석에 남긴다)

---

### 6단계 — 영향 없음을 **확인하고 기록**(코드 변경 없음)

이 단계는 "고치지 않는다"를 근거와 함께 확정하는 단계다. 구현자는 코드를 만지지 말고 검증만 한다.

| 대상 | 결론 | 근거 |
|---|---|---|
| `src/media/frameSource.ts` | **드라이버와 무관.** `streamUrl` 이 `http://` 면 `streamTransportFor` → `http-mjpeg` 로 MJPEG 를 그대로 중계하고, 드라이버는 **스냅샷 폴링(`snapshot-poll`) 경로에서만** 쓰인다(`createFrameSource` 42-44행). `simulator-2` 는 `/stream` 이 있으므로 폴링을 타지 않는다. `getSnapshot()` 은 `GET /api/snapshot` 과, streamUrl 을 비웠을 때의 폴백에서만 쓰인다 | `src/media/frameSource.ts:20-45,145-153` |
| `src/media/httpMjpeg.ts` | **변경 불필요(2판 확정).** `/stream` 이 무인증 200 이므로 커스텀 헤더가 필요 없다. `simulator-2` 는 username 이 비어 `authenticatedHttpUrl` 이 쿼리도 붙이지 않는다 — 있는 그대로 GET 한다 | `src/media/httpMjpeg.ts:21-35`, 리더 실측 |
| `src/mcp/routeCatalog.ts` | **갱신 대상 아님.** 라우트를 새로 만들지 않는다. 이 카탈로그는 **라우트** 카탈로그이고 `test/mcpServer.test.ts:15-24` 가 `src/api/routes/*.ts` 의 선언 경로만 스캔한다 | `src/mcp/routeCatalog.ts:1-13`, `test/mcpServer.test.ts` |
| `src/api/routes/devicePresetRoutes.ts` | **변경 불필요.** `camera.kind !== 'hucoms'` → 501 이므로 park3d-rpc 는 자동 배제 | 23·34행 |
| `src/core/local/localCoreProvider.ts` | **변경 불필요.** `typeof driver.centerPoint === 'function'` 판정이라 `centerPoint` 미구현이 곧 `center: ok:false` | 53-54, 72-73행 |
| `src/domain/ptz.ts`, PTZ 라우트, `web/control.js` | **불변.** raw 계약을 유지한다(D1) | — |

**검증 (모킹)**:
1. `test/mcpServer.test.ts` 그린 유지(카탈로그 미변경으로도 통과)
2. park3d-rpc 카메라로 `GET /api/device-preset-capability` → 501
3. park3d-rpc 카메라로 `GET /api/core/capabilities` → `center.ok === false`, 사유 문구 포함
4. `npm run test` 전체 그린 — **2판 기준 기존 테스트 파일은 `test/normalize.test.ts` 보강 외에 수정하지 않는다.**
   특히 `test/server.test.ts` 는 한 줄도 바뀌지 않아야 한다. 여기서 red 가 나면 전부 **회귀**다

---

## 영향 받는 파일/모듈

**신규**
- `SettingMain/src/devices/park3d/park3dRpcClient.ts`
- `SettingMain/test/park3dRpcClient.test.ts`
- `SettingMain/test/optionsPark3dUi.test.ts`

**수정**
- `SettingMain/src/config/types.ts` — `CameraKind` 확장, `camId?` 추가 (**`token?` 없음**, `PublicCamera` 불변)
- `SettingMain/src/config/normalize.ts` — `CAMERA_KINDS`, `normalizeCamera`(`camId`) (**`toPublicCamera`·`mergeSettings` 불변**)
- `SettingMain/src/devices/driverFactory.ts` — `case 'park3d-rpc'`
- `SettingMain/config/config.json` — `simulator-2` 정정
- `SettingMain/config/config.example.json` — park3d-rpc 예시 추가
- `SettingMain/web/options.js` — `portPairWarning` kind 게이트 + 힌트 문구
- `SettingMain/test/normalize.test.ts` — 신규 필드 케이스 보강

**확인만 (변경 없음)**: `src/media/frameSource.ts`, `src/media/httpMjpeg.ts`, `src/mcp/routeCatalog.ts`, `src/api/routes/devicePresetRoutes.ts`, `src/core/local/localCoreProvider.ts`, `src/domain/ptz.ts`, **`test/server.test.ts`**

**문서화(documenter)에게 전달할 요지**
- zoom raw 의 의미는 **기기 종류마다 다르다**: Hucoms 는 0~65535 의 **불투명 raw**(`src/domain/ptz.ts:4-11`), park3d-rpc 는 **배율×100**(100=1.0배, 3600=36배). 같은 화면의 같은 숫자칸이 기기에 따라 다른 뜻이라는 점을 반드시 명시할 것.
- pan/tilt 는 두 종류 모두 centi-deg 로 일치하므로 `toView` 의 도 표시는 park3d-rpc 에서도 정확하다.
- **park3d-rpc 는 인증을 쓰지 않는다** — 서버가 무인증으로 열려 있다는 실측 근거(§D2')와, 서버가 나중에 인증을 켜면 401/403 이 드라이버 오류로 즉시 드러난다는 점을 함께 적을 것. 형제 프로젝트 `SettingAgent` 는 `X-Park3D-Token` 을 배선하고 있으므로 **두 프로젝트의 차이**임을 명시해야 오해가 없다.
- `camId` 는 1-based이며 park3d-rpc 카메라에 필수다(없으면 400).

---

## 비범위 (하지 않을 것)

- `PtzRaw`·`clampPtz`·`toView`·PTZ 라우트·`web/control.js` 수정 (D1 — 변환은 드라이버에 가둔다)
- `ZOOM_RANGE` 를 park3d 기준으로 바꾸기 (Hucoms 를 깨뜨린다. zoom 100~3600 클램프는 **드라이버 내부**에만 둔다)
- `centerPoint` 를 park3d-rpc 에 지어내 구현하기 (선택 메서드다. 계약 없음)
- 카메라 2번(`camId:2`) 등록 (D3)
- **인증 배선 일체** — `token` 설정 필드, `PARK3D_RPC_TOKEN` 환경변수 폴백, `X-Park3D-Token` 헤더, `hasToken` 공개 필드, 토큰 마스킹 로직 (D2' — 서버가 무인증이다. 지금 없는 인증을 미리 만들지 않는다)
- 옵션 화면에 kind·camId **입력칸 추가** (기존 테스트가 kind 필드를 금지. camId 는 `config.json` 직접 편집)
- `cam.list` 로 카메라 자동 발견 / `/rpc/catalog` 79개 메서드의 범용 노출 (요청 범위 밖 — 지금 필요한 것은 드라이버 1종)
- MCP 라우트 카탈로그 갱신·신규 REST 라우트 추가 (6단계에서 불필요함을 확인)
- 프리셋·캘리브레이션·`preset.*` RPC 연동 (별도 과제)
- ~~`/stream` 토큰 인증 대응~~ → **해당 사항 없음.** 2판 실측으로 `/stream` 이 무인증 200 임이 확정됐다
