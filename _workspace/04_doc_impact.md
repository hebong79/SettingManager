# 04. 영향도 분석 — IDIS WebAPI v2.20 카메라 드라이버 신설 (`kind: "idis"`)

작성 2026-08-06 22:28 / 대상 `d:\Work\Parking3D\Agent\baro\SettingManager`
정본 문서: `docs/20260806_222856_IDIS카메라드라이버_신설.md`
CLAUDE.md 5번 규칙(영향도 분석). **모든 항목을 코드를 읽거나 실행해 확인했다.**

**출처 표기**: 「코드」= 파일을 읽어 확인 · 「실행」= 이번 문서화 중 **실제로 돌려** 받은 값 ·
「QA」= `_workspace/03_qa_report.md` 가 실행한 것 · 「추론」= 코드 구조로부터의 결론이며 실증하지
못한 것 · 「미확인」= 근거 없음.

---

## 0. 한눈에

| 축 | 결론 |
|---|---|
| 기존 카메라(hucoms · backend-core · park3d-rpc) | **동작 무변경.** 분기가 전부 새 `case`/새 조건으로만 들어갔다 — §1-1 에 근거 |
| 공개 응답 키 | `/api/db/cameras*` **모든 카메라에 `insecure_tls` 1키 증가**(13→14). `/api/settings`·`/api/cameras` 는 **idis 이고 켠 기기에만** `insecureTls:true` |
| 웹 화면 | `web/options.html`·`optionsDb.js` 만 수정. `dbtable.js`·`control.js`·`discovery.js` 는 **수정 없이 따라간다** |
| MCP | 도구 계약(경로·메서드) 무변경. `routeCatalog` 의 낡은 `notes` 는 **기존 문제**이며 이번 것이 아니다 |
| DB 파일 | 판 4·3 파일은 **깨끗이 올라가고 데이터가 보존된다**(실행으로 확인). 작업 중 운영 `setup.db` 가 "판만 5, 열 없음" 이 되어 서버가 뜨지 않았으나 **복구 완료(22:40, 데이터 보존)** — §2 |
| 다운그레이드 | **불가.** 판 5 파일은 옛 코드가 `DatabaseError` 로 거부한다(문구 확인함) |
| 형제 프로젝트 4곳 | **전부 파급 없음.** 근거는 §3 |
| 설계 판단 필요 | 2건 — §4 |
| QA 가 고친 기존 결함 | 1건 — §5 |

---

## 1. 이 저장소 안

### 1-1. 기존 카메라 동작이 바뀌지 않는다 — 근거

**"안 바뀐다"를 주장이 아니라 코드로 보인다.**

| 자리 | 어떻게 넣었나 | 기존 종류에 미치는 영향 |
|---|---|---|
| `src/devices/driverFactory.ts` | `switch` 에 **`case 'idis':` 블록만 추가.** hucoms·backend-core·park3d-rpc 블록은 **한 글자도 손대지 않았다** 「코드」 | **없음** |
| `src/config/normalize.ts` | `CAMERA_KINDS` 배열에 원소 추가 + `...(kind === 'idis' && r.insecureTls === true ? {…} : {})` 「코드」 | **없음** — 조건이 `kind === 'idis'` 로 잠겨 있어 다른 종류는 스프레드가 빈 객체다 |
| `src/db/configCameras.ts` `toCameraConfig` | `...(row.kind === 'idis' && row.insecure_tls ? {…} : {})` 「코드」 | **없음** — 같은 잠금. QA 가 "hucoms/park3d 는 열에 1 이 있어도 키 없음"을 시험으로 고정 「QA §3-E 고리 5」 |
| `src/db/schema.ts` | CHECK **목록에 값 추가**(제약 완화 방향) + 열 1개 추가(`DEFAULT 0`) 「코드」 | **없음** — 기존 값은 여전히 통과하고, 새 열은 기존 줄에 0 으로 채워진다 |
| `src/api/routes/dbRoutes.ts` | `KINDS` 배열 원소 추가 + `merged()` 1줄(`patch.insecure_tls === undefined ? current : …`) 「코드」 | **없음** — 생략하면 현재 값 유지 |
| `src/db/setupRepository.ts` | 열 목록·타입 확장. `(input.insecure_tls ?? existing?.insecure_tls) ? 1 : 0` 「코드」 | **없음** — 기존 호출부는 이 필드를 안 보내고 0 이 된다 |
| `src/config/types.ts` | 유니온 확장 + **선택 필드** `insecureTls?` 「코드」 | **없음** |
| `web/options.html`·`optionsDb.js` | `<option>` 2곳 · 체크박스 1개 · `draft()` 1줄 · 리스너 1항목 「코드」 | **없음** — 기존 필드 배선 무변경 |

