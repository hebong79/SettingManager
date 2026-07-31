import type { IncomingMessage, ServerResponse } from 'node:http';

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/** 요청 본문 JSON. 비어 있으면 빈 객체다(본문 없는 POST 를 오류로 만들지 않는다). */
export async function readJsonBody(req: IncomingMessage, limitBytes = 256 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new HttpError(413, '요청 본문이 너무 큽니다');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  // Node 의 utf8 디코드는 잘못된 바이트를 조용히 U+FFFD 로 바꾼다. 그대로 저장하면 설정 파일에
  // 깨진 한글이 영구히 남는다(CP949 로 보내는 클라이언트에서 실제로 겪음). 받는 자리에서 끊는다.
  if (text.includes('�')) {
    throw new HttpError(400, '요청 본문이 UTF-8 이 아닙니다 — 한글이 깨진 채 저장되는 것을 막기 위해 거부합니다');
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('object 가 아닙니다');
    return parsed as Record<string, unknown>;
  } catch (cause) {
    throw new HttpError(400, `요청 본문 JSON 파싱 실패: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** 숫자 필드를 엄격하게 읽는다. 없는 값을 0 으로 대체하면 카메라가 원점으로 간다. */
export function requireNumber(body: Record<string, unknown>, key: string): number {
  const value = Number(body[key]);
  if (!Number.isFinite(value)) throw new HttpError(400, `${key} 는 숫자여야 합니다`);
  return value;
}

export function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  if (body[key] === undefined || body[key] === null || body[key] === '') return undefined;
  return requireNumber(body, key);
}

export function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${key} 가 필요합니다`);
  return value.trim();
}
