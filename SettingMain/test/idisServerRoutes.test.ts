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
import { createDriver } from '../src/devices/driverFactory.js';
import { IdisCameraClient } from '../src/devices/idis/index.js';
import { readCameras } from '../src/db/configCameras.js';
import { SetupRepository } from '../src/db/setupRepository.js';
import type { AppConfig, CameraConfig } from '../src/config/types.js';

/**
 * 계획 §7 `test/idisServerRoutes.test.ts` — T-S1~T-S5.
 * `park3dRpcServerRoutes.test.ts` 의 하네스를 복제했다(`server.test.ts` 는 불가침이라 건드리지 않는다).
 *
 * **IDIS 드라이버는 `fetch` 를 쓰지 않으므로** 여기의 `fakeFetch` 는 대조군(hucoms `cam-a`)
 * 전용이다. IDIS 경로가 실수로 `fetch` 로 새면 그 사실이 아래 "두드리지 않는다" 단언에서 드러난다.
 */

let dir: string;
let server: Server;
let base: string;
let db: ReturnType<typeof openDatabase>;
let fetchCalls: string[] = [];

const fakeFetch = vi.fn(async (input: string | URL | Request) => {
  const url = new URL(String(input));
  fetchCalls.push(url.toString());
  // 대조군 hucoms 가 쓰는 CGI. `PresetSupported` 만 답하면 capability 경로가 성립한다.
  if (url.searchParams.get('action') === 'getPTZ') return new Response('PresetSupported = Yes\n');
  return new Response('', { status: 404 });
}) as unknown as typeof fetch;

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'settingmanager-idis-routes-'));
  fetchCalls = [];

  await writeFile(join(dir, 'config.json'), JSON.stringify({
    server: { host: '127.0.0.1', port: 0 },
    simulator: { baseUrl: 'http://127.0.0.1:8080' },
    activeCameraId: 'idis-1',
    cameras: [
      { id: 'idis-1', label: 'IDIS 1', kind: 'idis', controlUrl: 'http://192.168.0.30:80', username: 'admin', password: 'secret-not-real', streamUrl: 'rtsp://192.168.0.30:554/trackID=1', timeoutMs: 2000 },
      { id: 'cam-a', label: '리얼 1', kind: 'hucoms', controlUrl: 'http://10.0.0.1:80', username: 'admin', password: 'secret', streamUrl: 'rtsp://10.0.0.1:554/stream1', timeoutMs: 2000 },
    ],
  }));

  db = openDatabase({ path: ':memory:' });
  const configStore = new ConfigStore(join(dir, 'config.json'), db);
  await configStore.load();
  const presetStore = new PresetStore(db);
  const slotStore = new SlotStore(join(dir, 'slots.json'));
  await slotStore.load();
  const devicePresetRegistryStore = new DevicePresetRegistryStore(join(dir, 'device-preset-registry.json'), () => '2026-08-06T00:00:00.000Z');
  await devicePresetRegistryStore.load();

  server = createServer({
    configStore, presetStore, slotStore, devicePresetRegistryStore, db,
    fetchImpl: fakeFetch, settleOptions: { sleep: async () => {} },
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
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('T-S1 조립 — createDriver 가 IDIS 드라이버를 만든다', () => {
  const config = { streaming: {} } as unknown as AppConfig;
  const camera: CameraConfig = {
    id: 'idis-1', label: 'IDIS 1', kind: 'idis', controlUrl: 'http://192.168.0.30:80',
    username: 'admin', password: 'secret-not-real', streamUrl: '', timeoutMs: 2000,
  };

  it('`kind:idis` → `IdisCameraClient` 이고 `driver.kind === "idis"` 다', () => {
    const driver = createDriver(camera, config);
    expect(driver).toBeInstanceOf(IdisCameraClient);
    expect(driver.kind).toBe('idis');
    expect(driver.cameraId).toBe('idis-1');
  });

  it('`fetchImpl` 을 넘겨도 무시한다 — 이 드라이버는 node:http 를 쓴다', () => {
    const spy = vi.fn();
    const driver = createDriver(camera, config, spy as unknown as typeof fetch);
    expect(driver).toBeInstanceOf(IdisCameraClient);
    expect(spy).not.toHaveBeenCalled();
  });

  it('모르는 kind 는 여전히 400 이다 — `never` 소진 검사가 살아 있다', () => {
    expect(() => createDriver({ ...camera, kind: 'flexwatch' as never }, config)).toThrow(/알 수 없는 카메라 종류/);
  });

  it('자격증명이 박힌 controlUrl 은 팩토리 단계에서 400 으로 막힌다', () => {
    expect(() => createDriver({ ...camera, controlUrl: 'http://admin:pw@192.168.0.30:80' }, config))
      .toThrow(/인증·query·fragment 없는/);
  });
});

describe('T-S2 설정 왕복', () => {
  it('`/api/settings` 에서 kind 가 `idis` 로 보존되고 **비밀번호는 실리지 않는다**', async () => {
    const { status, body } = await api('/api/settings');
    expect(status).toBe(200);
    const idis = body.cameras.find((c: any) => c.id === 'idis-1');
    expect(idis.kind).toBe('idis');
    expect(idis).not.toHaveProperty('password');
    expect(idis.hasPassword).toBe(true);
    expect(JSON.stringify(body)).not.toContain('secret-not-real');
  });

  it('저장 왕복에서도 kind 가 살아남는다 — 이름만 고쳐도 종류가 hucoms 로 되돌아가지 않는다', async () => {
    const cameras = (await api('/api/db/cameras')).body.cameras;
    const camId = cameras.find((c: any) => c.cam_uuid === 'idis-1').cam_id;
    const { status } = await api(`/api/db/cameras/${camId}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cam_name: '이름만 바꿈' }),
    });
    expect(status).toBe(200);

    const after = (await api('/api/settings')).body.cameras.find((c: any) => c.id === 'idis-1');
    expect(after).toMatchObject({ label: '이름만 바꿈', kind: 'idis' });
  });
});

describe('T-S3 DB 왕복', () => {
  it('`camera_info` → `readCameras` 에서 kind:`idis` 가 보존된다', () => {
    const cameras = readCameras(db);
    expect(cameras.find((c) => c.id === 'idis-1')?.kind).toBe('idis');
  });

  it('`config.json` 1회 이관이 idis 카메라를 건너뛰지 않았다', () => {
    const rows = new SetupRepository(db).listCameras();
    expect(rows.map((r) => r.cam_uuid).sort()).toEqual(['cam-a', 'idis-1']);
    expect(rows.find((r) => r.cam_uuid === 'idis-1')?.kind).toBe('idis');
  });
});

describe('T-S4 장비 프리셋은 자동 배제된다 (§비범위 1번)', () => {
  it('`GET /api/cameras/idis-1/device-presets` 는 501 이다', async () => {
    const { status } = await api('/api/cameras/idis-1/device-presets');
    expect(status).toBe(501);
  });

  it('`GET /api/device-preset-capability?cameraId=idis-1` 도 501 이고 카메라를 두드리지 않는다', async () => {
    const { status, body } = await api('/api/device-preset-capability?cameraId=idis-1');
    expect(status).toBe(501);
    expect(JSON.stringify(body)).toContain('지원하지 않습니다');
    expect(fetchCalls).toHaveLength(0);
  });

  it('hucoms 는 같은 경로에서 501 이 아니다 — 501 이 kind 때문임을 고정한다', async () => {
    const { status } = await api('/api/device-preset-capability?cameraId=cam-a');
    expect(status).not.toBe(501);
  });
});

describe('T-S5 코어 능력 광고 — **알려진 한계를 테스트로 고정한다**', () => {
  it('`center` 가 `ok:true` 로 광고된다 (설계 §3-F 의 낙관 광고)', async () => {
    // ⚠ 이것은 **바람직한 동작이 아니라 현재 동작**이다. `bridgeCoreProvider` 가
    // `typeof driver.centerPoint === 'function'` 만 보므로, `ptzMoveToPoint` 가 없는 IDIS
    // 개체도 `center: ok:true` 로 광고된다 — 실제 호출은 501 로 떨어진다.
    // 계획이 감수하기로 한 한계이며, 나중에 프로브 결과를 반영하도록 바꾸면 이 시험이 알려 준다.
    const { status, body } = await api('/api/core/capabilities?cameraId=idis-1');
    expect(status).toBe(200);
    expect(body.supported.center.ok).toBe(true);
  });

  it('대조군 — park3d-rpc 처럼 centerPoint 가 없는 드라이버는 사유와 함께 미지원이다', async () => {
    // IDIS 의 `ok:true` 가 "모두 true" 라서 나온 값이 아님을 보인다.
    const cameras = (await api('/api/db/cameras')).body.cameras;
    const camId = cameras.find((c: any) => c.cam_uuid === 'cam-a').cam_id;
    await api(`/api/db/cameras/${camId}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'park3d-rpc', park3d_cam_id: 1 }),
    });
    const { body } = await api('/api/core/capabilities?cameraId=cam-a');
    expect(body.supported.center.ok).toBe(false);
    expect(body.supported.center.reason).toContain('픽셀 센터링');
  });
});
