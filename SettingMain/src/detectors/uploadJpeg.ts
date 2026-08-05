import { DetectorError, type DetectorName } from './detectorTypes.js';
import { multipartFile } from './multipart.js';

/**
 * VPD·LPD 가 공유하는 업로드 경로. 둘 다 FastAPI 의 `UploadFile file` 을 받고 **201** 로 답한다
 * (근거: `Sub/vpd_api/routers/yolo.py:32-37`, `Sub/lpd_api/routers/yolo.py:33-38`).
 */

export interface UploadOptions {
  detector: DetectorName;
  baseUrl: string;
  path: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** 테스트가 본문을 단정할 수 있도록 고정한다(§multipart.ts 참조). */
const BOUNDARY = 'settingmanager-detector';

export async function uploadJpeg(options: UploadOptions, image: Buffer): Promise<Record<string, unknown>> {
  const url = `${options.baseUrl}${options.path}`;
  const { contentType, body } = multipartFile(
    { field: 'file', filename: 'snapshot.jpg', contentType: 'image/jpeg', data: image },
    BOUNDARY,
  );

  const call = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await call(url, {
      method: 'POST',
      headers: { 'content-type': contentType, accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (cause) {
    throw new DetectorError(`${options.detector} 통신 실패 (${url}): ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  // 본문은 한 번만 읽을 수 있다 — 상태코드 분기 전에 확보해 두지 않으면 오류 사유를 잃는다.
  const text = await res.text();
  if (!res.ok) {
    // 상류의 상태코드를 그대로 되돌리지 않는다 — 그쪽 404 는 이쪽 경로가 없다는 뜻이 아니다.
    throw new DetectorError(`${options.detector} HTTP ${res.status} (${url}): ${text.slice(0, 200)}`);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('object 가 아닙니다');
    return parsed as Record<string, unknown>;
  } catch (cause) {
    throw new DetectorError(`${options.detector} 응답이 JSON 이 아닙니다 (${url}): ${text.slice(0, 200)}`);
  }
}

/** 상류가 준 배열만 배열로 본다. 숫자 자리에 문자열이 오면 그대로 두지 않고 숫자로 읽는다. */
export function numberPairs(raw: unknown): number[][] {
  return Array.isArray(raw) ? raw.map((row) => (Array.isArray(row) ? row.map(Number) : [])) : [];
}
