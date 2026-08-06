# 05. 설계 — 스키마 v4: `cam_company` 삭제 (`kind` 하나로 합치기)

작성 2026-08-06 / 대상 `d:\Work\Parking3D\Agent\baro\SettingManager`
선행 문서: `_workspace/01_architect_plan.md`(v3 계획) · `02_developer_changes.md` · `03_qa_report.md` — **셋 다 읽었다.**

---

## 범위

마스터가 확정한 결정을 코드·스키마·화면·테스트에 반영한다. **이 결정을 재론하지 않는다.**

> **cam_company 와 kind 는 같다. 하나만 사용한다** — `cam_company` 열을 DB 에서 **실제로 삭제**하고(v4) `kind` 를 남긴다.
> `simulator-1` 은 `kind=hucoms` 로 통일한다(실측 PTZ 200 으로 확인). 제조사 표시가 사라지는 손실은 마스터가 감수했다.

다루는 것은 다섯이다.

1. 마이그레이션 v4 — `SCHEMA_VERSION` 3→4, `SCHEMA_SQL` 에서 열 제거, 기존 파일용 `DROP COLUMN`
2. 코드에서 `cam_company` 제거(저장소·라우트·화면·MCP 카탈로그·타입)
3. `simulator-1` 데이터 작업 — **없음**(근거는 §3)
4. 회귀 테스트 — 기존 11건 유지 + 경계면 3건 갱신 + 신규
5. 서버가 살아 있는 상태에서의 **안전한 작업 순서**

**다루지 않는 것은 「비범위」 절에.**

### 확인한 현실 (전부 이번에 직접 실측했다)

| 사실 | 근거 |
|---|---|
| 운영 DB `SettingMain/config/setup.db`: `user_version=3`, `camera_info` 14열, 카메라 5대 | 읽기 전용(`readOnly:true`)으로 직접 조회 — 리더 보고와 **완전히 일치** |
| 5대 실측: 1 real-camera-1 hucoms/휴컴스 · 2 real-camera-2 hucoms/휴컴스 · 3 simulator-1 hucoms/시뮬레이터 · 4 simulator-2 park3d-rpc/언리얼 Park3D 시뮬/`park3d_cam_id=1` · 5 simulator-3 park3d-rpc/언리얼 Park3D 시뮬/`park3d_cam_id=2` | 같은 조회 |
| 백업 두 개가 실재한다: `config/setup.db.bak-20260806_before-v4`, `config/setup.db.bak-20260806_v3` | `ls config/` |
| **`ALTER TABLE camera_info DROP COLUMN cam_company` 가 실제로 된다** — 새 파일 모양·**ALTER 로 보강된 옛 파일 모양(=운영 DB)** 양쪽에서 성공. 나머지 열 값·인덱스·CHECK 전부 보존 | Node v24.16.0 `node:sqlite`, `:memory:` 일회용 스크립트(저장소·운영 DB 미접촉) |
| `cam_company` 사용처는 리더가 준 목록이 **전부**다. 저장소 전체 재검색으로 빠진 곳 없음을 확인 | `Grep cam_company\|camCompany\|companyOf` 전체 |
| `CameraConfig`(설정 타입)에 `cam_company` 가 **없다** | `src/db/configCameras.ts:20` `toCameraConfig()` 반환 · `src/config/types.ts` 검색 무결과 |

---

## 가정 / 확인 필요

- **가정 1**: 운영 DB 를 이번 마이그레이션이 열 때 5대 모두 위 표의 값을 갖고 있다. 그렇지 않으면(사이에 누가 UI 로 고쳤다면) 5단계 사후 확인에서 드러난다.
- **가정 2**: `sqlite3` CLI 나 외부 도구로 이 DB 를 직접 여는 사람이 없다. `cam_company` 를 읽는 외부 소비자가 있다면 이번 삭제가 그것을 깬다 — 저장소 안에는 없음을 확인했다.
- **확인 필요 A**: `docs/my_think/my_db_table.md:26` 의 `cam_company : 제조회사 ( 휴컴스, 아이디스 등 )` — **마스터의 원 설계 문서**다. 기본 방침은 **문서를 고치지 않고**, `schema.ts` 머리말의 「문서와 다른 점」에 "문서의 `cam_company` 는 담지 않는다(마스터 결정 2026-08-06)"로 기록하는 것이다(그 머리말의 기존 8개 항목이 전부 그런 자리다). 문서 자체를 고칠지는 마스터 판단.
- **확인 필요 B**: `POST /api/db/cameras` 본문에 `cam_company` 가 오면 어떻게 할 것인가. **기본: 조용히 무시**(키를 아예 읽지 않는다) — 모르는 키를 무시하는 이 라우트의 기존 관례와 같다. 400 으로 거절하길 원하면 지시.
- **확인 필요 C**: `test/dbRoutes.test.ts` 의 「분류는 고쳐도 남는다」가 `cam_company` 를 증인으로 쓴다. 대체 필드로 **`cam_type: 'static'`** 을 제안한다(같은 "분류" 축이고 `merged()` 를 지난다). 다른 필드를 원하면 지시.
- **확인 필요 D (별건, 이번에 안 고침)**: 운영 DB 의 `real-camera-2` 가 `kind=hucoms` 다. 01 계획의 3-5 는 이것을 `backend-core` 로 고치라고 했는데 지금 값은 `hucoms` 다 — 적용되지 않았거나 되돌려진 것으로 보인다. 이번 범위 밖이지만 리더가 알아야 한다.

