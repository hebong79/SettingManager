# 07. 검증 — 스키마 v4(`cam_company` 삭제) 회귀 테스트 실제 실행 결과

작성 2026-08-06 / 대상 `d:\Work\Parking3D\Agent\baro\SettingManager`
선행: `_workspace/05_architect_plan_v4.md`(4절·5-3·5-7) · `_workspace/06_developer_changes_v4.md` · `_workspace/03_qa_report.md` — **셋 다 전문 읽었다.**

**소스는 한 줄도 고치지 않았다.** 고친 파일은 테스트 셋뿐이다
(`test/database.test.ts` · `test/dbRoutes.test.ts` · `test/optionsDbUi.test.ts`).
`git status -- SettingMain/src SettingMain/web` 목록이 세션 시작 시점과 동일함을 확인했다 —
watcher 를 건드릴 저장이 없었다.

**운영 DB 는 읽기만 했다.** 새 테스트는 전부 `mkdtemp(join(tmpdir(), …))` 임시 경로나 `:memory:` 만
쓰고, `openDatabase()` 를 인자 없이 부르는 자리는 하나도 없다. `config/setup.db` 의 mtime 은
13:38(리더의 서버 기동)이고 내 첫 명령은 13:44 다 — 내가 쓴 흔적이 없다.

---

## 1. 실행 명령 / 결과 요약 (원문 수치 그대로)

### 1-1. `npm run typecheck` — 통과 (오류 0)

```
> settingmanager@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
```
출력 없음. 새 테스트에 `any`·`@ts-ignore` 없다. `as unknown as` 는 기존 `PRAGMA table_info` 관례만 따랐다.

### 1-2. `npx vitest run test/database.test.ts` — **40 통과 / 0 실패 / 0 스킵**

```
 Test Files  1 passed (1)
      Tests  40 passed (40)
```
(이번 작업 전 33 → **7건 추가**)

### 1-3. `npx vitest run test/database.test.ts test/dbRoutes.test.ts test/optionsDbUi.test.ts`

```
 Test Files  3 passed (3)
      Tests  107 passed (107)
```
(이번 작업 전 97 → **10건 추가**, 전부 통과)

| 파일 | 전 | 후 | 추가 |
|---|---|---|---|
| `test/database.test.ts` | 33 | **40** | +7 |
| `test/dbRoutes.test.ts` | 40 | **42** | +2 |
| `test/optionsDbUi.test.ts` | 24 | **25** | +1 |

### 1-4. `npm run test` (전체) — **490 통과 / 20 실패 / 0 스킵**

```
 Test Files  3 failed | 30 passed (33)
      Tests  20 failed | 490 passed (510)
```

| | Test Files | Tests |
|---|---|---|
| 구현자 보고(기준선) | 3 failed / 30 passed | 20 failed / **480** passed (500) |
| 이번 작업 후(실측) | 3 failed / 30 passed | 20 failed / **490** passed (510) |

**실패는 20건 그대로다 — 늘지 않았다.** 실패 20건의 소속·제목도 기준선과 동일함을 목록으로 대조했다:

| 파일 | 건수 |
|---|---|
| `test/server.test.ts` | 17 (기기 추가·삭제 5, 연결 테스트 3, 요청 본문 인코딩 2, 설정(옵션 페이지) 6, 영상·정적 파일 1) |
| `test/park3dRpcServerRoutes.test.ts` | 2 |
| `test/powershellSafeDiagnostic.test.ts` | 1 |

원인은 커밋되지 않은 다른 작업(카메라 정본 이관 + 옵션 화면 재작성 + 진단 스크립트 삭제)이며,
`03_qa_report.md` 「기존 20건 실패 — 직접 확인한 원인」에서 한 건씩 원인을 밝혀 두었다. 이번 건과 무관하다.

---

## 2. 작성한 테스트와 성공 기준

### 2-1. `test/database.test.ts` — 신규 `describe('cam_company 삭제 — 스키마 v4 (계획 5-3)')` 6건

**픽스처 `writeV3AugmentedFixture(path)`**(계획 5-3)를 새로 만들었다 — 옛 10열(`cam_company` 포함)
+ `upgradeToV2` 가 ALTER 로 붙인 v2 열 넷 + `user_version = 3`. **마이그레이션 직전 운영 DB 와 같은
모습**이다. 넣는 순서(10열 INSERT → ALTER 넷 → UPDATE 로 채우기)도 실제 경로 그대로다.

