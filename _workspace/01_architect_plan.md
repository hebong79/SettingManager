# architect — SettingMain 독립 CameraCore 설계

## 범위

`SettingMain/src` 안에서만 동작하는 카메라별 독립 CameraCore를 만든다. remote BackendCore의 active device, 설정 파일, HTTP API에 의존하지 않는다. 대상 기능은 직접 센터라이징, 캘리브레이션, 번호판 호밍이며 카메라별 작업 점유와 안전 복귀를 포함한다.

## 코드 근거

- SettingMain은 이미 `src/clients/cameraDriver.ts`, `src/clients/hucomsClient.ts`, `src/clients/waitForSettle.ts`로 직접 PTZ·스냅샷·정착 대기 기반을 보유한다.
- SettingMain에는 `calibration`, `homing`, `detector`, `intrinsics` 구현이 없다.
- 참고 전용 `baro_calory/apps/backend-core/src/calibration-manager.mjs`는 `@baro/profile`, `frame-match`, camera lock에 의존한다.
- 참고 전용 `baro_calory/apps/backend-core/src/discovery-manager.mjs`는 LPD/VPD detector HTTP 계약, plate tracker, discovery store에 의존한다.

## 구조도

```text
web/discovery.html + discovery.js
      │  명시적 local-core 선택 / cameraId
      ▼
SettingMain src/api/server.ts
      │
      ├─ /api/independent-core/cameras/:id/center
      ├─ /api/independent-core/cameras/:id/calibration/*
      └─ /api/independent-core/cameras/:id/plate-homing/*
      ▼
src/independentCameraCore/
      ├─ IndependentCameraCore      카메라별 context, capability, per-camera lock
      ├─ CenteringComponent         CameraDriver.centerPoint + waitForSettle
      ├─ CalibrationComponent       sweep, snapshot match, calibration profile 저장
      ├─ PlateHomingComponent       preset-point, LPD/VPD, zoom/recenter, 안전 복귀
      ├─ DetectorClient             SettingMain 설정 기반 LPD/VPD HTTP client
      └─ CameraCoreStore            카메라별 profile/job/preset-point 원자 저장
      ▼
src/clients/CameraDriver / HucomsClient / FrameSource
      ▼
선택된 독립 카메라 CGI · 스냅샷 · RTSP
```

## 가정 / 확인 필요

1. LPD endpoint는 `/lpd/api/v1/imgupload`, VPD segmentation endpoint는 `/vpd/api/v2/seg/imgupload` 형식이다. 이는 BackendCore 코드에서 확인했으나 SettingMain 운영 주소/인증/응답 크기는 확인 필요다.
2. calibration frame matching은 BackendCore의 `frame-match.mjs`와 `@baro/profile` 보정 solver를 TypeScript로 이식하거나, 동등한 SettingMain-native 알고리즘/테스트가 있어야 한다. 현재 SettingMain에는 없다.
3. 실제 calibration/homing POST는 운영 PTZ 이동 작업이므로 현장 승인 전에는 통합 테스트하지 않는다.

## 단계

1. CameraCore domain 계약·per-camera lock·center component를 구현한다.
   - 검증: 서로 다른 cameraId는 독립 lock, 같은 cameraId 중복 이동은 409, center는 direct driver만 호출.
2. 카메라별 설정·작업 상태·profile/preset-point 저장소를 구현한다.
   - 검증: config에 비밀번호가 노출되지 않고, JSON atomic write와 cameraId 경로 격리가 된다.
3. calibration algorithm 및 snapshot matcher를 SettingMain TypeScript로 이식한다.
   - 검증: fixture JPEG 기반 matcher/solver unit test, cancel·home return·lock 잔존 테스트.
4. LPD/VPD client와 plate-homing algorithm을 이식한다.
   - 검증: detector 응답 fixture, target ambiguity fail-closed, stop/failure에도 wide preset 복귀.
5. `/api/independent-core/*` routes와 Discovery UI를 연결한다.
   - 검증: browser request→route→component 경계 테스트 및 local HTTP health/capability GET.

## 영향 파일/모듈

- 추가: `SettingMain/src/independentCameraCore/**`, `SettingMain/src/store/**`, 해당 tests
- 변경: `SettingMain/src/api/server.ts`, `SettingMain/src/config/types.ts`, `normalize.ts`, `web/discovery.*`, `web/api.js`, `web/app.css`
- 참고만: `baro_calory/apps/backend-core/**`; 수정 금지

## 비범위

- `baro_calory` 파일 생성·수정
- remote BackendCore active device 변경
- 운영 카메라의 승인 없는 실제 이동/캘리브레이션/호밍
