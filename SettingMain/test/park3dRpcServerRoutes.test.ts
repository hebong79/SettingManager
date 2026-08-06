import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/api/server.js';
import { openDatabase } from '../src/db/database.js';
import { ConfigStore } from '../src/config/configStore.js';
import { PresetStore } from '../src/store/presetStore.js';
import { SlotStore } from '../src/store/slotStore.js';
import { DevicePresetRegistryStore } from '../src/store/devicePresetRegistryStore.js';

/**
 * park3d-rpc 카메라의 **서버 경계** 검증 — `test/server.test.ts` 의 하네스 패턴을 복제한 별도 파일이다
 * (그 파일은 불가침이므로 한 줄도 건드리지 않는다).
 *
 * 구현자(`_workspace/02_developer_changes.md` §"설계와 달라진 점" 4)가 "서버 하네스가 필요해 만들지 못했다"고
 * 밝힌 설계 6단계 검증 2(`GET /api/device-preset-capability` → 501)를 여기서 채운다.
 *
 * 와이어 근거 — 검증자가 라이브 서버(`http://192.168.0.125:13510`)에 **읽기 전용**으로 직접 호출해 받은 실측 원문:
 *   POST /rpc {"jsonrpc":"2.0","id":1,"method":"cam.getPTZ","params":{"camId":1}}
 *     → HTTP 200 {"jsonrpc":"2.0","id":1,"result":{"pan":41.5,"tilt":20.100000381469727,"zoom":1.5799099206924438}}
 *   cam.captureJPG → result 는 {img_bytes, width:1280, height:720, format:"jpg", camId:1} (img_bytes 는 `data:` 접두 없는 순수 base64)
 *   camId 누락/미존재 → HTTP **200** + {"error":{"code":-32000,"message":"..."}}
 * 토큰 헤더 없이 전부 200 이었다(무인증 확정).
 */

let dir: string;
let server: Server;
let base: string;
/** 가짜 Park3D 서버가 들고 있는 현재 자세(도·배율 실수). 실측 초기값. */
let park3d = { pan: 41.5, tilt: 20.100000381469727, zoom: 1.5799099206924438 };
let rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
let sentHeaders: Array<Record<string, string>> = [];

