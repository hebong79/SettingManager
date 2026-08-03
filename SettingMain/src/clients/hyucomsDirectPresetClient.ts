import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { CameraDriverError, type DevicePresetCapability } from './cameraDriver.js';
import type { PtzRaw } from '../domain/ptz.js';
import { parseHucomsText } from './hucomsText.js';

const CAPABILITY_PATH = '/cgi-bin/control/capabilityptz.cgi';
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface HyucomsDirectPresetClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
}

/**
 * Hucoms 장비 프리셋 전용 native HTTP 전송 경계다.
 * 일부 장비가 LF-only header를 보내므로 insecureHTTPParser는 이 클래스 요청에만 한정한다.
 */
export class HyucomsDirectPresetClient {
  private readonly endpoint: URL;

  constructor(private readonly options: HyucomsDirectPresetClientOptions) {
    this.endpoint = capabilityUrl(options);
  }

  async getCapability(): Promise<DevicePresetCapability> {
    const text = await this.getText(CAPABILITY_PATH, { action: 'getPTZ' });
    const response = parseHucomsText(text);
    if (response.errorMessage !== undefined) {
      throw new CameraDriverError(`카메라가 오류를 반환했습니다: ${this.redact(response.errorMessage) || '(사유 없음)'}`);
    }
    const raw = response.values.PresetSupported;
    if (raw === 'No') return unsupportedCapability();
    if (raw === 'Yes') return supportedCapability(null, 255);
    if (raw !== undefined && /^(?:[1-9]|[1-9]\d|1\d\d|2(?:[0-4]\d|5[0-5]))$/.test(raw)) {
      const maximum = Number(raw);
      return supportedCapability(maximum, Math.min(maximum, 255));
    }
    throw new CameraDriverError('Hucoms PresetSupported capability 응답이 계약과 다릅니다');
  }

  async goPreset(number: number): Promise<void> {
    assertPresetNumber(number);
    await this.requireSuccess(await this.getText('/cgi-bin/control/preset_control.cgi', { action: 'gopreset', number: String(number) }));
  }

  async getPtz(): Promise<PtzRaw> {
    const response = parseHucomsText(await this.getText('/cgi-bin/control/ptzf_status.cgi', { action: 'getptzfpos' }));
    if (response.errorMessage !== undefined) throw new CameraDriverError(`카메라가 오류를 반환했습니다: ${this.redact(response.errorMessage) || '(사유 없음)'}`);
    return {
      pan: requiredInteger(response.values.panpos, 'panpos'),
      tilt: requiredInteger(response.values.tiltpos, 'tiltpos'),
      zoom: requiredInteger(response.values.zoompos, 'zoompos'),
    };
  }

  async goPtz(ptz: PtzRaw): Promise<void> {
    validatePtz(ptz);
    await this.requireSuccess(await this.getText('/cgi-bin/control/ptzf_status.cgi', {
      // 0은 일부 실장비에서 정지/무이동으로 해석된다. 일반 HucomsClient의 기본값과 같은 50을 쓴다.
      action: 'goptzfpos', panpos: String(ptz.pan), tiltpos: String(ptz.tilt), zoompos: String(ptz.zoom), panspeed: '50', tiltspeed: '50', zoomspeed: '50',
    }));
  }

  private async requireSuccess(text: string): Promise<void> {
    const response = parseHucomsText(text);
    if (response.errorMessage !== undefined) throw new CameraDriverError(`카메라가 오류를 반환했습니다: ${this.redact(response.errorMessage) || '(사유 없음)'}`);
  }

  private getText(path: string, query: Record<string, string>): Promise<string> {
    const endpoint = new URL(this.endpoint);
    endpoint.pathname = path;
    endpoint.search = '';
    endpoint.searchParams.set('id', this.options.username);
    endpoint.searchParams.set('passwd', this.options.password);
    for (const [key, value] of Object.entries(query)) endpoint.searchParams.set(key, value);
    const requestFn = endpoint.protocol === 'http:' ? httpRequest : httpsRequest;
    return new Promise((resolve, reject) => {
      let done = false;
      const fail = (error: unknown): void => {
        if (done) return;
        done = true;
        const message = this.redact(error);
        reject(new CameraDriverError(`카메라 통신 실패: ${message}`, 502, { cause: new Error(message) }));
      };
      const request = requestFn({
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port || undefined,
        method: 'GET',
        path: `${endpoint.pathname}${endpoint.search}`,
        headers: { accept: 'text/plain' },
        insecureHTTPParser: true,
      }, (response: IncomingMessage) => {
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
          response.resume();
          fail(new Error(`HTTP ${response.statusCode ?? 0}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy(new Error('응답 본문이 허용 크기를 초과했습니다'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', fail);
        response.once('end', () => {
          if (done) return;
          done = true;
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
      });
      request.setTimeout(this.options.timeoutMs, () => request.destroy(new Error('요청 시간이 초과되었습니다')));
      request.once('error', fail);
      request.end();
    });
  }

  private redact(error: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of [this.options.password, encodeURIComponent(this.options.password)]) {
      if (secret) message = message.replaceAll(secret, '***');
    }
    return message.replace(/([?&]passwd=)[^&\s]*/gi, '$1***');
  }
}

function capabilityUrl(options: HyucomsDirectPresetClientOptions): URL {
  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch (cause) {
    throw new CameraDriverError('제어 URL 이 올바르지 않습니다', 400, { cause });
  }
  if ((base.protocol !== 'http:' && base.protocol !== 'https:') || base.username || base.password || base.search || base.hash) {
    throw new CameraDriverError('제어 URL 은 인증·query·fragment 없는 http(s) 주소여야 합니다', 400);
  }
  const endpoint = new URL(base.origin);
  return endpoint;
}

function assertPresetNumber(number: number): void {
  if (!Number.isInteger(number) || number < 1 || number > 255) throw new CameraDriverError('장비 프리셋 번호는 1..255 정수여야 합니다', 400);
}

function requiredInteger(raw: string | undefined, name: string): number {
  if (raw === undefined || !/^-?\d+$/.test(raw)) throw new CameraDriverError(`Hucoms ${name} 응답이 정수가 아닙니다`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new CameraDriverError(`Hucoms ${name} 응답이 안전한 정수가 아닙니다`);
  return value;
}

function validatePtz(ptz: PtzRaw): void {
  if (!Number.isInteger(ptz.pan) || ptz.pan < 0 || ptz.pan > 35999
    || !Number.isInteger(ptz.tilt) || ptz.tilt < -2000 || ptz.tilt > 9000
    || !Number.isInteger(ptz.zoom) || ptz.zoom < 0 || ptz.zoom > 65535) {
    throw new CameraDriverError('Hucoms PTZ 좌표가 허용 raw 범위를 벗어났습니다', 400);
  }
}

function supportedCapability(advertisedMaxPresetNumber: number | null, usableMaxPresetNumber: number): DevicePresetCapability {
  return {
    supported: true,
    advertisedMaxPresetNumber,
    usableMaxPresetNumber,
    listing: 'unsupported',
    naming: 'unsupported',
    slots: Array.from({ length: usableMaxPresetNumber }, (_, offset) => ({ index: offset + 1, registration: 'unknown' as const, name: null })),
  };
}

function unsupportedCapability(): DevicePresetCapability {
  return { supported: false, advertisedMaxPresetNumber: null, usableMaxPresetNumber: 0, listing: 'unsupported', naming: 'unsupported', slots: [] };
}
