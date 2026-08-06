import { HucomsCameraError } from "./errors.mjs";
import { hfovFromZoomPos, vfovFromHfov } from "./camera-intrinsics.mjs";

// Reproject a homed CLOSE-UP PTZ back into the WIDE preset frame's pixel. When a
// plate is centered at the close-up, the close-up pan/tilt IS that plate's absolute
// direction. Where that direction lands in the WIDE *image* is governed by the image
// projection (UE render / rectilinear lens) = TAN pinhole — not by the firmware's
// setcenter motion model. So this is a DISPLAY reprojection: full 3D pan/tilt basis
// + tan, same family as camera-projection.mjs ("재구성은 tan" 원칙).
//
// HFOV defaults to the cam-001 calibration table AT THE WIDE PRESET'S ZOOM
// (zoomPosToHFov). The old fixed-28.4° call was ~22% off at z8000 (table: 23.3°),
// which showed up as dots drifting off the car more the farther from center —
// linear scale error grows with eccentricity. VFOV defaults to the tan-consistent
// aspect ratio. Sign convention preserved (cam-001 field-validated 2026-06-13):
// higher panpos → target right in frame (x+), higher tiltpos → target lower (y+).
// Pan wraps at 360° (trig handles the 0..36000 seam). Behind-camera → inFrame=false.
const DEG = Math.PI / 180;
export function ptzToWidePixel({ closeup, wide, hfov, vfov, zoomHfovTable, frameWidth = 1920, frameHeight = 1080 } = {}) {
  if (!closeup || !wide) throw new HucomsCameraError("ptzToWidePixel needs closeup and wide PTZ.");
  // zoomHfovTable is THIS camera's measured zoom->FOV curve. Absent, we fall back to the
  // built-in one — right for the camera it was measured on, a guess for any other lens.
  const h = hfov !== undefined ? hfov : hfovFromZoomPos(Number(wide.zoompos) || 0, undefined, zoomHfovTable);
  assertPositive("hfov", h);
  const halfH = (h / 2) * DEG;
  const v = vfov !== undefined ? vfov : vfovFromHfov(h, frameWidth, frameHeight);
  assertPositive("vfov", v);
  // Hucoms → math frame: panpos+ = clockwise → azimuth a = -pan; tiltpos+ = down → elevation e = -tilt.
  const ang = (p) => ({ a: -((Number(p.panpos) || 0) / 100) * DEG, e: -((Number(p.tiltpos) || 0) / 100) * DEG });
  const dir = ({ a, e }) => [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)];
  const F = dir(ang(wide));                       // wide optical axis (forward)
  const rn = Math.hypot(F[0], F[1]) || 1;
  const R = [F[1] / rn, -F[0] / rn, 0];           // image right = F × worldUp, normalized
  const U = [R[1] * F[2], -R[0] * F[2], R[0] * F[1] - R[1] * F[0]]; // image up = R × F
  const d = dir(ang(closeup));                    // homed target direction
  const t = d[0] * F[0] + d[1] * F[1] + d[2] * F[2];
  const u = d[0] * R[0] + d[1] * R[1];
  const w = d[0] * U[0] + d[1] * U[1] + d[2] * U[2];
  const cx = frameWidth / 2, cy = frameHeight / 2;
  const fx = cx / Math.tan(halfH);
  const fy = cy / Math.tan((v / 2) * DEG);
  const behind = t <= 1e-9;                       // ≥90° off-axis: no pinhole image
  const xExact = behind ? cx + Math.sign(u || 1) * frameWidth : cx + fx * (u / t);
  const yExact = behind ? cy + Math.sign(-w || 1) * frameHeight : cy - fy * (w / t);
  const inFrame = !behind && xExact >= 0 && xExact <= frameWidth && yExact >= 0 && yExact <= frameHeight;
  return {
    x: clamp(Math.round(xExact), 0, frameWidth),
    y: clamp(Math.round(yExact), 0, frameHeight),
    xExact,
    yExact,
    inFrame,
  };
}

