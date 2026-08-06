# 벤더링 — `@baro/profile`

**이 디렉토리의 `.mjs` 파일은 남의 코드다. 손으로 고치지 않는다.**

| 항목 | 값 |
|---|---|
| 출처 | `d:\Work\Parking3D\Agent\baro\baro_calory` — `packages/profile/src/` |
| 패키지 | `@baro/profile` v0.2.1 |
| 상류 커밋 | `a2d62b67b1fae8a90121cc846e962f3c11e64175` (2026-08-05) |
| 복사 일자 | 2026-08-05 |
| 라이선스 | 사내 저장소 (`private: true`). 같은 조직 안에서의 복제다 |

## 왜 복사했는가

구성도(`docs/my_think/my_setting_manager_구성.md`)의 **Bridge Backend-Core** 는 "backend-core 에
없는 건 새로 제작"이 원칙이지만, **있는 것을 다시 짜는 것은 그 원칙이 아니다.** 광학·조준 기하는
실기 112샘플로 실측해 골든 픽스처로 고정된 계산이고, 베껴 쓰면 두 벌이 되어 반드시 갈라진다
(상류 `index.mjs` 의 규칙 2번이 정확히 그 금지다).

그래서 **다시 구현하지 않고 그대로 복사**했다. 조건이 맞았기 때문이다 —
이 패키지는 상류에서 **외부 의존 0**(DOM·fs·네트워크 금지)을 규칙으로 못 박고 있어서,
파일만 옮기면 그대로 돈다. SettingManager 의 *런타임 의존성 0* 원칙도 깨지지 않는다.

npm 워크스페이스로 참조하지 않은 이유는 **독립 운용**이다. 이 디렉토리가 있으면
`baro_calory` 저장소가 없는 기계에서도 SettingManager 가 혼자 선다.

## 무엇을 복사했나 (7파일)

| 파일 | 내용 |
|---|---|
| `index.mjs` | 배럴 |
| `camera-intrinsics.mjs` | 줌→화각 표(`ZOOM_HFOV_TABLE`) · `hfovFromZoomPos` · `vfovFromHfov` · 센터링 게인 |
| `fov-convert.mjs` | `pixelToPtzDelta`(조준) · `ptzToWidePixel`(표시) · `zoomPosToHFov` |
| `camera-projection.mjs` | 월드→픽셀 투영 |
| `calibration.mjs` | 캘리브레이션 솔버(`buildCalibration`·`solveZoom`) |
| `frame-scale.mjs` | 프레임 좌표 정규화(`scalePointToHucomsFrame`) |
| `errors.mjs` | `HucomsCameraError` |

복사하지 **않은** 것: `packages/profile/test/`(상류 러너 형식). 대신 이 저장소 관례로
`test/vendorProfile.test.ts` 를 두고 ① 파일 해시가 아래 표와 같은지 ② 대표 수치가 상류와
같은 답을 내는지를 검사한다.

## 갱신 방법

```bash
cp d:/Work/Parking3D/Agent/baro/baro_calory/packages/profile/src/*.mjs \
   SettingMain/src/vendor/baro-profile/
cd SettingMain && npx vitest run test/vendorProfile.test.ts   # 해시 불일치로 실패한다
```

실패한 해시를 **원문 확인 후** 아래 표와 `test/vendorProfile.test.ts` 에 옮겨 적고,
상류 커밋 해시·복사 일자를 이 문서에 갱신한다. 해시 표를 먼저 고치고 나중에 복사하는 순서는
금지다 — 그러면 검사가 아무것도 지키지 않는다.

## 복사본 지문 (sha256)

| 파일 | sha256 |
|---|---|
| `calibration.mjs` | `6be03db9e06154322c294f66f739181825676ed7a807ccd30aa149fa0766c384` |
| `camera-intrinsics.mjs` | `1ba7981fbb5bb0648de7a51597c1db59615040e39e500afa843dd47a63095de8` |
| `camera-projection.mjs` | `d4f07ae995eb2b83c87df2795939c0cd362f1aa1a00afeb08142d3b7ab332816` |
| `errors.mjs` | `2f14398741b74cec9be2ed783f5bf0e420b5e45418c608a64856ca726141b677` |
| `fov-convert.mjs` | `280da51fee98813794209333d863202beb5cab60eca289a499aabd0aef1d3c3c` |
| `frame-scale.mjs` | `929c899f7d8da84375d333bde1bda62716743d772464b5260888772c7130c6ef` |
| `index.mjs` | `4b0f6911382bb649e17eb2b0f81b7a82d58969607e44c0a1abadf61acdd2c2b9` |

## 쓸 때의 주의 (상류 문서에서 옮겨 온 함정)

- **내장 `ZOOM_HFOV_TABLE` 은 cam-001 실측 곡선이다.** 다른 렌즈·다른 줌 눈금 기기에 그대로
  쓰면 화각이 조용히 그 값으로 보고된다. 기기가 자기 표를 선언할 때만 계산을 켠다
  (`camera.intrinsics`). 표가 없으면 **지어내지 말고 501 로 거절한다.**
- **조준(`pixelToPtzDelta`)과 표시(`ptzToWidePixel`)는 다른 축이다.** 둘 다 tan 기하지만 역할이
  다르므로 섞지 않는다.
- 좌표 규약은 Hucoms 논리 좌표계다 — `panpos+` 는 화면에서 대상이 오른쪽, `tiltpos+` 는 아래.
