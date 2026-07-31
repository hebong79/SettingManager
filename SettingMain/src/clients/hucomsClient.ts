import { clampPtz, type PtzRaw } from '../domain/ptz.js';
import { CameraDriverError, type CameraDriver, type Slot } from './cameraDriver.js';
import { parseHucomsText, requireInt, type HucomsResponse } from './hucomsText.js';

/**
 * Hucoms HTTP CGI 드라이버 (hucoms-v1.22).
 * 인증은 매 요청 쿼리스트링 평문(`id=&passwd=`)이고 세션·토큰이 없다.
 * 근거: baro_calory/docs/cameras.md §Hucoms, SettingAgent/src/clients/hucoms/HucomsClient.ts
 */

export interface HucomsClientOptions {
  cameraId: string;
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

const CONTROL = '/cgi-bin/control';
const IMAGE = '/cgi-bin/image';

export class HucomsClient implements CameraDriver {
  readonly kind = 'hucoms';
  readonly cameraId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HucomsClientOptions) {
    this.cameraId = options.cameraId;
    if (!options.baseUrl) throw new CameraDriverError('제어 URL 이 설정되지 않았습니다', 400);
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getPtz(): Promise<PtzRaw> {
    const response = await this.control('ptzf_status', 'getptzfpos');
    return {
      pan: requireInt(response, 'panpos'),
      tilt: requireInt(response, 'tiltpos'),
      zoom: requireInt(response, 'zoompos'),
    };
  }

  async goPtz(target: PtzRaw, speed = 50): Promise<void> {
    const safe = clampPtz(target);
    await this.control('ptzf_status', 'goptzfpos', {
      panpos: safe.pan,
      tiltpos: safe.tilt,
      zoompos: safe.zoom,
      panspeed: speed,
      tiltspeed: speed,
      zoomspeed: speed,
      focusspeed: 0,
    });
  }

  async getSnapshot(): Promise<Buffer> {
    const body = await this.fetchBuffer(`${IMAGE}/jpeg.cgi`, {});
    // 인증 실패·경로 오류는 200 + text/plain 으로 오므로 JPEG SOI 로 판정한다.
    if (body.length < 2 || body[0] !== 0xff || body[1] !== 0xd8) {
      throw new CameraDriverError('스냅샷이 JPEG 가 아닙니다 — 계정·권한을 확인하세요');
    }
    return body;
  }

  /** Hucoms 기기는 주차면 개념이 없다. */
  async listSlots(): Promise<Slot[]> {
    return [];
  }

  private async control(script: string, action: string, params: Record<string, string | number> = {}): Promise<HucomsResponse> {
    const body = await this.fetchBuffer(`${CONTROL}/${script}.cgi`, { action, ...params });
    const parsed = parseHucomsText(body.toString('utf8'));
    if (parsed.errorMessage !== undefined) {
      throw new CameraDriverError(`카메라가 오류를 반환했습니다: ${parsed.errorMessage || '(사유 없음)'}`);
    }
    return parsed;
  }

  private async fetchBuffer(path: string, params: Record<string, string | number>): Promise<Buffer> {
    const url = this.buildUrl(path, params);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (cause) {
      throw new CameraDriverError(`카메라 통신 실패: ${this.mask(cause)}`, 502, { cause });
    }
    if (!response.ok) {
      throw new CameraDriverError(`카메라 HTTP ${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private buildUrl(path: string, params: Record<string, string | number>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('id', this.options.username);
    url.searchParams.set('passwd', this.options.password);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return url.toString();
  }

  /** 오류 문구에 비밀번호가 실려 로그로 새는 것을 막는다. */
  private mask(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return this.options.password ? message.replaceAll(this.options.password, '***') : message;
  }
}
