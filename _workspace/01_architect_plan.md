# 01. 설계 — camera_info v2 열 누락으로 전 카메라 400 실패

작성 2026-08-06 / 대상 저장소 `d:\Work\Parking3D\Agent\baro\SettingManager`

## 범위

리더가 실측으로 확정한 진단(마이그레이션 미실행 → `kind`/`timeout_ms` 열 부재 → `createDriver()` 400)을 전제로 한다.
**재진단하지 않는다.** 이 계획이 다루는 것은 넷이다.

1. 마이그레이션이 반드시 돌게 하는 코드 수정 + **같은 함정의 재발 방지 구조**
2. 회귀 테스트(vitest, 실제 실행)
3. 운영 DB `SettingMain/config/setup.db` 데이터 복구(`real-camera-2` → `backend-core`)
4. 서버 재기동 후 동작 확인 + 2차 피해 조사 지시

**다루지 않는 것은 「비범위」 절에.**

### 확인한 현실 (근거)

| 사실 | 근거 |
|---|---|
| `camera_info` 실제 10열, `user_version=2` | `SettingMain/config/setup.db` 직접 조회(읽기 전용) |
| 카메라 4대: cam_id 1~4 = real-camera-1 / real-camera-2 / simulator-1 / simulator-2 | 같은 조회 |
| `config.json` 에 `cameras` 키가 **없다** → 재이관 경로(`ConfigStore.migrateCameras`)는 다시 돌지 않는다 | `SettingMain/config/config.json` |
| 원본 kind: real-camera-2 만 `backend-core`, 나머지 3대 `hucoms`. 4대 모두 `timeoutMs:5000`, `intrinsics`·`camId` **없음** | `SettingMain/config/config.json.bak-cameras` |
| `cam_company` 는 kind 의 증인이 못 된다 — real-camera-2 가 `휴컴스`, 시뮬 2대가 `시뮬레이터`로 `companyOf()` 결과와 다르다(사람이 UI 로 고친 값) | DB 조회 vs `src/db/configCameras.ts:132` |
| 서버는 `nodemon --watch src --ext ts --exec tsx src/index.ts` 로 :13030 에서 실행 중, `setup.db-wal`/`-shm` 존재 | `SettingMain/package.json:11`, `config/` 목록 |

## 가정 / 확인 필요

- **가정**: v2 열 4개의 ALTER 기본값(`timeout_ms=5000`, `kind='hucoms'`, `park3d_cam_id=NULL`, `intrinsics=NULL`)이 백업 파일의 원본과 일치한다 — real-camera-2 의 `kind` 하나만 예외. 위 표가 근거다.
- **확인 필요 (A)**: real-camera-2 의 `cam_company` 가 `휴컴스`인데 kind 는 `backend-core` 다. 백업 파일에는 제조사 정보가 없어 **어느 쪽이 맞는지 근거가 없다.** 기본 방침은 **건드리지 않는다**(kind 만 고친다). 제조사도 고칠지는 사용자 판단.
- **확인 필요 (B)**: 4대 모두 `intrinsics` 가 NULL 이 된다. 그런데 **백업 파일에도 intrinsics 가 없었다** — 즉 브리지 박스줌이 꺼진 것은 이번 버그의 결과가 아니라 이관 전부터의 상태다. 줌→화각 표를 채울지는 **별건**이며 이 계획의 범위 밖이다(조사 항목으로만 남긴다).
- **확인 필요 (C)**: 데이터 복구를 위해 **개발 서버를 한 번 정지**해야 한다(백업의 일관성). 정지 가능한 시점을 사용자가 정한다.

---

## 단계

### 1단계. 스키마 판 올림 + 마이그레이션 실행 보장

**파일**: `SettingMain/src/db/schema.ts`, `SettingMain/src/db/database.ts`

