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
 * API 계층(VPD·LPD·LPR)의 **서버 경계** 검증. `test/park3dRpcServerRoutes.test.ts` 의 하네스를 복제한다.
 *
 * 여기서 지키는 것은 넷이다.
 *   ① 검출 요청이 **서버 쪽에서 찍은 스냅샷**을 보낸다(브라우저가 이미지를 올리지 않는다)
 *   ② 미설정·미구현 검출기는 카메라를 두드리기 전에 501 로 거절한다
 *   ③ 상류 실패가 조용한 빈 결과가 되지 않는다
 *   ④ 알 수 없는 검출기 이름은 404 다
 */

let dir: string;
let server: Server;
let base: string;
let uploads: Array<{ url: string; body: Buffer }> = [];
let snapshotCalls = 0;

/** 카메라 스냅샷용 JPEG(SOI 포함). 드라이버가 SOI 를 검사하므로 실제 바이트가 필요하다. */
const JPEG = Buffer.from([0xff, 0xd8, 0x00, 0x11, 0x22, 0xff, 0xd9]);

const VPD_BODY = {
  success: true,
  id: 7,
  bboxes: [[10, 20, 110, 120]],
  masks: [],
  confidences: [0.91],
  classes: ['car'],
};

/** Hucoms CGI(스냅샷)와 VPD/LPD 업로드를 함께 흉내 낸다. */
const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));

  if (url.pathname.endsWith('/imgupload')) {
    uploads.push({ url: url.toString(), body: Buffer.from(init?.body as Uint8Array) });
    if (url.pathname.startsWith('/lpd')) {
      return new Response(JSON.stringify({ success: false, id: 8, polygons: [], confidences: [], classes: [] }), { status: 201 });
    }
    return new Response(JSON.stringify(VPD_BODY), { status: 201 });
  }

  // Hucoms 스냅샷 CGI. 그 밖의 CGI 는 이 테스트에서 쓰지 않는다.
  snapshotCalls += 1;
  return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
}) as unknown as typeof fetch;

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function start(detectors: unknown): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'settingmanager-detectors-'));
  uploads = [];
  snapshotCalls = 0;

  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      server: { host: '127.0.0.1', port: 0 },
      simulator: { baseUrl: 'http://127.0.0.1:8080' },
      detectors,
      activeCameraId: 'cam-a',
      cameras: [
        { id: 'cam-a', label: '리얼 1', kind: 'hucoms', controlUrl: 'http://10.0.0.1:80', username: 'admin', password: 'secret', streamUrl: '', timeoutMs: 2000 },
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

  server = createServer({ configStore, presetStore, slotStore, devicePresetRegistryStore, db, fetchImpl: fakeFetch, settleOptions: { sleep: async () => {} } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('GET /api/detectors — 설정 상태', () => {
  beforeEach(() => start({ vpd: { baseUrl: 'http://svc:8001' } }));

  it('셋을 모두 답하고, 못 쓰는 것에는 사유가 붙는다', async () => {
    const { status, body } = await api('/api/detectors');
    expect(status).toBe(200);
    expect(body.detectors).toEqual([
      { name: 'vpd', available: true, baseUrl: 'http://svc:8001', timeoutMs: 15_000 },
      { name: 'lpd', available: false, reason: expect.stringMatching(/설정되지 않았습니다/), baseUrl: '', timeoutMs: 15_000 },
      { name: 'lpr', available: false, reason: expect.stringMatching(/구현이 없습니다/), baseUrl: '', timeoutMs: 15_000 },
    ]);
  });
});

describe('POST /api/detectors/:name/detect', () => {
  beforeEach(() => start({ vpd: { baseUrl: 'http://svc:8001' }, lpd: { baseUrl: 'http://svc:8002' } }));

  it('서버가 스냅샷을 찍어 보낸다 — 요청 본문에 이미지를 싣지 않는다', async () => {
    const { status, body } = await api('/api/detectors/vpd/detect', { method: 'POST' });
    expect(status).toBe(200);
    expect(snapshotCalls).toBe(1);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.url).toBe('http://svc:8001/vpd/api/v2/det/imgupload');
    // 카메라에서 받은 그 바이트가 그대로 올라간다.
    expect(uploads[0]!.body.includes(JPEG)).toBe(true);

    expect(body).toEqual({
      cameraId: 'cam-a',
      detector: 'vpd',
      success: true,
      imageId: 7,
      detections: [{ className: 'car', confidence: 0.91, bbox: [10, 20, 110, 120] }],
    });
  });

  it('검출 0건도 200 이다 — 없는 것을 오류로 만들지 않는다', async () => {
    const { status, body } = await api('/api/detectors/lpd/detect', { method: 'POST' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ detector: 'lpd', success: false, detections: [] });
  });

  /**
   * 회귀 방지 — 예전에는 검출기를 세우기 **전에** 스냅샷을 찍어서, 카메라가 대답하지 않으면
   * 501 이어야 할 답이 502(카메라 통신 실패)로 뒤덮였다(실기 실행에서 잡힌 순서 버그).
   */
  it('LPR 은 501 이고, 카메라를 두드리지 않는다 — 구현이 없다', async () => {
    const { status, body } = await api('/api/detectors/lpr/detect', { method: 'POST' });
    expect(status).toBe(501);
    expect(body.error).toMatch(/LPR/);
    expect(snapshotCalls).toBe(0);
  });

  it('알 수 없는 이름은 404 다', async () => {
    const { status, body } = await api('/api/detectors/nope/detect', { method: 'POST' });
    expect(status).toBe(404);
    expect(body.error).toMatch(/알 수 없는 검출기/);
  });
});

describe('POST /api/detectors/:name/detect — 미설정', () => {
  beforeEach(() => start({}));

  it('설정되지 않은 검출기는 501 이고, 카메라를 두드리지도 않는다', async () => {
    const { status, body } = await api('/api/detectors/vpd/detect', { method: 'POST' });
    expect(status).toBe(501);
    expect(body.error).toMatch(/detectors\.vpd\.baseUrl/);
    expect(snapshotCalls).toBe(0);
    expect(uploads).toHaveLength(0);
  });
});
