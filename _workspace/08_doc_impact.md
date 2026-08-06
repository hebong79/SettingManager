# 08. 영향도 분석 — DB 마이그레이션 수정(v3) + `cam_company` 삭제(v4)

작성 2026-08-06 / 대상 `d:\Work\Parking3D\Agent\baro\SettingManager`
정본 문서: `docs/20260806_135950_카메라연결불가_DB마이그레이션_수정.md`
CLAUDE.md 5번 규칙(영향도 분석). **모든 항목을 코드를 읽어 확인했다.** 출처를 `파일:줄` 로 병기한다.

**출처 표기**: 「코드」= 파일을 읽어 확인 · 「실측」= 이번에 실제로 실행해 받은 값 · 「추론」= 코드 구조로부터의 결론이며 실증하지 못한 것.

---

## 0. 한눈에

| 축 | 결론 |
|---|---|
| 공개 응답 키 | `/api/db/cameras*` 만 **1키 감소**(13키 → 13키: `cam_company` 빠지고 `hasPassword` 추가는 원래 있던 것). `/api/settings`·`/api/cameras` **무변화** |
| 웹 화면 | `web/optionsDb.js` **하나만** 영향. `discovery.js`·`control.js`·`options.js`·`dbtable.js` 무영향. 브라우저 저장 상태 **없음** |
| MCP | 도구 계약은 경로·메서드 기준이라 무영향. **notes 는 어떤 테스트도 검사하지 않는다** |
| 형제 프로젝트 | **파급 없음.** `SettingAgent`·`Parking3D` 어느 쪽도 `cam_company`·`/api/db/cameras`·`setup.db` 를 읽지 않는다 |
| 2차 피해 | 사고 기간에 **카메라 추가·수정이 전부 실패**했고 **장비 프리셋 전 기능이 501** 이었다(추론, 근거 강함). 다만 그 실패 덕에 **DB 오염은 없었다** |
| 되돌리기 | 판 4 파일은 **옛 코드로 열 수 없다**. 코드와 DB 를 **함께** 되돌려야 한다 |

---

## 1. `cam_company` 삭제와 공개 응답 키 집합

### 1-1. `/api/db/cameras` 계열 — **키가 하나 줄었다**

`publicCamera()`(`src/api/routes/dbRoutes.ts:199-202`)는 이렇게 생겼다:

```ts
function publicCamera(row: CameraRow): Record<string, unknown> {
  const { password, ...rest } = row;
  return { ...rest, hasPassword: password.length > 0 };
}
```

**이 함수는 손대지 않았다.** `CameraRow` 에서 `cam_company` 가 빠지면 `...rest` 가 저절로 따라간다 — 열 목록을 두 번 적지 않는 구조라서 가능한 일이다.

응답 키(13): `cam_id`·`cam_name`·`cam_uuid`·`url`·`user_id`·`rtsp_url`·`cam_type`·`place_id`·`timeout_ms`·`kind`·`park3d_cam_id`·`intrinsics`·`hasPassword`.

영향 받는 라우트 셋 — 전부 `publicCamera()` 를 지난다:

| 라우트 | 자리 |
|---|---|
| `GET /api/db/cameras` | `dbRoutes.ts:76` |
| `POST /api/db/cameras` | `dbRoutes.ts:93` |
| `PUT /api/db/cameras/:id` | `dbRoutes.ts:128` |

`POST /api/db/cameras/:id/test` 응답은 `{ ok, cam_id, kind, elapsedMs, ptz|error }`(`:112`·`:114-120`)라 원래 `cam_company` 를 담지 않았다 — **무변화**.
`DELETE /api/db/cameras/:id` 응답은 `{ removed, cam_uuid, removedPresets }`(`:139`) — **무변화**.

**요청 방향**: `POST` 본문의 `cam_company` 는 이제 **조용히 무시된다**(그 키를 읽던 `:91` 의 겹치기 한 줄을 지웠다). 400 이 아니다. `merged()`(`:219-237`)의 `text` 유니온에서도 빠졌으므로 `PUT` 본문의 `cam_company` 도 무시된다. 테스트로 고정돼 있다(`test/dbRoutes.test.ts:151-160`).

### 1-2. `GET /api/settings` · `GET /api/cameras` — **정말 안 바뀐다** (코드로 확인)

세 자리를 모두 확인했다.