1-1. `schema.ts` — `SCHEMA_VERSION = 2` → **`3`**.
   - 머리말의 "스키마를 바꾸면 올리고 마이그레이션을 추가한다" 주석은 유지하되, **판을 안 올려도 잡히는 안전망이 생겼다**는 한 줄을 덧붙인다(1-3 참조).

1-2. `database.ts` `migrate()` —
   - `if (current === SCHEMA_VERSION) return;` → `if (current < SCHEMA_VERSION) { …판 올리기… }` 로 바꾼다. `current > SCHEMA_VERSION` 던지기는 **그대로 둔다**.
   - 판 올리기 블록 안의 `if (current >= 1) upgradeToV2(db);` 에서 **버전 조건을 없애고 무조건 호출한다.** `upgradeToV2()` 는 이미 `PRAGMA table_info` 로 판단하므로 새 파일(표 없음)에서는 스스로 빠져나가고, 있는 열은 건너뛴다 — 판 번호로 분기하는 자리가 하나 줄어드는 것이 이 버그의 교훈이다.
   - 50~55행 주석("지금은 초판뿐이라 …") 과 `upgradeToV2()` 의 "v1 → v2" 표현을 **현실에 맞게 갱신한다**: "열 유무로 판단하므로 어느 옛 판에서 올라와도 멱등하다".

1-3. **재발 방지 구조 — 채택: (b) 열기 시점 스키마 대조(판 번호와 무관한 안전망)**

   구현 형태(약 25줄, `database.ts` 안의 비공개 함수 하나):
   - `:memory:` 에 `SCHEMA_SQL` 만 실행한 **일회용 기준 DB** 를 만들어, 표/뷰 이름과 각 표의 열 이름 집합을 뽑는다.
   - 실제 DB 의 같은 목록과 대조해 **기대에 있는데 실제에 없는** 표·열을 모은다.
   - 하나라도 있으면 `DatabaseError` 로 던진다. 메시지에 **무엇이 없는지 이름을 그대로 싣는다**
     (예: `DB 스키마가 코드의 기대와 다릅니다 — camera_info 에 kind, timeout_ms 가 없습니다`).
   - `migrate()` 의 **맨 끝에서 항상** 부른다(판을 올렸든 안 올렸든).
   - 실제에만 있는 여분의 열은 **문제 삼지 않는다** — 앞선 판이 연 파일은 `user_version` 검사가 이미 막는다.

   **왜 이것인가**
   - (a) 판 올림 + 규율: **이번에 실패한 방식**이다. 사람이 잊으면 아무도 알려 주지 않고, 증상이 `undefined` 로 조용히 새어 나가 400 이 될 때까지 아무 데서도 안 걸린다.
   - (c) 전부 멱등하게 매번 실행: 이번 버그는 막지만 **다음 버그는 못 막는다** — 새 열을 `SCHEMA_SQL` 에만 넣고 멱등 단계를 안 쓰면 다시 조용히 없는 열이 된다. 즉 여전히 사람의 규율에 기댄다.
   - (b) 는 **의도(`SCHEMA_SQL`)와 현실(파일)을 직접 대조**하므로, 판을 안 올리든 마이그레이션 단계를 빠뜨리든 **원인과 무관하게** 그 클래스를 전부 잡는다. 기대 목록을 손으로 관리하지 않아(SCHEMA_SQL 에서 뽑는다) 목록 자체가 낡을 수 없다. 값은 기동 시 1회 + 테스트당 1회의 `:memory:` DB 하나.
   - 마이그레이션 프레임워크(버전별 파일, 다운그레이드, 이력 표)는 **짓지 않는다** — 표 7개짜리 단일 서비스에 과하다(CLAUDE.md 2번).

   **역할 분담을 분명히**: 고치는 것은 마이그레이션, **검사하는 것은 대조**다. 대조는 자동 보정하지 않는다 — 보정까지 하면 "무엇이 왜 어긋났는가"를 아무도 안 보게 되고, 대조가 두 번째 마이그레이션 엔진이 된다.

