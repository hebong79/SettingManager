import { describe, expect, it, vi } from 'vitest';
import { normalizeDetectors } from '../src/config/normalize.js';
import { createDetector, detectorUnavailableReason } from '../src/detectors/detectorFactory.js';
import { DetectorError, DetectorUnsupportedError } from '../src/detectors/detectorTypes.js';
import { LpdClient } from '../src/detectors/lpdClient.js';
import { VpdClient } from '../src/detectors/vpdClient.js';
import type { AppConfig } from '../src/config/types.js';

/**
 * 모킹 응답은 **상류 소스의 예시 그대로** 쓴다 — 상상해서 만든 모킹은 통과해도 아무것도 증명하지 못한다.
 *   VPD: `Sub/vpd_api/routers/yolo.py:56-74` docstring 의 Example Return + `schemas/yolo.py`
 *   LPD: `Sub/lpd_api/routers/yolo.py:57-77` docstring 의 Example Return + `schemas/yolo.py:12-15`
 */

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function stubFetch(status: number, body: unknown, contentType = 'application/json') {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'content-type': contentType } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** 실제 상류 응답(201)과 같은 형태. */
const VPD_BODY = {
  success: true,
  id: 1,
  bboxes: [[551.580322265625, 358.8811340332031, 1084.7222900390625, 452.9200744628906]],
  masks: [],
  confidences: [0.9543854594230652],
  classes: ['car'],
};

const LPD_BODY = {
  success: true,
  id: 1,
  polygons: [[[551.58, 358.88], [1084.72, 360.1], [1082.0, 452.92], [549.1, 450.5]]],
  confidences: [0.9543854594230652],
  classes: ['car_license_plate'],
};

describe('VpdClient', () => {
  it('실측 경로로 multipart 를 보내고 bbox 를 매핑한다', async () => {
    const { fetchImpl, calls } = stubFetch(201, VPD_BODY);
    const result = await new VpdClient({ baseUrl: 'http://svc:8001', timeoutMs: 15_000, fetchImpl }).detect(JPEG);

    expect(calls[0]!.url).toBe('http://svc:8001/vpd/api/v2/det/imgupload');
    expect(calls[0]!.init.method).toBe('POST');
    expect(String((calls[0]!.init.headers as Record<string, string>)['content-type'])).toMatch(/^multipart\/form-data; boundary=/);

    expect(result).toEqual({
      detector: 'vpd',
      success: true,
      imageId: 1,
      detections: [
        {
          className: 'car',
          confidence: 0.9543854594230652,
          bbox: [551.580322265625, 358.8811340332031, 1084.7222900390625, 452.9200744628906],
        },
      ],
    });
  });

  it('보낸 본문에 FastAPI 가 요구하는 필드 이름 file 과 JPEG 원본이 그대로 들어 있다', async () => {
    const { fetchImpl, calls } = stubFetch(201, VPD_BODY);
    await new VpdClient({ baseUrl: 'http://svc:8001', timeoutMs: 1000, fetchImpl }).detect(JPEG);

    const body = Buffer.from(calls[0]!.init.body as Uint8Array);
    expect(body.toString('utf8')).toContain('name="file"; filename="snapshot.jpg"');
    expect(body.toString('utf8')).toContain('Content-Type: image/jpeg');
    expect(body.includes(JPEG)).toBe(true);
  });

  it('상자 값이 모자라면 그 검출에는 bbox 를 싣지 않는다 — 0 으로 채우지 않는다', async () => {
    const { fetchImpl } = stubFetch(201, { ...VPD_BODY, bboxes: [[1, 2]] });
    const result = await new VpdClient({ baseUrl: 'http://svc:8001', timeoutMs: 1000, fetchImpl }).detect(JPEG);
    expect(result.detections[0]).toEqual({ className: 'car', confidence: 0.9543854594230652 });
  });

  it('검출 0건도 오류가 아니다', async () => {
    const { fetchImpl } = stubFetch(201, { success: false, id: 3, bboxes: [], masks: [], confidences: [], classes: [] });
    const result = await new VpdClient({ baseUrl: 'http://svc:8001', timeoutMs: 1000, fetchImpl }).detect(JPEG);
    expect(result).toMatchObject({ success: false, imageId: 3, detections: [] });
  });

  it('상류 오류는 상태코드와 본문을 실어 502 로 던진다 — 조용히 빈 결과로 만들지 않는다', async () => {
    const { fetchImpl } = stubFetch(500, 'Internal Server Error', 'text/plain');
    const client = new VpdClient({ baseUrl: 'http://svc:8001', timeoutMs: 1000, fetchImpl });
    await expect(client.detect(JPEG)).rejects.toThrow(/vpd HTTP 500/);
    await expect(client.detect(JPEG)).rejects.toBeInstanceOf(DetectorError);
  });

  it('JSON 이 아닌 200 응답도 던진다 — 원문 앞부분을 보여 준다', async () => {
    const { fetchImpl } = stubFetch(200, '<html>proxy error</html>', 'text/html');
    const client = new VpdClient({ baseUrl: 'http://svc:8001', timeoutMs: 1000, fetchImpl });
    await expect(client.detect(JPEG)).rejects.toThrow(/JSON 이 아닙니다.*proxy error/s);
  });

  it('연결 자체가 실패하면 사유를 실어 던진다', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const client = new VpdClient({ baseUrl: 'http://svc:8001', timeoutMs: 1000, fetchImpl });
    await expect(client.detect(JPEG)).rejects.toThrow(/vpd 통신 실패.*ECONNREFUSED/);
  });
});

