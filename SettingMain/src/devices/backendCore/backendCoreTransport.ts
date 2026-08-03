import { CameraDriverError } from '../cameraDriver.js';

/**
 * backend-core 와 말을 주고받는 **전송 계층**.
 *
 * 이것을 인터페이스로 뽑아 둔 이유는 하나다 — 코어 계약(`CoreProvider`)은 전송과 무관해야
 * 하기 때문이다. 지금은 HTTP REST 하나뿐이지만, 나중에 MCP 도구를 경유하게 되어도
 * 이 인터페이스를 채우는 어댑터를 하나 더 만들면 되고 상위 계층은 바뀌지 않는다.
 */
export interface BackendCoreTransport {
  readonly baseUrl: string;
  json<T>(method: string, path: string, body?: unknown): Promise<T>;
  binary(method: string, path: string): Promise<Buffer>;
}

export interface HttpBackendCoreTransportOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class HttpBackendCoreTransport implements BackendCoreTransport {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpBackendCoreTransportOptions) {
    if (!options.baseUrl) throw new CameraDriverError('시뮬레이터 URL 이 설정되지 않았습니다 (옵션 페이지에서 입력하세요)', 400);
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.send(method, path, body);
    const text = await response.text();
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new CameraDriverError(`backend-core 응답이 JSON 이 아닙니다: ${path}`, 502, { cause });
    }
  }

  async binary(method: string, path: string): Promise<Buffer> {
    const response = await this.send(method, path);
    return Buffer.from(await response.arrayBuffer());
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
      // 501·409·422 는 "이 기기는 그것을 하지 않는다/지금은 안 된다"는 확정 답이다 —
      // 상위가 일시 장애로 보고 재시도하지 않도록 코드를 보존한다.
      const detail = await response.text().catch(() => '');
      const isHtml = response.headers.get('content-type')?.toLowerCase().includes('text/html')
        || /^\s*<!doctype html|^\s*<html/i.test(detail);
      const message = isHtml
        ? `backend-core endpoint ${this.safeEndpoint(path)}가 HTML HTTP ${response.status}을 반환했습니다. 이 카메라의 제어 URL은 BackendCore API 기준 URL이어야 하며 Hucoms CGI 또는 RTSP URL이 아닙니다.`
        : `backend-core HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
      throw new CameraDriverError(message, [409, 422, 501].includes(response.status) ? response.status : 502);
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
