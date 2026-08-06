import type { BackendCoreTransport } from '../../devices/backendCore/backendCoreTransport.js';
import type { CenterPoint } from '../../devices/cameraDriver.js';
import {
  allCapabilities,
  CoreUnsupportedError,
  type CalibrationStartOptions,
  type CenterBox,
  type CenterResult,
  type CoreCapabilities,
  type CoreContext,
  type CoreProvider,
  type DiscoveryPoint,
  type DiscoveryPointPort,
  type DiscoveryPreset,
  type DiscoveryPresetPort,
  type JobPort,
  type JobStatus,
  type ParkingSlot,
  type ParkingSlotPort,
  type PlateHomingStartOptions,
  type VehicleBoxPort,
} from '../coreProvider.js';

/**
 * backend-core 를 경유하는 코어 구현.
 *
 * **전송을 직접 알지 않는다** — `BackendCoreTransport` 를 받는다. 지금은 HTTP REST 하나뿐이지만
 * MCP 도구를 경유하게 되어도 이 파일은 바뀌지 않는다.
 *
 * 응답은 backend-core 가 준 JSON 을 **깎지 않고 통과**시킨다. 계약이 보장하는 필드만 읽고
 * 나머지는 그대로 실어 보낸다 — 원격이 늘린 정보를 우리가 조용히 버리면 안 된다.
 */

type Json = Record<string, unknown>;

export interface RemoteCoreProviderOptions {
  transport: BackendCoreTransport;
}

export class RemoteCoreProvider implements CoreProvider {
  readonly name = 'remote' as const;
  private readonly t: BackendCoreTransport;

  constructor(options: RemoteCoreProviderOptions) {
    this.t = options.transport;
  }

  /**
   * backend-core 는 능력을 스스로 답한다(`GET /api/cctv/capabilities`).
   * 도달하지 못하면 **지원한다고 지어내지 않고** 사유와 함께 전부 미지원으로 답한다.
   */
  async capabilities(ctx: CoreContext): Promise<CoreCapabilities> {
    let axes: Json | undefined;
    let reason: string | undefined;
    try {
      const data = await this.t.json<{ axes?: Json }>('GET', '/api/cctv/capabilities');
      axes = data.axes;
    } catch (error) {
      reason = `backend-core 능력 조회 실패: ${error instanceof Error ? error.message : String(error)}`;
    }

    if (reason) {
      return { provider: this.name, cameraId: ctx.camera.id, busy: false, supported: allCapabilities({ ok: false, reason }) };
    }

    const axisOk = (axis: string): boolean => Boolean((axes?.[axis] as Json | undefined)?.supported);
    const axisMissing = (axis: string): string => {
      const missing = (axes?.[axis] as Json | undefined)?.missing;
      return Array.isArray(missing) && missing.length > 0
        ? `backend-core 가 이 기기에서 ${missing.join('·')} 능력을 찾지 못했습니다`
        : 'backend-core 가 이 축을 지원하지 않는다고 답했습니다';
    };
    const gate = (ok: boolean, why: string) => (ok ? { ok: true } : { ok: false, reason: why });

    return {
      provider: this.name,
      cameraId: ctx.camera.id,
      busy: false,
      supported: {
        // 센터링·주차면·탐색 프리셋은 backend-core 가 축 게이트 없이 제공한다.
        center: { ok: true },
        // baro_calory 는 discovery point 에 box 좌표를 저장하지 않아 개별 센터+줌 경로가 없다.
        centerBox: { ok: false, reason: 'backend-core discovery point 는 box 좌표를 저장하지 않습니다' },
        discoveryPresets: { ok: true },
        discoveryPoints: { ok: true },
        calibration: gate(axisOk('calibration'), axisMissing('calibration')),
        plateHoming: gate(axisOk('plateHoming'), axisMissing('plateHoming')),
        // 아래 둘은 backend-core 소스에서 경로를 확인해 배선했다(control-api.mjs:485-604).
        // 3D 는 사이드카가 실제로 떠 있어야 답하므로 게이트를 여기서 판정하지 않고,
        // 호출 시점의 사이드카 상태가 그대로 드러나게 둔다(status 라우트가 사실을 답한다).
        vehicleBox: { ok: true },
        slotCreate: { ok: true },
      },
    };
  }

  async center(ctx: CoreContext, point: CenterPoint): Promise<CenterResult> {
    const result = await this.t.json<Json>('POST', '/api/center', {
      x: point.x,
      y: point.y,
      frameWidth: 1920,
      frameHeight: 1080,
      speed: 50,
    });
    return { cameraId: ctx.camera.id, point, ...result };
  }

  async centerBox(_ctx: CoreContext, _box: CenterBox): Promise<CenterResult> {
    throw new CoreUnsupportedError('centerBox', 'backend-core discovery point 는 box 좌표를 저장하지 않아 개별 센터+줌을 지원하지 않습니다');
  }


