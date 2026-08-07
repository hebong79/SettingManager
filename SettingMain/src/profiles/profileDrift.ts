import type { CameraIntrinsics } from '../config/types.js';
import type { CameraProfile } from './profileTypes.js';

/**
 * 발행본과 런타임 적용본이 어긋났는가.
 *
 * 근거: baro_calory `docs/calibration.md` §5 재측정은 사람이 결정한다.
 *
 * ## 서버는 "어긋났다"고 말하는 데까지만 한다
 *
 * 자동으로 재측정하지 않고 잡을 막지도 않는다 — 카메라를 수십 분 점유하는 결정은 **사람의 턴**이다.
 * 그리고 일치하거나 발행본이 없으면 **조용하다.** 늘 떠 있는 경고는 아무도 읽지 않는다.
 *
 * ## 대조의 분모는 발행본이다
 *
 * 재는 것은 "정본을 기준으로 런타임이 얼마나 벗어났는가"다. 반대로 잡으면 같은 수치가
 * 다른 뜻이 되고, 어느 쪽이 정본인지가 코드에서 사라진다.
 *
 * ## 왜 이 검사가 필요했나 (상류 2026-08-04 실사)
 *
 * 칼리브레이션이 디스크 **7곳**에 살고, 한 렌즈의 화각 곡선이 **3겹**이었으며 그중 둘이 이미
 * 달랐다(z=5129 에서 2.30%). 증상이 없는 것이 이 병의 성질이다 — 조준도 되고 화각도 답한다,
 * **틀린 숫자로.**
 */

export interface CurveDrift {
  curve: 'zoomHfov' | 'centeringGain';
  /** 가장 크게 벌어진 앵커. 어디를 봐야 하는지 가리킨다. */
  worst: { z: number; published: number; runtime: number; percent: number } | null;
  /** 발행본에 있는데 런타임에 없는(또는 그 반대) 앵커. 값이 아니라 **모양**이 다른 경우다. */
  shapeChanged: boolean;
}

export interface ProfileDrift {
  cameraId: string;
  /** 대조한 리비전. */
  revision: number;
  drifted: boolean;
  curves: CurveDrift[];
  /** 사람 문장. 콘솔 경고와 `GET /api/profiles/...` 응답이 같은 문장을 쓴다. */
  message: string;
}

/** 이보다 작은 차이는 보고하지 않는다 — 반올림(발행본은 소수 2자리)에서 오는 잔차다. */
const TOLERANCE_PERCENT = 0.5;

/**
 * 어긋났으면 보고, 아니면 `null`.
 *
 * **에이전트도 본다** — 로그에만 있으면 사람만 보는데, 그 값으로 계산하는 것은 에이전트도
 * 마찬가지다(상류가 `GET /api/help` 라이브 블록에 실은 이유).
 */
export function profileDrift(cameraId: string, published: CameraProfile | null, runtime: CameraIntrinsics | undefined): ProfileDrift | null {
  if (!published) return null;
  // 발행본은 있는데 런타임이 비어 있다 — 발행이 적용을 건너뛴 상태다(`apply:false` 또는 옛 발행).
  if (!runtime) {
    return {
      cameraId,
      revision: published.revision,
      drifted: true,
      curves: [],
      message: `기기 ${cameraId} 는 프로파일 rev-${published.revision} 이 발행돼 있으나 런타임이 그 값을 물고 있지 않습니다 — POST /api/profiles/camera/${cameraId}/apply 로 적용하십시오`,
    };
  }

  const curves: CurveDrift[] = [
    compare('zoomHfov', published.optics.zoomHfov, runtime.zoomHfov, 'h'),
    compare('centeringGain', published.optics.centeringGain, runtime.centeringGain, 'k'),
  ];
  const drifted = curves.some((c) => c.shapeChanged || (c.worst && Math.abs(c.worst.percent) >= TOLERANCE_PERCENT));
  if (!drifted) return null;

  const detail = curves
    .filter((c) => c.shapeChanged || (c.worst && Math.abs(c.worst.percent) >= TOLERANCE_PERCENT))
    .map((c) => (c.shapeChanged
      ? `${c.curve} 의 앵커 구성이 다릅니다`
      : `${c.curve} 이(가) z=${c.worst!.z} 에서 ${c.worst!.percent.toFixed(2)}% 어긋납니다 (발행 ${c.worst!.published} · 런타임 ${c.worst!.runtime})`))
    .join(' · ');

  return {
    cameraId,
    revision: published.revision,
    drifted: true,
    curves,
    message: `기기 ${cameraId} 의 런타임 광학이 발행본 rev-${published.revision} 과 다릅니다 — ${detail}. 재측정 여부는 사람이 정합니다(카메라를 수십 분 점유합니다)`,
  };
}

function compare<K extends 'h' | 'k'>(
  curve: CurveDrift['curve'],
  published: ReadonlyArray<{ z: number } & Record<K, number>> | null | undefined,
  runtime: ReadonlyArray<{ z: number } & Record<K, number>> | null | undefined,
  key: K,
): CurveDrift {
  // 둘 다 없으면 어긋난 것이 아니다 — 게인이 없는 기기(기하학적으로 정확한 시뮬)의 정상 상태다.
  if (!published?.length && !runtime?.length) return { curve, worst: null, shapeChanged: false };
  if (!published?.length || !runtime?.length) return { curve, worst: null, shapeChanged: true };

  const runtimeByZ = new Map(runtime.map((p) => [p.z, p[key]]));
  if (published.length !== runtime.length || published.some((p) => !runtimeByZ.has(p.z))) {
    return { curve, worst: null, shapeChanged: true };
  }

  let worst: CurveDrift['worst'] = null;
  for (const point of published) {
    const runtimeValue = runtimeByZ.get(point.z)!;
    const publishedValue = point[key];
    if (publishedValue === 0) continue;
    const percent = ((runtimeValue - publishedValue) / publishedValue) * 100;
    if (!worst || Math.abs(percent) > Math.abs(worst.percent)) {
      worst = { z: point.z, published: publishedValue, runtime: runtimeValue, percent };
    }
  }
  return { curve, worst, shapeChanged: false };
}
