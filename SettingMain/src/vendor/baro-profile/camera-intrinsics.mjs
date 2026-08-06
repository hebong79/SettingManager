// Camera intrinsics: zoom position -> horizontal FOV (degrees).
//
// This is the SINGLE JS source for the zoom->HFOV mapping — the browser overlay and
// node and the browser (served at /profile/) both use this one copy in @baro/profile,
// so the "camera math must not drift" rule holds. The UE side keeps a C++ mirror in
// HucomsProtocol.h::ZoomPosToHFov — keep the two in sync if the calibration changes.
//
// Table is the field-calibrated cam-001 curve; LINEAR interpolation between points.
// wideHFovDeg lets a different lens scale the whole curve proportionally (1x = wide).
//
// Re-measured 2026-07-14 (tools/centering_calib). The previous four anchors
// (69.88 / 35.36 / 23.30 / 1.94) were derived under the assumption that the camera maps
// pixels to angles LINEARLY — an assumption the firmware itself turned out not to hold — so
// the wide end was 22% too wide. These values come from fitting the one focal length that
// explains the observed pixel motion under the measured PTZ rotation, which needs no model
// of the firmware at all; a second, independent estimate off the telemetry agrees to ~0.5%.
//
// Two features of the real lens the old table could not express:
//   * it SATURATES at z≈16384 (2.39°) — zooming past that changes nothing, so the curve is
//     held flat beyond the last anchor rather than extrapolated toward zero, and
//   * its FOV HALVES between z15000 and z16384, which a coarse interpolation would smear
//     into a lie. Hence the dense anchors through that band.
//
// This is the DISPLAY/reprojection curve (overlays, homedPixel, view wedges). It is a
// different axis from CENTERING_GAIN_TABLE below (which corrects AIMING) — do not conflate
// them. Keep in sync with the C++ mirror, HucomsProtocol.h::ZoomPosToHFov.
export const ZOOM_HFOV_TABLE = [
  { z: 0, h: 57.14 },
  { z: 2000, h: 47.89 },
  { z: 3000, h: 43.37 },
  { z: 5129, h: 34.05 },
  { z: 8000, h: 22.59 },
  { z: 10338, h: 14.68 },
  { z: 12161, h: 9.77 },
  { z: 14000, h: 6.29 },
  { z: 15000, h: 4.88 },
  { z: 15400, h: 4.32 },
  { z: 15800, h: 3.74 },
  { z: 16100, h: 3.16 },
  { z: 16384, h: 2.39 },
];

// Vertical FOV for a rectilinear (tan-pinhole) image at a given horizontal FOV.
// This is the DISPLAY relationship ("조준은 선형, 표시는 tan") — a tan lens has no
// constant VFOV/HFOV ratio (0.614 at wide → 0.570 at 28.4°), so never replace this
// with a linear ratio like the aiming model's vfov/hfov (≈0.436) or a single-zoom
// measurement (0.53): both are linear-model numbers and wrong for drawing.
const DEG = Math.PI / 180;
export function vfovFromHfov(hfovDeg, frameWidth = 1920, frameHeight = 1080) {
  if (!(hfovDeg > 0)) throw new Error("vfovFromHfov: hfovDeg must be positive.");
  return 2 * Math.atan(Math.tan((hfovDeg / 2) * DEG) * (frameHeight / frameWidth)) / DEG;
}

// Piecewise-linear read of a [{z, <key>}] curve, clamped at both ends (never extrapolated —
// past the last anchor the real lens saturates, and below the first there is nothing).
function sampleCurve(table, key, z, scale = 1) {
  const zz = Math.min(Math.max(Number(z) || 0, table[0].z), table[table.length - 1].z);
  for (let i = 0; i < table.length - 1; i++) {
    if (zz <= table[i + 1].z) {
      const f = (zz - table[i].z) / (table[i + 1].z - table[i].z);
      return (table[i][key] + f * (table[i + 1][key] - table[i][key])) * scale;
    }
  }
  return table[table.length - 1][key] * scale;
}

// zoompos -> horizontal FOV (deg). `table` is that camera's measured curve; it defaults to the
// built-in cam-001 one so every existing caller keeps working, but a second camera with a
// different lens must pass its own (see resolveIntrinsics / devices.list[].intrinsics).
// wideHFovDeg additionally scales the whole curve — that is how the UE sim reuses this shape.
export function hfovFromZoomPos(zoomPos, wideHFovDeg, table = ZOOM_HFOV_TABLE) {
  const wide = wideHFovDeg === undefined ? table[0].h : wideHFovDeg;
  if (!(wide > 0)) throw new Error("hfovFromZoomPos: wideHFovDeg must be positive.");
  return sampleCurve(table, "h", zoomPos, wide / table[0].h);
}

