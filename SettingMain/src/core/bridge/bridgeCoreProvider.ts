import type { CenterPoint } from '../../devices/cameraDriver.js';
import { waitForSettle, type SettleOptions } from '../../devices/waitForSettle.js';
import { clampPtz, toView, type PtzRaw } from '../../domain/ptz.js';
import { pixelToPtzDelta } from '../../vendor/baro-profile/index.mjs';
import type { CameraConfig } from '../../config/types.js';
import type { Object3dClient } from '../../detectors/object3dClient.js';
import type { StoredPtz } from '../../store/discoveryStore.js';
import type { DiscoveryDbStore } from '../../db/discoveryDbStore.js';
import type { SpotDbStore } from '../../db/spotDbStore.js';
import {
  CoreBusyError,
  CoreNotFoundError,
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
  type ParkingSlotPort,
  type PlateHomingStartOptions,
  type VehicleBoxPort,
} from '../coreProvider.js';
import { CameraLeaseError, CameraLeaseRegistry } from './cameraLease.js';
import { hfovAt, zoomPosForHfov } from './zoomTable.js';

/**
 * SettingManager 자체 코어 구현 — 구성도의 **Bridge Backend-Core**.
 *
 * **backend-core 를 호출하지 않는다** — 선택된 카메라의 드라이버와 자기 저장소만 쓴다.
 * 아직 못 하는 것은 조용히 원격으로 흘려보내지 않고 **501 확정 답**으로 거절한다.
 * 무엇을 할 수 있는지는 `capabilities()` 가 미리 말하므로 화면은 못 하는 버튼을 비활성으로 그린다.
 *
 * 광학·조준 기하는 **다시 구현하지 않고 벤더링해 쓴다**(`src/vendor/baro-profile/`).
 * 실기 112샘플로 실측해 고정된 계산을 베껴 쓰면 두 벌이 되어 반드시 갈라진다.
 *
 * 지금 할 수 있는 것 / 없는 것
 *   ✅ 센터링 · 박스 줌 · 탐색 프리셋/점 · 주차면(스팟) · 차량 3D 육면체
 *   ❌ 캘리브레이션 · 번호판 호밍 — **이미지를 만지는 일**(ZNCC 프레임 매칭·크롭)이 필요하고,
 *      그것은 네이티브 이미지 라이브러리(sharp) 없이는 서지 않는다. 이 서비스는 런타임
 *      의존성 0 을 유지하므로 그 둘은 backend-core 경유로 남긴다.
 */

const NOT_YET = (capability: CoreCapabilityName, what: string): never => {
  throw new CoreUnsupportedError(capability, `브리지 코어는 아직 ${what}을(를) 지원하지 않습니다 — 옵션에서 코어 구현을 backend-core 로 바꾸면 쓸 수 있습니다`);
};

/** 실측 화각표가 없으면 기하 계산을 **켜지 않는다**. 내장 표로 대신하면 조용히 빗나간다. */
const NO_INTRINSICS = (camera: CameraConfig): string =>
  `기기 ${camera.id} 의 실측 줌→화각 표가 없습니다 — config.json 의 cameras[].intrinsics.zoomHfov 를 채우거나 코어 구현을 backend-core 로 바꾸십시오`;

export interface BridgeCoreProviderOptions {
  leases?: CameraLeaseRegistry;
  settleOptions?: SettleOptions;
  /** 카메라별 저장소. 기기를 바꾸면 다른 파일이 열려야 하므로 팩토리로 받는다. */
  discoveryStoreFor?: (cameraId: string) => DiscoveryDbStore;
  spotStoreFor?: (cameraId: string) => SpotDbStore;
  /** 3D 차량 박스 사이드카. 설정되지 않았으면 `undefined` 이고 능력이 꺼진다. */
  object3d?: Object3dClient;
}

export class BridgeCoreProvider implements CoreProvider {
  readonly name = 'bridge' as const;
  private readonly leases: CameraLeaseRegistry;
  private readonly settleOptions?: SettleOptions;
  private readonly options: BridgeCoreProviderOptions;

  constructor(options: BridgeCoreProviderOptions = {}) {
    this.leases = options.leases ?? new CameraLeaseRegistry();
    this.settleOptions = options.settleOptions;
    this.options = options;
  }

