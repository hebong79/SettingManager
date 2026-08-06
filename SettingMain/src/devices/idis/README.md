# IDIS WebAPI v2.20 카메라 드라이버 (self-contained 서브트리)

이 폴더는 **폴더째 다른 프로젝트로 복사할 수 있게** 만들어져 있다. 런타임 의존성은 0 이고
`node:http`·`node:https`·`node:crypto` 만 쓴다.

## 복사 절차 — 고칠 파일은 `contract.ts` 하나다

1. `src/devices/idis/` 를 통째로 복사한다.
2. **`contract.ts` 만 고친다.** 이 파일이 바깥을 보는 유일한 자리이며, 나머지 8개 파일에는
   `../` 로 시작하는 import 가 하나도 없다(테스트 T-ISO 가 이것을 기계로 증명한다).
3. `contract.ts` 가 요구하는 것은 다음 다섯이다.
   - `CameraDriver`·`CenterPoint`·`Slot`·`PtzRaw` — **타입뿐이다.** 옮긴 곳의 계약에 맞춰
     다시 적으면 된다.
   - `CameraDriverError` — **유일한 런타임 값 의존.** `constructor(message, statusCode, { cause })`
     를 갖는 오류 클래스 하나만 있으면 된다.

## 계약 좌표 규약

계약은 Hucoms 논리 좌표다. 변환·클램프는 `idisCoords.ts` 한 곳에 있다.

| 축 | 계약 | IDIS 와이어 | 와이어→계약 | 계약→와이어 |
|---|---|---|---|---|
| pan | `0..35999` 무부호 | `absPan −18000..18000` | `((absPan%36000)+36000)%36000` | 감아서 `>18000` 이면 `−36000` |
| tilt | `−2000..9000`, **+ 가 아래**, 0=수평 | `absTilt`, **+ 가 위**, 0=수직아래 | `9000 − absTilt` | `9000 − tilt` 뒤 `[0,9000]` 클램프 |
| zoom | `0..65535` 불투명 raw | `absZoom` **배율×100** | 항등 | 항등 뒤 `[100,1200]` 클램프 |
| centerPoint | `{x,y}` 1920×1080 픽셀 | `pointPan`·`pointTilt` `0..100000` | (쓰기 전용) | `round(x/1920×100000)` |

## 근거의 구분 — 무엇이 매뉴얼이고 무엇이 실측인가

`[매뉴얼 §N]` 은 IDIS Web API Protocol v2.20 원문, `[실측]` 은 실기 측정, `[미확인]` 은 아직
근거가 없는 것이다. **충돌하면 실측이 이긴다.**

매뉴얼에만 있는 것 — CGI 경로, mode·returnCode 전표, 액션 이름과 파라미터, 좌표 **범위**,
프리셋 명령 표기 `set|moveTo|remove`, 이동 명령 22개, 속도 눈금 1~16.

**실측으로만 닫힌 것** (매뉴얼이 말하지 않는다):

- **틸트의 원점과 부호.** `absTilt=0` 이 수직 아래, `9000` 이 수평 `[실측 DC-S6261XT 2026-07-29]`.
  매뉴얼은 범위(−9000..9000)만 말한다. 이 드라이버의 `9000 − x` 는 **이 한 대의 실측**이다.
- **줌 상한 1200** (이 모델의 광학 x12). 매뉴얼은 `<Max zoom scale>` 이라고만 적는다.
- **틸트 음수의 오토플립.** `absTilt=−3000` 을 보내면 `returnCode=0` 을 답하면서 팬을 180°
  돌려 해결한다. 그래서 보내기 전에 자른다.
- **Digest 만 받는다.** 매뉴얼은 `RFC2617` 이라고만 적어 Basic 도 포함되지만, 실측기는
  Basic 에 401 이었다. 그래서 챌린지를 읽어 방식을 고른다.
