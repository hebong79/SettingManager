# 02 구현 결과 — Park3D RPC 카메라 드라이버(`kind: "park3d-rpc"`)

- 작성: 구현자(developer)
- 입력: `_workspace/01_architect_plan.md` **2판** + 리더 지시(설계서보다 우선)
- 범위: 설계서 1~6단계 전부

---

## 리더 지시 반영 (설계서와 다른 점)

| # | 지시 | 반영 |
|---|---|---|
| 1 | `label` 변경 취소 | `config.json` 의 `simulator-2.label` 은 **`"UE-시뮬2"` 그대로**. 설계서 4단계의 `"Park3D 시뮬2 (RPC)"` 로의 변경은 **하지 않았다**. 바꾼 것은 `kind`·`streamUrl`·`camId` 셋뿐 |
| 2 | 컴파일 확인은 필수 | `npm run typecheck` 통과 확인(아래 실행 결과) |
| 3 | 기존 red 1건은 범위 밖 | `test/powershellSafeDiagnostic.test.ts` 는 **손대지 않았다** |
| 4 | 금지 파일 불가침 | `test/server.test.ts`·`toPublicCamera`·`mergeSettings`·`src/domain/ptz.ts`·PTZ 라우트·`web/control.js` **한 줄도 변경 없음** |
| 5 | 인증 코드 전면 금지 | `token` 필드·`PARK3D_RPC_TOKEN`·`X-Park3D-Token` 어디에도 **없음**. 오히려 "되살아나지 않는다"를 테스트로 고정 |

---

## 파일별 변경 요약

### 신규

**`SettingMain/src/devices/park3d/park3dRpcClient.ts`** — Park3D JSON-RPC 드라이버(설계 1단계)

- `implements CameraDriver`, `readonly kind = 'park3d-rpc'`
- 옵션: `{ cameraId, baseUrl, camId?, timeoutMs, fetchImpl? }` — **token 필드 없음**
- `callRpc(method, params)` (private): `POST {baseUrl}/rpc`, 본문 `{jsonrpc:'2.0', id:1, method, params}`,
  헤더는 `content-type: application/json` **하나뿐**, 타임아웃은 `AbortSignal.timeout(timeoutMs)`.
  본문을 `text()` 로 **1회만** 읽고 분기 순서를 설계대로 지켰다:
  ① JSON 파싱 실패 → 원문 200자 → ② `body.error` → `Park3D RPC 오류 [code]: message` → ③ `!res.ok` → `HTTP {status}` + 원문 200자 → ④ `body.result`.
  순서가 뒤집히면 404 본문이 `result: undefined` 로 조용히 통과해 먼 곳에서 TypeError 로 터진다(형제 프로젝트 사고 기록).
- `getPtz()`: `cam.getPTZ {camId}` → `pan/tilt/zoom`(도·배율 실수) → `Math.round(v*100)` 으로 raw 환산.
  세 값 중 하나라도 `typeof !== 'number'` 이거나 유한수가 아니면 `CameraDriverError`(조용한 0 폴백 금지).
- `goPtz(target, _speed?)`: `clampPtz(target)` → zoom raw 만 **100~3600 자체 클램프** → `/100` 해서 `cam.setPTZ {camId,pan,tilt,zoom}`.
  `speed` 는 **무시**(Park3D 계약에 속도 파라미터 없음 — 주석 명시).
- `getSnapshot()`: `cam.captureJPG {camId}` → `img_bytes` base64 디코드 → **JPEG SOI(`FF D8`) 검증**.
- `listSlots()` → `[]`. `centerPoint` 는 **구현하지 않음**(속성 자체가 없다).
- `requireCamId()`: 양의 정수가 아니면 **400** 으로 던지고 `fetch` 를 부르지 않는다.
- 마스킹 로직 없음(감출 비밀이 없다). 오류 문구에는 `url`·`method`·서버 원문 200자만 싣는다.

**`SettingMain/test/park3dRpcClient.test.ts`** — 모킹 유닛테스트 20건.
설계 1단계 검증 1~11 전부 + `createDriver` 분기(2단계 검증 2) + LocalCore `center` 능력 자동 미지원(6단계 검증 3).
모킹 응답은 리더 실측 원문 `{"result":{"pan":41.5,"tilt":20.100000381469727,"zoom":1.5799099206924438}}` 을 상수로 박아 두고 근거를 파일 머리 주석에 남겼다.

**`SettingMain/test/optionsPark3dUi.test.ts`** — 옵션 UI 검사 5건.
`web/options.js` 는 브라우저 모듈이라 통째로 import 할 수 없어, 소스 문자열 검사(기존 `optionsDiscoveryBackendCoreUi.test.ts` 패턴)에 더해
**순수 함수 `portPairWarning` 의 본문만 떼어 `new Function` 으로 실제 평가**했다(설계 5단계 검증 3의 "가능하면" 조건을 충족).
문자열 존재만 보면 조건이 뒤집혀 있어도 통과하기 때문이다.

### 수정