describe('LpdClient', () => {
  it('OBB 4점을 차례 그대로 옮긴다 (TL→TR→BR→BL)', async () => {
    const { fetchImpl, calls } = stubFetch(201, LPD_BODY);
    const result = await new LpdClient({ baseUrl: 'http://svc:8002', timeoutMs: 15_000, fetchImpl }).detect(JPEG);

    expect(calls[0]!.url).toBe('http://svc:8002/lpd/api/v1/imgupload');
    expect(result.detections).toEqual([
      {
        className: 'car_license_plate',
        confidence: 0.9543854594230652,
        polygon: [
          { x: 551.58, y: 358.88 },
          { x: 1084.72, y: 360.1 },
          { x: 1082.0, y: 452.92 },
          { x: 549.1, y: 450.5 },
        ],
      },
    ]);
  });

  it('4점이 아닌 폴리곤은 싣지 않는다 — 닫히지 않는 도형을 그리게 두지 않는다', async () => {
    const { fetchImpl } = stubFetch(201, { ...LPD_BODY, polygons: [[[1, 2], [3, 4], [5, 6]]] });
    const result = await new LpdClient({ baseUrl: 'http://svc:8002', timeoutMs: 1000, fetchImpl }).detect(JPEG);
    expect(result.detections[0]).toEqual({ className: 'car_license_plate', confidence: 0.9543854594230652 });
  });

  it('confidences 가 검출보다 짧으면 없는 자리를 0 으로 두고 짝을 밀지 않는다', async () => {
    const { fetchImpl } = stubFetch(201, {
      ...LPD_BODY,
      polygons: [LPD_BODY.polygons[0], LPD_BODY.polygons[0]],
      confidences: [0.9],
      classes: ['car_license_plate'],
    });
    const result = await new LpdClient({ baseUrl: 'http://svc:8002', timeoutMs: 1000, fetchImpl }).detect(JPEG);
    expect(result.detections.map((d) => d.confidence)).toEqual([0.9, 0]);
    expect(result.detections.map((d) => d.className)).toEqual(['car_license_plate', '']);
  });
});

describe('createDetector', () => {
  const configWith = (detectors: unknown): AppConfig => ({ detectors: normalizeDetectors(detectors) } as AppConfig);

  it('baseUrl 이 있으면 그 검출기를 만든다', () => {
    const config = configWith({ vpd: { baseUrl: 'http://svc:8001' }, lpd: { baseUrl: 'http://svc:8002' } });
    expect(createDetector('vpd', config).name).toBe('vpd');
    expect(createDetector('lpd', config).name).toBe('lpd');
  });

  it('baseUrl 이 비면 501 로 거절한다 — 빈 주소로 나가지 않는다', () => {
    const config = configWith({});
    expect(() => createDetector('vpd', config)).toThrow(DetectorUnsupportedError);
    expect(() => createDetector('vpd', config)).toThrow(/detectors.vpd.baseUrl/);
  });

  it('LPR 은 주소를 채워도 501 이다 — 설정이 아니라 구현이 없다', () => {
    const config = configWith({ lpr: { baseUrl: 'http://svc:8003' } });
    expect(() => createDetector('lpr', config)).toThrow(DetectorUnsupportedError);
    expect(() => createDetector('lpr', config)).toThrow(/구현이 없습니다/);
  });

  it('detectorUnavailableReason 이 createDetector 와 같은 판정을 한다 — 화면과 호출이 갈리지 않는다', () => {
    const config = configWith({ vpd: { baseUrl: 'http://svc:8001' }, lpr: { baseUrl: 'http://svc:8003' } });
    expect(detectorUnavailableReason('vpd', config)).toBeUndefined();
    expect(detectorUnavailableReason('lpd', config)).toMatch(/설정되지 않았습니다/);
    expect(detectorUnavailableReason('lpr', config)).toMatch(/구현이 없습니다/);
    for (const name of ['vpd', 'lpd', 'lpr'] as const) {
      const usable = detectorUnavailableReason(name, config) === undefined;
      // "쓸 수 있다"고 답한 것은 실제로 만들어지고, "못 쓴다"고 답한 것은 반드시 던진다.
      if (usable) expect(createDetector(name, config).name).toBe(name);
      else expect(() => createDetector(name, config)).toThrow(DetectorUnsupportedError);
    }
  });
});

describe('normalizeDetectors', () => {
  it('없으면 빈 주소 + 기본 타임아웃이다', () => {
    expect(normalizeDetectors(undefined)).toEqual({
      vpd: { baseUrl: '', timeoutMs: 15_000 },
      lpd: { baseUrl: '', timeoutMs: 15_000 },
      lpr: { baseUrl: '', timeoutMs: 15_000 },
    });
  });

  it('후행 슬래시를 떼어 경로가 겹치지 않게 한다', () => {
    expect(normalizeDetectors({ vpd: { baseUrl: 'http://svc:8001///' } }).vpd.baseUrl).toBe('http://svc:8001');
  });

  it('타임아웃은 범위 안으로 자른다', () => {
    expect(normalizeDetectors({ vpd: { timeoutMs: 1 } }).vpd.timeoutMs).toBe(500);
    expect(normalizeDetectors({ vpd: { timeoutMs: 999_999 } }).vpd.timeoutMs).toBe(120_000);
    expect(normalizeDetectors({ vpd: { timeoutMs: 'x' } }).vpd.timeoutMs).toBe(15_000);
  });
});