1. **응답을 만드는 자리**: `settingsRoutes.ts:25`·`:37`·`:45` 가 전부 `config.cameras.map(toPublicCamera)` 다. 즉 원본은 `CameraConfig` 배열이지 `CameraRow` 가 아니다.
2. **`CameraConfig` 타입**: `src/config/types.ts:15-` — 필드는 `id`·`label`·`kind`·`controlUrl`·`username`·`password`·`streamUrl`·`timeoutMs`·`camId?`·`place_id?`·`intrinsics?`. **`cam_company` 가 원래 없다.**
3. **DB → 설정 변환**: `toCameraConfig()`(`src/db/configCameras.ts:20-35`)가 만드는 키도 위와 같다. `cam_company` 를 읽는 줄이 애초에 없었다.

→ **`/api/settings` 와 `/api/cameras` 의 응답은 한 글자도 바뀌지 않는다.** 이것은 이번 변경이 안전한 가장 큰 이유다. 화면 대부분(스트림·PTZ·탐색·제어)이 이 두 라우트만 쓰기 때문이다.

테스트가 이 사실을 네 자리에서 못박고 있다(`test/database.test.ts:694-700`): 표(`SCHEMA_SQL`) ↔ `CameraRow` ↔ INSERT 결과 ↔ `toCameraConfig` 결과.

---

## 2. 웹 화면 영향

### 2-1. `/api/db/cameras` 의 소비자는 **`web/optionsDb.js` 하나뿐이다** (코드로 확인)

`web/api.js:33-38` 이 그 라우트들의 유일한 래퍼이고, 호출자는 셋뿐이다:

```
web/optionsDb.js:254  cameras = (await api.dbCameras()).cameras;
web/optionsDb.js:307  await api.dbSaveCamera(camera.cam_id, draft());
web/optionsDb.js:345  const result = await api.dbAddCamera({ cam_uuid: id, kind: …, label: id });
```

이번에 함께 고쳤다:
- `FIELDS`(`optionsDb.js:134-`)에서 `['camCompany','cam_company']` 삭제
- `draft()`(`:230-`)에서 `cam_company:` 삭제
- `web/options.html:142` 의 「제조사 (cam_company)」 입력 field 삭제 (`<div class="row">` 은 `camPlace` 가 같은 줄에 있어 남겼다)

`renderEditor()`(`:200`·`:204-206`)와 `wireCameraTab()`(`:294`)은 `FIELDS` 를 **순회할 뿐**이라 자동으로 따라간다. 열 목록이 한 곳에만 있어서 가능한 일이다.

**안 고쳤다면**: `FIELDS` 루프가 `camera['cam_company']` = `undefined` 를 `''` 로 그려 **빈 「제조사」 칸**이 남고, 사람이 값을 적고 저장해도 `merged()` 가 그 키를 읽지 않아 **아무 일도 일어나지 않는다.** 테스트 `test/optionsDbUi.test.ts:43-48` 이 js·html 양쪽을 함께 봐서 이 어긋난 상태를 막는다.

### 2-2. 다른 화면은 그 키를 읽지 않는다 (코드로 확인)

| 파일 | 무엇을 부르는가 | 영향 |
|---|---|---|
| `web/control.js:25` | `api.cameras()` → `GET /api/cameras` | **없음**(§1-2) |
| `web/discovery.js:111`·`:137` | `/api/cameras`, `/api/cameras/active` | **없음** |
| `web/options.js:15` | `api.settings()` → `GET /api/settings` | **없음** |
| `web/dbtable.js` | `/api/db/tables`·`/api/db/query` | **자동 추종**(§2-4) |
| `web/optionsDb.js:275` | `api.cameras()` (활성 기기 확인용) | **없음** |

### 2-3. 브라우저에 저장된 상태 — **없다**

`web/` 전체를 `localStorage`·`sessionStorage` 로 검색해 **무결과**. 즉 이미 열려 있던 탭이 옛 키를 기억하고 있다가 되살릴 위험이 없다. 화면 새로고침 하나로 정합이 맞는다.

### 2-4. DB 탭 테이블 뷰어 — 코드 수정 없이 13열을 그린다

`src/db/tableQuery.ts` 의 열 목록은 **SQLite 가 `PRAGMA table_info` 로 답한 것**이다(`:102-105`, 주석 `:101` — "화이트리스트의 정본이라 코드에 베껴 두지 않는다"). 숨김 목록도 `camera_info: ['password']` 하나뿐(`:42-44`)이라 `cam_company` 와 무관하다.