**검증**: `npm run typecheck` 통과. 2단계 테스트 전부 통과.

---

### 2단계. 회귀 테스트

**파일**: `SettingMain/test/database.test.ts` 에 `describe('옛 파일 열기 — v2 열 보강')` 블록 추가.
기존 관례를 따른다(`mkdtemp`/`rm` 로 임시 디렉토리, 한글 `it` 문장, 근거 주석).

**`:memory:` 로는 이 버그를 재현할 수 없다** — "이미 존재하는 옛 파일"이 전제이고 메모리 DB 는 닫으면 사라져 다시 열 수 없다. 따라서 **임시 파일 경로가 필수**다(`mkdtemp(join(tmpdir(), 'settingmanager-db-'))`, `afterEach`/`finally` 에서 `rm`).

**픽스처 만드는 법**: `openDatabase()` 를 쓰면 안 된다(그 자체가 고치는 대상). `src/db/sqlite.js` 의 `DatabaseSync` 를 직접 써서 옛 스키마를 SQL 로 세운다 — `place_info` + **10열 `camera_info`**(cam_id, cam_name, cam_uuid, url, user_id, password, rtsp_url, cam_type, cam_company, place_id), 카메라 2줄 삽입, `PRAGMA user_version = 2`, close. 이 10열 정의는 **역사적 v1 스키마를 재현한 테스트 픽스처**이며 소스의 `SCHEMA_SQL` 과 별개다(공유하면 재현이 무너진다).

| # | 케이스 | 성공 기준 |
|---|---|---|
| 2-1 | **핵심**: 위 픽스처를 `openDatabase({path})` 로 연다 | `PRAGMA table_info(camera_info)` 열 이름 집합이 `timeout_ms`·`kind`·`park3d_cam_id`·`intrinsics` 를 **모두 포함**. `user_version === SCHEMA_VERSION`(=3) |
| 2-2 | 같은 DB 에서 `readCameras(db)`(`src/db/configCameras.js`) | 반환 배열의 모든 원소가 `kind === 'hucoms'`, `timeoutMs === 5000`. `undefined` 가 하나도 없다 |
| 2-3 | 기존 데이터 보존 | 픽스처에 넣은 `url`·`rtsp_url`·`user_id`·`cam_name`·`cam_uuid` 가 열기 전후로 **문자 그대로 동일** |
| 2-4 | 새 파일(빈 경로) | 처음 열었을 때 `camera_info` 가 **14열**이고 `user_version === SCHEMA_VERSION` |
| 2-5 | 멱등 | 2-1 의 DB 를 닫고 **다시 열어도** 던지지 않고, 열 집합·행 수가 그대로 |
| 2-6 | 앞선 판 거절 | `PRAGMA user_version = SCHEMA_VERSION + 1` 후 `migrate(db)` 가 `DatabaseError` — **기존 테스트가 이미 덮는다**(`database.test.ts:68`). 값만 새 `SCHEMA_VERSION` 을 따라가는지 확인 |
| 2-7 | 대조 안전망이 실제로 던진다 | `camera_info` 에서 열 하나가 빠진 상태를 만들고 **`user_version` 을 최신(3)으로 위조**한 픽스처를 연다 → `DatabaseError` 를 던지고 메시지에 **빠진 열 이름이 들어 있다**. (SQLite 는 `DROP COLUMN` 을 지원하므로, 14열 DB 를 만든 뒤 `ALTER TABLE camera_info DROP COLUMN park3d_cam_id` 로 만든다. 지원 여부가 Node 내장 버전에 달렸다면 대신 10열 픽스처 + `user_version=3` 으로 같은 상황을 만든다 — 이때 1-2 의 무조건 `upgradeToV2()` 가 먼저 고쳐 버리므로, 이 케이스는 **표가 아니라 다른 표/열**로 세운다: 예컨대 `preset_info` 를 아예 만들지 않은 픽스처. 구현자가 둘 중 되는 쪽을 고르고 어느 쪽을 골랐는지 테스트 주석에 남긴다.) |