- **미구현 액션의 두 얼굴.** `returnCode=9000`(정직) 또는 **무관한 설정 덤프**(200 + 본문).
  후자 때문에 "본문이 `returnCode=` 로 시작하는가" 가 유일한 신뢰 신호다.

`[미확인]` — §4-B 분류표의 `301`/`304`/`900`/`310`/`308` 이 실제로 오는지는 지원 기기가 없어
확인하지 못했다. 그래서 분류의 기본 갈래를 **안전한 쪽**('없음' → 501 거절)에 두었다.

## 이 드라이버가 하지 않는 것

- **`intrinsics` 를 지어내지 않는다.** IDIS `zoom` 은 "0 = 광각" 이 아니라 "100 = 광각" 이라
  Hucoms 기본 화각 곡선을 폴백으로 들면 화각이 약 5배 틀린다 `[실측 사고]`.
- **소프트웨어 센터링을 하지 않는다.** `ptzMoveToPoint` 가 없으면 501 로 거절한다.
- **RTSP URL 을 조립하지 않는다.** IDIS 규약은 `rtsp://<ip>:554/trackID=N` `[매뉴얼 §0]` 이지만
  **N 이 어느 코덱인지는 기기 설정이 정한다** — 번호를 믿지 말고 `ffprobe` 로 확인할 것
  `[실측 교훈]`. SettingMain 은 `streamUrl` 에 전체 URL 을 담는다.
- **ONVIF 를 붙이지 않는다.** ONVIF `GetNodes` 는 절대 PTZ 공간을 노출하지 않아 역량의 하한만
  보여 준다 `[실측]`. 벤더 중립 정체 확인 수단으로는 `GetDeviceInformation` 이 유일하지만,
  이 설계는 그 자리를 `modelInformation` 으로 대신한다.
- **매뉴얼의 나머지 60여 절을 감싸지 않는다.** 절 이름은 `idisConstants.ts` 의
  `ACTION_CATALOG` 에 있고, 호출은 `IdisCameraClient.raw(action, params, method)` 로 연다.

## 상류와의 관계 — 벤더링이 아니라 독립 구현이다

이 코드는 `baro_calory/packages/cctv-client/src/idis-camera-client.mjs` ·
`http-transport.mjs` 와 **같은 기기에 대한 독립 구현**이다. 복사·심볼릭 참조가 없으므로
`src/vendor/baro-profile` 과 달리 **해시 고정 대상이 아니다.** 다시 쓴 이유는 ① 상류가 타입
없는 `.mjs` 이고 이 저장소는 `checkJs` 를 끈 채 `strict` TypeScript 라는 것, ② 상류가
`capabilities.mjs`·`camera-driver.mjs`·`@baro/profile` 에 의존해 self-contained 가 아니라는
것, ③ 계약 표면이 다르다는 것이다.

**따라서 두 벌이 된다는 위험은 실재한다. 한쪽에서 실측이 갱신되면 다른 쪽도 확인할 것.**
사실의 정본은 코드가 아니라 위의 「근거의 구분」 절과 `_workspace/01_architect_plan.md` 다.

## 실기 미검증 목록

이 서브트리의 테스트는 전부 목(mock) 기반이다. 실기가 확보되면 가장 먼저 확인할 것:

1. **틸트 원점과 부호** — 아래를 보라 했을 때 실제로 아래를 보는가.
2. **줌 상한** — `absZoom` 최댓값. 모델마다 다르다.
3. **분류표의 `[미확인]` 행** — 특히 `ptzMoveToPoint&mode=1` 이 정말 `301`/`304` 를 주는가.
4. **`videoSnapshot` 의 Content-Type** — §25 는 `image/webp` 라 적혀 있다.
5. **`modelInformation` 이 POST 로 동작하는가** — 매뉴얼 §4 는 POST 라 적고 있으나 다른 Read
   액션은 GET 이다. 실기에서 405/덤프가 나오면 GET 으로 바꾼다.
6. **RTSP `trackID=N` 의 실제 코덱** — 번호를 믿지 말고 `ffprobe` 로 확인한다.