**`driverFactory` 의 `never` 소진 검사가 이 작업의 안전망 역할을 실제로 했다** — 유니온에
`'idis'` 를 넣은 직후 `case` 를 쓰기 전 **컴파일이 깨졌다**(구현자 보고 §4-6). 즉 "유니온만
넓히고 배선을 빠뜨리는" 사고는 이 저장소에서 구조적으로 불가능하다.

### 1-2. 손대지 않았고, 그래서 동작이 유지되는 곳

| 파일 | 왜 안 건드렸나 |
|---|---|
| `src/api/routes/devicePresetRoutes.ts` | `camera.kind !== 'hucoms'` 분기가 그대로라 **IDIS 는 자동으로 501** 「코드:23,34」. 설계 비범위 1번 |
| `src/devices/cameraDriver.ts` | **계약 표면 무변경** — capabilities 개념을 도입하지 않았다 |
| `src/devices/hucoms/*` · `backendCore/*` · `park3d/*` | 기존 드라이버 무변경 |
| `src/domain/ptz.ts` | 계약 좌표 규약 무변경. IDIS 는 **자기 클램프를 갖는다** |
| `src/core/bridge/bridgeCoreProvider.ts` · `remote/remoteCoreProvider.ts` | 코어 계약 무변경 |
| `src/db/backendCoreExport.ts` | `kind` 를 전혀 다루지 않는다(grep 0건 「코드」) |
| `src/mcp/tools.ts` · `server.ts` | 도구 계약이 경로·메서드 기준이라 무영향 |

### 1-3. 알려진 한계 — `bridgeCoreProvider` 의 `center` 낙관 광고 (이번에 고치지 않음)

`typeof ctx.driver.centerPoint === 'function'` 「코드 bridgeCoreProvider.ts:79」 이므로,
**IDIS 는 기기에 `ptzMoveToPoint` 가 없어 실제로는 못 해도 `center: {ok:true}` 로 광고된다.**
`centerPoint` 를 항상 정의하고 첫 호출에서 프로브하는 설계의 필연적 결과다.

- 설계가 **감수하기로 한 것**이며(§3-F), 실제 호출 시 501 로 정직하게 거절된다.
- QA 가 이 **알려진 한계를 테스트로 그대로 고정**했다 「QA T-S5」 — 누가 고치면 그 시험이 깨져
  해소 시점이 드러난다. park3d 대조군까지 함께 박았다.

### 1-4. 공개 응답 키 — 정확히 어디가 얼마나 늘어나는가

**(A) `/api/db/cameras` 계열 — 모든 카메라에 1키 증가**

`publicCamera()` 는 `{...rest, hasPassword}` 라 `CameraRow` 에 열이 늘면 **함수를 안 고쳐도
따라온다** 「코드 dbRoutes.ts」. 그래서 **kind 와 무관하게** 전부 `insecure_tls: 0|1` 을 갖는다.

키 14: `cam_id`·`cam_name`·`cam_uuid`·`url`·`user_id`·`rtsp_url`·`cam_type`·`place_id`·
`timeout_ms`·`kind`·`park3d_cam_id`·**`insecure_tls`**·`intrinsics`·`hasPassword`.

영향 라우트: `GET /api/db/cameras` · `POST /api/db/cameras` · `PUT /api/db/cameras/:id`.
(`POST …/:id/test` 와 `DELETE` 응답은 자체 모양이라 **무변화** 「코드」.)

**(B) `/api/settings` · `/api/cameras` — idis 이고 켠 기기에만**

`kind === 'idis' && 값이 참` 일 때만 `insecureTls: true` 가 생긴다. QA 가 **다른 kind 의 키
집합이 9키에서 넓어지지 않음**을 정확 대조로, 그리고 **끄면 키가 사라지고 종류를 바꾸면 키가
사라짐**까지 고정했다 「QA §3-E 고리 6」.

**(C) 소비자 영향** 「코드」

