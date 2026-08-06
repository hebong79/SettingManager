# 01 설계 — IDIS WebAPI v2.20 카메라 드라이버 신설

작성 2026-08-06 · 대상 저장소 `d:/Work/Parking3D/Agent/baro/SettingManager`

## 표기 규약 (이 문서 전체에 적용)

이 문서의 모든 사실에는 근거 표시가 붙는다. 표시가 없으면 그것은 설계 판단이다.

| 표시 | 뜻 |
|---|---|
| `[매뉴얼 §N:행]` | IDIS WebAPI v2.20 원문. 행 번호는 평문 추출본 `baro_calory/reference/_idis_extracted.txt` 기준 |
| `[실측]` | 실기에서 잰 것. 기기·일자를 함께 적는다. **매뉴얼과 충돌하면 이쪽이 이긴다** |
| `[참조구현]` | `baro_calory/packages/cctv-client/src/*.mjs` 의 코드·주석 |
| `[본체]` | SettingMain 현재 코드 |
| `[미확인]` | 아직 아무 근거도 없다. 추측으로 메우지 않는다 |

---

## 범위

`SettingMain/src/devices/idis/` 에 IDIS WebAPI v2.20 카메라 드라이버를 **폴더째 복사 가능한
self-contained 서브트리**로 신설하고, 기존 `CameraDriver` 계약(요구사항 2)에 `kind: 'idis'`
로 배선한다.

**하는 것**

1. IDIS 서브트리 8파일(자체 Digest·요청별 TLS·마감 타이머·좌표변환·응답판정·상수).
2. `CameraKind` 유니온에 `'idis'` 추가와 그것이 건드리는 전 지점(§5).
3. DB `camera_info.kind` CHECK 제약 확장과 낡은 파일 감지 가드.
4. 목(mock) 서버·픽스처 기반 vitest 스위트. 실기는 없다.

**하지 않는 것은 「비범위」 절에 모았다.**

---

## 가정 / 확인 필요

### 이미 확정된 것 (재론하지 않음)

- **배치**: `SettingMain/src/devices/idis/` self-contained 서브트리. 별도 `package.json`
  없음. `../cameraDriver.js`·`../../domain/ptz.js` 계약 타입 import 만 허용.
- **centerPoint**: `ptzMoveToPoint` 프로브 후 폴백. 없으면 501 거절. 소프트웨어 센터링 없음.

### 이번 조사에서 **해소된** 숙제

> **숙제였던 것**: 추출본 8116/8121행의 `setPreset`/`moveToPreset` 표기가 §50 의
> `set|moveTo|remove` 와 충돌한다. 어느 쪽이 어느 모델 그룹인가?

**해소됨 — 모델 그룹 차이가 아니라 매뉴얼의 복붙 오류다.**

- 8116/8121행은 **§51 "PTZ Scan Command"** 의 Example 블록 안에 있다 `[매뉴얼 §51:8010~8125]`.
- 그런데 §51 자신의 Send Parameters 표는 `action=ptzScan`, `command=set|remove|run|stop`,
  파라미터 `scanName/startPreset/endPreset/dwellTime/speed/direction` 을 선언한다
  `[매뉴얼 §51:8069~8107]`. 즉 **§51 의 예시가 §51 의 표와도 맞지 않는다.**
- 그 예시는 §50 의 예시 `[매뉴얼 §50:7996,8001]` 와 문장이 거의 같고 `command` 값에만
  `Preset` 이 덧붙어 있다 — §50 예시를 §51 로 복사하다 생긴 오타로 읽는 것이 유일하게
  일관된 해석이다.
- **모델 그룹 가설은 원문이 부정한다.** 이 매뉴얼은 적용 제한이 있는 절에 제목으로 명시한다
  (`49. PTZ Command – TCP ( for model group 1 & model group 2 only )` `[매뉴얼 목차:227]`,
  `24. Video – Snapshot (group 5,6)` `[매뉴얼 목차:144]`, `67~69. Fisheye (…only)`).
  **§50·§51 에는 그런 제한이 없다** `[매뉴얼 목차:63~302]`. 문서 전체에 `NVR`·
  `Network Camera` 같은 제품군 챕터 분리도 없다.

**결정: `action=ptzPreset` + `command=set|moveTo|remove` 를 정본으로 쓴다**
`[매뉴얼 §50:7976~8004]`. 이는 `[실측]` 과도 일치한다 — DC-S6261XT 에서 `moveTo`/`set` 이
동작했다 `[참조구현 idis-camera-client.mjs:244,248]`.

**폴백은 두지 않는다.** 근거: ① 정본 표기가 매뉴얼 표와 실측 양쪽에서 확인됐다,
② `setPreset` 은 어느 파라미터 표에도 없는 값이라 이것을 받는 펌웨어가 존재한다는 근거가
하나도 없다(`[미확인]`), ③ CLAUDE.md 2번(추측성 코드 금지). 대신 `idisConstants.ts` 에
이 조사 결과를 주석으로 남겨, 다음 사람이 8116행을 보고 다시 흔들리지 않게 한다.

### 이번 조사에서 **정정된** 기존 기록

`baro_calory/docs/cameras.md:97` 은 "매뉴얼에는 인증 방식 언급이 없어 실측으로만 알 수
있다"고 적고 있으나, **원문에 있다**:

> `5. The API is based on the standard HTTP Authentication. (refer RFC2617 )` `[매뉴얼 §0:317]`

RFC2617 은 Basic 과 Digest 둘 다이므로 "**Digest 만** 받고 Basic 은 401" 이라는 좁힘은
여전히 `[실측]` 이다(DC-S6261XT). 설계에는 영향이 없다 — 챌린지를 읽어 방식을 고르는
`[참조구현 http-transport.mjs:96~113]` 방식이 두 서술 모두를 만족한다. 기록만 정정한다.

### 확인 필요 (사용자 판단)

| # | 사안 | 기본안(승인 없으면 이대로 간다) |
|---|---|---|
| 1 | `insecureTls`·`streamIndex` 를 `CameraConfig` + DB 열로 올릴 것인가 | **올리지 않는다.** 드라이버 옵션으로만 존재하고 SettingMain 은 기본값(`insecureTls:false`, `streamIndex:1`)을 넘긴다. 근거: 실측기는 평문 HTTP(80)이고 `streamIndex=1` 이 동작한다 `[실측 DC-S6261XT]`. 자체서명 HTTPS 기기를 만나기 전에 열을 만드는 것은 추측성 코드다(CLAUDE.md 2번). `controlUrl` 이 이미 스킴을 싣고 있어 `scheme` 필드는 **어느 안에서도 불필요하다** |
| 2 | 낡은 CHECK 를 가진 DB 파일 처리 (§5-C) | **감지 후 명시적 오류.** 표 재작성(12-step rebuild)은 하지 않는다 |
| 3 | 장비 프리셋 라우트(`/api/cameras/:id/device-presets`)를 IDIS 로 넓힐 것인가 | **이번 범위 밖.** 501 유지. 근거는 §비범위 1번 |
| 4 | 줌 눈금 차이로 생기는 `/api/ptz/absolute` 의 `limited` 부정확·`nudge` 델타 부적합 (§비범위 2번) | **이번 범위 밖.** 기기별 도달범위 도입은 별건 |
| 5 | 실기(IDIS 카메라) 확보 시점 | 이 계획의 모든 검증은 목 서버 기반이다. 실기로만 닫히는 항목을 §7-실기 미검증 목록에 모았다 |

---

## 1. 모듈 파일 분해

```
SettingMain/src/devices/idis/
├── README.md            폴더째 복사 안내 · 근거 대장 (문서)
├── contract.ts          계약 타입 재수출 한 겹 — 외부 의존은 이 파일에만    ~25줄
├── idisConstants.ts     CGI 경로 · 액션 카탈로그 · Return Code 전표 · 와이어 범위  ~90줄
├── digest.ts            RFC2617 Digest/Basic 헤더 생성 (순수, cnonce 주입)  ~55줄
├── idisTransport.ts     node:http(s) · 요청별 TLS · 마감 타이머 · 401 재시도  ~120줄
├── idisReply.ts         `returnCode=…` 파싱 + 응답 분류 (순수)              ~95줄
├── idisCoords.ts        계약↔와이어 좌표 변환 + 사전 클램프 (순수)          ~75줄
├── idisCamera.ts        IdisCameraClient — CameraDriver 구현 + 원본 액션 통로 ~260줄
└── index.ts             공개 표면 (배럴)                                    ~15줄
                                                                    합계 ~735줄
```

### 파일별 단일 책임

**`contract.ts` — 외부 의존을 한 파일에 가둔다**

```
export type { CameraDriver, CenterPoint, Slot } from '../cameraDriver.js';
export { CameraDriverError } from '../cameraDriver.js';
export type { PtzRaw } from '../../domain/ptz.js';
```

서브트리의 **다른 모든 파일은 `./contract.js` 만 import 한다.** 판단 근거:

1. **복사 비용이 상수가 된다.** 다른 프로젝트로 폴더째 옮길 때 고칠 파일이 정확히 1개다.
   재수출 한 겹이 없으면 7개 파일의 import 경로를 각각 고쳐야 하고, 하나 빠뜨리면
   빌드가 아니라 런타임(`ERR_MODULE_NOT_FOUND`)에서 터진다.
2. **격리를 기계로 증명할 수 있다.** "`contract.ts` 외의 파일에 `../` 로 시작하는 import 가
   없다"가 한 줄 테스트가 된다(§7 T-ISO). 규약을 사람의 주의력에 맡기지 않는다.
