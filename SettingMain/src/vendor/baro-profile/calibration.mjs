// Camera calibration solver — turns a click sweep into this camera's two curves.
//
// A calibration SAMPLE is one click: park the camera, snapshot, click a pixel off-centre,
// snapshot again, and find where the clicked content actually landed. From that we recover
// two focal lengths, by two independent routes:
//
//   f_fw   — the focal the FIRMWARE believes it has. Read straight off the telemetry (the
//            pan/tilt it chose for the click). Vertical clicks give it cleanly; horizontal
//            clicks carry the gimbal's spherical coupling. Needs no image at all.
//
//   f_true — the focal of the actual IMAGE. Recovered with no firmware model whatsoever: take
//            the measured before/after PTZ and the measured landing pixel, and fit the one f
//            that makes the 3D rotation explain the observed pixel motion.
//
// The aiming error is then not a mystery but a ratio: the camera mis-rotates by exactly
// f_fw/f_true, which shows up as a residual LINEAR IN ECCENTRICITY — the "worse the farther
// from centre" an operator sees. The same ratio is the fix (pre-scale the clicked offset by
// it), and f_true is the curve we must DRAW with.
//
// Conventions match ./fov-convert.mjs: panpos+ = clockwise (azimuth
// = -pan), tiltpos+ = camera looks down (elevation = -tilt).

const DEG = Math.PI / 180;
const CX = 960;
const CY = 540;
const HALF_W = 960;

// A match this weak is the scene failing us (sky, blank asphalt), not the camera missing.
export const MIN_PEAK = 0.6;
// ...and a match can score beautifully while pointing at the wrong repeat of the same texture.
// Measured on a real frame: a 0.898 match whose rival lobe 10px away scored 0.897. Both the
// reference OpenCV implementation and ours picked a lobe, and both were wrong. The score said
// nothing; this margin said everything. Every unambiguous sample in that sweep cleared 0.04.
export const MIN_MARGIN = 0.02;

function basis(panCd, tiltCd) {
  const a = -(panCd / 100) * DEG;
  const e = -(tiltCd / 100) * DEG;
  const F = [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)];
  const rn = Math.hypot(F[0], F[1]) || 1;
  const R = [F[1] / rn, -F[0] / rn, 0];
  const U = [R[1] * F[2] - R[2] * F[1], R[2] * F[0] - R[0] * F[2], R[0] * F[1] - R[1] * F[0]];
  return { F, R, U };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Where SHOULD the clicked content land, if the image focal is f? Uses measured PTZ only —
// the firmware's model never enters, which is what makes f_true an independent estimate.
export function predictLanding(sample, f) {
  const b0 = basis(sample.ptzBefore.panpos, sample.ptzBefore.tiltpos);
  const b1 = basis(sample.ptzAfter.panpos, sample.ptzAfter.tiltpos);
  const ux = (sample.clickX - CX) / f;
  const uy = -(sample.clickY - CY) / f;
  const ray = [0, 1, 2].map((i) => b0.F[i] + b0.R[i] * ux + b0.U[i] * uy);
  const t = dot(ray, b1.F);
  if (t <= 1e-9) return null;                       // rotated behind the camera
  return { x: CX + f * (dot(ray, b1.R) / t), y: CY - f * (dot(ray, b1.U) / t) };
}

// Median, not mean — one anchor whose focal fit blew up must not drag the summary with it.
// That is the whole reason this statistic exists next to the max (see `residual` below).
function median(values) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return NaN;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

// Reject the two ways a sample lies: a weak template match, and a PTZ readback that disagrees
// with the move it was asked to make (settle returned mid-motion). A click on the horizontal
// centreline must not throw the image vertically, and vice versa — a large cross-axis residual
// means the matcher locked onto the wrong thing.
export function usableSamples(samples) {
  return samples.filter((s) => {
    if (!Number.isFinite(s.landedX) || !(s.peak >= MIN_PEAK)) return false;
    // margin is absent on sweeps collected before ambiguity checking existed — those samples
    // are still usable, they just carry the older, weaker guarantee.
    if (s.margin !== undefined && !(s.margin >= MIN_MARGIN)) return false;
    if (s.dx && Math.sign(s.dpanCd || s.dx) !== Math.sign(s.dx)) return false;
    if (s.dy && Math.sign(s.dtiltCd || s.dy) !== Math.sign(s.dy)) return false;
    if (s.dy === 0 && Math.abs(s.residualY) > 40) return false;
    if (s.dx === 0 && Math.abs(s.residualX) > 40) return false;
    return true;
  });
}