**주의**: 2-7 의 취지는 "대조가 실제로 무언가를 잡는다"를 보이는 것이다. 잡히는 대상이 `camera_info.kind` 일 필요는 없다.

**검증**: `cd SettingMain && npm run test` **실제 실행**. 새 케이스 전부 통과 + **기존 테스트 전부 통과**(특히 `database.test.ts`·`server.test.ts`·`dbRoutes.test.ts`). 실행하지 않은 테스트를 통과로 보고하지 않는다.

---

### 3단계. 운영 DB 복구 (순서가 안전장치다)

**되돌리기 어려운 작업이다. 아래 순서를 지킨다.**

| 순 | 작업 | 성공 기준 |
|---|---|---|
| 3-1 | **개발 서버 정지**(nodemon/tsx, :13030). 정지 확인까지 | :13030 에 연결이 되지 않는다 |
| 3-2 | **백업**: `config/setup.db`·`setup.db-wal`·`setup.db-shm` **세 파일을 함께** `config/backup/20260806_HHMMSS/` 로 복사 | 세 파일이 백업 경로에 존재. WAL 을 빼고 `.db` 만 복사하면 **아직 반영 안 된 쓰기를 잃는다** — 서버를 먼저 정지시키는 이유가 이것이다 |
| 3-3 | 1·2단계 코드 수정을 적용하고 테스트 통과 확인 | 2단계 검증 통과 |
| 3-4 | **서버 기동**. 기동 시 `openDatabase()` → `migrate()` 가 열 4개를 붙인다 | 로그에 오류 없음. `PRAGMA table_info(camera_info)` 14열, `user_version=3`. 4대 모두 `kind='hucoms'`, `timeout_ms=5000` |
| 3-5 | **`real-camera-2` 만 보정** — `PUT /api/db/cameras/2` 본문 `{"kind":"backend-core"}` (`src/api/routes/dbRoutes.ts:126`). curl 로 하든 옵션 화면 DB 탭에서 종류를 바꿔 저장하든 **같은 경로**다 | 응답 `camera.kind === 'backend-core'`. 나머지 3대는 손대지 않는다 |

**왜 이 방법인가**
- 이 라우트는 저장 직후 **`deps.configStore.reloadCameras()` 를 부른다**(`dbRoutes.ts:128`). `sqlite3` 로 직접 `UPDATE` 하면 DB 는 바뀌지만 **메모리의 `config.cameras` 는 옛 값 그대로**라 다음 명령이 여전히 틀린 드라이버로 나간다(`src/config/configStore.ts:65` 가 경고하는 바로 그 함정).
- 일회성 보정을 위한 **스크립트·마이그레이션 코드를 소스에 남기지 않는다**(CLAUDE.md 2·3번). 이미 있는 정식 편집 경로를 쓴다.
- **UI 로 다른 카메라를 저장하는 일은 3-4 이전에 하지 않는다.** `web/optionsDb.js:208` 이 `camKind` 셀렉트에 `camera.kind`(=undefined)를 넣으면 셀렉트가 첫 항목으로 떨어지고, 그 상태로 저장하면 **틀린 kind 를 확정 기록**한다.

**되돌리기**: 3-2 의 백업 디렉토리에서 세 파일을 되돌린다(서버 정지 상태에서).

---

### 4단계. 동작 확인 (서버 재기동 후, 실제 호출)

성공 기준을 **"400 `알 수 없는 카메라 종류` 가 사라졌다"로 좁힌다.** 실제 카메라의 타임아웃·502·인증 실패는 **이번 버그와 다른 문제**이며 여기서는 실패로 치지 않는다.

