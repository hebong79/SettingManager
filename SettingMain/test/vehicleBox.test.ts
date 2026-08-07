import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.js';
import { Object3dClient } from '../src/vehiclebox/object3dClient.js';
import { VehicleBoxComponent } from '../src/vehiclebox/vehicleBoxComponent.js';
import { VehicleBoxStore } from '../src/vehiclebox/vehicleBoxStore.js';
import type { CameraConfig } from '../src/config/types.js';
import type { CameraDriver } from '../src/devices/cameraDriver.js';

/**
 * 차량 3D 육면체 — **사이드카를 소비하고, 남기고, 그릴 수 있게 준다.**
 *
 * 여기서 지키는 것 셋:
 *   ① 측정값은 **사이드카 어휘 그대로** 지나간다(개명하면 대조가 안 된다)
 *   ② `segments` 개수를 **가정하지 않는다**(12개가 아닐 수 있다)
 *   ③ 오류 `code` 를 뭉개지 않는다("파일 하나 없음"이 "서비스 죽음"으로 보고되면 안 된다)
 */

let db: DatabaseSync;

const CAMERA: CameraConfig = {
  id: 'cam-a', label: 'cam-a', kind: 'hucoms', controlUrl: 'http://10.0.0.1',
  username: 'u', password: 'p', streamUrl: '', timeoutMs: 2000,
};

const DRIVER: CameraDriver = {
  cameraId: 'cam-a',
  kind: 'fake',
  async getPtz() { return { pan: 12_000, tilt: 1_681, zoom: 8000 }; },
  async goPtz() {},
  async getSnapshot() { return Buffer.from([0xff, 0xd8]); },
  async listSlots() { return []; },
};

/** 실제 사이드카 응답 모양. 근거: `baro_object3d_api/README.md`. */
const SIDECAR_BODY = {
  detections: [{
    label: 'car',
    score: 0.87,
    score_3d: null,                       // 이 모델은 늘 null 이다
    label_point: [640, 380],
    // **큐보이드는 12모서리지만 항상 12개가 오지는 않는다** — 화면 밖으로 날아간 모서리는
    // 개별적으로 버려진다. 여기서는 7개만 왔다고 둔다.
    segments: [[10, 20, 30, 40], [30, 40, 50, 60], [50, 60, 70, 80], [70, 80, 90, 100], [90, 100, 110, 120], [110, 120, 130, 140], [130, 140, 150, 160]],
    position_m: [12.4, -3.1],
    size_m: [4.6, 1.9, 1.5],
    yaw_deg: 91.2,
  }],
  calibration: { status: 'calibrated', intrinsics: { fx: 1200 } },
  model_id: 'object3d-primary',
  total_ms: 42,
};

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  db.prepare(`INSERT INTO camera_info (cam_id, cam_name, cam_uuid, place_id) VALUES (1, 'cam-a', 'cam-a', 1)`).run();
});

afterEach(() => {
  db.close();
});

function componentWith(fetchImpl: typeof fetch): VehicleBoxComponent {
  return new VehicleBoxComponent({
    client: new Object3dClient({ baseUrl: 'http://127.0.0.1:9070', model: 'object3d-primary', timeoutMs: 5000, fetchImpl }),
    storeFor: (cameraId) => new VehicleBoxStore(db, cameraId),
  });
}

describe('사이드카 소비 — 어휘의 경계', () => {
  it('봉투는 우리 어휘, 측정값은 사이드카 어휘 그대로다', async () => {
    const result = await componentWith(vi.fn(async () => new Response(JSON.stringify(SIDECAR_BODY))) as unknown as typeof fetch)
      .detect(CAMERA, DRIVER);

    // 봉투 — 우리가 정한 이름
    expect(result).toMatchObject({ cameraId: 'cam-a', count: 1, model: 'object3d-primary', latencyMs: 42, source: 'object3d' });
    // 측정값 — 개명하지 않는다. `position_m` 을 우리 취향으로 바꾸면 사이드카 로그·오프라인
    // 도구와 대조가 안 되고 좌표계 규약이 두 벌이 된다.
    expect(result.detections[0]).toMatchObject({ position_m: [12.4, -3.1], size_m: [4.6, 1.9, 1.5], yaw_deg: 91.2 });
    // **무엇을 기준으로 잰 값인지가 곧 값의 의미다** — 함께 나가야 한다.
    expect(result.calibration).toMatchObject({ status: 'calibrated' });
  });

  it('segments 개수를 가정하지 않는다 — 12개가 아닐 수 있다', async () => {
    const result = await componentWith(vi.fn(async () => new Response(JSON.stringify(SIDECAR_BODY))) as unknown as typeof fetch)
      .detect(CAMERA, DRIVER);
    const segments = (result.detections[0] as { segments: number[][] }).segments;
    // 그리는 쪽은 받은 선분만 이으면 된다. 12를 기대하고 인덱스로 면을 재구성하면 조용히 깨진다.
    expect(segments).toHaveLength(7);
  });

  it('카메라를 움직이지 않는다 — 그래서 점유하지도 않는다', async () => {
    const goPtz = vi.fn();
    await componentWith(vi.fn(async () => new Response(JSON.stringify(SIDECAR_BODY))) as unknown as typeof fetch)
      .detect(CAMERA, { ...DRIVER, goPtz });
    expect(goPtz).not.toHaveBeenCalled();
  });
});