---

## 단계

### 1단계. 안전 준비 — 되돌리기 지점과 저장 순서 (**코드보다 먼저**)

`DROP COLUMN` 은 되돌릴 수 없다. 그리고 **서버가 `nodemon --watch src --ext ts` 로 :13030 에서 살아 있어 소스를 저장하는 순간 재기동하며 `migrate()` 가 운영 DB 에 즉시 적용된다**(02 문서에서 실제로 그렇게 됐다).

**1-1. 되돌리기 지점 확인.** `SettingMain/config/setup.db.bak-20260806_before-v4` 가 실재함을 확인한다(이미 확인했다).
되돌리는 방법: **서버 정지 → `setup.db`·`setup.db-wal`·`setup.db-shm` 세 파일을 모두 지우고 → bak 파일을 `setup.db` 로 복사.**
`VACUUM INTO` 스냅샷은 **단독으로 완전하다** — 옛 `-wal`/`-shm` 을 남겨 두면 다른 DB 의 저널을 붙이는 꼴이 되므로 반드시 함께 지운다.

**1-2. 개발 서버를 정지한 뒤 소스를 고친다.** 정지하면 아래 사고 자체가 성립하지 않는다. 테스트는 임시 파일(`mkdtemp`)만 쓰므로 서버 없이 전부 돌아간다.

**1-3. 정지가 불가능하면 — 저장 순서가 안전장치다.**
반드시 **`database.ts` 를 먼저 저장하고 `schema.ts` 를 나중에 저장한다.** 반대로 하면 되돌릴 수 없는 상태가 된다:

- `schema.ts` 만 먼저 저장된 순간의 코드는 「`SCHEMA_VERSION=4` + `SCHEMA_SQL` 에 `cam_company` 없음 + **드롭 코드 없음**」이다.
- 재기동 → `current(3) < 4` 라 블록이 돌지만 지울 코드가 없으므로 **판만 4로 오른다.** 이후 영원히 `current === SCHEMA_VERSION` 이라 블록을 건너뛰고 **드롭이 다시는 실행되지 않는다.**
- `verifySchema()` 는 "실제에만 있는 여분의 열"을 문제 삼지 않으므로 **조용히 지나간다.**
- 반대로 `database.ts` 만 먼저 저장된 상태는 **안전하다**: 그때 `current(3) === SCHEMA_VERSION(3)` 이라 블록이 안 돌고, `SCHEMA_SQL` 에 아직 `cam_company` 가 있어 대조도 통과한다.

**이 사고가 났을 때의 피해와 회복** (미리 적어 둔다):
- 피해는 **가볍다.** 남은 `cam_company` 는 `NOT NULL DEFAULT ''` 라 INSERT 가 열 이름을 대지 않아도 기본값으로 채워진다(실측 확인). 코드가 그 열을 더는 읽지도 쓰지도 않으므로 기능은 전부 정상이다. 손실은 "DB 탭 뷰어에 쓸모없는 열이 하나 남는다"뿐이다.
- 다만 **스스로 낫지 않는다.** 회복: 서버 정지 → `PRAGMA user_version = 3` 으로 되돌리고 재기동하면 드롭이 다시 돈다. (또는 백업 복원)

**검증**: 백업 파일이 실재하고 크기가 0 이 아니다. 서버 정지를 택했다면 `:13030` 에 연결되지 않는다.

---

### 2단계. 마이그레이션 v4

#### 2-1. `SettingMain/src/db/schema.ts`

| 자리 | 변경 |
|---|---|
| `:43` | `export const SCHEMA_VERSION = 3;` → **`4`** |
| `:63` | `  cam_company TEXT    NOT NULL DEFAULT '',` **줄 삭제** |
| 머리말 7번(`:23~28`) | 아래대로 **갱신**(삭제가 아니다) |

머리말 7번의 뒷문장 — 지금 "`cam_company`(제조사)는 하드웨어 축이고 `kind`(프로토콜)는 다른 축이라…" — 는 **마스터 결정에 맞게 다시 쓴다.** 담을 내용 셋:

1. **v4 에서 `cam_company` 를 지우고 `kind` 하나만 남겼다**(마스터 결정 2026-08-06). 그래서 이 표는 문서의 10칸 중 `cam_company` 를 **담지 않는다** — 「문서와 다른 점」의 한 항목이다(확인 필요 A).
2. **근거**: 실 운용 5대에서 두 값이 사실상 1:1 이었다(휴컴스↔`hucoms`, 언리얼 Park3D 시뮬↔`park3d-rpc`). 유일한 반례가 `simulator-1`(제조사 `시뮬레이터` / 프로토콜 `hucoms`)이고, **실측 PTZ 200 으로 `hucoms` 가 맞음을 확인**했다.
3. **감수한 손실**: 제조사를 따로 적을 자리가 없어진다. `simulator-1` 은 이름(`UE 시뮬 1 (8081)`)에 시뮬이라는 정보가 남는다.

