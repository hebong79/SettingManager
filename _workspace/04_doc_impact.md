# 04 영향도 분석 — Park3D RPC 카메라 드라이버(`kind: "park3d-rpc"`) 신설

- 작성: 문서화·영향도 분석가(documenter), 2026-08-05 00:36:51
- 본 문서: `docs/20260805_003651_Park3D_RPC_카메라드라이버_신설.md`
- 근거: 실제 코드(`git diff` + 파일 직접 확인) + `_workspace/03_qa_report.md`
- 모든 파일:라인은 **문서 작성 시점의 실제 코드**로 재확인했다(QA 리포트와 라인이 1 다른 항목은 실제 코드 기준으로 정정했다 — `ptzRoutes.ts` 25·43).

---

## 1. 이 저장소에서 실제로 바뀐 것

| 파일 | 변경 성격 | 파급 |
|---|---|---|
| `SettingMain/src/devices/park3d/park3dRpcClient.ts` (신규) | 드라이버 1종 추가 | `driverFactory` 만이 유일한 진입점. 다른 모듈은 `CameraDriver` 인터페이스로만 본다 |
| `src/config/types.ts:13` | `CameraKind` 유니온 확장 | **공유 도메인 타입 변경** — §2 참조 |
| `src/config/types.ts:31-32` | `CameraConfig.camId?: number` 추가 | 선택 필드라 기존 설정과 하위호환 |
| `src/config/normalize.ts:5,29-32,47,59` | `CAMERA_KINDS` 확장 + `positiveInt()` 로 `camId` 조건부 탑재 | `camId` 는 **유효할 때만 키가 생긴다** → 공개 응답 키 집합 불변 |
| `src/devices/driverFactory.ts:5,30-38` | `case 'park3d-rpc'` | `default:` 의 `const unknown: never`(`:40`)가 누락 시 컴파일 오류로 잡는다 |
| `config/config.json` (git 미추적) | `simulator-2` 정정 | §5 사용자 조치 |
| `config/config.example.json` | park3d-rpc 예시 1건 추가 | 새 클론의 출발점 |
| `web/options.js:79,86,96,99` | `portPairWarning` 에 3번째 인자 `kind` + park3d-rpc 조기 반환 | 인자가 늘었으나 **옛 2인자 호출도 그대로 동작**(kind `undefined` → 기존 경로) |

**타입 유니온 확장의 전파 경로** — `CameraKind` 를 넓히면 컴파일러가 소진 검사 지점을 전부 짚어 준다.
실제로 짚힌 곳은 `driverFactory.ts:40` **한 곳뿐**이었고(`npm run typecheck` 통과), `kind` 를 런타임에 분기하는 지점은
`grep` 전수 조사 결과 `devicePresetRoutes.ts:23,34` 와 `web/options.js` 가 전부다. **park3d-rpc 를 모르는 채 남은 분기는 없다.**

---

## 2. 바뀌지 않았지만 **자동으로 영향을 받는** 지점

코드를 한 줄도 안 고쳤는데 새 종류가 추가된 것만으로 동작이 결정되는 곳이다. 놓치기 쉬우므로 근거와 함께 남긴다.

