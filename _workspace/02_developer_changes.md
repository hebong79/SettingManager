# 02 구현 — IDIS WebAPI v2.20 카메라 드라이버

작성 2026-08-06 · 근거 계획 `_workspace/01_architect_plan.md` · 사용자 결정(확인 필요 #1 뒤집힘) 반영

---

## 1. 신규 파일

### IDIS 서브트리 `SettingMain/src/devices/idis/` (9파일 · 소스 1155줄 + README 67줄)

| 파일 | 줄 | 한 줄 설명 |
|---|---|---|
| `contract.ts` | 19 | 계약 타입 재수출 한 겹. **`../` 로 시작하는 import 가 존재하는 유일한 파일** |
| `idisConstants.ts` | 277 | CGI 경로 · MODE · 액션 이름 · §75 전표 전문 · 이동 명령 22개 · 와이어 범위(선언/실측 분리) · §0~§79 목차 |
| `digest.ts` | 79 | RFC2617 Digest/Basic 헤더 생성(순수). `nc`·`cnonce` 주입 지점 |
| `idisTransport.ts` | 139 | `node:http(s)` · 요청별 TLS · 연결까지 덮는 마감 타이머 · 401 재시도 · `IdisTransportError` |
| `idisReply.ts` | 127 | `returnCode=` 파싱(URI 디코딩) + 5갈래 분류(순수) + `IdisAuthError`/`IdisUnknownActionError` |
| `idisCoords.ts` | 98 | 계약↔와이어 변환 + **사전 클램프**(순수) |
| `idisCamera.ts` | 396 | `IdisCameraClient` — `CameraDriver` 구현 + 프로브 + 프리셋/상대이동 + `raw()` 통로 |
| `index.ts` | 20 | 공개 표면 배럴 |
| `README.md` | 67 | 복사 절차 · 매뉴얼/실측 근거 구분 · 실기 미검증 목록 |

계획 §1 의 예상(~735줄)보다 420줄 많다. 대부분이 `idisConstants.ts` 의 §75 전표 전문과
§0~§79 목차(계획이 명시적으로 요구한 것)이며, 나머지는 근거 주석이다.

### 자기 확인용 테스트

- `SettingMain/test/idisSmoke.test.ts` (250줄) — **구현자가 자기 확인용으로 짠 것.** 23케이스
  전부 통과. 검증자가 흡수하거나 폐기해도 좋다. 자세한 것은 §5.

---

## 2. 수정 파일 (최소 라인)

| 파일 | 변경 |
|---|---|
| `src/config/types.ts` | `CameraKind` 에 `'idis'` + 주석 1문단 · `CameraConfig.insecureTls?: boolean` 추가 |
| `src/config/normalize.ts` | `CAMERA_KINDS` 에 `'idis'` · `insecureTls` 정규화 1줄(**kind 가 idis 일 때만 키 생성**) |
| `src/db/schema.ts` | `SCHEMA_VERSION` 4→5 · `kind` CHECK 에 `'idis'` · `insecure_tls` 열 신설 |
| `src/db/database.ts` | `addInsecureTls()` 신설 · `verifyCameraKindConstraint()` 가드 신설 · `migrate()` 에서 두 함수 호출 |
| `src/db/setupRepository.ts` | `CameraRow.kind` 유니온 확장 · `insecure_tls: number` 추가 · `CameraInput` 선택 필드 · INSERT/UPSERT 열 목록 |
| `src/db/configCameras.ts` | `toCameraConfig` 에 `insecureTls` 조건부 키 1줄 · `toCameraRow` 에 `insecure_tls` 1줄 |
| `src/api/routes/dbRoutes.ts` | `KINDS` 에 `'idis'` · `merged()` 에 `insecure_tls` 1줄 |
| `src/devices/driverFactory.ts` | `import` 1줄 + `case 'idis':` 블록 |
| `web/options.html` | kind `<select>` 2곳에 `<option value="idis">` · `insecure_tls` 체크박스 1블록 |
| `web/optionsDb.js` | `renderEditor` 2줄 · `draft()` 1줄 · dirty 리스너 목록 1항목 |
| `test/database.test.ts` | **내 변경이 깨뜨린 자리만.** 열 개수 단언 13→14 (3곳) · 픽스처 리터럴에 `insecure_tls` (4곳) · 문구의 "13열"→"14열" |

`src/api/routes/devicePresetRoutes.ts` 는 **건드리지 않았다** — `camera.kind !== 'hucoms'`
분기가 그대로라 IDIS 는 자동으로 501 이다(계획 §비범위 1번, 사용자 확인 #3).

---

## 3. 계획과 달라진 점과 그 이유

### 3-A. 사용자 결정으로 뒤집힌 것 (계획 §확인 필요 #1)

`insecureTls` 를 `CameraConfig` + DB 열 + UI 로 **올렸다.** 계획의 "올리지 않는다" 는 무효.

- **`streamIndex` 는 올리지 않았다** — 요청이 없었고 실측기에서 1 이 동작한다. 드라이버
  옵션(`IdisClientOptions.streamIndex`)으로만 존재하고 기본값 1 이다.
- **키 노출 규칙**: `normalize.ts`·`configCameras.ts` 양쪽에서 **`kind === 'idis'` 이고 값이 참일
  때만** 키를 만든다. `camId` 선례보다 한 단계 더 좁다 — `camId` 는 값 유효성만 보지만
  `insecureTls` 는 `false` 가 기본이라 값만 보면 모든 카메라에 `insecureTls:false` 가 붙어
  공개 응답의 키 집합이 넓어진다.
- **DB 열 이름 `insecure_tls`** (표의 snake_case 관례). 타입은 `INTEGER NOT NULL DEFAULT 0
  CHECK (insecure_tls IN (0,1))` — SQLite 에 boolean 이 없고, 같은 표의 `is_occupy` 가 선례다.
- **마이그레이션은 `addInsecureTls()` 라는 별도 함수**로 넣었다. `upgradeToV2()` 의 additions
  배열에 끼워 넣지 않은 이유: 그 함수의 이름·주석이 "v2 에 더해진 열 넷" 이라고 못 박고 있어
  v5 열을 섞으면 문서가 거짓이 된다. **`dropCamCompany()`(v4)가 이미 같은 선례**다 — 판마다
  자기 함수를 갖고, 판 번호가 아니라 열이 있는지로 판단해 멱등하다.

### 3-B. 계획에 없었지만 넣은 것 (작은 추가분 4개)

1. **`digest.ts` 가 `algorithm≠MD5`·`qop` 에 auth 가 없는 챌린지를 던진다.** 계획은 "만나면
   넓힌다" 로만 적었다. 조용히 MD5 로 계산해 보내면 401 만 돌아오고 **원인이 인증 방식이라는
   사실이 어디에도 드러나지 않는다.** 던지면 메시지가 무엇을 넓혀야 하는지 말한다.
2. **`IdisAuthError` / `IdisUnknownActionError` 클래스.** 계획은 분류표만 정의했고 프로브가
   "auth 면 던진다" 를 어떻게 판별하는지는 적지 않았다. `CameraDriverError` 를 상속하므로
   상위 계층에는 평범한 502/501 이고, 서브트리 안에서만 `instanceof` 로 갈린다.
   - `IdisAuthError.statusCode` 는 **401 이 아니라 502** 다. 그 401 은 우리와 카메라 사이의
     것이고 그대로 브라우저에 내보내면 사용자 자신의 세션이 끊긴 것처럼 보인다.
3. **`probeAction` 이 예외가 아니라 상태 코드로 판정한다.** 계획의 의사코드는
   `try/catch` 였는데, 그러면 "파라미터 오류(=있음)" 를 만들려고 던진 뒤 다시 잡아야 해서
   갈래가 오류 클래스에 숨는다. `classifyReply` 의 반환값을 직접 읽는 쪽이 표와 1:1 이다.
4. **`send()` 가 전송 오류를 마스킹해 다시 던진다**(같은 `IdisTransportError` 클래스라 표식은
   유지). 현재 경로에서는 비밀번호가 전송 계층 문구에 실릴 수 없지만(자격증명 URL 은 400 으로
   거절한다), T-M16 을 조건 없이 참으로 만든다.

### 3-C. 계획의 세부와 다르게 구현한 것

| 자리 | 계획 | 실제 | 이유 |
|---|---|---|---|
| `index.ts` 의 좌표 함수 | "좌표 변환 4함수" | 9함수(축별 6 + `ptzToContract`/`ptzToWire` + `pointToWire`) | 검증자가 축별 왕복(T-C1~C7)을 직접 부를 수 있어야 한다 |
| `classifyReply` 반환 | 분류 문자열 | 그대로(분류 문자열) — 파싱은 `parseQueryReply` 가 따로 | 계획대로. 대신 `returnCodeOf`·`describeReturnCode` 를 보조로 추가 |
| `modelInformation` 메서드 | 명시 없음 | **POST** | 매뉴얼 §4 원문이 `Method: POST` 다. 다른 Read 액션은 GET 이라 **실기에서 확인이 필요하다**(README 실기 미검증 #5) |
| `videoSnapshot` 판정 | Content-Type | **바이트(SOI) 1차 + 텍스트 응답 선판정** | 계획 T-M18/M19 대로. §25 가 `image/webp` 라 적은 모순이 있어 헤더를 믿지 않는다 |
| `verifyCameraKindConstraint` 술어 | `sqlite_master.sql` 문자열 | 같음, 단 **SQL 주석을 먼저 걷어낸다** | `sqlite_master.sql` 은 적은 그대로를 담아 주석도 들어 있고, 우리 스키마 주석에 `kind` 라는 낱말이 있어 매칭이 엉뚱한 CHECK 를 읽는다 |

### 3-D. 계획의 결함으로 판단해 **설계자와 합의가 필요한 것**

**없다.** 계획대로 구현하지 못한 자리는 나오지 않았다. 다만 아래 §6 의 "발견했지만 건드리지
않은 문제" 중 첫 항목은 설계자가 인지할 가치가 있다.

---

## 4. 구현 중 발견한 함정

1. **`ADD COLUMN` 에 CHECK 를 못 붙이는 제약이 `insecure_tls` 에도 그대로 재현된다.** 운영 DB
   (상태 가)에는 `insecure_tls` 에 CHECK 가 없다. 그래서 `upsertCamera` 가 `? 1 : 0` 으로
   좁혀 넣는다 — 저장소 계층이 제약을 대신한다는 `database.ts` 의 기존 규약과 같다.

2. **`formParams` 가 `0` 을 지우면 `ptzCommand` 의 뜻이 바뀐다.** 빈 값을 거르는 필터를
   truthy 로 쓰면 `step=0`(연속 이동)이 사라져 **1스텝 이동으로 조용히 바뀐다.** 엄격 비교
   (`=== undefined || === null || === ''`)로만 거른다. 참조구현도 같은 형태였다.

3. **`decodeURIComponent` 는 `+` 를 공백으로 바꾸지 않는다.** 매뉴얼 §0 이 말하는 것은 form
   인코딩이 아니라 URI 인코딩(공백 `%20`)이므로 `+` 를 접지 않았다. 접으면 이름에 정말로
   `+` 가 든 프리셋이 깨진다. 이 판단은 `[미확인]` 이며 실기에서 프리셋 이름에 `+` 를 넣어
   확인할 수 있다.

4. **`getSnapshot` 에서 8MiB 바이너리를 통째로 utf8 디코딩하면 안 된다.** 앞 64바이트만
   `latin1` 로 떠서 `returnCode=` 여부를 보고, 텍스트일 때만 64KiB 까지 디코딩한다.

5. **Digest 챌린지 파서의 `nonce` 가 `cnonce` 를 잡을 수 있다.** 참조구현의 정규식
   (`` `${k}="?([^",]+)"?` ``)은 앞 경계가 없다. 챌린지에 `cnonce` 가 오는 경우는 없지만
   `(?:^|[\s,])` 로 묶어 두었다. 덤으로 `qop="auth,auth-int"` 처럼 따옴표 안에 콤마가 있는
   값도 온전히 읽는다(참조구현은 `auth` 에서 잘린다 — 우연히 맞는 동작이었다).

6. **`driverFactory` 의 `never` 소진 검사가 실제로 작동했다.** 유니온에 `'idis'` 를 넣은 직후
   `case` 를 쓰기 전 컴파일이 깨졌다. 계획 §5-A 7번의 예상 그대로다.

7. **`test/database.test.ts` 는 판 번호에는 자동 추종했지만 열 개수에는 아니었다.** 계획 §8-A
   는 "수정 불필요" 로 봤는데, `toHaveLength(13)` 세 곳과 `CameraRow` 리터럴 네 곳이 깨졌다.
   전부 내 변경이 원인이라 고쳤다(단언의 뜻은 바꾸지 않고 숫자만 14 로).

---

## 5. 아직 테스트가 없는 부분 (검증자가 이어받을 지점)

`test/idisSmoke.test.ts` 가 **덮은 것** (23케이스, 전부 통과):

- 좌표: T-C1·C2(일부)·C3(일부)·C5·C6·C7
- 판정: T-R1·R2·R3·R5·R6·R7·R9
- Digest: T-D1(독립 계산 대조)·T-D2(일부)·T-D5
- 드라이버: T-M1·M2·M3·M4·M5·M6·M8(변형)·M9·M11·M12·M13·M14·M15·M16·M18·M19·M20·M22
- 전송: T-T1·T2·T3·T5
- T-ISO(격리)

**덮지 못한 것 — 검증자 몫:**

| 미검증 | 내용 |
|---|---|
| T-C2 전 구간 | tilt 0..9000 **전 구간** 자기역함수(스모크는 대표값 몇 개만) |
| T-C3·C4 경계 | pan `18000`→`18000`, `18001`→`−17999`, `0`→`0`, `40000`→`4000` |
| T-R4·R8 | `returnCode=0` 파싱값 4개 · **선행 공백·개행이 있는 본문** |
| T-D3·D4 | `opaque` 통과 · **qop 없는 RFC2069 챌린지** |
| T-T4·T6 | **Basic 챌린지 폴백** · 알 수 없는 인증 방식에서 401 그대로 올리기 |
| T-M7·M10 | `returnCode=9000` 단독 · **프로브에서 rc=900 이 던지고 능력을 안 내린다** |
| T-M17 | `controlUrl` 자격증명 400 (마스킹 테스트가 곁다리로 부르지만 **statusCode 단언이 없다**) |
| T-M21·M23·M24·M25 | `listPresets` 정렬 · 프리셋 id 범위(0·257·1.5) · `ptzCommand` 화이트리스트·speed 클램프 · `raw()` |
| **T-DB1~DB4** | **DB 전부.** 특히 **T-DB3((다) 상태 픽스처가 `DatabaseError`)**·**T-DB4((가) 상태는 통과)** — `verifyCameraKindConstraint` 는 **어떤 테스트도 아직 실행하지 않았다.** 가장 우선순위가 높다 |
| T-N1·N2 | `normalizeCamera({kind:'idis'})` 보존 · 알 수 없는 kind 폴백 회귀 |
| T-S1~S5 | 서버 경계 전부(조립·설정 왕복·DB 왕복·**device-presets 501**·코어 능력 광고) |
| T-UI1·UI2 | `options.html` 드롭다운 2곳 · `portPairWarning` 이 IDIS 를 통과시키는가 |
| **`insecureTls` 배선 전 구간** | 계획에 케이스가 없다(사용자 결정 이후 생긴 것). **UI 체크박스 → `draft()` → `PUT /api/db/cameras` → `camera_info.insecure_tls` → `toCameraConfig` → `createDriver` → `rejectUnauthorized`** 왕복과, **idis 가 아닌 카메라의 공개 응답에 `insecureTls` 키가 없다**는 것 |

**`portPairWarning` 확인 결과**(계획 §5-A 의 "구현 중 확인" 항목): `kind === 'park3d-rpc'`
에서만 분기하고 그 밖에는 `controlPort + 10` 규칙으로 떨어진다. **IDIS 는 park3d 경고 대상이
아니지만, 영상 URL 이 `http(s)://` 인 IDIS 카메라에는 "제어 + 10" 경고가 뜬다** — IDIS 영상은
보통 `rtsp://` 라 실제로는 거의 안 걸리지만, 걸리면 근거 없는 경고다. 계획 T-UI2 는 "빈
문자열" 을 기대하는데 **현재 코드는 그렇지 않다.** 고치지 않았다(계획에 없는 UI 규칙 변경).
검증자·설계자가 판단할 자리다.

---

## 6. 발견했지만 건드리지 않은 무관한 문제

1. **`bridgeCoreProvider` 의 `center` 낙관 광고**(계획 §3-F 의 알려진 한계). `typeof
   driver.centerPoint === 'function'` 이라 IDIS 는 실제로 못 해도 `center: {ok:true}` 로
   광고된다. 계획이 감수하기로 한 것이며 그대로 두었다. 계획 T-S5 가 이것을 **테스트로 고정**
   하라고 하므로 검증자가 못을 박아야 한다.

2. **`configCameras.ts` 의 `diff()` 키 목록에 `insecureTls` 가 없다.** 그 함수는
   `config.json` → DB 1회 이관의 대조용이고, `config.json` 에 idis 카메라가 있을 일이
   현재로선 없다(이관은 이미 끝났다). 넓히지 않았다 — 필요해지면 한 낱말이다.

3. **`test/server.test.ts` 17건 · `test/park3dRpcServerRoutes.test.ts` 2건 ·
   `test/powershellSafeDiagnostic.test.ts` 1건이 이미 실패하고 있었다.** 내 변경 **이전부터**
   실패한다(§7 에서 `git stash` 로 확인). 원인은 무관한 것들이다:
   - `server.test.ts` — `options.html` 에서 `id="cameraSelect"`·`id="editCard"`·
     `id="applyCamera"` 를 찾는데, 카메라 편집이 DB 탭으로 옮겨지며 `camSelect` 등으로
     **이름이 바뀌었다.** 그 밖에 `/api/cameras`·`/api/settings` 왕복 단언도 깨져 있다.
   - `powershellSafeDiagnostic.test.ts` — `scripts/test-settingmanager-safe.ps1` 파일이
     **저장소에 없다**(ENOENT).
   - `park3dRpcServerRoutes.test.ts` — `PUT /api/db/cameras` 왕복에서 `label` 이 반영되지 않고,
     `camId` 없는 park3d 카메라가 400 이 아니다.

   **전부 이번 요청 범위 밖이라 손대지 않았다.** 다만 20건이 상시 빨간 상태라 **다음 회귀가
   이 노이즈에 묻힌다** — 별건으로 정리할 가치가 있다.

4. `src/db/schema.ts` 머리말 7번이 "`camera_info` 에 열 4개를 더한다(v2)" 라고만 적고 있어 이제
   v5 의 `insecure_tls` 가 그 목록 밖이다. 열 자체에는 인라인 주석(`-- v5:`)을 달았지만
   머리말은 **고치지 않았다** — 문서 갱신은 문서화 담당 소관으로 남긴다.

---

## 7. 자기 확인 실행 결과 (그대로 옮김)

```
cd d:/Work/Parking3D/Agent/baro/SettingManager/SettingMain

$ npm run typecheck
> settingmanager@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
                                    ← 출력 없음 = 통과

$ npx vitest run
 Test Files  3 failed | 31 passed (34)
      Tests  20 failed | 525 passed (545)
```

### 실패 20건은 내 변경 이전부터 실패하던 것이다 — `git stash` 로 확인

```
$ git stash push --include-untracked        # 내 변경을 전부 치운 상태
$ npx vitest run
 Test Files  3 failed | 30 passed (33)
      Tests  20 failed | 502 passed (522)   ← **같은 20건**

$ git stash pop                             # 되돌림
```

- **같은 3개 파일 · 같은 20건**이 양쪽에서 실패한다(목록은 §6-3).
- 내 변경으로 **늘어난 것은 통과 23건뿐**(502 → 525)이며, 그것이 `idisSmoke.test.ts` 다.
- 중간에 한 번 새 실패 3건이 났다 — `test/database.test.ts` 의 열 개수 단언(13)이
  `insecure_tls` 추가로 깨진 것이라 14 로 고쳤다. 지금은 없다.

### 서브트리 단독 실행

```
$ npx vitest run test/idisSmoke.test.ts
 ✓ test/idisSmoke.test.ts (23 tests) 717ms
 Test Files  1 passed (1)
      Tests  23 passed (23)
```

마감 타이머 케이스가 실측 **367ms**(설정 350ms)에 실패했다 — 소켓 유휴 타임아웃으로
되돌아가지 않았다는 증거다(계획 3단계 T-T5 의 1200ms 기준을 지킨다).