| 소비자 | 영향 |
|---|---|
| `web/optionsDb.js` | 이름으로 필드를 읽으므로 키가 늘어도 무해. `renderEditor` 가 `camera.insecure_tls` 를 새로 읽는다(이번 수정) |
| `web/dbtable.js` (DB 탭 테이블 뷰어) | **수정 없이 따라간다** — 열 목록을 서버의 `PRAGMA table_info` 결과로 받는다 「코드 tableQuery.ts:101~105」. 화면 배지가 `13열` → `14열` 로 바뀐다 |
| `web/control.js` · `discovery.js` · `options.js` | `/api/db/cameras` 를 읽지 않는다 「코드 web/api.js」 |
| `test/database.test.ts` | 열 개수 단언 3곳·픽스처 리터럴 4곳이 깨져 **14 로 고쳤다**(단언의 뜻은 안 바꿈) |

### 1-5. MCP

- 도구 계약(경로·메서드)은 **무변경**. `src/mcp/routeCatalog.ts` 에 새 경로가 생기지 않았다.
- ⚠ **기존 문제(이번 것 아님)**: `routeCatalog` 의 `PUT /api/db/cameras/:id` notes 가 아직
  "cam_name·cam_type·place_id 만. **접속정보는 config.json 이 주인이다**" 라고 적고 있다
  「코드 routeCatalog.ts:133~134」. 접속정보 정본은 이미 DB 로 옮겨졌으므로 낡은 설명이다.
  `POST /api/db/cameras` 항목 자체도 카탈로그에 없다. **어떤 테스트도 notes 를 검사하지 않는다**
  (앞선 영향도 문서 `08_doc_impact.md` §3-2 가 같은 사실을 기록). 이번 범위 밖이라 손대지 않았다.

### 1-6. 런타임 의존성

**0 이 유지된다.** 이 드라이버는 `node:http`·`node:https`·`node:crypto` 만 쓴다 「코드」.
`package.json` 무변경 → `test/packageScripts.test.ts` 무영향.

---

## 2. DB 파일 실물 영향

### 2-1. 작업 중 사건 — 운영 `setup.db` 가 "판만 5, 열 없음" 이 됐다 (**복구 완료**)

문서화 중 발견(22:2x) → **리더가 재확인해 22:40 복구를 마쳤다.** 지금 조치할 것은 없다.
남기는 이유는 **재발 방지**다.

**그때의 상태** 「실행 2026-08-06 22:2x」:

| 확인한 것 | 값 |
|---|---|
| `PRAGMA user_version` | **5** |
| `camera_info` 열 | 13개 — **`insecure_tls` 가 없었다** |
| 현재 코드로 열면 | `DatabaseError: DB 스키마가 코드의 기대와 다릅니다 — camera_info 에 insecure_tls 가 없습니다` |
| 포트 13030 | **연결 거부** |
| `nodemon`(PID 2396, `--watch src`) | 살아 있으나 **자식 `tsx` 프로세스 없음** = 재기동이 예외로 죽었다 |

**원인(추론 · 근거 강함 · 리더 확인)**: 파일 mtime 21:36 은 구현 도중이다. `nodemon` 이 `src/`
를 감시하다가 **`SCHEMA_VERSION` 이 5 로 올라간 순간** 재기동하면서 판만 찍었고, 그 시점의
코드에는 아직 `insecure_tls`(열도 `addInsecureTls()` 도) 가 없었다. 파일의 `camera_info` 정의가
여전히 (가) 상태(ALTER 유래, `kind` CHECK 없음)인 것도 이 해석과 맞는다.

> **정상 사용자가 v4 → v5 로 올릴 때 겪는 일이 아니다**(§2-2 가 증거).
> **개발 중 판 번호가 코드보다 먼저 나간 부산물**이다.

**⚠ 재발 방지 — 이 상태는 스스로 낫지 못한다.** `migrate()` 는 `current < SCHEMA_VERSION` 일
때만 올리기 블록에 들어가므로, 판이 이미 5 면 `addInsecureTls()` 가 **영원히 실행되지 않는다**
「코드 database.ts:72」. 그래서 **판을 올릴 때는 마이그레이션 함수와 `SCHEMA_SQL` 의 열을
먼저 쓰고 `SCHEMA_VERSION` 을 마지막에 올린다.**

**이 사건이 조용히 넘어가지 않은 이유** — `verifySchema()` 가 **판올림 여부와 무관하게 항상
돈다** 「코드 database.ts:95~97」. 그 덕에 파일이 조용히 열려 한참 떨어진 자리에서 `undefined`
로 새는 대신 **기동 시 한국어 오류 한 줄로 즉시** 드러났다. `database.ts:96` 의 주석이 이
실패 모드를 이미 예고하고 있었다 — "판이 이미 최신이라 위를 통째로 건너뛴 파일이 이번 사고의
모습이었다 — **판만 맞고 열은 없었다**". **가드는 잡기만 하고 고치지는 않는다**(명시적 철학).

