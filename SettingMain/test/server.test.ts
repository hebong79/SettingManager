import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/api/server.js';
import { CameraDriverError } from '../src/clients/cameraDriver.js';
import { ConfigStore } from '../src/config/configStore.js';
import { PresetStore } from '../src/store/presetStore.js';
import { SlotStore } from '../src/store/slotStore.js';
import { DevicePresetRegistryStore } from '../src/store/devicePresetRegistryStore.js';

/**
 * 서버 통합 테스트 — 실제 http 서버를 띄우고 진짜 요청을 보낸다.
 * 카메라 쪽 외부 HTTP 만 fetchImpl 로 가로챈다(응답 shape 근거는 각 클라이언트 테스트 참조).
 */

let dir: string;
let server: Server;
let base: string;
let cameraPtz = { panpos: 3844, tiltpos: 1188, zoompos: 10711 };
/**
 * 이동 명령 뒤 몇 번은 **중간값**을 돌려줄지. UE 시뮬레이터가 PTZ 를 애니메이션으로 움직여
 * 명령 직후 읽기가 중간값을 주는 실측 동작을 재현한다(1296 → 1446 → 1496).
 */
let slewSteps = 0;
let slewFrom = { panpos: 0, tiltpos: 0, zoompos: 0 };
let presetSupported = 'Yes';
let directPresetFactoryCalls = 0;
let directPresetCapabilityCalls = 0;
let directPresetCommands: string[] = [];
let requestedUrls: string[] = [];

