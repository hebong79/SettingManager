# 09. 검증 보고 — park3d-rpc 포트 정정

실행: `npm run typecheck` + `npm run test` (vitest, SettingMain/)

## 1. 타입 검사

```
> tsc -p tsconfig.json --noEmit
(출력 없음 — 통과)
```

## 2. 대상 테스트 — `test/optionsPark3dUi.test.ts`

```
✓ test/optionsPark3dUi.test.ts (8 tests) 8ms
      Tests  8 passed (8)
```

| 검증 | 내용 | 결과 |
|---|---|---|
| 힌트 배선 | `portPairWarning(..., kind, $('camPark3d').value.trim())`, `const kind = $('camKind').value;`, `camPark3d` 의 `input` 배선 | 통과 |
| 정상 포트 | 13602/camId 2, 13601/camId '1'(문자열), 13650/camId 50 → 무경고 | 통과 |
| 포트 불일치 | 13605/camId 2 → 경고에 `13602`(정답)와 `13605`(현재값) 모두 포함 | 통과 |
| 제어 칸에 영상 포트 | 13601·13650 → `영상 포트` 경고 / 경계 밖 13600 → 무경고 | 통과 |
| camId 미입력 | `''`·`undefined` → 무경고 (계산 근거 없음) | 통과 |
| hucoms 회귀 | 8091 무경고 / 8095 경고 / kind 없는 옛 호출부 동작 유지 | 통과 |
| 문구 정정 | `Park3D 영상은 카메라별 포트 13600 + camId 입니다` 존재 + `같은 포트` **부재** | 통과 |

`portPairWarning` 은 소스에서 본문만 떼어 `new Function` 으로 **실제 평가**한다. 상수를 함수 안에 둔 설계가
여기서 검증됐다 — 바깥에 뒀다면 이 8건이 ReferenceError 로 죽는다.

## 3. 전체 회귀

```
 Test Files  3 failed | 30 passed (33)
      Tests  20 failed | 493 passed (513)
```

### 실패 20건은 전부 **기존 실패**다 — 이번 변경과 무관

증명: 내가 만진 유일한 픽스처(`park3dRpcServerRoutes.test.ts` 의 `streamUrl` 13510→13601)를
**되돌려 재실행해도 같은 2건이 같은 이유로 깨진다.**

| 파일 | 실패 | 사유 (읽어서 확인) |
|---|---|---|
| `test/server.test.ts` | 17 | `id="cameraSelect"`·`id="editCard"` 등 **옵션 페이지 옛 DOM** 과 `POST /api/cameras`·`DELETE /api/cameras/*` 옛 경로를 기대한다. 카메라 정본이 `camera_info` 테이블로 옮겨지면서 사라진 것들 — 진행 중인 DB 이관 작업 소관 |
| `test/powershellSafeDiagnostic.test.ts` | 1 | 같은 이관 여파 |
| `test/park3dRpcServerRoutes.test.ts` | 2 | `POST /api/db/cameras/1/test` 가 `ok:true` 를 돌려줌(camId 없는 카메라를 400 으로 막지 못함), `PUT /api/db/cameras` label 변경이 `/api/settings` 에 반영되지 않음. **DB 라우트 동작 문제이지 포트와 무관** |

이번 변경으로 **새로 깨진 테스트는 없고, 새로 통과한 것이 7건**(optionsPark3dUi 의 신규·교체분)이다.

## 4. 미검증 항목

- **브라우저 실동작 미확인.** `optionsDb.js` 는 브라우저 모듈이라 테스트가 소스를 읽어 검사하는 구조다.
  화면에서 실제로 경고가 뜨는지는 `npm start` 후 옵션 페이지에서 사람이 봐야 한다.
- 위 기존 실패 20건은 이 작업 범위 밖이라 손대지 않았다.
