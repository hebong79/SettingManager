import { splitJpegFrames } from './jpegFrames.js';

/**
 * HTTP 로 서빙되는 연속 MJPEG 를 프레임으로 끊어 낸다.
 *
 * UE 시뮬레이터는 RTSP 서버가 없고 `multipart/x-mixed-replace` 를 TCP 로 직접 서빙한다
 * (실측: `http://192.168.0.22:8091/` → 8초에 118프레임, boundary `baroframe`).
 * ffmpeg 를 거치지 않으므로 지연도 중복 프레임도 없다.
 *
 * **multipart 헤더를 파싱하지 않는다.** JPEG 의 SOI/EOI 로 끊으면 boundary 이름이
 * 무엇이든(`baroframe`·`baroworldboundary`…) 같은 코드로 동작하고, 파트 헤더는
 * SOI 앞의 바이트라 `splitJpegFrames` 가 알아서 버린다.
 */

export class HttpMjpegError extends Error {}

/**
 * 계정이 있고 URL 에 아직 없을 때만 Hucoms 평문 인증 파라미터를 붙인다.
 * CGI 경로(`/cgi-bin/…`)는 이것이 없으면 401 이고, 직결 MJPEG 포트는 쿼리를 무시한다.
 */
export function authenticatedHttpUrl(raw: string, username?: string, password?: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new HttpMjpegError('영상 URL 형식이 올바르지 않습니다', { cause });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new HttpMjpegError('HTTP 영상 URL 은 http:// 또는 https:// 여야 합니다');
  }
  if (username && !url.searchParams.has('id')) {
    url.searchParams.set('id', username);
    url.searchParams.set('passwd', password ?? '');
  }
  return url.toString();
}

/** 로그·오류 문구용. 비밀번호 쿼리를 가린다. */
export function safeHttpUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.searchParams.has('passwd')) url.searchParams.set('passwd', '***');
    return url.toString();
  } catch {
    return '<invalid-url>';
  }
}

export interface HttpMjpegOptions {
  url: string;
  username?: string;
  password?: string;
  startupTimeoutMs: number;
  fetchImpl?: typeof fetch;
}

export async function* httpMjpegFrames(options: HttpMjpegOptions, signal: AbortSignal): AsyncGenerator<Buffer> {
  if (signal.aborted) return;
  const url = authenticatedHttpUrl(options.url, options.username, options.password);
  const fetchImpl = options.fetchImpl ?? fetch;

  // 첫 프레임까지만 마감을 건다. 그 뒤로는 연속 스트림이라 전체 타임아웃을 걸면 안 된다.
  const startup = new AbortController();
  const onAbort = (): void => startup.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const startupTimer = setTimeout(() => startup.abort(), options.startupTimeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, { signal: startup.signal, headers: { accept: 'multipart/x-mixed-replace, image/jpeg' } });
  } catch (cause) {
    clearTimeout(startupTimer);
    signal.removeEventListener('abort', onAbort);
    if (signal.aborted) return;
    throw new HttpMjpegError(`영상 연결 실패: ${safeHttpUrl(url)}`, { cause });
  }
  clearTimeout(startupTimer);
  signal.removeEventListener('abort', onAbort);

  if (!response.ok) throw new HttpMjpegError(`영상 HTTP ${response.status} ${response.statusText}: ${safeHttpUrl(url)}`);
  if (!response.body) throw new HttpMjpegError('영상 응답에 본문이 없습니다');

  const reader = response.body.getReader();
  const abortRead = (): void => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', abortRead, { once: true });

  let rest: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || signal.aborted) return;
      const parsed = splitJpegFrames(Buffer.concat([rest, Buffer.from(value)]));
      rest = parsed.rest;
      for (const frame of parsed.frames) yield Buffer.from(frame);
    }
  } finally {
    signal.removeEventListener('abort', abortRead);
    await reader.cancel().catch(() => undefined);
  }
}