3. **런타임 값 의존은 딱 하나다.** `CameraDriverError` 는 클래스(런타임 값)이고 나머지
   4개는 타입뿐이다. 즉 이 서브트리가 SettingMain 런타임에 실제로 매달린 지점은
   **오류 클래스 하나**이며, 복사 시 그 자리에 등가 클래스만 넣어 주면 된다. 이 사실을
   README 에 적는다.

> **`domain/ptz.js` 의 `clampPtz`·`wrapPan` 은 쓰지 않는다.** 그쪽은 **계약 범위**
> (tilt −2000..9000, zoom 0..65535)로 자르는데, IDIS 에 보내기 전 잘라야 하는 것은
> **이 기기의 와이어 범위**다(§2). 계약 상수로 자르면 `absZoom=65535` 가 그대로 나가고
> 기기가 조용히 1200 으로 클램프한다 `[실측]`. 그래서 서브트리는 자기 클램프를 갖는다 —
> `PtzRaw` **타입만** 빌려 온다(런타임 결합 0).

**`idisConstants.ts` — "꼼꼼하게"(요구사항 1)를 여기서 갚는다**

- `CGI_PATH = '/cgi-bin/webSetup.cgi'` `[매뉴얼 §2:425]`
- `MODE = { WRITE: 0, READ: 1, TEST: 2, SECURED_WRITE: 5, SECURED_READ: 6, SECURED_TEST: 7 }`
  `[매뉴얼 §74:9877~9890]` — **`mode=9000` 은 System Restart 다**. `returnCode=9000`
  (Unknown API)과 **다른 네임스페이스**이며 이 둘을 섞으면 "미구현 판정"을 하려다
  카메라를 재부팅시킬 수 있다. 상수 이름과 주석으로 못 박는다.
- `RETURN_CODES` — §75 전표(§4에 전문 수록) `[매뉴얼 §75:9898~9976]`
- `ACTION_CATALOG` — 매뉴얼 목차 §0~§79 전 절 이름 `[매뉴얼 목차:63~302]`. **감싸지 않고
  이름만 싣는다.** 쓰지 않을 액션까지 래퍼를 만들면 거대 SDK 가 되지만(CLAUDE.md 2번),
  목록조차 없으면 다음 사람이 매뉴얼을 처음부터 다시 읽는다.
- `WIRE_RANGE` — `[매뉴얼 §56]` 선언 범위와 `[실측]` 도달 범위를 **따로** 담는다(§3).
- `MOVE_COMMANDS` — `[매뉴얼 §48:7805~7844]` 의 22개 전부.

**`digest.ts` — 순수 함수. 결정적 테스트를 위한 주입 지점이 여기다**

```
buildDigestHeader({ header, method, uri, username, password, nc = '00000001', cnonce = <random> })
buildBasicHeader({ username, password })
```

`cnonce` 와 `nc` 를 **인자로 받고 기본값만 난수**다. 참조구현은 `randomBytes(8)` 을 함수
안에서 직접 부르는데 `[참조구현 http-transport.mjs:34]`, 그러면 헤더 생성을 결정적으로
검증할 수 없다(요구사항 7). `nonce`·`realm`·`qop`·`opaque` 는 챌린지 문자열에서 읽으므로
테스트가 챌린지를 고정하면 나머지도 고정된다. 지원 범위는 `algorithm=MD5` + `qop=auth`
`[실측 realm="WEB SERVER", qop=auth, MD5]`. `MD5-sess`·`SHA-256` 은 만나면 넓힌다(현재
`[미확인]`).

**`idisTransport.ts` — 세 사고의 결론이 모인 자리** `[참조구현 http-transport.mjs:1~17]`

1. `fetch` 가 아니라 `node:http`/`node:https`. 이유는 **요청별 TLS 옵션**이다. Node 의
   `fetch` 는 이것을 받지 못해 유일한 우회가 프로세스 전역
   `NODE_TLS_REJECT_UNAUTHORIZED` 이고, 그건 프로세스 전체의 검증을 끈다.
2. **마감은 명시적 `setTimeout`.** `req.setTimeout` 은 소켓 *유휴* 타임아웃이라 TCP 연결
   수립 중에는 걸리지 않는다 — 도달 불가 주소에서 설정값과 무관하게 OS 기본(실측 5초)까지
   붙잡히면서 오류 메시지는 설정값이 지난 것처럼 거짓말했다 `[실측]`.
3. **전송 실패에는 `transport: true` 표식을 달고 던진다.** 능력 프로브가 "기기에 못 닿았다"를
   "그 기능이 없다"로 기록하면 멀쩡한 카메라가 영구히 불구로 저장된다 — 실기에서 실제로
   발생했다 `[실측]`.

여기에 SettingMain 관례를 더한다: **비밀번호 마스킹**(`[본체 hucomsClient.ts:115~119]`,
`[본체 hucomsPresetClient.ts:125~131]`)과 **응답 본문 상한**
(`MAX_RESPONSE_BYTES`, `[본체 hucomsPresetClient.ts:8]`). 다만 스냅샷은 JPEG 바이너리라
상한을 따로 둔다(텍스트 64KiB / 이미지 8MiB).

**`idisReply.ts` — "이 응답을 믿어도 되는가"의 단일 판정소** (§4에 전체 규칙)

**`idisCoords.ts` — 계약↔와이어 변환과 사전 클램프** (§2에 전체 표)

**`idisCamera.ts` — `IdisCameraClient`**

- `CameraDriver` 구현: `cameraId` · `kind='idis'` · `getPtz` · `goPtz` · `centerPoint` ·
  `getSnapshot` · `listSlots`
- 서브트리 전용(계약 밖): `identify()` · `getPtzCapabilities()` · `getPtzStatus()` ·
  `listPresets()` · `gotoPreset()` · `setPreset()` · `removePreset()` · `ptzCommand()` ·
  `stop()` · `probeCapabilities()`
- **원본 액션 통로**: `raw(action, params, method)` — §75 판정을 거친 `Record<string,string>`
  을 그대로 돌려준다. 매뉴얼의 나머지 60여 절을 래퍼 없이 부를 수 있게 열어 두는 자리다.
  이것이 "코어는 좁게, 통로는 열어 둠" 의 실체다.

**`index.ts`** — `IdisCameraClient`, `IdisClientOptions`, `IdisCapabilities`,
`buildDigestHeader`, 좌표 변환 4함수를 내보낸다. **다른 파일을 직접 import 하지 않는 것이
공개 표면 규약**이고, `driverFactory.ts` 는 `index.js` 만 본다.

---

## 2. 좌표·단위 변환 계약 표

계약 단위는 SettingMain 의 `PtzRaw` = Hucoms 논리 좌표 `[본체 domain/ptz.ts:4~12]`.

| 축 | 계약 (PtzRaw) | IDIS 와이어 | 와이어→계약 | 계약→와이어 | 근거 |
|---|---|---|---|---|---|
| **pan** | `pan` 0..35999, 0.01°, 무부호 | `absPan` −18000..18000, 0.01° | `((absPan % 36000) + 36000) % 36000` | `p = ((pan%36000)+36000)%36000; p > 18000 ? p − 36000 : p` | 범위 `[매뉴얼 §56:8495,8535]` · **−18000 ≡ +18000(원)** `[실측 DC-S6261XT 2026-07-29]` |
| **tilt** | `tilt` −2000..9000, **+ 가 아래**, 0=수평 | `absTilt` 매뉴얼 −9000..9000 / **실측 도달 0..9000**, **+ 가 위**, 0=수직아래(nadir) | `9000 − absTilt` | `9000 − tilt`, 그 뒤 `[0, 9000]` 로 클램프 | 범위 `[매뉴얼 §56:8501]` · **원점·부호는 매뉴얼에 없다 — `[실측]` 만이 근거** |
| **zoom** | `zoom` 0..65535 **불투명 raw** | `absZoom` 100..`<Max zoom scale>`, **배율×100** / 실측 100..1200(광학 x12) | 항등 | 항등, 그 뒤 `[100, 1200]` 로 클램프 | 범위·의미 `[매뉴얼 §56:8507]` · 상한 1200 `[실측 DC-S6261XT]` |
| **centerPoint** | `{x,y}` 1920×1080 절대 픽셀 `[본체 cameraDriver.ts:29~33]` | `pointPan`·`pointTilt` 0..100000 (0.0~1.0, 단위 0.00001) | — (쓰기 전용) | `pointPan = round(x / 1920 × 100000)`, `pointTilt = round(y / 1080 × 100000)` | `[매뉴얼 §58:8635~8664]` |

### 틸트가 이 설계에서 가장 위험한 축인 이유

매뉴얼은 **범위만 말하고 원점을 말하지 않는다**. 원점은 실측으로만 닫혔다 —
`absTilt=0` 에서 카메라 자기 다리가 보이고(수직 아래), `absTilt=9000` 에서 사무실 수평
전경이 나온다 `[실측 DC-S6261XT 2026-07-29]`. Hucoms 는 **+ 가 아래**
`[실측 cam-001]` 라 부호도 원점도 반대다. 두 범위가 정확히 겹쳐 `9000 − x` 한 식(자기역함수)
으로 왕복한다.

