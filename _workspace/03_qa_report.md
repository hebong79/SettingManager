# 03 검증 — IDIS WebAPI v2.20 카메라 드라이버

작성 2026-08-06 · 근거 `_workspace/01_architect_plan.md` §7 · `_workspace/02_developer_changes.md`

---

## 1. 실행한 명령과 그 출력

### 최종 (요청받은 두 명령, 그대로)

```
cd d:/Work/Parking3D/Agent/baro/SettingManager/SettingMain

$ npm run typecheck
> settingmanager@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
                                    ← 출력 없음 = 통과

$ npx vitest run
 Test Files  3 failed | 39 passed (42)
      Tests  20 failed | 696 passed (716)
```

**통과 696 · 실패 20 · 스킵 0.** 실패 20건은 전부 §2 의 기존 실패이며, 이번 작업이 만든 것은 없다.

### 내가 새로 세운 스위트만 따로

```
$ npx vitest run test/idisCoords.test.ts test/idisReply.test.ts test/idisDigest.test.ts \
                 test/idisTransport.test.ts test/idisCamera.test.ts test/idisDatabase.test.ts \
                 test/idisInsecureTls.test.ts test/idisServerRoutes.test.ts test/idisNormalizeUi.test.ts
```

| 파일 | 케이스 | 결과 |
|---|---:|---|
| `test/idisCoords.test.ts` | 19 | 통과 |
| `test/idisReply.test.ts` | 19 | 통과 |
| `test/idisDigest.test.ts` | 18 | 통과 |
| `test/idisTransport.test.ts` | 13 | 통과 |
| `test/idisCamera.test.ts` | 48 | 통과 |
| `test/idisDatabase.test.ts` | 22 | 통과 |
| `test/idisInsecureTls.test.ts` | 28 | 통과 |
| `test/idisServerRoutes.test.ts` | 13 | 통과 |
| `test/idisNormalizeUi.test.ts` | 14 | 통과 |
| **합계** | **194** | **194 통과 · 0 실패 · 0 스킵** |

산수 대조: 클린 HEAD 는 `20 failed | 502 passed (522)` 였다.
`502 + 194 = 696`, `522 + 194 = 716` 으로 최종 실행과 정확히 맞는다 —
즉 **늘어난 것은 통과 194건뿐**이고 실패는 20건 그대로다.
(구현자의 `idisSmoke.test.ts` 23건은 §6 대로 흡수 후 삭제했으므로 이 셈에 들어가지 않는다.)

---

## 2. 베이스라인 재현 — **구현자 보고와 일치했다**

`git stash` 는 쓰지 않았다(작업 손실 위험). 대신 **`git worktree` 로 HEAD 를 별도 디렉토리에
펼치고** `node_modules` 를 junction 으로 연결해, 작업 트리를 전혀 건드리지 않고 클린 상태를 돌렸다.

```
$ git worktree add <scratchpad>/baseline HEAD --detach
$ npx vitest run          # ← 클린 HEAD(894c8f7)
 Test Files  3 failed | 30 passed (33)
      Tests  20 failed | 502 passed (522)
```

작업 트리(구현자 변경 포함)에서 돌린 같은 명령:

```
 Test Files  3 failed | 31 passed (34)
      Tests  20 failed | 525 passed (545)
```

두 실행의 **실패 목록을 파일로 떠서 `diff`** 했다 — 차이 0줄, 즉 **같은 20건**이다.
검증을 마친 뒤 다시 대조해도 여전히 **byte 단위로 동일**했다.

```
$ diff fail_base.txt fail_final.txt
IDENTICAL to clean-HEAD baseline (20/20)
```

- **결론: 구현자 보고가 정확하다.** 20건은 이번 작업 범위 밖의 기존 실패이며 손대지 않았다.
- 다만 구현자 기술 중 **세부 하나는 덜 정확하다.** `server.test.ts` 17건의 원인을
  "`id="cameraSelect"`/`editCard`/`applyCamera` 를 찾음" 으로 적었는데, 그 단언은 17건 중
  **1건**(`영상·정적 파일 > /options …`)의 원인이고 나머지 16건은 `POST /api/cameras`·
  `/api/settings` 왕복·연결 테스트 등 **다른 원인**이다. 결론(범위 밖·기존 실패)은 바뀌지 않는다.
- 워크트리는 검증 종료 후 `git worktree remove` + `prune` 으로 제거했고 `git worktree list` 에
  본체만 남은 것을 확인했다.