  async capabilities(ctx: CoreContext): Promise<CoreCapabilities> {
    const canCenter = typeof ctx.driver.centerPoint === 'function';
    const intrinsics = ctx.camera.intrinsics;
    const boxReason = intrinsics ? undefined : NO_INTRINSICS(ctx.camera);
    return {
      provider: this.name,
      cameraId: ctx.camera.id,
      busy: this.leases.isBusy(ctx.camera.id),
      supported: {
        center: canCenter ? { ok: true } : { ok: false, reason: '이 카메라 드라이버는 픽셀 센터링을 지원하지 않습니다' },
        // 박스 줌은 하드웨어 기능이 아니라 **계산**이다 — 실측 화각표만 있으면 어느 기기에서든 선다.
        centerBox: boxReason ? { ok: false, reason: boxReason } : { ok: true },
        discoveryPresets: this.options.discoveryStoreFor ? { ok: true } : { ok: false, reason: '탐색 프리셋 저장소가 배선되지 않았습니다' },
        discoveryPoints: this.options.discoveryStoreFor ? { ok: true } : { ok: false, reason: '탐색 점 저장소가 배선되지 않았습니다' },
        calibration: { ok: false, reason: '브리지 코어는 캘리브레이션을 지원하지 않습니다 — 프레임 매칭(ZNCC)에 네이티브 이미지 처리가 필요합니다' },
        plateHoming: { ok: false, reason: '브리지 코어는 번호판 호밍을 지원하지 않습니다 — 크롭·가시성 판정에 네이티브 이미지 처리가 필요합니다' },
        vehicleBox: this.options.object3d
          ? { ok: true }
          : { ok: false, reason: '3D 차량 박스 사이드카가 설정되지 않았습니다 — config.json 의 object3d.baseUrl 을 채우십시오' },
        slotCreate: this.options.spotStoreFor ? { ok: true } : { ok: false, reason: '주차면 저장소가 배선되지 않았습니다' },
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

  /**
   * 드래그한 박스가 화면을 채우도록 조준 + 줌인. **순수 계산이다** — 하드웨어 박스줌을 쓰지 않는다.
   *
   *   ① 박스 중앙을 화면 중앙으로  →  `pixelToPtzDelta`(짐벌 기하, 벤더링)
   *   ② 박스가 프레임을 채울 화각  →  현재 화각 × max(박스폭/프레임폭, 박스높이/프레임높이)
   *   ③ 그 화각의 줌 눈금          →  실측 표 역보간
   *
   * ②에서 가로·세로 중 **큰 쪽**을 쓰는 이유는 작은 쪽을 쓰면 박스가 화면 밖으로 잘리기 때문이다.
   */
  async centerBox(ctx: CoreContext, box: CenterBox): Promise<CenterResult> {
    const intrinsics = ctx.camera.intrinsics;
    if (!intrinsics) throw new CoreUnsupportedError('centerBox', NO_INTRINSICS(ctx.camera));

    const width = Math.abs(box.endX - box.startX);
    const height = Math.abs(box.endY - box.startY);
    if (width < 1 || height < 1) {
      throw new CoreUnsupportedError('centerBox', '박스가 너무 작습니다 — 가로·세로가 각각 1픽셀 이상이어야 합니다');
    }

    const release = this.acquire(ctx.camera.id);
    try {
      const current = await ctx.driver.getPtz();
      const hfov = hfovAt(intrinsics, current.zoom);
      const delta = pixelToPtzDelta({
        x: (box.startX + box.endX) / 2,
        y: (box.startY + box.endY) / 2,
        hfovDeg: hfov,
        tiltDeg: current.tilt / 100,
        frameWidth: FRAME.width,
        frameHeight: FRAME.height,
      });
      const target = clampPtz({
        pan: current.pan + delta.panDelta,
        tilt: current.tilt + delta.tiltDelta,
        zoom: zoomPosForHfov(intrinsics, hfov * Math.max(width / FRAME.width, height / FRAME.height)),
      });

      await ctx.driver.goPtz(target);
      const settle = await waitForSettle(ctx.driver, this.settleOptions);
      return { cameraId: ctx.camera.id, box, ptz: toView(settle.ptz), settled: settle.settled, target };
    } finally {
      release();
    }
  }

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

  /**
   * 차량 3D 육면체 — 사이드카 소비. **카메라를 움직이지 않으므로 점유하지 않는다**
   * (상류도 같다: 잡이 도는 중에도 이 경로는 막히지 않는다).
   */
  readonly vehicleBox: VehicleBoxPort = {
    status: async (ctx) => {
      const client = this.options.object3d;
      if (!client) return { configured: false, ready: false };
      return { ...(await client.ready()), cameraId: ctx.camera.id, model: client.model };
    },
    detect: async (ctx) => {
      const client = this.options.object3d;
      if (!client) {
        throw new CoreUnsupportedError('vehicleBox', '3D 차량 박스 사이드카가 설정되지 않았습니다 — config.json 의 object3d.baseUrl 을 채우십시오');
      }
      const image = await ctx.driver.getSnapshot();
      const raw = await client.detect(image, ctx.camera.id);
      const detections = Array.isArray(raw.detections) ? (raw.detections as Record<string, unknown>[]) : [];
      return {
        // 봉투는 우리 어휘, detections·calibration 은 사이드카 어휘 그대로(상류와 같은 경계).
        cameraId: ctx.camera.id,
        capturedAt: new Date().toISOString(),
        count: detections.length,
        detections,
        calibration: raw.calibration,
        model: (raw.model_id as string | undefined) ?? client.model,
        latencyMs: raw.total_ms ?? raw.latency_ms ?? null,
        source: 'object3d',
      };
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

/** 픽셀 좌표의 기준 프레임. 계약 좌표와 같은 Hucoms 논리 프레임이다. */
const FRAME = { width: 1920, height: 1080 };

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