독립 교차검증이 이 규약을 뒷받침한다 `[실측]`: `absZoom=100` 에서 5°씩 움직여 상호상관으로
화면 이동을 재면 tilt 37.6 px/°, pan 29.6 px/°. 그대로 보면 두 축 화각이 어긋나지만
(28.7° vs 64.9°), 위 규약대로 카메라가 수평에서 40° 내려가 있다면 팬의 화면 변위는
`cos40°=0.766` 배라 38.6 px/° 가 되어 틸트와 3% 안에서 일치한다. **원점이 수평이었다면 이
일치가 나오지 않는다.**

### 보내기 전에 자르는 이유 — 기기는 성공이라 답하며 다른 데로 간다 `[실측]`

| 보낸 값 | 실제 도달 | 응답 | 무슨 일 |
|---|---|---|---|
| `absTilt=12000` | 9000 | `returnCode=0` | 수평에서 클램프 |
| `absTilt=−3000` | `pan=18000, tilt=3000` | `returnCode=0` | **오토플립** — 팬을 180° 돌려 해결 |
| `absZoom=3000` | 1200 | `returnCode=0` | 이 렌즈의 상한 |
| `absPan=−18000` | 18000 | `returnCode=0` | 같은 방향(원) |

오토플립이 특히 위험하다 — 성공 응답을 받고 정반대를 본다. 그래서 **팬은 자르지 않고 감고
(modulo), 틸트·줌은 와이어 범위로 자른 뒤 보낸다.**

### 속도는 받되 버린다

`ptzAbsolute` 에 속도 파라미터가 **없다** `[매뉴얼 §56:8520~8551]`. `CameraDriver.goPtz(target,
speed?)` 의 `speed` 는 받되 무시하고, 그 사실을 코드 주석과 README 에 남긴다 — 조용히 버리면
속도를 준 호출자가 "느리게 갈 것"으로 기대하고 타이밍을 짠다. (상대 이동 `ptzCommand` 에는
`speed` 1~16 이 있다 `[매뉴얼 §48:7830]` — Hucoms 의 1~100 과 눈금이 다르다.)

### 줌 표현이 Hucoms 와 다르다는 사실의 무게

Hucoms `zoompos` 는 **불투명 raw 0..65535** 이고 IDIS `absZoom` 은 **배율×100** 이다. 숫자
범위가 계약 안에 들어가므로 항등 통과는 계약 위반이 아니지만, **"0 = 광각"이 아니라
"100 = 광각"** 이다. 이 차이를 무시하고 Hucoms 기본 화각 곡선을 폴백으로 들면 화각이 약
**5배** 틀린다(54.9° vs 실제 10.4°) `[실측 사고]`. 따라서 이 드라이버는 `intrinsics` 를
**절대 지어내지 않는다** — SettingMain 은 이미 같은 규칙을 갖고 있다
(`[본체 config/types.ts:41~49]`, `[본체 bridgeCoreProvider.ts:81]` 의 `NO_INTRINSICS`).
드라이버 쪽에 추가로 할 일은 없다.

---

## 3. 능력 상한 선언 + 프로브 설계

### 3-A. `CameraDriver` 에 capabilities 개념을 도입하지 않는다 (판단과 근거)

`[본체 cameraDriver.ts:39~49]` 에는 capabilities 개념이 없다. **도입하지 않는다.**

1. **이미 두 개의 능력 어휘가 있다.** `CoreCapabilities`
   (`[본체 core/coreProvider.ts]` — 코어 제공자의 8능력)와 `DevicePresetCapability`
   (`[본체 cameraDriver.ts:12~20]` — 장비 프리셋). 세 번째를 만들면 "이 기기가 X 를
   할 수 있는가"의 답이 세 군데에 생기고, 갈리는 순간 어느 쪽이 맞는지 판단할 근거가 없다.
2. **`CameraDriver` 의 설계 의도가 이미 다른 방식이다** — "못 하는 기능은 지어내지 않고
   던진다" `[본체 cameraDriver.ts:36~38]`. 능력 표현이 **메서드의 존재 여부와 예외**이며,
   `bridgeCoreProvider` 가 정확히 그렇게 읽는다(`typeof ctx.driver.centerPoint === 'function'`
   `[본체 bridgeCoreProvider.ts:79]`).
3. CLAUDE.md 2번·3번(단순함 우선·외과적 변경). 계약 표면 확장은 4개 드라이버 전부와 코어
   제공자 2개, 적합성 스위트에 파급된다. 요청은 드라이버 추가지 계약 개편이 아니다.

**결론: 능력 프로브는 idis 서브트리 안에만 둔다.** `IdisCameraClient.probeCapabilities()` 는
`CameraDriver` 계약 밖의 공개 메서드이며, 서브트리를 다른 프로젝트로 옮겼을 때 그 프로젝트가
쓸 수 있게 남는다(요구사항 1의 "독립 컴포넌트").

### 3-B. 상한 선언 — 생성자에서

```
{ snapshot: true, absolutePosition: true, relativeMove: true, presets: true,
  pixelCentering: true, boxZoom: true }
```

**상한에 `false` 를 미리 박지 않는다.** 근거: 같은 벤더·같은 CGI·같은 자칭 역량인데
DC-S6286HRXLT 에는 `ptzAbsolute` 가 아예 없다 `[실측 2026-07-31]`. 즉 **경계는 벤더가 아니라
개체(모델·펌웨어)** 이고, 상한에 낙관을 두고 프로브가 좁히는 것이 유일하게 맞는 방향이다.
상한에 비관을 두면 멀쩡히 되는 기기가 프로브 전까지 거부된다.

(참조구현은 상한에서 `pixelCentering`/`boxZoom` 을 빼 두었다
`[참조구현 idis-camera-client.mjs:117]`. 이 설계는 **넣는다** — 그 두 줄은 실측기 한 대의
사실을 벤더 전체의 상한으로 옮겨 적은 것이고, 같은 파일 머리말이 금지한 바로 그 일이다.
`ptzMoveToPoint` 를 가진 모델이 있으면 프로브가 살린다.)

### 3-C. 전송 실패와 기능 부재의 구분 — 이 설계의 안전 핵심

```
probeAction(action, params):
    try:   classify(응답)                       → 'present' | 'absent'
    catch: if (error.transport) throw error     ← 못 닿은 것은 능력이 아니다
           if (error.auth)      throw error     ← 자격증명 문제도 능력이 아니다
           else                 return 'absent'
```

- **전송 오류(`transport: true`)는 절대 `false` 로 기록하지 않고 던진다.** 자체서명 인증서
  하나 때문에 `snapshot:false`·`presets:false` 가 실측 결과로 저장돼 멀쩡한 카메라가
  영구히 불구로 기록될 뻔한 사고가 실제로 있었다 `[실측]`.
- **인증 실패도 마찬가지로 던진다.** 참조구현에는 이 갈래가 없다 — 비밀번호 오타 하나가
  "이 카메라는 아무것도 못 한다"로 저장된다. `[매뉴얼 §75]` 의 `900`(Password authentication
  failed) · `901` · `903` · `306`(NOT_HAS_PERMISSION) · `307` 을 인증·권한 갈래로 분리한다.
  **이 갈래는 참조구현에 없는 이 설계의 추가분이며 `[미확인]`(실측 대조 없음)이다.**

### 3-D. 프로브 첫 줄은 "정말 이 벤더인가"

`modelInformation` `[매뉴얼 §4:994~1037]` 을 먼저 부른다. 이것이 실패하면 능력을 낮추는
대신 **그 사실을 말하며 던진다.**

근거는 실기 사고다 `[실측 2026-07-31]`: `type:"flexwatch"` 로 등록된 기기가 실은 IDIS
DC-S6286HRXLT 였고, 모든 호출이 실패해 능력이 전부 `false` 로 나왔다 — **고장난 카메라와
구분되지 않는 모습**이다. FlexWatch 드라이버는 그 뒤 프로브 첫 줄에 벤더 확인을 넣었다
`[baro_calory/docs/cameras.md:374]`. 같은 것을 여기도 둔다.

부수 이득: `modelInformation` 이 `model`·`modelGroup`·`softwareVersion`·`webApiVersion` 을
준다 `[매뉴얼 §4:1013~1037]`. `modelGroup` 은 매뉴얼이 절 단위 적용 제한에 쓰는 바로 그 축이라
(예: `24. Video – Snapshot (group 5,6)` `[매뉴얼 목차:144]`), 스냅샷이 왜 없는지를 설명할 수
있게 된다.

### 3-E. 프로브 대상과 비파괴성

| 능력 | 프로브 요청 | 파괴적인가 |
|---|---|---|
| (벤더 확인) | `modelInformation&mode=1` | 아니오 |
| `absolutePosition` | `ptzAbsolute&mode=1` | 아니오 (읽기) |
| `pixelCentering` | `ptzMoveToPoint&mode=1` | 아니오 — **아래 주의** |
| `boxZoom` | `ptzMoveToArea&mode=1` | 아니오 — 같은 주의 |
| `presets` | `ptzPreset&mode=1` | 아니오 (읽기) |
| `relativeMove` | `ptzCapability&mode=1` 의 `supportPTZ` | 아니오. **자칭이므로 참고만** |
| `snapshot` | `getSnapshot()` 실제 호출 | 아니오 |