---

## 3. 계획 §7 T-번호 커버리지

### 3-A. 순수 계층

| ID | 상태 | 어디에 |
|---|---|---|
| T-C1 tilt 부호·원점 | 덮음 | `idisCoords` — 0↔9000·9000↔0·4500 항등 + "반전을 잊으면" 역단언 |
| T-C2 tilt 자기역함수 | 덮음 | **0..9000 전 구간 9001개** 양방향 |
| T-C3 pan modulo 왕복 | 덮음 | 35000↔−1000 + 경계 18000/18001/0 + **계약 전 구간 36000개** 항등 |
| T-C4 pan 은 감는다 | 덮음 | 40000→4000, 음수 입력 포함 |
| T-C5 zoom 클램프 | 덮음 | 3000→1200 · 0→100 · 65535→1200 |
| T-C6 tilt 음수 방지 | 덮음 | −2000→9000 + `11000` 아님 + **−2000..0 전 구간** |
| T-C7 centerPoint 정규화 | 덮음 | 네 좌표 전부(§58 Example 자리 포함) |
| T-R1 덤프 | 덮음 | 실측 덤프 + 빈 본문 + HTML + **본문 중간의 returnCode** |
| T-R2 rc=9000 | 덮음 | + **`MODE.SYSTEM_RESTART`(9000)와 안 섞임**을 별도 단언 |
| T-R3 310/308 | 덮음 | |
| T-R4 rc=0 파싱값 4개 | 덮음 | §56 Example 원문, 값이 문자열임까지 |
| T-R5 301/302/304 | 덮음 | |
| T-R6 900/903/306 | 덮음 | + 307 |
| T-R7 9999 | 덮음 | + 비정수 returnCode |
| T-R8 선행 공백·개행 | 덮음 | `\n`·CRLF·`returnCode = 0` |
| T-R9 URI 디코딩 | 덮음 | `door%20A` · 한글 · `%zz` 원문 유지 · `+` 미변환 · 값 안의 `=` |
| T-D1 결정적 digest | 덮음 | **테스트가 RFC2617 을 따로 계산**. method·nonce 변화 반응까지 |
| T-D2 필드 집합 | 덮음 | 8필드 + 비밀번호 비노출 + cnonce 난수성 |
| T-D3 opaque | 덮음 | 있을 때 통과 / 없을 때 **지어내지 않음** |
| T-D4 RFC2069 | 덮음 | 식 대조 + qop·nc·cnonce 부재 |
| T-D5 uri = path+query | 덮음 | + **query 를 뗀 계산과 다름**까지 확인(대조군) |

### 3-B. 전송

| ID | 상태 | 어디에 |
|---|---|---|
| T-T1 Digest 왕복 | 덮음 | **목이 응답 해시를 스스로 계산해 검증** · 인증 요청 1회 · 재시도 1회 한정 |
| T-T2 POST 폼 본문 | 덮음 | Content-Type·Length·본문·쿼리 비유출 + **재시도에서도 본문 재전송** |
| T-T3 바이너리 온전성 | 덮음 | 50KB 결정적 패턴 청크 분할 + 상한 초과 시 전송 오류 |
| T-T4 Basic 폴백 | 덮음 | |
| T-T5 연결 마감 | 덮음 | 도달 불가 350ms + **응답 미완 서버** 두 갈래, 1200ms 이내 |
| T-T6 알 수 없는 방식 | 덮음 | Bearer + **헤더 없는 401**, 자격증명 미전송까지 |

### 3-C. 드라이버

