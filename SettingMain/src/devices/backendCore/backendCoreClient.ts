import { clampPtz, type PtzRaw } from '../../domain/ptz.js';
import { CameraDriverError, type CameraDriver, type CenterPoint, type Slot } from '../cameraDriver.js';
import { HttpBackendCoreTransport, type BackendCoreTransport } from './backendCoreTransport.js';

/**
 * baro_calory backend-core 의 **드라이버 표면**(PTZ·스냅샷·주차면).
 *
 * 에이전트 기능(탐색 프리셋·캘리브레이션·번호판 호밍)은 이 클래스가 아니라
 * `core/remote/remoteCoreProvider.ts` 가 담당한다 — 층이 다르기 때문이다.
 * driver 는 "기기를 어떻게 두드리는가", provider 는 "카메라로 무슨 일을 하는가"다.
 *
 * 계약 근거 — baro_calory/apps/backend-core/src/:
 *   GET  /api/ptz              → { panpos, tiltpos, zoompos, hfovDeg? }   control-api.mjs:262
 *   POST /api/ptz              ← { panpos, tiltpos, zoompos, panspeed… }  control-api.mjs:309
 *   GET  /api/snapshot         → image/jpeg                               control-api.mjs:266
 *   GET  /api/simulator/slots  → { slots: [{ id, label, occupied, carId }] }  simulator-api.mjs
 */

export interface BackendCoreClientOptions {
  cameraId: string;
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** 전송을 갈아 끼우기 위한 주입 지점(테스트·MCP 어댑터). 없으면 HTTP 를 쓴다. */
  transport?: BackendCoreTransport;
}

/** BackendCore discovery 데이터는 이 서비스에 저장하지 않고 그대로 전달한다. */
export type BackendCoreJson = Record<string, unknown>;

export class BackendCoreClient implements CameraDriver {
  readonly kind = 'backend-core';
  readonly cameraId: string;
  readonly transport: BackendCoreTransport;

  constructor(options: BackendCoreClientOptions) {
    this.cameraId = options.cameraId;
    this.transport = options.transport ?? new HttpBackendCoreTransport({
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
  }

  async getPtz(): Promise<PtzRaw> {
    const data = await this.transport.json<Record<string, unknown>>('GET', '/api/ptz');
    const pan = Number(data.panpos);
    const tilt = Number(data.tiltpos);
    const zoom = Number(data.zoompos);
    if (![pan, tilt, zoom].every(Number.isFinite)) {
      throw new CameraDriverError('backend-core 가 PTZ 좌표를 주지 않았습니다');
    }
    return { pan: Math.round(pan), tilt: Math.round(tilt), zoom: Math.round(zoom) };
  }

  async goPtz(target: PtzRaw, speed = 50): Promise<void> {
    const safe = clampPtz(target);
    await this.transport.json('POST', '/api/ptz', {
      panpos: safe.pan,
      tiltpos: safe.tilt,
      zoompos: safe.zoom,
      panspeed: speed,
      tiltspeed: speed,
      zoomspeed: speed,
    });
  }

  async centerPoint(point: CenterPoint): Promise<void> {
    await this.transport.json('POST', '/api/center', { x: point.x, y: point.y, frameWidth: 1920, frameHeight: 1080, speed: 50 });
  }

  async getSnapshot(): Promise<Buffer> {
    return this.transport.binary('GET', '/api/snapshot');
  }

  async listSlots(): Promise<Slot[]> {
    const data = await this.transport.json<{ slots?: unknown }>('GET', '/api/simulator/slots');
    const slots = Array.isArray(data.slots) ? data.slots : [];
    return slots.map((raw, index) => {
      const s = (raw ?? {}) as Record<string, unknown>;
      const id = typeof s.id === 'string' ? s.id : String(s.id ?? index + 1);
      return {
        id,
        label: typeof s.label === 'string' && s.label ? s.label : id,
        occupied: typeof s.occupied === 'boolean' ? s.occupied : undefined,
        carId: typeof s.carId === 'string' ? s.carId : null,
      };
    });
  }
}