**실제 복구 — 권고안 A** 「리더 실측 2026-08-06 22:40」:

| 단계 | 내용 |
|---|---|
| 1 | `config/setup.db` → `setup.db.bak-before-v5-repair-20260806_224028` 로 백업 |
| 2 | `PRAGMA user_version = 4` |
| 3 | `openDatabase()` 로 **실제 마이그레이션 경로를 태움** |
| 결과 | `user_version = 5` · **`insecure_tls` 열 존재** · **카메라 5대 보존** |

**교차 확인** 「실행 22:4x」 — 복구 뒤 따로 조회했다: `user_version = 5` · `camera_info` **14열**
· `insecure_tls` 있음 · 카메라 5대 · 프리셋 9건. `GET /api/settings` 가 **HTTP 200** = 서버 정상.
(WAL/SHM 파일이 잠겨 있는 것도 서버가 DB 를 쥐고 있다는 증거다.)

**왜 A 인가** — 마이그레이션 코드가 스스로 열을 붙이므로 정의가 코드와 어긋날 여지가 없다.
(대안 B `ALTER TABLE camera_info ADD COLUMN insecure_tls INTEGER NOT NULL DEFAULT 0` 도 내가
사본에서 돌려 성공했고 카메라 5대를 보존했지만, 열 정의를 사람이 손으로 적는다는 점에서 A 보다
못하다 「실행」.) 이전 작업의 백업 세 벌도 그대로 있다(`bak-20260806_before-presets` 판4 ·
`bak-20260806_before-v4` 판3 · `bak-20260806_v3` 판3).

### 2-2. 정상 판올림은 문제가 없다 — 백업 두 벌로 실행 확인 「실행」

| 파일 | 전 | 후 | 데이터 |
|---|---|---|---|
| `setup.db.bak-20260806_before-presets` | 판 4 | 판 5 · `insecure_tls` 생성 | 카메라 5대 · 프리셋 2건 **보존** |
| `setup.db.bak-20260806_v3` | 판 3 (`cam_company` 있음) | 판 5 · `cam_company` 제거 · `insecure_tls` 생성 | 카메라 4대 · 프리셋 2건 **보존** |

즉 **사용자가 이 판올림에서 겪는 일은 "아무 일도 안 일어난다"** 이다 — 서버를 띄우면 열이
조용히 붙고 기존 값은 그대로다. `ADD COLUMN` 은 기존 줄을 건드리지 않는다.

### 2-3. 사용자가 겪는 유일한 새 실패 경로 — (다) 상태 파일

**옛 판의 `SCHEMA_SQL` 이 새로 만든 v3/v4 파일**(= 옛 `kind` CHECK 가 표 정의에 박힌 파일)은
서버 기동 시 다음으로 **명시적으로 거절**된다 「코드 database.ts:197~200」 「QA T-DB3」:

```
DatabaseError: 이 DB 파일의 camera_info.kind 제약이 idis 를 허용하지 않습니다 —
옛 판으로 새로 만들어진 파일입니다. 표 재작성이 필요합니다(설계 §5-C).
현재 제약: CHECK (kind IN ('hucoms', 'backend-core', 'park3d-rpc'))
```

**이것은 개선이다** — 가드가 없으면 사용자가 옵션 화면에서 IDIS 카메라를 저장하는 순간 해독
불가능한 `SQLITE_CONSTRAINT` 를 만난다. 다만 **자동 복구는 하지 않는다**(연쇄 삭제 위험 —
정본 문서 §7-4). 운영 DB 는 (가) 상태라 이 경로에 걸리지 않는다 「실행으로 확인」.

### 2-4. 되돌리기(다운그레이드) — **불가**

판 5 파일을 판 4 만 아는 코드로 열면 `migrate()` 가 던진다 「코드 database.ts:65~70」.
같은 코드 경로를 판 6 파일로 실제로 밟아 문구를 확인했다 「실행」:

```
DatabaseError: DB 스키마 판(6)이 이 코드가 아는 판(5)보다 높습니다 — 더 새로운 SettingManager 로 여십시오
```

즉 **코드를 되돌리려면 DB 도 함께 되돌려야 한다.** 방향별 정리:

| 방향 | 결과 |
|---|---|
| 판 3·4 파일 + 새 코드 | ✅ 자동으로 5 로 올라간다. 데이터 보존 |
| 판 5 파일 + **옛 코드** | ❌ **열리지 않는다.** 백업으로 되돌려야 한다 |
| 판 5 파일 + 새 코드 | ✅ 정상 |
| 판 5 인데 `insecure_tls` 없음 | ❌ **열리지 않는다.** §2-1 의 사건이 이 경우였고 A 로 복구했다 |

`ADD COLUMN` 은 되돌릴 수 없다 — `insecure_tls` 를 지우려면 표 재작성이 필요하고, 그건 이
설계가 위험하다고 판정한 바로 그 작업이다.

---

## 3. 형제 프로젝트 파급 — **4곳 전부 없다**

실제로 각 저장소를 grep 해서 확인했다(검색어: `cam_company`·`camera_info`·`setup.db`·
`/api/db/cameras`·`/api/settings`·`CameraKind`·`park3d-rpc`·`hucoms`·`idis`·`insecure_tls`·
`insecureTls`·`kind`).

### 3-1. `d:\Work\Parking3D\AgentVLA\ParkAgent` (`SettingAgent` 포함) — **파급 없음**

| 검색어 | 결과 |
|---|---|
| `CameraKind` · `idis` · `insecure_tls` · `insecureTls` · `setup.db` · `/api/db/cameras` | **0건** |
| `camera_info` · `cam_company` | 28건이나 **자기 표다** — `SettingAgent/src/capture/SqliteStore.ts:75~85` 의 `camera_info` 는 `cam_company TEXT`(자유 텍스트)를 갖고 `kind` CHECK·`insecure_tls` 가 없다. **스키마가 다르다.** DB 파일도 `tools.capture.dbFile`(`src/index.ts:63`)로 별도 주입 — **물리적으로 같은 `setup.db` 가 아니다** |
| `park3d-rpc` | 문서 4곳. 언리얼 **MCP 서버 이름**(`park3d-rpc-mcp/server.py`)이며 `CameraKind` 값과 **문자열만 우연히 같다** |
| `hucoms` | ParkAgent 자체 `src/clients/hucoms/`(TS). IDIS 변경과 접점 없음 |

**결론: 없음.** 두 저장소는 카메라 스키마를 각자 갖고 있고 DB 파일도 분리돼 있다.

### 3-2. `d:\Work\Parking3D\Parking3D` (Unity · `NetworkREST`) — **파급 없음**

검색어 **12개 전량 0건**. `SettingManager`·`SettingMain`·`baro_calory` 도 0건.
디렉토리 실체는 `CCenteriseLogger.cs`·`CWebCamCtrlServer(Host).cs`·`CWebCenteriseClient.cs`·
`CWebCenteriseHelper.cs` + API 명세 md 1개뿐이다.

**결론: 없음.**

### 3-3. `d:\Work\Parking3D\Agent\baro\baro_calory` — **런타임 결합 없음. 단, 관찰 대상**

| 확인 | 결과 |
|---|---|
| `packages/cctv-client/src/idis-camera-client.mjs` · `http-transport.mjs` | **존재한다**(이번 구현의 참조원) |
| SettingManager 가 import/복사하는가 | **아니다.** `grep -rn "from.*baro_calory" src/` **0건**, `package.json` 에 `cctv-client`·`@baro`·`baro_calory` 의존성 **없음** |
| 해시 고정 대상인가 | **아니다.** `src/vendor/baro-profile` 은 `packages/profile` 7파일을 복사해 sha256 으로 고정하지만(`test/vendorProfile.test.ts`), 그건 **화각 계산 패키지**이고 IDIS 와 별개다 |
| 공통 사양 | IDIS WebAPI v2.20 매뉴얼 PDF(baro_calory 소재)를 **양쪽이 인용**한다. 코드 결합이 아니라 문서 인용 |

**결론: 코드 파급 없음.** 그러나 **두 벌이 된다는 위험은 실재하며 이미 문서로 인정했다** —
`src/devices/idis/README.md` 「상류와의 관계」: "같은 기기에 대한 독립 구현이다. **한쪽에서
실측이 갱신되면 다른 쪽도 확인할 것.**"

**이번 작업이 상류보다 나아진 자리 4곳**(상류에 역반영을 검토할 가치가 있다):

1. `param`(301/302/304)을 프로브에서 **'있음'으로 읽는다** — 상류는 `returnCode !== 0` 을 전부
   "없음"으로 읽어 §58·§59 지원 기기에서 **거짓 음성**을 낸다.