| ID | 상태 | 비고 |
|---|---|---|
| T-M1·M2 getPtz | 덮음 | + 읽기가 GET·mode=1 인지 · 비정수 응답 거절 |
| T-M3·M4·M5 goPtz | 덮음 | + 본문 키 집합 전체 대조(`speed` 가 다른 이름으로도 안 샘) |
| T-M6·M7 미구현 | 덮음 | + **어떤 요청에도 `mode=9000` 이 안 나감** |
| T-M8 프로브 하강 | 덮음 | |
| T-M9 전송 실패는 던짐 | 덮음 | 마감 1200ms + 선언 능력 유지 |
| T-M10 인증 실패는 던짐 | 덮음 | rc=900 · **HTTP 401** 두 갈래 + `statusCode === 502` |
| T-M11 301/304 는 있음 | 덮음 | 304→pixelCentering · 301→boxZoom |
| T-M12 벤더 확인 실패 | 덮음 | + **첫 줄에서 멈춤**(요청 1건) |
| T-M13·M14·M15 centerPoint | 덮음 | + 프로브 메모이즈 · 경계값 1920×1080 통과 |
| T-M16 비밀번호 비유출 | 덮음 | **8개 실패 경로** + URI 인코딩 형태까지 |
| T-M17 자격증명 URL 400 | 덮음 | **`statusCode` 단언 포함**(구현자가 없다고 지목한 자리) |
| T-M18·M19 스냅샷 | 덮음 | + `image/webp` 헤더 + JPEG 바이트 조합(§25 모순 대응) |
| T-M20 listSlots | 덮음 | + 네트워크 미접촉 |
| T-M21 listPresets | 덮음 | + **숫자 정렬**(10 vs 2) · 무관 키 배제 |
| T-M22 명령 표기 | 덮음 | moveTo/set/remove + `moveToPreset` 미출현 |
| T-M23 프리셋 id 범위 | 덮음 | 0·257·1.5·−1·NaN × 세 메서드 + 경계 1·256 통과 |
| T-M24 ptzCommand | 덮음 | 화이트리스트 + speed 클램프 + **`step=0` 보존** |
| T-M25 raw() | 덮음 | + 판정 우회 없음 · POST 경로 |
| T-ISO 격리 | 덮음 | + **`contract.ts` 는 반대로 갖고 있음**(이관점이 정말 1곳) + 파일 수 하한 |

### 3-D. DB · 서버 · 정규화 · UI

| ID | 상태 | 비고 |
|---|---|---|
| T-DB1 새 DB idis | 덮음 | + CHECK 가 **실제로 막는지**(장식 아님) |
| T-DB2 판 올림 | 덮음 | |
| T-DB3 (다) 감지 | 덮음 | **HEAD(v4) `SCHEMA_SQL` 원문 픽스처** · 메시지 3낱말 · 멱등 · 표 미재작성 · 판이 이미 5인 경우 |
| T-DB4 (가) 통과 | 덮음 | ALTER 유래 · idis 삽입 · 기존 데이터 보존 · **멱등(3회 재개방)** |
| T-N1 idis 보존 | 덮음 | 네 종류 전부 |
| T-N2 폴백 회귀 | 덮음 | 8가지 잘못된 입력 |
| T-S1 조립 | 덮음 | + `fetchImpl` 무시 · `never` 소진 · 자격증명 URL |
| T-S2 설정 왕복 | 덮음 | + 저장 후에도 kind 유지 |
| T-S3 DB 왕복 | 덮음 | + `config.json` 1회 이관이 건너뛰지 않음 |
| T-S4 device-presets 501 | 덮음 | + 카메라 미접촉 · hucoms 대조군 |
| T-S5 코어 능력 광고 | 덮음 | **알려진 한계를 그대로 고정** + park3d 대조군 |
| T-UI1 드롭다운 2곳 | 덮음 | + 기존 3종 유실 없음 · `CAMERA_KINDS` 와 집합 일치 |
| **T-UI2 portPairWarning** | **미충족 — §5 판정 참조** | 계획의 기대가 성립하지 않는다 |

**계획 §7 의 T-번호 중 안 덮은 것은 없다.** T-UI2 만 "덮었으나 기대를 만족하지 못한다".

### 3-E. 계획에 없던 것 — `insecureTls` 배선 전 구간 (`test/idisInsecureTls.test.ts` 28건)

사용자 결정으로 계획 **이후에** 생긴 값이라 §7 에 케이스가 없다. 여덟 고리를 각각 못박았다.

| 고리 | 확인한 것 |
|---|---|
| 1 체크박스 | `options.html` 의 `camInsecureTls` |
| 2 `draft()` | **snake_case `insecure_tls`** 로 보냄 = 서버 `merged()` 가 읽는 이름과 일치 · `renderEditor` 역방향 · dirty 리스너(`input`+`change`) |
| 3 `PUT /api/db/cameras` | `true`→1 · `false`→0 · **생략 시 유지** |
| 4 DB 왕복 | boolean↔정수 · `??` 라 명시 `0` 이 살아남음 · 저장소가 7→1 로 좁힘 |
| 5 `toCameraConfig` | idis+1 만 키 생성 · **hucoms/park3d 는 열에 1 이 있어도 키 없음** |
| 6 공개 응답 | `/api/settings` 에 `insecureTls:true` · 다른 kind 는 키 집합이 안 넓어짐(9키 정확 대조) · 끄면 키 소멸 · 종류 변경 시 키 소멸 |
| 7 `createDriver` | 설정 → 팩토리 |
| 8 `rejectUnauthorized` | **실제 자체서명 HTTPS 서버**로 확인 |

