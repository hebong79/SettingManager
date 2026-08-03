# SettingMain 독립 CameraCore 설계도

## 목표

BackendCore에 등록되지 않은 카메라도 SettingMain 자체 컴포넌트로 센터라이징·캘리브레이션·번호판 호밍을 수행한다. 외부 BackendCore의 active camera를 사용하거나 변경하지 않는다.

## 구조도

```text
[Discovery Web UI]
      │ local independent-core REST
      ▼
[SettingMain API]
      ▼
[IndependentCameraCore]
  ├─ CenteringComponent
  ├─ CalibrationComponent
  ├─ PlateHomingComponent
  ├─ DetectorClient
  ├─ CameraCoreStore
  └─ CameraId별 Lease/Lock
      ▼
[CameraDriver / HucomsClient]
      ▼
[선택된 카메라 CGI · Snapshot · Stream]
```

## 독립성 규칙

- 각 `cameraId`는 별도 작업 context·lock·저장 경로를 가진다.
- 리얼카메라2의 homing이 리얼카메라1의 center 요청을 막지 않는다.
- 카메라별 calibration profile 및 discovery-point는 `SettingMain/config` 아래 cameraId별 파일로 저장한다.
- PTZ 장기 작업은 시작 전 위치를 기록하고 stop/failure/finally에서 원래 wide preset으로 복귀한다.
- 브라우저에는 비밀번호를 반환하지 않는다.

## API 초안

```text
GET  /api/independent-core/cameras/:id/capabilities
POST /api/independent-core/cameras/:id/center
GET  /api/independent-core/cameras/:id/calibration
POST /api/independent-core/cameras/:id/calibration/start
POST /api/independent-core/cameras/:id/calibration/stop
GET  /api/independent-core/cameras/:id/plate-homing
POST /api/independent-core/cameras/:id/plate-homing/start
POST /api/independent-core/cameras/:id/plate-homing/stop
```

## 구현 전 확인된 사실

SettingMain에는 direct camera PTZ/settle 기반은 있으나 calibration·homing 알고리즘은 없다. BackendCore 구현을 이식하려면 calibration solver/frame matcher와 LPD/VPD detector/plate-tracker의 의존 코드를 SettingMain TypeScript로 함께 이식해야 한다. 이 작업은 `baro_calory`를 변경하지 않고 수행 가능하지만, 대체 코드의 규모가 크며 detector 운영 endpoint를 SettingMain config로 새로 관리해야 한다.
