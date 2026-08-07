import type { GrayFrame } from './frameDecode.js';

/**
 * 클릭한 내용은 **어디에 떨어졌는가.**
 *
 * 캘리브레이션에는 카메라가 줄 수 없는 측정이 하나 있다 — `setcenter` 가 움직인 뒤, 우리가
 * 클릭한 그것이 새 프레임의 어디에 있는가. before 프레임의 클릭 주변 패치를 잘라 after 프레임의
 * **중앙 근처**(제대로 됐다면 거기 있어야 한다)에서 찾아 답한다.
 *
 * 상류 `apps/backend-core/src/frame-match.mjs` 의 TypeScript 이식이다.
 * **알고리즘을 개선하지 않았다** — 아래 하나하나가 상류가 실측으로 피 흘려 얻은 것이고,
 * "더 나은" 변형은 그 교훈을 되돌리는 일이 되기 쉽다.
 *
 * ## 왜 ZNCC 인가
 * 두 스냅샷 사이에 **노출이 변한다.** 단순 SSD 는 내용이 아니라 밝기를 쫓는다.
 * 영평균 정규화 상관이라야 그 변화에 둔감하다.
 *
 * ## 왜 coarse → fine 인가
 * 1/4 축소로 위치를 잡고 전해상도로 확정한 뒤 상관 봉우리에 포물선을 맞춰 **서브픽셀**까지
 * 간다. 우리가 재는 신호 전체가 겨우 수십 픽셀 폭이라 그 정밀도가 곧 결과의 정밀도다.
 *
 * ## `margin` 이 `peak` 보다 중요하다 (이 파일의 핵심)
 * 높은 상관 점수는 **확신 있는 위치가 아니다.** 울타리·난간·주차선은 여러 오프셋에서 자기와
 * ~0.9 로 상관되고, 그 비슷비슷한 로브 중 누가 1등인지는 잡음이 정한다. 실측 프레임에서
 * 봉우리 0.898 옆 10px 에 0.897 이 있었고 — **레퍼런스 OpenCV 구현과 상류 구현이 둘 다 로브를
 * 골랐고 둘 다 ~10px 틀렸다.** 점수는 아무것도 말하지 않았고 마진이 전부를 말했다
 * (그 스윕의 모호하지 않은 샘플은 전부 0.04 를 넘겼다).
 */

const FRAME_W = 1920;
const FRAME_H = 1080;

export interface MatchResult {
  /** 착지 지점. **논리 1920×1080 좌표**라 클릭한 픽셀과 직접 비교된다. */
  landedX: number;
  landedY: number;
  /** ZNCC 점수. ~0.6 아래면 붙잡을 것이 없었다는 뜻이다. */
  peak: number;
  /** 봉우리가 차순위 로브보다 얼마나 높은가. ~0.02 아래면 위치는 동전 던지기다. */
  margin: number;
  /**
   * 패치의 RMS 대비(그레이 레벨). **매칭이 실패하는 두 방식을 가른다** —
   * 대비가 높은데 점수가 낮으면 장면이 반복적이거나 카메라가 정착하지 않은 것이고,
   * 대비가 낮으면 영상에 애초에 아무것도 없다(빈 벽, 야간 20배 줌).
   * 처방이 다르다: 하나는 아침에 다시 오면 되고 하나는 카메라를 다른 쪽으로 돌려야 한다.
   */
  contrast: number;
}

export class FrameMatchError extends Error {
  constructor(message: string) {
    super(`프레임 매칭: ${message}`);
    this.name = 'FrameMatchError';
  }
}

export interface LocateOptions {
  clickX: number;
  clickY: number;
  half?: number;
  search?: number;
  step?: number;
}