> **판 번호 `3` 은 상수(`SCHEMA_VERSION`)가 아니라 리터럴로 박았다.** 이것은 "지금 코드의 판"이
> 아니라 **그때 디스크에 있던 사실**이기 때문이다. 상수를 쓰면 판이 같아져 판 올리기 블록을
> 건너뛰고, 시험하려던 드롭이 아예 돌지 않는다.

심은 카메라 3줄은 운영의 세 패턴을 덮는다 — `real-camera-1`(hucoms/휴컴스/`park3d_cam_id` 없음) ·
**`simulator-1`(hucoms/**시뮬레이터**/없음) ← 1:1 이 아니었던 유일한 반례** ·
`simulator-3`(park3d-rpc/언리얼 Park3D 시뮬/**`park3d_cam_id`=2**).
`timeout_ms` 는 일부러 기본값 5000 이 아닌 3000·2500·4000 을 넣었다 — 기본값으로 시험하면
"보존됐다"와 "지워지고 기본값이 다시 채워졌다"를 구분할 수 없다.

| # | 테스트 | 성공 기준 | 결과 |
|---|---|---|---|
| 전제 | 픽스처가 **열기 전에** `cam_company` 를 갖고 판이 3 이다 | 열 14개가 이름·순서까지 운영 DB 와 같고 `user_version === 3 < SCHEMA_VERSION` | **통과** |
| **4-1** | **핵심.** `writeV3AugmentedFixture` → `openDatabase({ path })` | `columnsOf` 가 **`cam_company` 를 포함하지 않고**(이름으로 단언) 길이 13, `user_version === SCHEMA_VERSION`(4) | **통과** |
| 4-2 | 나머지 데이터 보존 | `listCameras()` 전체를 `toEqual` 로 통째 비교(여분 키도 실패로 본다). **`simulator-3.park3d_cam_id === 2`** 를 따로 못박음 | **통과** |
| 4-3 | `simulator-1` — 제조사만 사라지고 `kind` 는 그대로 | `kind === 'hucoms'`, `not.toHaveProperty('cam_company')`, `readCameras()` 를 지나도 동일 | **통과** |
| 4-4 | 옛 10열 파일(v2)도 같은 결과 | 13열·`cam_company` 없음 + `kind==='hucoms'`·`timeoutMs===5000` 이 붙어 있다(보강과 삭제가 한 번의 열기에서) | **통과** |
| 4-6 | 멱등 | 닫고 다시 열어도 안 던지고 열 집합·행 수·판이 동일 | **통과** |

**「전제」를 따로 둔 이유**: 이것이 없으면 픽스처가 조용히 망가져도(예: `LEGACY_SCHEMA_SQL` 에서
누가 `cam_company` 를 지워도) 4-1~4-4 가 전부 통과한다. 구현자가 「함정」으로 경고한 자리를
**단언으로 바꿔** 못박았다.

### 2-2. 4-5 — `[2-4]` 를 구현자가 남긴 대로 채웠다

구현자가 「계획과 다르게 한 것 1」로 비워 둔 자리다. 제목을 「새 파일은 처음부터 13열이고
**`cam_company` 가 없다**」로 바꾸고 `expect(...).not.toContain('cam_company')` 한 줄을 더했다.

> **개수만으로는 부족하다.** `toHaveLength(13)` 은 "**다른** 열 하나를 잃고 `cam_company` 는 남은"
> 파일과 13열 정상 파일을 구분하지 못한다. 그래서 이름 단언을 앞에 둔다. 4-1 에도 같은 이유로
> `not.toContain` 을 `toHaveLength` 보다 먼저 놓았다.

### 2-3. `test/dbRoutes.test.ts` — 2건

- **공개 응답에 `cam_company` 키가 없다 — GET·PUT 양쪽**:
  `GET /api/db/cameras` 의 각 원소와 `PUT /api/db/cameras/:id` 응답의 `camera` 에
  `not.toHaveProperty('cam_company')`. `toMatchObject` 계열은 **여분 키를 문제 삼지 않아** 누가
  라우트에서 그 키를 되살려도 잡지 못하므로 `not.toHaveProperty` 로 봤다.
- **POST 본문의 `cam_company` 는 조용히 무시된다(400 이 아니다)**: 계획 확인필요 B 의 기본 방침을
  계약으로 고정. `status === 200`, 응답·DB 양쪽에 키가 없다.

### 2-4. `test/optionsDbUi.test.ts` — 1건

`web/optionsDb.js` 에 `cam_company` 가 없고 `web/options.html` 에 `camCompany`·`cam_company` 가
없다. **js·html 을 함께 본다** — 한쪽만 지우면 「입력칸은 있는데 `draft()` 가 안 보내는」 어긋난
상태가 되고, 그때 사람은 값을 적고 저장했는데 아무 일도 안 일어나는 화면을 본다.

---

## 3. 회귀 방향 확인 — **되돌린 코드에서 무엇이 실패했는가**

**통과하는 테스트는 아무것도 증명하지 않는다.** 작업 트리를 스크래치패드로 복사하고
(`robocopy /E /XD node_modules .git config`, `node_modules` 는 정션으로 연결) **그 사본에서만**
되돌렸다. `git stash` 는 쓰지 않았고 저장소·서버·운영 DB 는 건드리지 않았다.
`src/db/` 는 여전히 미추적이라 `git show HEAD:` 로는 되돌릴 수 없어 06 문서의 변경 역을 손으로 적용했다.

### 갈래 A — `schema.ts`·`database.ts` 를 **v4 이전으로 통째 되돌림**

(`SCHEMA_VERSION` 4→3, `SCHEMA_SQL` 에 `cam_company` 복원, `dropCamCompany()` 호출·함수 제거)

```
      Tests  12 failed | 95 passed (107)
```

| 실패한 테스트 | 재현된 것 |
|---|---|
| **[4-1]·[4-2]·[4-3]·[4-4]·[4-6]**, [전제] | 판(3)이 코드의 판(3)과 같아 **판 올리기 블록을 통째로 건너뛴다** → `SCHEMA_SQL` 이 아예 돌지 않아 `preset_info`·`slot_setup`·`floor_ROI`·`parking_slot`·`parking_evnt` 가 만들어지지 않고 `verifySchema` 가 던진다 |
| [2-4] | 새 파일이 14열이라 `not.toContain('cam_company')` 실패 |
| 경계면 교차 3건 | `SCHEMA_SQL`(14열)과 `CameraRow`·INSERT(13열)가 **한쪽만 되돌아간** 상태 — 이 셋이 정확히 이것을 잡으라고 지어진 자리다 |
| `dbRoutes` 2건 | 응답에 `cam_company` 키가 되살아난다 |

4-1 의 실패 문구:
```
DatabaseError: DB 스키마가 코드의 기대와 다릅니다 — preset_info 표가 없습니다; …
```

**이 갈래만으로는 부족하다.** 4-1 이 실패하긴 하지만 「`cam_company` 가 남았다」가 아니라
「표가 통째로 없다」로 실패해서, 이 테스트가 **드롭을 지키는지**를 증명하지 못한다. 그래서 갈래 B 를 더 돌렸다.

### 갈래 B — **`dropCamCompany(db);` 한 줄만 제거** (가장 중요)

`schema.ts` 는 v4 그대로 두고(판 4 · `SCHEMA_SQL` 에 열 없음) `database.ts` 의 호출 한 줄과
함수만 지웠다. 이것이 계획 §1-3 이 경고한 **저장 순서 사고**의 모습이자, 구현자가 그 한 줄을
빠뜨렸을 때의 모습이다.

```
      Tests  4 failed | 103 passed (107)
```

실패한 것은 **정확히 [4-1]·[4-2]·[4-3]·[4-4]** 넷이고, 4-1 의 문구는:

```
AssertionError: expected [ 'cam_id', 'cam_name', …(12) ] to not include 'cam_company'
 ❯ test/database.test.ts:579:27
   579|       expect(columns).not.toContain('cam_company');
```

**= 14열, `cam_company` 가 그대로 남았다. 계획이 예측한 그대로다.**

> **이 갈래에서 드러난 사실 — 계획 2-2(라)의 판단이 실측으로 확인됐다.**
> 갈래 B 에서 `user_version` 은 **4 로 올라갔는데 열은 남았다.** 그런데도
> **`verifySchema()` 는 통과했고**(여분 열을 문제 삼지 않으므로) 다른 103건도 전부 통과했다.
> 즉 **이 상태를 잡는 안전망은 저장소 안에 4-1 뿐이다.** 계획이 "런타임에 던지는 대신 테스트로
> 막는다"고 결정한 그 자리가, 이제 실제로 그 일을 한다는 것이 증명됐다.
> 반대로 4-1 이 없었다면 이 사고는 **CI 를 조용히 통과했을 것이다.**

### 갈래 A 에서 관찰된 부수 현상 (결함 아님 / 기록)

갈래 A 의 4-1 은 `openDatabase()` 가 던지는 경로라, 반환되지 않은 핸들을 아무도 닫을 수 없어
`afterEach` 의 `rm(dir, { recursive: true, force: true })` 가 `EBUSY … setup.db-wal` 을 냈다
(구현자가 경고한 Windows 핸들 함정). **현재 v4 코드에서는 이 describe 의 어떤 테스트도
`openDatabase()` 에서 던지지 않으므로 나타나지 않는다** — 실제로 저장소 실행에서 EBUSY 는 한 번도 없었다.

---

## 4. 경계면 교차 비교 결과 — v4 로 갱신

리더 지시대로 **양쪽을 같이 열어** shape 을 맞대 봤다.

| 왼쪽(생산자) | 오른쪽(소비자) | 결과 |
|---|---|---|
| `schema.ts` `SCHEMA_SQL` 의 `camera_info` **13열** | `setupRepository.ts:18` `CameraRow` 13키 | **일치**(이름·개수) — `cam_company` 가 양쪽에서 함께 빠졌다 |
| `SCHEMA_SQL` 13열 | `setupRepository.ts:173` `upsertCamera` INSERT 열 목록·물음표 13·바인딩 13 | **일치** — 계획이 경고한 「열 목록/물음표/바인딩 개수 어긋남」 없음 |
| `SCHEMA_SQL` 13열 | `configCameras.ts:20` `toCameraConfig()` 가 읽는 11열 | **일치**(전부 실재) |
| `dbRoutes.merged()` 의 `text` 유니온·반환 키 | `CameraRow` | **일치** — `cam_company` 유니온·대입 모두 제거됨 |
| `publicCamera()` 응답 키 | `web/optionsDb.js` 의 `FIELDS`·`draft()` | **일치** — 양쪽에서 함께 빠졌다 |
| `upgradeToV2()` 가 붙이는 열 순서 | `SCHEMA_SQL` 의 열 순서 | **일치**(둘 다 `timeout_ms, kind, park3d_cam_id, intrinsics`) |

**어긋난 것은 없었다.** 코드로 고정한 자리는 넷이다.

1. `표의 열 집합 === Object.keys(upsertCamera 반환값)` — `CameraRow` 는 타입이라 런타임에 지워지므로
   `upsertCamera` 가 **`CameraRow` 로 만들어 돌려주는 객체**의 키를 본다.
2. **「13열 전부가 INSERT 를 왕복한다」 — 형태를 유지했다.** `FULL_ROW` 는 13열 전부를
   **기본값이 아닌 값**으로 채우고 `SELECT *` 결과를 `toEqual` 로 통째 비교한다.
   INSERT 열 목록에서 빠진 열은 오류 없이 조용히 기본값이 되므로, 기본값으로 시험하면 누락과 구분되지 않는다.
3. `toCameraConfig()` 결과 전체를 기대값과 통째 비교(조건부 키 `camId`·`intrinsics` 포함).
4. **신규 — 「`cam_company` 는 네 자리 어디에도 없다」.** 위 셋은 **개수·집합**으로 어긋남을 잡으므로
   "한쪽만 되돌리고 다른 열 하나를 함께 지운" 상태를 통과시킬 수 있다. 그래서 v4 가 지운
   **이름 하나**를 `SCHEMA_SQL` ↔ `CameraRow` ↔ INSERT 결과 ↔ `toCameraConfig` 네 자리에서 따로 못박았다.

---

## 5. 발견 결함

**이번 v4 구현에서 발견한 결함 0건.** 계획 5-3 의 4-1~4-6, 5-4, 5-5 전부 충족.

보고 사항 둘(결함 아님):

1. **갈래 B 가 `verifySchema()` 를 통과한다** — 위 3절 인용문. 계획이 이미 감수한 선택이고 결과적으로
   4-1 이 그 자리를 정확히 메운다. 다만 **그 테스트를 지우거나 느슨하게 고치면 안전망이 통째로
   사라진다**는 뜻이므로, 4-1 은 앞으로 손대지 말아야 할 자리다.
2. **ALTER 로 보강된 옛 파일에 `kind`·`intrinsics` 의 CHECK 가 없다** — 03 보고서에서 별건으로 올린
   그대로다. `writeV3AugmentedFixture` 도 그 상태를 재현하며(주석에 명시), `DROP COLUMN` 이 이 상태를
   바꾸지 않음을 이번 실행이 다시 보여 준다. **계획 비범위. 테스트로 굳히지 않았다** —
   현재 동작을 "옳다"고 못박는 셈이 되기 때문이다.

---

## 6. 운영 DB — 읽기 전용 확인 (범위 밖이지만 리더에게 필요한 사실)

`{ readOnly: true }` 로 한 번 조회했다. **쓰지 않았다.**

```
user_version = 4
columns = cam_id, cam_name, cam_uuid, url, user_id, password, rtsp_url, cam_type,
          place_id, timeout_ms, kind, park3d_cam_id, intrinsics       ← 13열, cam_company 없음
[{"cam_id":1,"cam_uuid":"real-camera-1","kind":"hucoms","park3d_cam_id":null},
 {"cam_id":2,"cam_uuid":"real-camera-2","kind":"hucoms","park3d_cam_id":null},
 {"cam_id":3,"cam_uuid":"simulator-1","kind":"hucoms","park3d_cam_id":null},
 {"cam_id":4,"cam_uuid":"simulator-2","kind":"park3d-rpc","park3d_cam_id":1},
 {"cam_id":5,"cam_uuid":"simulator-3","kind":"park3d-rpc","park3d_cam_id":2}]
```

**마이그레이션이 이미 돌았다.** 계획 6단계 중 **6-1(13열·`cam_company` 없음) · 6-2(판 4) ·
6-3(5대 보존) · 6-4(`kind` 보존) · 6-5(`park3d_cam_id` 4→1, 5→2 보존)가 충족**된다.
6-5 는 계획이 "여기가 틀리면 엉뚱한 카메라가 움직인다"고 못박은 자리이고, 값이 정확하다.

별건 확인: `real-camera-2` 의 `kind` 가 여전히 `hucoms` 다(계획 확인필요 D). 이번 범위 밖이지만 그대로다.

---

## 7. 미검증 항목과 사유

1. **계획 6-6 ~ 6-10 (살아 있는 서버에 대한 HTTP 확인)** — 서버 기동·정지는 리더 소관이라
   `:13030` 을 두드리지 않았다. 따라서 `GET /api/db/cameras` 실응답, 옵션 페이지 카메라 탭의
   「제조사」 칸 부재와 저장 200, `GET /api/settings` 무변화, `POST /api/db/cameras/3/test` 의
   `kind==='hucoms'`, 서버 로그의 `DatabaseError` 부재는 **내가 확인한 사실이 아니다.**
   같은 계약을 임시 DB + 인메모리 서버로는 `dbRoutes.test.ts` 가 덮는다.
2. **기존 20건 실패의 수정** — 계획 비범위. 03 보고서에서 원인만 밝혔다. 특히 `server.test.ts` 17건은
   이미 옮겨진 `/api/cameras` 라우트를 겨누고 있어 **지금 아무 계약도 지켜 주지 않는다** — 리더 판단 사항.
3. **`docs/my_think/my_db_table.md:26`(계획 확인필요 A)** — 마스터 판단 사항이라 손대지 않았고
   테스트로도 다루지 않았다.
4. **ALTER 보강 파일의 CHECK 부재를 테스트로 고정하지 않았다** — 5절 2번. 일부러 남겼다.
5. **`verifySchema` 가 자료형·`NOT NULL`·기본값·여분 열을 안 본다** — 설계가 그렇게 정한 것이라
   시험하지 않았다. 갈래 B 가 그 성질을 실측으로 보여 준다.
6. **회귀 방향 확인의 되돌리기는 근사다** — `src/db/` 가 미추적이라 `git show HEAD:` 를 쓸 수 없어
   06 문서에 적힌 변경의 역을 사본에 손으로 적용했다. 이 점을 그대로 밝힌다.
7. **`writeV3AugmentedFixture` 는 카메라 3줄만 심는다** — 운영은 5대다. 세 **패턴**을 덮는 것이
   목적이고 나머지 둘은 같은 패턴의 반복이라 늘리지 않았다. 대신 운영 DB 5대는 6절에서 실측했다.
