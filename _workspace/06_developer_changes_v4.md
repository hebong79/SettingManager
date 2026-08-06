# 06. 구현 — 스키마 v4: `cam_company` 삭제 (`kind` 하나로)

작성 2026-08-06 / 대상 `d:\Work\Parking3D\Agent\baro\SettingManager`
정본 계획: `_workspace/05_architect_plan_v4.md` (전문 읽음) · 선행 `_workspace/02_developer_changes.md`

마스터 결정을 그대로 구현했다 — **`cam_company` 열을 DB 에서 실제로 삭제하고 `kind` 를 남긴다.**
`simulator-1` 을 위한 데이터 작업은 하나도 없다(계획 4단계). 운영 DB `SettingMain/config/setup.db`
는 **한 번도 열지 않았다** — 마이그레이션은 리더가 서버를 켤 때 자동으로 돈다.

**저장 순서**: 서버가 정지해 있었지만 계획 1-3 의 규칙대로 **`database.ts` 를 `schema.ts` 보다 먼저**
저장했다(나중에 누가 서버를 켠 채 같은 작업을 반복할 때의 안전 관례).

---

## 바꾼 파일 (소스 8 · 테스트 3)

### 1. `SettingMain/src/db/database.ts` — 마이그레이션 본체

- `migrate()` 판 올리기 블록 안, `upgradeToV2(db);` **바로 다음 줄**에 `dropCamCompany(db);` 한 줄.
  그 밖의 구조·주석·`verifySchema()` 호출 위치는 손대지 않았다.
- 비공개 함수 `dropCamCompany()` 신설(`upgradeToV2()` 바로 아래). 주석에 계획이 요구한 셋을
  담았다 — 마스터 결정과 근거 위치(`schema.ts` 머리말 7번), **판 번호가 아니라 열이 있는지로
  판단한다**는 관례, `DROP COLUMN` 이 되는 이유(어떤 인덱스·뷰·CHECK 도 이 열을 참조하지 않는다).

### 2. `SettingMain/src/db/schema.ts`

- `SCHEMA_VERSION` **3 → 4**.
- `camera_info` 에서 `cam_company TEXT NOT NULL DEFAULT '',` **행 삭제**.
- 머리말 「문서와 다른 점」 **7번을 갱신**(삭제가 아니다). 담은 것:
  v4 에서 지웠다는 사실과 마스터 결정 날짜 / 근거(실 운용 5대에서 두 값이 사실상 1:1, 유일한
  반례 `simulator-1` 도 실측 PTZ 200 으로 `hucoms` 확인) / **감수한 손실**(제조사를 적을 자리가
  없어진다, `simulator-1` 은 이름에 시뮬 정보가 남는다).
  **`cam_id` ↔ `park3d_cam_id` 를 가르는 뒷부분은 문장을 다듬어 그대로 남겼다** — 이번 결정과
  무관한 다른 축이고, 지우면 왜 두 번호가 따로 있는지 알 수 없게 된다(계획 2-1).
- `SCHEMA_SQL` 의 다른 표·인덱스·뷰는 한 글자도 건드리지 않았다.

### 3. `SettingMain/src/db/setupRepository.ts`

- `CameraRow` 에서 `cam_company: string;` 삭제.
- `kind` 주석: "`cam_company`(제조사)와 **다른 축**이다" → **"v4 에서 제조사를 여기로 합쳤다 —
  열은 이것 하나다. 드라이버를 고르는 값이다."**
- `upsertCamera()` INSERT: 열 목록에서 제거 + **`VALUES` 물음표 14 → 13**,
  `ON CONFLICT … SET` 에서 `cam_company = excluded.cam_company,` 제거,
  `.run(…)` 바인딩에서 `filled.cam_company,` 제거. **셋을 함께 옮겨 개수를 맞췄다**(계획의 함정).

### 4. `SettingMain/src/db/configCameras.ts`

- `toCameraRow` 시그니처 `defaults: { cam_type?: 'ptz' | 'static' } = {}` 로 좁힘.
- 본문의 `cam_company:` 대입 삭제.
- **`companyOf()` 통째 삭제** — 유일한 호출자가 사라져 고아가 됐다(CLAUDE.md 3번).

### 5. `SettingMain/src/api/routes/dbRoutes.ts`

- POST 의 `...(typeof body!.cam_company === 'string' ? …)` 줄 삭제 → **본문에 `cam_company` 가
  와도 조용히 무시한다**(계획 확인필요 B 의 기본 방침, 400 으로 거절하지 않는다).
