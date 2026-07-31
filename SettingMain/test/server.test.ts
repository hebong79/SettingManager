import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/api/server.js';
import { ConfigStore } from '../src/config/configStore.js';
import { PresetStore } from '../src/store/presetStore.js';
import { SlotStore } from '../src/store/slotStore.js';

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

/** Hucoms 와이어를 흉내 낸다: text/plain `key = value`. */
const fakeFetch = vi.fn(async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const action = url.searchParams.get('action');
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

  // 정착 대기가 실제 시간을 흘려보내지 않게 한다(로직은 settle.test.ts 가 검증).
  server = createServer({ configStore, presetStore, slotStore, fetchImpl: fakeFetch, settleOptions: { sleep: async () => {} } });
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
    expect(body.cameras).toHaveLength(2);
    expect(body.cameras[0]).not.toHaveProperty('password');
    expect(body.cameras[0].hasPassword).toBe(true);
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
    expect(html).toContain('시뮬레이터 URL');
    // 선택한 기기 하나만 보여주는 편집 폼 구조
    expect(html).toContain('id="cameraSelect"');
    expect(html).toContain('id="editCard"');
    expect(html).toContain('id="applyCamera"');
    // 폼만 있는 페이지는 한쪽 영역만 쓴다
    expect(html).toContain('<main class="narrow">');
  });

  it('web/ 밖으로 나가는 경로는 거부한다', async () => {
    const response = await fetch(`${base}/../config/config.json`, { redirect: 'manual' });
    expect(response.status).toBe(404);
  });

  it('없는 API 경로는 404', async () => {
    expect((await api('/api/nope')).status).toBe(404);
  });
});