→ 10열 → 14열 → 13열의 세 번의 변화를 **뷰어는 한 줄도 고치지 않고 따라왔다.** 열 목록을 코드에 베껴 두지 않은 설계의 값이 여기서 나왔다.

---

## 3. MCP 도구 계약과 라우트 카탈로그

### 3-1. 바뀐 것

`src/mcp/routeCatalog.ts:134` 의 notes 문구에서 단어 하나:

```
'cam_name·cam_type·cam_company·place_id 만. …'  →  'cam_name·cam_type·place_id 만. …'
```

도구 표면(`ROUTE_CATALOG` 의 `method`·`path`·`mutating`·`movesCamera`)은 **바뀌지 않았다.** MCP 도구는 SettingManager 자신의 REST 를 부르므로, 다른 에이전트가 `GET /api/db/cameras` 를 호출하면 **키가 줄어든 응답**을 그대로 받는다. 그 값을 읽는 자리는 저장소 안에 없다(§2-1).

### 3-2. **드리프트 테스트는 이번 변경을 잡지 않는다** (코드로 확인 — 중요)

카탈로그를 검사하는 테스트는 둘뿐이고, **둘 다 경로·메서드만 본다**:

| 테스트 | 무엇을 보는가 |
|---|---|
| `test/mcpServer.test.ts:13-17` 「라우트 소스의 모든 고정 경로가 카탈로그에 있다」 | 라우트 소스에서 뽑은 **경로 문자열**이 카탈로그에 있는지 |
| `test/optionsDbUi.test.ts:153-167` 「새 라우트가 카탈로그에 있다」 | `method`·`path` 쌍의 존재 |

**`notes` 의 내용을 검사하는 단언은 저장소 어디에도 없다.** 따라서:

- 이번 `cam_company` 단어 삭제를 **잡지 않았고**, 안 지웠어도 아무도 알려 주지 않았을 것이다.
- 같은 줄에 남아 있는 **더 큰 거짓말**도 잡지 못한다: `'**접속정보는 config.json 이 주인이다.**'` — 카메라의 정본은 이제 DB 이고(`dbRoutes.ts:18-21` 주석이 그렇게 명시한다), `merged()` 는 `url`·`user_id`·`password`·`rtsp_url`·`kind`·`timeout_ms`·`park3d_cam_id`·`intrinsics` 를 전부 받는다(`dbRoutes.ts:219-237`). **이 notes 를 읽는 다른 에이전트는 접속정보를 못 고친다고 잘못 알게 된다.**

→ **별건으로 올린다.** 외과적 변경 원칙에 따라 이번에는 단어 하나만 지웠다. 고치려면 notes 를 실제 허용 키에 맞춰 다시 쓰고, `merged()` 가 받는 키 집합과 notes 를 대조하는 테스트를 함께 두어야 재발하지 않는다.

---

## 4. 형제 프로젝트 파급 — **없다** (실제로 grep 해서 확인)

조사 대상 두 곳 모두 존재를 확인하고 전수 검색했다.

### 4-1. `d:\Work\Parking3D\AgentVLA\ParkAgent` (`SettingAgent` 포함)

| 검색어 | 결과 |
|---|---|
| `cam_company` / `camCompany` | 히트 **다수 — 그러나 전부 SettingAgent 자신의 것** |
| `camera_info` | 히트 다수 — 전부 자기 표 정의 |
| `setup.db` | **0건** |
| `park3d_cam_id` | **0건** |
| `/api/db/cameras` | **0건** |
| `/api/cameras` | 전부 `/viewer/api/cameras` — **자기 라우트 정의** |
| `13030` | 전부 과거 문서·메모(폐지된 `SettingViewer :13030`). **SettingManager 를 부르는 HTTP 클라이언트 코드 0건** |

자기 것이라는 근거:
- `SettingAgent\src\capture\SqliteStore.ts:75` `CREATE TABLE IF NOT EXISTS camera_info (` … `:85` `cam_company  TEXT,` — **SettingAgent 가 자기 DB 에 만드는 표**
- `SettingAgent\src\capture\types.ts:76` `camCompany: string | null;` — 자기 행 타입
- `SettingAgent\src\config\toolsConfig.ts:430` `dbFile: 'data/setting.sqlite'` → `SettingAgent\src\index.ts:63` `new SqliteStore(tools.capture.dbFile)` — **DB 경로 주입점은 이 한 곳뿐이고 SettingManager 경로 문자열이 없다**

