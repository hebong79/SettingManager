import { clampAxis, wrapPan, type PtzRaw } from '../domain/ptz.js';
import type { CameraDriver } from '../devices/cameraDriver.js';
import type { CameraConfig, CameraIntrinsics } from '../config/types.js';
import { aimDelta, type AimPoint } from './aimChain.js';

/**
 * 소프트웨어 픽셀 센터링 — **하드웨어에 없는 능력을 계산으로 계약까지 끌어올린다.**
 *
 * 근거: baro_calory `packages/cctv-client/src/software-centering.mjs`.
 *
 * ```
 * 절대 PTZ 만 있는 기기  ──(pixelToPtzDelta 주입)──▶  픽셀 센터링 계약 충족
 * ```
 *
 * 이 저장소의 구체적 수요는 **`park3d-rpc`** 다 — `centerPoint` 가 없어 센터링이 아예 안 된다.
 * 미지원으로 닫는 대신, 리퍼런스가 쓰는 기하를 그대로 주입해 채운다.
 *
 * ## 순환측정이 아닌 이유
 *
 * 캘리브레이션이 재야 할 대상은 **"운영에서 실제로 조준할 사슬"** 이다. 이 기기의 사슬이 우리
 * 기하라면, 캘리브레이션이 재는 것은 그 기하가 가정한 화각과 실제 렌즈의 차이 — 즉 이 기기의
 * 광학이고, 그것이 정확히 그 산출물이다. 조준 사슬이 우리 코드이므로 **상쇄할 펌웨어 오차가
 * 없고**(게인 ≡ 1 에서 출발), 남는 것은 우리 화각 가정의 잔차뿐이다.
 */

export class SoftwareCenteringError extends Error {
  constructor(message: string, readonly statusCode = 422) {
    super(message);
    this.name = 'SoftwareCenteringError';
  }
}

/**
 * 이 기기에 소프트웨어 센터링을 세울 수 있는가. **성립 조건이 곧 게이트다.**
 * 세울 수 없으면 사유를 사람 문장으로 돌려준다(`capabilities()` 가 그대로 화면에 싣는다).
 */
export function softwareCenteringGate(camera: CameraConfig, driver: CameraDriver): { ok: true } | { ok: false; reason: string } {
  const intrinsics = camera.intrinsics;
  // 화각을 모르면 클릭 픽셀을 각도로 바꿀 수 없다. 기본(cam-001) 곡선을 갖다 쓰면 다른 렌즈·
  // 다른 줌 눈금에서 **조용히 엉뚱한 곳을 조준한다.**
  if (!intrinsics?.zoomHfov?.length) {
    return {
      ok: false,
      reason: `기기 ${camera.id} 의 실측 줌→화각 표가 없습니다 — intrinsics.zoomHfov 를 채우거나(POST /api/profiles/camera/${camera.id}) 캘리브레이션을 돌리십시오`,
    };
  }

  /**
   * 표가 기기 줌 범위를 **덮어야** 한다. 벤더 `hfovFromZoomPos` 는 표 밖에서 끝값으로
   * 클램프하므로, 부분 표를 통과시키면 표 밖 줌에서 조용한 오조준이 된다
   * (상류 리뷰 확정: 1점짜리 x1 표 + x12 줌 = **12배 과회전**).
   *
   * 범위를 모르는 기기는 통과 — 자기 범위를 선언하는 드라이버에만 물을 수 있는 질문이다.
   */
  const range = driver.zoomRange;
  if (range) {
    const zs = intrinsics.zoomHfov.map((point) => point.z);
    const lo = Math.min(...zs);
    const hi = Math.max(...zs);
    if (lo > range.min || hi < range.max) {
      return {
        ok: false,
        reason: `기기 ${camera.id} 의 zoomHfov 표(${lo}~${hi})가 기기 줌 범위(${range.min}~${range.max})를 덮지 않습니다 — 표 밖 줌에서 조용한 오조준이 됩니다`,
      };
    }
  }
  return { ok: true };
}

export interface SoftwareCenterOutcome {
  from: PtzRaw;
  target: PtzRaw;
  /** 틸트가 도달범위에 걸려 **부분적으로만** 갔는가. 삼키면 착지 어긋남이 무표시가 된다. */
  clamped: boolean;
  hfovDeg: number;
}

/**
 * 보정된 픽셀을 절대 이동으로 옮긴다. **호출자가 `goPtz` 한다** — 이 함수는 계산만 하고
 * 카메라를 만지지 않으므로 목 없이 테스트된다.
 *
 * ## 틸트는 계약 수준에서 자른다
 *
 * 와이어 클램프에만 맡기면 두 가지가 조용해진다 — 부분 클램프의 착지 어긋남이 무표시가 되고,
 * **전량 클램프(수평 카메라에서 수직 중앙선 위 클릭)는 무이동이라 정착 대기가 10초를 매달린 뒤
 * 원인 불명 502 가 된다.** 후자는 여기서, 지금, 사람 문장으로 거절한다.
 */
export function planSoftwareCenter(pixel: AimPoint, current: PtzRaw, intrinsics: CameraIntrinsics): SoftwareCenterOutcome {
  const delta = aimDelta(pixel, current, intrinsics);
  const wantTilt = Math.round(current.tilt + delta.tiltDelta);
  const target: PtzRaw = {
    pan: wrapPan(current.pan + delta.panDelta),
    tilt: clampAxis('tilt', wantTilt),
    // 센터링은 조준만 바꾼다 — 줌은 건드리지 않는다(박스 줌은 별개의 동작이다).
    zoom: current.zoom,
  };
  const clamped = target.tilt !== wantTilt;

  if (clamped && target.pan === current.pan && target.tilt === current.tilt) {
    throw new SoftwareCenteringError(
      `조준점이 이 기기의 틸트 도달범위 밖입니다 — 카메라가 그 방향으로 움직일 수 없습니다 (요청 ${wantTilt}cd, 도달 가능 ${clampAxis('tilt', -1e9)}~${clampAxis('tilt', 1e9)}cd)`,
    );
  }
  return { from: current, target, clamped, hfovDeg: delta.hfovDeg };
}
