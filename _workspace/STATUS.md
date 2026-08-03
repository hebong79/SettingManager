# 작업 진행 상태

> **🟡 현재 구현 중: 4 / 6 — 독립 센터라이징과 Discovery 연결을 완료하고 CalibrationComponent로 이동**

| 순서 | 작업 단위 | 상태 | 현재 위치 |
|---:|---|---|---|
| 1 | 기존 BackendCore/SettingMain 코드 조사 및 독립 구조 설계 | ✅ 완료 | 설계도·구조도 작성 완료 |
| 2 | `baro_calory` 작업 흔적 제거 및 SettingMain 경계 확정 | ✅ 완료 | `baro_calory` 신규 Worker 폴더 제거 완료 |
| 3 | 카메라별 독립 CameraCore context·Lease/Lock | ✅ 완료 | `src/independentCameraCore/cameraLease.ts` |
| 4 | 직접 센터라이징 컴포넌트·독립 REST API | ✅ 완료 | 독립 endpoint·Discovery OFF 연결·관련 88 Vitest 통과 |
| 5 | CalibrationComponent·카메라별 보정 결과 저장소 | 🟡 구현 중 | BackendCore 참조 알고리즘을 SettingMain TypeScript로 이식 시작 |
| 6 | PlateHomingComponent·LPD/VPD Detector·UI·통합검증·문서화 | ⏳ 대기 | detector 계약/안전 복귀/테스트를 포함해 순차 구현 예정 |

## 4번 세부 진행 — 직접 센터라이징 컴포넌트·독립 REST API

> **✅ 8 / 8 완료 — 독립 API와 Discovery 화면 연결까지 검증했습니다.**

| 세부 # | 작업 | 상태 | 근거/남은 작업 |
|---:|---|---|---|
| 4-1 | `cameraId`별 독립 Lease/Lock | ✅ 완료 | `cameraLease.ts`: 같은 카메라 중복 작업은 차단, 다른 카메라는 분리 |
| 4-2 | 직접 카메라 `centerPoint` 호출 | ✅ 완료 | `centeringComponent.ts`: BackendCore 없이 `CameraDriver.centerPoint`만 호출 |
| 4-3 | PTZ 정착 대기 및 최종 좌표 응답 | ✅ 완료 | `waitForSettle` 뒤 `{ point, ptz, settled }` 반환 |
| 4-4 | 실패·예외 시 Lease 해제 | ✅ 완료 | `try/finally`에서 release 보장 |
| 4-5 | 카메라별 capability API | ✅ 완료 | `GET /api/independent-core/cameras/:id/capabilities` |
| 4-6 | 독립 center REST API·입력 좌표 검증 | ✅ 완료 | `POST /api/independent-core/cameras/:id/center`, 1920×1080 범위 검증 |
| 4-7 | Vitest 단위/HTTP 회귀 테스트 | ✅ 완료 | capability·직접 Hucoms 요청·BackendCore 비호출·좌표 400을 `server.test.ts`로 확인 |
| 4-8 | Discovery UI에서 local core endpoint 선택 | ✅ 완료 | BackendCore OFF는 `/api/independent-core/cameras/:id/center`를 사용 |

## 지금 작업 중인 파일

```text
SettingMain/src/independentCameraCore/
├─ cameraLease.ts             ✅
├─ centeringComponent.ts      ✅
└─ independentCameraCore.ts   🟡

SettingMain/src/api/server.ts 🟡 독립 center/capabilities route 연결 완료
```

## 안전 원칙

- 실제 운영 카메라 PTZ 이동·캘리브레이션·호밍 POST는 현장 승인 전에는 실행하지 않는다.
- `baro_calory` 파일은 생성·수정하지 않는다.
