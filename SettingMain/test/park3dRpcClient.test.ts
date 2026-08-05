import { describe, expect, it, vi } from 'vitest';
import { BridgeCoreProvider } from '../src/core/bridge/bridgeCoreProvider.js';
import type { CoreContext } from '../src/core/coreProvider.js';
import { normalizeConfig } from '../src/config/normalize.js';
import { CameraDriverError, type CameraDriver } from '../src/devices/cameraDriver.js';
import { createDriver } from '../src/devices/driverFactory.js';
import { Park3DRpcClient } from '../src/devices/park3d/park3dRpcClient.js';

/**
 * 와이어 근거 — 리더가 라이브 서버(`http://192.168.0.125:13510`)를 **토큰 헤더 없이** 호출해 받은 실측 원문:
 *   POST /rpc {"jsonrpc":"2.0","id":1,"method":"cam.getPTZ","params":{"camId":1}}
 *     → HTTP 200 {"result":{"pan":41.5,"tilt":20.100000381469727,"zoom":1.5799099206924438}}
 *   params 없이 호출 → {"error":{"code":-32000,"message":"필수 파라미터 누락: camId","data":null}}
 *   `/cgi-bin/...` 등 없는 경로 → 404 {"errorCode":"errors.com.epicgames.httpserver.route_handler_not_found",...}
 * cam.setPTZ·cam.captureJPG 의 파라미터·응답 형태는 형제 프로젝트
 *   AgentVLA/ParkAgent/SettingAgent/src/clients/RpcCameraClient.ts:65,79,115-134 를 근거로 한다.
 */

const LIVE_GET_PTZ = { result: { pan: 41.5, tilt: 20.100000381469727, zoom: 1.5799099206924438 } };

type FetchMock = ReturnType<typeof mockFetch>;

function mockFetch(handler: (input: string | URL | Request, init?: RequestInit) => Response) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => handler(input, init));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** `camId: null` 은 **설정에 camId 가 아예 없는** 카메라를 뜻한다(undefined 를 넘기면 기본값 1 이 되어 검사가 무의미해진다). */
function client(fetchImpl: FetchMock, camId: number | null = 1): Park3DRpcClient {
  return new Park3DRpcClient({
    cameraId: 'simulator-2',
    baseUrl: 'http://192.168.0.125:13510',
    ...(camId === null ? {} : { camId }),
    timeoutMs: 3000,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

function sentInit(fetchImpl: FetchMock): RequestInit {
  return fetchImpl.mock.calls[0]![1] as RequestInit;
}

function sentBody(fetchImpl: FetchMock): Record<string, unknown> {
  return JSON.parse(sentInit(fetchImpl).body as string) as Record<string, unknown>;
}

describe('Park3DRpcClient.getPtz', () => {
  it('도·배율 실수를 raw 정수로 환산한다 — 상위 계층은 지금까지처럼 raw 만 본다', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(LIVE_GET_PTZ));
    expect(await client(fetchImpl).getPtz()).toEqual({ pan: 4150, tilt: 2010, zoom: 158 });
  });

  it('POST /rpc 에 JSON-RPC 2.0 봉투를 보낸다 — 경로 접미사(/stream/rpc)가 끼면 404 가 난다', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(LIVE_GET_PTZ));
    await client(fetchImpl).getPtz();

    expect(fetchImpl.mock.calls[0]![0]).toBe('http://192.168.0.125:13510/rpc');
    expect(sentInit(fetchImpl).method).toBe('POST');
    expect(sentBody(fetchImpl)).toEqual({ jsonrpc: '2.0', id: 1, method: 'cam.getPTZ', params: { camId: 1 } });
  });

  it('후행 슬래시가 있는 controlUrl 도 //rpc 가 되지 않는다', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(LIVE_GET_PTZ));
    const c = new Park3DRpcClient({ cameraId: 'x', baseUrl: 'http://h:13510/', camId: 1, timeoutMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch });
    await c.getPtz();
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://h:13510/rpc');
  });

  it('제어 URL 이 비어 있으면 조립 시점에 400 으로 던진다', () => {
    expect(() => new Park3DRpcClient({ cameraId: 'x', baseUrl: '', timeoutMs: 1000 })).toThrow(/제어 URL/);
  });

  it('PTZ 값이 하나라도 유한수가 아니면 던진다 — 0 으로 대체하면 카메라가 원점으로 간다', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ result: { pan: 41.5, tilt: null, zoom: 1.5 } }));
    await expect(client(fetchImpl).getPtz()).rejects.toThrow(/tilt/);
  });
});

