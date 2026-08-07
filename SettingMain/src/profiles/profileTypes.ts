import type { CameraIntrinsics } from '../config/types.js';

/**
 * 카메라 프로파일 문서 — **발행본의 형식**.
 *
 * 근거: baro_calory `profiles/camera/cam-real-001/rev-0001.camprof.json` 실물과
 * `docs/calibration.md` §프로파일 생명주기 정책. 형식을 우리 취향으로 다시 짜지 않은 이유는
 * 이 문서가 **외부 소비자의 진실의 출처**이기 때문이다 — 필드를 개명하면 저쪽 도구가 못 읽는다.
 *
 * ## 이 문서가 답해야 하는 것
 *
 * 숫자만 있으면 안 된다. **"이 값을 어떻게 얻었는가"** 가 함께 있어야 한다 —
 * 재지 않은 값이 실측처럼 보이면 없느니만 못하다. 그래서 `quality.method` 와
 * `quality.samples` 가 광학과 같은 문서 안에 산다.
 */

export const PROFILE_SPEC_VERSION = '1.0.0';
export const PROFILE_KIND = 'baro.camera-profile';

/** 이 곡선이 어떻게 생겼는가. 복사의 복사를 지나도 **최초 실측 기기**를 가리킨다. */
export type ProfileMethod = 'sweep' | 'import' | 'copy';

export interface ProfileOptics {
  interpolation: 'piecewise-linear';
  /** 표 밖은 **외삽하지 않는다** — 실제 렌즈는 양 끝에서 포화한다. */
  extrapolation: 'clamp';
  zoomHfov: Array<{ z: number; h: number }>;
  /** 게인이 없는 기기(기하학적으로 정확한 시뮬)는 `null` 이며 그대로 두어야 한다. */
  centeringGain: Array<{ z: number; k: number }> | null;
}

export interface ProfileQuality {
  measuredAt?: string;
  /** `click-sweep.zncc.v1` · `import` · `copy` 중 하나. */
  method: string;
  samples?: { usable: number; of: number };
  residual?: {
    beforePx: number;
    fitRmsPx: number;
    /** 발행 게이트가 **판정에 쓰는 값**. 옛 측정본에는 없다. */
    fitRmsMedianPx?: number;
    byZoom?: Record<string, number>;
    byZoomFitRms?: Record<string, number>;
  };
  skipped?: Array<{ zoom: number; usable: number; of: number; why?: string }>;
  /**
   * 검증 패스 결과. **늘 `null` 이다** — 리비전이 불변이라 발행 후 되쓸 수 없다.
   * 자리를 비워 두는 것이 정직하다(상류 §6 미해결 그대로).
   */
  verify: null;
  /** 게이트를 우회해 발행했다면 그 사유가 여기 배열로 박힌다. 나중에 읽는 사람이 안다. */
  forced?: string[];
  note?: string;
}

export interface CameraProfile {
  specVersion: string;
  kind: typeof PROFILE_KIND;
  profileId: string;
  revision: number;
  /** 이 리비전이 대체한 번호. 정정은 덮어쓰기가 아니라 **새 리비전**이다. */
  supersedes: number | null;
  issuedAt: string;
  issuer: { tool: string; version: string };
  /** 이 문서로 할 수 있는 일. `project`(월드 투영)는 외부 측량이 있어야 붙는다. */
  capabilities: string[];
  /**
   * 기기 정보. **곡선은 렌즈의 성질이지만 그 곡선을 색인하는 눈금은 프로토콜의 성질이다** —
   * 그래서 복사는 광학만 옮기고 이 블록은 대상 기기 등록 정보로 새로 찍는다.
   */
  device: {
    type: string;
    frame: { width: number; height: number };
    ptzRange: { pan: [number, number]; tilt: [number, number]; zoom: [number, number] };
  };
  provenance: {
    method: ProfileMethod;
    /** **최초로 실측한 기기.** 복사본에서도 원본을 가리킨다. */
    measuredOn: string;
    note?: string;
  };
  optics: ProfileOptics;
  extrinsic: {
    /** 설치 측량은 이 서비스가 하지 않는다 — 없는 것을 있는 척하지 않는다. */
    status: 'unsurveyed';
    mount: null;
    note: string;
  };
  quality: ProfileQuality;
}

/** 발행본 → 런타임이 물고 도는 광학. 문서의 나머지는 런타임이 보지 않는다. */
export function opticsOf(profile: CameraProfile): CameraIntrinsics {
  return {
    zoomHfov: profile.optics.zoomHfov.map((p) => ({ z: p.z, h: p.h })),
    ...(profile.optics.centeringGain ? { centeringGain: profile.optics.centeringGain.map((p) => ({ z: p.z, k: p.k })) } : {}),
  };
}