// Golden-section search: the cost is unimodal in f and one parameter is all we are fitting.
function minimize(cost, lo = 400, hi = 400000, iterations = 220) {
  const gr = (Math.sqrt(5) - 1) / 2;
  let a = hi - gr * (hi - lo);
  let b = lo + gr * (hi - lo);
  let fa = cost(a);
  let fb = cost(b);
  for (let i = 0; i < iterations; i++) {
    if (fa < fb) {
      hi = b; b = a; fb = fa;
      a = hi - gr * (hi - lo); fa = cost(a);
    } else {
      lo = a; a = b; fa = fb;
      b = lo + gr * (hi - lo); fb = cost(b);
    }
  }
  const f = (lo + hi) / 2;
  return { f, rms: cost(f) };
}

// The image's true focal: the single f whose 3D rotation explains where everything landed.
export function fitTrueFocal(samples) {
  const usable = usableSamples(samples);
  if (usable.length < 3) return null;
  const cost = (f) => {
    let total = 0;
    let n = 0;
    for (const s of usable) {
      const p = predictLanding(s, f);
      if (!p) continue;
      total += (p.x - s.landedX) ** 2 + (p.y - s.landedY) ** 2;
      n++;
    }
    return n ? Math.sqrt(total / n) : Infinity;
  };
  return { ...minimize(cost), n: usable.length };
}

// The focal the FIRMWARE used, from telemetry alone. Horizontal clicks carry the 1/cos(tilt)
// gimbal coupling; vertical ones do not. The two agreeing is the proof the firmware runs
// correct rectilinear + spherical geometry (and at which focal).
export function firmwareFocal(samples) {
  const h = [];
  const v = [];
  for (const s of samples) {
    const cosTilt = Math.cos((s.ptzBefore.tiltpos / 100) * DEG);
    if (s.dy === 0 && s.dx && s.dpanCd && Math.sign(s.dpanCd) === Math.sign(s.dx)) {
      h.push(Math.abs(s.dx) / (Math.tan(Math.abs(s.dpanCd / 100) * DEG) * cosTilt));
    }
    if (s.dx === 0 && s.dy && s.dtiltCd && Math.sign(s.dtiltCd) === Math.sign(s.dy)) {
      v.push(Math.abs(s.dy) / Math.tan(Math.abs(s.dtiltCd / 100) * DEG));
    }
  }
  const stat = (vals) => {
    if (!vals.length) return null;
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = vals.length > 1
      ? Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length)
      : 0;
    return { f: m, sd, n: vals.length };
  };
  return { pan: stat(h), tilt: stat(v) };
}

// The fraction of the clicked offset the camera leaves behind. No model in between: this is
// simply what the operator sees. Median, because one bad match should not move it.
export function undershootSlope(samples) {
  const gs = [];
  for (const s of samples) {
    if (s.dx) gs.push(s.residualX / s.dx);
    if (s.dy) gs.push(s.residualY / s.dy);
  }
  if (!gs.length) return null;
  gs.sort((a, b) => a - b);
  const mid = gs.length >> 1;
  const g = gs.length % 2 ? gs[mid] : (gs[mid - 1] + gs[mid]) / 2;
  return { g, n: gs.length };
}

export const hfovFromFocal = (f) => (2 * Math.atan(HALF_W / f)) / DEG;

