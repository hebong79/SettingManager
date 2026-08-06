// @baro/profile — 카메라 광학·조준 기하 계층의 배럴.
//
// 여기 있는 코드는 이 저장소의 "광학 진실의 출처"다: 이 카메라가 줌마다 실제로 얼마나
// 보는지(zoomHfov), 펌웨어가 얼마나 빗나가는지(centeringGain), 그리고 그 둘로 하는
// 픽셀<->PTZ 변환 전부. 규칙 셋:
//   1. 외부 의존 0. DOM/fs/네트워크 금지 — Node 와 브라우저가 같은 파일을 실행한다.
//   2. 여기 있는 계산을 다른 곳에 복제하지 않는다(과거 6중 분기의 재발 방지).
//   3. 숫자를 바꾸면 test/calibration-golden.test.mjs(실기 112샘플)가 잡는다 —
//      골든이 깨지면 실측으로 재검증한 뒤 픽스처를 새로 뜬다.

export { HucomsCameraError } from "./errors.mjs";
export {
  ZOOM_HFOV_TABLE, CAMERA_CALIBRATIONS, resolveIntrinsics,
  hfovFromZoomPos, vfovFromHfov, centeringGain, applyCenteringGain,
} from "./camera-intrinsics.mjs";
export { ptzCamera, projectWorldToPixel, projectPoints } from "./camera-projection.mjs";
export { ptzToWidePixel, pixelToPtzDelta, zoomPosToHFov } from "./fov-convert.mjs";
export { scalePointToHucomsFrame, HUCOMS_FRAME } from "./frame-scale.mjs";
export { buildCalibration, solveZoom, usableSamples, MIN_PEAK, MIN_MARGIN } from "./calibration.mjs";
