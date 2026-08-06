// Pinhole (rectilinear / tan) projection of a world point onto a camera image.
//
// WHY a fresh projector (not fov-convert.mjs): fov-convert works in the PTZ domain — it
// converts BETWEEN a pixel and a pan/tilt pair for one camera (aiming, and reprojecting a
// close-up heading back into the wide frame). This file answers a different question: where
// does a point with WORLD coordinates land in the image. That needs the full camera pose
// (location + rotation basis), which fov-convert never has. Both are tan, so the models do
// not conflict — they take different inputs and must not be substituted for each other.
//
// This is the same math for sim and real cameras — the only difference is where the
// camera pose + intrinsics come from (sim: UE /scene/cameras; real: install survey +
// lens calibration). Feed a fully-resolved OPTICAL pose (world location + the world
// rotation of the camera's forward axis) and the horizontal FOV at the current zoom.
//
// Coordinate convention = Unreal Engine: left-handed, degrees, forward = +X, right = +Y,
// up = +Z. The rotation basis below is UE's FRotationMatrix (row 0/1/2 = X/Y/Z axis), so
// the pixel this returns matches UE's own ProjectWorldToScreen (validated by the sim's
// /scene/project ground-truth endpoint).

import { hfovFromZoomPos, ZOOM_HFOV_TABLE } from "./camera-intrinsics.mjs";

const DEG2RAD = Math.PI / 180;

// Sign convention mapping raw Hucoms PTZ (centidegrees) to UE pivot angles. Field-validated
// on cam-001 and matched to the sim (HucomsServerSubsystem PanToYawSign/TiltToPitchSign):
//   panpos  -> +yaw  (pan right = +panpos = +yaw)
//   tiltpos -> -pitch (higher tiltpos = camera looks DOWN; UE +pitch = up, so negate)
// If a real lens is recalibrated with different signs, override per camera.
export const PAN_TO_YAW_SIGN = 1;
export const TILT_TO_PITCH_SIGN = -1;

// Faithful PTZ camera model: rebuild the OPTICAL camera (pose + FOV) from a FIXED mount
// extrinsic + LIVE Hucoms PTZ. Identical for sim and real — only the mount source differs
// (sim: /scene/cameras; real: install survey/calibration). The sim proves this reproduces
// UE's own render to sub-pixel (validated across pan/tilt/zoom).
//   mount:      { location:{x,y,z}, baseYaw }   install extrinsic (baseYaw = azimuth at pan=0)
//   intrinsics: sim /scene/cameras intrinsics   authoritative sim zoompos→HFOV table
//   ptz:        { panpos, tiltpos, zoompos }     raw Hucoms (from /api/ptz)
// Optical rotation = FRotator(pitch = TILT_SIGN*tiltpos/100, yaw = baseYaw + PAN_SIGN*panpos/100, roll = 0),
// which is exactly the sim's PanPivot(yaw-only world) -> TiltPivot(pitch) composition.
// The wide FOV defaults to the calibration table's own wide anchor rather than a literal:
// a second copy of that number is how the old 69.88 outlived the measurement it came from.
export function ptzCamera({
  mount,
  wideHFovDeg = ZOOM_HFOV_TABLE[0].h,
  intrinsics,
  ptz = {},
  width,
  height,
} = {}) {
  if (!mount || !mount.location) throw new Error("ptzCamera: mount{location,baseYaw} required.");
  const panDeg = ((Number(ptz.panpos) || 0) / 100) * PAN_TO_YAW_SIGN;
  const tiltDeg = ((Number(ptz.tiltpos) || 0) / 100) * TILT_TO_PITCH_SIGN;
  const sceneTable = sceneZoomHfovTable(intrinsics);
  return {
    location: mount.location,
    rotation: { pitch: tiltDeg, yaw: (Number(mount.baseYaw) || 0) + panDeg, roll: 0 },
    // A sim describes its own rendered lens. Prefer that table verbatim; wideHFovDeg keeps
    // older plugins working. Physical cameras continue to resolve their {z,h} calibration
    // through resolveIntrinsics at their existing device/config boundary.
    hfovDeg: sceneTable
      ? hfovFromZoomPos(ptz.zoompos, undefined, sceneTable)
      : hfovFromZoomPos(ptz.zoompos, wideHFovDeg),
    width,
    height,
  };
}