2. 능력 **상한에 `pixelCentering`/`boxZoom` 을 넣는다** — 상류는 실측기 한 대의 사실을 벤더
   전체 상한으로 옮겨 적어 **있는 기능을 스스로 버린다.**
3. Digest 챌린지 파서에 **앞 경계**(`(?:^|[\s,])`)를 넣었다 — 상류 정규식은 `nonce` 를 찾다가
   `cnonce` 를 잡을 수 있고, `qop="auth,auth-int"` 를 `auth` 에서 자른다(우연히 맞는 동작이었다).
4. `algorithm≠MD5`·`qop` 에 auth 없음이면 **던진다** — 조용히 MD5 로 계산하면 401 만 돌아오고
   원인이 인증 방식이라는 사실이 어디에도 드러나지 않는다.

### 3-4. `Sub/HyucomsAPI` (Python) — **파급 없음**

- 경로가 **둘**이다: `SettingManager/Sub/HyucomsAPI` 와 `AgentVLA/ParkAgent/Sub/HyucomsAPI`.
- `.gitmodules` **없음** = 서브모듈이 아니라 각자 벤더링된 사본이며, `diff -rq` 결과
  `__pycache__` 제외 **바이트 단위로 동일**하다. 즉 **한쪽을 고쳐도 다른 쪽에 자동 반영되지
  않는다**(이번 변경과 무관한 기존 사실이지만 기록해 둔다).
- 그 안에서 `idis|insecure_tls|insecureTls|CameraKind` grep **0건**.

**결론: 없음.** Hucoms 프로토콜 전용 Python 패키지다.

### 3-5. 종합

| 대상 | 파급 | 근거 |
|---|---|---|
| ParkAgent / SettingAgent | **없음** | 자체 카메라 스키마·자체 Hucoms 클라이언트. DB 파일 분리 |
| Parking3D (Unity) | **없음** | 검색어 12개 전량 0건 |
| baro_calory | **없음(런타임)** | import·복사 0건. 단 **독립 구현 두 벌**이라 실측 갱신 시 수동 확인 필요 |
| Sub/HyucomsAPI | **없음** | Hucoms 전용, 접점 0건 |

**결합 방식은 셋뿐이다**: ① 우연한 문자열 동명이인(`park3d-rpc`), ② 공통 사양 문서 인용(IDIS
매뉴얼, `my_db_table.md`), ③ 단방향 참고 구현(baro_calory). **실제 코드 import·공유 DB 파일·
API 계약 결합은 어디에도 없다.**

---

## 4. 미해결 — 설계 판단이 필요한 2건

### 4-1. `portPairWarning` 이 IDIS 에 근거 없는 "제어 + 10" 경고를 띄운다

계획 T-UI2 의 기대(빈 문자열)가 **성립하지 않는다.** QA 가 함수 본문을 떼어 내 **실제로
평가**했다 「QA §5」:

| 입력 | 결과 |
|---|---|
| `('http://h:80', 'rtsp://h:554/trackID=1', 'idis')` | `''` |
| **`('http://h:8000', 'http://h:8080/stream', 'idis')`** | **`' ⚠ 제어 8000 의 영상 포트는 8010 입니다 …'`** |
| **`('https://h:8443', 'http://h:8080/stream', 'idis')`** | **`' ⚠ 제어 8443 의 영상 포트는 8453 입니다 …'`** |

**핵심 — 빈 문자열이 나오는 것도 규칙이 아니라 우연이다** 「QA 판정」:

1. IDIS 제어는 보통 80/443 인데 `new URL().port` 가 **기본 포트를 지워** `controlPort = 0` 이
   되고 함수가 `if (!controlPort || !streamPort) return ''` 에서 빠져나간다.
2. IDIS 영상은 보통 `rtsp://` 라 첫 관문 `/^https?:\/\//` 에서 빠져나간다.

둘 중 **하나라도 어긋나면**(비기본 포트 IDIS + MJPEG 중계) `kind === 'park3d-rpc'` 분기를 지나
**UE 시뮬레이터 직결 전용 규칙**으로 떨어진다. **화면이 사용자에게 없는 규칙을 지키라고 시킨다.**

**고치지 않은 이유**: "IDIS 의 올바른 포트짝 규칙은 무엇인가"의 답이 **"규칙이 없다"** 이고,
그러면 폴백 갈래를 kind 별로 갈라야 한다 — **UI 경고 규칙의 계약 변경**이며 `hucoms`·
`backend-core` 의 기존 동작에도 영향이 간다. 요청은 드라이버 추가다.