| 파일 | 변경 |
|---|---|
| `src/config/types.ts` | `CameraKind` 에 `'park3d-rpc'` 추가 + 주석(Hucoms CGI 가 아님). `CameraConfig.camId?: number`(1-based) 추가. `PublicCamera`·`CameraPatch` 정의는 불변 |
| `src/config/normalize.ts` | `CAMERA_KINDS` 에 `'park3d-rpc'` 추가. `positiveInt()` 헬퍼 신설 후 `normalizeCamera` 가 **유효할 때만** `camId` 를 싣는다(스프레드 조건부). `toPublicCamera`·`mergeSettings` **불변** |
| `src/devices/driverFactory.ts` | `import { Park3DRpcClient }` + `case 'park3d-rpc'`. `token` 은 넘기지 않는다(필드가 없다) |
| `config/config.json` | `simulator-2`: `kind` → `park3d-rpc`, `streamUrl` → `.../stream`, `camId: 1` 추가. **`label`·`controlUrl` 그대로**. 다른 3대 불변 |
| `config/config.example.json` | `park3d-rpc` 예시 1건 추가(`_comment` 로 무인증·같은 포트·camId 1-based 설명). 기존 3건 불변 |
| `web/options.js` | `portPairWarning(controlUrl, streamUrl, kind)` 3번째 인자 + `kind === 'park3d-rpc'` 조기 반환. `applyStreamHint()` 가 `selected()?.kind` 를 읽어 넘기고, http 안내 문구를 이 kind 에서만 교체. **다른 kind 의 경고 로직은 불변** |
| `test/normalize.test.ts` | `describe('park3d-rpc 카메라')` 7건 추가. 기존 테스트는 불변 |

---

## 설계와 달라진 점과 사유

1. **`label` 유지** — 리더 지시 1(CLAUDE.md 3항). 위 표 참조.
2. **설계 3단계 검증 5·6(`PUT /api/settings` 왕복, `/api/settings` 응답의 `camId`)을 HTTP 대신 순수 계층에서 검증** —
   해당 검증은 `test/server.test.ts` 의 하네스가 필요한데 그 파일은 불가침이다. 대신 같은 경계를
   `mergeSettings`(저장 왕복에서 `kind`·`camId` 유지)와 `toPublicCamera`(값이 있는 카메라에만 `camId` 노출, 없으면 키 없음)로 `test/normalize.test.ts` 에서 검사했다.
   **키 집합 회귀 여부는 `test/server.test.ts:154` 가 이미 그대로 지키고 있고, 실행 결과 그린이다.**
3. **설계 4단계의 모킹 검증(정정된 `config.json` → `normalizeConfig`, `streamTransportFor`)을 커밋된 테스트로 만들지 않았다** —
   `config.json` 은 `.gitignore` 대상이라 이를 읽는 테스트는 다른 사람의 클론에서 ENOENT 로 깨진다.
   대신 **일회성 스크립트로 실제 실행해 확인**했다(아래 실행 결과). `streamTransportFor` 의 `http://` → `http-mjpeg` 규칙 자체는 `test/stream.test.ts` 가 이미 덮는다.
4. **설계 6단계 검증 2(`GET /api/device-preset-capability` → 501)는 테스트를 만들지 않았다** —
   서버 하네스가 필요하고 그 파일이 불가침이다. 코드상 근거는 `src/api/routes/devicePresetRoutes.ts:23,34` 의 `camera.kind !== 'hucoms'` 가드이며,
   `park3d-rpc` 는 여기에 걸려 자동으로 501 이 된다(코드 변경 없음). **qa-tester 가 필요하다고 보면 이 항목만 별도 파일로 추가해 달라.**

---

## 확인 필요 항목의 해소

| 설계서 항목 | 결과 |
|---|---|
| `cam.captureJPG` 의 base64 가 `data:` 접두 없는 순수 base64인가 | **해소.** 실기 읽기 호출로 99,237 바이트 디코드 성공, 첫 두 바이트 `ff d8`. 순수 base64가 맞다 |
| zoom raw 100~3600 을 서버가 어떻게 다루는가 | **미해소(유지).** 확인하려면 `cam.setPTZ` 로 카메라를 움직여야 한다 — 지시대로 호출하지 않았다. 드라이버는 자체 클램프만 하고 서버 거부는 그대로 전달한다 |
| 가정 B (`cam.setPTZ` 파라미터·응답) | **미확인(유지).** 실기 이동은 리더가 사용자 승인 아래 수행 |

---

## 검증자(qa-tester)가 알아야 할 경계면

```ts
// src/devices/park3d/park3dRpcClient.ts
export interface Park3DRpcClientOptions {
  cameraId: string; baseUrl: string; camId?: number; timeoutMs: number; fetchImpl?: typeof fetch;
}
class Park3DRpcClient implements CameraDriver {
  readonly kind = 'park3d-rpc';
  getPtz(): Promise<PtzRaw>;                       // raw 정수 (pan/tilt centi-deg, zoom 배율×100)
  goPtz(target: PtzRaw, _speed?: number): Promise<void>;  // speed 무시
  getSnapshot(): Promise<Buffer>;
  listSlots(): Promise<Slot[]>;                    // 항상 []
  // centerPoint 없음 (속성 자체가 없다)
}
```