고리 8 이 이 스위트의 핵심이다. `openssl req -x509` 로 만든 **테스트 전용 자체서명 인증서**
(CN/SAN = 127.0.0.1, 2126년까지)를 파일에 고정하고 실제 TLS 서버를 띄웠다 — 실행 환경에
openssl 이 있는지에 시험이 매달리지 않는다.

- `insecureTls` 없음/`false` → **실패**하고 메시지에 `insecure_tls` 안내가 실린다(전제 확인)
- `insecureTls:true` → **같은 서버에서 성공**
- `createDriver` 로 만든 드라이버도 같다
- **`camera_info` 행에서 출발해도** 끝까지 닿는다
- 느슨한 기기를 성공시킨 **뒤에도** 엄격한 기기는 여전히 실패하고 `NODE_TLS_REJECT_UNAUTHORIZED`
  는 손대지 않는다 = **요청별 TLS 가 실제로 요청별이다**

---

## 4. 발견한 결함과 조치

### 4-1. 고쳤음 — `openDatabase()` 가 실패 시 DB 핸들을 흘린다

- **위치** `SettingMain/src/db/database.ts:38~48`(수정 전)
- **재현** (다) 상태 픽스처를 `openDatabase({path})` 로 연다 → `verifyCameraKindConstraint` 가
  `DatabaseError` 를 던진다 → **핸들이 닫히지 않는다.**
- **기대/실제** 기대: 던지되 파일 잠금은 남기지 않는다. 실제: Windows 에서 그 파일을 지우지도
  옮기지도 못한다 —
  `Error: EBUSY: resource busy or locked, unlink '…\old-schema.db'`
  (내 첫 실행에서 실제로 5건이 이 오류로 깨졌다)
- **영향** 이번 변경이 만든 결함은 아니다(`verifySchema` 도 던진다). 그러나 **새 가드가 이 경로를
  일상적으로 도달 가능하게 만들었고**, 하필 그 상황이 "사람이 DB 파일을 손봐야 하는" 상황이라
  파일이 잠기면 손쓸 방법까지 막힌다.
- **조치** `try/catch` 로 감싸 실패 시 `db.close()` 후 재던짐. 4줄 · 동작 변화 없음(성공 경로 동일).
  회귀 시험을 `idisDatabase.test.ts` 에 남겼다("던진 뒤에도 그 파일을 지울 수 있다").
- 이 수정으로 기존 `database.test.ts` 를 포함한 어떤 시험도 새로 깨지지 않았다.

### 4-2. 설계 판단 필요 — `portPairWarning` 이 IDIS 에 근거 없는 경고를 낸다 (계획 T-UI2)

§5 에 판정을 따로 적었다.

### 4-3. 기록만 — `POST` 와 `PUT` 이 `insecure_tls` 를 다른 이름으로 읽는다

- **위치** `src/api/routes/dbRoutes.ts:86`(POST → `normalizeCamera` → `r.insecureTls`, camel) vs
  같은 파일 `merged()`(PUT → `patch.insecure_tls`, snake)
- **재현/실측** 라이브 서버에 실제로 쏴서 확인했다.

  | 본문 | 저장된 `insecure_tls` |
  |---|---|
  | `POST {cam_uuid, kind:'idis', insecure_tls:true}` | **0** (무시됨) |
  | `POST {cam_uuid, kind:'idis', insecureTls:true}` | 1 |
  | `PUT {insecure_tls:true}` | 1 |

- **지금은 사고가 안 난다.** 화면의 「+ 기기 추가」는 `{cam_uuid, kind, label}` 만 보내고 나머지는
  전부 PUT 으로 채운다(그 사실도 시험으로 고정했다).
- **고치지 않았다.** 넓힐지(POST 도 snake 를 읽기) 좁힐지는 계약 판단이고, 계획 범위 밖이다.
  현재 동작을 `[기록]` 케이스로 사실대로 고정만 해 두었다.

### 4-4. 구현 결함 아님 — 검증 중 확인한 것

