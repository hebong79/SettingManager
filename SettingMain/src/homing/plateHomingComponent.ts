import type { CameraConfig } from '../config/types.js';
import type { CameraDriver } from '../devices/cameraDriver.js';
import type { HomeTrace, HomeTraceStore } from './homeTraceStore.js';
import {
  PlateHomingJobRunner,
  type HomingOptions,
  type HomingStatus,
  type HomingStorePort,
} from './plateHomingJob.js';

/**
 * 번호판 호밍 컴포넌트의 **바깥 표면**. 라우트와 브리지 코어는 이것만 본다.
 *
 * `calibration/`·`centering/`·`vehiclebox/` 를 import 하지 않는다 — 아래로만 의존한다
 * (잡 · 다시보기 저장소 · 검출기 · 벤더 순수 계산). 세 컴포넌트가 서로를 안 부르는
 * 이 저장소의 규약을 그대로 따른다.
 */
export interface PlateHomingComponentOptions {
  runner: PlateHomingJobRunner;
  traces: HomeTraceStore;
  /** 카메라별 저장소를 만든다. 없으면 이 능력이 통째로 꺼진다. */
  storeFor?: (cameraId: string) => HomingStorePort;
  /** 검출기가 왜 없는지. 있으면 그 문장이 그대로 미지원 사유가 된다. */
  detectorReason?: () => string | undefined;
}

export class PlateHomingComponent {
  constructor(private readonly options: PlateHomingComponentOptions) {}

  isBusy(cameraId: string): boolean {
    return this.options.runner.isBusy(cameraId);
  }

  /**
   * 이 기기에서 호밍을 돌릴 수 있는가. **조건 셋이 다 필요하다.**
   *
   * 못 하면 사유를 사람 문장으로 돌려주고 `capabilities()` 가 그대로 화면에 싣는다 —
   * 버튼을 눌러 본 뒤에야 "검출기가 없습니다"를 알게 되는 것은 늦다.
   */
  support(camera: CameraConfig, driver: CameraDriver): { ok: true } | { ok: false; reason: string } {
    if (typeof driver.centerPoint !== 'function') {
      // 호밍은 픽셀을 찍어 그쪽으로 카메라를 보내는 일을 수십 번 반복한다. 그 원동력이 없으면
      // 계산 조준으로 흉내 낼 수는 있으나, 그때 재는 것은 우리 기하의 잔차이지 판의 위치가 아니다.
      return { ok: false, reason: `기기 ${camera.id} 의 드라이버는 픽셀 센터링을 지원하지 않아 호밍을 돌릴 수 없습니다` };
    }
    if (!this.options.storeFor) {
      return { ok: false, reason: '탐색 저장소가 배선되지 않았습니다 — 조준을 저장할 곳이 없습니다' };
    }
    const detector = this.options.detectorReason?.();
    if (detector) return { ok: false, reason: detector };
    return { ok: true };
  }

  async start(
    camera: CameraConfig,
    driver: CameraDriver,
    request: { presetId: string; pointIds?: string[] },
    options: HomingOptions = {},
  ): Promise<HomingStatus> {
    const support = this.support(camera, driver);
    if (!support.ok) throw new PlateHomingUnsupported(support.reason);
    // `support()` 가 이미 `storeFor` 존재를 확인했다 — 여기 `!` 는 그 게이트에 기댄다.
    return this.options.runner.start(camera, driver, this.options.storeFor!(camera.id), request, options);
  }

  status(cameraId: string): HomingStatus {
    return this.options.runner.status(cameraId);
  }

  stop(cameraId: string): HomingStatus {
    return this.options.runner.stop(cameraId);
  }

  /** 실패한 점을 **잡이 본 그대로** 다시 본다. 없으면 `null` — 오류가 아니다. */
  async trace(cameraId: string, presetId: string, pointId: string): Promise<HomeTrace | null> {
    return this.options.traces.read(cameraId, presetId, pointId);
  }

  async frame(cameraId: string, presetId: string, pointId: string, step: number): Promise<Buffer | null> {
    return this.options.traces.frame(cameraId, presetId, pointId, step);
  }
}

export class PlateHomingUnsupported extends Error {
  readonly statusCode = 501;
  constructor(reason: string) {
    super(reason);
    this.name = 'PlateHomingUnsupported';
  }
}