> **주의 — §58·§59 는 Write 전용이다** `[매뉴얼 목차:171,173]`. 그래서 `mode=1` 프로브는
> 지원하는 기기에서도 `returnCode=0` 이 **아닐** 수 있다(파라미터 오류 `301`/`304` 가
> 유력하다). 참조구현은 `returnCode !== 0` 을 전부 "없음"으로 읽어
> `[참조구현 idis-camera-client.mjs:291,298~306]` **지원 기기에서 거짓 음성**을 낼 수 있다.
> 이 설계는 §4 의 분류표로 이것을 고친다 — `301`/`304` 는 "기기가 액션을 알아듣고 파라미터를
> 탓했다"이므로 **'present'** 로 읽는다.
>
> 다만 **어느 코드가 실제로 오는지는 `[미확인]`** 이다(지원 기기가 없어 실측 불가). 그래서
> 분류표의 기본 갈래는 **안전한 쪽('absent' → 501 거절)** 으로 둔다. `mode=0` 으로 프로브하는
> 대안은 **카메라를 실제로 움직이므로 채택하지 않는다.**

`relativeMove` 를 `ptzCapability` 로 판정하는 것은 **자칭**이다 — 이 벤더는 픽셀 센터링이
없는데도 `supportPan=on` 이라고 답한다 `[실측]`. 실제 호출로 확인하려면 카메라를 움직여야
하므로 프로브하지 않고 상한 `true` 를 유지하며, `ptzCapability` 원문은 참고 정보로만 싣는다.

### 3-F. `centerPoint` 는 항상 정의하고, 첫 호출에서 프로브한다

```
async centerPoint(point) {
  프레임 범위 검사 → 벗어나면 400            ([본체 hucomsClient.ts:60~62] 와 같은 관례)
  this.#pixelCentering ??= await probeAction('ptzMoveToPoint', {mode:1})   // 1회 메모이즈
  if (absent) throw new CameraDriverError('이 IDIS 기기에는 ptzMoveToPoint 가 없습니다 …', 501)
  POST ptzMoveToPoint { mode:0, pointPan, pointTilt }
}
```

**알려진 한계(감수하고 문서화한다):** `bridgeCoreProvider.capabilities()` 는
`typeof driver.centerPoint === 'function'` 으로 판정하므로 `[본체 bridgeCoreProvider.ts:79]`,
IDIS 기기는 실제로 못 하더라도 `center: {ok:true}` 로 **낙관 광고**된다. 실제 호출은 501 로
정확히 거절된다.

이것을 감수하는 근거:

1. `typeof ...=== 'function'` 은 **"이 드라이버 종류가 원리적으로 할 수 있는가"** 를 묻는
   정적 질문이다. 기기별 실측은 그 질문의 답이 아니다. 이 낙관은 3-B 의 "상한은 낙관,
   프로브가 좁힌다" 규약과 **같은 방향**이다.
2. 501 은 **조용한 성공이 아니라 명시적 거절**이므로 이 저장소의 적합성 원칙
   ("금지 대상은 오직 조용한 성공" `[본체 test/coreProviderConformance.ts:69~76]`)을
   위반하지 않는다.
3. 대안 ①(메서드를 아예 정의하지 않음)은 `ptzMoveToPoint` 가 있는 모델에서 **있는 기능을
   스스로 버린다** — `cameras.md` 가 ONVIF 공통분모 드라이버를 거부한 것과 같은 실수다.
   대안 ②(`capabilities()` 를 프로브 기반으로 바꿈)는 능력 조회 한 번마다 카메라를 두드리게
   되고, 코어 계층 개편이라 이번 범위 밖이다.

---

## 4. 미구현 액션 판정 로직

### 4-A. Return Code 전표 `[매뉴얼 §75:9898~9976]`

`idisConstants.ts` 에 상수로 싣는다.

| Type | Code | Description (원문) |
|---|---|---|
| Success | 0 | Success |
| Error | 100 | File does not exist. |
| | 101 | Firmware upgrade fail |
| | 102 | Failed to create the system data |
| | 107 | Failed to send email |
| | 108 | System wizard failed |
| | 109 | Network wizard failed |
| | 110 | DDNS failed |
| | 111 | camera name already exist in DDNS server |
| | 200 | Failed to mount SD card |
| | 201 | Failed to unmount SD card |
| | 202 | Failed to format SD card |
| | 203 | Failed to check SD card |
| | 204 | Failed to mount SD card (already mounted) |
| | 205 | Failed to format SD card (unmounted SD Card ) |
| | **301** | **Invalid parameter(s) (out of the range of valid values)** |
| | **302** | Either attempting to write a read-only data or written data is different from the original data. |
| | 303 | Over the camera compression capability. Reduce the resolution or frame rates. |
| | **304** | **Not enough parameters (need the mandatory parameters)** |
| | 305 | INVALID_SETUP_FILE |
| | **306** | **NOT_HAS_PERMISSION** |
| | **307** | **NOT_FOUND_SESSION_INFO** |
| | **308** | **NOT_SUPPORT_CMD_THIS_VERSION** |
| | 309 | DATA_DECRYPT_FAILED |
| | **310** | **FUNCTION_NOT_SUPPORTED** |
| | 400 | UPNP NAT not exist |
| | 401 | UPNP error |
| | 402 | UPNP invalid port range |
| | 500 | FTP upload test failed |
| | 600~612 | SMTP_TEST_FAIL_* (UNKNOWN · INVALID_DNS · TO_CONNECT_SMTP · TO_CONNECT_SSL · NO_SUCH_USER · TO_AUTHENTICATE · NEED_TLS · TO_SEND_MESSAGE · TO_SEND_CMD_FROM · TO_SEND_CMD_RCPT · TO_CMD_DATA · TO_CMD_DATA_END · TO_CMD_QUIT) |
| | **900** | **Password authentication failed (wrong password)** |
| | 901 | Password policy violation |
| | 902 | Exceed the maximum number of element (user, group, alarm file, PTZ client, preset, scan, tour, event client) |
| | **903** | **No matching user found** |
| | 904 | There is already same element(user, group, alarm file, PTZ client, preset, scan, tour, event client) |
| | **9000** | **Unknown API** |
| | 9999 | Unknown error |

**9000 의 정의가 확인됐다: `Unknown API`** `[매뉴얼 §75:9974]`. 즉 실측기의 rc=9000 응답은
펌웨어가 정직하게 "그런 API 없다"고 답한 것이며, "미구현"이라는 우리 해석이 매뉴얼과 일치한다.

> ⚠ **9000 은 이 문서에서 두 뜻이다.** `returnCode=9000` = Unknown API `[매뉴얼 §75:9974]`,
> `mode=9000` = **System Restart** `[매뉴얼 §74:9888]`. 별개 네임스페이스이며 섞으면
> 카메라를 재부팅시킨다. 상수 이름을 분리하고(`RETURN_CODE.UNKNOWN_API` /
> `MODE.SYSTEM_RESTART`) 주석으로 못 박는다.

### 4-B. 단일 분류 함수 — 두 경로를 하나로 다룬다

```
classifyReply(text) → 'answer' | 'unknown-action' | 'auth' | 'param' | 'error'
```

| 입력 | 분류 | 호출자의 처리 | 근거 |
|---|---|---|---|
| `returnCode=` 로 **시작하지 않는** 본문 | `unknown-action` | 프로브: absent / 일반 호출: 502 던짐 | `[실측 DC-S6286HRXLT — 무관한 설정 덤프]` |
| `returnCode=9000` | `unknown-action` | 동일 | `[매뉴얼 §75:9974]` + `[실측 DC-S6261XT]` |
| `returnCode=310` (FUNCTION_NOT_SUPPORTED) | `unknown-action` | 동일 | `[매뉴얼 §75]` · `[미확인]` |
| `returnCode=308` (NOT_SUPPORT_CMD_THIS_VERSION) | `unknown-action` | 동일 | `[매뉴얼 §75]` · `[미확인]` |
| `returnCode=0` | `answer` | 파싱 결과 반환 | `[매뉴얼 §1:356~375]` |
| `returnCode=301` / `302` / `304` | `param` | 프로브: **present** / 일반 호출: 400 던짐 | `[매뉴얼 §75]` · `[미확인]` |
| `returnCode=900` / `901` / `903` / `306` / `307` | `auth` | **항상 던짐**(프로브도 능력을 낮추지 않는다) | `[매뉴얼 §75]` · `[미확인]` |
| 그 밖의 코드 | `error` | 502 던짐. 프로브에서는 absent(안전한 쪽) | — |
| 예외(전송) | — | `transport: true` 달고 전파 | `[실측]` |

**두 경로(덤프 / 9000)가 하나로 다뤄지는 지점이 `unknown-action` 이다.** 이 위에 프로브와
일반 호출이 각각 다른 처리를 얹으므로, "미구현"의 정의가 코드 전체에 딱 한 군데만 있다.

**본문이 `returnCode=` 로 시작하는지가 왜 유일한 신뢰 신호인가**: 같은 CGI 가 존재하지 않는
액션명(`bogusNotReal`)에도 200 + 무관한 설정 덤프를 돌려준 적이 있다 `[실측]`. HTTP 상태도,
본문의 유무도 성공 판정이 될 수 없다.

### 4-C. 파서

`parseQueryReply(text)` → `Record<string,string>`.
응답 형식은 `returnCode=<code>&<k>=<v>&…` `[매뉴얼 §1:356~366]`, 값은 URI 인코딩
`[매뉴얼 §0:314]` 이므로 `decodeURIComponent` 로 푼다(참조구현은 풀지 않아 프리셋 이름에
공백·한글이 들어가면 깨진다 `[참조구현 idis-camera-client.mjs:310~318]`). 디코딩 실패는
원문을 그대로 남긴다 — 던져서 응답 전체를 버리는 것보다 낫다.

---

## 5. CameraKind 확장 전 지점 + DB 마이그레이션 전략