function sceneZoomHfovTable(intrinsics) {
  const rows = intrinsics?.zoomHfov;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (intrinsics.interpolation !== undefined && intrinsics.interpolation !== "linear") return null;
  if (intrinsics.clamp !== undefined && intrinsics.clamp !== true) return null;

  const table = rows
    .map((row) => ({ z: Number(row?.zoomPos), h: Number(row?.hfovDeg) }))
    .sort((a, b) => a.z - b.z);
  if (table.some((row) => !Number.isFinite(row.z) || !Number.isFinite(row.h) || !(row.h > 0))) return null;
  for (let i = 1; i < table.length; i++) {
    if (table[i].z <= table[i - 1].z) return null;
  }
  return table;
}

// Build the camera's world-space basis (forward/right/up unit vectors) from a UE FRotator.
// Mirrors FRotationTranslationMatrix: row0=X(forward), row1=Y(right), row2=Z(up).
export function rotatorBasis({ pitch = 0, yaw = 0, roll = 0 } = {}) {
  const P = pitch * DEG2RAD, Y = yaw * DEG2RAD, R = roll * DEG2RAD;
  const SP = Math.sin(P), CP = Math.cos(P);
  const SY = Math.sin(Y), CY = Math.cos(Y);
  const SR = Math.sin(R), CR = Math.cos(R);
  return {
    forward: { x: CP * CY, y: CP * SY, z: SP },
    right: { x: SR * SP * CY - CR * SY, y: SR * SP * SY + CR * CY, z: -SR * CP },
    up: { x: -(CR * SP * CY + SR * SY), y: CY * SR - CR * SP * SY, z: CR * CP },
  };
}

function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

// Project one world point onto the camera image.
//   camera: { location:{x,y,z}, rotation:{pitch,yaw,roll}, hfovDeg, width, height }
//   point:  {x,y,z} world (e.g. a parking slot's transform.location)
// Returns { x, y, ndcX, ndcY, depth, visible, behind }:
//   x,y     = pixel in the camera frame (top-left origin, y down). May fall outside
//             [0,width]x[0,height] — caller decides whether to clamp or hide.
//   visible = in front of camera AND inside the frame rectangle.
//   behind  = point is at/behind the image plane (depth <= near); x,y are meaningless.
export function projectWorldToPixel({ camera, point } = {}) {
  const { location, rotation, hfovDeg, width, height } = camera || {};
  if (!location || !point || !(hfovDeg > 0) || !(width > 0) || !(height > 0)) {
    throw new Error("projectWorldToPixel: camera{location,rotation,hfovDeg,width,height} and point are required.");
  }
  const basis = rotatorBasis(rotation || {});
  const rel = { x: point.x - location.x, y: point.y - location.y, z: point.z - location.z };

  const depth = dot(rel, basis.forward);   // distance along optical axis (UE +X)
  const near = 1e-3;
  if (depth <= near) {
    return { x: NaN, y: NaN, ndcX: NaN, ndcY: NaN, depth, visible: false, behind: true };
  }

  const camRight = dot(rel, basis.right);
  const camUp = dot(rel, basis.up);

  // Horizontal FOV drives the X axis; vertical FOV follows the frame aspect (tan model,
  // exactly what a rectilinear render does: VFOV = 2*atan(tan(HFOV/2) / aspect)).
  const tanHalfH = Math.tan(hfovDeg * 0.5 * DEG2RAD);
  const aspect = width / height;
  const tanHalfV = tanHalfH / aspect;

  const ndcX = (camRight / depth) / tanHalfH;   // -1 = left edge, +1 = right edge
  const ndcY = (camUp / depth) / tanHalfV;       // -1 = bottom, +1 = top (Y up in NDC)

  const x = (ndcX * 0.5 + 0.5) * width;
  const y = (0.5 - ndcY * 0.5) * height;          // NDC Y up -> pixel Y down

  const visible = x >= 0 && x <= width && y >= 0 && y <= height;
  return { x, y, ndcX, ndcY, depth, visible, behind: false };
}

// Convenience: project many points with one camera. Returns array aligned to input.
export function projectPoints({ camera, points } = {}) {
  return (points || []).map((point) => projectWorldToPixel({ camera, point }));
}
