import type { CenterPoint } from '../../devices/cameraDriver.js';
import { waitForSettle, type SettleOptions } from '../../devices/waitForSettle.js';
import { clampPtz, toView, type PtzRaw } from '../../domain/ptz.js';
import type { StoredPtz } from '../../store/discoveryStore.js';
import type { DiscoveryDbStore } from '../../db/discoveryDbStore.js';
import type { SpotDbStore } from '../../db/spotDbStore.js';
import type { CalibrationComponent } from '../../calibration/calibrationComponent.js';
import { CenteringComponent } from '../../centering/centeringComponent.js';
import { VehicleBoxComponent } from '../../vehiclebox/vehicleBoxComponent.js';
import {
  CoreBusyError,
  CoreNotFoundError,
  CoreUnsupportedError,
  type CalibrationStartOptions,
  type CenterBox,
  type CenterResult,
  type CoreCapabilities,
  type CoreCapabilityName,
  type CoreCapabilityState,
  type CoreContext,
  type CoreProvider,
  type DiscoveryPointPort,
  type DiscoveryPresetPort,
  type JobPort,
  type JobStatus,
  type ParkingSlotPort,
  type PlateHomingStartOptions,
  type VehicleBoxPort,
} from '../coreProvider.js';
import { CameraLeaseError, CameraLeaseRegistry } from './cameraLease.js';

/**
 * SettingManager 자체 코어 구현 — 구성도의 **Bridge Backend-Core**.
 *
 * **backend-core 를 호출하지 않는다.** 아직 못 하는 것은 조용히 원격으로 흘려보내지 않고
 * **501 확정 답**으로 거절한다.
 *
 * ## 이 파일은 이제 조립만 한다 (2026-08-07)
 *
 * 캘리브레이션·센터라이징·차량 3D 육면체는 각각 **독립 컴포넌트**로 나갔다
 * (`src/calibration/` · `src/centering/` · `src/vehiclebox/`). 셋은 서로를 import 하지 않고,
 * 여기는 그것들을 코어 포트 모양으로 **옮겨 담기만** 한다. 그래서 이 파일에는 기하도 없고
 * 이미지 처리도 없다 — 그런 것이 다시 여기 들어오면 컴포넌트 경계가 무너진 것이다.
 *
 * 여기 남은 것: 탐색 프리셋·점 · 주차면(스팟) · 카메라 점유 · 능력 취합.
 *
 * ## 아직 못 하는 것
 * ❌ 번호판 호밍 — 크롭·가시성 판정이 필요하고 아직 만들지 않았다. backend-core 경유로 남는다.
 */

const NOT_YET = (capability: CoreCapabilityName, what: string): never => {
  throw new CoreUnsupportedError(
    capability,
    `브리지 코어는 아직 ${what}을(를) 지원하지 않습니다 — 옵션에서 코어 구현을 backend-core 로 바꾸면 쓸 수 있습니다`,
  );
};

export interface BridgeCoreProviderOptions {
  leases?: CameraLeaseRegistry;
  settleOptions?: SettleOptions;
  /** 카메라별 저장소. 기기를 바꾸면 다른 파일이 열려야 하므로 팩토리로 받는다. */
  discoveryStoreFor?: (cameraId: string) => DiscoveryDbStore;
  spotStoreFor?: (cameraId: string) => SpotDbStore;
  /** 세 독립 컴포넌트. 주지 않으면 그 능력이 사유와 함께 꺼진다 — 지어내지 않는다. */
  centering?: CenteringComponent;
  calibration?: CalibrationComponent;
  vehicleBox?: VehicleBoxComponent;
}

export class BridgeCoreProvider implements CoreProvider {
  readonly name = 'bridge' as const;
  private readonly leases: CameraLeaseRegistry;
  private readonly settleOptions?: SettleOptions;

  constructor(options: BridgeCoreProviderOptions = {}) {
    this.leases = options.leases ?? new CameraLeaseRegistry();
    this.settleOptions = options.settleOptions;
    this.options = {
      ...options,
      // 센터라이징과 차량 3D 는 **기본으로 세운다.** 둘 다 생성 비용이 없고(순수 계산 /
      // 주소 없으면 꺼진 상태), 배선을 잊었을 때 조용히 능력이 사라지는 것보다 낫다.
      // 캘리브레이션은 기본을 두지 않는다 — ffmpeg 프로브·잡 기록처럼 **수명이 있는 것**을
      // 들고 있어서, 요청마다 새로 만들어지면 진행 중인 스윕이 폴링마다 사라진다.
      centering: options.centering ?? new CenteringComponent({ settleOptions: options.settleOptions }),
      vehicleBox: options.vehicleBox ?? new VehicleBoxComponent(),
    };
  }

