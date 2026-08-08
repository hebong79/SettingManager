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
 * `POST /api/sim/pick` — 영상 클릭 하나를 월드 좌표와 차량으로 바꾸는 경계.
 *
 * 하네스는 `test/park3dRpcServerRoutes.test.ts` 패턴을 복제했다. 가짜 시뮬레이터가 돌려주는
 * 값은 **2026-08-08 실측 원문**이다 — 1번 카메라의 자세와 `car.list` 의 실제 좌표다.
 */

let dir: string;
let server: Server;
let base: string;
let rpcCalls: string[] = [];

/** 실측: `cam.get {camId:1}` 원문. */
const CAM_GET = {
  camId: 1, name: 'Camera-1',
  pos: { x: -36.29999923706055, y: -13.600000381469727, z: 13.5 },
  pan: 47.099998474121094, tilt: 30.399999618530273, zoom: 2.4000000953674316,
};

/** 실측 `car.list` 에서 뽑은 세 대. 좌표는 원문 그대로다. */
const CARS = [
  { carNameId: '63-16.48.26', pos: { x: -19.32, y: 6.05, z: 0.0 }, rotY: 0 },
  { carNameId: '0-13.50.46', pos: { x: 14.76, y: -8.17, z: 0.02 }, rotY: 0 },
  { carNameId: '15-13.53.13', pos: { x: -21.6, y: -4.6, z: 0.03 }, rotY: 0 },
];

/** 자세만 바꿔 끼울 수 있게 해 둔다 — 조준 상태를 시험에서 정한다. */
let pose = { ...CAM_GET };

const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as { method: string };
  rpcCalls.push(body.method);
  if (body.method === 'cam.get') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: pose }));
  if (body.method === 'car.list') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { cars: CARS } }));
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: `Method not found: ${body.method}` } }));
}) as unknown as typeof fetch;

const pick = async (payload: Record<string, unknown>): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}/api/sim/pick`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'settingmanager-simpick-'));
  rpcCalls = [];
  pose = { ...CAM_GET };
  await writeFile(join(dir, 'config.json'), JSON.stringify({
    server: { host: '127.0.0.1', port: 0 },
    simTool: { rpcUrl: 'http://127.0.0.1:13510/rpc', timeoutMs: 2000 },
    activeCameraId: 'cam-a',
    cameras: [{ id: 'cam-a', label: '리얼 1', kind: 'hucoms', controlUrl: 'http://10.0.0.1:80', username: 'admin', password: 'secret', streamUrl: 'rtsp://10.0.0.1:554/stream1', timeoutMs: 2000 }],
  }));
  const db = openDatabase({ path: ':memory:' });
  const configStore = new ConfigStore(join(dir, 'config.json'), db);
  await configStore.load();
  const slotStore = new SlotStore(join(dir, 'slots.json'));
  await slotStore.load();
  const devicePresetRegistryStore = new DevicePresetRegistryStore(join(dir, 'device-preset-registry.json'), () => '2026-08-08T00:00:00.000Z');
  await devicePresetRegistryStore.load();
  server = createServer({
    configStore, presetStore: new PresetStore(db), slotStore, devicePresetRegistryStore, db,
    fetchImpl: fakeFetch, settleOptions: { sleep: async () => {} },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('POST /api/sim/pick', () => {
  it('겨누고 있는 차를 화면 중앙 클릭으로 고른다 — 실측 재현', async () => {
    // 실측: 차량 63-16.48.26 을 pan 49.168 · tilt 27.469 로 조준하니 십자가 그 차에 꽂혔다.
    pose = { ...pose, pan: 49.168, tilt: 27.469, zoom: 10 };
    const { status, body } = await pick({ camId: 1, x: 640, y: 360, width: 1280, height: 720 });
    expect(status).toBe(200);
    expect(body.car.id).toBe('63-16.48.26');
    expect(body.car.distancePx).toBeLessThan(2);
    // 자세도 함께 준다 — 화면이 "무엇을 기준으로 계산했는지" 말할 수 있어야 한다.
    expect(body.pose.zoom).toBe(10);
  });

  it('빈 자리를 찍으면 차는 없고 지면 좌표만 준다 — 3번 배치가 그것을 쓴다', async () => {
    pose = { ...pose, pan: 49.168, tilt: 27.469, zoom: 10 };
    // 같은 조준에서 화면 구석 — 반경(가로의 6%=76px) 밖이다.
    const { body } = await pick({ camId: 1, x: 20, y: 700, width: 1280, height: 720 });
    expect(body.car).toBeNull();
    expect(body.ground).not.toBeNull();
    expect(body.ground.z).toBe(0);
  });

  it('지면 높이를 지정할 수 있다', async () => {
    const { body } = await pick({ camId: 1, x: 640, y: 500, width: 1280, height: 720, groundZ: 1.5 });
    expect(body.ground.z).toBe(1.5);
  });

  it('하늘을 찍으면 지면 좌표가 null 이다 — 지어내지 않는다', async () => {
    pose = { ...pose, tilt: -20 };
    const { body } = await pick({ camId: 1, x: 640, y: 5, width: 1280, height: 720 });
    expect(body.ground).toBeNull();
  });

  it('자세와 차량을 **같은 순간**에 묻는다', async () => {
    await pick({ camId: 1, x: 640, y: 360, width: 1280, height: 720 });
    expect(rpcCalls.sort()).toEqual(['cam.get', 'car.list']);
  });

  it('영상 크기가 없으면 400 이다 — 없는 화면비를 가정하면 세로 화각이 조용히 틀어진다', async () => {
    const { status, body } = await pick({ camId: 1, x: 640, y: 360 });
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toContain('width');
  });

  it('camId 가 없으면 400 이다', async () => {
    const { status } = await pick({ x: 640, y: 360, width: 1280, height: 720 });
    expect(status).toBe(400);
  });

  it('클릭 좌표가 없으면 400 이다', async () => {
    const { status } = await pick({ camId: 1, width: 1280, height: 720 });
    expect(status).toBe(400);
  });

  it('카메라를 움직이지 않는다 — 읽기 두 번뿐이다', async () => {
    await pick({ camId: 1, x: 100, y: 100, width: 1280, height: 720 });
    expect(rpcCalls).not.toContain('cam.setPTZ');
  });
});