| 지점 | 자동으로 일어나는 일 | 코드 근거 |
|---|---|---|
| 장비 프리셋 | park3d-rpc 카메라는 **501 로 자동 배제**된다. RPC 호출은 0회(네트워크 이전에 걷어낸다) | `src/api/routes/devicePresetRoutes.ts:23` (`/api/device-preset-capability`), `:34` (`/api/cameras/{id}/device-presets`) — 둘 다 `camera.kind !== 'hucoms'` → `HttpError(501)` |
| 코어 능력 광고 | `center` 능력이 **자동으로 `ok:false`** 가 된다(사유: "이 카메라 드라이버는 픽셀 센터링을 지원하지 않습니다") | `src/core/local/localCoreProvider.ts:54` `typeof ctx.driver.centerPoint === 'function'`, `:60` 사유 문구, `:72-73` 실제 호출 시 `CoreUnsupportedError` |
| 영상 파이프라인 | `streamUrl` 이 `http://` 라 `http-mjpeg` 로 **그대로 중계**된다. 드라이버(스냅샷 폴링)를 타지 않는다 | `src/media/frameSource.ts:20-24`(`streamTransportFor`), `:27-41`(http-mjpeg 분기), `:42-43`(폴링은 default 뿐) |
| MJPEG 인증 | `username` 이 비어 있어 쿼리도 붙지 않고 **있는 그대로 GET** 한다 | `src/media/httpMjpeg.ts:21,31` (`username &&` 가드) |
| 연결 테스트 | `POST /api/cameras/{id}/test` 가 새 드라이버의 `getPtz()` → `toView()` 를 그대로 쓴다. 새 배선 없음 | `src/api/routes/settingsRoutes.ts:76,78` |
| MCP 라우트 카탈로그 | **갱신 대상 아님.** 새 REST 라우트를 만들지 않았다 | `test/mcpServer.test.ts` 가 `src/api/routes/*.ts` 선언 경로만 스캔 — 그린 유지 |
| 웹 제어 화면 | `camera.kind` 를 문자열로 표시만 한다. 분기 없음 | `web/control.js:35-38` (`showKind`) |

### 2-1. ⚠ 자동으로 따라오지 **못한** 지점 = 미해결 결함 1건 (중간)

| 지점 | 문제 |
|---|---|
| `src/api/routes/ptzRoutes.ts:25` (`limitedAxes(requested)`) / `:43` (nudge 의 `limited`) | 공유 `ZOOM_RANGE = [0, 65535]`(`src/domain/ptz.ts:29`, **Hucoms 값**)로만 판정한다. park3d-rpc 의 실제 유효범위 `[100, 3600]` 은 드라이버 안(`park3dRpcClient.ts:77`)에만 있어 라우트가 알지 못한다 |

결과: **park3d-rpc 에서 줌이 잘려도 `limited: []` 로 나간다.** `ptzRoutes.ts:29` 가 명시한
*"잘린 축은 숨기지 않는다 — 착지가 어긋났다는 유일한 신호다"* 원칙이 **이 종류에서만 깨진다.**

- 구현 실수가 아니라 **설계 계약의 빈틈**이다 — 결정 D1("단위·범위를 드라이버에 가둔다")의 대가.
- 완화: 응답의 `ptz` 는 `waitForSettle` 로 장비에서 되읽은 값이라 **숫자로는 확인 가능**하다. 조용한 오동작이지 데이터 손상은 아니다.
- **상태: 사용자 판단 대기 중** (고칠지 / 알려진 한계로 둘지). 선택지는 본 문서 §7 참조.

---

## 3. 형제 프로젝트 파급 — `AgentVLA/ParkAgent/SettingAgent`

### 3-1. 코드 의존은 **없다** (복제 관계)

두 저장소는 서로를 import 하지 않는다. `SettingAgent/src/clients/CRpcClient.ts`·`RpcCameraClient.ts` 를
**참고해서 같은 계약을 다시 구현**했을 뿐이다. 따라서 이번 변경으로 `SettingAgent` 가 깨지는 일은 없다.
반대로 Park3D 서버 계약이 바뀌면 **양쪽을 따로 고쳐야 한다**(중복의 대가).

### 3-2. ⚠ 같은 서버를 동시에 조작한다 — 런타임 상호 간섭

| | SettingManager (이 저장소) | SettingAgent (형제) |
|---|---|---|
| 대상 | `http://192.168.0.125:13510` — `config/config.json` `simulator-2` | `http://192.168.0.125:13510` — `config/tools.config.json:123`, id 도 `simulator-2` |
| 인증 | 없음 | `X-Park3D-Token` (`src/viewer/sourceRegistry.ts:29`), 토큰은 `rpcTokenEnv: "PARK3D_RPC_TOKEN"`(`tools.config.json:126`) → `resolveRpcToken()`(`src/config/toolsConfig.ts:296-301`) |

