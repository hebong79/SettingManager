import { waitForSettle, type SettleOptions } from '../devices/waitForSettle.js';
import { clampPtz, toView, type PtzView } from '../domain/ptz.js';
import type { CameraDriver, CenterPoint } from '../devices/cameraDriver.js';
import type { CameraConfig } from '../config/types.js';
import { hfovFromZoomPos } from '../vendor/baro-profile/index.mjs';
import { zoomPosForHfov } from './zoomTable.js';
import { FRAME, aimPixel, hfovForBox } from './aimChain.js';
import { SoftwareCenteringError, planSoftwareCenter, softwareCenteringGate } from './softwareCentering.js';

/**
 * 센터라이징 컴포넌트 — **클릭한 픽셀을 화면 중앙으로, 그리고 실제로 갔는지 말한다.**
 *
 * `calibration/`·`vehiclebox/` 를 import 하지 않는다. 게인 표는 **데이터로** 온다
 * (`camera.intrinsics.centeringGain`) — 그것을 누가 만들었는지 이 컴포넌트는 모르고,
 * 알 필요도 없다. 스윕으로 얻었든 손으로 넣었든 옆 카메라에서 복사했든 똑같이 동작한다.
 */

export interface CenteringBox {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export interface CenteringOutcome {
  cameraId: string;
  point?: CenterPoint;
  box?: CenteringBox;
  ptz: PtzView;
  settled: boolean;
  /** 펌웨어가 조준했는가(`firmware`), 우리가 계산해 절대 이동했는가(`software`). */
  centering: 'firmware' | 'software';
  /** 적용된 센터링 게인. **1 이면 보정이 없었다는 뜻이고, 그것도 사실이다.** */
  gain: number;
  /** 보정된 점이 프레임 밖이라 잘렸는가. */
  gainClamped?: boolean;
  /** 소프트웨어 조준에서 틸트 도달범위에 걸려 부분적으로만 갔는가. */
  tiltClamped?: boolean;
  target?: { pan: number; tilt: number; zoom: number };
}

export interface CenteringComponentOptions {
  settleOptions?: SettleOptions;
}

export class CenteringComponent {
  constructor(private readonly options: CenteringComponentOptions = {}) {}

  /**
   * 이 카메라에서 센터링이 되는가. 안 되면 **사유가 화면에 그대로 뜬다.**
   *
   * 사유가 두 겹인 것이 중요하다 — 드라이버에 펌웨어 픽셀 센터링이 없는 것은 **고칠 수 없는
   * 사실**이고, 화각표가 없는 것은 **사람이 채울 수 있는 것**이다. 앞의 것만 말하면 운영자는
   * 손쓸 수 없다고 읽고 포기한다.
   */
  centerSupport(camera: CameraConfig, driver: CameraDriver): { ok: true } | { ok: false; reason: string } {
    if (typeof driver.centerPoint === 'function') return { ok: true };
    const gate = softwareCenteringGate(camera, driver);
    if (gate.ok) return gate;
    return { ok: false, reason: `이 카메라 드라이버는 펌웨어 픽셀 센터링을 지원하지 않습니다 — 계산 조준으로 대신할 수 있으나 ${gate.reason}` };
  }

  /** 박스 줌은 하드웨어 기능이 아니라 **계산**이다 — 실측 화각표만 있으면 어느 기기에서든 선다. */
  boxSupport(camera: CameraConfig): { ok: true } | { ok: false; reason: string } {
    return camera.intrinsics?.zoomHfov?.length
      ? { ok: true }
      : {
          ok: false,
          reason: `기기 ${camera.id} 의 실측 줌→화각 표가 없습니다 — intrinsics.zoomHfov 를 채우거나(POST /api/profiles/camera/${camera.id}) 캘리브레이션을 돌리십시오`,
        };
  }

