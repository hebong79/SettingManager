# 03. 검증 — 계획 2단계(회귀 테스트) 실제 실행 결과

작성 2026-08-06 / 대상 `d:\Work\Parking3D\Agent\baro\SettingManager`
검증 범위는 계획서 「2단계」와 리더가 지시한 경계면 교차 비교뿐이다. 소스는 한 줄도 고치지 않았다.

**운영 DB·서버에 손대지 않았다.** 새 테스트는 전부 `mkdtemp` 임시 경로나 `:memory:` 만 쓴다.
`openDatabase()` 를 인자 없이 부르는 자리는 저장소 전체에서 `src/index.ts:11`(서버 기동) 하나이며
테스트에는 없다(`grep openDatabase\(\)` 로 확인). :13030 서버는 계속 살아 있다.

---

## 실행 명령 / 결과 요약

### 1. `npm run typecheck` — 통과

```
> settingmanager@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
```
출력 없음(오류 0). 새 테스트에 `any`·`@ts-ignore` 없음. `as unknown as` 캐스팅은 기존 파일의
`PRAGMA table_info` 관례를 그대로 따랐다.

### 2. `npx vitest run test/database.test.ts` — **33 통과 / 0 실패 / 0 스킵**

```
 ✓ test/database.test.ts (33 tests) 307ms

 Test Files  1 passed (1)
      Tests  33 passed (33)
```
(변경 전 22 → 새로 **11건** 추가)

### 3. `npm run test` (= `vitest run`, 전체) — **480 통과 / 20 실패 / 0 스킵**

```
 Test Files  3 failed | 30 passed (33)
      Tests  20 failed | 480 passed (500)
   Duration  2.42s
```

| | Test Files | Tests |
|---|---|---|
| 이번 작업 전(구현자 보고) | 3 failed / 30 passed | 20 failed / **469** passed (489) |
| 이번 작업 후(실측) | 3 failed / 30 passed | 20 failed / **480** passed (500) |

**추가한 11건이 전부 통과했고 실패는 20건 그대로다** — 새로 깨뜨린 것이 없다.

---

## 계획 성공 기준 대조

| # | 케이스 | 성공 기준 | 결과 |
|---|---|---|---|
| 2-1 | `user_version=2` + 10열 옛 파일을 `openDatabase({path})` | 열 집합이 `timeout_ms`·`kind`·`park3d_cam_id`·`intrinsics` 포함, `user_version === SCHEMA_VERSION` | **충족** |
| 2-2 | 같은 DB 에서 `readCameras(db)` | 모든 원소 `kind==='hucoms'`, `timeoutMs===5000`, 빈 칸 없음 | **충족** |
| 2-3 | 기존 데이터 보존 | `url`·`rtsp_url`·`user_id`·`cam_name`·`cam_uuid` 가 열기 전후 문자 그대로 동일 | **충족** |
| 2-4 | 새 파일(빈 경로) | `camera_info` 14열, `user_version === SCHEMA_VERSION` | **충족** |
| 2-5 | 멱등 | 닫고 다시 열어도 안 던지고 열 집합·행 수 동일 | **충족** |
| 2-6 | 앞선 판 거절 | `SCHEMA_VERSION + 1` 이면 `DatabaseError` | **충족** (아래 보강 설명) |
| 2-7 | 대조 안전망이 실제로 던진다 | `DatabaseError` + 메시지에 빠진 표/열 이름 | **충족** (가·나 두 갈래 모두) |

테스트 위치: `SettingMain/test/database.test.ts` 의 `describe('옛 파일 열기 — v2 열 보강 (계획 2단계)')`.
기존 관례를 따랐다 — 한글 `it` 문장, `mkdtemp(join(tmpdir(), …))` 임시 디렉토리, 근거 주석.

### 픽스처

`openDatabase()` 로 만들지 않았다(그것이 고치는 대상이다). `src/db/sqlite.js` 의 `DatabaseSync` 를
직접 써서 옛 10열 스키마를 SQL 로 세웠다(`LEGACY_SCHEMA_SQL`). 그 상수 머리말에
**`SCHEMA_SQL` 과 공유하면 재현이 무너진다**는 이유를 적어 두었다 — 저쪽은 "지금 만들려는 모습",
이쪽은 "이미 디스크에 있는 옛 모습"이라 같은 값을 보면 옛 파일이 아니라 새 파일을 여는 시험이 된다.

### 2-6 에 대해 (기존 테스트가 덮는지 확인)

