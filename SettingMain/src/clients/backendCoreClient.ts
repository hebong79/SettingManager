import { clampPtz, type PtzRaw } from '../domain/ptz.js';
import { CameraDriverError, type CameraDriver, type Slot } from './cameraDriver.js';

/**
 * baro_calory backend-core 의 REST 제어면 드라이버(시뮬레이터 포함).
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
}

export class BackendCoreClient implements CameraDriver {
  readonly kind = 'backend-core';
  readonly cameraId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: BackendCoreClientOptions) {
    this.cameraId = options.cameraId;
    if (!options.baseUrl) throw new CameraDriverError('시뮬레이터 URL 이 설정되지 않았습니다 (옵션 페이지에서 입력하세요)', 400);
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getPtz(): Promise<PtzRaw> {
    const data = await this.json<Record<string, unknown>>('GET', '/api/ptz');
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
    await this.json('POST', '/api/ptz', {
      panpos: safe.pan,
      tiltpos: safe.tilt,
      zoompos: safe.zoom,
      panspeed: speed,
      tiltspeed: speed,
      zoomspeed: speed,
    });
  }

  async getSnapshot(): Promise<Buffer> {
    const response = await this.send('GET', '/api/snapshot');
    return Buffer.from(await response.arrayBuffer());
  }

  async listSlots(): Promise<Slot[]> {
    const data = await this.json<{ slots?: unknown }>('GET', '/api/simulator/slots');
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

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.send(method, path, body);
    const text = await response.text();
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new CameraDriverError(`backend-core 응답이 JSON 이 아닙니다: ${path}`, 502, { cause });
    }
  }

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (cause) {
      throw new CameraDriverError(`backend-core 통신 실패 (${this.baseUrl}${path})`, 502, { cause });
    }
    if (!response.ok) {
      // 501 은 "이 기기는 그것을 하지 않는다"는 확정 답이다 — 상위가 재시도하지 않도록 코드를 보존한다.
      const detail = await response.text().catch(() => '');
      throw new CameraDriverError(
        `backend-core HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
        response.status === 501 ? 501 : 502,
      );
    }
    return response;
  }
}
