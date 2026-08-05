import type { CenterPoint } from '../../devices/cameraDriver.js';
import { waitForSettle, type SettleOptions } from '../../devices/waitForSettle.js';
import { toView } from '../../domain/ptz.js';
import {
  CoreBusyError,
  CoreUnsupportedError,
  type CalibrationStartOptions,
  type CenterBox,
  type CenterResult,
  type CoreCapabilities,
  type CoreCapabilityName,
  type CoreContext,
  type CoreProvider,
  type DiscoveryPointPort,
  type DiscoveryPresetPort,
  type JobPort,
  type PlateHomingStartOptions,
} from '../coreProvider.js';
import { CameraLeaseError, CameraLeaseRegistry } from './cameraLease.js';

/**
 * SettingManager 자체 코어 구현 — 구성도의 **Bridge Backend-Core**.
 *
 * **backend-core 를 호출하지 않는다** — 선택된 카메라의 드라이버만 쓴다.
 * 아직 못 하는 것은 조용히 원격으로 흘려보내지 않고 **501 확정 답**으로 거절한다.
 * 무엇을 할 수 있는지는 `capabilities()` 가 미리 말하므로 화면은 못 하는 버튼을 비활성으로 그린다.
 *
 * 구현 단계 (docs/20260803_141528_BackendCore_대체컴포넌트_설계서.md §5.2)
 *   1단계 ✅ 센터링 · 카메라별 점유
 *   2단계 ⏳ CalibrationComponent
 *   3단계 ⏳ PlateHomingComponent · DetectorClient
 */

const NOT_YET = (capability: CoreCapabilityName, what: string): never => {
  throw new CoreUnsupportedError(capability, `브리지 코어는 아직 ${what}을(를) 지원하지 않습니다 — 옵션에서 코어 구현을 backend-core 로 바꾸면 쓸 수 있습니다`);
};

export interface BridgeCoreProviderOptions {
  leases?: CameraLeaseRegistry;
  settleOptions?: SettleOptions;
}

export class BridgeCoreProvider implements CoreProvider {
  readonly name = 'bridge' as const;
  private readonly leases: CameraLeaseRegistry;
  private readonly settleOptions?: SettleOptions;

  constructor(options: BridgeCoreProviderOptions = {}) {
    this.leases = options.leases ?? new CameraLeaseRegistry();
    this.settleOptions = options.settleOptions;
  }

  async capabilities(ctx: CoreContext): Promise<CoreCapabilities> {
    const canCenter = typeof ctx.driver.centerPoint === 'function';
    return {
      provider: this.name,
      cameraId: ctx.camera.id,
      busy: this.leases.isBusy(ctx.camera.id),
      supported: {
        center: canCenter ? { ok: true } : { ok: false, reason: '이 카메라 드라이버는 픽셀 센터링을 지원하지 않습니다' },
        centerBox: { ok: false, reason: '브리지 코어는 아직 영역(박스) 센터링을 지원하지 않습니다' },
        discoveryPresets: { ok: false, reason: '브리지 코어는 아직 탐색 프리셋 저장소를 갖고 있지 않습니다' },
        discoveryPoints: { ok: false, reason: '브리지 코어는 아직 탐색 점 저장소를 갖고 있지 않습니다' },
        calibration: { ok: false, reason: '브리지 코어는 아직 캘리브레이션을 지원하지 않습니다 (2단계 예정)' },
        plateHoming: { ok: false, reason: '브리지 코어는 아직 번호판 호밍을 지원하지 않습니다 (3단계 예정)' },
        // 아래 둘은 실행 표면(포트)조차 없다 — 계약이 확정되면 포트와 함께 켠다.
        vehicleBox: { ok: false, reason: '브리지 코어는 아직 차량 3D 육면체 관리를 지원하지 않습니다' },
        slotCreate: { ok: false, reason: '브리지 코어는 아직 주차면 생성을 지원하지 않습니다' },
      },
    };
  }

  /** 클릭한 점을 화면 중앙으로. 드라이버가 직접 하고, 멈출 때까지 기다린 좌표를 답한다. */
  async center(ctx: CoreContext, point: CenterPoint): Promise<CenterResult> {
    const centerPoint = ctx.driver.centerPoint;
    if (!centerPoint) throw new CoreUnsupportedError('center', '이 카메라 드라이버는 픽셀 센터링을 지원하지 않습니다');

    const release = this.acquire(ctx.camera.id);
    try {
      await centerPoint.call(ctx.driver, point);
      const settle = await waitForSettle(ctx.driver, this.settleOptions);
      return { cameraId: ctx.camera.id, point, ptz: toView(settle.ptz), settled: settle.settled };
    } finally {
      release();
    }
  }

  async centerBox(_ctx: CoreContext, _box: CenterBox): Promise<CenterResult> {
    return NOT_YET('centerBox', '영역(박스) 센터링');
  }


  readonly discoveryPresets: DiscoveryPresetPort = {
    list: async () => NOT_YET('discoveryPresets', '탐색 프리셋 조회'),
    create: async () => NOT_YET('discoveryPresets', '탐색 프리셋 생성'),
    update: async () => NOT_YET('discoveryPresets', '탐색 프리셋 수정'),
    remove: async () => NOT_YET('discoveryPresets', '탐색 프리셋 삭제'),
    goto: async () => NOT_YET('discoveryPresets', '탐색 프리셋 이동'),
  };

  readonly discoveryPoints: DiscoveryPointPort = {
    list: async () => NOT_YET('discoveryPoints', '탐색 점 조회'),
    create: async () => NOT_YET('discoveryPoints', '탐색 점 생성'),
    update: async () => NOT_YET('discoveryPoints', '탐색 점 수정'),
    remove: async () => NOT_YET('discoveryPoints', '탐색 점 삭제'),
  };

  readonly calibration: JobPort<CalibrationStartOptions> = {
    start: async () => NOT_YET('calibration', '캘리브레이션'),
    status: async () => NOT_YET('calibration', '캘리브레이션'),
    stop: async () => NOT_YET('calibration', '캘리브레이션'),
  };

  readonly plateHoming: JobPort<PlateHomingStartOptions> = {
    start: async () => NOT_YET('plateHoming', '번호판 호밍'),
    status: async () => NOT_YET('plateHoming', '번호판 호밍'),
    stop: async () => NOT_YET('plateHoming', '번호판 호밍'),
  };

  /** 같은 카메라의 동시 작업만 막는다. 다른 카메라는 서로 간섭하지 않는다. */
  private acquire(cameraId: string): () => void {
    try {
      return this.leases.acquire(cameraId);
    } catch (error) {
      if (error instanceof CameraLeaseError) throw new CoreBusyError(cameraId, error.message);
      throw error;
    }
  }
}