- **전송 형태**: `POST {baseUrl}/rpc`, headers `{'content-type':'application/json'}` **단 하나**, body `{jsonrpc:'2.0', id:1, method, params}`.
- **오류**: 전부 `CameraDriverError`. 연결 실패 `502`, `camId` 미설정 `400`, 나머지(RPC error 봉투·non-2xx·파싱 실패) 기본 `502`.
- **환산**: `4150 ↔ 41.5°`, `2010 ↔ 20.1°`, `158 ↔ 1.58배`. zoom raw 클램프 `[100, 3600]` 은 **드라이버 내부에만** 있다(공유 `ZOOM_RANGE` 불변).
- **설정 스키마**: `camId` 는 선택 필드이고 **유효한 양의 정수일 때만 객체에 존재**한다. 없는 카메라에는 키 자체가 없으므로 `server.test.ts:154` 의 키 집합은 그대로다.

---

## 실행한 명령과 결과

```
$ cd SettingMain && npm run typecheck
> tsc -p tsconfig.json --noEmit
(오류 없음 — 통과)

$ npx vitest run
Test Files  1 failed | 21 passed (22)
     Tests  1 failed | 325 passed (326)
```

- **착수 전 기준선(리더 실측): 291 pass / 1 fail** → **현재: 325 pass / 1 fail**. 신규 34건 그린, **회귀 0건**.
- 유일한 red 는 기준선과 **동일한** `test/powershellSafeDiagnostic.test.ts`(없는 파일 `scripts/test-settingmanager-safe.ps1` 을 읽음). 지시대로 손대지 않았다.
- 최종 판정은 qa-tester 소관이다 — 위 수치는 구현자의 자기 점검이다.

### 설계 4단계 모킹 검증 (일회성 스크립트, 임시 디렉토리)

```
normalizeConfig(config.json).simulator-2 =
  {"id":"simulator-2","label":"UE-시뮬2","kind":"park3d-rpc",
   "controlUrl":"http://192.168.0.125:13510","username":"","password":"",
   "streamUrl":"http://192.168.0.125:13510/stream","timeoutMs":5000,"camId":1}
streamTransportFor(streamUrl) = http-mjpeg
config.example.json = real-camera-1:hucoms:-, real-camera-2:hucoms:-, simulator-1:hucoms:-, simulator-2:park3d-rpc:1
```

### 실기 **읽기 전용** 확인 (`http://192.168.0.125:13510`, 환경변수·토큰 아무것도 설정하지 않은 상태)

```
getPtz(raw)    = {"pan":4150,"tilt":2010,"zoom":158}     ← 리더 실측(41.5 / 20.1 / 1.58)과 정확히 일치
getSnapshot()  = 99237 bytes, SOI = ffd8                  ← cam.captureJPG 실동작 확인
GET /health    = 200
```

**`cam.setPTZ` 는 호출하지 않았다** — 카메라를 움직이는 확인은 리더가 사용자 승인 아래 별도로 수행한다.

---

## 문서화(documenter)에게 넘길 비자명한 결정

1. **zoom raw 의 의미가 기기마다 다르다.** Hucoms 는 0~65535 불투명 raw, park3d-rpc 는 **배율×100**(100=1.0배, 3600=36배).
   화면의 같은 숫자칸이 기기에 따라 다른 뜻이라는 점을 반드시 명시해야 한다. pan/tilt 는 두 종류 모두 centi-deg 라 도 표시가 그대로 맞는다.
2. **인증을 쓰지 않는다.** 형제 프로젝트 `SettingAgent` 는 `X-Park3D-Token` 을 배선하지만 이 프로젝트는 하지 않는다 — 서버가 무인증으로 열려 있음이 실측으로 확정됐기 때문이다.
   서버가 나중에 인증을 켜면 `!res.ok` 분기가 `HTTP 401` + 서버 본문을 실은 오류로 즉시 드러내므로 조용히 실패하지 않는다.
3. **`speed` 를 무시한다.** Park3D `cam.setPTZ` 계약에 속도 파라미터가 없다. 지어 보내면 서버가 조용히 버려 "속도를 줬는데 왜 안 먹지"가 된다.
4. **`camId` 없으면 400.** 임의로 1번을 쓰지 않는다 — 엉뚱한 카메라를 움직이는 사고는 화면에 아무 흔적도 남기지 않는다.
5. **웹 UI 포트짝 경고의 게이트.** "영상 포트 = 제어 포트 + 10" 은 UE 시뮬(hucoms) 규칙이다. Park3D 는 같은 포트의 `/stream` 이라 게이트가 없으면 정상 설정에 항상 거짓 경고가 뜨고, 그러면 **진짜 경고까지 무시하게 된다**.