  private readonly options: BridgeCoreProviderOptions;

  async capabilities(ctx: CoreContext): Promise<CoreCapabilities> {
    const centering = this.options.centering;
    const calibration = this.options.calibration;
    return {
      provider: this.name,
      cameraId: ctx.camera.id,
      // 캘리브레이션이 도는 중에도 busy 다 — 그 잡은 카메라를 20분간 통째로 점유한다.
      busy: this.leases.isBusy(ctx.camera.id) || Boolean(calibration?.isBusy(ctx.camera.id)),
      supported: {
        center: wired(centering, '센터라이징 컴포넌트') ?? asState(centering!.centerSupport(ctx.camera, ctx.driver)),
        centerBox: wired(centering, '센터라이징 컴포넌트') ?? asState(centering!.boxSupport(ctx.camera)),
        discoveryPresets: this.options.discoveryStoreFor ? { ok: true } : { ok: false, reason: '탐색 프리셋 저장소가 배선되지 않았습니다' },
        discoveryPoints: this.options.discoveryStoreFor ? { ok: true } : { ok: false, reason: '탐색 점 저장소가 배선되지 않았습니다' },
        calibration: wired(calibration, '캘리브레이션 컴포넌트') ?? asState(await calibration!.support(ctx.camera, ctx.driver)),
        plateHoming: { ok: false, reason: '브리지 코어는 번호판 호밍을 지원하지 않습니다 — 크롭·가시성 판정에 이미지 처리가 필요하고 아직 만들지 않았습니다' },
        vehicleBox: wired(this.options.vehicleBox, '차량 3D 육면체 컴포넌트') ?? asState(this.options.vehicleBox!.support()),
        slotCreate: this.options.spotStoreFor ? { ok: true } : { ok: false, reason: '주차면 저장소가 배선되지 않았습니다' },
      },
    };
  }

  // --- 센터라이징 (컴포넌트에 위임) ---------------------------------------------

  async center(ctx: CoreContext, point: CenterPoint): Promise<CenterResult> {
    const centering = this.require(this.options.centering, 'center', '센터라이징 컴포넌트');
    const release = this.acquire(ctx.camera.id);
    try {
      // 펼쳐 담는다 — `CenterResult` 는 구현이 더 실어 보낸 것을 잃지 않고 통과시키는 계약이라
      // 인덱스 시그니처를 갖고, 컴포넌트의 좁은 타입은 그대로는 들어맞지 않는다.
      return { ...(await centering.center(ctx.camera, ctx.driver, point)) };
    } finally {
      release();
    }
  }

  async centerBox(ctx: CoreContext, box: CenterBox): Promise<CenterResult> {
    const centering = this.require(this.options.centering, 'centerBox', '센터라이징 컴포넌트');
    const release = this.acquire(ctx.camera.id);
    try {
      return { ...(await centering.centerBox(ctx.camera, ctx.driver, box)) };
    } finally {
      release();
    }
  }

  // --- 캘리브레이션 (컴포넌트에 위임) -------------------------------------------
  //
  // **점유를 여기서 잡지 않는다.** 잡은 20분간 비동기로 돌므로 요청 하나의 수명과 어긋난다 —
  // `try/finally` 로 감싸면 start 가 돌아오는 순간 점유가 풀린다. 대신 잡 자신이 자기 상태로
  // busy 를 답하고(`isBusy`), `capabilities()` 가 그것을 합쳐 보고한다.

  readonly calibration: JobPort<CalibrationStartOptions> = {
    start: async (ctx, options) => {
      const calibration = this.require(this.options.calibration, 'calibration', '캘리브레이션 컴포넌트');
      const support = await calibration.support(ctx.camera, ctx.driver);
      if (!support.ok) throw new CoreUnsupportedError('calibration', support.reason);
      if (this.leases.isBusy(ctx.camera.id)) throw new CoreBusyError(ctx.camera.id);
      return (await calibration.start(ctx.camera, ctx.driver, options.mode)) as JobStatus;
    },
    // 상태·중지는 **미지원 기기에서도 답한다** — "지금 idle 이다"를 읽는 것은 거짓말이 아니고,
    // 여기서 501 을 내면 화면이 잡 패널을 아예 못 그린다(적합성 스위트의 판정 대상은 행위다).
    status: async (ctx) => (this.options.calibration?.status(ctx.camera.id) ?? { state: 'idle' }) as JobStatus,
    stop: async (ctx) => (this.options.calibration?.stop(ctx.camera.id) ?? { state: 'idle' }) as JobStatus,
  };