- `merged()` 의 `text` 키 유니온에서 `| 'cam_company'` 제거, `cam_company: text('cam_company'),` 삭제.
- `publicCamera()` 는 `{ password, ...rest }` 라 손대지 않았다 — 열이 빠지면 저절로 따라간다.

### 6. `SettingMain/src/mcp/routeCatalog.ts:134`

notes 에서 단어 하나만: `cam_name·cam_type·cam_company·place_id 만.` → `cam_name·cam_type·place_id 만.`
(이 notes 가 `merged()` 의 실제 허용 키와 어긋나는 문제는 계획 비범위라 고치지 않았다.)

### 7. `SettingMain/web/options.html:142`

「제조사 (cam_company)」 field 하나만 삭제. **`<div class="row">` 은 남겼다** — `camPlace`(장소)가
같은 row 에 있다.

### 8. `SettingMain/web/optionsDb.js`

`FIELDS` 의 `['camCompany', 'cam_company'],` 와 `draft()` 의 `cam_company: …` 삭제.
`renderEditor()`·`wireCameraTab()` 은 `FIELDS` 를 순회할 뿐이라 자동으로 따라간다.

### 9~11. 테스트 — **기존이 깨지지 않게 하는 최소 수정만**

| 파일 | 수정 |
|---|---|
| `test/database.test.ts` | `cam_company:` 객체 리터럴 7곳 삭제(`seed()`·`:83`·`:102`·`:103`·`:107`·`:115`·`:116`) · `FULL_ROW` 의 `cam_company: '제조사7',` 삭제 · **[2-4] `toHaveLength(14)` → `13`** 과 제목 "14열"→"13열" · 경계면 「14열 전부가 INSERT 를 왕복한다」 제목 → 「13열…」 · `FULL_ROW` 머리 주석의 "14열"→"13열" |
| `test/dbRoutes.test.ts` | `:122` 요청 본문과 `:129` 단언의 증인을 **`cam_type: 'static'`** 으로 교체(계획 확인필요 C) |
| `test/optionsDbUi.test.ts` | `:31` 키 배열에서 `'cam_company'` 제거 |

**`LEGACY_SCHEMA_SQL`(`:271`)·`LEGACY_CAMERAS`(`:278`,`:279`)·`writeLegacyFixture`(`:299`,`:303`) 의
`cam_company` 는 그대로 두었다** — 그것이 이번 마이그레이션이 지울 대상의 재현이다(계획 5-1).

---

## `dropCamCompany()` 동작

```ts
function dropCamCompany(db: DatabaseSync): void {
  const columns = new Set((db.prepare(`PRAGMA table_info("camera_info")`).all() as unknown as Array<{ name: string }>).map((row) => row.name));
  if (columns.has('cam_company')) db.exec('ALTER TABLE camera_info DROP COLUMN cam_company');
}
```

| 축 | 내용 |
|---|---|
| **판단 기준** | **판 번호가 아니라 열이 있는지.** `upgradeToV2()` 와 같은 관례다 — 판 번호로 갈랐던 자리가 v2 열 넷을 통째로 빠뜨린 자리였다 |
| **멱등** | 이미 지운 파일·처음부터 없는 새 파일에는 아무 일도 하지 않는다. 두 번 열어도 안전 |
| **표가 없을 때** | `PRAGMA table_info` 가 빈 배열을 답해 `has()` 가 false → 그냥 빠져나간다. 새 파일은 뒤이은 `SCHEMA_SQL` 이 13열로 만든다 |
| **부르는 자리** | `migrate()` 의 판 올리기 블록 안, `upgradeToV2(db);` **다음**, `db.exec(SCHEMA_SQL)` **앞**. `CREATE TABLE IF NOT EXISTS` 는 이미 있는 표에 아무 일도 하지 않으므로 앞뒤 어디든 결과는 같지만, **"이미 있는 표의 열을 손보는 일"을 한자리에 모았다**(계획 2-2) |
| **실패했을 때** | 판 올림과 **같은 트랜잭션** 안이다(`BEGIN` … `PRAGMA user_version = 4` … `COMMIT`). 던지면 판 올림까지 통째로 롤백되고 `DatabaseError('DB 스키마 생성에 실패했습니다')` 로 시끄럽게 실패한다 — "조용히 실패하고 판만 오른다"는 성립하지 않는다 |
| **되돌릴 수 없다** | `DROP COLUMN` 은 값을 함께 들어낸다. `simulator-1` 의 `'시뮬레이터'` 도 여기서 사라진다 — 계획 4단계가 말한 대로 **별도 UPDATE 가 필요 없는 이유**가 이것이다 |

