# 02. 구현 — 1단계 (스키마 판 올림 + 마이그레이션 실행 보장 + 열기 시점 대조)

작성 2026-08-06 / 대상 `d:\Work\Parking3D\Agent\baro\SettingManager`
구현 범위는 계획서 「1단계」뿐이다. 2단계(테스트)·3단계(운영 DB 복구)는 손대지 않았다.

---

## ⚠️ 먼저 읽을 것 — 운영 DB 가 **이미 마이그레이션되었다** (계획 3-2 백업 없이)

**개발 서버가 `nodemon --watch src` 로 돌고 있어서, 내가 `src/db/*.ts` 를 저장한 순간 서버가
스스로 재기동했고 그 기동이 `openDatabase()` → `migrate()` 를 태웠다.** 즉 계획 3-4 가
3-2(백업)·3-3(테스트 통과)보다 먼저 일어났다. 의도한 것이 아니고, 내가 DB 나 서버에 직접
명령한 것도 아니다 — 파일 저장의 부수 효과다.

실측 상태(읽기 전용으로 확인, 2026-08-06 12:10 기준):

| 항목 | 값 |
|---|---|
| `PRAGMA user_version` | **3** |
| `camera_info` | **14열** (`…, place_id, timeout_ms, kind, park3d_cam_id, intrinsics`) |
| cam 1 real-camera-1 | `kind=hucoms`, `timeout_ms=5000`, `park3d_cam_id=NULL`, `intrinsics=NULL` |
| cam 2 real-camera-2 | `kind=hucoms` ← **아직 `backend-core` 로 고쳐야 한다(계획 3-5)** |
| cam 3 simulator-1 | `kind=hucoms`, `timeout_ms=5000` |
| cam 4 simulator-2 | `kind=hucoms`, `timeout_ms=5000` |
| 서버 | `:13030` 살아 있음(`/api/health` 200). `/api/settings` 의 카메라에 `kind`·`timeoutMs` 가 값으로 나온다 |

**잃은 것은 없다.** `ALTER TABLE ADD COLUMN` 은 기존 줄을 건드리지 않으므로 옛 10열의 값은
그대로고, 복구 근거인 `config/config.json.bak-cameras`(8/5 23:25)도 손대지 않았다. 다만
**계획이 요구한 사전 백업(3-2)이 없는 상태**이므로, 리더는 지금이라도 서버를 정지시킨 뒤
세 파일(`setup.db`·`-wal`·`-shm`)을 백업하고 **3-5(`PUT /api/db/cameras/2` 로 `kind` 를
`backend-core`)만 남은 것으로 보고 진행하면 된다.** 3-4 는 사실상 끝났다.

---

## 바꾼 파일

### 1. `SettingMain/src/db/schema.ts` (1-1)

- `SCHEMA_VERSION` **2 → 3**.
- 머리말 주석에 두 줄을 덧붙였다 — "판을 올리는 규율"은 그대로 두되, **잊어도 여는 시점의
  대조가 잡는다**는 사실과 그 함수 이름(`database.ts` 의 `verifySchema`)을 적었다. 규율만 적어
  두었다가 이번에 실패했으므로, 안전망이 어디 있는지 읽는 사람이 바로 찾을 수 있어야 한다.

그 밖의 `SCHEMA_SQL` 본문은 **한 글자도 건드리지 않았다**(계획 비범위).

### 2. `SettingMain/src/db/database.ts` (1-2, 1-3)

**(가) `migrate()` 구조 변경 (1-2)**

- `if (current === SCHEMA_VERSION) return;` **조기 반환을 없앴다.** 대신 판 올리기 전체를
  `if (current < SCHEMA_VERSION) { … }` 블록으로 감쌌다.
- `current > SCHEMA_VERSION` 던지기는 **문구·위치·조건 모두 그대로**다.
- 블록 안 `if (current >= 1) upgradeToV2(db);` → **`upgradeToV2(db);` 무조건 호출**.
- 블록 끝난 **뒤에, 판을 올렸든 안 올렸든 `verifySchema(db)` 를 항상 부른다.**
- 주석: "지금은 초판뿐이라 …" → "판이 뒤처진 파일만 손대고, 마지막에 언제나 대조로 확인한다".
  블록 안 주석에 **"판 번호로 분기하지 않는다 — 판 번호로 갈랐던 자리가 바로 v2 열 넷을 통째로
  빠뜨린 자리다"** 를 더했다(이 버그의 교훈이 코드 옆에 남아 있어야 다음 사람이 되돌리지 않는다).

