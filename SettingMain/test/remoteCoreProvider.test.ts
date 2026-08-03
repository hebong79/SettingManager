import { describe, expect, it, vi } from 'vitest';
import { HttpBackendCoreTransport } from '../src/devices/backendCore/backendCoreTransport.js';
import { RemoteCoreProvider } from '../src/core/remote/remoteCoreProvider.js';
import { CoreUnsupportedError, type CoreContext } from '../src/core/coreProvider.js';
import { runCoreProviderConformance } from './coreProviderConformance.js';

/**
 * 응답 shape 근거 — baro_calory/apps/backend-core/src/control-api.mjs:
 *   GET /api/cctv/capabilities → { cameraId, declared, axes: { calibration: {supported, missing[]}, … } }  (:138)
 *   POST /api/center           → 센터링 결과 JSON                                                          (:445 경유)
 *   GET /api/discovery/presets → { cameraId, presets[], busy }                                             (:453)
 *   /api/calibration/{start,status,stop} · /api/discovery/plate-home/{…}
 */

const CAMERA = { id: 'sim-1', label: '시뮬', kind: 'backend-core', controlUrl: '', username: '', password: '', streamUrl: '', timeoutMs: 2000 };

function makeProvider(routes: Record<string, unknown>, onCall?: (url: string, init?: RequestInit) => void) {
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    onCall?.(url.toString(), init);
    const body = routes[url.pathname];
    if (body === undefined) return new Response(JSON.stringify({ error: 'not stubbed' }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const provider = new RemoteCoreProvider({
    transport: new HttpBackendCoreTransport({ baseUrl: 'http://127.0.0.1:8080', timeoutMs: 2000, fetchImpl: fetchImpl as unknown as typeof fetch }),
  });
  const ctx = { camera: CAMERA, driver: {} } as unknown as CoreContext;
  return { provider, ctx, fetchImpl };
}

/** 두 축 모두 지원한다고 답하는 backend-core. */
const FULL_CAPABILITIES = {
  '/api/cctv/capabilities': { cameraId: 'sim-1', axes: { calibration: { supported: true, missing: [] }, plateHoming: { supported: true, missing: [] } } },
  '/api/calibration/status': { state: 'idle' },
  '/api/calibration/stop': { state: 'stopped' },
  '/api/discovery/plate-home/status': { state: 'idle' },
  '/api/discovery/plate-home/stop': { stopped: false },
  '/api/center': { ok: true },
  '/api/simulator/slots': { slots: [] },
  '/api/discovery/presets': { presets: [] },
  '/api/discovery/presets/preset-1/points': { points: [] },
};

// ★ 계약의 정본 — LocalCore 도 같은 스위트를 통과해야 한다.
runCoreProviderConformance('RemoteCore (능력 전부 지원)', () => makeProvider(FULL_CAPABILITIES));

runCoreProviderConformance('RemoteCore (축 미지원)', () =>
  makeProvider({
    ...FULL_CAPABILITIES,
    '/api/cctv/capabilities': {
      cameraId: 'sim-1',
      axes: { calibration: { supported: false, missing: ['pixelCentering'] }, plateHoming: { supported: false, missing: [] } },
    },
  }),
);

runCoreProviderConformance('RemoteCore (backend-core 도달 불가)', () => makeProvider({}));

describe('RemoteCoreProvider 능력 판정', () => {
  it('backend-core 의 축 응답을 그대로 옮긴다', async () => {
    const { provider, ctx } = makeProvider(FULL_CAPABILITIES);
    const capabilities = await provider.capabilities(ctx);
    expect(capabilities.provider).toBe('remote');
    expect(capabilities.supported.calibration.ok).toBe(true);
    expect(capabilities.supported.plateHoming.ok).toBe(true);
  });

  it('축이 없다고 답하면 무엇이 모자란지 사유에 싣는다', async () => {
    const { provider, ctx } = makeProvider({
      ...FULL_CAPABILITIES,
      '/api/cctv/capabilities': { axes: { calibration: { supported: false, missing: ['absolutePosition', 'pixelCentering'] }, plateHoming: { supported: true } } },
    });
    const capabilities = await provider.capabilities(ctx);
    expect(capabilities.supported.calibration.ok).toBe(false);
    expect(capabilities.supported.calibration.reason).toContain('absolutePosition·pixelCentering');
  });

  it('backend-core 에 도달하지 못하면 지원한다고 지어내지 않는다', async () => {
    const { provider, ctx } = makeProvider({});
    const capabilities = await provider.capabilities(ctx);
    expect(Object.values(capabilities.supported).every((state) => !state.ok)).toBe(true);
    expect(capabilities.supported.center.reason).toContain('능력 조회 실패');
  });

  it('centerBox 는 항상 501 — discovery point 에 box 정본이 없다', async () => {
    const { provider, ctx } = makeProvider(FULL_CAPABILITIES);
    await expect(provider.centerBox(ctx, { startX: 1, startY: 2, endX: 3, endY: 4 })).rejects.toBeInstanceOf(CoreUnsupportedError);
  });
});

describe('RemoteCoreProvider 전송 계약', () => {
  it('center 는 계약 프레임(1920×1080)과 속도를 채워 보낸다', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const { provider, ctx } = makeProvider(FULL_CAPABILITIES, (url, init) => calls.push({ url, init }));
    await provider.center(ctx, { x: 100, y: 200 });
    const call = calls.find((c) => c.url.endsWith('/api/center'))!;
    expect(JSON.parse(String(call.init?.body))).toEqual({ x: 100, y: 200, frameWidth: 1920, frameHeight: 1080, speed: 50 });
  });

  it('프리셋 id 는 경로에서 인코딩된다', async () => {
    const calls: string[] = [];
    const { provider, ctx } = makeProvider({ '/api/discovery/presets/p%201/points': { points: [] } }, (url) => calls.push(url));
    await provider.discoveryPoints.list(ctx, 'p 1');
    expect(calls[0]).toBe('http://127.0.0.1:8080/api/discovery/presets/p%201/points');
  });

  it('원격이 실어 보낸 추가 필드를 깎지 않는다', async () => {
    const { provider, ctx } = makeProvider({
      ...FULL_CAPABILITIES,
      '/api/calibration/status': { state: 'running', mode: 'full', deviceId: 'cam-001', recent: [1, 2] },
    });
    const status = await provider.calibration.status(ctx);
    expect(status).toMatchObject({ state: 'running', mode: 'full', deviceId: 'cam-001', recent: [1, 2] });
  });

  it('state 가 없는 응답은 idle 로 본다 — 지어낸 진행 상태보다 낫다', async () => {
    const { provider, ctx } = makeProvider({ ...FULL_CAPABILITIES, '/api/discovery/plate-home/stop': { stopped: false } });
    expect((await provider.plateHoming.stop(ctx)).state).toBe('idle');
  });
});