`verifySchema()` 는 **손대지 않았다.** 양방향 대조로 바꾸지 않는다 — 계획 2-2(라)가 명시적으로
"그대로 둔다"로 결론냈고, 그 자리는 테스트(계획 5-3 의 4-1)가 막는다.

---

## 계획과 다르게 한 것

1. **[2-4] 에 `expect(...).not.toContain('cam_company')` 한 줄을 더하지 않았다.**
   계획 5-1 은 2-4 수정에 그 줄을 함께 넣으라고 했으나, 리더가 이번 작업 범위를
   「기존 테스트가 깨지지 않게 하는 최소 수정까지, **신규 회귀 테스트는 qa-tester 가 이어받는다**」
   로 못박았다. 그 줄은 계획 5-3 의 **4-5** 이기도 하므로 신규 단언 쪽으로 보고 **qa-tester 에게
   넘긴다.** 지금 상태에서 `toHaveLength(13)` 은 열 개수만 보므로, 그 줄이 붙기 전까지는
   "이름이 정말 `cam_company` 인 열이 빠졌는지"가 못박히지 않는다.
2. **`FULL_ROW` 머리 주석의 "14열 전부를 …" 을 "13열 전부를 …" 로 고쳤다.**
   계획 5-2 표에는 `FULL_ROW` 의 값 삭제와 `it` 제목만 적혀 있었다. 그 주석은 바로 아래
   `FULL_ROW` 를 설명하는 문장이라, 내 변경으로 **내가 만든 거짓말**이 되므로 함께 고쳤다.
   인접 코드를 "개선"한 것이 아니다.

그 밖에 계획과 다른 점은 없다. 신규 테스트는 만들지 않았고, 운영 DB 와 서버에는 손대지 않았다.

---

## 실제 실행 결과 (그대로)

### `npm run typecheck` — **통과 (오류 0)**

```
> settingmanager@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
```
출력 없음. `any`·`@ts-ignore`·캐스팅으로 덮은 자리 없다.

### `npm run test` — **20 실패 / 480 통과 (500), 3 파일 실패 / 30 통과 (33)**

```
 Test Files  3 failed | 30 passed (33)
      Tests  20 failed | 480 passed (500)
```

**기준선(480 통과 / 20 실패)과 정확히 같다 — 늘지도 줄지도 않았다.**
실패 20건의 소속·제목도 기준선과 동일하다:

| 파일 | 건수 | 예 |
|---|---|---|
| `test/server.test.ts` | 17 | 기기 추가·삭제 5, 연결 테스트 3, 요청 본문 인코딩 2, 설정(옵션 페이지) 6, 영상·정적 파일 1 |
| `test/park3dRpcServerRoutes.test.ts` | 2 | `camId 가 없는 park3d-rpc 카메라는 400 …` · `PUT /api/db/cameras 왕복에서 kind 와 camId 가 …` |
| `test/powershellSafeDiagnostic.test.ts` | 1 | `PTZ 이동 없이 health와 cameras만 GET으로 …` |

원인은 커밋되지 않은 다른 작업(카메라 정본 이관 + 옵션 화면 재작성 + 진단 스크립트 삭제)이고
이번 건과 무관하다 — 이미 확인된 사실이며 계획 비범위다.

이번 변경과 가장 가까운 **`test/database.test.ts`·`test/dbRoutes.test.ts`·`test/optionsDbUi.test.ts`
는 전부 통과**한다(위 30 passed 안에 있다).

### `grep -rn "cam_company\|camCompany\|companyOf" src/ web/`

남은 것은 **`src/db/database.ts` 의 주석 2줄과 `dropCamCompany()` 의 SQL 문자열, `src/db/schema.ts`
머리말 주석 2줄뿐**이다 — 전부 "지웠다는 사실을 기록하는 자리"다. 동작하는 코드에서
`cam_company` 를 읽거나 쓰는 곳은 없다. `web/` 은 무결과.

---

## qa-tester 가 알아야 할 것

### 경계면 — 바뀐 계약

- **`CameraRow` 가 13키다.** `cam_company` 가 사라졌다. `toCameraRow()` 의 defaults 도
  `{ cam_type?: 'ptz' | 'static' }` 하나만 받는다.