  readonly discoveryPresets: DiscoveryPresetPort = {
    list: async () => {
      const data = await this.t.json<Json>('GET', '/api/discovery/presets');
      return { ...data, presets: (data.presets as DiscoveryPreset[]) ?? [] };
    },
    create: async (_ctx, body) => {
      const data = await this.t.json<Json>('POST', '/api/discovery/presets', body);
      return data as unknown as { preset: DiscoveryPreset };
    },
    update: async (_ctx, presetId, body) => {
      const data = await this.t.json<Json>('PUT', presetPath(presetId), body);
      return data as unknown as { preset: DiscoveryPreset };
    },
    remove: async (_ctx, presetId) => {
      const data = await this.t.json<Json>('DELETE', presetPath(presetId));
      return data as unknown as { removed: string };
    },
    goto: async (_ctx, presetId) => {
      const data = await this.t.json<Json>('POST', `${presetPath(presetId)}/goto`);
      return data as unknown as { preset: DiscoveryPreset };
    },
  };

  readonly discoveryPoints: DiscoveryPointPort = {
    list: async (_ctx, presetId) => {
      const data = await this.t.json<Json>('GET', pointPath(presetId));
      return { ...data, points: (data.points as DiscoveryPoint[]) ?? [] };
    },
    create: (_ctx, presetId, body) => this.t.json<Json>('POST', pointPath(presetId), body),
    update: (_ctx, presetId, pointId, body) => this.t.json<Json>('PUT', pointPath(presetId, pointId), body),
    remove: (_ctx, presetId, pointId) => this.t.json<Json>('DELETE', pointPath(presetId, pointId)),
  };

  readonly calibration: JobPort<CalibrationStartOptions> = {
    start: (_ctx, options) => this.job('POST', '/api/calibration/start', { mode: options.mode }),
    status: () => this.job('GET', '/api/calibration/status'),
    stop: () => this.job('POST', '/api/calibration/stop'),
  };

  /**
   * 차량 3D 육면체. backend-core 가 사이드카를 **소비**해 자기 어휘로 답하므로 그대로 통과시킨다.
   * 근거: baro_calory `control-api.mjs:530-604` — `POST /api/discovery/object3d`(본문 없음),
   * `GET /api/discovery/object3d/status`.
   */
  readonly vehicleBox: VehicleBoxPort = {
    status: async (ctx) => {
      // 상태를 묻는 질문에 오류로 답하지 않는다 — backend-core 도 사이드카가 죽어 있어도 200 이다.
      try {
        const data = await this.t.json<Json>('GET', '/api/discovery/object3d/status');
        return { configured: false, ready: false, ...data, cameraId: ctx.camera.id };
      } catch (error) {
        return { configured: false, ready: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    detect: async (ctx) => {
      const data = await this.t.json<Json>('POST', '/api/discovery/object3d', {});
      const detections = Array.isArray(data.detections) ? (data.detections as Record<string, unknown>[]) : [];
      // 원격이 준 봉투를 그대로 두고 계약 필드만 보정한다 — 깎으면 늘어난 정보가 사라진다.
      return { cameraId: ctx.camera.id, capturedAt: new Date().toISOString(), ...data, count: detections.length, detections };
    },
  };

  /**
   * 커미셔닝 주차면. 근거: `control-api.mjs:485-520` — `GET·POST /api/spots`,
   * `POST /api/spots/:id/goto`, `DELETE /api/spots/:id`.
   * 상류는 목록을 `{wideShot, spots}` 로 답하므로 `slots` 로 옮겨 담고 나머지는 통과시킨다.
   */
  readonly parkingSlots: ParkingSlotPort = {
    list: async () => {
      const data = await this.t.json<Json>('GET', '/api/spots');
      return { ...data, slots: (Array.isArray(data.spots) ? data.spots : []) as ParkingSlot[] };
    },
    create: async (_ctx, input) => {
      const body: Json = { x: input.x, y: input.y };
      if (input.name !== undefined) body.name = input.name;
      if (input.box !== undefined) body.box = input.box;
      return this.t.json<{ slot: ParkingSlot }>('POST', '/api/spots', body);
    },
    goto: async (_ctx, slotId) => this.t.json<{ slot: ParkingSlot }>('POST', `/api/spots/${encodeURIComponent(slotId)}/goto`),
    remove: async (_ctx, slotId) => {
      await this.t.json<Json>('DELETE', `/api/spots/${encodeURIComponent(slotId)}`);
      return { removed: slotId };
    },
  };

  readonly plateHoming: JobPort<PlateHomingStartOptions> = {
    start: (_ctx, options) => {
      const body: Json = { presetId: options.presetId };
      if (options.pointIds) body.pointIds = options.pointIds;
      return this.job('POST', '/api/discovery/plate-home/start', body);
    },
    status: () => this.job('GET', '/api/discovery/plate-home/status'),
    stop: () => this.job('POST', '/api/discovery/plate-home/stop'),
  };

  /** 원격 응답을 JobStatus 로 옮긴다. state 가 없으면 idle 로 본다 — 지어낸 진행 상태보다 낫다. */
  private async job(method: string, path: string, body?: Json): Promise<JobStatus> {
    const data = await this.t.json<Json>(method, path, body);
    const state = typeof data.state === 'string' && ['idle', 'running', 'done', 'failed', 'stopped'].includes(data.state)
      ? (data.state as JobStatus['state'])
      : 'idle';
    return { ...data, state };
  }
}

function presetPath(presetId: string): string {
  return `/api/discovery/presets/${encodeURIComponent(presetId)}`;
}

function pointPath(presetId: string, pointId?: string): string {
  const root = `${presetPath(presetId)}/points`;
  return pointId ? `${root}/${encodeURIComponent(pointId)}` : root;
}