- `verifyCameraKindConstraint` 의 SQL 주석 제거는 **실제로 필요하다.** (다) 픽스처를 HEAD 원문
  그대로 썼더니 `kind` 열 바로 위 주석에 `kind` 라는 낱말이 있었고, 주석을 안 걷으면 매칭이
  엉뚱한 CHECK 를 읽는다. 그 전제를 시험에 명시로 박아 두었다.
- 열 구분자를 넘지 않는 `[^,]*?` 도 필요하다. (가) 상태에 뒤쪽 열 CHECK 를 심은 픽스처로
  오판하지 않음을 확인했다.

---

## 5. `portPairWarning` 판정 — **계획 T-UI2 는 성립하지 않는다. 결함으로 올린다.**

### 실측

함수 본문을 떼어 내 실제로 평가했다.

| 입력 | 결과 |
|---|---|
| `('http://h:80', 'rtsp://h:554/trackID=1', 'idis')` | `''` |
| `('http://h:80', 'http://h:8080/stream', 'idis')` | `''` |
| `('https://h:443', 'http://h:8080/stream', 'idis')` | `''` |
| **`('http://h:8000', 'http://h:8080/stream', 'idis')`** | **`' ⚠ 제어 8000 의 영상 포트는 8010 입니다 — 지금 8080 는 다른 카메라를 볼 수 있습니다'`** |
| **`('https://h:8443', 'http://h:8080/stream', 'idis')`** | **`' ⚠ 제어 8443 의 영상 포트는 8453 입니다 …'`** |

### 판정

**결함이다.** 다만 구현자 보고보다 한 걸음 더 들어간 사실이 있다 — **빈 문자열이 나오는 경우도
규칙 때문이 아니라 우연이다.**

1. IDIS 제어는 보통 80/443 인데 `new URL().port` 가 **기본 포트를 지워** `controlPort = 0` 이
   되고 함수가 그 앞 `if (!controlPort || !streamPort) return ''` 에서 빠져나간다.
2. IDIS 영상은 보통 `rtsp://` 라 첫 관문 `/^https?:\/\//` 에서 빠져나간다.

둘 중 **하나라도 어긋나면**(비기본 포트로 연 IDIS + MJPEG 중계) `kind === 'park3d-rpc'` 분기를
지나 **"영상 = 제어 + 10"** 이라는 **UE 시뮬레이터 직결 전용 규칙**으로 떨어진다. IDIS 에는
그런 규칙이 없다 — 제어 80/443, 영상 RTSP 554 가 이 벤더의 모습이고, "제어 + 10" 은 근거가
어디에도 없다. 화면이 사용자에게 **없는 규칙을 지키라고 시킨다.**

### 조치 — 고치지 않았다. 현재 동작을 정확한 문자열로 고정했다.

- **고칠 수 있는 명백한 결함이 아니다.** "IDIS 의 올바른 포트짝 규칙은 무엇인가" 에 답해야 하는데
  답은 "규칙이 없다" 이고, 그러면 폴백 갈래를 kind 별로 갈라야 한다 — 이는 UI 경고 규칙의
  **계약 변경**이고 `hucoms`·`backend-core` 의 기존 동작에도 영향이 간다.
- **느슨하게 덮지 않았다.** `toBe('')` 같은 관대한 단언 대신 **틀린 문구를 문자열 그대로** 박았다.
  누가 고치는 순간 이 시험이 깨지고, 그때가 결함 해소 시점이다. 계획 T-S5 가 쓴 것과 같은 방식이다.
- 원인 위치도 함께 고정했다 — IDIS 와 hucoms 의 반환값이 **같음**을 단언해, 이것이 IDIS 전용
  분기의 문제가 아니라 **폴백 한 갈래를 공유하기 때문**임을 못박았다.

**설계 판단 필요:** 폴백 갈래를 `hucoms`·`backend-core` 로 좁히고 그 밖의 종류에는 `''` 를
돌려줄 것인가. 계획 T-UI2 의 문면은 그것을 뜻하는 것으로 읽힌다.

---

## 6. 구현자 스모크(`test/idisSmoke.test.ts`) 처리 — 흡수 후 삭제

23건 전부가 내 스위트에 **더 강한 단언으로** 들어갔음을 한 건씩 대조한 뒤 파일을 지웠다.
같은 계약을 두 파일이 각자 들고 있으면 계약이 바뀔 때 두 곳을 고쳐야 하고, 한쪽만 고치는 순간
테스트가 거짓말을 시작한다.