describe('Park3DRpcClient 인증 — 이 서버는 무인증이다', () => {
  it('인증 헤더를 보내지 않는다 — 헤더는 content-type 뿐이다', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(LIVE_GET_PTZ));
    await client(fetchImpl).getPtz();

    const headers = sentInit(fetchImpl).headers as Record<string, string>;
    expect(Object.keys(headers)).toEqual(['content-type']);
    expect(Object.keys(headers).some((k) => k.toLowerCase() === 'x-park3d-token')).toBe(false);
  });

  it('PARK3D_RPC_TOKEN 환경변수를 설정해도 헤더가 되살아나지 않는다 — 인증은 배선하지 않기로 확정했다', async () => {
    vi.stubEnv('PARK3D_RPC_TOKEN', 'apark3d');
    try {
      const fetchImpl = mockFetch(() => jsonResponse(LIVE_GET_PTZ));
      await client(fetchImpl).getPtz();
      expect(Object.keys(sentInit(fetchImpl).headers as Record<string, string>)).toEqual(['content-type']);
      expect(JSON.stringify(sentInit(fetchImpl))).not.toContain('apark3d');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('서버가 나중에 인증을 켜면 401 이 조용히 묻히지 않고 오류로 드러난다', async () => {
    const fetchImpl = mockFetch(() => new Response('{"detail":"unauthorized"}', { status: 401 }));
    await expect(client(fetchImpl).getPtz()).rejects.toThrow(/401/);
  });
});

describe('Park3DRpcClient.goPtz', () => {
  it('raw 를 도·배율로 되돌려 cam.setPTZ 로 보낸다', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ result: { ok: true } }));
    await client(fetchImpl).goPtz({ pan: 4150, tilt: 2010, zoom: 158 });

    expect(sentBody(fetchImpl)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'cam.setPTZ',
      params: { camId: 1, pan: 41.5, tilt: 20.1, zoom: 1.58 },
    });
  });

  it('zoom 은 기기 범위(배율 1~36)로 자른다 — 공유 ZOOM_RANGE 는 Hucoms 것이다', async () => {
    const low = mockFetch(() => jsonResponse({ result: {} }));
    await client(low).goPtz({ pan: 0, tilt: 0, zoom: 50 });
    expect((sentBody(low).params as Record<string, number>).zoom).toBe(1);

    const high = mockFetch(() => jsonResponse({ result: {} }));
    await client(high).goPtz({ pan: 0, tilt: 0, zoom: 9999 });
    expect((sentBody(high).params as Record<string, number>).zoom).toBe(36);
  });
});

describe('Park3DRpcClient 오류 봉투', () => {
  it('JSON-RPC error 는 HTTP 200 으로 오므로 상태코드보다 먼저 본다', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ error: { code: -32000, message: '필수 파라미터 누락: camId', data: null } }));
    const error = await client(fetchImpl).getPtz().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CameraDriverError);
    expect((error as Error).message).toContain('-32000');
  });

  it('404 route_handler_not_found 를 undefined 로 흘려보내지 않는다 — 먼 곳의 TypeError 로 번지는 사고였다', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ errorCode: 'errors.com.epicgames.httpserver.route_handler_not_found', errorMessage: '' }, 404));
    await expect(client(fetchImpl).getPtz()).rejects.toBeInstanceOf(CameraDriverError);
    await expect(client(fetchImpl).getPtz()).rejects.toThrow(/404/);
  });

  it('JSON 이 아닌 본문은 원문을 실어 던진다 — 오진을 막는 유일한 단서다', async () => {
    const fetchImpl = mockFetch(() => new Response('<html>proxy error</html>', { status: 502 }));
    await expect(client(fetchImpl).getPtz()).rejects.toThrow(/proxy error/);
  });

  it('연결 실패는 502 드라이버 오류로 감싼다', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const error = await client(fetchImpl as unknown as FetchMock).getPtz().catch((e: unknown) => e);
    expect(error).toMatchObject({ statusCode: 502 });
  });
});

describe('Park3DRpcClient.getSnapshot', () => {
  it('img_bytes base64 를 디코드해 JPEG 를 돌려준다', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
    const fetchImpl = mockFetch(() => jsonResponse({ result: { img_bytes: jpeg.toString('base64') } }));
    const body = await client(fetchImpl).getSnapshot();
    expect(body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it('base64 디코드는 쓰레기도 통과시키므로 JPEG SOI 로 판정한다', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ result: { img_bytes: Buffer.from('not an image').toString('base64') } }));
    await expect(client(fetchImpl).getSnapshot()).rejects.toThrow(/JPEG/);
  });
});

describe('Park3DRpcClient camId', () => {
  it('camId 가 없으면 400 으로 던지고 전송조차 하지 않는다 — 1번을 임의로 움직이면 엉뚱한 카메라가 돈다', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(LIVE_GET_PTZ));
    const error = await client(fetchImpl, null).getPtz().catch((e: unknown) => e);
    expect(error).toMatchObject({ statusCode: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Park3DRpcClient 미지원 기능', () => {
  it('주차면 개념이 없어 빈 목록이다 (오류가 아니다)', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ result: {} }));
    await expect(client(fetchImpl).listSlots()).resolves.toEqual([]);
  });

  it('픽셀 센터링 계약이 없으므로 centerPoint 를 지어내지 않는다', () => {
    const driver: CameraDriver = client(mockFetch(() => jsonResponse({ result: {} })));
    expect(driver.centerPoint).toBeUndefined();
  });

  it('그 결과 코어가 center 능력을 사유와 함께 미지원으로 광고한다 — 별도 배선이 없다', async () => {
    const driver: CameraDriver = client(mockFetch(() => jsonResponse({ result: {} })));
    const provider = new BridgeCoreProvider();
    const capabilities = await provider.capabilities({ camera: { id: 'simulator-2' }, driver } as unknown as CoreContext);
    expect(capabilities.supported.center.ok).toBe(false);
    expect(capabilities.supported.center.reason).toBeTruthy();
  });
});

describe('createDriver — 종류 분기의 유일한 지점', () => {
  const config = normalizeConfig({
    activeCameraId: 'sim-2',
    cameras: [{ id: 'sim-2', kind: 'park3d-rpc', controlUrl: 'http://192.168.0.125:13510', streamUrl: 'http://192.168.0.125:13510/stream', camId: 1 }],
  });

  it('park3d-rpc 설정은 Park3DRpcClient 로 조립된다', () => {
    const driver = createDriver(config.cameras[0]!, config);
    expect(driver).toBeInstanceOf(Park3DRpcClient);
    expect(driver.kind).toBe('park3d-rpc');
  });

  it('설정의 camId 가 드라이버까지 전달된다', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(LIVE_GET_PTZ));
    const driver = createDriver(config.cameras[0]!, config, fetchImpl as unknown as typeof fetch);
    await driver.getPtz();
    expect((sentBody(fetchImpl).params as Record<string, number>).camId).toBe(1);
  });
});