### 4-2. `d:\Work\Parking3D\Parking3D` (Unity, `NetworkREST` 포함)

9개 검색어 **전부 소스 트리 무결과**(`Assets\Scripts`·`Config`·`Docs`·`memo`). 저장소 전체에서 뜬 `13030` 은 폰트 글리프 ID(`Pretendard-SemiBold SDF.asset:207`)와 로그의 프레임 번호였다. `*.cs` 전체에서 `sqlite`/`SQLiteConnection` **0건** — SQLite 를 아예 쓰지 않는다.

실제 통신 상대는 SettingManager 가 아니다:
- `Assets\Scripts\99_Network\NetworkREST\CWebCenteriseClient.cs:48` `BaseUrl = "http://localhost:18002"`
- `Assets\Scripts\99_Network\NetworkREST\CWebCenteriseHelper.cs:20` `m_ServerUrl = "http://localhost:18002"`

### 4-3. 두 결론

- **형제 프로젝트 중 `cam_company` 키를 읽는 것은 없다.** ParkAgent 안의 `cam_company` 는 전부 SettingAgent **자기 SQLite 표**의 열이며, SettingManager 의 응답이나 DB 를 읽는 코드는 0건이다.
- **형제 프로젝트 중 SettingManager 의 `setup.db` 나 `camera_info` 를 직접 여는 것은 없다.** SettingAgent 가 여는 것은 자기 `data/setting.sqlite` 다.

### 4-4. 다만 — 결합이 아니라 **공통 사양 문서**로 이어져 있다 (기록)

두 프로젝트의 `camera_info`/`cam_company` 는 **같은 원 설계 문서를 각자 구현한 것**이다:

- `d:\Work\Parking3D\AgentVLA\ParkAgent\Docs\MyThink\my_db_table.md:17`(`2. camera_info`) · `:26`(`- cam_company : 제조회사 ( 휴컴스, 아이디스 등 )`)
- SettingManager 쪽 사본: `docs/my_think/my_db_table.md:26`

즉 **코드는 안 깨지지만 사양 문서와는 어긋난다.** 지금 SettingManager 의 `camera_info` 는 문서의 10칸 중 `cam_company` 를 담지 않고, SettingAgent 의 것은 담는다 — **같은 이름의 표가 두 프로젝트에서 다른 모양이 되었다.** 이 사실은 `src/db/schema.ts:26-33` 에 기록해 두었지만, **문서를 고칠지·SettingAgent 도 맞출지는 마스터 판단 사항**이다. 이 문서는 그 결정을 대신하지 않는다.

### 4-5. 의존 방향과 유일한 실물 충돌 지점

의존은 **반대 방향으로만** 있다 — SettingManager 가 SettingAgent 를 참조한다(`.claude/skills/settingmanager-stack/SKILL.md:127`, `docs/20260731_195049_시뮬레이터_연동_및_결함수정.md:250`).

실물 충돌 위험은 스키마가 아니라 **포트**다. SettingManager 가 `:13030` 을 상시 점유하는데(`README.md:19`), ParkAgent 쪽은 과거 그 포트를 임시 검증 서버로 반복 사용한 이력이 있다(`AgentVLA\ParkAgent\메모\memo.md:778`·`:1523`). **이번 변경과 무관한 별건이지만 같이 기록해 둔다.**

---

## 5. 2차 피해 조사 — `kind`/`timeout_ms` 가 열째 없던 기간

「그 기간」 = `camera_info` 가 10열이던 기간. 언제 시작됐는지는 **확인하지 못했다**(그 열들이 `SCHEMA_SQL` 에 들어간 커밋 시점 이후라는 것만 알 수 있고, 로그가 남아 있지 않다).

### 5-1. **카메라 추가·수정이 전부 실패했을 것이다** — 근거 강한 추론

`upsertCamera()` 의 INSERT 는 없는 열을 **이름으로 명시**한다(`src/db/setupRepository.ts:172-175`):