기존 `database.test.ts:68` 은 `SCHEMA_VERSION` **상수**를 써서 `+1` 을 위조하므로 판을 3 으로
올린 뒤에도 그대로 통과한다(확인). 다만 그 테스트는 **메모리 DB** 를 쓴다. 계획이 문제 삼은 것은
"디스크에 있는 파일"이므로, 파일 픽스처로 같은 경계를 다시 못박았다. 그리고 메시지에 판 번호 둘
(`4`, `3`)이 실리는지도 확인했다 — "높습니다"만 있으면 사람이 DB 를 다시 열어 봐야 한다.
경계가 상수를 따라간다는 것은 **양쪽에서** 확인된다: 뒤처진 판 2 는 보강(2-1), 앞선 판 4 는 거절(2-6).

### 2-7 픽스처 선택 이유 (테스트 주석에도 남겼다)

`verifySchema` 의 어긋남 갈래가 둘이고, **이번 사고는 뒤쪽**이었다. 그래서 둘 다 세웠다.

- **(가)** `preset_info` 를 아예 만들지 않은 파일 + `user_version` 을 최신(3)으로 위조.
  판이 최신이라 `SCHEMA_SQL` 이 돌지 않아 표가 계속 없다. 계획이 예로 든 픽스처다.
  → `DatabaseError`, 메시지에 `preset_info`·`camera_info`·`kind` 가 모두 실린다.
- **(나)** 14열 파일에서 `ALTER TABLE camera_info DROP COLUMN park3d_cam_id`.
  이 Node 의 `node:sqlite` 가 DROP COLUMN 을 지원한다(구현자 실측, 02 문서 / 이번에도 실제로 동작).
  **"판은 맞는데 열이 없다" — 이번 사고와 똑같은 모습**이다.
  → `DatabaseError`, 메시지 `camera_info 에 park3d_cam_id 가 없습니다`.

(가)만 확인하면 정작 이번 클래스를 잡는 갈래가 검증되지 않은 채 남는다.

### Windows 핸들 함정 대응

구현자 경고대로다. 던지는 경로(2-6, 2-7)에서는 `new DatabaseSync(path)` 로 **테스트가 핸들을 쥐고
`migrate(db)` 만** 부른 뒤 `finally` 에서 직접 닫는다. 정리는 `rm(dir, {recursive:true, force:true})`.
실행에서 EPERM 은 한 번도 나지 않았다.

---

## 새 테스트가 진짜 회귀 테스트인가 — 변경 전 코드에 대고 확인

**통과하는 테스트는 아무것도 증명하지 않는다.** 그래서 작업 트리를 스크래치패드로 복사하고
그 사본에서만 `schema.ts`·`database.ts` 를 **변경 전 내용으로 되돌린 뒤**(`SCHEMA_VERSION` 2,
`if (current === SCHEMA_VERSION) return;`, `if (current >= 1) upgradeToV2()`, `verifySchema` 없음)
새 테스트를 그대로 돌렸다. 저장소와 서버는 건드리지 않았다.

```
      Tests  4 failed | 29 passed (33)
```

| 케이스 | 변경 전 결과 | 무엇을 재현했나 |
|---|---|---|
| **2-1** | 실패 — `expected [ 'cam_id', 'cam_name', …(8) ]` = **10열 그대로** | 마이그레이션이 통째로 안 돌았다 |
| **2-2** | 실패 — `expected undefined to be 'hucoms'` | **사고의 증상 그 자체**(`kind: undefined` → 400) |
| **2-7가** | 실패 — `expected function to throw an error, but it didn't` | 안전망이 없어 조용히 열렸다 |
| **2-7나** | 실패 — 같음 | 〃 |
| 2-3·2-4·2-5·2-6 | 통과 | 이 넷은 버그 재현이 아니라 **보존·멱등·경계 지킴이**다. 변경이 이것들을 깨뜨리지 않았음을 보이는 자리이므로 양쪽에서 통과하는 것이 정상이다 |

`src/db/` 는 **통째로 미추적(untracked)** 이라 `git show HEAD:` 로는 되돌릴 수 없었다
(`fatal: path 'SettingMain/src/db/database.ts' exists on disk, but not in 'HEAD'`).
그래서 02 문서에 적힌 변경 세 곳의 역을 사본에 손으로 적용했다. 이 점은 근사이므로 그대로 밝힌다.

---

## 경계면 교차 비교 결과

리더 지시대로 **양쪽을 같이 열어** shape 을 맞대 봤다. 새 `describe('경계면 교차 — camera_info 표
↔ CameraRow ↔ upsertCamera INSERT')` 3건이 그 결과를 코드로 고정한다.