**`cam_id` ↔ `park3d_cam_id` 를 가르는 뒷부분은 그대로 둔다** — 이번 결정과 무관한 다른 축이고, 지우면 왜 두 번호가 따로 있는지 아무도 모르게 된다.

`SCHEMA_SQL` 의 다른 표·인덱스·뷰는 **한 글자도 건드리지 않는다.**

#### 2-2. `SettingMain/src/db/database.ts`

**(가) `migrate()` — 판 올리기 블록 안, `upgradeToV2(db);` **바로 다음** 줄에 `dropCamCompany(db);` 한 줄 추가.** 그 밖의 구조·주석·`verifySchema()` 호출 위치는 손대지 않는다.

```
      upgradeToV2(db);
      dropCamCompany(db);      // ← 추가
      db.exec(SCHEMA_SQL);
```

위치 근거: `SCHEMA_SQL` 은 `CREATE TABLE IF NOT EXISTS` 라 **이미 있는 표에는 아무 일도 하지 않는다.** 새 파일이면 표가 없어 두 함수 모두 그대로 빠져나가고 `SCHEMA_SQL` 이 13열로 만든다. 즉 앞뒤 어디에 두어도 결과는 같지만, **"이미 있는 표의 열을 손보는 일"을 한자리에 모은다.**

**(나) 비공개 함수 `dropCamCompany()` 신설** (`upgradeToV2()` 바로 아래, 약 4줄 + 주석):

```ts
function dropCamCompany(db: DatabaseSync): void {
  const columns = new Set((db.prepare(`PRAGMA table_info("camera_info")`).all() as unknown as Array<{ name: string }>).map((row) => row.name));
  if (columns.has('cam_company')) db.exec('ALTER TABLE camera_info DROP COLUMN cam_company');
}
```

주석에 담을 것:
- **v4: 제조사(`cam_company`)를 프로토콜(`kind`) 하나로 합쳤다**(마스터 결정 2026-08-06). 근거·감수한 손실은 `schema.ts` 머리말 7번.
- **`upgradeToV2()` 와 같은 관례다 — 판 번호가 아니라 열이 있는지로 판단한다.** 판 번호로 갈랐던 자리가 v2 열 넷을 통째로 빠뜨린 자리였다(01 계획의 교훈).
- **왜 `DROP COLUMN` 이 되는가**: SQLite 는 그 열을 **PRIMARY KEY·UNIQUE·인덱스·뷰·CHECK·외래키·생성열**이 참조할 때만 거부한다. `cam_company` 는 어디서도 참조되지 않는다 — 이 표의 유일한 인덱스 `idx_camera_place` 는 `place_id`, 뷰 `floor_ROI` 는 `slot_setup` 에서 뽑고, CHECK 셋은 `cam_type`·`kind`·`intrinsics` 에 걸려 있다. **실측으로 확인했다**(새 파일 모양·ALTER 보강 파일 모양 양쪽에서 성공, 나머지 열 값·인덱스·CHECK 전부 보존).

**(다) `upgradeToV2()` 는 손대지 않는다.** 개명도 통합도 하지 않는다(CLAUDE.md 3번). 하는 일이 다르다 — 저쪽은 더하고 이쪽은 뺀다.

**(라) `verifySchema()` 는 손대지 않는다 — 양방향 대조로 바꾸지 않는다.** 판단 근거는 아래.

> **왜 양방향으로 안 바꾸는가**
>
> 우려는 이것이었다: 대조가 "실제에만 있는 여분 열"을 안 보므로, 드롭이 실패해도 안 잡힌다.
>
> 실제로 그 구멍이 열리는 경우는 **하나뿐**이다 — 판은 4인데 열이 남은 상태. 그런데 드롭은 판을 올리는 **같은 트랜잭션 안**에 있다(`BEGIN` … `PRAGMA user_version = 4` … `COMMIT`). SQLite 는 DDL 도 트랜잭션에 넣으므로, **드롭이 던지면 판 올림까지 통째로 롤백되고 `DatabaseError('DB 스키마 생성에 실패했습니다')` 로 시끄럽게 실패한다.** "조용히 실패하고 판만 오른다"는 성립하지 않는다. 유일한 예외가 §1-3 의 저장 순서 사고이고, 그것은 **저장 순서 규칙으로 막는다.**
>
> 반대로 양방향으로 바꾸면 값이 크다. `verifySchema()` 는 **고치지 않고 던지기만 한다.** 여분 열을 오류로 보는 순간, 운영자가 어떤 이유로든 열을 하나 덧붙인 DB(또는 §1-3 사고를 겪은 DB)는 **서비스가 아예 기동하지 않는다.** 코드 안에 회복 경로가 없어 사람이 `sqlite3` 로 직접 손대야 한다. 그런데 §1-3 에서 봤듯 **남은 여분 열의 피해는 사실상 0 이다**(`DEFAULT ''` 라 INSERT 가 열 이름을 안 대도 들어간다). **무해한 상태를 기동 불능과 맞바꾸는 셈**이다.
>
> 게다가 양방향이 새로 잡아 주는 것도 없다. "앞선 판이 만든 여분 열"은 `user_version` 검사가 이미 막는다.
>
> **결론: 그대로 둔다.** 대신 그 자리를 **테스트로 막는다**(3단계 4-1) — 운영 DB 와 같은 모습의 픽스처가 열린 뒤 `cam_company` 가 없음을 CI 가 매번 확인한다. 런타임에 매번 던지는 것보다 이쪽이 맞다.