**(나) `upgradeToV2()` 머리말 주석 갱신 (1-2)**

- "v1 → v2:" 라는 판 번호 표현을 지우고, **"어느 옛 판에서 올라와도 멱등하다 — 판 번호가 아니라
  열이 있는지로 판단한다"** 로 바꿨다. 본문(ADD COLUMN·CHECK 설명)은 그대로다.
- **함수 이름은 `upgradeToV2` 그대로 두었다.** 계획이 요구한 것은 표현 갱신이지 개명이 아니고,
  하는 일(“v2 에서 더해진 열 넷을 채운다”)은 이름과 여전히 맞다. 외과적 변경 원칙(CLAUDE.md 3번).

**(다) 열기 시점 스키마 대조 `verifySchema()` 추가 (1-3)**

`database.ts` 안의 **비공개** 함수다(내보내지 않는다). 보조로 `schemaObjectsOf()`(비공개)와
`SchemaObject` 인터페이스가 붙는다 — 같은 뽑기를 기준 DB 와 실제 DB **두 번** 하므로,
그 자리에 코드를 두 벌 복사하는 것보다 함수 하나가 짧고 어긋날 데가 없다.

---

## 대조 함수의 동작 요약

| 축 | 내용 |
|---|---|
| **기대** | `:memory:` 에 **`SCHEMA_SQL` 만** 실행한 일회용 기준 DB. 즉 "코드가 만들려던 모습"을 SQLite 가 스스로 답하게 한다. 기대 목록을 사람이 적지 않으므로 목록이 낡을 수 없다 |
| **실제** | 지금 연 DB(파일이든 메모리든) |
| **뽑는 것** | 양쪽에서 `SELECT name, type FROM sqlite_master WHERE type IN ('table','view')` + 각각의 `PRAGMA table_info` 열 이름 |
| **문제 삼는 방향** | **기대에 있는데 실제에 없는 것만.** 없는 표/뷰 → `preset_info 표가 없습니다` · `floor_ROI 뷰가 없습니다`. 표는 있는데 없는 열 → `camera_info 에 kind, timeout_ms 가 없습니다` |
| **무시하는 방향** | **실제에만 있는 여분의 표·열은 보지 않는다.** 앞선 판이 연 파일은 `user_version` 검사가 이미 막고, 그 밖의 여분은 우리 코드가 읽지 않는다 |
| **던지는 것** | `DatabaseError`(기본 statusCode 500). 메시지 = `DB 스키마가 코드의 기대와 다릅니다 — ` + 어긋남들을 `; ` 로 이은 문장. **이름을 그대로 싣는다** |
| **고치지 않는다** | 검사만 한다. 자동 보정을 넣으면 "무엇이 왜 어긋났나"를 아무도 안 보게 되고 대조가 두 번째 마이그레이션 엔진이 된다(계획 1-3의 역할 분담) |
| **부르는 자리** | `migrate()` 의 맨 끝, **항상**. 판이 이미 최신이라 판 올리기를 통째로 건너뛴 파일이 이번 사고의 모습이었다 |
| **핸들** | 기준 DB 는 `try/finally` 로 **반드시 닫는다**. `finally` 안에 `close()` 를 두어 `SCHEMA_SQL` 이 던져도 새지 않는다 |

### 뷰와 SQLite 내부 표 (계획이 확인하라고 한 부분)

- **뷰 `floor_ROI` 는 대조 대상에 포함한다.** `sqlite_master` 를 `type IN ('table','view')` 로
  받고, `PRAGMA table_info` 는 뷰에도 동작해 **뽑는 열 이름**을 준다. 즉 뷰가 통째로 없는 것도,
  뷰가 내놓는 열이 줄어든 것도 잡힌다. 메시지에서는 `표`/`뷰` 를 구분해 적는다(`type` 으로 판별).