| 왼쪽(생산자) | 오른쪽(소비자) | 결과 |
|---|---|---|
| `schema.ts` `SCHEMA_SQL` 의 `camera_info` 14열 | `setupRepository.ts:18` `CameraRow` 인터페이스 | **일치**(이름·개수) |
| `SCHEMA_SQL` 14열 | `setupRepository.ts:174` `upsertCamera` INSERT 열 목록 | **일치** |
| `SCHEMA_SQL` 14열 | `configCameras.ts:20` `toCameraConfig()` 가 읽는 11열 | **일치**(전부 실재) |
| `upgradeToV2()` 가 붙이는 열 순서 | `SCHEMA_SQL` 의 열 순서 | **일치**(둘 다 `timeout_ms, kind, park3d_cam_id, intrinsics`) |

**어긋난 것은 없었다.** 셋이 지금은 맞으므로 테스트는 통과하고, 이후 한쪽만 바뀌면 깨진다:

1. `표의 열 집합 === Object.keys(upsertCamera 반환값)` — `CameraRow` 는 타입이라 런타임에 지워지므로,
   `upsertCamera` 가 `CameraRow` 로 **만들어 돌려주는 객체**의 키를 본다. 그것이 코드가 믿는 열 목록이다.
2. **14열 전부를 기본값이 아닌 값으로 왕복** — INSERT 열 목록에서 열이 빠지면 그 열은 조용히
   기본값이 된다(오류가 안 난다). 기본값으로 시험하면 누락과 구분되지 않으므로 전부 다른 값을 넣었다.
3. `toCameraConfig()` 결과 전체를 기대값과 통째 비교 — `camId`·`intrinsics` 의 조건부 키 생성까지 포함.

### 발견 — 옛 파일과 새 파일의 **제약이 다르다** (결함 아님 / 보고 사항)

`upgradeToV2()` 는 `ALTER TABLE ADD COLUMN` 이라 `CHECK` 를 붙일 수 없다(구현자 주석이 밝힌 대로).
그래서 **ALTER 로 보강된 파일에는 `kind`·`intrinsics` 의 CHECK 가 없다.** 실측(임시 DB, 일회용
스크립트, 저장소에 남기지 않음):

```
옛(ALTER 보강) 파일 kind='엉터리'        : 들어갔다 (제약 없음)
옛(ALTER 보강) 파일 intrinsics='{{{'     : 들어갔다 (제약 없음)
새 파일        kind='엉터리'             : 거절 (CHECK constraint failed: kind IN ('hucoms', 'backend-core', 'park3d-rpc'))
```

**운영 `config/setup.db` 가 바로 이 "ALTER 로 보강된 파일"이다.** 판단:

- **이번 계획의 결함이 아니다.** 계획이 명시적으로 감수한 선택이고(데이터를 잃지 않는 쪽), 대조도
  일부러 열 이름만 본다 — 제약까지 보면 정상적인 옛 파일이 전부 안 열린다.
- **HTTP 경로는 막혀 있다.** `dbRoutes.ts:232` 의 `merged()` 가 `KINDS` 화이트리스트로 `kind` 를,
  `intrinsicsJson()` 이 `normalizeCamera` 로 표를 거른다. 즉 라우트를 거치면 못 쓰는 값이 못 들어간다.
- **남는 위험**: 누가 `sqlite3` 로 직접 UPDATE 하면 DB 가 안 막는다. 새 파일이었다면 막혔을 것이다.
  고치려면 표를 다시 만들어 옮기는 마이그레이션이 필요하고 그것은 **이번 범위 밖**이다.
  → 리더 판단이 필요한 **별건**으로 올린다. 테스트로 굳히지 않았다(현재 동작을 "옳다"고 못박는 셈이 된다).

---

## 발견 결함

**이번 1단계 구현에서 발견한 결함 0건.** 계획 2단계 7개 항목 전부 충족.

---

## 기존 20건 실패 — 직접 확인한 원인

구현자의 "변경 전부터 20건 실패" 주장을 **내가 다시 확인했다.** 위 사본(변경 전 코드)과 현재
작업 트리에서 각각 전체 실행하고 실패 목록을 파일로 뽑아 `Compare-Object` 로 비교했다:

```
DIFF NONE - 실패 목록 완전 동일
```
(양쪽 모두 `Tests 20 failed | 469 passed (489)`. 새 테스트를 넣기 전 기준.)

수치가 같은 것만으로는 "같은 실패"인지 알 수 없어 **20건의 이름을 한 건씩 맞춰 봤고 전부 동일**하다.
그다음 원인을 하나씩 봤다 — 전부 **이번 DB 변경과 무관**하다.