// ---------------------------------------------------------------------------
// Centering gain — the fix for "the farther from center I click, the more it misses".
//
// Measured 2026-07-14 on cam-001 (HNR-2036LA) with tools/centering_calib, 105 samples
// over 7 zooms and 4 tilts. What the sweep found:
//
//   * The setcenter firmware is NOT the naive linear model we long assumed. It runs exact
//     rectilinear geometry — the focal it implies from a pan sweep and from a tilt sweep
//     agree to 0.1%, and the pan focal stays constant across tilt 6°..33°, which is only
//     possible if it already applies the 1/cos(tilt) gimbal coupling. Its geometry is right.
//   * What is wrong is the CONSTANT: the focal the firmware believes it has drifts away
//     from the lens's real focal as it zooms in. f_fw/f_true is ~0.99 at wide but climbs to
//     ~1.11 from z8000 up, so the camera under-rotates by ~10% there.
//
// A scale error in focal is a scale error in eccentricity, which is exactly the reported
// symptom (fine near the middle, ~10% short at the edges; invisible at wide zoom).
//
// The correction is exact rather than approximate, because firmware and lens are both tan
// and differ by nothing but that focal scale:
//
//     atan(k*dx / f_fw)  ==  atan(dx / f_true)   iff   k = f_fw / f_true
//
// so pre-scaling the clicked offset by k(zoom) cancels the error at EVERY eccentricity and
// EVERY tilt — no closed loop, no extra round trip, no per-position error table.
//
// Device-specific by nature: this is one camera's factory calibration, not a Hucoms trait.
// The UE simulator answers setcenter from the same table it renders with, so its gain is 1
// and it must be left alone. Opt in per device (config devices.list[].centeringGain).
//
// The curve is NOT monotone, and that matters: the firmware's zoom->focal model tops out
// around z16384 (focal ~34,950px) while the lens keeps closing to ~45,000px, so past that
// point the camera believes it sees WIDER than it does and OVER-rotates. k flips below 1
// there (measured -33% overshoot at z22000 with no correction). Homing's close-up zoom is
// 22000, squarely in that region — a table that just held ~1.11 to the long end would make
// the tele error worse, not better. Anchors are dense through the 15000..16384 transition
// because the lens's FOV halves across that band and a coarse interpolation would lie.
export const CENTERING_GAIN_TABLE = [
  { z: 0, k: 0.988 },
  { z: 2000, k: 1.053 },
  { z: 3000, k: 1.071 },
  { z: 5129, k: 1.090 },
  { z: 8000, k: 1.110 },
  { z: 10338, k: 1.111 },
  { z: 12161, k: 1.113 },
  { z: 14000, k: 1.110 },
  { z: 15000, k: 1.106 },
  { z: 15400, k: 1.075 },
  { z: 15800, k: 1.050 },
  { z: 16100, k: 0.935 },
  { z: 16384, k: 0.765 },
  { z: 22000, k: 0.750 },
];

// ---------------------------------------------------------------------------
// Per-camera intrinsics.
//
// Both curves above belong to ONE physical camera, not to Hucoms and not to the model line.
// A second camera with a different lens has a different zoom->FOV curve, and its firmware's
// belief about that lens drifts differently, so it has a different gain curve too.
//
// What IS shared across units of the same model+firmware is the SHAPE: the firmware's internal
// zoom table is code, identical in every unit, so the gain a unit needs is
//   k(z) = f_firmware(z) / f_thisLens(z)
// and only the denominator varies. How much it varies is UNMEASURED — we have exactly one real
// camera. Until a second unit is swept, treat the built-in preset as a *starting point* that a
// commissioning measurement confirms or replaces (tools/centering_calib, or the in-app
// calibration job). The preset is opt-in per device precisely so it is never applied blind.
export const CAMERA_CALIBRATIONS = {
  "cam-001": {
    label: "HNR-2036LA (cam-001 실측 2026-07-14)",
    zoomHfov: ZOOM_HFOV_TABLE,
    centeringGain: CENTERING_GAIN_TABLE,
  },
  // UE 시뮬레이터. 렌더가 이 곡선의 C++ 미러(HucomsProtocol.h::ZoomPosToHFov)를 쓰므로
  // 광학은 cam-001 과 같지만, setcenter 를 **자기가 렌더한 표 그대로** 답하기 때문에
  // 보정할 펌웨어 상수가 없다 — 게인은 1(= 없음)이고 그대로 두어야 한다.
  // 이 항목이 있어야 시뮬이 "선언 없는 기기"의 기본 폴백에 얹히지 않는다.
  "ue-sim": {
    label: "UE 시뮬 렌더 광학 (cam-001 곡선 · 조준 보정 없음)",
    zoomHfov: ZOOM_HFOV_TABLE,
    centeringGain: null,
  },
};