| # | 확인 | 성공 기준 |
|---|---|---|
| 4-1 | `GET /api/settings` | `cameras` 4대 **전부** `kind` 와 `timeoutMs` 가 값이 있다. `real-camera-2.kind === 'backend-core'`, 나머지 3대 `'hucoms'`, 전부 `timeoutMs === 5000` |
| 4-2 | `GET /api/ptz?cameraId=simulator-1` / `simulator-2` / `real-camera-1` / `real-camera-2` | 응답이 **400 + 본문에 `알 수 없는 카메라 종류` 가 아니다.** 200 이면 통과, 502/504/타임아웃이어도 **이 항목은 통과**(별건으로 기록) |
| 4-3 | `GET /api/stream?cameraId=simulator-1` | 400 이 아니다. 응답 헤더 `Content-Type` 이 `multipart/x-mixed-replace` 계열 |
| 4-4 | `GET /api/snapshot?cameraId=simulator-1` | 400 `알 수 없는 카메라 종류` 가 아니다 |
| 4-5 | 웹 UI 열기 | "영상을 받지 못했습니다 — 옵션 페이지에서 RTSP·시뮬레이터 URL 을 확인하세요" 토스트가 **뜨지 않는다** |
| 4-6 | `POST /api/db/cameras/1/test` | 응답의 `kind` 가 `'hucoms'` 이고, `ok:false` 일 때의 `error` 가 `알 수 없는 카메라 종류` 가 **아니다** |

4-2~4-4 에서 **다른** 실패(타임아웃 등)가 나오면 그 응답을 그대로 기록해 리더에게 올린다. 이 계획에서 고치지 않는다.

---

### 5단계. 영향도 조사 지시 (문서화 담당에게)

`kind`/`timeout_ms`/`park3d_cam_id`/`intrinsics` 가 **열 자체로 없었던 기간** 동안 DB 를 읽고 쓴 다른 경로에 남았을 2차 피해를 조사한다. 각 항목은 **결론 + 근거 경로**로 답한다.

1. **`SetupRepository.upsertCamera` 가 아예 실패했는가** — INSERT 문이 `timeout_ms, kind, park3d_cam_id, intrinsics` 를 **열 이름으로 명시**한다(`src/db/setupRepository.ts:174`). 없는 열이므로 SQLite 가 `no such column` 으로 던졌을 것이다. 그렇다면 그 기간의 **카메라 추가(`POST /api/db/cameras`)·수정(`PUT`)·삭제 후 재등록이 전부 실패**했다는 뜻이다. 로그나 사용자 증언으로 확인하고, 실패한 편집이 있었는지 → 3-5 이후 다시 해야 하는 작업이 있는지 정리한다.
2. **`dbRoutes.merged()`** (`src/api/routes/dbRoutes.ts:220`) — `current.kind`/`current.timeout_ms` 가 undefined 인 채로 patch 에 겹쳐졌다. 1번이 맞다면 저장이 던져서 **오염은 없었을** 가능성이 크다. 확인해 확정한다.
3. **`POST /api/db/cameras/:id/test`(연결 테스트 버튼)** — `createDriver` 실패를 `ok:false` 로 200 에 실어 보낸다(`dbRoutes.ts:114`). 즉 화면에는 "연결 실패"로 보였다. 이 기간의 실패 보고는 **네트워크 문제가 아니었다** — 사용자에게 오해가 남았는지 확인.
4. **장비 프리셋 라우트** — `src/api/routes/devicePresetRoutes.ts:23,34` 가 `camera.kind !== 'hucoms'` 면 **501** 로 거절한다. undefined 였으므로 **모든 카메라의 장비 프리셋 기능이 501 로 죽어 있었다.** 3단계 뒤 hucoms 3대에서 되살아나는지 확인.
5. **`providerFactory`**(`src/core/providerFactory.ts:39`)와 `camera.timeoutMs` 를 그대로 `AbortSignal.timeout()` 으로 넘기는 경로들 — undefined 가 들어갔을 때 무슨 일이 났는지(즉시 abort / TypeError) 확인. 코어 프로바이더가 createDriver 이전에 죽는 경로가 있었는지.
6. **DB 탭 테이블 뷰어**(`src/db/tableQuery.ts`, `web/` 뷰어) — `SELECT *` 기반이면 이제 열이 10→14 로 늘어난다. 열 목록을 굳혀 둔 자리(헤더 하드코딩, 열 수 가정)가 없는지 확인.
7. **MCP 라우트 카탈로그**(`src/mcp/routeCatalog.ts`) — 카메라 `kind` 를 노출·분기하는 자리가 있으면 그동안 무엇을 답했는지 확인.
8. **브리지 코어 박스줌**(`src/core/bridge/bridgeCoreProvider.ts:80,127`) — `intrinsics` 가 없으면 `centerBox` 가 501 로 거절된다. **다만 `config.json.bak-cameras` 에도 intrinsics 가 없었으므로 이번 버그 이전부터 꺼져 있었다.** 이 사실을 확인해 "이번 수정으로 켜지지 않는다"를 분명히 기록하고, 줌→화각 표를 채우는 일은 **별건**으로 올린다(확인 필요 B).
9. **`park3d_cam_id`** — 4대 중 park3d-rpc 종류가 없으므로 피해 없음이 예상된다. 확인만 한다.
10. **형제 프로젝트 영향 없음 확인** — 이번 변경은 `SettingMain` 안의 DB 계층에 갇힌다. `AgentVLA/ParkAgent/SettingAgent` 와의 계약을 바꾸지 않는다는 점을 명시한다.