| 파일 | 건수 | 원인 (한 줄) | 이번 변경과 관계 |
|---|---|---|---|
| `powershellSafeDiagnostic.test.ts` | 1 | `ENOENT: … \scripts\test-settingmanager-safe.ps1` — 그 스크립트가 **작업 트리에서 삭제됐다**(`git status`: `D scripts/test-settingmanager-safe.ps1`) | **무관** |
| `server.test.ts` 「기기 추가·삭제」 | 5 | `POST/DELETE /api/cameras` 가 **404**. 카메라 정본이 `config.json` → DB 로 옮겨지면서 그 라우트가 `settingsRoutes.ts` 에서 빠졌다(지금은 `GET /api/cameras` 와 `POST /api/cameras/active` 만 남았다). 대체 경로는 미추적 파일 `dbRoutes.ts` 의 `/api/db/cameras` | **무관** |
| `server.test.ts` 「연결 테스트」 | 3 | `POST /api/cameras/:id/test` 가 **404**. 같은 이유 — `POST /api/db/cameras/:id/test` 로 옮겨졌다 | **무관** |
| `server.test.ts` 「요청 본문 인코딩」 | 2 | `Cannot read properties of undefined (reading '0')` = `saved.cameras[0]`. **`config.json` 에 더 이상 `cameras` 키가 없다**(계획서 「확인한 현실」 3행과 같은 사실) | **무관** |
| `server.test.ts` 「설정(옵션 페이지)」 | 6 | 같은 이유. `PUT /api/settings` 가 카메라를 `config.json` 에 쓰지 않으므로 `body.cameras[0]`·`saved.cameras[0]` 가 없다 | **무관** |
| `server.test.ts` 「영상·정적 파일」 | 1 | `expect(html).toContain('id="cameraSelect"')` — `web/options.html` 이 DB 탭 UI 로 다시 쓰여 그 id 가 없다(대신 `camIntrinsics` 등이 있다) | **무관** |
| `park3dRpcServerRoutes.test.ts` | 2 | 테스트가 `PUT /api/settings` 에 **DB 행 필드명**(`park3d_cam_id`, `cam_name`)을 보낸다. `/api/settings` 는 그 키를 모르므로 아무것도 안 바뀐다. 테스트 **이름 자체가 `PUT /api/db/cameras`** 라고 적혀 있어, 라우트만 옮기고 호출부를 못 따라간 상태다 | **무관** |

**판정: 20건 전부 이번 변경과 무관하다.** 원인은 하나로 모인다 — **작업 트리에 커밋되지 않은 다른
진행 중 작업**("카메라 정본을 `config.json` 에서 DB 로 옮기기" + 옵션 화면 재작성 + 진단 스크립트
삭제)이 라우트·설정 파일·정적 파일을 바꿨는데 그 테스트들이 따라가지 않았다.
`git status` 가 `src/api/routes/*`, `web/options.html`, `src/db/`(미추적), `scripts/*`(삭제)를
전부 미커밋으로 보여 준다.

**이번 계획 범위 밖이므로 고치지 않았다.** 다만 **덮어야 할 계약이 실제로 안 덮이고 있다**는 뜻이라
리더 판단이 필요하다 — 특히 `server.test.ts` 의 17건은 지금 아무것도 지켜 주지 않는다.

---

## 미검증 항목과 사유

1. **운영 `config/setup.db` 의 실제 상태** — 읽기조차 하지 않았다. 3단계는 이번 지시 범위 밖이고,
   구현자 보고(판 3 / 14열)를 내가 재확인하지 않았다. 3-5(`real-camera-2` → `backend-core`)도 미수행.
2. **4단계 동작 확인(실제 HTTP 호출)** — 이번 지시 범위 밖. `/api/settings`·`/api/ptz` 를 두드리지 않았다.
   따라서 "400 `알 수 없는 카메라 종류` 가 사라졌다"는 **내가 확인한 사실이 아니다.**
3. **ALTER 보강 파일의 CHECK 부재를 테스트로 고정하지 않았다** — 위 「발견」 참조. 현재 동작을 옳다고
   못박는 셈이 되어 일부러 남겼다. 별건으로 올린다.
4. **`verifySchema` 가 자료형·`NOT NULL`·기본값을 안 본다** — 설계가 그렇게 정한 것이라 시험하지 않았다.
   즉 "열 이름은 맞는데 자료형이 다른" 파일은 이 안전망을 통과한다.
5. **기존 20건 실패의 수정** — 범위 밖. 원인만 밝혔다.
6. **`upgradeToV2` 를 여러 옛 판(v0·v1)에서 올리는 경우** — 계획의 픽스처는 `user_version=2` 하나다.
   함수가 판이 아니라 열 유무로 판단하므로 원리상 같지만, v0·v1 파일을 실제로 만들어 보지는 않았다.
   (다만 2-7가가 `place_info`·`camera_info` 만 있는 파일을 다루므로 유사 상황은 한 번 지나간다.)
