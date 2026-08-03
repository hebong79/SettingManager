import { describe, expect, it, vi } from 'vitest';
import { BackendCoreClient } from '../src/devices/backendCore/backendCoreClient.js';
import { CameraDriverError } from '../src/devices/cameraDriver.js';

/**
 * 응답 shape 근거 — baro_calory/apps/backend-core/src/:
 *   control-api.mjs:262  GET /api/ptz → withFov(client.getPtzPosition()) = { panpos, tiltpos, zoompos, hfovDeg? }
 *   control-api.mjs:309  POST /api/ptz ← ptzCommandFields(body) = { panpos, tiltpos, zoompos, panspeed… }
 *   simulator-api.mjs    GET /api/simulator/slots → { slots: [{ id, label, occupied, carId }] }
 */

function client(fetchImpl: typeof fetch) {
  return new BackendCoreClient({ cameraId: 'sim-1', baseUrl: 'http://127.0.0.1:8080', timeoutMs: 3000, fetchImpl });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('BackendCoreClient.getPtz', () => {
  it('panpos·tiltpos·zoompos 를 계약 좌표로 읽는다', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({ panpos: 914, tiltpos: 2158, zoompos: 5140, hfovDeg: 34.05 }));
    await expect(client(fetchImpl as unknown as typeof fetch).getPtz()).resolves.toEqual({ pan: 914, tilt: 2158, zoom: 5140 });
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://127.0.0.1:8080/api/ptz');
  });

  it('좌표가 빠진 응답은 던진다 — 0 으로 대체하면 카메라가 원점으로 간다', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({ hfovDeg: 34 }));
    await expect(client(fetchImpl as unknown as typeof fetch).getPtz()).rejects.toThrow(/PTZ 좌표/);
  });
});

describe('BackendCoreClient.goPtz', () => {
  it('backend-core 필드명(panpos…)으로 POST 한다', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({ panpos: 1000, tiltpos: 500, zoompos: 8000 }));
    await client(fetchImpl as unknown as typeof fetch).goPtz({ pan: 1000, tilt: 500, zoom: 8000 }, 40);

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({ panpos: 1000, tiltpos: 500, zoompos: 8000, panspeed: 40 });
  });

  it('도달범위 밖 목표는 보내기 전에 자른다', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({}));
    await client(fetchImpl as unknown as typeof fetch).goPtz({ pan: -1, tilt: 12000, zoom: 99999 });
    expect(JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body))).toMatchObject({
      panpos: 35999,
      tiltpos: 9000,
      zoompos: 65535,
    });
  });
});

describe('BackendCoreClient.centerPoint', () => {
  it('BackendCore point-centering endpoint에 좌표를 POST 한다', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({ ok: true }));
    await client(fetchImpl as unknown as typeof fetch).centerPoint({ x: 1400, y: 800 });

    expect(fetchImpl.mock.calls[0]![0]).toBe('http://127.0.0.1:8080/api/center');
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ x: 1400, y: 800, frameWidth: 1920, frameHeight: 1080, speed: 50 });
  });
});

describe('BackendCoreClient.listSlots', () => {
  it('시뮬 씬의 슬롯을 목록으로 옮긴다', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ slots: [{ id: 'S1', label: 'A-1', occupied: true, carId: 'car-9' }, { id: 'S2', occupied: false }] }),
    );
    const slots = await client(fetchImpl as unknown as typeof fetch).listSlots();

    expect(fetchImpl.mock.calls[0]![0]).toBe('http://127.0.0.1:8080/api/simulator/slots');
    expect(slots[0]).toEqual({ id: 'S1', label: 'A-1', occupied: true, carId: 'car-9' });
    // label 이 없으면 id 로 채운다 — 화면에 빈 칸을 그리지 않는다.
    expect(slots[1]).toMatchObject({ id: 'S2', label: 'S2', occupied: false });
  });

  it('slots 가 없는 응답은 빈 목록이다', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({}));
    await expect(client(fetchImpl as unknown as typeof fetch).listSlots()).resolves.toEqual([]);
  });
});

describe('BackendCoreClient 오류', () => {
  it('HTML 400은 호환되지 않는 BackendCore endpoint라는 안전한 진단으로 바꾼다', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response('<html><body><h1>400 Bad Request</h1></body></html>', { status: 400, headers: { 'content-type': 'text/html' } }),
    );

    await expect(client(fetchImpl as unknown as typeof fetch).center({ x: 1400, y: 800 })).rejects.toThrow(
      /http:\/\/127\.0\.0\.1:8080\/api\/center.*BackendCore API.*Hucoms CGI.*RTSP/i,
    );
  });

  it('501 은 확정 답이므로 상태코드를 보존한다 — 상위가 재시도하지 않도록 한다', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({ error: '투영 오라클은 UE 연결에서만' }, 501));
    await expect(client(fetchImpl as unknown as typeof fetch).listSlots()).rejects.toMatchObject({ statusCode: 501 });
  });

  it('그 외 실패는 502 로 올린다', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({ error: 'boom' }, 500));
    await expect(client(fetchImpl as unknown as typeof fetch).getPtz()).rejects.toMatchObject({ statusCode: 502 });
  });

  it('URL 이 비어 있으면 조립 시점에 400 으로 던진다', () => {
    expect(() => new BackendCoreClient({ cameraId: 'x', baseUrl: '', timeoutMs: 1000 })).toThrow(CameraDriverError);
  });
});

describe('BackendCoreClient 탐색 계약', () => {
  it('discovery point·센터의 실제 경로와 body를 전달한다', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({ ok: true }));
    const subject = client(fetchImpl as unknown as typeof fetch);
    await subject.discoveryPoints('POST', 'p 1', undefined, { x: 10, y: 20 });
    await subject.center({ startX: 1, startY: 2, endX: 3, endY: 4 }, true);
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      'http://127.0.0.1:8080/api/discovery/presets/p%201/points',
      'http://127.0.0.1:8080/api/center-box',
    ]);
    expect(JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body))).toEqual({ x: 10, y: 20 });
  });

  it('busy(409)와 capability(422)를 상위 API까지 보존한다', async () => {
    for (const code of [409, 422]) {
      const fetchImpl = vi.fn(async () => jsonResponse({ error: 'blocked' }, code));
      await expect(client(fetchImpl as unknown as typeof fetch).listDiscoveryPresets()).rejects.toMatchObject({ statusCode: code });
    }
  });
});