  readonly plateHoming: JobPort<PlateHomingStartOptions> = {
    start: async () => NOT_YET('plateHoming', '번호판 호밍'),
    status: async () => NOT_YET('plateHoming', '번호판 호밍'),
    stop: async () => NOT_YET('plateHoming', '번호판 호밍'),
  };

  // --- 차량 3D 육면체 (컴포넌트에 위임) -----------------------------------------
  //
  // **카메라를 움직이지 않으므로 점유하지 않는다** — 상류도 같다: 잡이 도는 중에도 막히지 않는다.

  readonly vehicleBox: VehicleBoxPort = {
    status: async (ctx) => {
      const component = this.options.vehicleBox;
      if (!component) return { configured: false, ready: false, cameraId: ctx.camera.id };
      return component.status(ctx.camera);
    },
    detect: async (ctx) => {
      const component = this.require(this.options.vehicleBox, 'vehicleBox', '차량 3D 육면체 컴포넌트');
      const result = await component.detect(ctx.camera, ctx.driver);
      return { ...result, detections: result.detections as Array<Record<string, unknown>> };
    },
  };

  // --- 탐색 프리셋·점 -----------------------------------------------------------

  readonly discoveryPresets: DiscoveryPresetPort = {
    list: async (ctx) => ({ presets: await this.discovery(ctx, 'discoveryPresets').listPresets(), busy: this.leases.isBusy(ctx.camera.id) }),
    create: async (ctx, body) => ({ preset: await this.discovery(ctx, 'discoveryPresets').addPreset(body) }),
    update: async (ctx, presetId, body) => {
      const preset = await this.discovery(ctx, 'discoveryPresets').updatePreset(presetId, body);
      if (!preset) throw new CoreNotFoundError('탐색 프리셋', presetId);
      return { preset };
    },
    remove: async (ctx, presetId) => {
      if (!(await this.discovery(ctx, 'discoveryPresets').removePreset(presetId))) throw new CoreNotFoundError('탐색 프리셋', presetId);
      return { removed: presetId };
    },
    goto: async (ctx, presetId) => {
      const store = this.discovery(ctx, 'discoveryPresets');
      const preset = await store.getPreset(presetId);
      if (!preset) throw new CoreNotFoundError('탐색 프리셋', presetId);
      const release = this.acquire(ctx.camera.id);
      try {
        await ctx.driver.goPtz(fromStoredPtz(preset.ptz));
        const settle = await waitForSettle(ctx.driver, this.settleOptions);
        return { preset, ptz: toView(settle.ptz) };
      } finally {
        release();
      }
    },
  };

  readonly discoveryPoints: DiscoveryPointPort = {
    list: async (ctx, presetId) => {
      const points = await this.discovery(ctx, 'discoveryPoints').listPoints(presetId);
      if (points === null) throw new CoreNotFoundError('탐색 프리셋', presetId);
      return { points };
    },
    create: async (ctx, presetId, body) => {
      const point = await this.discovery(ctx, 'discoveryPoints').addPoint(presetId, body);
      if (!point) throw new CoreNotFoundError('탐색 프리셋', presetId);
      return { point };
    },
    update: async (ctx, presetId, pointId, body) => {
      const point = await this.discovery(ctx, 'discoveryPoints').updatePoint(presetId, pointId, body);
      if (!point) throw new CoreNotFoundError('탐색 점', pointId);
      return { point };
    },
    remove: async (ctx, presetId, pointId) => {
      const store = this.discovery(ctx, 'discoveryPoints');
      // pointId 를 생략하면 그 프리셋의 점을 통째로 비운다(상류의 목록 일괄삭제와 같은 계약).
      if (pointId === undefined) {
        const removed = await store.clearPoints(presetId);
        if (removed === null) throw new CoreNotFoundError('탐색 프리셋', presetId);
        return { removed };
      }
      if (!(await store.removePoint(presetId, pointId))) throw new CoreNotFoundError('탐색 점', pointId);
      return { removed: pointId };
    },
  };