**대신 느슨하게 덮지 않았다** — `toBe('')` 같은 관대한 단언 대신 **틀린 문구를 문자열 그대로**
박았고, IDIS 와 hucoms 의 반환값이 **같음**도 단언해 원인이 **공유 폴백 갈래**임을 못박았다.
누가 고치는 순간 시험이 깨지고 그때가 해소 시점이다.

> **판단 필요**: 폴백 갈래를 `hucoms`·`backend-core` 로 좁히고 그 밖에는 `''` 를 돌려줄 것인가.

### 4-2. `POST` 는 camelCase, `PUT` 은 snake_case 를 읽는다 — **이번 작업이 만든 결함이 아니다**

| 본문 | 저장된 `insecure_tls` |
|---|---|
| `POST {cam_uuid, kind:'idis', insecure_tls:true}` | **0** (무시됨) |
| `POST {cam_uuid, kind:'idis', insecureTls:true}` | 1 |
| `PUT {insecure_tls:true}` | 1 |

「QA §4-3 — 라이브 서버에 실제로 쏴서 확인」

원인 「코드」:
- `POST /api/db/cameras` → `normalizeCamera({...body, id})` → **camel** (`dbRoutes.ts:86`)
- `PUT /api/db/cameras/:id` → `merged(current, patch)` → **snake** (`dbRoutes.ts:235`)

> **리더 확인 결과 — 기존 `camId`/`park3d_cam_id` 도 정확히 같은 비대칭이다.**
> `normalizeCamera` 는 `camId`(camel)를 읽고(`normalize.ts:76`) `merged()` 는
> `park3d_cam_id`(snake)를 읽는다(`dbRoutes.ts:234`). **`insecureTls` 는 저장소의 기존 관례를
> 그대로 따랐을 뿐**이며, 이번 작업이 새로 만든 결함이 아니다.

**고치지 않은 이유(외과적 변경 원칙 — CLAUDE.md 3번)**: 넓힐지(POST 도 snake 를 읽기) 좁힐지는
**계약 판단**이고, 제대로 고치려면 `camId` 를 포함한 모든 필드를 함께 손대야 한다. 요청은
드라이버 추가지 REST 본문 계약 정리가 아니다. **변경된 모든 줄이 사용자의 요청으로 직접
추적될 수 있어야 한다**는 기준에 어긋난다.

**지금은 사고가 안 난다** — 화면의 「+ 기기 추가」는 `{cam_uuid, kind, label}` 만 보내고 나머지는
전부 PUT 으로 채운다(그 사실도 시험으로 고정). 현재 동작을 `[기록]` 케이스로 사실대로 고정했다.

> **판단 필요**: 저장소 전반의 본문 키 표기를 어느 쪽으로 통일할 것인가(별건).

### 4-3. (참고) 아직 열려 있는 설계 확인 항목

| # | 사안 | 현재 |
|---|---|---|
| 확인 필요 #3 | 장비 프리셋 라우트를 IDIS 로 넓힐 것인가 | **501 유지.** 기능은 서브트리에 완전 구현돼 있고 남은 것은 배선 + **"장비 이름 vs 로컬 이름 중 어느 쪽이 정본인가"** 결정 |
| 확인 필요 #4 | 줌 눈금 차이로 `/api/ptz/absolute` 의 `limited` 가 부정확 · `nudge` 델타 부적합 | **범위 밖.** `limitedAxes()` 가 계약 상수로 판정하므로 `zoom:3000` 요청에 `limited:[]` 를 답하면서 드라이버는 1200 으로 자른다 — **"잘린 축은 숨기지 않는다"는 약속이 이 기기에서 깨진다** |

---

## 5. QA 가 고친 기존 결함 1건 — `openDatabase()` 의 DB 핸들 누수

**이번 작업 범위 밖이었으나 검증 자체를 막아서 고쳤다.** 경위 「QA §4-1」:

1. QA 가 (다) 상태 픽스처를 `openDatabase({path})` 로 여는 T-DB3 케이스를 만들었다.
2. `verifyCameraKindConstraint` 가 `DatabaseError` 를 던진다 — **의도한 동작이다.**
3. 그런데 **핸들이 닫히지 않는다.** Windows 에서 그 파일을 지우지도 옮기지도 못한다:
   `Error: EBUSY: resource busy or locked, unlink '…\old-schema.db'`
   — **QA 첫 실행에서 실제로 5건이 이 오류로 깨졌다.**
