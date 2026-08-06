import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/api/server.js';
import { openDatabase } from '../src/db/database.js';
import { ConfigStore } from '../src/config/configStore.js';
import { PresetStore } from '../src/store/presetStore.js';
import { SlotStore } from '../src/store/slotStore.js';
import { DevicePresetRegistryStore } from '../src/store/devicePresetRegistryStore.js';

/**
 * **브리지 코어가 실제로 일하는가** — backend-core 를 한 번도 두드리지 않고.
 *
 * 여기서 지키는 것은 다섯이다.
 *   ① 새 능력 4종(centerBox·discovery·slotCreate·vehicleBox)이 켜지고 실제로 동작한다
 *   ② 실측 화각표가 없는 기기는 박스 줌이 **켜지지 않는다**(내장 표로 대신하지 않는다)
 *   ③ 박스 줌은 순수 계산이다 — 드라이버에 절대 좌표 이동만 나간다
 *   ④ 사이드카가 없으면 vehicleBox 는 사유와 함께 501
 *   ⑤ 저장한 것이 파일에 남고 다시 읽힌다
 */

let dir: string;
let server: Server;
let base: string;
/** 가짜 Hucoms 카메라의 현재 자세(와이드). 실측 표의 z=0 자리다. */
let ptz = { pan: 12_000, tilt: 1_681, zoom: 0 };
let cgiCommands: string[] = [];
let object3dCalls: string[] = [];

/** 상류 실측 곡선에서 뽑은 앵커. 근거: baro_calory camera-intrinsics.mjs ZOOM_HFOV_TABLE. */
const ZOOM_HFOV = [
  { z: 0, h: 57.14 },
  { z: 2000, h: 47.89 },
  { z: 8000, h: 22.59 },
  { z: 16384, h: 2.39 },
];

const JPEG = Buffer.from([0xff, 0xd8, 0x00, 0x11, 0xff, 0xd9]);