- **공개 응답 키가 줄었다.** `GET/POST /api/db/cameras` · `PUT /api/db/cameras/:id` 의
  `camera`/`cameras` 원소에 **`cam_company` 키가 없다.** 나머지 키는 그대로다.
  `GET /api/settings` · `GET /api/cameras`(=`CameraConfig`)는 **한 글자도 바뀌지 않았다** —
  원래 `cam_company` 를 담지 않았다.
- **POST 본문의 `cam_company` 는 조용히 무시된다.** 400 이 아니다(계획 확인필요 B).
  이것을 시험한다면 "무시된다"를 기대해야 한다.
- `openDatabase(options?)` · `migrate(db)` · `transaction(db, work)` · `DatabaseError` 의
  **시그니처는 하나도 바뀌지 않았다.** `dropCamCompany` 는 내보내지 않는다 — `openDatabase()` 나
  `migrate()` 를 통해서만 건드린다.
- **`SCHEMA_VERSION` 은 이제 `4`다.** 상수를 참조하는 단언은 저절로 따라간다.

### 남겨 둔 신규 테스트 (계획 5-3 · 5-4 · 5-5)

내가 만들지 않았다. 특히:

- **계획 5-3 의 `writeV3AugmentedFixture()`** — 운영 DB 와 같은 모습(옛 10열 + ALTER 로 붙인 v2
  열 넷 + `user_version=3`). 기존 `writeLegacyFixture`(10열·v2)로는 이 모습이 안 나온다.
  4-1~4-6 여섯 건이 여기에 매달린다.
- **[2-4] 의 `not.toContain('cam_company')` 한 줄**(위 「계획과 다르게 한 것」 1번). 계획 5-3 의
  4-5 이기도 하다.
- `test/dbRoutes.test.ts` 의 `not.toHaveProperty('cam_company')` 1건,
  `test/optionsDbUi.test.ts` 의 `js`·`html` 양쪽 부재 확인 1건.

### 함정

- **`LEGACY_SCHEMA_SQL`·`LEGACY_CAMERAS`·`writeLegacyFixture` 의 `cam_company` 를 지우지 마라.**
  그것이 이번 마이그레이션이 지울 대상의 재현이다. 지우면 신규 테스트가 아무것도 시험하지 않는다.
- **`test/dbRoutes.test.ts:122` 는 `JSON.stringify` 안이라 `typecheck` 가 잡아 주지 않았다.**
  `test/optionsDbUi.test.ts:31` 도 문자열 배열이라 마찬가지다. 둘 다 손으로 고쳤고 지금 통과하지만,
  같은 성질의 자리가 또 있으면 런타임에만 드러난다.
- **회귀 방향 확인이 남았다**(계획 5-7 의 4). 변경 전 코드에서 신규 4-1 이 실제로 실패하는지
  (14열·`cam_company` 포함) 확인해야 한다. 통과하는 테스트는 아무것도 증명하지 않는다.
  02 문서의 방식대로 **작업 트리를 스크래치패드로 복사해 그 사본에서만** 되돌려야 한다.
- **Windows 핸들**: `openDatabase()` 가 `migrate()` 에서 던지면 그 핸들을 아무도 닫을 수 없어
  임시 디렉토리 `rm` 이 `EPERM` 을 낸다. 던지는 경로는 `new DatabaseCtor(path)` 로 테스트가
  핸들을 쥐고 `migrate(db)` 만 부르거나, `rm(dir, { recursive: true, force: true })` 로 흘린다
  (기존 테스트가 이미 그렇게 하고 있다).
- **운영 DB 는 아직 v3 다.** 리더가 서버를 켜야 마이그레이션이 돈다. 테스트는 임시 파일만 쓰므로
  서버 없이 전부 돌아간다.

### 별건으로 남은 것 (이번에 안 고쳤다)

- `real-camera-2` 의 `kind` 가 `hucoms` 인 문제(계획 확인필요 D).
- ALTER 로 보강된 옛 파일에 `kind`·`intrinsics` 의 CHECK 제약이 없는 문제 — `DROP COLUMN` 이
  이 상태를 바꾸지 않는다.
- `routeCatalog.ts:134` notes 가 `merged()` 의 실제 허용 키와 다른 문제 — 단어 하나만 지웠다.
- `docs/my_think/my_db_table.md:26` 의 `cam_company` 서술(계획 확인필요 A) — 마스터 판단 사항이라
  손대지 않았고, `schema.ts` 머리말 7번에 「문서와 다른 점」으로 기록했다.