// One zoom level's worth of samples -> that zoom's calibration point.
//
// The gain is taken from the RESIDUAL SLOPE, not from f_fw/f_true. Both are measured, and they
// agree, but the slope is what the operator actually experiences and it degrades gracefully:
// a single bad focal fit cannot swing it. gainApplied lets a *verification* pass (run with the
// current calibration switched on) recover the true gain: g = 1 - k_applied/k_true.
export function solveZoom(samples, { gainApplied = 1, minSamples = 2 } = {}) {
  const usable = usableSamples(samples);
  const slope = usable.length >= minSamples ? undershootSlope(usable) : null;
  // The FOV needs a focal FIT (three landings minimum); the gain only needs the residual slope.
  // Keeping them separate matters: a verify pass asks only "how far off is it?", and refusing to
  // answer that because one sample out of three was a bad match would be pointless fussiness.
  const trueFit = fitTrueFocal(samples);
  const fw = firmwareFocal(samples);
  if (!slope) return null;

  const kTrue = slope.g < 0.9 ? gainApplied / (1 - slope.g) : null;
  const fwFocal = fw.tilt?.f ?? fw.pan?.f ?? null;

  return {
    zoom: samples[0].zoomAnchor,
    hfov: trueFit ? hfovFromFocal(trueFit.f) : null,   // what we DRAW with (needs the fit)
    gain: kTrue,                                       // what we AIM with (needs only the slope)
    focalTrue: trueFit ? trueFit.f : null,
    focalFirmware: fwFocal,
    residualSlope: slope.g,
    // How far a quarter-frame click actually missed by, IN THIS PASS. Read it against what the
    // pass was: a calibration sweep aims raw, so this is the error the camera has; a verify pass
    // aims through the installed correction, so this is the error that SURVIVES it. Same number,
    // opposite meanings — which is exactly why verify exists as a separate pass.
    residualPx: Math.abs(slope.g) * 480,
    // How well one focal explains every landing. This is the error bar on the fit itself: large
    // means the samples disagree with each other, and the curve should not be trusted.
    fitRmsPx: trueFit ? trueFit.rms : null,
    samples: usable.length,
    of: samples.length,
  };
}

// Whole sweep -> the two curves, ready to store on the device.
export function buildCalibration(samples, { gainApplied = () => 1, measuredAt } = {}) {
  const byZoom = new Map();
  for (const s of samples) {
    if (!byZoom.has(s.zoomAnchor)) byZoom.set(s.zoomAnchor, []);
    byZoom.get(s.zoomAnchor).push(s);
  }

  const points = [];
  const skipped = [];
  for (const [zoom, rows] of [...byZoom.entries()].sort((a, b) => a[0] - b[0])) {
    const p = solveZoom(rows, { gainApplied: gainApplied(zoom) });
    // A stored curve needs BOTH numbers at every anchor. A zoom where the scene gave us the
    // aiming slope but not a focal fit cannot be an anchor — it would leave a hole in the FOV
    // curve that interpolation would paper over with a guess.
    if (p && p.gain > 0 && p.hfov) points.push(p);
    else skipped.push({ zoom, usable: usableSamples(rows).length, of: rows.length });
  }
  if (points.length < 2) {
    throw new Error(`캘리브레이션에 쓸 수 있는 줌 지점이 ${points.length}개뿐입니다 — 장면에 특징이 부족하거나(하늘·빈 아스팔트) 카메라가 정착하지 못했습니다. 차량·주차선처럼 무늬가 있는 쪽을 향하게 두고 다시 시도하세요.`);
  }

  return {
    zoomHfov: points.map((p) => ({ z: p.zoom, h: Number(p.hfov.toFixed(2)) })),
    centeringGain: points.map((p) => ({ z: p.zoom, k: Number(p.gain.toFixed(3)) })),
    measuredAt: measuredAt || undefined,
    residual: {
      // What this camera was doing BEFORE the curves below existed — the size of the problem
      // just measured. It is NOT what remains afterwards; only a verify pass can say that, and
      // conflating the two would let a calibration congratulate itself.
      beforePx: Number(Math.max(...points.map((p) => p.residualPx)).toFixed(1)),
      // Worst disagreement between the samples and the single focal fitted to them. This is a
      // MAX over anchors, not an average of the sweep — one noisy anchor sets it on its own.
      fitRmsPx: Number(Math.max(...points.map((p) => p.fitRmsPx)).toFixed(1)),
      // What the TYPICAL anchor did. The pair is the point: `fitRmsPx` alone cannot tell "one
      // anchor was noisy" from "the model does not describe this camera", and those call for
      // opposite responses (publish and note it / re-measure). cam-real-002's first sweep read
      // 67.3 worst while ten of its eleven anchors sat between 2.9 and 9.1 — a publish gate
      // reading only the max refused a good sweep and said the model had failed. (2026-08-05)
      fitRmsMedianPx: Number(median(points.map((p) => p.fitRmsPx)).toFixed(1)),
      anchors: points.length,
      byZoom: Object.fromEntries(points.map((p) => [p.zoom, Number(p.residualPx.toFixed(1))])),
      byZoomFitRms: Object.fromEntries(points.map((p) => [p.zoom, Number(p.fitRmsPx.toFixed(1))])),
    },
    // Zooms the scene refused to give up. Reported, never hidden: the curve is only as good as
    // its coverage, and an operator deserves to know which part of the zoom range is a guess.
    skipped,
    points,
  };
}
