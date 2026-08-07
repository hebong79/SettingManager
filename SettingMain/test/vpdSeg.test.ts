import { describe, expect, it } from 'vitest';
import { VpdSegClient } from '../src/detectors/vpdSegClient.js';
import { DetectorError } from '../src/detectors/detectorTypes.js';

/**
 * VPD 세그멘테이션 계약. 응답 모양은 **2026-08-07 라이브 실측**에서 왔다
 * (192.168.0.125:9081, 시뮬레이터 스냅샷 1장 → 차량 4대, `masks[0]` 417점).
 */

function reply(body: unknown, status = 201): typeof fetch {
  return (async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
}

const client = (fetchImpl: typeof fetch) => new VpdSegClient({ baseUrl: 'http://sidecar:9081', timeoutMs: 1000, fetchImpl });

describe('VpdSegClient', () => {
  it('세그 경로로 간다 — 검출 경로는 masks 를 비워 보낸다', async () => {
    let seen = '';
    const spy = (async (url: string) => {
      seen = String(url);
      return new Response(JSON.stringify({ success: true, id: 1, bboxes: [], masks: [], confidences: [], classes: [] }), { status: 201 });
    }) as unknown as typeof fetch;
    await client(spy).detect(Buffer.from([0xff, 0xd8]));
    expect(seen).toBe('http://sidecar:9081/vpd/api/v2/seg/imgupload');
  });

  it('윤곽 폴리곤을 점 개수 제한 없이 싣는다', async () => {
    const mask = Array.from({ length: 417 }, (_, i) => [i, i * 2]);
    const result = await client(reply({
      success: true, id: 1,
      bboxes: [[2, 177, 613, 571]],
      masks: [mask],
      confidences: [0.95],
      classes: ['car'],
    })).detect(Buffer.alloc(2));

    expect(result.detections).toHaveLength(1);
    expect(result.detections[0]!.bbox).toEqual([2, 177, 613, 571]);
    expect(result.detections[0]!.polygon).toHaveLength(417);
    expect(result.detections[0]!.polygon![0]).toEqual({ x: 0, y: 0 });
    expect(result.detections[0]!.className).toBe('car');
  });

  /**
   * 면적이 없는 마스크는 "안쪽"을 판정할 수 없다. 남겨 두면 점-내부 판정이 언제나 false 라서
   * **"차량이 없다"와 구별되지 않는다.**
   */
  it('3점 미만 마스크는 버린다 — 면적이 없으면 안쪽을 물을 수 없다', async () => {
    const result = await client(reply({
      success: true, id: 1,
      bboxes: [[0, 0, 10, 10]],
      masks: [[[1, 1], [2, 2]]],
      confidences: [0.9],
      classes: ['car'],
    })).detect(Buffer.alloc(2));
    expect(result.detections[0]!.polygon).toBeUndefined();
    expect(result.detections[0]!.bbox).toEqual([0, 0, 10, 10]);
  });

  it('숫자가 아닌 점이 섞이면 그 마스크를 통째로 버린다 — 반쪽 윤곽은 엉뚱한 안쪽을 만든다', async () => {
    const result = await client(reply({
      success: true, id: 1,
      bboxes: [[0, 0, 10, 10]],
      masks: [[[1, 1], ['x', 2], [3, 3]]],
      confidences: [0.9],
      classes: ['car'],
    })).detect(Buffer.alloc(2));
    expect(result.detections[0]!.polygon).toBeUndefined();
  });

  it('상자와 마스크 개수가 다르면 짝이 맞는 만큼만 싣는다', async () => {
    const square = [[0, 0], [4, 0], [4, 4], [0, 4]];
    const result = await client(reply({
      success: true, id: 1,
      bboxes: [[0, 0, 4, 4], [5, 5, 9, 9], [10, 10, 14, 14]],
      masks: [square, square],
      confidences: [0.9, 0.8, 0.7],
      classes: ['car', 'car', 'car'],
    })).detect(Buffer.alloc(2));
    expect(result.detections).toHaveLength(2);
  });

  it('상류 오류는 원문을 실어 던진다 — 어디로 갔는지 모르는 실패를 만들지 않는다', async () => {
    const fail = (async () => new Response('upstream exploded', { status: 500 })) as unknown as typeof fetch;
    await expect(client(fail).detect(Buffer.alloc(2))).rejects.toThrow(DetectorError);
    await expect(client(fail).detect(Buffer.alloc(2))).rejects.toThrow(/upstream exploded/);
  });
});