  /**
   * 클릭한 점을 화면 중앙으로.
   *
   * ```
   * 클릭 픽셀 ─▶ 게인 보정 ─▶ centerPoint 있나?
   *                              ├─ 예   → 펌웨어가 나머지를 한다
   *                              └─ 아니오 → 계산 조준 + 절대 이동
   *                                        ─▶ 정착 대기 ─▶ 착지 보고
   * ```
   */
  async center(camera: CameraConfig, driver: CameraDriver, point: CenterPoint): Promise<CenteringOutcome> {
    const current = await driver.getPtz();
    // ★ 여기가 살아 있던 결함을 고치는 자리다 — 예전에는 클릭 픽셀이 게인 없이 그대로 나갔다.
    const aimed = aimPixel(point, current.zoom, camera.intrinsics);

    if (typeof driver.centerPoint === 'function') {
      await driver.centerPoint({ x: aimed.x, y: aimed.y });
      const settle = await waitForSettle(driver, this.options.settleOptions);
      return {
        cameraId: camera.id,
        point,
        ptz: toView(settle.ptz),
        settled: settle.settled,
        centering: 'firmware',
        gain: aimed.k,
        ...(aimed.clamped ? { gainClamped: true } : {}),
      };
    }

    const gate = softwareCenteringGate(camera, driver);
    if (!gate.ok) throw new SoftwareCenteringError(gate.reason, 501);

    const plan = planSoftwareCenter({ x: aimed.x, y: aimed.y }, current, camera.intrinsics!);
    await driver.goPtz(plan.target);
    const settle = await waitForSettle(driver, this.options.settleOptions);
    return {
      cameraId: camera.id,
      point,
      ptz: toView(settle.ptz),
      settled: settle.settled,
      centering: 'software',
      gain: aimed.k,
      ...(aimed.clamped ? { gainClamped: true } : {}),
      ...(plan.clamped ? { tiltClamped: true } : {}),
      target: plan.target,
    };
  }

  /**
   * 드래그한 박스가 화면을 채우도록 조준 + 줌인. **순수 계산이다** — 하드웨어 박스줌을 쓰지 않는다.
   *
   *   ① 박스 중앙을 화면 중앙으로  →  게인 보정 + 짐벌 기하
   *   ② 박스가 프레임을 채울 화각  →  현재 화각 × max(박스폭/프레임폭, 박스높이/프레임높이)
   *   ③ 그 화각의 줌 눈금          →  실측 표 역보간
   *
   * ②에서 **큰 쪽**을 쓰는 이유는 작은 쪽을 쓰면 박스가 화면 밖으로 잘리기 때문이다.
   */
  async centerBox(camera: CameraConfig, driver: CameraDriver, box: CenteringBox): Promise<CenteringOutcome> {
    const intrinsics = camera.intrinsics;
    const support = this.boxSupport(camera);
    if (!support.ok || !intrinsics) throw new SoftwareCenteringError(support.ok ? '광학이 없습니다' : support.reason, 501);

    const width = Math.abs(box.endX - box.startX);
    const height = Math.abs(box.endY - box.startY);
    if (width < 1 || height < 1) {
      throw new SoftwareCenteringError('박스가 너무 작습니다 — 가로·세로가 각각 1픽셀 이상이어야 합니다', 400);
    }

    const current = await driver.getPtz();
    const hfov = hfovFromZoomPos(current.zoom, undefined, intrinsics.zoomHfov);
    const centre = { x: (box.startX + box.endX) / 2, y: (box.startY + box.endY) / 2 };
    const aimed = aimPixel(centre, current.zoom, intrinsics);
    const plan = planSoftwareCenter({ x: aimed.x, y: aimed.y }, current, intrinsics);

    const target = clampPtz({
      pan: plan.target.pan,
      tilt: plan.target.tilt,
      zoom: zoomPosForHfov(intrinsics, hfovForBox(hfov, width, height)),
    });
    await driver.goPtz(target);
    const settle = await waitForSettle(driver, this.options.settleOptions);
    return {
      cameraId: camera.id,
      box,
      ptz: toView(settle.ptz),
      settled: settle.settled,
      // 박스 줌은 팬·틸트·줌을 한 번에 절대 이동으로 낸다 — 펌웨어 센터링이 있는 기기에서도
      // 이 경로는 우리 계산이다(하드웨어 박스줌을 쓰지 않는다).
      centering: 'software',
      gain: aimed.k,
      ...(aimed.clamped ? { gainClamped: true } : {}),
      ...(plan.clamped ? { tiltClamped: true } : {}),
      target,
    };
  }
}

export { FRAME };