---

## 영향 받는 파일/모듈

**수정**
- `SettingMain/src/db/schema.ts` — `SCHEMA_VERSION` 2→3, 머리말 주석 보강
- `SettingMain/src/db/database.ts` — `migrate()` 조기 반환 제거, `upgradeToV2()` 무조건 호출, 스키마 대조 함수 추가, 낡은 주석 갱신
- `SettingMain/test/database.test.ts` — 2단계 케이스 추가

**읽기만 (수정 없음, 동작이 달라지는 쪽)**
- `SettingMain/src/db/configCameras.ts` — `toCameraConfig()` 가 이제 실제 값을 반환
- `SettingMain/src/db/setupRepository.ts` — INSERT 가 성공하기 시작
- `SettingMain/src/devices/driverFactory.ts` — `default` 분기로 떨어지지 않게 된다
- `SettingMain/src/api/routes/mediaRoutes.ts`, `ptzRoutes`·`devicePresetRoutes`·`dbRoutes`
- `SettingMain/src/config/configStore.ts` — `readCameras()` 결과가 채워진다

**데이터**
- `SettingMain/config/setup.db`(+`-wal`,`-shm`) — 3단계에서 열 4개 추가 및 1행 수정
- 백업: `SettingMain/config/backup/20260806_HHMMSS/`

**손대지 않음**: `config.json`, `config.json.bak-cameras`(복구 근거이므로 **지우지 않는다**), `web/`, `src/vendor/`

## 비범위 (하지 않을 것)

- 마이그레이션 프레임워크(판별 파일 분리, 다운그레이드, 이력 표) 도입
- `intrinsics`(줌→화각 표) 채워 넣기 — 이번 버그 이전부터 비어 있었다(확인 필요 B)
- `cam_company` 값 정리 — 근거 없음(확인 필요 A)
- 4단계에서 드러날 수 있는 **실제 카메라 통신 실패**(타임아웃·인증·502) 수정 — 별건으로 올린다
- `sqlite3` 직접 UPDATE 나 일회성 보정 스크립트를 소스에 추가하는 것
- 관련 없는 리팩토링(`database.ts`·`schema.ts` 의 나머지 주석·구조 손대지 않는다)