describe('오류 code 를 뭉개지 않는다', () => {
  it('no_calibration 은 422 이고 **어느 파일**인지까지 말한다 — 운영자가 5분이면 고친다', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ detail: { code: 'no_calibration', message: '없음' } }), { status: 422 }));
    await expect(componentWith(fetchImpl as unknown as typeof fetch).detect(CAMERA, DRIVER))
      .rejects.toMatchObject({ statusCode: 422, code: 'no_calibration' });
  });

  it('model_unavailable 은 501 — 재시도해 봐야 같은 답이 오는 **확정 답**이다', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ detail: { code: 'model_unavailable', message: '준비 안 됨' } }), { status: 503 }));
    await expect(componentWith(fetchImpl as unknown as typeof fetch).detect(CAMERA, DRIVER))
      .rejects.toMatchObject({ statusCode: 501, code: 'model_unavailable' });
  });

  it('overloaded 는 502 — 재시도할 가치가 있는 것과 없는 것을 가른다', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ detail: { code: 'overloaded', message: '큐가 참' } }), { status: 503 }));
    await expect(componentWith(fetchImpl as unknown as typeof fetch).detect(CAMERA, DRIVER))
      .rejects.toMatchObject({ statusCode: 502, code: 'overloaded' });
  });

  it('닿지 못한 것은 상태 조회에서 **오류가 아니라 사실**이다', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const status = await componentWith(fetchImpl as unknown as typeof fetch).status(CAMERA);
    // 상태를 묻는 질문에 오류로 답하면 화면이 "모른다"와 "안 됐다"를 구별할 수 없다.
    expect(status).toMatchObject({ configured: true, ready: false });
  });

  it('사이드카가 설정되지 않았으면 상태가 **무엇을 채워야 하는지** 말한다', async () => {
    const status = await new VehicleBoxComponent().status(CAMERA);
    expect(status).toMatchObject({ configured: false, ready: false });
    expect(String(status.reason)).toContain('object3d.baseUrl');
  });
});

describe('영속화 — 상류에 없는 것', () => {
  it('검출·자세·캘리브레이션을 함께 남기고 다시 읽는다', async () => {
    const component = componentWith(vi.fn(async () => new Response(JSON.stringify(SIDECAR_BODY))) as unknown as typeof fetch);
    const result = await component.detect(CAMERA, DRIVER);
    expect(result.detectId).toBe(1);

    const [record] = component.history(CAMERA);
    expect(record).toMatchObject({
      cameraId: 'cam-a',
      count: 1,
      model: 'object3d-primary',
      latencyMs: 42,
      // 자세 없이는 같은 그림을 다시 못 본다.
      ptz: { pan: 12_000, tilt: 1_681, zoom: 8000 },
    });
    expect((record!.detections[0] as { yaw_deg: number }).yaw_deg).toBe(91.2);
    expect(record!.calibration).toMatchObject({ status: 'calibrated' });
  });

  it('최근 것부터 준다', () => {
    const store = new VehicleBoxStore(db, 'cam-a');
    store.save({ capturedAt: '2026-08-07T00:00:00Z', ptz: null, model: null, latencyMs: null, detections: [], calibration: null });
    store.save({ capturedAt: '2026-08-07T00:01:00Z', ptz: null, model: null, latencyMs: null, detections: [{ label: 'car' }], calibration: null });
    expect(store.list().map((r) => r.count)).toEqual([1, 0]);
  });

  it('등록되지 않은 기기의 검출은 버리되 **던지지는 않는다** — 저장 실패가 측정을 삼키면 안 된다', () => {
    const store = new VehicleBoxStore(db, 'ghost');
    expect(store.save({ capturedAt: 'x', ptz: null, model: null, latencyMs: null, detections: [], calibration: null })).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('저장소가 없어도 검출은 된다 — 저장은 부가가치이지 검출의 조건이 아니다', async () => {
    const component = new VehicleBoxComponent({
      client: new Object3dClient({
        baseUrl: 'http://127.0.0.1:9070', model: 'object3d-primary', timeoutMs: 5000,
        fetchImpl: vi.fn(async () => new Response(JSON.stringify(SIDECAR_BODY))) as unknown as typeof fetch,
      }),
    });
    const result = await component.detect(CAMERA, DRIVER);
    expect(result.count).toBe(1);
    expect(result.detectId).toBeNull();
  });
});