```sql
INSERT INTO camera_info (cam_id, cam_name, cam_uuid, url, user_id, password, rtsp_url, cam_type, place_id,
                         timeout_ms, kind, park3d_cam_id, intrinsics)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

10열 표에서는 SQLite 가 `prepare` 단계에서 **`no such column: timeout_ms`** 로 던진다.

**결론(추론)**: 그 기간에 `POST /api/db/cameras`(`dbRoutes.ts:88`)·`PUT /api/db/cameras/:id`(`:126`)·`importCameras()`(`configCameras.ts:87`)가 **전부 500 으로 실패**했다. 화면에서는 "저장 실패"로 보였을 것이다.

**직접 실증하지 못했다** — 이미 열이 붙어 있어 재현할 수 없고, 그 기간의 서버 로그를 확보하지 못했다. 다만 코드 경로가 단일하고 우회로가 없어 결론은 확실하다.

### 5-2. **그 실패 덕분에 DB 오염은 없었다** — 확인

`merged()`(`dbRoutes.ts:219-237`)는 `current.kind`(=undefined)·`current.timeout_ms`(=undefined)를 patch 에 겹쳐 넘겼다. 그러나 그 결과가 `upsertCamera()` 로 가면 **§5-1 에서 던지므로 아무것도 저장되지 않았다.**

→ **"undefined 가 DB 에 기록됐을 가능성"은 없다.** 실측이 이를 뒷받침한다: 운영 DB 5대의 `cam_uuid`·`url`·`rtsp_url`·`user_id`·`cam_name` 이 전부 온전하고, `ALTER TABLE ADD COLUMN` 은 기존 줄을 건드리지 않으므로 옛 10열의 값은 그대로다.

**단, 사용자가 그 기간에 시도했다가 실패한 편집이 있다면 그것은 되돌아오지 않는다.** 지금 값이 맞는지는 사람이 확인해야 한다 — 실제로 §4(정본 문서 §4)의 `real-camera-2`·`simulator-2` `kind` 정정이 그런 확인이었다.

### 5-3. 예외 — **자동 등록 경로는 살아 있었다** (코드로 확인)

브리지 저장소 둘은 INSERT 에 **4열만** 댄다:

```
src/db/discoveryDbStore.ts:201  INSERT INTO camera_info (cam_id, cam_name, cam_uuid, place_id) VALUES (?, ?, ?, ?)
src/db/spotDbStore.ts:116       INSERT INTO camera_info (cam_id, cam_name, cam_uuid, place_id) VALUES (?, ?, ?, ?)
```

→ 없는 열을 대지 않으므로 **그 기간에도 성공했다.** 즉 탐색·주차면 저장이 카메라를 자동 등록하는 경로는 막히지 않았다. 이 카메라 줄들은 `kind` 가 기본값이 되므로(v2 열이 붙은 뒤에는 `'hucoms'`) **의도치 않은 종류로 남을 수 있다** — 운영 DB 5대는 전부 사람이 확인한 값이라 해당 사항이 없지만(실측), 앞으로 이 경로로 생긴 카메라는 종류를 확인해야 한다.

### 5-4. **장비 프리셋 기능이 전부 501 로 죽어 있었다** — 근거 강한 추론

`src/api/routes/devicePresetRoutes.ts` 는 두 자리에서 종류를 검사한다:

```
:23  if (camera.kind !== 'hucoms') throw new HttpError(501, '현재 카메라는 장비 프리셋 capability를 지원하지 않습니다');
:34  if (camera.kind !== 'hucoms') throw new HttpError(501, 'Hucoms 카메라에서만 장비 프리셋을 실행할 수 있습니다');
```

`undefined !== 'hucoms'` 는 **항상 참**이므로 `GET /api/device-preset-capability`·`GET /api/cameras/:id/device-presets`·`POST …/go`·`POST …/sync-coordinate` 가 **전 카메라에서 501** 이었다.

**지금은 되살아났다** — hucoms 3대(`real-camera-1`·`real-camera-2`·`simulator-1`)에서 검사를 통과한다. 다만 **장비 프리셋 라우트 자체를 실제로 호출해 200 을 받는 확인은 하지 않았다**(리더 실측 범위는 PTZ·스트림이었다). 별도 확인이 필요하면 그때 한다.

### 5-5. 연결 테스트 버튼이 준 **잘못된 인상** — 확인

`POST /api/db/cameras/:id/test` 는 `createDriver` 실패를 **오류가 아니라 시험의 결과**로 보아 200 에 실어 보낸다(`dbRoutes.ts:113-121`):

```json
{ "ok": false, "cam_id": 1, "kind": null, "elapsedMs": 1, "error": "알 수 없는 카메라 종류입니다: undefined" }
```

즉 화면에는 **"연결 실패"** 로 보였다. 그 기간의 연결 실패 보고는 **네트워크 문제가 아니었다.** 사용자가 그것을 장비·회선 문제로 오해했을 수 있고, 실제로 이번 진단이 "RTSP·URL 확인" 토스트 문구 때문에 처음에 그 방향으로 갔다.

**여기가 개선 여지다(별건)**: 이 라우트는 `error` 문자열을 그대로 싣기 때문에 원인이 응답에 **이미 들어 있었다.** 화면이 그 문자열을 보여 주기만 했어도 진단이 훨씬 빨랐을 것이다. 지금 `optionsDb.js` 가 `camTestResult` 에 무엇을 그리는지는 이번에 확인하지 않았다.

### 5-6. `providerFactory` 의 `timeoutMs: undefined` — **잠재 위험이었으나 발현하지 않았다** (실측)

`src/core/providerFactory.ts:39` 이 `camera.timeoutMs` 를 그대로 넘기고, 그 값이 `AbortSignal.timeout()` 으로 들어간다(`src/devices/backendCore/backendCoreTransport.ts:55`).

Node v24.16.0 에서 실제로 확인했다(실측):

```
AbortSignal.timeout(undefined)
→ TypeError: The "delay" argument must be of type number. Received undefined
```

즉 그 경로를 탔다면 **한국어 오류가 아니라 정체불명의 `TypeError` 로 500** 이 났을 것이다.

**그러나 발현하지 않았다.** 그 분기는 `coreProviderFor(config, camera.id) === 'remote'` 일 때만 타는데(`providerFactory.ts:35`), 운영 `config.json` 은 실측 결과:

```json
"core": { "provider": "bridge", "perCamera": {} }
```

→ 전 카메라가 `bridge` 다. 브리지 경로는 `timeoutMs` 를 쓰지 않고, 대신 코어 라우트가 `driverFor()` 로 드라이버를 먼저 만들므로(`src/api/routes/coreRoutes.ts:20`) **§2 의 400 으로 죽었다.** 결과적으로 사용자가 본 오류는 일관되게 「알 수 없는 카메라 종류입니다」 하나였다.

**남는 위험**: `core.provider` 를 `remote` 로 바꾸고 `timeoutMs` 가 어떤 이유로든 비면 이 `TypeError` 가 그대로 난다. 지금은 DB `NOT NULL DEFAULT 5000` 이 막고 있지만 **코드 자체에는 방어가 없다.** 별건으로 올린다.

### 5-7. `park3d_cam_id` — 피해 없음 (확인)

사고 당시 4대 중 `park3d-rpc` 종류가 없었고, `park3d_cam_id` 를 읽는 곳은 `toCameraConfig()`(`configCameras.ts:32`)뿐인데 값이 없으면 **키 자체를 만들지 않는다**. 이후 `simulator-2`(camId 1)·`simulator-3`(camId 2)가 등록됐고 v4 마이그레이션 뒤에도 **값이 보존됐다**(실측 §정본문서 7-1). 이 값이 틀리면 엉뚱한 카메라가 움직이므로 테스트 `[4-2]` 가 따로 못박고 있다.

### 5-8. `intrinsics` / 브리지 박스줌 — 이번 버그의 결과가 아니다 (확인)

운영 5대 전부 `intrinsics = NULL`(실측). 그런데 복구 근거인 `config/config.json.bak-cameras` 의 **4대에도 `intrinsics` 가 없었다**(실측). 즉 브리지 박스줌(`centerBox` 501)이 꺼져 있는 것은 **이관 전부터의 상태**이며 **이번 수정으로 켜지지 않는다.** 줌→화각 표를 채우는 일은 **별건**이다.

---

## 6. 이번 변경이 **잡지 못하는** 상태 (안전망의 구멍)

정본 문서 §8-3 과 같은 내용이며, 영향도 관점에서 다시 적는다.

`verifySchema()`(`src/db/database.ts:152-179`)는 **기대에 있는데 실제에 없는 것만** 본다. 반대 방향(실제에만 있는 여분)은 설계상 보지 않는다(`:149-150` 주석).

검증자 실측: `database.ts` 에서 **`dropCamCompany(db);` 한 줄만 지우면** `user_version` 은 4 로 오르고 `cam_company` 열은 남는데 **`verifySchema` 를 포함해 103건이 전부 통과한다.**

→ **이 상태를 잡는 것은 `test/database.test.ts` 의 `[4-1]` 한 건뿐이다.**

```
test/database.test.ts:579
  expect(columns).not.toContain('cam_company');