### 5-A. 전 지점 (리더 목록 검증 결과)

| # | 위치 | 변경 | 비고 |
|---|---|---|---|
| 1 | `src/config/types.ts:13` | 유니온에 `'idis'` + 주석 1문단 | 리더 목록 ✔ |
| 2 | `src/config/normalize.ts:19` | `CAMERA_KINDS` 배열 | 리더 목록 ✔ |
| 3 | `src/db/schema.ts:71` | `CHECK (kind IN (…, 'idis'))` | 리더 목록 ✔ (§5-C) |
| 4 | `src/db/schema.ts:48` | `SCHEMA_VERSION` 4 → 5 | **리더 목록에 없었음.** 파일 자신의 규칙: "스키마를 바꾸면 올리고 마이그레이션을 추가한다" `[본체 schema.ts:43~47]` |
| 5 | `src/db/setupRepository.ts:31` | `CameraRow['kind']` 유니온 | 리더 목록 ✔ |
| 6 | `src/api/routes/dbRoutes.ts:239` | `KINDS` 배열 | 리더 목록 ✔ |
| 7 | **`src/devices/driverFactory.ts:12`** | **`case 'idis':` 추가** | **리더 목록에 없었음 — 가장 중요한 자리다.** `default` 의 `const unknown: never = camera.kind` `[본체 driverFactory.ts:40]` 때문에 유니온만 넓히고 `case` 를 빠뜨리면 **컴파일이 깨진다**. 즉 컴파일러가 이 자리를 강제한다 |
| 8 | `web/options.html:111,165` | `<option value="idis">` 2곳 | 리더 목록 ✔ |
| 9 | `src/api/routes/devicePresetRoutes.ts:23,34` | **변경 없음** | §비범위 1번. IDIS 는 501 유지 |
| 10 | `src/db/database.ts` | 낡은 CHECK **감지 가드** 추가 | 리더는 `:109`(`upgradeToV2` 의 kind 기본값)을 지목했으나 그 자리는 `DEFAULT 'hucoms'` 뿐이라 **목록 확장이 필요 없다.** 대신 §5-C 의 가드가 이 파일에 들어간다 |

**전수 확인 방법**(구현자가 그대로 실행): `grep -rn "kind ===\|kind !==\|'park3d-rpc'" src/ web/`.
이 계획 작성 시 실행한 결과가 위 표이며, 그 밖에 `kind` 를 값으로 분기하는 자리는 없다.
`src/db/backendCoreExport.ts` 는 `kind` 를 전혀 다루지 않는다(확인함).

**추가 확인 항목(구현 중 확인)**: `web/options.html` 의 `portPairWarning(controlUrl,
streamUrl, kind, camId)` 가 `'park3d-rpc'` 문자열로 분기하는지. 분기한다면 IDIS 는 해당
경고 대상이 아니므로 **통과(빈 문자열)** 하는 것이 맞다 — 테스트로 못 박는다(§7 T-UI2).

### 5-B. DB 현황 — **실측**(이 계획 작성 시 직접 조회)

운영 DB `SettingMain/config/setup.db` (`user_version = 4`)의 `camera_info` 정의:

```
cam_type TEXT NOT NULL DEFAULT 'ptz' CHECK (cam_type IN ('ptz','static')),
place_id INTEGER NOT NULL REFERENCES place_info(place_id) ON DELETE RESTRICT
, timeout_ms INTEGER NOT NULL DEFAULT 5000, kind TEXT NOT NULL DEFAULT 'hucoms',
  park3d_cam_id INTEGER, intrinsics TEXT
```

**결정적 사실: 운영 DB 의 `kind` 열에는 CHECK 제약이 없다.** `upgradeToV2()` 가
`ALTER TABLE … ADD COLUMN` 으로 붙인 열이고, SQLite 는 `ADD COLUMN` 에 CHECK 를 붙일 수 없어
코드가 의도적으로 생략했다 `[본체 database.ts:100~102]`. 그 파일의 주석이 이 상황을 이미
예고한다 — "제약이 두 파일에서 다른 것은 감수하고, 그 대신 데이터를 잃지 않는다".

즉 **CHECK 는 지금도 운영에서 강제되고 있지 않다.** 이것이 다음 절의 전략을 결정한다.

### 5-C. 마이그레이션 전략

파일 상태는 세 가지뿐이다.

| 상태 | 어떻게 생겼나 | `kind='idis'` 삽입 | 필요한 조치 |
|---|---|---|---|
| **(가)** ALTER 유래 (= 운영 DB) | `kind TEXT NOT NULL DEFAULT 'hucoms'`, CHECK 없음 | **된다** | 없음 |
| **(나)** 새로 만드는 파일 | `SCHEMA_SQL` 이 만든다 | 목록만 넓히면 된다 | `SCHEMA_SQL` 의 CHECK 에 `'idis'` 추가 |
| **(다)** `SCHEMA_SQL` 로 새로 만들어진 **v3/v4 파일** | 옛 목록의 CHECK 가 표 정의에 박혀 있다 | **거부(SQLITE_CONSTRAINT)** | 아래 |

(다)가 문제다. 그리고 **`verifySchema` 는 이것을 잡지 못한다** — 표·뷰 이름과 **열 이름만**
대조하고 제약은 보지 않는다 `[본체 database.ts:152~179]`. `CREATE TABLE IF NOT EXISTS` 는
이미 있는 표의 정의를 바꾸지 않으므로 `SCHEMA_SQL` 을 고쳐도 (다)는 그대로다.

**기본안: 고치지 않고 감지해 던진다.**

`database.ts` 에 `verifySchema` 와 나란히 `verifyCameraKindConstraint(db)` 를 둔다.

```
sqlite_master 에서 camera_info 의 CREATE 문을 읽는다
kind 열에 CHECK 가 없으면            → 통과 (상태 가)
CHECK 가 있고 'idis' 를 포함하면      → 통과 (상태 나)
CHECK 가 있고 'idis' 가 없으면        → DatabaseError 를 던진다
    "이 DB 파일의 camera_info.kind 제약이 idis 를 허용하지 않습니다 — 옛 판으로 새로
     만들어진 파일입니다. 표 재작성이 필요합니다(설계 §5-C)."
```

이 판단 근거:

1. **표 재작성(12-step rebuild)에는 데이터 손실 위험이 실재한다.** `migrate()` 는
   `BEGIN`…`COMMIT` 안에서 돌고 `[본체 database.ts:65~79]`, `PRAGMA foreign_keys` 는
   트랜잭션 안에서 **무효(no-op)** 다. 그 상태로 `DROP TABLE camera_info` 를 하면 SQLite 가
   암묵 `DELETE FROM` 을 수행하고 `preset_info.cam_id … ON DELETE CASCADE`
   `[본체 schema.ts:86]` 가 발동해 **프리셋 전부 → `slot_setup` 전부**가 연쇄 삭제된다.
   안전하게 하려면 트랜잭션 **밖에서** `foreign_keys=OFF` 를 걸고 별도 트랜잭션을 여는
   구조 변경이 필요하다. 커미셔닝 산출물을 다루는 코드에서 이만한 위험을 (다)라는
   드문 상태 하나 때문에 감수하지 않는다.
2. **`verifySchema` 의 명시적 철학과 같다** — "검사만 하고 고치지 않는다. 보정까지 하면
   무엇이 왜 어긋났는지 아무도 다시 안 보게 되고, 대조가 두 번째 마이그레이션 엔진이 된다"
   `[본체 database.ts:145~147]`.
3. **실패 시점이 옮겨진다.** 가드가 없으면 사용자가 옵션 화면에서 IDIS 카메라를 저장하는
   순간 해독 불가능한 `SQLITE_CONSTRAINT` 를 만난다. 가드가 있으면 **서버 기동 시**
   무엇이 왜 문제인지 한국어 문장으로 나온다.
4. **판 번호가 아니라 사실로 판단한다** — 이 저장소가 v2 열 넷을 통째로 빠뜨린 원인이 판
   번호 분기였다 `[본체 database.ts:70~71]`. 그래서 가드의 술어는 `user_version` 이 아니라
   `sqlite_master.sql` 문자열이며, 그 덕에 **멱등**하고 (가)·(나)에서는 아무 일도 하지 않는다.

**표 재작성은 확인 필요 #2 로 올린다.** 사용자가 (다) 상태의 파일이 실재한다고 판단하면
그때 별도 단계로 붙인다.

**함께 하는 것**: `SCHEMA_SQL` 의 CHECK 목록에 `'idis'` 추가 + `SCHEMA_VERSION` 4 → 5.
판 올리기는 (가)에서 `upgradeToV2`(무동작) → `dropCamCompany`(무동작) → `SCHEMA_SQL`(무동작)
→ `user_version=5` 로 무해하게 지나간다.

---

## 6. 단계별 구현 순서

각 단계의 검증은 **통과해야 하는 테스트**로 적는다. 파일 생성은 검증이 아니다.

### 1단계 — 서브트리 순수 계층 (`contract` · `idisConstants` · `idisCoords` · `idisReply`)

네트워크가 필요 없는 부분을 먼저 세운다. 계약 위험(좌표 부호·미구현 판정)이 전부 여기 있다.

**검증**
- `npx vitest run test/idisCoords.test.ts test/idisReply.test.ts` 통과 (T-C1~C7, T-R1~R9)
- `npm run typecheck` 통과

### 2단계 — `digest.ts`