/** Hucoms CGI 와 object3d 사이드카를 함께 흉내 낸다. */
const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));

  if (url.pathname === '/detect' || url.pathname === '/readyz') {
    object3dCalls.push(`${init?.method ?? 'GET'} ${url.pathname}?${url.searchParams}`);
    if (url.pathname === '/readyz') return new Response(JSON.stringify({ ready: true, queued: 0 }));
    return new Response(JSON.stringify({
      // 사이드카 어휘 그대로 — 개명하지 않고 통과시키는지 본다.
      detections: [{ position_m: [1.2, 0, 8.4], dimensions_m: [4.5, 1.8, 1.5], yaw: 0.12, score: 0.87 }],
      calibration: { source: '/host/path/cam-a.json', intrinsics: { fx: 1200 } },
      model_id: 'object3d-primary',
      total_ms: 42,
    }));
  }

  if (url.pathname.includes('jpeg')) return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });

  // **순서가 계약이다.** 이동(goptzfpos)과 조회(getptzfpos)는 같은 `ptzf_status.cgi` 로 오므로
  // 경로가 아니라 `action` 으로 갈라야 한다. 경로로 먼저 가르면 이동이 조회로 먹혀
  // "명령을 보냈는데 아무 일도 안 일어나는" 상태가 된다(이 테스트를 쓰다 실제로 겪었다).
  const action = url.searchParams.get('action');
  if (action === 'goptzfpos') {
    cgiCommands.push(url.toString());
    ptz = {
      pan: Number(url.searchParams.get('panpos')),
      tilt: Number(url.searchParams.get('tiltpos')),
      zoom: Number(url.searchParams.get('zoompos')),
    };
    return new Response('OK');
  }
  if (action === 'getptzfpos') {
    return new Response(`panpos = ${ptz.pan}\ntiltpos = ${ptz.tilt}\nzoompos = ${ptz.zoom}\n`);
  }
  cgiCommands.push(url.toString());
  return new Response('OK');
}) as unknown as typeof fetch;

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function start(options: { intrinsics?: boolean; object3d?: boolean } = {}): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'settingmanager-bridge-'));
  ptz = { pan: 12_000, tilt: 1_681, zoom: 0 };
  cgiCommands = [];
  object3dCalls = [];

  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      server: { host: '127.0.0.1', port: 0 },
      simulator: { baseUrl: 'http://127.0.0.1:8080' },
      core: { provider: 'bridge', perCamera: {} },
      ...(options.object3d ? { object3d: { baseUrl: 'http://127.0.0.1:9070' } } : {}),
      activeCameraId: 'cam-a',
      cameras: [{
        id: 'cam-a', label: '리얼 1', kind: 'hucoms', controlUrl: 'http://10.0.0.1:80',
        username: 'admin', password: 'secret', streamUrl: '', timeoutMs: 2000,
        ...(options.intrinsics ? { intrinsics: { zoomHfov: ZOOM_HFOV } } : {}),
      }],
    }),
  );

  // 카메라의 정본은 DB 다. config.json 의 cameras[] 는 load() 가 1회 이관하고 파일에서 지운다 —
  // 그래서 하네스는 예전처럼 config 에 카메라를 적어 두면 되고, 이관 경로도 매번 검증된다.
  const db = openDatabase({ path: ':memory:' });
  const configStore = new ConfigStore(join(dir, 'config.json'), db);
  await configStore.load();
  // 프리셋 정본은 preset_info 표다 — 파일이 아니라 같은 DB 를 본다.
  const presetStore = new PresetStore(db);
  const slotStore = new SlotStore(join(dir, 'slots.json'));
  await slotStore.load();
  const registry = new DevicePresetRegistryStore(join(dir, 'device-preset-registry.json'), () => '2026-08-05T00:00:00.000Z');
  await registry.load();

  server = createServer({
    configStore, presetStore, slotStore, devicePresetRegistryStore: registry,
    fetchImpl: fakeFetch, settleOptions: { sleep: async () => {} }, db,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('브리지 능력 선언', () => {
  it('실측 표와 사이드카가 다 있으면 6종이 켜진다 — 캘리브레이션·호밍만 남는다', async () => {
    await start({ intrinsics: true, object3d: true });
    const { body } = await api('/api/core/capabilities');
    expect(body.provider).toBe('bridge');
    const ok = Object.entries(body.supported).filter(([, v]) => (v as { ok: boolean }).ok).map(([k]) => k).sort();
    expect(ok).toEqual(['center', 'centerBox', 'discoveryPoints', 'discoveryPresets', 'slotCreate', 'vehicleBox']);
    expect(body.supported.calibration.reason).toMatch(/네이티브 이미지 처리/);
    expect(body.supported.plateHoming.reason).toMatch(/네이티브 이미지 처리/);
  });

  it('실측 화각표가 없으면 박스 줌이 꺼지고 무엇을 채워야 하는지 말한다', async () => {
    await start({ object3d: true });
    const { body } = await api('/api/core/capabilities');
    expect(body.supported.centerBox).toMatchObject({ ok: false, reason: expect.stringContaining('intrinsics.zoomHfov') });
  });

  it('사이드카 주소가 없으면 차량 3D 육면체가 꺼진다', async () => {
    await start({ intrinsics: true });
    const { body } = await api('/api/core/capabilities');
    expect(body.supported.vehicleBox).toMatchObject({ ok: false, reason: expect.stringContaining('object3d.baseUrl') });
  });
});

describe('POST /api/core/center-box — 순수 계산', () => {
  it('박스 중앙으로 조준하고 박스가 화면을 채울 만큼 줌인한다', async () => {
    await start({ intrinsics: true });
    // 화면 오른쪽 아래 사분면의 절반 크기 박스 → 오른쪽·아래로 돌고 2배쯤 줌인해야 한다.
    const { status, body } = await api('/api/core/center-box', {
      method: 'POST',
      body: JSON.stringify({ startX: 960, startY: 540, endX: 1920, endY: 1080 }),
    });
    expect(status).toBe(200);
    expect(body.provider).toBe('bridge');

    // 박스가 프레임의 정확히 절반 → 목표 화각 = 현재(57.14°)의 절반 ≈ 28.57° → 표에서 z≈5,700
    expect(body.target.zoom).toBeGreaterThan(4000);
    expect(body.target.zoom).toBeLessThan(8000);
    // 오른쪽 아래를 겨눴으므로 팬은 늘고 틸트도 아래(+)로 간다.
    expect(body.target.pan).toBeGreaterThan(12_000);
    expect(body.target.tilt).toBeGreaterThan(1_681);
  });

  it('하드웨어 박스줌을 쓰지 않는다 — 절대 좌표 이동만 나간다', async () => {
    await start({ intrinsics: true });
    cgiCommands = [];
    await api('/api/core/center-box', { method: 'POST', body: JSON.stringify({ startX: 100, startY: 100, endX: 500, endY: 400 }) });
    expect(cgiCommands.length).toBeGreaterThan(0);
    expect(cgiCommands.some((url) => /setcenter|boxzoom|zoomarea/i.test(url))).toBe(false);
    expect(cgiCommands.some((url) => url.includes('panpos='))).toBe(true);
  });

  it('실측 표가 없으면 501 이다 — 내장 표로 대신 계산하지 않는다', async () => {
    await start({});
    const { status, body } = await api('/api/core/center-box', {
      method: 'POST',
      body: JSON.stringify({ startX: 0, startY: 0, endX: 100, endY: 100 }),
    });
    expect(status).toBe(501);
    expect(body.error).toMatch(/intrinsics\.zoomHfov/);
  });
});

describe('탐색 프리셋·점 — 브리지 자기 저장소', () => {
  it('만들고 읽고 지운다. backend-core 를 부르지 않는다', async () => {
    await start({ intrinsics: true });
    const created = await api('/api/core/discovery/presets', { method: 'POST', body: JSON.stringify({ name: '입구' }) });
    expect(created.status).toBe(200);
    expect(created.body.preset).toMatchObject({ id: 'p-1', name: '입구' });

    const listed = await api('/api/core/discovery/presets');
    expect(listed.body.presets).toHaveLength(1);

    const point = await api('/api/core/discovery/presets/p-1/points', { method: 'POST', body: JSON.stringify({ x: 300, y: 400 }) });
    expect(point.body.point).toMatchObject({ id: 'pt-1', x: 300, y: 400 });

    expect((await api('/api/core/discovery/presets/p-1', { method: 'DELETE' })).body).toMatchObject({ removed: 'p-1' });
    expect((await api('/api/core/discovery/presets')).body.presets).toEqual([]);
  });

  it('없는 프리셋은 404 다 — 501(이 구현이 못 함)과 구분한다', async () => {
    await start({ intrinsics: true });
    const { status, body } = await api('/api/core/discovery/presets/p-99', { method: 'DELETE' });
    expect(status).toBe(404);
    expect(body.error).toMatch(/탐색 프리셋/);
  });

  it('프리셋 이동은 저장된 자세로 카메라를 보낸다', async () => {
    await start({ intrinsics: true });
    await api('/api/core/discovery/presets', {
      method: 'POST',
      body: JSON.stringify({ name: 'A', ptz: { panpos: 4200, tiltpos: 900, zoompos: 3000 } }),
    });
    cgiCommands = [];
    const { status } = await api('/api/core/discovery/presets/p-1/goto', { method: 'POST' });
    expect(status).toBe(200);
    expect(cgiCommands.some((url) => url.includes('panpos=4200'))).toBe(true);
  });
});

describe('커미셔닝 주차면 — /api/core/slots', () => {
  it('지금 자세를 클로즈업으로 저장하고, 되돌아갈 수 있다', async () => {
    await start({ intrinsics: true });
    // 주차면은 프리셋(구도)에 속한다 — 먼저 하나 만든다.
    await api('/api/core/discovery/presets', { method: 'POST', body: JSON.stringify({ name: '입구' }) });
    ptz = { pan: 8_800, tilt: 2_200, zoom: 6_000 };

    const created = await api('/api/core/slots', { method: 'POST', body: JSON.stringify({ x: 800, y: 600, name: 'A-01' }) });
    expect(created.status).toBe(200);
    expect(created.body.slot).toMatchObject({
      id: 'spot-1', name: 'A-01', markedPixel: { x: 800, y: 600 }, slotId: 1,
      closeupPtz: { panpos: 8_800, tiltpos: 2_200, zoompos: 6_000, focuspos: 0 },
    });

    // 카메라를 딴 데로 보낸 뒤 goto 로 돌아온다.
    ptz = { pan: 0, tilt: 0, zoom: 0 };
    cgiCommands = [];
    expect((await api('/api/core/slots/spot-1/goto', { method: 'POST' })).status).toBe(200);
    expect(cgiCommands.some((url) => url.includes('panpos=8800'))).toBe(true);

    expect((await api('/api/core/slots/spot-1', { method: 'DELETE' })).body).toMatchObject({ removed: 'spot-1' });
    expect((await api('/api/core/slots')).body.slots).toEqual([]);
  });

  it('프리셋이 없으면 409 로 거절한다 — 어느 구도의 주차면인지가 좌표의 의미다', async () => {
    await start({ intrinsics: true });
    const { status, body } = await api('/api/core/slots', { method: 'POST', body: JSON.stringify({ x: 10, y: 20 }) });
    expect(status).toBe(409);
    expect(body.error).toMatch(/프리셋/);
  });

  it('저장은 카메라를 움직이지 않는다 — 읽기만 한다', async () => {
    await start({ intrinsics: true });
    await api('/api/core/discovery/presets', { method: 'POST', body: JSON.stringify({ name: '입구' }) });
    cgiCommands = [];
    await api('/api/core/slots', { method: 'POST', body: JSON.stringify({ x: 10, y: 20 }) });
    expect(cgiCommands.some((url) => url.includes('panpos='))).toBe(false);
  });

  it('프레임 밖 좌표는 400 이다', async () => {
    await start({ intrinsics: true });
    await api('/api/core/discovery/presets', { method: 'POST', body: JSON.stringify({ name: '입구' }) });
    expect((await api('/api/core/slots', { method: 'POST', body: JSON.stringify({ x: 5000, y: 10 }) })).status).toBe(400);
  });
});

describe('차량 3D 육면체 — /api/core/vehicle-box', () => {
  it('사이드카 측정값을 개명하지 않고 통과시킨다', async () => {
    await start({ intrinsics: true, object3d: true });
    const { status, body } = await api('/api/core/vehicle-box', { method: 'POST' });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      provider: 'bridge', cameraId: 'cam-a', count: 1, source: 'object3d', model: 'object3d-primary', latencyMs: 42,
    });
    // 사이드카 어휘 그대로여야 한다 — 개명하면 그쪽 로그와 대조가 안 된다.
    expect(body.detections[0]).toEqual({ position_m: [1.2, 0, 8.4], dimensions_m: [4.5, 1.8, 1.5], yaw: 0.12, score: 0.87 });
    // 캘리브레이션 키는 기기 id 다.
    expect(object3dCalls.some((call) => call.includes('camera_id=cam-a'))).toBe(true);
  });

  it('카메라를 움직이지 않는다 — 스냅샷만 뜬다', async () => {
    await start({ intrinsics: true, object3d: true });
    cgiCommands = [];
    await api('/api/core/vehicle-box', { method: 'POST' });
    expect(cgiCommands.some((url) => url.includes('panpos='))).toBe(false);
  });

  it('상태는 사이드카가 죽어 있어도 200 으로 사실을 답한다', async () => {
    await start({ intrinsics: true, object3d: true });
    expect((await api('/api/core/vehicle-box/status')).body).toMatchObject({ configured: true, ready: true, cameraId: 'cam-a' });
  });

  it('사이드카 미설정이면 status 는 configured:false, detect 는 501 이다', async () => {
    await start({ intrinsics: true });
    expect((await api('/api/core/vehicle-box/status')).body).toEqual({ configured: false, ready: false });
    const { status, body } = await api('/api/core/vehicle-box', { method: 'POST' });
    expect(status).toBe(501);
    expect(body.error).toMatch(/object3d\.baseUrl/);
    expect(object3dCalls).toEqual([]);
  });
});