4. **이번 변경이 만든 결함은 아니다**(`verifySchema` 도 던지므로 이전부터 있었다). 그러나
   **새 가드가 이 경로를 일상적으로 도달 가능하게 만들었고**, 하필 그 상황이 "사람이 DB 파일을
   손봐야 하는" 상황이라 **파일이 잠기면 손쓸 방법까지 막힌다.**
5. **조치**: `src/db/database.ts:46~54` 를 `try/catch` 로 감싸 실패 시 `db.close()` 후 재던짐.
   **4줄이고 성공 경로는 동일하다.** 회귀 시험("던진 뒤에도 그 파일을 지울 수 있다")을
   `test/idisDatabase.test.ts` 에 남겼다.
6. 이 수정으로 기존 `test/database.test.ts` 를 포함한 **어떤 시험도 새로 깨지지 않았다** 「QA」.

**이것이 "검증을 막는 결함만 고치고 그 사실을 남긴다"의 사례다** — 발견한 다른 결함 2건(§4)은
고치지 않고 기록만 했다.

---

## 6. 영향 받는 파일 — 전체 목록

### 신규 (소스 9)
`SettingMain/src/devices/idis/` — `README.md` · `contract.ts` · `idisConstants.ts` ·
`digest.ts` · `idisTransport.ts` · `idisReply.ts` · `idisCoords.ts` · `idisCamera.ts` · `index.ts`

### 신규 (테스트 9 · 194건)
`SettingMain/test/idis{Coords,Reply,Digest,Transport,Camera,Database,InsecureTls,ServerRoutes,NormalizeUi}.test.ts`

### 수정 (소스 8)
`src/config/types.ts` · `src/config/normalize.ts` · `src/db/schema.ts` · `src/db/database.ts` ·
`src/db/setupRepository.ts` · `src/db/configCameras.ts` · `src/api/routes/dbRoutes.ts` ·
`src/devices/driverFactory.ts`

### 수정 (화면 2 · 테스트 1)
`web/options.html` · `web/optionsDb.js` · `test/database.test.ts`

### 삭제 1
`SettingMain/test/idisSmoke.test.ts` — 구현자 자기 확인용. QA 가 23건 전부 흡수 후 삭제

### 동작이 달라지지만 **수정 없음** (전부 코드로 확인)
- `web/dbtable.js` — 열을 서버가 답하므로 `14열` 로 자동 표시
- `src/api/routes/devicePresetRoutes.ts` — IDIS 는 자동으로 501
- `src/core/bridge/bridgeCoreProvider.ts` — IDIS 에 `center:{ok:true}` 를 낙관 광고(§1-3)
- `src/db/tableQuery.ts` — `PRAGMA table_info` 기반이라 새 열이 그대로 보인다

### 데이터
- `SettingMain/config/setup.db` — ⚠ **§2-1 의 복구 필요**
- 백업 3벌은 손대지 않았다

### 손대지 않음
`cameraDriver.ts` · `hucoms/*` · `backendCore/*` · `park3d/*` · `domain/ptz.ts` ·
코어 제공자 2개 · `backendCoreExport.ts` · `mcp/*` · `package.json`

---

## 7. 리더·마스터 판단이 필요한 것 (우선순위 순)

1. ~~운영 `setup.db` 복구~~ — **처리 완료**(리더, 22:40, 권고안 A, 데이터 보존). §2-1 참조.
2. **`portPairWarning` 폴백 갈래를 kind 로 좁힐 것인가** (§4-1) — UI 경고 계약 변경.
3. **본문 키 표기(camel vs snake) 통일** (§4-2) — 저장소 전반 관례. `camId` 부터 얽혀 있다.
4. **기존 실패 20건 정리** — 상시 빨간 상태라 **다음 회귀가 이 노이즈에 묻힌다.**
5. **실기 IDIS 카메라 확보** — 정본 문서 §11 의 9건은 목으로 닫히지 않는다. 특히
   `modelInformation` 의 HTTP 메서드가 틀리면 **프로브 전체가 죽는다.**
6. **장비 프리셋 라우트 확장 여부**(확인 필요 #3) · **기기별 도달범위 도입**(확인 필요 #4).
7. **스키마 판올림 순서 규칙을 관례로 못박을 것인가** (§2-1) — 마이그레이션 함수·열을 먼저,
   `SCHEMA_VERSION` 은 마지막에. 이번 사건의 재발 방지책이다.