**검증**
- `npx vitest run test/idisDigest.test.ts` 통과 (T-D1~D5)
- 특히 T-D1: 고정 nonce/cnonce 주입 시 `response=` 가 **테스트가 독립적으로 계산한**
  RFC2617 값과 바이트 단위로 같다

### 3단계 — `idisTransport.ts`

**검증**
- `npx vitest run test/idisTransport.test.ts` 통과 (T-T1~T6)
- T-T5(마감 타이머)가 **도달 불가 주소에서 설정 350ms 를 지켜 1200ms 안에 실패**한다 —
  이것이 실패하면 소켓 유휴 타임아웃으로 되돌아간 것이다

### 4단계 — `idisCamera.ts` + `index.ts` (계약 구현 + 프로브 + 원본 통로)

**검증**
- `npx vitest run test/idisCamera.test.ts` 통과 (T-M1~M14)
- T-ISO: `contract.ts` 외의 서브트리 파일에 `../` 로 시작하는 import 가 **0개**
- `npm run typecheck` 통과 (아직 `driverFactory` 미배선 상태에서도 서브트리 단독으로 컴파일)

### 5단계 — DB 스키마 (`schema.ts` · `database.ts`)

`driverFactory` 배선보다 **먼저** 한다. 서버 경계 테스트가 `seedCameras`
`[본체 test/cameraFixture.ts]` → `upsertCamera` 로 DB 에 카메라를 심으므로, CHECK 가 먼저
열려 있어야 6단계 테스트가 성립한다.

**검증**
- `npx vitest run test/database.test.ts` 통과 (기존 전부 + T-DB1~DB4)
- T-DB1: 새로 연 DB 에 `kind='idis'` 카메라가 **삽입되고 다시 읽힌다**
- T-DB3: 옛 CHECK 를 가진 (다) 상태 픽스처를 열면 `DatabaseError` 가 나고 메시지에
  `camera_info` · `kind` · `idis` 가 들어 있다
- T-DB4: (가) 상태 픽스처(`kind` 에 CHECK 없음)는 **가드에 걸리지 않는다** — 운영 DB 가
  기동을 멈추면 안 된다

### 6단계 — CameraKind 배선 (types · normalize · setupRepository · dbRoutes · driverFactory)

`driverFactory` 의 `never` 소진 검사가 빠뜨림을 컴파일 오류로 잡아 준다.

**검증**
- `npm run typecheck` 통과 (= `driverFactory` 의 `case 'idis'` 가 실제로 있다는 증명)
- `npx vitest run test/normalize.test.ts test/dbRoutes.test.ts test/idisServerRoutes.test.ts` 통과
  (T-N1~N2, T-S1~S5)
- T-S1: `kind:'idis'` 설정이 `createDriver` 로 `IdisCameraClient` 를 조립하고 `driver.kind === 'idis'`

### 7단계 — UI 드롭다운 + 경계 확인

**검증**
- `npx vitest run test/optionsDbUi.test.ts test/optionsPark3dUi.test.ts` 통과 (T-UI1~UI2)
- T-UI1: `options.html` 의 kind `<select>` **2곳 모두**에 `idis` 옵션이 있다
- T-S4: IDIS 카메라에 `/api/cameras/idis-1/device-presets` 를 부르면 **501** 이다
  (`park3dRpcServerRoutes.test.ts:126` 의 대응 검증과 같은 형태)

### 8단계 — 전체 회귀 + 문서

**검증**
- `npm run typecheck && npm run test` — **전부 통과**. 기존 테스트가 하나도 깨지지 않는다
- `src/devices/idis/README.md` 가 존재하고 ① 복사 절차 ② `contract.ts` 하나만 고치면 된다는
  사실 ③ 매뉴얼 근거와 실측 근거의 구분 ④ 실기 미검증 목록을 담는다
- 한글 변경 문서 `docs/yyyyMMdd_hhmmss_*.md` (CLAUDE.md 4번) — 문서화 담당 소관

---

## 7. 모듈별 vitest 케이스 목록

**픽스처 원칙**: 응답 문자열은 지어내지 않고 `[매뉴얼]` 의 Example 또는 `[실측]` 문자열을
그대로 쓴다. 각 픽스처 상수 옆에 근거를 주석으로 단다(스택 규약의 모킹 규칙).

**전송 모킹 방식**: 이 드라이버는 `fetch` 가 아니라 `node:http` 를 쓰므로
`vi.stubGlobal('fetch', …)` 로 가로챌 수 없다. 저장소에 이미 선례가 있다 —
`[본체 test/hucomsPresetClient.test.ts:10~19]` 가 로컬 소켓 서버를 띄운다. Digest 는 401→재시도
2왕복이 필요하므로 `node:http` 의 `createServer` 를 쓴다(`[참조구현 test/idis-transport.test.mjs]`
와 같은 형태).

### `test/idisCoords.test.ts` (순수)

| ID | 케이스 | 기대 |
|---|---|---|
| T-C1 | **tilt 부호·원점 반전 왕복** | 계약 `tilt=0`(수평) ↔ 와이어 `absTilt=9000`; 계약 `9000`(수직아래) ↔ 와이어 `0`; 계약 `4500` ↔ 와이어 `4500` |
| T-C2 | tilt 자기역함수 | 0..9000 전 구간에서 `fromWire(toWire(t)) === t` |
| T-C3 | **pan modulo 왕복** | 계약 `35000` → 와이어 `−1000` → 계약 `35000`. 경계 `18000`→`18000`, `18001`→`−17999`, `0`→`0` |
| T-C4 | pan 은 자르지 않고 감는다 | 계약 `40000` → 와이어 `4000`(=40000%36000) |
| T-C5 | **범위 밖 사전 클램프 — zoom** | `zoompos=3000` → 와이어 `absZoom=1200`; `zoompos=0` → `100`; `zoompos=65535` → `1200` |
| T-C6 | **범위 밖 사전 클램프 — tilt 음수 방지** | 계약 `tilt=−2000`(수평 위 20°, Hucoms 는 가능) → 와이어 `absTilt=9000`(수평에서 멈춤). **`11000` 이 나가면 안 된다** — 오토플립으로 팬이 180° 돌아간다 |
| T-C7 | **centerPoint 정규화** | `{x:960,y:540}` → `{pointPan:50000, pointTilt:50000}`; `{x:1920,y:1080}` → `{100000,100000}`; `{x:0,y:0}` → `{0,0}`; `{x:384,y:216}` → `{20000,20000}` (`[매뉴얼 §58:8660]` 의 Example 값과 같은 자리) |

### `test/idisReply.test.ts` (순수)

| ID | 케이스 | 기대 |
|---|---|---|
| T-R1 | **`returnCode=` 로 시작하지 않는 본문** — 픽스처 `motion_type="rect"\narea_count=1` `[실측 DC-S6286HRXLT 덤프]` | `'unknown-action'` |
| T-R2 | **`returnCode=9000`** `[매뉴얼 §75:9974 Unknown API]` | `'unknown-action'` |
| T-R3 | `returnCode=310` / `308` | `'unknown-action'` |
| T-R4 | `returnCode=0&absPan=18000&absTilt=8850&absZoom=3000` `[매뉴얼 §56:8513 Example]` | `'answer'` + 파싱값 4개 |
| T-R5 | `returnCode=301` / `302` / `304` | `'param'` |
| T-R6 | `returnCode=900` / `903` / `306` | `'auth'` |
| T-R7 | `returnCode=9999` | `'error'` |
| T-R8 | 선행 공백·개행이 있는 본문 | `'answer'` (앵커는 `/^\s*returnCode\s*=/`) |
| T-R9 | URI 인코딩된 값 `presetName1=door%20A` `[매뉴얼 §0:314]` | `'door A'` 로 디코딩. 잘못된 이스케이프는 원문 유지 |

### `test/idisDigest.test.ts` (순수)

| ID | 케이스 | 기대 |
|---|---|---|
| T-D1 | **고정 nonce/cnonce 결정적 검증** — 챌린지 `Digest realm="WEB SERVER",qop="auth",algorithm=MD5,nonce="deadbeef"` `[실측 realm]`, `cnonce='0123456789abcdef'`, `nc='00000001'` | `response=` 가 테스트가 **독립적으로** 계산한 `MD5(HA1:nonce:nc:cnonce:auth:HA2)` 와 일치. 구현 함수를 다시 부르지 않고 RFC2617 식을 테스트 안에 따로 적는다 |
| T-D2 | 헤더 필드 집합 | `username`·`realm`·`nonce`·`uri`·`response`·`qop=auth`·`nc`·`cnonce` 가 모두 있고 `Digest ` 로 시작 |
| T-D3 | `opaque` 통과 | 챌린지에 있으면 헤더에 그대로 실린다 |
| T-D4 | `qop` 없는 챌린지(RFC2069) | `MD5(HA1:nonce:HA2)`, `qop`·`nc`·`cnonce` 필드 없음 |
| T-D5 | `uri` 는 path+query 를 그대로 쓴다 | `/cgi-bin/webSetup.cgi?action=ptzAbsolute&mode=1` 전체가 `uri=` 와 HA2 양쪽에 동일하게 들어간다(불일치하면 기기가 403) |

### `test/idisTransport.test.ts` (로컬 `node:http` 목)