function normCurve(rows, key, name) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`${name} must be a non-empty [{z, ${key}}] table.`);
  }
  for (const p of rows) {
    if (!Number.isFinite(Number(p?.z)) || !(Number(p?.[key]) > 0)) {
      throw new Error(`${name} entries must be { z: number, ${key}: positive number }.`);
    }
  }
  return rows.map((p) => ({ z: Number(p.z), [key]: Number(p[key]) })).sort((a, b) => a.z - b.z);
}

// spec: a preset name ("cam-001"), a measured object { zoomHfov?, centeringGain?, ... },
// or null/undefined = this camera has no calibration (aim raw, draw with the default curve).
// A measured object may also name a preset to inherit from and override only what it measured.
export function resolveIntrinsics(spec) {
  if (!spec) return { zoomHfov: ZOOM_HFOV_TABLE, centeringGain: null, source: "none" };

  const preset = (name) => {
    const p = CAMERA_CALIBRATIONS[name];
    if (!p) {
      const known = Object.keys(CAMERA_CALIBRATIONS).join(", ") || "(none)";
      throw new Error(`Unknown camera calibration "${name}". Known: ${known}.`);
    }
    return p;
  };

  if (typeof spec === "string") {
    const p = preset(spec);
    return { zoomHfov: p.zoomHfov, centeringGain: p.centeringGain, source: spec, label: p.label };
  }
  // Legacy shape: intrinsics used to be just the aiming curve (devices.list[].centeringGain).
  if (Array.isArray(spec)) {
    return { zoomHfov: ZOOM_HFOV_TABLE, centeringGain: normCurve(spec, "k", "centeringGain"), source: "measured" };
  }
  if (typeof spec !== "object") {
    throw new Error("intrinsics must be a calibration name, a measured object, or absent.");
  }

  const base = spec.model ? preset(spec.model) : null;
  const zoomHfov = spec.zoomHfov
    ? normCurve(spec.zoomHfov, "h", "intrinsics.zoomHfov")
    : (base ? base.zoomHfov : ZOOM_HFOV_TABLE);
  const gain = spec.centeringGain
    ? normCurve(spec.centeringGain, "k", "intrinsics.centeringGain")
    : (base ? base.centeringGain : null);

  return {
    zoomHfov,
    centeringGain: gain,
    source: spec.zoomHfov || spec.centeringGain ? "measured" : (spec.model || "none"),
    label: spec.label || (base ? base.label : undefined),
    measuredAt: spec.measuredAt,
    residual: spec.residual,
  };
}

export function centeringGain(zoomPos, table) {
  if (!table || table.length === 0) return 1;
  return sampleCurve(table, "k", zoomPos);
}

// Pre-scale a click so the firmware's own (miscalibrated) setcenter lands on it.
// Past the frame edge the corrected point would leave the 0..1920/0..1080 range setcenter
// accepts; we clamp and report it, so the caller knows this click could only be corrected
// partway (an absolute goptzfpos move is the way out for those, if it ever matters).
export function applyCenteringGain({ x, y, zoomPos, table, frameWidth = 1920, frameHeight = 1080 } = {}) {
  const k = centeringGain(zoomPos, table);
  const cx = frameWidth / 2;
  const cy = frameHeight / 2;
  const ax = cx + (Number(x) - cx) * k;
  const ay = cy + (Number(y) - cy) * k;
  const sx = Math.min(Math.max(Math.round(ax), 0), frameWidth);
  const sy = Math.min(Math.max(Math.round(ay), 0), frameHeight);
  return { x: sx, y: sy, k, clamped: sx !== Math.round(ax) || sy !== Math.round(ay) };
}