- **`sqlite_sequence` 는 양쪽 모두에서 뺀다** (`AND name NOT LIKE 'sqlite_%'`). 실측 확인:
  `AUTOINCREMENT` 표(`preset_info`·`parking_evnt`)를 만들면 SQLite 가 `sqlite_sequence` 를
  **표로** 만들고, 그것이 `sqlite_master` 에 그대로 나온다. 기준 DB 에는 `SCHEMA_SQL` 을 태우니
  항상 생기지만, **실제 쪽에는 없을 수 있다** — 예컨대 2단계 2-7 이 만들 "preset_info 가 없는
  픽스처"에는 AUTOINCREMENT 표가 하나도 없어 `sqlite_sequence` 도 없다. 그 상태에서 걸러 내지
  않으면 **기대에만 있고 실제엔 없는** 꼴이 되어 진짜 문제(없는 표) 옆에 거짓 경보가 한 줄 더
  붙는다. 우리 의도(`SCHEMA_SQL`)가 아니라 SQLite 의 장부이므로 양쪽에서 뺐다.

---

## 계획과 다르게 한 것

1. **`upgradeToV2` 를 개명하지 않았다.** 위 (나) 참조. 계획은 주석 표현 갱신만 요구했고,
   개명은 계획에 없는 변경이라 하지 않았다.
2. **보조 함수가 하나 늘었다**(`schemaObjectsOf`). 계획은 "비공개 함수 하나(약 25줄)"라고 했다.
   같은 뽑기를 기준·실제 두 DB 에 해야 해서, 한 함수 안에 두 벌 복사하는 쪽이 더 길고 어긋나기
   쉬웠다. 실제 크기는 주석 제외 **약 35줄**이다. 프레임워크를 만들지 않았고 파일 밖으로
   내보내지도 않았다 — 계획의 취지(작고 닫힌 안전망) 안에 있다고 판단했다.

그 밖에 계획과 다른 점은 없다. **테스트는 쓰지 않았고**(2단계), 운영 DB 에 명령을 보내지
않았으며(3단계), 서버를 죽이지 않았다.

---

## 실제 실행 결과

### `npm run typecheck` — **통과**

```
> settingmanager@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
```
출력 없음(오류 0). `any` 로 덮거나 `@ts-ignore` 를 쓴 자리는 없다.

### `npm run test` — **20 실패 / 469 통과 (489), 3 파일 실패 / 30 통과 (33)**

```
 Test Files  3 failed | 30 passed (33)
      Tests  20 failed | 469 passed (489)
```

**이 20건은 전부 내 변경 이전부터 실패하던 것이다 — 대조로 확인했다.** 작업 트리를 건드리면
(nodemon 이 물고 있으므로) 서버가 옛 코드로 재기동해 `user_version=3` 파일을 열다 죽는다.
그래서 `git stash` 대신 **트리 전체를 스크래치패드로 복사한 뒤 그 사본에서만 내 두 파일을
변경 전 내용으로 되돌려** vitest 를 돌렸다.

| | Test Files | Tests |
|---|---|---|
| 변경 전(사본) | 3 failed / 30 passed | **20 failed / 469 passed** |
| 변경 후(현재) | 3 failed / 30 passed | **20 failed / 469 passed** |

실패 목록도 **한 건도 다르지 않다**:

- `test/server.test.ts` 17건 — 기기 추가·삭제, 연결 테스트, 옵션 페이지 저장, 요청 본문 인코딩,
  `/options` 정적 파일. 예: `expect(html).toContain('id="cameraSelect"')` 가 지금의
  `web/options.html` 에 없어서 실패한다.
- `test/park3dRpcServerRoutes.test.ts` 2건 — `POST /api/db/cameras/1/test` 가 `ok:false` 를
  기대하는데 `ok:true`, `PUT /api/db/cameras` 왕복에서 `label` 이 안 바뀐다.
- `test/powershellSafeDiagnostic.test.ts` 1건.

원인은 **작업 트리에 커밋되지 않은 다른 진행 중 작업**(git status 상 `web/options.html`,
`src/api/routes/*` 등이 수정·미추적 상태)이지 이번 DB 변경이 아니다. 이번 변경과 가장 가까운
`test/database.test.ts`·`test/dbRoutes.test.ts`·`test/bridgeStores.test.ts` 는 **전부 통과**한다
(판을 3 으로 올렸는데도 기존 `SCHEMA_VERSION + 1` 거절 테스트가 상수를 따라가므로 그대로 통과).