export function locateClicked(before: GrayFrame, after: GrayFrame, options: LocateOptions): MatchResult {
  const { clickX, clickY, half = 48, search = 320, step = 4 } = options;
  const { data: b, width: w, height: h } = before;
  const sx = w / FRAME_W;
  const sy = h / FRAME_H;

  // 클릭 주변 패치. 가장자리를 클릭했으면 프레임 안쪽으로 밀어 넣는다.
  const px = Math.min(Math.max(Math.round(clickX * sx), half), w - half - 1);
  const py = Math.min(Math.max(Math.round(clickY * sy), half), h - half - 1);
  const size = half * 2;

  // 탐색창은 **프레임 중앙 주변**이다 — 올바른 setcenter 라면 거기 놓였을 자리다.
  const ccx = Math.round((FRAME_W / 2) * sx);
  const ccy = Math.round((FRAME_H / 2) * sy);
  const x0 = Math.max(0, ccx - search - half);
  const y0 = Math.max(0, ccy - search - half);
  const x1 = Math.min(w, ccx + search + half);
  const y1 = Math.min(h, ccy + search + half);
  const winW = x1 - x0;
  const winH = y1 - y0;
  if (winW < size || winH < size) throw new FrameMatchError('탐색창이 패치보다 작습니다');

  // 거친 단계: 창 전체를 1/4 로.
  const coarsePatch = downsample(b, w, px - half, py - half, size, size, step);
  const coarseWin = downsample(after.data, w, x0, y0, winW, winH, step);
  const coarse = correlate(coarseWin.data, coarseWin.width, coarseWin.height, coarsePatch.data, coarsePatch.width, coarsePatch.height);
  if (coarse.width <= 0 || coarse.height <= 0) throw new FrameMatchError('거친 단계 탐색창이 너무 작습니다');

  const patch = crop(b, w, px - half, py - half, size, size);
  const contrast = zeroMean(patch).norm / Math.sqrt(patch.length);
  const candidates = topCandidates(coarse.surface, coarse.width, coarse.height, 3, Math.round(half / step));
  if (candidates.length === 0) throw new FrameMatchError('쓸 수 있는 상관 봉우리가 없습니다');

  // 세밀 단계: 후보마다 전해상도로. 창을 거친 단계가 요구하는 것보다 **일부러 넓게** 잡는다 —
  // 무늬 반복 하나 거리(~8~20px)의 경쟁 로브를 볼 수 있어야 하고, 이 착지를 믿어도 되는지를
  // 정하는 것은 점수가 아니라 바로 그 경쟁자이기 때문이다.
  const pad = 24;
  let winner: MatchResult | null = null;
  for (const candidate of candidates) {
    const guessX = x0 + candidate.x * step;
    const guessY = y0 + candidate.y * step;
    const fx0 = Math.max(0, Math.min(guessX - pad, w - size - 1));
    const fy0 = Math.max(0, Math.min(guessY - pad, h - size - 1));
    const fw = Math.min(size + pad * 2, w - fx0);
    const fh = Math.min(size + pad * 2, h - fy0);
    const fine = correlate(crop(after.data, w, fx0, fy0, fw, fh), fw, fh, patch, size, size);
    if (fine.width <= 0 || fine.height <= 0) continue;
    const peak = peakOf(fine.surface, fine.width, fine.height);
    if (!winner || peak.peak > winner.peak) {
      winner = {
        // 봉우리 위치 → 패치 좌상단 → 패치 중심 → 논리 프레임 좌표로 되돌린다.
        landedX: (fx0 + peak.x + half) / sx,
        landedY: (fy0 + peak.y + half) / sy,
        peak: peak.peak,
        margin: sidelobeMargin(fine.surface, fine.width, fine.height, peak.x, peak.y, 8),
        contrast,
      };
    }
  }
  if (!winner) throw new FrameMatchError('쓸 수 있는 상관 봉우리가 없습니다');
  return winner;
}

/** 두 프레임의 치수가 다르면 비교 자체가 성립하지 않는다. */
export function assertSameSize(before: GrayFrame, after: GrayFrame): void {
  if (before.width !== after.width || before.height !== after.height) {
    throw new FrameMatchError(`두 스냅샷의 크기가 다릅니다 (${before.width}×${before.height} vs ${after.width}×${after.height})`);
  }
}

// --- 내부 --------------------------------------------------------------------

/**
 * `step` 배 상자평균. 싸고, 축소 패치를 상관하기 전에 하고 싶은 바로 그 일이다 —
 * 세밀 단계가 잘못 물고 늘어질 센서 잡음을 눌러 준다.
 */
function downsample(src: Uint8Array, w: number, x0: number, y0: number, w0: number, h0: number, step: number): { data: Float32Array; width: number; height: number } {
  const dw = Math.floor(w0 / step);
  const dh = Math.floor(h0 / step);
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y += 1) {
    for (let x = 0; x < dw; x += 1) {
      let sum = 0;
      const sy = y0 + y * step;
      const sx = x0 + x * step;
      for (let j = 0; j < step; j += 1) {
        const row = (sy + j) * w;
        for (let i = 0; i < step; i += 1) sum += src[row + sx + i]!;
      }
      out[y * dw + x] = sum / (step * step);
    }
  }
  return { data: out, width: dw, height: dh };
}

function crop(src: Uint8Array | Float32Array, w: number, x0: number, y0: number, cw: number, ch: number): Float32Array {
  const out = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y += 1) {
    const row = (y0 + y) * w + x0;
    for (let x = 0; x < cw; x += 1) out[y * cw + x] = src[row + x]!;
  }
  return out;
}