  readonly parkingSlots: ParkingSlotPort = {
    list: async (ctx) => {
      const data = await this.spots(ctx).load();
      return { slots: data.spots, wideShot: data.wideShot };
    },
    create: async (ctx, input) => {
      // 지금 자세가 곧 그 주차면의 클로즈업이다 — 카메라를 움직이지 않고 읽기만 한다.
      const closeupPtz = toStoredPtz(await ctx.driver.getPtz());
      const slot = await this.spots(ctx).addSpot({ ...input, closeupPtz });
      return { slot };
    },
    goto: async (ctx, slotId) => {
      const slot = await this.spots(ctx).getSpot(slotId);
      if (!slot) throw new CoreNotFoundError('주차면', slotId);
      const release = this.acquire(ctx.camera.id);
      try {
        await ctx.driver.goPtz(fromStoredPtz(slot.closeupPtz));
        const settle = await waitForSettle(ctx.driver, this.settleOptions);
        return { slot, ptz: toView(settle.ptz) };
      } finally {
        release();
      }
    },
    remove: async (ctx, slotId) => {
      if (!(await this.spots(ctx).removeSpot(slotId))) throw new CoreNotFoundError('주차면', slotId);
      return { removed: slotId };
    },
  };

  // --- 내부 ---------------------------------------------------------------------

  /**
   * `capability` 를 받는 이유: 오류에 **부른 쪽의 능력 이름**이 실려야 한다.
   * 고정으로 `discoveryPresets` 를 실었더니 점 조작 실패가 프리셋 사유로 보고됐고,
   * 적합성 스위트가 그것을 잡아냈다(`checkUnsupportedRejects` 의 capability 일치 검사).
   */
  private discovery(ctx: CoreContext, capability: CoreCapabilityName): DiscoveryDbStore {
    const make = this.options.discoveryStoreFor;
    if (!make) throw new CoreUnsupportedError(capability, '탐색 저장소가 배선되지 않았습니다');
    return make(ctx.camera.id);
  }

  private spots(ctx: CoreContext): SpotDbStore {
    const make = this.options.spotStoreFor;
    if (!make) throw new CoreUnsupportedError('slotCreate', '주차면 저장소가 배선되지 않았습니다');
    return make(ctx.camera.id);
  }

  private require<T>(component: T | undefined, capability: CoreCapabilityName, what: string): T {
    if (!component) throw new CoreUnsupportedError(capability, `${what}가 배선되지 않았습니다`);
    return component;
  }

  /** 같은 카메라의 동시 작업만 막는다. 다른 카메라는 서로 간섭하지 않는다. */
  private acquire(cameraId: string): () => void {
    if (this.options.calibration?.isBusy(cameraId)) {
      throw new CoreBusyError(cameraId, `카메라 ${cameraId} 에서 캘리브레이션이 진행 중입니다`);
    }
    try {
      return this.leases.acquire(cameraId);
    } catch (error) {
      if (error instanceof CameraLeaseError) throw new CoreBusyError(cameraId, error.message);
      throw error;
    }
  }
}

/** 컴포넌트가 아예 없으면 그 자체가 사유다. 있으면 `undefined` 를 돌려 다음 판단으로 넘긴다. */
function wired(component: unknown, what: string): CoreCapabilityState | undefined {
  return component ? undefined : { ok: false, reason: `${what}가 배선되지 않았습니다` };
}

function asState(support: { ok: true } | { ok: false; reason: string }): CoreCapabilityState {
  return support.ok ? { ok: true } : { ok: false, reason: support.reason };
}

/** 저장 형식(backend-core) → 계약 좌표. 필드명이 다르므로 옮기는 자리를 한 곳에 둔다. */
function fromStoredPtz(stored: unknown): PtzRaw {
  const p = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  return clampPtz({
    pan: Number(p.panpos) || 0,
    tilt: Number(p.tiltpos) || 0,
    zoom: Number(p.zoompos) || 0,
  });
}

/** 계약 좌표 → 저장 형식. `focuspos` 는 이 서비스가 다루지 않으므로 0 으로 남긴다. */
function toStoredPtz(ptz: PtzRaw): StoredPtz {
  return { panpos: ptz.pan, tiltpos: ptz.tilt, zoompos: ptz.zoom, focuspos: 0 };
}