| 스모크 케이스 | 흡수처 |
|---|---|
| §56 Example 좌표 · 실측 자세 | `idisCoords` 묶음 변환 |
| 틸트 음수 · 줌 클램프 · 센터링 정규화 | T-C6 · T-C5 · T-C7 (+ 전 구간 확장) |
| 덤프 판정 · 코드 8종 분류 · URI 디코딩 | T-R1 · T-R2/R3/R5/R6/R7 · T-R9 |
| digest 결정적 검증 | T-D1 (+ method·nonce 반응) |
| Digest 401 → getPtz | T-T1 + T-M1 |
| goPtz POST/speed · 프리셋 표기 · 미구현 501 | T-M3/M4/M5 · T-M22 · T-M6/M7 |
| 프로브 4종(하강·벤더실패·전송실패·301/304) | T-M8 · T-M12 · T-M9 · T-M11 |
| centerPoint 3종 | T-M13 · T-M14 · T-M15 |
| 스냅샷 SOI · 비밀번호 비유출 · listSlots | T-M18/M19 · T-M16(8경로) · T-M20 |
| T-ISO | T-ISO (+ 역방향 확인) |

---

## 7. 실기로만 닫히는 미검증 항목

**이 스위트 전체가 목 기반이다. 실기 IDIS 카메라는 없다.** 계획 §7 "실기 미검증 목록" 5건은
그대로 열려 있고, 검증 중 **4건을 새로 추가**한다.

계획에 이미 있던 것:

1. **틸트 원점과 부호** — `9000 − x` 는 DC-S6261XT 한 대의 실측이다. 다른 모델에서 같다는 근거가 없다.
2. **줌 상한 1200** — 이 모델의 광학 x12 이고 모델마다 다르다.
3. **§4-B 분류표의 `[미확인]` 행** — `301`/`304`/`900`/`310`/`308` 을 기기가 실제로 돌려주는가.
   특히 T-M11(`ptzMoveToPoint&mode=1` → `304`)은 **지원 기기가 있어야만** 확인된다.
4. **`videoSnapshot` 의 Content-Type** — §25 는 `image/webp` 라 적혀 있다.
5. **RTSP `trackID=N` 의 실제 코덱** — 번호를 믿지 말고 ffprobe 로 확인.

검증 중 새로 발견한 것:

6. **`modelInformation` 이 정말 POST 인가.** 매뉴얼 §4 원문이 `Method: POST` 라 그렇게 보내지만
   다른 Read 액션은 GET 이다. **프로브의 첫 줄이라 이것이 틀리면 모든 프로브가 벤더 확인 실패로
   떨어진다** — 목에서는 목이 GET/POST 를 가리지 않아 절대 드러나지 않는다.
7. **Digest 챌린지가 정말 `qop="auth"`·`algorithm=MD5` 인가.** 그 밖이면 구현이 **던진다**
   (조용히 MD5 로 계산하지 않는다). 실기가 `MD5-sess`·`SHA-256` 을 쓰면 즉시 연결 불가이고,
   그때 `digest.ts` 를 넓혀야 한다. 목은 우리가 정한 챌린지만 보낸다.
8. **`+` 를 공백으로 접지 않는 판단.** 프리셋 이름에 `+` 를 넣어 저장·조회하면 닫힌다.
9. **`insecure_tls` 가 필요한 실제 모델이 있는가.** 자체서명 인증서를 쓰는 IDIS 모델에서
   체크를 켜고 실제로 연결되는지. TLS 계층 자체는 §3-E 고리 8 로 닫혔지만, **그 기기의 인증서가
   Node 가 거절하는 이유가 자체서명인지**(만료·SAN 불일치 등 다른 이유일 수도 있다)는 실기 문제다.

---

## 8. 산출물

**신규 테스트 9파일 194건** (`SettingMain/test/`):
`idisCoords` · `idisReply` · `idisDigest` · `idisTransport` · `idisCamera` ·
`idisDatabase` · `idisInsecureTls` · `idisServerRoutes` · `idisNormalizeUi` `.test.ts`

**소스 수정 1파일**: `SettingMain/src/db/database.ts` — `openDatabase()` 실패 시 핸들 닫기(§4-1).

**삭제 1파일**: `SettingMain/test/idisSmoke.test.ts` — §6 대로 흡수 완료.

작업 트리 외 잔여물 없음(`git worktree list` 에 본체만 · 임시 DB·인증서는 전부 tmp 또는 스크래치패드).