**Park3D 카메라 상태는 서버가 들고 있는 단일 상태다.** 두 프로젝트가 동시에 떠 있으면:

- 한쪽이 `cam.setPTZ` 로 PTZ 를 움직이면 **다른 쪽 화면(`/stream`, 스냅샷, PTZ 숫자)이 같이 바뀐다.**
- 이 저장소의 `waitForSettle`(연속 읽기로 정지 판정)이 **다른 프로세스가 움직이는 카메라** 때문에 "안 멈춤"으로 오판할 수 있다.
- 이 저장소의 `CameraLeaseRegistry`(`localCoreProvider`) 는 **자기 프로세스 안에서만** 유효한 락이다. 서버 차원의 배타 제어가 아니다.
- 증상은 "내가 안 건드렸는데 카메라가 움직인다"로 나타난다. **디버깅 전에 다른 쪽이 떠 있는지부터 확인할 것.**

### 3-3. 인증 정책 차이는 의도된 것이다

형제 쪽 주석은 *"토큰이 서버에 설정돼 있으면 루프백조차 검사하므로 미첨부 시 모든 호출이 401"* 이라고 적는다.
즉 형제는 **토큰이 켜진 서버까지 다룰 수 있게** 만들어 둔 것이고, 이 저장소는 **지금 이 서버가 무인증임을 실측하고 배선하지 않았다.**
`SettingAgent` 코드를 보고 "여기에도 토큰이 빠졌다"고 판단하면 오해다.
서버가 토큰을 켜면 이 저장소는 `park3dRpcClient.ts:141-143` 의 `!res.ok` 분기에서 **HTTP 401 오류로 즉시 드러난다.**

### 3-4. 다른 형제 프로젝트

`AgentVLA/ParkAgent` 하위의 다른 모듈, `Parking3D`(Unity) 쪽에는 **영향 없음**. 이 저장소의 타입·REST 계약을 공유하지 않는다.

---

## 4. ⚠ `baroCCTVSimulator` 와 Park3D 는 **다른 시뮬레이터**다 — 이번 버그의 뿌리

| | baroCCTVSimulator | Park3D |
|---|---|---|
| 정체 | Hucoms CGI 를 **모사하는** UE 플러그인 | 언리얼 **Park3D JSON-RPC 서버** |
| 프로토콜 | `GET /cgi-bin/control/...` (Hucoms CGI) | `POST /rpc` (JSON-RPC 2.0) |
| 포트 | 제어 8081 / 영상 8091 (**영상 = 제어 + 10**) | 제어·영상 **모두 13510** (`/rpc`, `/stream`) |
| 이 저장소의 `kind` | `hucoms` | `park3d-rpc` |
| 예시 | `config.json` `simulator-1` (`192.168.0.22:8081`, label `"UE 시뮬 1 (8081)"`) | `simulator-2` (`192.168.0.125:13510`) |

**둘 다 "UE 시뮬"이라 불리는 것**이 혼동의 원인이다. `simulator-2` 가 `kind:"hucoms"` 로 등록됐던 것도 이 때문이고,
그래서 Hucoms CGI 경로를 두드려 404 가 났다.

파생 영향 하나 — `web/options.js:92` 의 포트짝 경고("영상 포트 = 제어 포트 + 10")는 **baroCCTVSimulator 규칙**이다.
Park3D 에 그대로 적용하면 `13510 → 13520` 을 요구하는 **거짓 경고가 항상 뜨고**, 그러면 진짜 경고까지 무시하게 된다.
그래서 `options.js:99` 에 kind 게이트를 넣었다. 다른 kind 의 경고 로직은 한 줄도 바꾸지 않았다(검증자가 `new Function` 으로 실제 평가해 확인).

---

## 5. 설정 파일 파급 — 기존 사용자에게 필요한 조치