/** Hucoms 와이어를 흉내 낸다: text/plain `key = value`. */
const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  requestedUrls.push(url.toString());
  if (url.pathname === '/api/discovery/presets') return new Response(JSON.stringify({ cameraId: 'backend-device', presets: [{ id: 'd1', name: '입구' }], busy: false }));
  if (url.pathname === '/api/discovery/presets/d1/points') return new Response(JSON.stringify({ points: [{ id: 'pt-1', x: 10, y: 20 }] }));
  if (url.pathname === '/api/center-box') return new Response(JSON.stringify({ ok: true }));
  if (url.pathname === '/api/center') {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (body.frameWidth !== 1920 || body.frameHeight !== 1080 || body.speed !== 50) return new Response(JSON.stringify({ error: 'incomplete centering body' }), { status: 400 });
    return new Response(JSON.stringify({ error: 'frame unavailable' }), { status: 422 });
  }
  const action = url.searchParams.get('action');
  if (action === 'getPTZ') return new Response(`PresetSupported = ${presetSupported}\n`);
  if (action === 'getptzfpos') {
    if (slewSteps > 0) {
      slewSteps -= 1;
      const mid = {
        panpos: Math.round((slewFrom.panpos + cameraPtz.panpos) / 2),
        tiltpos: Math.round((slewFrom.tiltpos + cameraPtz.tiltpos) / 2),
        zoompos: Math.round((slewFrom.zoompos + cameraPtz.zoompos) / 2),
      };
      return new Response(`panpos = ${mid.panpos}\ntiltpos = ${mid.tiltpos}\nzoompos = ${mid.zoompos}\n`);
    }
    return new Response(`panpos = ${cameraPtz.panpos}\ntiltpos = ${cameraPtz.tiltpos}\nzoompos = ${cameraPtz.zoompos}\n`);
  }
  if (action === 'goptzfpos') {
    slewFrom = cameraPtz;
    cameraPtz = {
      panpos: Number(url.searchParams.get('panpos')),
      tiltpos: Number(url.searchParams.get('tiltpos')),
      zoompos: Number(url.searchParams.get('zoompos')),
    };
    return new Response('rc = 0\n');
  }
  if (url.pathname.endsWith('/ptz_centering.cgi') && action === 'setcenter') return new Response('rc = 0\n');
  if (url.pathname.endsWith('/jpeg.cgi')) {
    return new Response(Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9]));
  }
  return new Response('Error: unexpected call\n');
}) as unknown as typeof fetch;

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'settingmanager-'));
  cameraPtz = { panpos: 3844, tiltpos: 1188, zoompos: 10711 };
  slewSteps = 0;
  presetSupported = 'Yes';
  directPresetFactoryCalls = 0;
  directPresetCapabilityCalls = 0;
  directPresetCommands = [];
  requestedUrls = [];

  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      server: { host: '127.0.0.1', port: 0 },
      simulator: { baseUrl: 'http://127.0.0.1:8080' },
      activeCameraId: 'cam-a',
      cameras: [
        { id: 'cam-a', label: '리얼 1', kind: 'hucoms', controlUrl: 'http://10.0.0.1:80', username: 'admin', password: 'secret', streamUrl: 'rtsp://10.0.0.1:554/stream1', timeoutMs: 2000 },
        { id: 'sim-1', label: '시뮬', kind: 'backend-core', controlUrl: '', username: '', password: '', streamUrl: '', timeoutMs: 2000 },
      ],
    }),
  );
  await writeFile(join(dir, 'slots.json'), JSON.stringify({ cameras: { 'cam-a': [{ id: 'A-01', label: 'A구역 1번' }] } }));

  const configStore = new ConfigStore(join(dir, 'config.json'));
  await configStore.load();
  const presetStore = new PresetStore(join(dir, 'presets.json'), () => '2026-07-31T00:00:00.000Z');
  await presetStore.load();
  const slotStore = new SlotStore(join(dir, 'slots.json'));
  await slotStore.load();
  const devicePresetRegistryStore = new DevicePresetRegistryStore(join(dir, 'device-preset-registry.json'), () => '2026-08-02T00:00:00.000Z');
  await devicePresetRegistryStore.load();

  // 정착 대기가 실제 시간을 흘려보내지 않게 한다(로직은 settle.test.ts 가 검증).
  server = createServer({
    configStore, presetStore, slotStore, devicePresetRegistryStore, fetchImpl: fakeFetch, settleOptions: { sleep: async () => {} },
    directPresetClientFactory: () => {
      directPresetFactoryCalls += 1;
      return {
      async getCapability() {
        directPresetCapabilityCalls += 1;
        if (presetSupported === 'No') return { supported: false, advertisedMaxPresetNumber: null, usableMaxPresetNumber: 0, listing: 'unsupported' as const, naming: 'unsupported' as const, slots: [] };
        if (presetSupported !== 'Yes') throw new CameraDriverError('PresetSupported capability 응답이 계약과 다릅니다');
        return { supported: true, advertisedMaxPresetNumber: null, usableMaxPresetNumber: 255, listing: 'unsupported' as const, naming: 'unsupported' as const, slots: Array.from({ length: 255 }, (_, index) => ({ index: index + 1, registration: 'unknown' as const, name: null })) };
      },
      async goPreset(number: number) { directPresetCommands.push(`gopreset:${number}`); },
      async getPtz() { directPresetCommands.push('getptzfpos'); return { pan: cameraPtz.panpos, tilt: cameraPtz.tiltpos, zoom: cameraPtz.zoompos }; },
      async goPtz(ptz: { pan: number; tilt: number; zoom: number }) { directPresetCommands.push(`goptzfpos:${ptz.pan}:${ptz.tilt}:${ptz.zoom}`); },
      };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('상태·카메라', () => {
  it('GET /api/health', async () => {
    const { status, body } = await api('/api/health');
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, activeCameraId: 'cam-a' });
  });

  it('GET /api/cameras 는 비밀번호를 싣지 않는다', async () => {
    const { body } = await api('/api/cameras');
    expect(body.activeCameraId).toBe('cam-a');
    expect(body.cameras).toHaveLength(2);
    expect(Object.keys(body.cameras[0]).sort()).toEqual(['controlUrl', 'hasPassword', 'id', 'kind', 'label', 'streamUrl', 'timeoutMs', 'username']);
    expect(body.cameras[0]).not.toHaveProperty('password');
    expect(body.cameras[0].hasPassword).toBe(true);
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('POST /api/cameras/active 는 설정 파일에 반영된다', async () => {
    const { status } = await api('/api/cameras/active', { method: 'POST', body: JSON.stringify({ id: 'sim-1' }) });
    expect(status).toBe(200);
    const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    expect(saved.activeCameraId).toBe('sim-1');
  });

  it('없는 카메라를 활성으로 지정하면 404 — 다른 경로의 "모르는 카메라"와 같은 코드를 쓴다', async () => {
    const { status } = await api('/api/cameras/active', { method: 'POST', body: JSON.stringify({ id: 'ghost' }) });
    expect(status).toBe(404);
  });
});

describe('기기 추가·삭제', () => {
  it('POST /api/cameras 로 등록하면 파일에 남는다', async () => {
    const { status, body } = await api('/api/cameras', { method: 'POST', body: JSON.stringify({ id: 'cam-c', kind: 'backend-core' }) });
    expect(status).toBe(200);
    expect(body.camera).toMatchObject({ id: 'cam-c', label: 'cam-c', kind: 'backend-core' });
    expect(body.activeCameraId).toBe('cam-a'); // 추가가 활성을 옮기지 않는다

    const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    expect(saved.cameras).toHaveLength(3);
  });

  it('중복 ID 는 409', async () => {
    expect((await api('/api/cameras', { method: 'POST', body: JSON.stringify({ id: 'cam-a' }) })).status).toBe(409);
  });

  it('안전하지 않은 ID 는 400', async () => {
    expect((await api('/api/cameras', { method: 'POST', body: JSON.stringify({ id: '../etc' }) })).status).toBe(400);
  });

  it('DELETE 하면 그 기기의 프리셋도 함께 지워진다', async () => {
    await api('/api/presets', { method: 'POST', body: JSON.stringify({ cameraId: 'cam-a', name: '정문' }) });
    expect((await api('/api/presets?cameraId=cam-a')).body.presets).toHaveLength(1);

    const { status, body } = await api('/api/cameras/cam-a', { method: 'DELETE' });
    expect(status).toBe(200);
    expect(body.removedPresets).toBe(1);
    // 활성이던 기기를 지웠으므로 남은 기기로 옮겨 간다
    expect(body.activeCameraId).toBe('sim-1');

    const savedPresets = JSON.parse(await readFile(join(dir, 'presets.json'), 'utf8'));
    expect(savedPresets.presets).toHaveLength(0);
  });

  it('마지막 기기는 409 로 막는다', async () => {
    await api('/api/cameras/sim-1', { method: 'DELETE' });
    expect((await api('/api/cameras/cam-a', { method: 'DELETE' })).status).toBe(409);
  });

  it('없는 기기 삭제는 404', async () => {
    expect((await api('/api/cameras/ghost', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('연결 테스트', () => {
  it('성공하면 ok:true 와 PTZ 를 준다', async () => {
    const { status, body } = await api('/api/cameras/cam-a/test', { method: 'POST' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, cameraId: 'cam-a', kind: 'hucoms' });
    expect(body.ptz).toMatchObject({ pan: 3844, tilt: 1188 });
  });

  it('실패는 예외가 아니라 결과다 — 200 + ok:false + 사유', async () => {
    const { status, body } = await api('/api/cameras/sim-1/test', { method: 'POST' });
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/backend-core/);
  });

  it('저장하지 않은 값으로 시험한다 — 「적용」 전에 URL 을 확인할 수 있다', async () => {
    const { body } = await api('/api/cameras/cam-a/test', {
      method: 'POST',
      body: JSON.stringify({ camera: { controlUrl: 'http://10.9.9.9:80' } }),
    });
    expect(body.ok).toBe(true);
    // 시험은 설정을 바꾸지 않는다
    const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    expect(saved.cameras[0].controlUrl).toBe('http://10.0.0.1:80');
  });

  it('없는 기기는 404', async () => {
    expect((await api('/api/cameras/ghost/test', { method: 'POST' })).status).toBe(404);
  });
});

describe('PTZ', () => {
  it('GET /api/ptz 는 raw 와 도(°)를 함께 준다', async () => {
    const { body } = await api('/api/ptz');
    expect(body.ptz).toMatchObject({ pan: 3844, tilt: 1188, zoom: 10711, panDeg: 38.44, tiltDeg: 11.88 });
  });

  it('POST /api/ptz/absolute 가 카메라를 움직이고 도착 좌표를 돌려준다', async () => {
    const { body } = await api('/api/ptz/absolute', {
      method: 'POST',
      body: JSON.stringify({ pan: 1000, tilt: 500, zoom: 8000 }),
    });
    expect(body.ptz).toMatchObject({ pan: 1000, tilt: 500, zoom: 8000 });
    expect(body.limited).toEqual([]);
  });

  it('도달범위 밖 목표는 잘리고 어느 축이 잘렸는지 알려준다', async () => {
    const { body } = await api('/api/ptz/absolute', {
      method: 'POST',
      body: JSON.stringify({ pan: 0, tilt: 12000, zoom: 99999 }),
    });
    expect(body.limited).toEqual(['tilt', 'zoom']);
    expect(body.ptz).toMatchObject({ tilt: 9000, zoom: 65535 });
  });

  it('좌표가 빠지면 400 — 없는 값을 0 으로 대체하지 않는다', async () => {
    const { status, body } = await api('/api/ptz/absolute', { method: 'POST', body: JSON.stringify({ pan: 1 }) });
    expect(status).toBe(400);
    expect(body.error).toMatch(/tilt/);
  });

  it('POST /api/ptz/nudge 는 현재 자세에서 축 하나만 움직인다', async () => {
    const { body } = await api('/api/ptz/nudge', { method: 'POST', body: JSON.stringify({ axis: 'pan', delta: 200 }) });
    expect(body.ptz).toMatchObject({ pan: 4044, tilt: 1188, zoom: 10711 });
  });

  it('알 수 없는 축은 400', async () => {
    const { status } = await api('/api/ptz/nudge', { method: 'POST', body: JSON.stringify({ axis: 'focus', delta: 1 }) });
    expect(status).toBe(400);
  });

  it('POST /api/ptz/center는 클릭 논리 좌표를 Hucoms point-centering CGI로 보내고 정착 좌표를 돌려준다', async () => {
    const { status, body } = await api('/api/ptz/center', {
      method: 'POST',
      body: JSON.stringify({ cameraId: 'cam-a', x: 1400, y: 800 }),
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ cameraId: 'cam-a', point: { x: 1400, y: 800 }, settled: true, ptz: { pan: 3844, tilt: 1188, zoom: 10711 } });
    const calls = (fakeFetch as unknown as { mock: { calls: Array<[string | URL | Request]> } }).mock.calls;
    const centerCall = calls.find((call) => new URL(String(call[0])).pathname.endsWith('/ptz_centering.cgi'));
    expect(centerCall).toBeDefined();
    const url = new URL(String(centerCall![0]));
    expect(url.pathname).toBe('/cgi-bin/control/ptz_centering.cgi');
    expect(url.searchParams.get('action')).toBe('setcenter');
    expect(url.searchParams.get('type')).toBe('point');
    expect(url.searchParams.get('center.pointx')).toBe('1400');
    expect(url.searchParams.get('center.pointy')).toBe('800');
  });

  it.each([{ x: -1, y: 0 }, { x: 1921, y: 0 }, { x: 0, y: 1081 }, { x: 1.5, y: 0 }, { x: 1 }])('POST /api/ptz/center의 잘못된 좌표 %j는 400이며 장비에 명령을 보내지 않는다', async (body) => {
    const calls = (fakeFetch as unknown as { mock: { calls: unknown[] } }).mock.calls;
    const before = calls.length;
    const response = await api('/api/ptz/center', { method: 'POST', body: JSON.stringify({ cameraId: 'cam-a', ...body }) });
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(before);
  });

  it('이동이 멈춘 뒤의 좌표를 답한다 — 이동 중간값을 최종값으로 보고하지 않는다', async () => {
    // 실측 재현(UE 시뮬): 명령 직후 한 번은 중간값이 잡힌다.
    slewSteps = 1;
    const { body } = await api('/api/ptz/absolute', {
      method: 'POST',
      body: JSON.stringify({ pan: 1496, tilt: 1516, zoom: 100 }),
    });
    expect(body.ptz.pan).toBe(1496); // 중간값(1446)이 아니라 최종값
    expect(body.settled).toBe(true);
  });

  it('연속 nudge 는 멈춘 자세를 기준으로 누적된다 — 중간값을 기준 삼으면 목표가 계속 뒤로 밀린다', async () => {
    slewSteps = 1;
    await api('/api/ptz/absolute', { method: 'POST', body: JSON.stringify({ pan: 1000, tilt: 0, zoom: 0 }) });
    slewSteps = 1;
    const first = await api('/api/ptz/nudge', { method: 'POST', body: JSON.stringify({ axis: 'pan', delta: 200 }) });
    expect(first.body.ptz.pan).toBe(1200);
    slewSteps = 1;
    const second = await api('/api/ptz/nudge', { method: 'POST', body: JSON.stringify({ axis: 'pan', delta: 200 }) });
    expect(second.body.ptz.pan).toBe(1400);
  });
});

describe('요청 본문 인코딩', () => {
  it('UTF-8 이 아닌 본문은 400 으로 거부한다 — 깨진 한글이 설정에 영구히 남는 것을 막는다', async () => {
    // CP949 로 인코딩된 "시뮬" (UTF-8 로 읽으면 U+FFFD 가 된다)
    const cp949 = Buffer.from([
      0x7b, 0x22, 0x63, 0x61, 0x6d, 0x65, 0x72, 0x61, 0x73, 0x22, 0x3a, 0x5b, 0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a,
      0x22, 0x63, 0x61, 0x6d, 0x2d, 0x61, 0x22, 0x2c, 0x22, 0x6c, 0x61, 0x62, 0x65, 0x6c, 0x22, 0x3a, 0x22,
      0xbd, 0xc3, 0xb9, 0xc4, // CP949 "시뮬"
      0x22, 0x7d, 0x5d, 0x7d,
    ]);
    const response = await fetch(`${base}/api/settings`, { method: 'PUT', body: cp949 });
    expect(response.status).toBe(400);

    // 설정은 손대지 않는다
    const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    expect(saved.cameras[0].label).toBe('리얼 1');
  });

  it('정상 UTF-8 한글은 그대로 왕복한다', async () => {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ cameras: [{ id: 'cam-a', label: '정문 시뮬레이터 (UE)' }] }),
    });
    const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    expect(saved.cameras[0].label).toBe('정문 시뮬레이터 (UE)');
    expect(saved.cameras[0].label).not.toContain('�');
  });
});

describe('프리셋 CRUD', () => {
  it('ptz 를 생략하면 현재 자세를 저장한다', async () => {
    const { body } = await api('/api/presets', { method: 'POST', body: JSON.stringify({ name: '정문 와이드' }) });
    expect(body.preset).toMatchObject({ cameraId: 'cam-a', name: '정문 와이드', ptz: { pan: 3844, tilt: 1188, zoom: 10711 } });
  });

  it('목록 → 수정 → 이동 → 삭제가 이어진다', async () => {
    const created = await api('/api/presets', { method: 'POST', body: JSON.stringify({ name: '정문 와이드' }) });
    const id = created.body.preset.id;

    expect((await api('/api/presets')).body.presets).toHaveLength(1);

    const updated = await api(`/api/presets/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: '정문 클로즈업', ptz: { pan: 1000, tilt: 500, zoom: 8000 } }),
    });
    expect(updated.body.preset.name).toBe('정문 클로즈업');

    const moved = await api(`/api/presets/${id}/goto`, { method: 'POST' });
    expect(moved.body.ptz).toMatchObject({ pan: 1000, tilt: 500, zoom: 8000 });

    expect((await api(`/api/presets/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await api('/api/presets')).body.presets).toHaveLength(0);
  });

  it('같은 카메라에서 이름이 겹치면 409', async () => {
    await api('/api/presets', { method: 'POST', body: JSON.stringify({ name: '정문' }) });
    const dup = await api('/api/presets', { method: 'POST', body: JSON.stringify({ name: '정문' }) });
    expect(dup.status).toBe(409);
  });

  it('없는 프리셋 이동은 404', async () => {
    expect((await api('/api/presets/ghost/goto', { method: 'POST' })).status).toBe(404);
  });

  it('프리셋은 파일로 남는다 — 재기동 후에도 살아 있어야 한다', async () => {
    await api('/api/presets', { method: 'POST', body: JSON.stringify({ name: '정문' }) });
    const saved = JSON.parse(await readFile(join(dir, 'presets.json'), 'utf8'));
    expect(saved.presets[0]).toMatchObject({ cameraId: 'cam-a', name: '정문' });
  });
});

describe('주차면', () => {
  it('실카메라는 로컬 등록본에서 읽는다', async () => {
    const { body } = await api('/api/slots?cameraId=cam-a');
    expect(body.source).toBe('local');
    expect(body.slots).toEqual([{ id: 'A-01', label: 'A구역 1번' }]);
  });

  it('등록이 없으면 빈 목록이다 — 지어내지 않는다', async () => {
    const { body } = await api('/api/slots?cameraId=sim-1');
    expect(body.slots).toEqual([]);
  });
});

describe('장비 프리셋 capability', () => {
  it('Hucoms capability는 로컬 프리셋과 분리된 unknown 슬롯 후보를 돌려준다', async () => {
    const { status, body } = await api('/api/device-preset-capability?cameraId=cam-a');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      cameraId: 'cam-a', supported: true, advertisedMaxPresetNumber: null, usableMaxPresetNumber: 255,
      listing: 'unsupported', naming: 'unsupported',
    });
    expect(body.slots).toHaveLength(255);
    expect(body.slots[0]).toEqual({ index: 1, registration: 'unknown', name: null });
    expect(body.slots[254]).toEqual({ index: 255, registration: 'unknown', name: null });
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('PresetSupported = No 는 200 미지원 상태로 구별한다', async () => {
    presetSupported = 'No';
    const { status, body } = await api('/api/device-preset-capability');
    expect(status).toBe(200);
    expect(body).toMatchObject({ supported: false, advertisedMaxPresetNumber: null, usableMaxPresetNumber: 0, slots: [] });
  });

  it.each(['0', '257', '1.5'])('유효하지 않은 capability는 빈 목록으로 위장하지 않고 502다', async (value) => {
    presetSupported = value;
    expect((await api('/api/device-preset-capability')).status).toBe(502);
  });

  it('없는 카메라는 기존 규약대로 404다', async () => {
    expect((await api('/api/device-preset-capability?cameraId=ghost')).status).toBe(404);
  });

  it('BackendCore는 discovery presets와 혼동하지 않고 501이다', async () => {
    const { status, body } = await api('/api/device-preset-capability?cameraId=sim-1');
    expect(status).toBe(501);
    expect(body.error).toMatch(/장비 프리셋 capability/);
    expect(directPresetFactoryCalls).toBe(0);
  });

  it('capability route는 BackendCore driver factory를 거치지 않는다', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'api', 'server.ts'), 'utf8');
    const start = source.indexOf("pathname === '/api/device-preset-capability'");
    const end = source.indexOf("pathname === '/api/cameras'", start);
    const route = source.slice(start, end);
    expect(route).not.toContain('driverFor(');
    expect(route).not.toContain('createDriver(');
    expect(route).not.toContain('BackendCoreClient');
  });
});

describe('Hucoms 장비 프리셋 레지스트리', () => {
  it('preset 이동은 캐시를 변경하지 않고 명시 coordinate 이동은 동기화된 raw 좌표만 쓴다', async () => {
    const initial = await api('/api/cameras/cam-a/device-presets');
    expect(initial.status).toBe(200);
    expect(initial.body.entries).toHaveLength(10);
    expect(initial.body.entries[0]).toMatchObject({ number: 1, name: null, flags: ['generic', 'unlearned'], ptz: null });

    const movedPreset = await api('/api/cameras/cam-a/device-presets/1/go', { method: 'POST', body: JSON.stringify({ mode: 'preset' }) });
    expect(movedPreset.status).toBe(200);
    expect(movedPreset.body).toMatchObject({ mode: 'preset', settled: true, ptz: { pan: 3844, tilt: 1188, zoom: 10711 } });
    expect(directPresetCommands).toEqual(['gopreset:1', 'getptzfpos', 'getptzfpos']);
    expect((await api('/api/cameras/cam-a/device-presets')).body.entries[0]).toMatchObject({ ptz: null, learnedAt: null });

    directPresetCommands = [];
    const synced = await api('/api/cameras/cam-a/device-presets/1/sync-coordinate', { method: 'POST', body: '{}' });
    expect(synced.status).toBe(200);
    expect(synced.body).toMatchObject({ mode: 'synced', settled: true, ptz: { pan: 3844, tilt: 1188, zoom: 10711 } });
    expect(directPresetCommands).toEqual(['gopreset:1', 'getptzfpos', 'getptzfpos']);

    directPresetCommands = [];
    const moved = await api('/api/cameras/cam-a/device-presets/1/go', { method: 'POST', body: JSON.stringify({ mode: 'coordinate' }) });
    expect(moved.status).toBe(200);
    expect(moved.body.mode).toBe('coordinate');
    expect(directPresetCommands).toEqual(['goptzfpos:3844:1188:10711', 'getptzfpos', 'getptzfpos']);
  });

  it('좌표 미학습 coordinate 요청과 잘못된 번호는 장비 명령 없이 거절한다', async () => {
    const missing = await api('/api/cameras/cam-a/device-presets/2/go', { method: 'POST', body: JSON.stringify({ mode: 'coordinate' }) });
    expect(missing.status).toBe(409);
    expect(missing.body.error).toContain('COORDINATE_NOT_SYNCED');
    expect(directPresetFactoryCalls).toBe(0);
    expect(directPresetCapabilityCalls).toBe(0);
    expect((await api('/api/cameras/cam-a/device-presets/256/go', { method: 'POST' })).status).toBe(400);
    expect(directPresetCommands).toEqual([]);
  });

  it.each([undefined, {}, { expectedMode: 'learn' }, { mode: 'preset', extra: true }, { mode: 'learn' }])('go body %j 는 정확한 mode 계약이 아니면 400이며 명령이 없다', async (body) => {
    const response = await api('/api/cameras/cam-a/device-presets/1/go', { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
    expect(response.status).toBe(400);
    expect(directPresetCommands).toEqual([]);
  });

  it.each([{ mode: 'preset' }, { extra: true }])('sync body %j 는 빈 객체 계약이 아니면 400이며 명령이 없다', async (body) => {
    const response = await api('/api/cameras/cam-a/device-presets/1/sync-coordinate', { method: 'POST', body: JSON.stringify(body) });
    expect(response.status).toBe(400);
    expect(directPresetCommands).toEqual([]);
  });

  it('real-camera-2 seed는 EV1/EV2만 영속 항목으로 제공한다', async () => {
    // 설정 fixture에 없는 camera이므로 도메인 저장소 seed 계약은 별도 저장소 테스트에서 검증한다.
    const source = await readFile(join(process.cwd(), 'src', 'domain', 'devicePresetRegistry.ts'), 'utf8');
    expect(source).toContain("cameraId !== 'real-camera-2'");
    expect(source).toContain("seedEntry(1, 'EV1')");
    expect(source).toContain("seedEntry(2, 'EV2')");
  });
});

describe('BackendCore 탐색 프록시', () => {
  it('주차면 탐색의 명시적 opt-in은 hucoms 활성 카메라도 전역 BackendCore URL로 프록시한다', async () => {
    const { status, body } = await api('/api/discovery/presets?useBackendCore=1');
    expect(status).toBe(200);
    expect(body).toMatchObject({ cameraId: 'backend-device', presets: [{ id: 'd1' }] });
  });

  it('주차면 탐색 checkbox opt-in 없는 고급 작업은 명시적으로 막는다', async () => {
    const { status, body } = await api('/api/discovery/presets');
    expect(status).toBe(409);
    expect(body.error).toMatch(/체크박스/);
  });

  it.each([
    ['/api/discovery/presets', undefined],
    ['/api/discovery/calibration/start', { mode: 'full' }],
    ['/api/center', { x: 10, y: 20 }],
    ['/api/discovery/plate-home/start', { presetId: 'd1' }],
    ['/api/vla/tour', { zoomIn: false, saveSpots: false }],
  ])('checkbox opt-in 없는 고급 경로 %s 는 409로 막는다', async (path, body) => {
    const response = await api(path, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/BackendCore/);
  });

  it('discovery point에 box 정본이 없으므로 센터+줌은 서버에서 명시적으로 미지원 처리한다', async () => {
    const response = await api('/api/center-box?useBackendCore=1', { method: 'POST', body: JSON.stringify({ startX: 1, startY: 2, endX: 3, endY: 4 }) });
    expect(response.status).toBe(501);
    expect(response.body.error).toMatch(/box 좌표/);
  });

  it('BackendCore capability 오류(422)는 프록시에서도 보존한다', async () => {
    const response = await api('/api/center?useBackendCore=1', { method: 'POST', body: JSON.stringify({ x: 10, y: 20 }) });
    expect(response.status).toBe(422);
    expect(response.body.error).toMatch(/422/);
  });
});

describe('설정(옵션 페이지)', () => {
  it('GET /api/settings 는 비밀번호를 싣지 않는다', async () => {
    const { body } = await api('/api/settings');
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(body.simulator.baseUrl).toBe('http://127.0.0.1:8080');
  });

  it('카메라 한 건만 보내도 나머지 설정은 그대로다 — 옵션 페이지의 「이 기기 적용」 경로', async () => {
    const { status, body } = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ cameras: [{ id: 'cam-a', label: '정문 카메라', controlUrl: 'http://10.0.0.5:80' }] }),
    });
    expect(status).toBe(200);
    expect(body.cameras[0]).toMatchObject({ label: '정문 카메라', controlUrl: 'http://10.0.0.5:80' });

    const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    expect(saved.simulator.baseUrl).toBe('http://127.0.0.1:8080');
    expect(saved.activeCameraId).toBe('cam-a');
    expect(saved.cameras[1]).toMatchObject({ id: 'sim-1', label: '시뮬' });
  });

  it('시뮬레이터 URL 만 보내도 카메라는 그대로다', async () => {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ simulator: { baseUrl: 'http://sim:9090' } }) });
    const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    expect(saved.simulator.baseUrl).toBe('http://sim:9090');
    expect(saved.cameras[0]).toMatchObject({ label: '리얼 1', password: 'secret' });
  });

  it('활성 기기만 보내도 나머지는 그대로다 — 「이 기기를 활성으로」 경로', async () => {
    const { body } = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ activeCameraId: 'sim-1' }) });
    expect(body.activeCameraId).toBe('sim-1');
    const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    expect(saved.cameras[0]).toMatchObject({ password: 'secret' });
  });

  it('옛 필드명 rtspUrl 로 보내도 저장된다 — 옛 화면이 열려 있어도 입력이 버려지지 않는다', async () => {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ cameras: [{ id: 'cam-a', rtspUrl: 'http://192.168.0.22:8092/' }] }),
    });
    const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    expect(saved.cameras[0].streamUrl).toBe('http://192.168.0.22:8092/');
  });

  it('타입을 바꿔 저장할 수 있다', async () => {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ cameras: [{ id: 'cam-a', kind: 'backend-core' }] }) });
    const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    expect(saved.cameras[0].kind).toBe('backend-core');
  });

  it('빈 비밀번호로 저장해도 기존 비밀번호가 살아 있다', async () => {
    const { status } = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        simulator: { baseUrl: 'http://sim:9090' },
        cameras: [{ id: 'cam-a', label: '이름 변경', streamUrl: 'rtsp://10.0.0.9:554/s' }],
      }),
    });
    expect(status).toBe(200);

    const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    expect(saved.cameras[0]).toMatchObject({ label: '이름 변경', password: 'secret', streamUrl: 'rtsp://10.0.0.9:554/s' });
    expect(saved.simulator.baseUrl).toBe('http://sim:9090');
  });
});

