import { clampPtz, type PtzRaw } from '../domain/ptz.js';
import { CameraDriverError, type CameraDriver, type CenterPoint, type Slot } from './cameraDriver.js';

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

/** BackendCore discovery 데이터는 이 서비스에 저장하지 않고 그대로 전달한다. */
export type BackendCoreJson = Record<string, unknown>;

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

  async centerPoint(point: CenterPoint): Promise<void> {
    await this.center({ x: point.x, y: point.y, frameWidth: 1920, frameHeight: 1080, speed: 50 });
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


  async discovery(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<BackendCoreJson> {
    return this.json<BackendCoreJson>(method, path, body);
  }

  async listDiscoveryPresets(): Promise<BackendCoreJson> {
    return this.discovery('GET', '/api/discovery/presets');
  }

  async createDiscoveryPreset(body: BackendCoreJson): Promise<BackendCoreJson> {
    return this.discovery('POST', '/api/discovery/presets', body);
  }

  async updateDiscoveryPreset(id: string, body: BackendCoreJson): Promise<BackendCoreJson> {
    return this.discovery('PUT', `/api/discovery/presets/${encodeURIComponent(id)}`, body);
  }

  async deleteDiscoveryPreset(id: string): Promise<BackendCoreJson> {
    return this.discovery('DELETE', `/api/discovery/presets/${encodeURIComponent(id)}`);
  }

  async gotoDiscoveryPreset(id: string): Promise<BackendCoreJson> {
    return this.discovery('POST', `/api/discovery/presets/${encodeURIComponent(id)}/goto`);
  }

  async discoveryPoints(method: 'GET' | 'POST' | 'PUT' | 'DELETE', presetId: string, pointId?: string, body?: BackendCoreJson): Promise<BackendCoreJson> {
    const root = `/api/discovery/presets/${encodeURIComponent(presetId)}/points`;
    return this.discovery(method, pointId ? `${root}/${encodeURIComponent(pointId)}` : root, body);
  }

  async calibration(action: 'start' | 'stop' | 'status', body?: BackendCoreJson): Promise<BackendCoreJson> {
    return this.discovery(action === 'status' ? 'GET' : 'POST', `/api/calibration/${action}`, body);
  }

  async center(body: BackendCoreJson, withBox = false): Promise<BackendCoreJson> {
    return this.discovery('POST', withBox ? '/api/center-box' : '/api/center', body);
  }

  async plateHome(action: 'start' | 'stop' | 'status', body?: BackendCoreJson): Promise<BackendCoreJson> {
    return this.discovery(action === 'status' ? 'GET' : 'POST', `/api/discovery/plate-home/${action}`, body);
  }

  async vlaTour(body: BackendCoreJson): Promise<BackendCoreJson> {
    return this.discovery('POST', '/api/vla/tour', body);
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
      const isHtml = response.headers.get('content-type')?.toLowerCase().includes('text/html')
        || /^\s*<!doctype html|^\s*<html/i.test(detail);
      const message = isHtml
        ? `backend-core endpoint ${this.safeEndpoint(path)}가 HTML HTTP ${response.status}을 반환했습니다. 이 카메라의 제어 URL은 BackendCore API 기준 URL이어야 하며 Hucoms CGI 또는 RTSP URL이 아닙니다.`
        : `backend-core HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
      throw new CameraDriverError(
        message,
        [409, 422, 501].includes(response.status) ? response.status : 502,
      );
    }
    return response;
  }

  private safeEndpoint(path: string): string {
    try {
      const base = new URL(this.baseUrl);
      return `${base.origin}${base.pathname.replace(/\/+$/, '')}${path}`;
    } catch {
      return path;
    }
  }
}