`SettingMain/config/config.json` 은 **git 미추적**이다(`.gitignore:8` — `git check-ignore` 로 확인).
따라서 이 저장소를 이미 쓰고 있는 사람의 `config.json` 은 **자동으로 고쳐지지 않는다.**

### 조치가 필요한 경우: `192.168.0.125:13510`(Park3D)을 등록해 둔 사용자

`config.json` 의 해당 카메라를 손으로 이렇게 고친다.

```jsonc
"kind":      "hucoms"                          → "park3d-rpc"
"streamUrl": "http://192.168.0.125:13510"      → "http://192.168.0.125:13510/stream"
"camId":     (없음)                            → 1        // 1-based 필수
"controlUrl":"http://192.168.0.125:13510"        (그대로 — 경로 접미사 금지)
```

- **`camId` 를 빠뜨리면** 조작 시점에 `400` — "camId 를 설정하세요"가 뜬다(임의로 1번을 움직이지 않는다).
- **`controlUrl` 에 `/rpc` 나 `/stream` 을 붙이면** `/stream/rpc` 로 조립돼 404 가 난다.
- `username`/`password` 는 **비워 둔다.** 이 종류는 인증을 쓰지 않으며, 값이 있으면 MJPEG URL 에 불필요한 쿼리가 붙는다(`httpMjpeg.ts:31`).

### 조치가 **불필요한** 경우

- Hucoms·backend-core 카메라만 쓰는 사용자 — 스키마가 **하위호환**이다. `camId` 는 선택 필드이고, 없으면 키 자체가 생기지 않는다.
- `config.json` 에 옛 `token` 키가 남아 있어도 **조용히 버려진다**(정규화가 모르는 키를 싣지 않는다).
- 새로 클론하는 사람 — `config.example.json` 에 park3d-rpc 예시가 들어 있다(`_comment` 로 무인증·같은 포트·camId 1-based 설명 포함).

### API 계약 파급

- `GET /api/settings` 응답에 `camId` 가 **값이 있는 카메라에만** 실린다. 없는 카메라의 키 집합은 그대로라
  `test/server.test.ts:154` 의 공개 키 집합 검사(`controlUrl·hasPassword·id·kind·label·streamUrl·timeoutMs·username`)가 **손대지 않고 그린**이다.
- `PUT /api/settings` 왕복에서 `kind`·`camId` 가 유지된다(HTTP 레벨 검증 완료).
- 옵션 화면에 **kind·camId 입력칸을 추가하지 않았다.** `config.json` 직접 편집으로만 바뀐다.

---

## 6. 검증 현황 (있는 그대로)

문서 작성 시점에 `SettingMain/` 에서 직접 재실행한 결과:

```
Test Files  1 failed | 22 passed (23)
     Tests  1 failed | 336 passed (337)
```

- 착수 기준선 **291 pass / 1 fail** → 최종 **336 pass / 1 fail / 0 skip**. 회귀 0건.
- 실패 1건은 **범위 밖 선행 실패**다: `test/powershellSafeDiagnostic.test.ts` 가
  `git status` 상 **삭제(D)** 상태인 `scripts/test-settingmanager-safe.ps1` 을 읽어 ENOENT.
  (`scripts/run-hermes-role.ps1`·`setup-hermes-role-profiles.ps1` 도 삭제 상태다 — 별건이나 인지 필요.)
- `npm run typecheck` 통과.

**미검증(⛔ "동작 확인 완료"가 아님)**: `cam.setPTZ` 실기 이동(카메라가 실제로 움직여 승인 대기),
Park3D 의 zoom·tilt 실제 도달범위, 브라우저 화면 확인.
특히 **tilt** — 공유 `TILT_RANGE=[-2000,9000]`(`ptz.ts:28`)은 Hucoms 값이라 Park3D 가 그 밖을 지원하면 왕복이 깨진다.
현재 실제 카메라 2대는 tilt 20.1° / 6.0° 로 범위 안이라 드러나지 않는다.