describe('영상·정적 파일', () => {
  it('GET /api/snapshot 은 JPEG 를 그대로 넘긴다', async () => {
    const response = await fetch(`${base}/api/snapshot`);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it('/ 는 카메라 제어 페이지를 준다', async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('카메라 제어');
  });

  it('/options 는 확장자 없이도 옵션 페이지로 간다', async () => {
    const response = await fetch(`${base}/options`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('BackendCore URL');
    // 선택한 기기 하나만 보여주는 편집 폼 구조
    expect(html).toContain('id="cameraSelect"');
    expect(html).toContain('id="editCard"');
    expect(html).toContain('id="applyCamera"');
    // 폼만 있는 페이지는 한쪽 영역만 쓴다
    expect(html).toContain('<main class="narrow">');
  });

  it('카메라 제어 정적 계약은 대상 선택 안에서 로컬 프리셋과 분리된 읽기 전용 장비 슬롯 후보 UI를 둔다', async () => {
    const html = await readFile(join(process.cwd(), 'web', 'index.html'), 'utf8');
    const source = await readFile(join(process.cwd(), 'web', 'control.js'), 'utf8');
    const apiSource = await readFile(join(process.cwd(), 'web', 'api.js'), 'utf8');
    const targetStart = html.indexOf('<h2>대상 선택');
    const targetEnd = html.indexOf('</section>', targetStart);
    const cameraSelect = html.indexOf('id="cameraSelect"');
    const devicePresetArea = html.indexOf('id="devicePresetArea"');
    const presetSelect = html.indexOf('id="presetSelect"');

    expect(targetStart).toBeGreaterThanOrEqual(0);
    expect(targetEnd).toBeGreaterThan(devicePresetArea);
    expect(cameraSelect).toBeLessThan(devicePresetArea);
    expect(devicePresetArea).toBeLessThan(presetSelect);
    expect(html).toContain('class="device-preset-section"');
    expect(html).not.toContain('<section class="card" aria-labelledby="devicePresetTitle">');
    expect(html).toContain('<h3 id="devicePresetTitle">장비 프리셋</h3>');
    expect(html).toContain('id="devicePresetRefresh"');
    expect(html).toContain('id="devicePresetArea"');
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true" aria-busy="false"');
    expect(html).toContain('aria-controls="devicePresetArea" aria-label="장비 프리셋 다시 시도"');
    expect(html).toContain('id="devicePresetGo"');
    expect(html).toContain('id="devicePresetSync"');
    expect(apiSource).toContain('devicePresets: (cameraId)');
    expect(apiSource).toContain('goDevicePreset: (cameraId, number, mode)');
    expect(apiSource).toContain('syncDevicePresetCoordinate: (cameraId, number)');
    expect(source).toContain('id="devicePresetSelect"');
    expect(source).toContain('id="devicePresetMode"');
    expect(source).toContain('프리셋 → 좌표 동기화');
    expect(source).toContain("go.textContent = state.devicePresetMode === 'preset' ? '프리셋 이동' : '좌표 이동';");
  });

  it('장비 프리셋 capability는 초기·카메라 변경에 자동 조회하고 오래된 응답을 차단한다', async () => {
    const source = await readFile(join(process.cwd(), 'web', 'control.js'), 'utf8');

    expect(source).toContain('await Promise.all([loadDevicePresetCapability(), loadPresets().catch(reportError), loadSlots()]);');
    expect(source).toContain('await Promise.all([loadDevicePresetCapability(), loadPresets(), loadSlots(), refreshPtz().catch(() => {})]);');
    expect(source).toContain('const requestedCameraId = state.cameraId;');
    expect(source).toContain('const requestGeneration = ++devicePresetRequestGeneration;');
    expect(source).toContain('const isCurrentRequest = () => state.cameraId === requestedCameraId && devicePresetRequestGeneration === requestGeneration;');
    expect(source).toContain('api.devicePresets(requestedCameraId)');
    expect(source).toContain("area.setAttribute('aria-busy', 'true');");
    expect(source).toContain("area.setAttribute('aria-busy', 'false');");
    expect(source).toContain("button.disabled = true;");
    expect(source).toContain("button.disabled = false;");
  });

  it('장비 프리셋 502·501·계약 오류는 후보를 합성하지 않고 재시도 상태로 렌더링한다', async () => {
    const source = await readFile(join(process.cwd(), 'web', 'control.js'), 'utf8');

    expect(source).toContain("$('devicePresetTag').textContent = '조회 실패';");
    expect(source).toContain('장비 프리셋 정보를 불러오지 못했습니다. 잠시 후 “다시 시도”를 눌러 주세요.');
    expect(source).toContain('validateDevicePresetResponse(response);');
    expect(source).toContain("state.devicePresetCapability = null;");
    expect(source).not.toContain('Array.from({ length: 128 }');
    expect(source).not.toContain('Array.from({length:128}');
    expect(source).not.toContain('devicePresetCapability(state.cameraId).catch');
  });

  it('/discovery 는 항상 보이는 고급 UI와 BackendCore 연결 안내를 제공한다', async () => {
    const response = await fetch(`${base}/discovery`);
    const html = await response.text();
    expect(html).toContain('주차면 탐색');
    expect(html).toContain('탐색 프리셋');
    expect(html).toContain('주차면 점');
    expect(html).toContain('자동 작업');
    expect(html).toContain('캘리브레이션');
    expect(html).toContain('번호판 호밍');
    expect(html).toContain('VLA 투어');
    expect(html).toContain('개별 센터+줌 (미지원)');
    expect(html).toContain('id="advanced"');
    expect(html).not.toContain('id="advanced" hidden');
    expect(html).toContain('<div class="layout discovery-layout">');
    expect(html).toContain('<section id="discoveryTarget" class="card">');
    expect(html).toContain('<aside id="discoveryViewer" class="discovery-view" aria-label="선택 카메라 영상">');
    expect(html.indexOf('id="discoveryTarget"')).toBeLessThan(html.indexOf('id="discoveryViewer"'));
    expect(html.indexOf('id="discoveryViewer"')).toBeLessThan(html.indexOf('id="advanced"'));
    expect(html).toContain('id="cameraNote"');
    expect(html).toContain('id="stream"');
    expect(html).toContain('class="placeholder" id="streamPlaceholder"');
    expect(html).toContain('id="streamTag" aria-live="polite"');
    expect(html).toContain('alt="선택한 카메라의 영상"');
    expect(html).toContain('id="streamStart"');
    expect(html).toContain('id="streamStop"');
    expect(html).toContain('id="snapshotOnce"');
    expect(html).toContain('type="button" aria-controls="stream" disabled>시작');
    expect(html).toContain('type="button" aria-controls="stream" disabled>정지');
    expect(html).toContain('type="button" aria-controls="stream" disabled>스냅샷 1장');
    expect(html.indexOf('id="streamStart"')).toBeLessThan(html.indexOf('id="advanced"'));
    expect(html).toContain('href="/options"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('id="status" role="status" aria-live="polite" aria-atomic="true"');
    expect(html).toContain('/discovery.js');
  });

  it('discovery CSS는 데스크톱 좌우 grid와 모바일 DOM 순서를 보존한다', async () => {
    const css = await readFile(join(process.cwd(), 'web', 'app.css'), 'utf8');

    expect(css).toContain('.discovery-layout {');
    expect(css).toContain('grid-template-columns: minmax(320px, 420px) minmax(0, 1fr);');
    expect(css).toContain('"target viewer"');
    expect(css).toContain('"advanced viewer"');
    expect(css).toContain('#discoveryTarget { grid-area: target; }');
    expect(css).toContain('#discoveryViewer { grid-area: viewer; min-width: 0; }');
    expect(css).toContain('#advanced { grid-area: advanced; min-width: 0; }');
    expect(css).toContain('#advanced > .card { width: 100%; }');
    expect(css).toContain('@media (min-width: 1101px)');
    expect(css).toContain('#discoveryViewer { position: sticky; top: 72px; }');
    expect(css).toContain('@media (max-width: 1100px)');
    expect(css).toMatch(/"target"\r?\n      "viewer"\r?\n      "advanced";/);
    expect(css).toContain('#discoveryViewer { position: static; }');
    expect(css).toContain('.discovery-stream-actions .row { justify-content: flex-end; }');
  });

  it('discovery 정적 계약은 화면 BackendCore 체크박스·활성 카메라 이중 게이트와 안전한 비활성 상태를 보존한다', async () => {
    const source = await readFile(join(process.cwd(), 'web', 'discovery.js'), 'utf8');
    const html = await readFile(join(process.cwd(), 'web', 'discovery.html'), 'utf8');

    // 화면의 명시적인 BackendCore 선택과 활성 카메라 일치가 있어야 고급 API를 쓸 수 있다.
    expect(source).toContain("const useBackendCore=$('useBackendCore').checked;");
    expect(source).toContain('advanced=Boolean(useBackendCore && c && c.id===activeCameraId);');
    expect(source).toContain('useBackendCore=1');
    // 비활성 시 먼저 poller를 해제하고, discovery 조회·새 poller는 advanced 분기 안에서만 시작한다.
    expect(source).toContain('clearInterval(poller); poller=0;');
    expect(source).toContain('if (advanced) {');
    expect(source).toContain('await loadPresets(); await poll(); poller=setInterval(poll,1500);');
    // 고급 영역 내 모든 native form control을 토글하며 centerBox만은 항상 disabled다.
    expect(source).toContain("querySelectorAll('input, select, button')");
    expect(source).toContain("control.disabled = disabled || control.id === 'centerBox';");
    expect(source).toContain("control.id === 'centerBox' ? 'BackendCore discovery point는 box 좌표를 저장하지 않습니다'");
    // checkbox/활성 불일치 안내에서 기존 옵션 화면과 활성화 절차를 제공한다.
    expect(source).toContain('<a href="/options">/options</a>');
    expect(source).toContain('선택한 카메라를 먼저 <strong>활성으로 선택</strong>하세요');
    // 선택 카메라만으로 읽기 URL을 만들며, 활성 카메라나 고급 API를 변경하지 않는다.
    expect(source).toContain('/api/stream?cameraId=${encodeURIComponent(cameraId)}&t=${Date.now()}');
    expect(source).toContain('/api/snapshot?cameraId=${encodeURIComponent(cameraId)}&t=${Date.now()}');
    expect(source).toContain("$('cameraSelect').addEventListener('change', () => { stopStream();");
    expect(source).toContain("addEventListener('pagehide', () => { stopStream(); clearInterval(poller); poller=0; });");
    expect(source).toContain("image.removeAttribute('src');");

    // 레이아웃 재배치 뒤에도 discovery.js가 직접 소비하는 모든 ID는 정확히 한 번 남아야 한다.
    const consumedIds = new Set([...source.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]));
    for (const id of consumedIds) {
      expect(html.match(new RegExp(`id="${id}"`, 'g'))).toHaveLength(1);
    }
  });

  it('점 추가 UI는 선택된 기존 점과 무관하게 collection POST를 만든다', async () => {
    const source = await readFile(join(process.cwd(), 'web', 'discovery.js'), 'utf8');
    expect(source).toContain("const pointId=method==='POST'?undefined:q.id");
    expect(source).toContain('points${pointId?');
  });

  it('web/ 밖으로 나가는 경로는 거부한다', async () => {
    const response = await fetch(`${base}/../config/config.json`, { redirect: 'manual' });
    expect(response.status).toBe(404);
  });

  it('없는 API 경로는 404', async () => {
    expect((await api('/api/nope')).status).toBe(404);
  });

  it('독립 CameraCore capability와 center는 선택 cameraId의 직접 Hucoms 경로만 사용한다', async () => {
    const capability = await api('/api/independent-core/cameras/cam-a/capabilities');
    expect(capability.status).toBe(200);
    expect(capability.body).toEqual({ cameraId: 'cam-a', center: true, calibration: false, plateHoming: false, busy: false });

    const callsBeforeCenter = requestedUrls.length;
    const centered = await api('/api/independent-core/cameras/cam-a/center', { method: 'POST', body: JSON.stringify({ x: 960, y: 540 }) });
    expect(centered.status).toBe(200);
    expect(centered.body).toMatchObject({ cameraId: 'cam-a', point: { x: 960, y: 540 }, settled: true });
    const centerCalls = requestedUrls.slice(callsBeforeCenter);
    expect(centerCalls.some((url) => url.includes('/ptz_centering.cgi'))).toBe(true);
    expect(centerCalls.some((url) => url.includes('/api/center'))).toBe(false);
  });

  it('독립 CameraCore center는 논리 프레임 밖 좌표를 400으로 거부한다', async () => {
    const response = await api('/api/independent-core/cameras/cam-a/center', { method: 'POST', body: JSON.stringify({ x: 1921, y: 540 }) });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('x 는 0..1920 정수여야 합니다');
  });
});