```

**영향도 결론**: 이 테스트는 「단순한 회귀 테스트」가 아니라 **런타임 안전망을 대신하는 자리**다. 앞으로 이 파일을 정리·리팩토링하는 사람은 그 사실을 알아야 한다. 지우거나 `toHaveLength(13)` 만 남기면 같은 클래스의 사고가 **CI 를 조용히 통과한다**(개수만으로는 "다른 열 하나를 잃고 `cam_company` 는 남은" 파일과 구분되지 않는다).

같은 성질의 구멍 둘:
- `verifySchema` 는 **자료형·`NOT NULL`·기본값·`CHECK` 를 보지 않는다.** "열 이름은 맞는데 자료형이 다른" 파일은 통과한다(설계 선택, §정본문서 3-3).
- **ALTER 로 보강된 옛 파일(=운영 DB)에는 `kind`·`intrinsics` 의 CHECK 가 없다.** HTTP 경로는 `dbRoutes.merged()` 의 `KINDS` 화이트리스트(`:230`·`:239`)와 `intrinsicsJson()`(`:256-261`)이 막지만, `sqlite3` 로 직접 UPDATE 하면 DB 가 막지 않는다.

---

## 7. 되돌리기 — **판 4 파일은 옛 코드로 열 수 없다**

### 7-1. 왜 못 여는가 (코드)

```ts
// src/db/database.ts:57-62
const current = Number(…PRAGMA user_version…);
if (current > SCHEMA_VERSION) {
  throw new DatabaseError(
    `DB 스키마 판(${current})이 이 코드가 아는 판(${SCHEMA_VERSION})보다 높습니다 — 더 새로운 SettingManager 로 여십시오`,
  );
}
```

v3 코드(`SCHEMA_VERSION = 3`)로 판 4 파일을 열면 **기동 즉시 던진다.** 이것은 결함이 아니라 의도된 보호다 — 옛 코드가 모르는 열을 무시한 채 쓰면 새 코드가 기대하는 값이 조용히 비어 버린다.

### 7-2. 되돌리기 절차

| 순 | 작업 | 왜 |
|---|---|---|
| 1 | **개발 서버 정지**(`:13030`). 정지 확인까지 | 켜져 있으면 다음 단계 사이에 다시 마이그레이션이 돈다. `nodemon --watch src --ext ts` 라 **소스를 저장하는 것만으로도 재기동한다** |
| 2 | `config/setup.db` · `setup.db-wal` · `setup.db-shm` **세 파일을 모두 지운다** | 백업은 `VACUUM INTO` 스냅샷이라 **단독으로 완전하다.** 옛 `-wal`/`-shm` 을 남기면 **다른 DB 의 저널을 붙이는 꼴**이 된다 |
| 3 | 백업을 `setup.db` 로 복사 | `setup.db.bak-20260806_before-v4`(판 3·5대) 또는 `setup.db.bak-20260806_v3`(판 3·v2 열 보강 직후) |
| 4 | **소스도 함께 되돌린다** | §7-1. DB 만 되돌리고 코드가 v4 면 다음 기동에 **드롭이 다시 실행되어 그냥 v4 가 된다**(멱등) — 되돌린 것이 되돌려지지 않는다 |
| 5 | 기동 후 `PRAGMA user_version` 과 열 목록 확인 | 의도한 판인지 |

### 7-3. 방향별 안전성 요약

| 상황 | 결과 |
|---|---|
| 판 3 DB + v4 코드 | **안전.** 드롭이 돌아 v4 가 된다(멱등) |
| 판 4 DB + v3 코드 | **기동 불능.** `DatabaseError` 로 던진다 |
| 판 4 DB + v4 코드에서 `dropCamCompany` 한 줄만 빠짐 | **조용히 통과.** §6 — 테스트 `[4-1]` 만 잡는다. 회복은 `PRAGMA user_version = 3` 으로 되돌리고 재기동하거나 백업 복원 |
| 판 2(10열) DB + v4 코드 | **안전.** 보강(v2 열 넷)과 삭제(`cam_company`)가 **한 번의 열기에서** 일어난다. 테스트 `[4-4]` 가 이 경로를 덮는다 |

---

## 8. 영향 받는 파일 — 전체 목록

### 수정 (소스 8)
```
SettingMain/src/db/schema.ts
SettingMain/src/db/database.ts
SettingMain/src/db/setupRepository.ts
SettingMain/src/db/configCameras.ts
SettingMain/src/api/routes/dbRoutes.ts
SettingMain/src/mcp/routeCatalog.ts
SettingMain/web/options.html
SettingMain/web/optionsDb.js
```

### 수정 (테스트 3)
```
SettingMain/test/database.test.ts      (+18 : v3 11건 + v4 7건, 기존 단언 갱신)
SettingMain/test/dbRoutes.test.ts      (+2)
SettingMain/test/optionsDbUi.test.ts   (+1)
```

### 동작이 달라지지만 수정 없음 (전부 코드로 확인)
```
SettingMain/src/db/tableQuery.ts        PRAGMA 기반 — 저절로 13열
SettingMain/src/db/discoveryDbStore.ts  4열만 대므로 무영향
SettingMain/src/db/spotDbStore.ts       4열만 대므로 무영향
SettingMain/src/db/backendCoreExport.ts cam_uuid 만 읽는다
SettingMain/src/config/types.ts         CameraConfig 에 cam_company 가 원래 없다
SettingMain/src/config/normalize.ts     〃
SettingMain/src/config/configStore.ts   readCameras() 결과가 채워지기 시작(v3)
SettingMain/src/devices/driverFactory.ts default 분기로 떨어지지 않게 된다(v3)
SettingMain/src/api/routes/mediaRoutes.ts / ptzRoutes / devicePresetRoutes / coreRoutes
SettingMain/web/control.js · discovery.js · options.js · dbtable.js
```

### 데이터
```
SettingMain/config/setup.db  (+ -wal, -shm)   user_version 2 → 4, camera_info 10 → 14 → 13열
SettingMain/config/setup.db.bak-20260806_v3            판 3 스냅샷 (69,632 bytes)
SettingMain/config/setup.db.bak-20260806_before-v4     판 3·5대 스냅샷 (69,632 bytes)
```

### 손대지 않음
```
SettingMain/config/config.json                 (cameras 키가 원래 없다 — 실측)
SettingMain/config/config.json.bak-cameras     복구 근거이므로 지우지 않는다 (다만 kind 4건 중 2건이 낡았다 — 실측)
docs/my_think/my_db_table.md                   마스터 원 설계 문서 (§4-4)
```

---

## 9. 리더·마스터 판단이 필요한 것

| # | 사안 | 근거 위치 |
|---|---|---|
| 1 | **`simulator-2`·`simulator-3` 스트림 URL 이 둘 다 `:13602`** — PTZ 는 camId 1 을 움직이고 화면은 camId 2 를 보여주는 어긋난 상태 | 정본 문서 §8-1 (지시 대기 중) |
| 2 | **기존 20건 실패** — 특히 `server.test.ts` 17건은 이미 옮겨진 옛 라우트를 겨눠 **아무 계약도 지켜 주지 않는다.** 정리 대상 | 정본 문서 §8-4 |
| 3 | **`docs/my_think/my_db_table.md` 와 실제가 달라졌다** — SettingAgent 는 여전히 `cam_company` 를 갖는다. 문서를 고칠지, SettingAgent 도 맞출지 | §4-4 |
| 4 | **`routeCatalog.ts:134` notes 의 거짓말** — 접속정보의 주인이 config.json 이라고 적혀 있다. **어떤 테스트도 잡지 않는다** | §3-2 |
| 5 | **ALTER 보강 파일의 CHECK 부재** — 표를 다시 만들어 옮기는 마이그레이션이 필요 | §6 |
| 6 | **`intrinsics` 줌→화각 표 채우기** — 브리지 박스줌이 계속 꺼져 있다 | §5-8 |
| 7 | **`AbortSignal.timeout(undefined)` TypeError** — `core.provider = remote` 로 바꿀 때의 잠재 위험. 코드에 방어가 없다 | §5-6 |
| 8 | **`:13030` 포트 충돌 이력** — ParkAgent 쪽 임시 검증 서버와 겹칠 수 있다 | §4-5 |