**검증**: `npm run typecheck` 통과.

---

### 3단계. 코드에서 `cam_company` 제거

리더가 준 목록을 저장소 전체 재검색으로 대조했다 — **빠진 곳도 남는 곳도 없다.** 아래가 전부다.

#### 3-1. `src/db/setupRepository.ts`

| 자리 | 변경 |
|---|---|
| `:28` | `cam_company: string;` **삭제**(`CameraRow`) |
| `:31` | `kind` 주석 "`cam_company`(제조사)와 **다른 축**이다" → **"v4 에서 제조사를 여기로 합쳤다 — 열은 이것 하나다. 드라이버를 고르는 값이다."** 로 갱신 |
| `:174` | INSERT 열 목록에서 `cam_company` 제거 **+ `VALUES` 의 물음표 14 → 13** |
| `:180` | `ON CONFLICT … SET` 에서 `cam_company = excluded.cam_company,` 제거 |
| `:185` | `.run(…)` 바인딩에서 `filled.cam_company,` 제거 |

> **함정**: `:174`(열 목록·물음표)와 `:185`(바인딩)는 **개수가 맞아야 한다.** 한쪽만 고치면 타입 검사는 통과하고 런타임에 `column index out of range` 로 던진다. 3단계 테스트 「13열 전부가 INSERT 를 왕복한다」가 이것을 잡는다.

#### 3-2. `src/db/configCameras.ts`

| 자리 | 변경 |
|---|---|
| `:38` | 시그니처 `defaults: { cam_type?: 'ptz' \| 'static'; cam_company?: string } = {}` → **`defaults: { cam_type?: 'ptz' \| 'static' } = {}`** |
| `:47` | `cam_company: defaults.cam_company ?? companyOf(camera.kind),` **줄 삭제** |
| `:131~136` | **`companyOf()` 함수 통째로 삭제** |

`companyOf()` 는 **삭제가 맞다.** 유일한 호출자가 `:47` 이었고(전체 검색으로 확인) 이번 변경으로 고아가 된다 — 내 변경이 만든 고아는 지운다(CLAUDE.md 3번). 남겨 두면 "제조사를 유추하는 함수"가 제조사 열이 없는 코드베이스에 떠 있게 되어, 다음 사람이 열을 되살리려 든다.

#### 3-3. `src/api/routes/dbRoutes.ts`

| 자리 | 변경 |
|---|---|
| `:91` | `...(typeof body!.cam_company === 'string' ? { cam_company: body!.cam_company } : {}),` **줄 삭제**(POST). 남기면 없는 열을 upsert 입력에 실어 타입 오류가 난다 |
| `:221` | `text` 의 키 유니온에서 `\| 'cam_company'` 제거 |
| `:230` | `cam_company: text('cam_company'),` **줄 삭제**(`merged()`) |

`publicCamera()`(`:200`)는 **손대지 않는다** — `{ password, ...rest }` 라 열이 빠지면 저절로 따라간다.

#### 3-4. `web/options.html`

`:142` 의 `<div class="field"><label for="camCompany">제조사 (cam_company)</label><input id="camCompany"></div>` **삭제.**
그 `<div class="row">` 에는 `camPlace`(장소)가 함께 있으므로 **row 는 남기고 field 하나만 지운다.**

#### 3-5. `web/optionsDb.js`

| 자리 | 변경 |
|---|---|
| `:139` | `FIELDS` 에서 `['camCompany', 'cam_company'],` **삭제** |
| `:239` | `draft()` 에서 `cam_company: $('camCompany').value.trim(),` **삭제** |

다른 참조는 없다 — `renderEditor()`(`:205`)와 `wireCameraTab()`(`:296`)은 `FIELDS` 를 순회할 뿐이라 자동으로 따라간다. 기기 추가(`camAdd`, `:347`)는 원래 `cam_company` 를 보내지 않는다(확인함).

#### 3-6. `src/mcp/routeCatalog.ts`

`:134` notes: `'cam_name·cam_type·cam_company·place_id 만. …'` → **`'cam_name·cam_type·place_id 만. …'`**