| ID | 케이스 | 기대 |
|---|---|---|
| T-T1 | **Digest 왕복** 401 → 재시도 → 200 | 인증된 요청이 목에 **1회** 도달, 목이 응답 해시를 독립 검증해 통과 |
| T-T2 | **POST 는 폼 본문으로 나가고 쿼리로 새지 않는다** | `Content-Type: application/x-www-form-urlencoded`, 본문에 `command=moveTo&id=7`, **URL 쿼리에 `command=` 없음** `[매뉴얼 §50 은 mode=0 쓰기]` |
| T-T3 | **바이너리 온전성** | 50KB JPEG 이 청크로 쪼개져 와도 바이트가 보존된다 |
| T-T4 | Basic 챌린지 폴백 | 목이 `WWW-Authenticate: Basic` 을 주면 Basic 헤더로 재시도 |
| T-T5 | **연결 단계 마감** | 도달 불가 `10.255.255.1`, `timeoutMs=350` → 1200ms 안에 `transport:true` 오류 |
| T-T6 | 알 수 없는 인증 방식 | 401 을 그대로 올린다(임의로 Basic 을 시도하지 않는다) |

### `test/idisCamera.test.ts` (로컬 목 + 순수)

| ID | 케이스 | 기대 |
|---|---|---|
| T-M1 | `getPtz` | 목이 `[매뉴얼 §56:8513]` Example `returnCode=0&absPan=18000&absTilt=8850&absZoom=3000` → `{pan:18000, tilt:150, zoom:3000}` (tilt = 9000−8850) |
| T-M2 | `getPtz` — 실측 자세 | `absPan=-1000&absTilt=0&absZoom=1200` → `{pan:35000, tilt:9000, zoom:1200}` |
| T-M3 | **`goPtz` 사전 클램프가 와이어에 반영된다** | `{pan:35000, tilt:-2000, zoom:3000}` → POST 본문이 `absPan=-1000`·`absTilt=9000`·`absZoom=1200`. **`absTilt` 가 음수로 나가지 않는다** |
| T-M4 | **`goPtz` 의 speed 는 와이어에 실리지 않는다** | `goPtz(t, 50)` 의 POST 본문에 `speed`·`panspeed` 없음 `[매뉴얼 §56:8520~8551 — 속도 파라미터 없음]` |
| T-M5 | `goPtz` 는 GET 이 아니라 POST | `mode=0` 이 본문에 |
| T-M6 | **미구현 액션 — 덤프** | 목이 설정 덤프 → `getPtz()` 가 "이 펌웨어에 없습니다" 로 던진다 |
| T-M7 | **미구현 액션 — 9000** | 목이 `returnCode=9000` → 같은 오류 |
| T-M8 | **프로브: 덤프/9000 은 능력을 내린다** | `probeCapabilities()` → `absolutePosition:false`, `presets:false` |
| T-M9 | **프로브: 전송 실패는 던진다** | 도달 불가 주소 → `transport:true` 로 던지고 **선언 능력은 그대로**(`snapshot:true` 유지) |
| T-M10 | **프로브: 인증 실패는 던진다** | 목이 `returnCode=900` → 던지고 능력을 내리지 않는다 |
| T-M11 | **프로브: `301`/`304` 는 '있음'** | `ptzMoveToPoint&mode=1` 에 `returnCode=304` → `pixelCentering:true` |
| T-M12 | **프로브: 벤더 확인 실패** | `modelInformation` 이 덤프를 주면 능력을 내리는 대신 **던진다**(FlexWatch 기기 오인 사고 대응) |
| T-M13 | **`centerPoint` — 지원 시** | 프로브가 present → POST 본문 `pointPan=50000&pointTilt=50000` (T-C7 과 같은 값) |
| T-M14 | **`centerPoint` — 미지원 시 501** | 프로브가 absent → `CameraDriverError` 의 `statusCode === 501`, 그리고 **`ptzMoveToPoint` POST 가 목에 도달하지 않는다** |
| T-M15 | `centerPoint` 프레임 범위 밖 | `{x:2000,y:0}` → 400, 네트워크 호출 없음 `[본체 hucomsClient.ts:60~62]` 관례 |
| T-M16 | **비밀번호가 새지 않는다** | 비밀번호 `secret-not-real` 로 여러 실패 경로(전송 실패·rc≠0·HTTP 500·JPEG 아님)를 유발해 **모든 오류 메시지에 그 문자열이 없다.** `controlUrl` 에 자격증명이 박힌 경우도 포함 |
| T-M17 | `controlUrl` 에 자격증명이 있으면 400 | `http://admin:pw@ip` 거절 `[본체 hucomsPresetClient.ts:141~143]` 관례 |
| T-M18 | `getSnapshot` | `Content-Type: image/jpeg` + SOI(`FF D8`) → Buffer 그대로. `returnCode=…` 텍스트가 오면 오류 |
| T-M19 | `getSnapshot` — SOI 없는 200 | 던진다 (`[본체 hucomsClient.ts:68~72]` 관례). §25 가 `image/webp` 라 적은 모순이 있어 **바이트 판정을 1차 신호로 둔다** `[매뉴얼 §25:4021~4024]` |
| T-M20 | `listSlots` | `[]` (IDIS 에 주차면 개념 없음) |
| T-M21 | `listPresets` | `returnCode=0&presetName1=EL1&presetName2=FL1` → `[{id:1,name:'EL1'},{id:2,name:'FL1'}]`, id 오름차순 |
| T-M22 | `gotoPreset`/`setPreset` 명령 표기 | POST 본문이 `command=moveTo` / `command=set` — **`moveToPreset`/`setPreset` 이 아니다** `[매뉴얼 §50:7976~7987]`, §가정 절의 조사 결과 |
| T-M23 | 프리셋 id 범위 | 0·257·1.5 → 400, 네트워크 호출 없음 `[매뉴얼 §50:7981 — 1~256]` |
| T-M24 | `ptzCommand` 화이트리스트 | 목록 밖 명령은 400. `speed` 는 1~16 으로 클램프 `[매뉴얼 §48:7830]` |
| T-M25 | `raw()` 원본 통로 | 임의 action 을 §75 판정을 거쳐 `Record<string,string>` 으로 돌려준다 |
| T-ISO | **격리 증명** | `src/devices/idis/*.ts` 중 `contract.ts` 를 뺀 모든 파일에 `from '../` 로 시작하는 import 가 0개 |

### `test/idisServerRoutes.test.ts` (서버 경계 — `park3dRpcServerRoutes.test.ts` 하네스 복제)

| ID | 케이스 | 기대 |
|---|---|---|
| T-S1 | **조립** | `kind:'idis'` 설정 → `createDriver` 가 `IdisCameraClient`, `driver.kind === 'idis'` |
| T-S2 | 설정 왕복 | `/api/settings` 로 저장·조회 시 `kind` 가 `idis` 로 보존되고 **비밀번호는 실리지 않는다** |
| T-S3 | DB 왕복 | `seedCameras` → `readCameras` 에서 `kind:'idis'` 보존 |
| T-S4 | **장비 프리셋은 자동 배제** | `/api/cameras/idis-1/device-presets` → **501** (§비범위 1번) |
| T-S5 | 코어 능력 광고 | `center` 가 `ok:true` 로 광고된다(§3-F 의 알려진 한계를 **테스트로 고정**해 둔다 — 나중에 바꿀 때 이 테스트가 알려 준다) |

### `test/database.test.ts` (추가분)

| ID | 케이스 | 기대 |
|---|---|---|
| T-DB1 | 새 DB 에 IDIS 카메라 | `openDatabase(':memory:')` → `kind='idis'` upsert 성공, `listCameras()` 에서 되읽힘 |
| T-DB2 | 판 올림 | `user_version === SCHEMA_VERSION`(=5) |
| T-DB3 | **(다) 상태 감지** | 옛 CHECK(`kind IN ('hucoms','backend-core','park3d-rpc')`)를 손으로 심은 픽스처를 열면 `DatabaseError`, 메시지에 `camera_info`·`kind`·`idis` |
| T-DB4 | **(가) 상태는 통과** | ALTER 유래(= CHECK 없음) 픽스처는 가드에 걸리지 않고 `kind='idis'` 삽입까지 된다 — **운영 DB 의 모습이다** |

### `test/normalize.test.ts` · `optionsDbUi.test.ts` (추가분)

| ID | 케이스 | 기대 |
|---|---|---|
| T-N1 | `normalizeCamera({kind:'idis'})` | `kind:'idis'` 보존 |
| T-N2 | 알 수 없는 kind | 여전히 `'hucoms'` 로 폴백(회귀 방지) |
| T-UI1 | `options.html` 드롭다운 | `idis` 옵션이 **2곳 모두** |
| T-UI2 | `portPairWarning` | IDIS 는 park3d 전용 포트 경고 대상이 아니다(빈 문자열) |

### 실기 미검증 목록 (목으로는 닫히지 않는다)

이 스위트 전체가 목 기반이다. 실기가 확보되면 **가장 먼저** 확인할 것:

1. **틸트 원점과 부호** — 아래를 보라 했을 때 실제로 아래를 보는가. 이 계획의 `9000 − x` 는
   DC-S6261XT 한 대의 실측이다. 다른 모델에서 같다는 근거는 없다 `[미확인]`.
2. **줌 상한** — `absZoom` 최댓값. 1200 은 이 모델의 광학 x12 이고 모델마다 다르다.
   `ptzCapability`/`lensList` 로 좁힐 수 있는지도 함께 본다.
3. **§4-B 분류표의 `[미확인]` 행** — `301`/`304`/`900`/`310`/`308` 을 실제로 돌려주는가.
   특히 T-M11(`ptzMoveToPoint&mode=1` → `304`)은 **지원 기기가 있어야만** 확인된다.
