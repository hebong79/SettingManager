import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { CameraDriverError } from './contract.js';
import { buildBasicHeader, buildDigestHeader } from './digest.js';

/**
 * 카메라용 HTTP 전송 — 요청별 TLS · 연결까지 덮는 마감 · Digest/Basic 인증.
 *
 * 실기에서 겪은 세 사고의 결론이 여기 모여 있다.
 *
 * 1. **`fetch` 가 아니라 `node:http`/`node:https` 인 이유는 요청별 TLS 옵션이다.** Node 의
 *    `fetch` 는 그것을 받지 못해 자체서명 인증서 기기에 검증을 끄려면 프로세스 전역
 *    `NODE_TLS_REJECT_UNAUTHORIZED` 뿐인데, 그건 이 서비스 **전체**의 검증을 끈다.
 *    의존성도 늘지 않는다(`node:http`·`node:https`·`node:crypto` 만 쓴다).
 *
 * 2. **마감은 명시적 `setTimeout` 이다.** `req.setTimeout` 은 소켓 *유휴* 타임아웃이라 TCP
 *    연결 수립 중에는 걸리지 않는다 — 도달 불가 주소에서 설정값과 무관하게 OS 기본
 *    (실측 5초)까지 붙잡히면서 오류 메시지는 설정값이 지난 것처럼 거짓말했다 `[실측]`.
 *    연결+응답 전체를 하나의 타이머가 덮는다.
 *
 * 3. **전송 실패는 `IdisTransportError` 로 던진다.** 능력 프로브가 "기기에 못 닿았다" 를
 *    "그 기능이 없다" 로 기록하면 멀쩡한 카메라가 영구히 불구로 저장된다 — 자체서명 인증서
 *    하나 때문에 `snapshot:false`·`presets:false` 가 실측 결과로 남을 뻔한 사고가 실제로
 *    있었다 `[실측]`.
 */

/** 텍스트 응답 상한. `[본체 hucomsPresetClient.ts]` 의 관례와 같은 값이다. */
export const MAX_TEXT_BYTES = 64 * 1024;
/** 스냅샷은 JPEG 바이너리라 상한을 따로 둔다. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface IdisRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** `application/x-www-form-urlencoded` 본문. POST 에서만 쓴다. */
  body?: string;
  timeoutMs: number;
  /** `false` 면 이 요청 하나에 한해 TLS 검증을 끈다. 프로세스 전역을 건드리지 않는다. */
  rejectUnauthorized?: boolean;
  maxBytes?: number;
}

export interface IdisResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/**
 * **기기에 못 닿았다 — 능력 부재가 아니다.** 능력 프로브는 이 오류를 만나면 능력을 낮추지
 * 않고 그대로 올린다. `CameraDriverError` 를 상속하므로 상위 계층에서는 평범한 502 다.
 */
export class IdisTransportError extends CameraDriverError {
  readonly transport = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 502, options);
    this.name = 'IdisTransportError';
  }
}

export function isTransportError(error: unknown): error is IdisTransportError {
  return error instanceof IdisTransportError;
}

/** 인증 없이 한 번 보낸다. 마감·TLS·본문 상한이 여기서 걸린다. */
export function rawRequest(url: URL, options: IdisRequestOptions): Promise<IdisResponse> {
  const { method = 'GET', body, timeoutMs, rejectUnauthorized = true, maxBytes = MAX_TEXT_BYTES } = options;
  return new Promise<IdisResponse>((resolve, reject) => {
    const secure = url.protocol === 'https:';
    const send = secure ? httpsRequest : httpRequest;
    const headers: Record<string, string> = { ...options.headers };
    if (body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(body));
    const requestOptions: RequestOptions = { method, headers };
    if (secure) requestOptions.rejectUnauthorized = rejectUnauthorized;

    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      run();
    };
    const fail = (cause: unknown, hint: string): void => {
      const detail = cause instanceof Error ? cause.message : String(cause);
      finish(() => reject(new IdisTransportError(`${hint}: ${detail}`, { cause })));
    };

    const req = send(url, requestOptions, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy(new Error(`응답 본문이 허용 크기(${maxBytes} 바이트)를 초과했습니다`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', (error) => fail(error, `${url.host} 응답 수신 중 오류`));
      res.on('end', () => finish(() => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })));
    });

    // **연결 수립 중에도 도는 타이머.** `req.setTimeout` 으로 바꾸면 도달 불가 주소에서
    // 이 값이 지켜지지 않는다(위 머리말 2번).
    timer = setTimeout(() => {
      req.destroy(new Error(`${timeoutMs}ms 안에 응답이 없습니다`));
    }, timeoutMs);

    req.on('error', (error: NodeJS.ErrnoException) => {
      // 자체서명 인증서는 가장 흔한 실패라 무엇을 해야 하는지까지 말해 준다.
      const selfSigned = /SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(error.code ?? error.message ?? '');
      fail(error, selfSigned
        ? `${url.host} 의 TLS 인증서를 검증할 수 없습니다 (이 기기의 설정에서 insecure_tls 를 켜면 이 기기에 한해 검증을 끕니다)`
        : `${url.host} 연결 실패`);
    });

    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * 먼저 인증 없이 보내고, 401 이 오면 **기기가 요구한 방식**으로 한 번만 재시도한다.
 *
 * 방식을 우리가 고르지 않는 이유: 같은 벤더 안에서도 갈린다 — 실측 IDIS 는 Digest 만 받는다.
 * 우리가 모르는 방식이면 **임의로 Basic 을 시도하지 않고 401 을 그대로 올린다**(호출부가
 * 상태로 판단한다).
 */
export async function authorizedRequest(
  url: URL,
  options: IdisRequestOptions,
  username: string,
  password: string,
): Promise<IdisResponse> {
  const first = await rawRequest(url, options);
  if (first.status !== 401) return first;

  const challenge = first.headers['www-authenticate'] ?? '';
  const header = Array.isArray(challenge) ? (challenge[0] ?? '') : challenge;
  // Digest 의 uri 는 path+query 여야 하고, HA2 와 `uri=` 에 **같은 값**이 들어가야 한다.
  const uri = url.pathname + (url.search || '');
  const method = options.method ?? 'GET';

  let authorization: string;
  if (/^digest/i.test(header)) {
    authorization = buildDigestHeader({ header, method, uri, username, password });
  } else if (/^basic/i.test(header)) {
    authorization = buildBasicHeader({ username, password });
  } else {
    return first;
  }

  return rawRequest(url, { ...options, headers: { ...options.headers, Authorization: authorization } });
}
