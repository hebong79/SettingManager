# 독립 카메라 BackendCore Worker 구현

## 생성 위치

`baro_calory/apps/independent-camera-core/`

## 구현 내용

이 폴더는 기존 BackendCore의 기능을 복제하지 않습니다. 검증된 `apps/backend-core/src/server.mjs`를 **별도 config·별도 포트·별도 active camera**로 실행하는 독립 worker launcher입니다. 따라서 camera-154가 기존 `/barocalory` BackendCore의 active device를 바꾸지 않고 center, calibration, plate-homing API를 사용할 수 있습니다.

```text
기존 BackendCore
  config.json / port 8080 / active=기존 카메라

independent-camera-core
  config.json / port 8184 / active=cam-154
```

두 서비스 모두 API path는 `/barocalory/api/*`입니다.

## 운영 설정

서버에서:

```bash
cd /path/to/baro_calory/apps/independent-camera-core
cp config.example.json config.json
chmod 600 config.json
```

`config.json`의 `CAMERA_IP`, `CAMERA_USERNAME`, `CAMERA_PASSWORD`를 154 카메라의 실제 값으로 교체합니다. 이 파일은 git에 커밋하면 안 됩니다.

```bash
CAMERA_CORE_CAMERA_ID=cam-154 npm run start
```

기본 API base URL:

```text
http://BACKEND_SERVER:8184/barocalory
```

SettingMain Options의 BackendCore URL에는 위 주소를 입력합니다. 주차면 탐색에서 BackendCore 사용을 체크하면 기존 API 계약 그대로 이 worker에 연결됩니다.

## 실제 웹 연결 확인 명령

카메라를 움직이지 않는 GET만 사용합니다.

```bash
curl --fail http://BACKEND_SERVER:8184/barocalory/api/health
curl --fail http://BACKEND_SERVER:8184/barocalory/api/cctv/capabilities
```

두 번째 응답의 `cameraId`가 `cam-154`인지 먼저 확인한 뒤에만 center/calibration/homing을 사용합니다.

## 검증 상태

launcher 문법 검사는 통과했다. 그러나 현 Docker 개발 환경은 Node 20.20.2인데 `baro_calory`의 pnpm 11.1.0은 Node 22.13+를 요구하여 workspace 의존성을 설치할 수 없었다. 따라서 새 worker 기동 HTTP 검증은 Node 22.13+ 실제 서버에서 남아 있다.