4. `videoSnapshot` 의 Content-Type 이 `image/jpeg` 인지(§25 는 `image/webp` 라 적혀 있다).
5. RTSP `trackID=N` 의 실제 코덱 — **번호를 믿지 말고 ffprobe 로 확인**한다 `[실측 교훈]`.

---

## 8. 영향도 예고

### 8-A. 기존 테스트

| 파일 | 영향 | 이유 |
|---|---|---|
| `test/database.test.ts` | **판 번호에 자동 추종** — 수정 불필요 | `SCHEMA_VERSION` 상수를 참조한다 `[본체 test/database.test.ts:47,405]`. 단 `writeV3AugmentedFixture` 의 `PRAGMA user_version = 3` 은 **의도적 하드코딩**이므로 건드리지 않는다 `[본체 test/database.test.ts:499~510]` |
| `test/normalize.test.ts` | 추가만 | 기존 케이스는 kind 목록 길이에 의존하지 않는다 |
| `test/dbRoutes.test.ts` | 추가만 | 〃 |
| `test/park3dRpcServerRoutes.test.ts` | **없음** | IDIS 는 별도 파일로 대응 케이스를 만든다(그 파일의 하네스를 복제) |
| `test/optionsDbUi.test.ts` | 드롭다운 개수를 세는 단언이 있으면 갱신 | 구현 중 확인 |
| `test/coreProviderContract.test.ts` · `bridgeCoreProvider.test.ts` | **없음** | 코어 계약을 건드리지 않는다(§3-A) |
| `test/vendorProfile.test.ts` | **없음** | 벤더 해시와 무관 |
| `test/packageScripts.test.ts` | **없음** | 의존성을 추가하지 않는다 |

**런타임 의존성 0 이 유지된다.** 이 드라이버는 `node:http`·`node:https`·`node:crypto` 만
쓴다 — SettingManager 의 원칙 `[본체 database.ts:11~13]` 과 같은 자리다.

### 8-B. 형제 프로젝트

| 대상 | 파급 | 조치 |
|---|---|---|
| **`baro_calory`** | **없음(단방향 참조)**. 이 작업은 `idis-camera-client.mjs`·`http-transport.mjs` 를 **읽고 TypeScript 로 다시 쓴다** — 복사·심볼릭 참조가 없다 | 없음. 단, `src/vendor/baro-profile` 과 달리 **벤더링이 아니므로 해시 고정 대상이 아니다.** 그 이유를 README 에 적는다(§8-C) |
| **`SettingAgent`** | **없음** | IDIS 드라이버가 없고, 이 변경은 그쪽 계약을 건드리지 않는다 |
| `Parking3D`(언리얼) | **없음** | `park3d-rpc` 경로 무변경 |

### 8-C. 왜 벤더링(복사)이 아니라 재작성인가

`src/vendor/baro-profile` 의 판단 기준은 명확하다 — **"있는 것을 다시 짜는 것은 원칙이
아니다"** 이며, 조건은 ① 실측 골든 픽스처로 고정된 계산이고 ② 외부 의존 0 일 것이다
`[본체 src/vendor/baro-profile/VENDOR.md]`.

IDIS 드라이버는 그 조건에 맞지 않는다:

1. `.mjs` 이고 타입이 없다. 이 저장소는 `strict: true` TypeScript 이며, `allowJs` 는 켜져
   있지만 `checkJs` 는 **의도적으로 꺼져 있다** `[본체 tsconfig.json]` — 벤더링하면 드라이버
   전체가 타입 검사 밖에 놓인다. 계약 표면(`CameraDriver`)을 구현해야 하는 코드가 타입
   검사를 못 받는 것은 요구사항 2 자체를 무력화한다.
2. `capabilities.mjs`·`camera-driver.mjs`·`hucoms-camera-client.mjs`·`@baro/profile` 에
   의존한다 `[참조구현 idis-camera-client.mjs:14~18]` — **외부 의존 0 이 아니다.** 벤더링하면
   그 사슬을 전부 끌고 와야 하고, 그것은 요구사항 1(self-contained)과 정반대다.
3. 계약이 다르다. 그쪽은 `getPtzPosition/goPtzPosition({panpos,tiltpos,zoompos})`, 이쪽은
   `getPtz/goPtz({pan,tilt,zoom})` 이다. 어차피 어댑터가 필요하다.

**따라서 두 벌이 된다는 위험은 실재한다.** 완화책: ① 참조구현이 담고 있는 **실측 사실**을
이 계획의 §2·§4 표로 옮겨 적고 README 에 남긴다(사실이 코드가 아니라 문서에 정본을 갖는다),
② README 에 "상류 `baro_calory/packages/cctv-client/src/idis-camera-client.mjs` 와 **같은
기기에 대한 독립 구현**이다. 한쪽에서 실측이 갱신되면 다른 쪽도 확인할 것" 을 명시한다.

### 8-D. 사용자에게 보이는 변화

- 옵션 화면 카메라 종류에 `idis` 가 생긴다.
- IDIS 카메라에서 `/api/ptz`·`/api/ptz/absolute`·`/api/ptz/nudge`·스냅샷이 동작한다.
- 장비 프리셋 탭은 IDIS 에서 **501**(§비범위 1번).
- `/api/center` 는 기기에 `ptzMoveToPoint` 가 있으면 동작, 없으면 **501**.
- **줌 눈금 주의**: IDIS `zoom` 은 100~1200(배율×100)이라 화면의 줌 슬라이더·`nudge` 델타가
  Hucoms 눈금 기준이면 어색하게 동작한다(§비범위 2번, 확인 필요 #4).

---

## 9. 비범위 (하지 않을 것)

1. **장비 프리셋 라우트를 IDIS 로 넓히지 않는다.** IDIS 는 프리셋 **목록 조회와 이름**을
   준다 `[매뉴얼 §50:7940~7960]` `[실측 현장 16개]` — Hucoms 의
   `listing:'unsupported'`/`naming:'unsupported'` `[본체 cameraDriver.ts:16~19]` 와 다르다.
   그러나 그 두 리터럴은 **타입이 아니라 레지스트리의 설계 전제**다:
   `devicePresetRegistryStore` 는 "장비가 이름을 안 주니 우리가 저장한다"로 만들어졌고
   `[본체 domain/devicePresetRegistry.ts:48~58]`, 이름을 주는 장비가 들어오면 **장비 이름과
   로컬 이름 중 어느 쪽이 정본인가**라는 새 질문이 생긴다. 타입만 넓히면 두 이름이 조용히
   갈린다. 이는 드라이버 추가가 아니라 레지스트리 재설계이므로 별건으로 미룬다.
   **기능 자체는 서브트리 안에 완전히 구현돼 있으므로**(`listPresets`/`gotoPreset`/`setPreset`)
   다음 단계는 배선과 정본 결정뿐이다. → 확인 필요 #3
2. **기기별 도달범위(`deviceRanges`) 를 도입하지 않는다.** IDIS 줌은 100~1200 인데
   `limitedAxes()` 는 계약 상수 0~65535 로 판정하므로 `[본체 domain/ptz.ts:61~69]`,
   `/api/ptz/absolute` 가 `zoom:3000` 요청에 `limited: []` 를 답하면서 드라이버는 1200 으로
   자른다 — **"잘린 축은 숨기지 않는다" 는 약속이 이 기기에서 깨진다**
   `[본체 ptzRoutes.ts:30]`. `nudge` 델타도 같은 문제다. `baro_calory` 는 같은 사고를 겪고
   `tiltRange`/`zoomRange` 선언 + `deviceRanges(client)` 로 풀었다
   `[baro_calory/docs/cameras.md §도달범위와 정착]`. 그 도입은 도메인·라우트·화면에 걸친
   별건이다. → 확인 필요 #4
3. **소프트웨어 센터링을 구현하지 않는다** (사용자 확정).
4. **`insecureTls`·`streamIndex` 를 설정·DB 로 올리지 않는다** (확인 필요 #1). 드라이버
   옵션으로는 존재한다.
5. **표 재작성 마이그레이션을 하지 않는다** (§5-C, 확인 필요 #2).
6. **`CameraDriver` 계약을 넓히지 않는다** (§3-A) — capabilities 개념 도입 없음.
7. **매뉴얼의 나머지 60여 절을 감싸지 않는다.** 이름만 `ACTION_CATALOG` 에 싣고 호출은
   `raw()` 통로로 연다. 쓰지 않을 액션의 래퍼는 추측성 코드다(CLAUDE.md 2번).
8. **`setPreset`/`moveToPreset` 폴백을 두지 않는다** (§가정 절의 조사 결과).
9. **ONVIF 를 붙이지 않는다.** ONVIF `GetNodes` 는 절대 PTZ 공간을 노출하지 않아 역량의
   하한만 보여 준다 `[실측]`. 다만 `GetDeviceInformation` 이 벤더 중립 정체 확인의 유일한
   수단이라는 사실은 README 에 남긴다 — 이 설계는 그 자리를 `modelInformation` 으로
   대신한다(§3-D).
10. **RTSP 조립 코드를 추가하지 않는다.** `streamUrl` 이 이미 전체 URL 을 담고
    `authenticatedRtspUrl` 이 자격증명을 주입한다 `[본체 media/rtspUrl.ts]`. IDIS 규약
    `rtsp://<ip>:554/trackID=N` `[매뉴얼 §0:324~327]` 과 **N 의 코덱은 기기 설정이 정한다**
    `[실측]` 는 사실은 README 에 문서로만 남긴다.
