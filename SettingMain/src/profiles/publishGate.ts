import type { ProfileQuality } from './profileTypes.js';

/**
 * 발행 게이트 — **파국은 막고, 우회는 흔적을 남긴다.**
 *
 * 근거: baro_calory `docs/calibration.md` §3 발행 게이트. 상류의 `publishGateFailures()` 와
 * 같은 판정을 한다.
 *
 * ## 이 값들은 품질을 증명하는 기준이 아니다
 *
 * 스윕이 아직 둘뿐이라(cam-real-001·002) 타이트한 임계는 **없는 지식을 있는 척하는 것**이 된다.
 * 여기서 거르는 것은 "이 스윕은 설명되지 않았다"는 파국뿐이고, 스윕이 쌓이면 조인다.
 *
 * ## 왜 최댓값이 아니라 중앙값인가 (2026-08-05 상류 실측)
 *
 * `residual.fitRmsPx` 는 앵커별 **최댓값**이라 앵커 하나가 시끄러우면 그것만으로 상한을 넘는다.
 * cam-real-002 의 첫 실측이 그랬다 — 열한 앵커 중 열이 2.9~9.1px 인데 z=12161 하나가 67.3px
 * 였고, 게이트는 그것을 *"모델이 이 스윕을 설명하지 못했습니다"* 라고 답했다. 사실이 아니었다
 * (중앙값 5.8px 로 cam-real-001 의 6.0 보다 좋다).
 *
 * **중앙값을 넘는다는 것은 앵커의 절반 이상이 나쁘다는 뜻**이고, 그때야 그 문장이 참이 된다.
 * 최댓값은 판정에서 빼되 **보고에는 남긴다** — 어느 앵커를 다시 재야 하는지는 그 값이 가리킨다.
 */

/** cam-real-001 이 6.0, cam-real-002 가 5.8 이었다. 파국은 그 몇 배 위에서 시작한다. */
export const MAX_FIT_RMS_PX = 20;
/** rev-0001 실측이 69/112 = 62% 였다. */
export const MIN_USABLE_RATIO = 0.5;

export interface GateFailure {
  /** 사람 문장. 그대로 화면에 뜨고 `quality.forced` 에 박힌다. */
  reason: string;
  metric: 'fitRms' | 'usableRatio';
}

/**
 * 미달 사유 전부. 비어 있으면 통과다.
 *
 * **판단 근거가 없으면 막지 않는다** — 옛 감사본에는 `residual` 이 아예 없다.
 * 모르는 것을 미달로 취급하면 되살릴 수 있는 측정이 영영 발행되지 못한다.
 */
export function publishGateFailures(quality: ProfileQuality): GateFailure[] {
  const failures: GateFailure[] = [];
  const residual = quality.residual;

  if (residual) {
    // 중앙값이 없는 옛 측정본은 최댓값으로 판정하되 **그 사실이 문구에 드러난다** —
    // 같은 숫자를 두 가지 뜻으로 쓰면 다음 사람이 또 속는다.
    const median = residual.fitRmsMedianPx;
    const value = median ?? residual.fitRmsPx;
    const isMedian = median !== undefined;
    if (Number.isFinite(value) && value > MAX_FIT_RMS_PX) {
      failures.push({
        metric: 'fitRms',
        reason: isMedian
          ? `초점 적합 중앙값이 ${value.toFixed(1)}px 로 상한 ${MAX_FIT_RMS_PX}px 을 넘습니다 — 앵커의 절반 이상이 나쁘다는 뜻이고, 이 스윕은 모델로 설명되지 않았습니다`
          : `초점 적합 ${value.toFixed(1)}px 이 상한 ${MAX_FIT_RMS_PX}px 을 넘습니다 (중앙값이 없는 옛 측정본이라 **앵커별 최댓값**으로 판정했습니다 — 앵커 하나만 시끄러워도 걸립니다)`,
      });
    }
  }

  const samples = quality.samples;
  if (samples && samples.of > 0) {
    const ratio = samples.usable / samples.of;
    if (ratio < MIN_USABLE_RATIO) {
      failures.push({
        metric: 'usableRatio',
        reason: `쓸 수 있는 표본이 ${samples.usable}/${samples.of} (${Math.round(ratio * 100)}%) 로 하한 ${Math.round(MIN_USABLE_RATIO * 100)}% 에 못 미칩니다 — 장면에 무늬가 부족하거나(하늘·빈 아스팔트) 너무 어두웠습니다`,
      });
    }
  }

  return failures;
}

/** 다시 재야 할 앵커. 게이트에 걸렸을 때 **무엇을** 고칠지 가리킨다. */
export function noisyAnchors(quality: ProfileQuality, limit = 5): Array<{ zoom: number; fitRmsPx: number }> {
  const byZoom = quality.residual?.byZoomFitRms;
  if (!byZoom) return [];
  return Object.entries(byZoom)
    .map(([zoom, fitRmsPx]) => ({ zoom: Number(zoom), fitRmsPx: Number(fitRmsPx) }))
    .filter((row) => Number.isFinite(row.fitRmsPx) && row.fitRmsPx > MAX_FIT_RMS_PX)
    .sort((a, b) => b.fitRmsPx - a.fitRmsPx)
    .slice(0, limit);
}