> 이 notes 는 지금도 사실과 다르다 — `merged()` 는 `url`·`user_id`·`password`·`rtsp_url`·`kind`·`timeout_ms`·`park3d_cam_id`·`intrinsics` 도 받는다. **그러나 그 수정은 이번 결정과 무관하므로 하지 않는다**(외과적 변경). `cam_company` 라는 단어만 지운다. 비범위에 기록한다.

#### 3-7. 손대지 않음 — 확인한 것

- `src/db/discoveryDbStore.ts:201`·`src/db/spotDbStore.ts:116` — `INSERT INTO camera_info (cam_id, cam_name, cam_uuid, place_id)` 로 `cam_company` 를 **이름으로 대지 않는다**(기본값에 기댔다). 열이 사라져도 그대로 동작한다.
- `src/db/tableQuery.ts` — 열 목록은 `PRAGMA` 가 답하고 숨김 목록은 `camera_info: ['password']` 뿐이다. **DB 탭 뷰어는 저절로 13열을 그린다.**
- `src/config/types.ts`·`normalize.ts`·`configStore.ts` — `CameraConfig` 에 `cam_company` 가 원래 없다.
- `src/db/backendCoreExport.ts` — `cam_uuid` 만 읽는다.

#### 3-8. 응답 키 집합 변화 — 영향

`GET /api/db/cameras` · `POST /api/db/cameras` · `PUT /api/db/cameras/:id` 의 `camera`/`cameras` 에서 **`cam_company` 키가 사라진다.** 소비자는 둘뿐이다.

| 소비자 | 영향 |
|---|---|
| `web/optionsDb.js` 카메라 탭 | 3-5 에서 함께 고친다. 안 고치면 `FIELDS` 루프가 `undefined` 를 `''` 로 그려 **빈 「제조사」 칸이 남고, 저장할 때마다 빈 문자열을 보내려다 없는 열에 걸린다** |
| MCP(`/api/db/cameras` 를 도구로 부르는 다른 에이전트) | **키가 줄기만 한다.** 그 값을 읽는 자리가 저장소 안에 없다. `routeCatalog` notes 만 갱신(3-6) |

`GET /api/settings` · `GET /api/cameras`(= `CameraConfig`)는 **원래 `cam_company` 를 담지 않았으므로 응답이 한 글자도 바뀌지 않는다.**

**검증**: `npm run typecheck` 통과. `grep -rn "cam_company\|camCompany\|companyOf" src/ web/` 가 **무결과**(테스트의 옛 파일 픽스처는 예외 — 3단계 참조).

---

### 4단계. `simulator-1` — **추가 작업 없음**

**맞다. 별도 데이터 작업은 필요 없다.** 근거:

- `simulator-1`(cam_id=3)의 현재 값은 `kind='hucoms'`, `cam_company='시뮬레이터'` 다(실측).
- 마스터가 통일하기로 한 축은 `kind` 이고, **그 값은 이미 `hucoms` 다** — 바꿀 것이 없다.
- 제조사 `시뮬레이터` 는 `DROP COLUMN` 이 **열째로 들어내므로 값이 함께 사라진다.** 지우는 UPDATE 문을 따로 쓸 필요가 없다.
- 즉 이 카메라를 위한 SQL·스크립트·수동 조작이 **하나도 없다.** 마이그레이션 한 번이 전부다.

**검증**: 5단계 사후 확인에서 `cam_id=3` 이 `kind='hucoms'` 이고 열 목록에 `cam_company` 가 없다.

---

### 5단계. 회귀 테스트

**파일**: `SettingMain/test/database.test.ts` · `test/dbRoutes.test.ts` · `test/optionsDbUi.test.ts`.
기존 관례를 따른다 — 한글 `it` 문장, `mkdtemp(join(tmpdir(), …))`, 근거 주석.

#### 5-1. 기존 11건(`describe('옛 파일 열기 — v2 열 보강 (계획 2단계)')`) — **깨지는 단언은 하나뿐이다**

한 건씩 짚었다.

| # | `SCHEMA_VERSION` 4 에서 | 조치 |
|---|---|---|
| 2-1 | **통과.** `user_version === SCHEMA_VERSION` 은 상수를 따라가고, `arrayContaining` 은 v2 열 넷만 본다 | 없음 |
| 2-2 | **통과.** `readCameras` 는 `cam_company` 를 읽지 않는다 | 없음 |
| 2-3 | **통과.** `DROP COLUMN` 은 나머지 열 값을 보존한다(실측) | 없음 |
| **2-4** | **깨진다** — `columnsOf(opened,'camera_info')).toHaveLength(14)` | **`13` 으로 고치고**, `expect(...).not.toContain('cam_company')` 를 **한 줄 더한다.** 제목의 "14열"도 "13열"로 |
| 2-5 | **통과** | 없음 |
| 2-6 | **통과.** `SCHEMA_VERSION + 1` = 5, 전부 상수 기반 | 없음 |
| 2-7가 | **통과.** `writeLegacyFixture(path, SCHEMA_VERSION)` → 판이 같아 블록을 건너뛰고 `verifySchema` 가 `preset_info`·`camera_info`·`kind` 를 든다. 남은 `cam_company` 는 여분이라 무시(설계대로) | 없음 |
| 2-7나 | **통과.** 새 파일(13열) → `DROP COLUMN park3d_cam_id` → 던진다 | 없음 |