function zeroMean(a: Float32Array): { data: Float32Array; norm: number } {
  let mean = 0;
  for (let i = 0; i < a.length; i += 1) mean += a[i]!;
  mean /= a.length;
  let ss = 0;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i += 1) {
    out[i] = a[i]! - mean;
    ss += out[i]! * out[i]!;
  }
  return { data: out, norm: Math.sqrt(ss) };
}

/** `patch` 를 `win` 안의 모든 위치와 ZNCC. 상관 표면을 돌려준다. */
function correlate(win: Float32Array, ww: number, wh: number, patch: Float32Array, pw: number, ph: number): { surface: Float32Array; width: number; height: number } {
  const p = zeroMean(patch);
  const outW = ww - pw + 1;
  const outH = wh - ph + 1;
  const surface = new Float32Array(Math.max(0, outW * outH));
  if (outW <= 0 || outH <= 0 || p.norm < 1e-6) return { surface, width: outW, height: outH };

  for (let oy = 0; oy < outH; oy += 1) {
    for (let ox = 0; ox < outW; ox += 1) {
      let sum = 0;
      let sumSq = 0;
      let cross = 0;
      for (let y = 0; y < ph; y += 1) {
        const wrow = (oy + y) * ww + ox;
        const prow = y * pw;
        for (let x = 0; x < pw; x += 1) {
          const v = win[wrow + x]!;
          sum += v;
          sumSq += v * v;
          cross += v * p.data[prow + x]!;
        }
      }
      const n = pw * ph;
      const varSum = sumSq - (sum * sum) / n; // == Σ(w - μw)²
      const denom = Math.sqrt(Math.max(varSum, 0)) * p.norm;
      // p 가 영평균이므로 cross 는 이미 Σ((w-μw)(p-μp)) 와 같다.
      surface[oy * outW + ox] = denom > 1e-6 ? cross / denom : 0;
    }
  }
  return { surface, width: outW, height: outH };
}

function peakOf(surface: Float32Array, w: number, h: number): { x: number; y: number; peak: number } {
  let best = -Infinity;
  let bx = 0;
  let by = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const v = surface[y * w + x]!;
      if (v > best) {
        best = v;
        bx = x;
        by = y;
      }
    }
  }
  // 봉우리와 이웃을 지나는 포물선 → 서브픽셀 오프셋.
  const at = (x: number, y: number): number => surface[y * w + x]!;
  const sub = (a: number, b: number, c: number): number => {
    const d = a - 2 * b + c;
    return Math.abs(d) < 1e-9 ? 0 : (0.5 * (a - c)) / d;
  };
  const ox = bx > 0 && bx < w - 1 ? sub(at(bx - 1, by), best, at(bx + 1, by)) : 0;
  const oy = by > 0 && by < h - 1 ? sub(at(bx, by - 1), best, at(bx, by + 1)) : 0;
  return { x: bx + ox, y: by + oy, peak: best };
}

/**
 * **거친 단계의 1등은 제안이지 판결이 아니다.** 주차선과 난간은 반복되므로 축소 표면에
 * 비슷한 로브가 여럿 설 수 있고, 1/4 에서의 1등이 전해상도의 1등이라는 보장이 없다.
 * 상위 몇을 (충분히 떨어뜨려 진짜 다른 로브가 되게) 들고 가 전해상도가 고르게 한다.
 */
function topCandidates(surface: Float32Array, w: number, h: number, count: number, minSeparation: number): Array<{ x: number; y: number; peak: number }> {
  const taken: Array<{ x: number; y: number; peak: number }> = [];
  const scratch = Float32Array.from(surface);
  for (let k = 0; k < count; k += 1) {
    let best = -Infinity;
    let bx = -1;
    let by = -1;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const v = scratch[y * w + x]!;
        if (v > best) {
          best = v;
          bx = x;
          by = y;
        }
      }
    }
    if (bx < 0 || best === -Infinity) break;
    taken.push({ x: bx, y: by, peak: best });
    for (let y = Math.max(0, by - minSeparation); y < Math.min(h, by + minSeparation + 1); y += 1) {
      for (let x = Math.max(0, bx - minSeparation); x < Math.min(w, bx + minSeparation + 1); x += 1) {
        scratch[y * w + x] = -Infinity;
      }
    }
  }
  return taken;
}

/** 이긴 봉우리가 나머지보다 얼마나 높은가. 이 값이 착지를 믿어도 되는지를 정한다. */
function sidelobeMargin(surface: Float32Array, w: number, h: number, peakX: number, peakY: number, radius: number): number {
  let side = -Infinity;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (Math.hypot(x - peakX, y - peakY) < radius) continue;
      const v = surface[y * w + x]!;
      if (v > side) side = v;
    }
  }
  return side === -Infinity ? 1 : surface[Math.round(peakY) * w + Math.round(peakX)]! - side;
}