/** Park3D JSON-RPC 와이어를 흉내 낸다. 오류도 **HTTP 200** 으로 돌려주는 실측 동작을 그대로 재현한다. */
const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  // 대조군(hucoms cam-a)이 쓰는 Hucoms CGI. `PresetSupported` 만 답하면 capability 경로가 성립한다.
  if (url.searchParams.get('action') === 'getPTZ') return new Response('PresetSupported = Yes\n');
  if (url.pathname !== '/rpc') {
    return new Response(JSON.stringify({ errorCode: 'errors.com.epicgames.httpserver.route_handler_not_found', errorMessage: '' }), { status: 404 });
  }
  sentHeaders.push((init?.headers ?? {}) as Record<string, string>);
  const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; params: Record<string, unknown> };
  rpcCalls.push({ method: body.method, params: body.params });

  if (body.params?.camId === undefined) {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: '필수 파라미터 누락: camId', data: null } }));
  }
  if (body.method === 'cam.getPTZ') {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ...park3d } }));
  }
  if (body.method === 'cam.setPTZ') {
    park3d = { pan: Number(body.params.pan), tilt: Number(body.params.tilt), zoom: Number(body.params.zoom) };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
  }
  if (body.method === 'cam.captureJPG') {
    const jpeg = Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9]);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { img_bytes: jpeg.toString('base64'), width: 1280, height: 720, format: 'jpg', camId: 1 } }));
  }
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: `Method not found: ${body.method}` } }));
}) as unknown as typeof fetch;

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'settingmanager-park3d-'));
  park3d = { pan: 41.5, tilt: 20.100000381469727, zoom: 1.5799099206924438 };
  rpcCalls = [];
  sentHeaders = [];

  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      server: { host: '127.0.0.1', port: 0 },
      simulator: { baseUrl: 'http://127.0.0.1:8080' },
      activeCameraId: 'sim-2',
      cameras: [
        // 실제 config.json 의 simulator-2 와 같은 모양이다(제어는 RPC 서버 13510, 영상은 13600 + camId, camId 1-based).
        { id: 'sim-2', label: 'UE-시뮬2', kind: 'park3d-rpc', controlUrl: 'http://192.168.0.125:13510', username: '', password: '', streamUrl: 'http://192.168.0.125:13601/stream', timeoutMs: 2000, camId: 1 },
        { id: 'cam-a', label: '리얼 1', kind: 'hucoms', controlUrl: 'http://10.0.0.1:80', username: 'admin', password: 'secret', streamUrl: 'rtsp://10.0.0.1:554/stream1', timeoutMs: 2000 },
      ],
    }),
  );

  // 카메라의 정본은 DB 다. config.json 의 cameras[] 는 load() 가 1회 이관하고 파일에서 지운다 —
  // 그래서 하네스는 예전처럼 config 에 카메라를 적어 두면 되고, 이관 경로도 매번 검증된다.
  const db = openDatabase({ path: ':memory:' });
  const configStore = new ConfigStore(join(dir, 'config.json'), db);
  await configStore.load();
  const presetStore = new PresetStore(join(dir, 'presets.json'), () => '2026-08-05T00:00:00.000Z');
  await presetStore.load();
  const slotStore = new SlotStore(join(dir, 'slots.json'));
  await slotStore.load();
  const devicePresetRegistryStore = new DevicePresetRegistryStore(join(dir, 'device-preset-registry.json'), () => '2026-08-05T00:00:00.000Z');
  await devicePresetRegistryStore.load();

  server = createServer({
    configStore, presetStore, slotStore, devicePresetRegistryStore, db, fetchImpl: fakeFetch, settleOptions: { sleep: async () => {} },
    // 대조군(hucoms cam-a)용. park3d-rpc 는 kind 가드에 먼저 걸려 이 팩토리에 닿지도 않는다는 것이
    // 아래 `장비 프리셋은 자동 배제된다` 의 요지다(server.test.ts 의 주입 패턴을 복제).
    directPresetClientFactory: () => ({
      async getCapability() {
        return { supported: true, advertisedMaxPresetNumber: null, usableMaxPresetNumber: 255, listing: 'unsupported' as const, naming: 'unsupported' as const, slots: [] };
      },
      async goPreset() {},
      async getPtz() { return { pan: 0, tilt: 0, zoom: 0 }; },
      async goPtz() {},
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('park3d-rpc — 장비 프리셋은 자동 배제된다 (설계 6단계 검증 2)', () => {
  it('GET /api/device-preset-capability 는 501 이다 — 장비 프리셋은 Hucoms CGI 계약이다', async () => {
    const { status, body } = await api('/api/device-preset-capability?cameraId=sim-2');
    expect(status).toBe(501);
    expect(JSON.stringify(body)).toContain('지원하지 않습니다');
    // 501 로 걷어내므로 Park3D 서버를 두드리지도 않는다.
    expect(rpcCalls).toHaveLength(0);
  });

  it('GET /api/cameras/sim-2/device-presets 도 501 이다', async () => {
    const { status } = await api('/api/cameras/sim-2/device-presets');
    expect(status).toBe(501);
  });

  it('hucoms 카메라는 같은 경로에서 501 이 아니다 — 501 이 kind 때문임을 고정한다', async () => {
    const { status } = await api('/api/device-preset-capability?cameraId=cam-a');
    expect(status).not.toBe(501);
  });
});

describe('park3d-rpc — 코어 능력 광고 (설계 6단계 검증 3)', () => {
  it('centerPoint 가 없으므로 center 능력이 사유와 함께 미지원이다', async () => {
    const { status, body } = await api('/api/core/capabilities?cameraId=sim-2');
    expect(status).toBe(200);
    expect(body.supported.center.ok).toBe(false);
    expect(body.supported.center.reason).toContain('픽셀 센터링');
  });
});

describe('park3d-rpc — camId 가 설정에서 RPC params 까지 끊기지 않고 도달한다', () => {
  it('연결 테스트(POST /api/db/cameras/1/test)가 raw 로 환산된 PTZ 를 돌려준다', async () => {
    const { status, body } = await api('/api/db/cameras/1/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.kind).toBe('park3d-rpc');
    // 41.5° / 20.100000381469727° / 1.5799099206924438배 → centi-deg · 배율×100
    expect(body.ptz).toMatchObject({ pan: 4150, tilt: 2010, zoom: 158, panDeg: 41.5, tiltDeg: 20.1 });

    expect(rpcCalls[0]).toEqual({ method: 'cam.getPTZ', params: { camId: 1 } });
    // 인증 헤더가 붙지 않는다 — 이 서버는 무인증이다.
    expect(Object.keys(sentHeaders[0]!)).toEqual(['content-type']);
  });

  it('GET /api/ptz 도 같은 raw 를 준다', async () => {
    const { status, body } = await api('/api/ptz?cameraId=sim-2');
    expect(status).toBe(200);
    expect(body.ptz).toMatchObject({ pan: 4150, tilt: 2010, zoom: 158 });
  });

  it('GET /api/snapshot 이 cam.captureJPG 의 img_bytes 를 JPEG 로 돌려준다', async () => {
    const response = await fetch(`${base}/api/snapshot?cameraId=sim-2`);
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(rpcCalls.some((c) => c.method === 'cam.captureJPG' && c.params.camId === 1)).toBe(true);
  });

  it('camId 가 없는 park3d-rpc 카메라는 400 으로 거절하고 서버를 두드리지 않는다', async () => {
    // 옵션 화면의 연결 테스트는 body.camera 로 초안을 덮어쓴다. camId 를 지워 초안을 만든다.
    await api('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ park3d_cam_id: 0 }),
    });
    rpcCalls = [];
    const { body } = await api('/api/db/cameras/1/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(body.ok).toBe(false);
    expect(body.error).toContain('camId');
    expect(rpcCalls).toHaveLength(0);
  });
});

describe('park3d-rpc — 설정 공개 표면 (설계 3단계 검증 5·6)', () => {
  it('/api/settings 응답에 camId 가 실리고, 없는 카메라에는 키 자체가 없다', async () => {
    const { body } = await api('/api/settings');
    const sim = body.cameras.find((c: any) => c.id === 'sim-2');
    const cam = body.cameras.find((c: any) => c.id === 'cam-a');
    expect(sim.camId).toBe(1);
    expect(sim.kind).toBe('park3d-rpc');
    expect(cam).not.toHaveProperty('camId');
    // camId 가 없는 카메라의 키 집합은 넓어지지 않았다(server.test.ts:154 와 같은 계약).
    expect(Object.keys(cam).sort()).toEqual(['controlUrl', 'hasPassword', 'id', 'kind', 'label', 'place_id', 'streamUrl', 'timeoutMs', 'username']);
  });

  it('PUT /api/db/cameras 왕복에서 kind 와 camId 가 살아남는다', async () => {
    const { status } = await api('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cam_name: '이름만 바꿈' }),
    });
    expect(status).toBe(200);
    const { body } = await api('/api/settings');
    const sim = body.cameras.find((c: any) => c.id === 'sim-2');
    expect(sim).toMatchObject({ label: '이름만 바꿈', kind: 'park3d-rpc', camId: 1 });
  });
});

describe('park3d-rpc — 역방향 왕복(goPtz(getPtz()))', () => {
  it('읽은 raw 를 그대로 되돌려 보내면 서버 값이 0.01 단위로 양자화된다', async () => {
    const read = await api('/api/ptz?cameraId=sim-2');
    const { pan, tilt, zoom } = read.body.ptz;
    await api('/api/ptz/absolute', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cameraId: 'sim-2', pan, tilt, zoom }),
    });
    // 서버로 나간 값: 실수 원본(20.100000381469727)이 아니라 0.01 로 반올림된 20.1 이다.
    const set = rpcCalls.find((c) => c.method === 'cam.setPTZ')!;
    expect(set.params).toEqual({ camId: 1, pan: 41.5, tilt: 20.1, zoom: 1.58 });
    expect(park3d.tilt).not.toBe(20.100000381469727);

    // 그러나 raw 관점에서는 **고정점**이다 — 한 번 양자화된 뒤에는 반복해도 더 이상 흐르지 않는다.
    const again = await api('/api/ptz?cameraId=sim-2');
    expect(again.body.ptz).toMatchObject({ pan: 4150, tilt: 2010, zoom: 158 });
  });
});