> **`LEGACY_SCHEMA_SQL`(`:257`)·`LEGACY_CAMERAS`(`:277`)·`writeLegacyFixture`(`:292`) 의 `cam_company` 는 절대 지우지 마라.**
> 그것은 **"이미 디스크에 있는 옛 파일"의 재현**이고, 이번 마이그레이션이 지울 대상 그 자체다. 지우면 신규 테스트가 아무것도 시험하지 않게 된다. (테스트 상단 주석이 이미 "`SCHEMA_SQL` 과 공유하면 재현이 무너진다"고 밝혀 두었다.)

#### 5-2. 경계면 교차 3건(`describe('경계면 교차 — camera_info 표 ↔ CameraRow ↔ upsertCamera INSERT')`) — 갱신 방법

이 셋은 **한쪽만 바뀌면 깨지도록** 지어져 있다. 이번 변경에서는 양쪽을 함께 옮긴다.

| 자리 | 변경 | 그 뒤 |
|---|---|---|
| `FULL_ROW`(`:465`) | `cam_company: '제조사7',`(`:474`) **삭제**. 타입이 `CameraRow` 라 안 지우면 `typecheck` 가 잡는다 | — |
| 「표의 열 집합과 `CameraRow` 의 키 집합이 정확히 같다」 | **단언은 안 고친다** — 양쪽에서 저절로 빠진다. 이 테스트가 3-1(저장소)과 2-1(스키마)을 **함께** 고쳤는지 증명하는 자리다 | 자동 통과 |
| 「14열 전부가 INSERT 를 왕복한다」 | 제목만 **「13열 전부가 …」** 로. 단언(`stored === FULL_ROW`)은 그대로 | 자동 통과 |
| 「`toCameraConfig` 가 읽는 열이 전부 표에 있다」 | 기대값에 `cam_company` 가 원래 없다 — **손대지 않는다** | 자동 통과 |

#### 5-3. 신규 — `describe('cam_company 삭제 — 스키마 v4')`

**픽스처 하나를 새로 만든다** — 지금 운영 DB 와 **같은 모습**이어야 한다(옛 10열 + ALTER 로 붙인 v2 열 넷 + `user_version=3`). 기존 `writeLegacyFixture`(10열·v2)로는 이 모습이 안 나온다.

```
/** 운영 DB 와 같은 모습: 옛 10열 + ALTER 로 붙인 v2 열 넷 + user_version = 3.
 *  `SCHEMA_SQL` 로 만들면 안 된다 — 그쪽은 이미 cam_company 가 없는 "새 파일"이다. */
function writeV3AugmentedFixture(path: string): void
```

내용: `LEGACY_SCHEMA_SQL` + `place_info` 1줄 + 카메라 3줄(운영과 같은 조합) + `ALTER … ADD COLUMN` 넷(`timeout_ms`/`kind`/`park3d_cam_id`/`intrinsics`, `database.ts` 의 `upgradeToV2` 와 같은 정의) + `UPDATE` 로 `kind`·`park3d_cam_id` 채우기 + `PRAGMA user_version = 3`.

카메라 3줄은 운영의 세 패턴을 덮는다:
`(hucoms, '휴컴스', park3d_cam_id=NULL)` · **`('simulator-1', hucoms, '시뮬레이터', NULL)` ← 반례** · `(park3d-rpc, '언리얼 Park3D 시뮬', park3d_cam_id=2)`

| # | 케이스 | 성공 기준 |
|---|---|---|
| **4-1** | **핵심.** `writeV3AugmentedFixture(path)` 를 `openDatabase({ path })` 로 연다 | `columnsOf(opened,'camera_info')` 가 **`cam_company` 를 포함하지 않고** 길이가 **13**. `userVersionOf(opened) === SCHEMA_VERSION`(=4) |
| **4-2** | 같은 열기에서 **나머지 데이터 보존** | 세 줄의 `cam_id·cam_uuid·cam_name·url·user_id·password·rtsp_url·cam_type·place_id·timeout_ms·kind·intrinsics` 가 픽스처에 넣은 값과 **문자 그대로 동일**. 특히 **`park3d_cam_id` 가 `2` 로 남는다**(운영 4·5번 카메라가 이 값에 매달려 있다 — 잃으면 엉뚱한 카메라를 움직인다) |
| **4-3** | **`simulator-1` — 제조사만 사라지고 `kind` 는 그대로** | 그 줄이 열기 뒤 `kind === 'hucoms'`. **데이터 조작 단계가 따로 없다는 것을 이 한 건이 증명한다**(4단계) |
| **4-4** | 옛 10열 파일(v2)도 같은 결과 — **보강과 삭제가 한 번에** | `writeLegacyFixture(path)` → 열기 → 13열, `cam_company` 없음, `kind==='hucoms'`·`timeout_ms===5000` 이 붙어 있다 |
| **4-5** | 새 파일에는 처음부터 없다 | 5-1 의 2-4 수정본이 덮는다 — 13열 + `not.toContain('cam_company')` |
| **4-6** | 멱등 — 이미 v4 인 파일에는 아무 일도 하지 않는다 | 4-1 의 DB 를 닫고 **다시 열어도** 던지지 않고, 열 집합·행 수가 그대로이며 `user_version === 4` |