**이 20건은 이번 1단계에서 고치지 않는다** — 계획 비범위이고 원인이 다른 작업에 있다.
리더 판단이 필요하다.

### 임시 동작 확인 (테스트 파일을 만들지 않고, 임시 DB 로만)

2단계 전에 새 코드가 실제로 도는지만 확인했다(스크래치패드의 일회용 스크립트, **저장소에 남기지
않았고 운영 DB 를 열지 않았다**). 결과:

| 경우 | 결과 |
|---|---|
| 10열 옛 파일 + `user_version=2` 를 `openDatabase()` | 14열로 보강, `user_version=3`, 기존 행 보존(`{"cam_uuid":"real-camera-1","url":"http://x","kind":"hucoms","timeout_ms":5000}`) |
| 같은 파일 다시 열기(멱등) | 던지지 않음, 14열 그대로 |
| 새 빈 파일 | 14열, `user_version=3` |
| `place_info` 만 있고 `user_version=3` 으로 위조 | `DatabaseError: DB 스키마가 코드의 기대와 다릅니다 — camera_info 표가 없습니다; preset_info 표가 없습니다; slot_setup 표가 없습니다; floor_ROI 뷰가 없습니다; parking_slot 표가 없습니다; parking_evnt 표가 없습니다` |
| 14열 DB 에서 `ALTER TABLE camera_info DROP COLUMN park3d_cam_id` 후 `migrate()` | `DatabaseError: DB 스키마가 코드의 기대와 다릅니다 — camera_info 에 park3d_cam_id 가 없습니다` |

---

## 검증자(qa-tester)가 알아야 할 경계면

- **시그니처는 하나도 바뀌지 않았다.** `openDatabase(options?): DatabaseSync`,
  `migrate(db): void`, `transaction(db, work)`, `DatabaseError` 모두 그대로다.
  새 `verifySchema`·`schemaObjectsOf` 는 **내보내지 않는다** — 테스트는 `migrate()` 나
  `openDatabase()` 를 통해서만 대조를 건드린다.
- **던지는 형태**: `DatabaseError`, `name === 'DatabaseError'`, `statusCode === 500`.
  메시지는 `DB 스키마가 코드의 기대와 다릅니다 — ` 로 시작하고 그 뒤에 어긋난 것들이 `; ` 로
  이어진다. 열 이름은 **`SCHEMA_SQL` 에 적힌 순서**로 나온다(예: `timeout_ms, kind`).
  메시지 전체를 문자열 비교하지 말고 **빠진 이름이 들어 있는지**로 검사하는 편이 덜 부서진다.
- **계획 2-7 은 두 방법 다 된다.** 이 Node(v24.16.0)의 `node:sqlite` 는
  `ALTER TABLE … DROP COLUMN` 을 지원한다(위 표 마지막 줄에서 실제로 썼다). `preset_info` 를
  빼는 픽스처도 물론 잡힌다. 어느 쪽을 골라도 되며, 고른 이유를 테스트 주석에 남기면 된다.
- **Windows 주의 — 던진 뒤의 핸들.** `openDatabase()` 가 `migrate()` 에서 던지면 그 안에서 만든
  DB 핸들을 **아무도 닫을 수 없다**(반환되지 않으므로). 그 상태로 임시 디렉토리를 `rm` 하면
  Windows 에서 `EPERM` 이 난다 — 실제로 겪었다. **이것은 이번 변경이 만든 것이 아니라 기존
  `user_version` 거절 경로에도 있던 성질**이고(계획 비범위라 고치지 않았다), 다만 대조 때문에
  던지는 경우가 늘었으므로 테스트에서 만난다. 대응:
  `new DatabaseSync(path)` 로 **테스트가 핸들을 쥐고 `migrate(db)` 만 부른 뒤 직접 닫거나**,
  정리에서 `rm(dir, { recursive: true, force: true })` 로 실패를 흘리면 된다.
- 대조는 **열 이름만** 본다. 자료형·`NOT NULL`·`CHECK`·기본값은 보지 않는다 —
  `ADD COLUMN` 으로 `CHECK` 를 붙일 수 없어(위 `upgradeToV2` 주석) 옛 파일과 새 파일의 제약이
  원래부터 다르기 때문이다. 제약이 다르다고 던지면 정상적인 옛 파일이 전부 열리지 않는다.
