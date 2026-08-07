import { PAN_RANGE, TILT_RANGE, ZOOM_RANGE } from '../domain/ptz.js';
import type { CameraConfig } from '../config/types.js';
import type { CameraDriver } from '../devices/cameraDriver.js';
import type { ProfileStore, PublishResult } from '../profiles/profileStore.js';
import type { CameraProfile } from '../profiles/profileTypes.js';
import { CalibrationError, CalibrationJobRunner, type CalibrationJobStatus, type CalibrationRunResult } from './calibrationJob.js';
import type { SweepMode } from './sweepPlan.js';

/**
 * 캘리브레이션 컴포넌트의 **바깥 표면**. 라우트와 브리지 코어는 이것만 본다.
 *
 * `centering/`·`vehiclebox/` 를 import 하지 않는다. 아래로만 의존한다 —
 * 잡(`calibrationJob`) · 프로파일 저장소(데이터 창구) · 벤더 순수 계산.
 */
export class CalibrationComponent {
  constructor(private readonly runner: CalibrationJobRunner, private readonly profiles: ProfileStore) {}

  isBusy(cameraId: string): boolean {
    return this.runner.isBusy(cameraId);
  }

  /**
   * 이 기기에서 스윕을 돌릴 수 있는가. **두 조건 다 필요하다.**
   *
   * 못 하면 사유를 사람 문장으로 돌려주고 `capabilities()` 가 그대로 화면에 싣는다 —
   * 버튼을 눌러 본 뒤에야 "ffmpeg 가 없습니다"를 알게 되는 것은 늦다.
   */
  async support(camera: CameraConfig, driver: CameraDriver): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (typeof driver.centerPoint !== 'function') {
      return {
        ok: false,
        // 클릭 스윕은 **펌웨어의 조준 오차**를 재는 것이라 펌웨어가 조준해야 한다. 계산 조준
        // (소프트웨어 센터링) 위에서 돌리면 우리 기하의 잔차를 재게 되는데, 그것은 다른 질문이다.
        reason: `기기 ${camera.id} 의 드라이버는 픽셀 센터링을 지원하지 않아 클릭 스윕을 돌릴 수 없습니다`,
      };
    }
    return this.runner.probeDecoder();
  }

  async start(camera: CameraConfig, driver: CameraDriver, mode: SweepMode): Promise<CalibrationJobStatus> {
    return this.runner.start(camera, driver, mode);
  }

  status(cameraId: string): CalibrationJobStatus {
    return this.runner.status(cameraId);
  }

  stop(cameraId: string): CalibrationJobStatus {
    return this.runner.stop(cameraId);
  }

  /**
   * 방금 끝난 full 스윕을 **발행한다.**
   *
   * 별도 동작인 이유가 둘이다.
   *   ① 게이트에 걸렸을 때 사람이 「그래도 발행」을 고를 여지가 있어야 한다.
   *   ② 스윕을 돌려 **보기만** 하고 발행하지 않을 수도 있다(다른 조명에서 다시 재려는 경우).
   * 스윕이 끝나자마자 자동 발행하면 둘 다 불가능해진다.
   */
  async mint(camera: CameraConfig, options: { apply?: boolean; force?: boolean } = {}): Promise<PublishResult> {
    const status = this.runner.status(camera.id);
    const result = status.result;
    if (!result || result.mode !== 'full') {
      throw new CalibrationError(
        '발행할 full 스윕 결과가 없습니다 — 먼저 POST /api/core/calibration/start {mode:"full"} 로 스윕을 끝내십시오',
        409,
      );
    }
    if (status.state !== 'done') {
      throw new CalibrationError(`스윕이 아직 ${status.state} 상태입니다 — 끝난 뒤에 발행하십시오`, 409);
    }

    return this.profiles.publish(camera.id, {
      optics: {
        interpolation: 'piecewise-linear',
        extrapolation: 'clamp',
        zoomHfov: result.zoomHfov,
        // 게인이 비면 `null` 이다 — 빈 배열로 두면 "재서 0개가 나왔다"와 "게인이 없다"가 섞인다.
        centeringGain: result.centeringGain.length ? result.centeringGain : null,
      },
      device: {
        type: camera.kind,
        frame: { width: 1920, height: 1080 },
        ptzRange: {
          pan: [PAN_RANGE[0], PAN_RANGE[1]],
          tilt: [TILT_RANGE[0], TILT_RANGE[1]],
          zoom: [ZOOM_RANGE[0], ZOOM_RANGE[1]],
        },
      },
      provenance: { method: 'sweep', measuredOn: camera.id },
      quality: qualityOf(result),
      apply: options.apply,
      force: options.force,
    });
  }
}

/**
 * 스윕 결과 → 문서의 `quality` 블록.
 *
 * **`residual.beforePx` 는 보정 전 오차다.** 문서에 그 사실을 문장으로 박아 둔다 — 숫자만
 * 남기면 다음 사람이 "보정 후 남은 오차"로 읽고, 그러면 캘리브레이션이 자기 자신을 축하하게 된다.
 */
function qualityOf(result: Extract<CalibrationRunResult, { mode: 'full' }>): CameraProfile['quality'] {
  return {
    measuredAt: result.measuredAt,
    method: 'click-sweep.zncc.v1',
    samples: { usable: result.usable, of: result.of },
    residual: {
      beforePx: result.residual.beforePx,
      fitRmsPx: result.residual.fitRmsPx,
      fitRmsMedianPx: result.residual.fitRmsMedianPx,
      byZoom: result.residual.byZoom,
      byZoomFitRms: result.residual.byZoomFitRms,
    },
    skipped: result.skipped,
    // 리비전이 불변이라 발행 후 검증 결과를 되쓸 수 없다. 비워 두는 것이 정직하다.
    verify: null,
    note: `residual.beforePx(${result.residual.beforePx}px)는 **보정 전** 조준 오차입니다 — 보정 후 남는 오차가 아닙니다. 그것은 verify 패스만 말할 수 있습니다.`,
  };
}