#### 5-4. `test/dbRoutes.test.ts`

| 자리 | 변경 |
|---|---|
| `:122` | `JSON.stringify({ place_id: 9, cam_company: '아이디스' })` → **`{ place_id: 9, cam_type: 'static' }`**(확인 필요 C) |
| `:129` | `toMatchObject({ place_id: 9, cam_company: '아이디스' })` → **`{ place_id: 9, cam_type: 'static' }`** |
| 신규 1건 | `GET /api/db/cameras` 의 각 원소와 `PUT` 응답의 `camera` 에 **`cam_company` 키가 없다**(`expect(row).not.toHaveProperty('cam_company')`). 공개 응답 키 집합이 줄었다는 계약을 못박는다(3-8) |

> **주의**: `:122` 는 `JSON.stringify` 안이라 **`typecheck` 가 잡아 주지 않는다.** 안 고치면 `:129` 단언이 런타임에 실패한다.

#### 5-5. `test/optionsDbUi.test.ts`

| 자리 | 변경 |
|---|---|
| `:31` | 키 배열에서 **`'cam_company'` 제거** |
| 신규 1건 | `expect(js).not.toContain('cam_company')`(`web/optionsDb.js`) **+** `expect(html).not.toContain('camCompany')`(`web/options.html`). 입력칸만 되살아나고 `draft()` 가 안 보내는 어긋난 상태를 잡는다 |

> `:31` 도 문자열 배열이라 **`typecheck` 가 안 잡는다** — 런타임 실패로 드러난다.

#### 5-6. `typecheck` 가 자동으로 안내하는 자리

`test/database.test.ts` 의 `cam_company:` 리터럴 — `:39`(`seed()`) · `:83` · `:102` · `:103` · `:107` · `:115` · `:116` · `:474`(`FULL_ROW`). 전부 **객체 리터럴이라 잉여 속성 검사에 걸린다.** 지우기만 하면 된다. `test/cameraFixture.ts` 는 `toCameraRow()` 를 쓰므로 손댈 것이 없다(확인함).

#### 5-7. 검증 (실제 실행 — 실행하지 않은 것을 통과로 보고하지 않는다)

1. `npm run typecheck` — 오류 0.
2. `npx vitest run test/database.test.ts test/dbRoutes.test.ts test/optionsDbUi.test.ts` — **전부 통과.**
3. `npm run test`(전체) — **실패가 기존 20건을 넘지 않는다.** 넘으면 그 목록을 그대로 보고한다.
4. **회귀 방향 확인** — 03 문서의 방식(작업 트리를 스크래치패드로 복사해 그 사본에서만 되돌리기)으로, **변경 전 코드에서 4-1 이 실제로 실패하는지**(14열·`cam_company` 포함) 확인한다. 통과하는 테스트는 아무것도 증명하지 않는다.

---

### 6단계. 서버 기동 후 운영 DB 확인

1단계에서 서버를 정지했다면 여기서 기동한다. 기동이 곧 마이그레이션이다.

| # | 확인 | 성공 기준 |
|---|---|---|
| 6-1 | `PRAGMA table_info(camera_info)` (읽기 전용 조회) | **13열**, `cam_company` **없음** |
| 6-2 | `PRAGMA user_version` | **4** |
| 6-3 | 카메라 5대가 전부 남아 있다 | `cam_id` 1~5, `cam_uuid` 가 열기 전과 동일 |
| 6-4 | `kind` 보존 | 1·2·3 = `hucoms`, 4·5 = `park3d-rpc` |
| 6-5 | **`park3d_cam_id` 보존** | 4 → `1`, 5 → `2` (여기가 틀리면 엉뚱한 카메라가 움직인다) |
| 6-6 | `GET /api/db/cameras` | 5대 반환, 각 원소에 `cam_company` 키 **없음**, 나머지 키는 그대로 |
| 6-7 | 옵션 페이지 카메라 탭 | 「제조사」 칸이 **없다**. 아무 기기나 골라 「이 기기 적용」 저장이 **200** 이고, 저장 뒤 목록·편집칸 값이 그대로 |
| 6-8 | `GET /api/settings` | `cameras` 5대가 열기 전과 **한 글자도 다르지 않다**(`CameraConfig` 에는 원래 `cam_company` 가 없다) |
| 6-9 | `POST /api/db/cameras/3/test`(simulator-1) | 응답의 `kind` 가 **`'hucoms'`**. `ok:false` 여도 이 항목은 통과(연결 실패는 별건) |
| 6-10 | 서버 로그 | `DatabaseError` 없음 |

6-1 이 14열이면 §1-3 의 저장 순서 사고다 — 그 절의 회복 절차를 따른다.