// 클릭 픽셀 -> setcenter 가 만들어내는 pan/tilt 델타(centi-degree). 즉 **펌웨어의 조준 모델**이다.
//
// 실기(cam-001)를 105샘플 실측해 확정한 규약(2026-07-14): TAN 핀홀 + 구면(짐벌) 기하. 픽셀을
// 카메라 좌표계의 광선으로 되돌린 뒤 그 광선이 새 광축이 되도록 팬/틸트를 푼다. 팬 축이 월드
// 수직축이라, 광축이 기울어져 있으면 가로로만 클릭해도 **틸트가 조금 딸려 움직인다** — 실기가
// 정확히 그렇게 동작하고(와이드·틸트 16.81°에서 dx=480 클릭에 dtilt=-62cd), 이 식이 그 값을
// 오차 0 centidegree 로 재현한다.
//
// 이 저장소는 오랫동안 "펌웨어는 선형"이라 믿었지만 그건 검증된 적 없는 가정이었다(그 믿음이
// fake-camera mock → UE sim → 문서로 자기일관되게 퍼져 있었다). 실측이 반증했다.
// 근거·도구: tools/centering_calib (measure_center.py / analyze.py / README.md)
//
// 주의: 이건 조준(카메라에 명령)이고, ptzToWidePixel 은 표시(이미지에 그리기)다. 둘 다 tan 이지만
// 역할이 다르다 — 섞지 말 것.
const HALF = 0.5;
export function pixelToPtzDelta({ x, y, hfovDeg, tiltDeg = 0, focalGain = 1, frameWidth = 1920, frameHeight = 1080 } = {}) {
  assertPositive("hfovDeg", hfovDeg);
  assertPositive("frameWidth", frameWidth);
  assertPositive("frameHeight", frameHeight);
  assertFinite("x", x);
  assertFinite("y", y);

  const focal = ((frameWidth * HALF) / Math.tan((hfovDeg / 2) * DEG)) * Math.max(focalGain, 0.01);
  const nx = (x - frameWidth * HALF) / focal;   // 광축 기준 정규화 편심
  const ny = (y - frameHeight * HALF) / focal;

  // 광축의 고도각. tiltpos 는 '아래로'가 + 라 부호가 뒤집힌다.
  const e0 = -tiltDeg * DEG;
  const se = Math.sin(e0);
  const ce = Math.cos(e0);

  // 목표 광선 = F + R*nx + U*(-ny), 방위 0 기준.
  const rx = ce + se * ny;
  const ry = -nx;
  const rz = se - ce * ny;
  const len = Math.hypot(rx, ry, rz) || 1;

  const a1 = Math.atan2(ry, rx);
  const e1 = Math.asin(Math.min(1, Math.max(-1, rz / len)));

  return {
    panDelta: Math.round((-a1 / DEG) * 100),
    tiltDelta: Math.round(((e0 - e1) / DEG) * 100),
  };
}

// zoompos -> 수평 FOV(deg). 실측 캘리브레이션 표(cam-001)는 이제 camera-intrinsics.mjs 가
// JS 단일 소스다(브라우저 오버레이와 공유 — camera-math 중복 드리프트 방지). 여기선 기존 시그니처
// (zoomPosToHFov)를 유지해 control-api 등 노드 호출부를 무변경으로 둔다. UE HucomsProtocol.h 는 별도 C++ 미러.
export { hfovFromZoomPos as zoomPosToHFov } from "./camera-intrinsics.mjs";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function assertFinite(name, value) {
  if (!Number.isFinite(value)) {
    throw new HucomsCameraError(`${name} must be a finite number.`, { [name]: value });
  }
}

function assertPositive(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new HucomsCameraError(`${name} must be a positive number.`, { [name]: value });
  }
}