---

## 영향 받는 파일/모듈

**수정 (소스)**
- `SettingMain/src/db/schema.ts` — `SCHEMA_VERSION` 3→4, `camera_info` 에서 `cam_company` 행 제거, 머리말 7번 갱신
- `SettingMain/src/db/database.ts` — `dropCamCompany()` 신설 + `migrate()` 에 한 줄 호출
- `SettingMain/src/db/setupRepository.ts` — `CameraRow` 1줄, INSERT 열 목록·물음표·`ON CONFLICT`·바인딩, `kind` 주석
- `SettingMain/src/db/configCameras.ts` — `toCameraRow` 시그니처·본문, **`companyOf()` 삭제**
- `SettingMain/src/api/routes/dbRoutes.ts` — POST 겹치기 1줄, `merged()` 의 `text` 유니온·1줄
- `SettingMain/src/mcp/routeCatalog.ts` — notes 문구에서 단어 하나
- `SettingMain/web/options.html` — 제조사 입력 field 삭제
- `SettingMain/web/optionsDb.js` — `FIELDS` 1줄, `draft()` 1줄

**수정 (테스트)**
- `SettingMain/test/database.test.ts` — 2-4 단언, `FULL_ROW`, `cam_company:` 리터럴 8곳, **신규 `describe` + `writeV3AugmentedFixture`**
- `SettingMain/test/dbRoutes.test.ts` — `:122`·`:129` 대체 + 신규 1건
- `SettingMain/test/optionsDbUi.test.ts` — `:31` + 신규 1건

**동작이 달라지지만 수정 없음 (확인함)**
- `src/db/tableQuery.ts`(DB 탭 뷰어 — `PRAGMA` 기반이라 저절로 13열) · `src/db/discoveryDbStore.ts` · `src/db/spotDbStore.ts` · `src/db/backendCoreExport.ts` · `src/config/*`

**데이터**
- `SettingMain/config/setup.db`(+`-wal`,`-shm`) — 열 하나 삭제, `user_version` 4
- 되돌리기 지점: **`SettingMain/config/setup.db.bak-20260806_before-v4`**(VACUUM INTO 스냅샷 · 단독으로 완전) / 그 이전 판 `SettingMain/config/setup.db.bak-20260806_v3`

**형제 프로젝트**: 영향 없음. 이번 변경은 `SettingMain` 의 DB 계층·DB 탭 화면에 갇히며, `AgentVLA/ParkAgent/SettingAgent` 와의 계약을 바꾸지 않는다.

---

## 비범위 (하지 않을 것)

- **`verifySchema()` 를 양방향 대조로 바꾸는 것** — 근거는 2-2(라). 대신 5-3 의 4-1 테스트가 그 자리를 막는다.
- `upgradeToV2()` 개명·통합, `database.ts`·`schema.ts` 의 나머지 구조·주석
- **ALTER 로 보강된 옛 파일(=운영 DB)에 `kind`·`intrinsics` 의 CHECK 제약이 없는 문제**(QA 발견) — `ADD COLUMN` 은 CHECK 를 못 붙인다. HTTP 경로는 `dbRoutes.merged()` 의 `KINDS` 화이트리스트와 `intrinsicsJson()` 이 막고 있다. 고치려면 표를 다시 만들어 옮기는 마이그레이션이 필요하며 **별건**이다. 이번 `DROP COLUMN` 이 이 상태를 바꾸지 않는다(실측: 드롭 뒤에도 기존 CHECK 는 그대로, 없던 CHECK 는 여전히 없다).
- **기존 20건 실패**(`server.test.ts` 17 · `park3dRpcServerRoutes` 2 · `powershellSafeDiagnostic` 1) — 원인은 커밋되지 않은 다른 작업(카메라 정본을 `config.json`→DB 로 옮기기 + 옵션 화면 재작성 + 진단 스크립트 삭제)이다. 특히 `server.test.ts` 17건은 이미 옮겨진 `/api/cameras` 라우트를 겨누고 있어 **아무 계약도 지켜 주지 않는다.** 리더 판단 사항.
- `routeCatalog.ts:134` notes 가 `merged()` 의 실제 허용 키와 다른 문제 — `cam_company` 라는 단어만 지우고 나머지 문구는 안 고친다(3-6).
- `docs/my_think/my_db_table.md`(마스터 원 문서, 확인 필요 A) · `docs/20260805_233245_장소구분_DB탭_테이블뷰어.md`(과거 기록) 의 `cam_company` 서술 — 지난 기록을 소급해 고치지 않는다. 이번 변경은 문서화 담당이 **새 `.md`** 로 남긴다.
- `cam_type`(ptz/static) — 마스터 결정은 `cam_company` 한정이다. 그대로 둔다.
- `real-camera-2` 의 `kind`(확인 필요 D) · `intrinsics` 줌→화각 표 채우기 · 실제 카메라 통신 실패 — 전부 별건.
- 일회성 보정 스크립트를 소스에 남기는 것. 마이그레이션 한 번이 전부다.
