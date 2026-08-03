import { describe, expect, it, vi } from 'vitest';
import { LocalCoreProvider } from '../src/core/local/localCoreProvider.js';
import { CameraLeaseRegistry } from '../src/core/local/cameraLease.js';
import { CoreBusyError, CoreUnsupportedError, type CoreContext } from '../src/core/coreProvider.js';
import type { CameraDriver } from '../src/devices/cameraDriver.js';
import { runCoreProviderConformance } from './coreProviderConformance.js';

/**
 * LocalCore 는 backend-core 를 호출하지 않고 선택된 카메라의 드라이버만 쓴다.
 * **RemoteCore 와 같은 적합성 스위트를 통과한다** — 그것이 두 구현이 교체 가능하다는 증거다.
 */

function driver(overrides: Partial<CameraDriver> = {}): CameraDriver {
  let ptz = { pan: 1000, tilt: 500, zoom: 8000 };
  return {
    cameraId: 'cam-a',
    kind: 'hucoms',
    getPtz: async () => ptz,
    goPtz: async (target) => {
      ptz = target;
    },
    centerPoint: async () => {},
    getSnapshot: async () => Buffer.alloc(0),
    listSlots: async () => [],
    ...overrides,
  };
}

function subject(overrides: Partial<CameraDriver> = {}, leases = new CameraLeaseRegistry()) {
  const provider = new LocalCoreProvider({ leases, settleOptions: { sleep: async () => {} } });
  const ctx = { camera: { id: 'cam-a' }, driver: driver(overrides) } as unknown as CoreContext;
  return { provider, ctx, leases };
}

// ★ RemoteCore 와 공유하는 계약의 정본
runCoreProviderConformance('LocalCore (센터링 가능)', () => subject());
runCoreProviderConformance('LocalCore (센터링 불가 드라이버)', () => subject({ centerPoint: undefined }));

describe('LocalCoreProvider 능력', () => {
  it('드라이버가 픽셀 센터링을 하면 center 만 지원한다 — 나머지는 사유와 함께 미지원', async () => {
    const { provider, ctx } = subject();
    const capabilities = await provider.capabilities(ctx);
    expect(capabilities.provider).toBe('local');
    expect(capabilities.supported.center.ok).toBe(true);
    for (const name of ['centerBox', 'discoveryPresets', 'discoveryPoints', 'calibration', 'plateHoming'] as const) {
      expect(capabilities.supported[name].ok).toBe(false);
      expect(capabilities.supported[name].reason).toBeTruthy();
    }
  });

  it('드라이버가 센터링을 못 하면 center 도 미지원이다', async () => {
    const { provider, ctx } = subject({ centerPoint: undefined });
    expect((await provider.capabilities(ctx)).supported.center).toMatchObject({ ok: false });
  });

  it('미지원 능력은 501 이고 backend-core 로 흘려보내지 않는다', async () => {
    const { provider, ctx } = subject();
    await expect(provider.calibration.start(ctx, { mode: 'full' })).rejects.toBeInstanceOf(CoreUnsupportedError);
    await expect(provider.plateHoming.start(ctx, { presetId: 'p' })).rejects.toMatchObject({ statusCode: 501 });
  });
});

describe('LocalCoreProvider 센터링', () => {
  it('드라이버 centerPoint 를 부르고 정착 후 좌표를 답한다', async () => {
    const centerPoint = vi.fn(async () => {});
    const { provider, ctx } = subject({ centerPoint });
    const result = await provider.center(ctx, { x: 1400, y: 800 });

    expect(centerPoint).toHaveBeenCalledWith({ x: 1400, y: 800 });
    expect(result).toMatchObject({ cameraId: 'cam-a', point: { x: 1400, y: 800 }, settled: true });
    expect(result.ptz).toMatchObject({ pan: 1000, panDeg: 10 });
  });

  it('같은 카메라의 동시 센터링은 409 로 막는다', async () => {
    const leases = new CameraLeaseRegistry();
    let release: (() => void) | undefined;
    const { provider, ctx } = subject(
      { centerPoint: async () => new Promise<void>((resolve) => { release = resolve; }) },
      leases,
    );
    const first = provider.center(ctx, { x: 1, y: 1 });
    await expect(provider.center(ctx, { x: 2, y: 2 })).rejects.toBeInstanceOf(CoreBusyError);
    release?.();
    await first;
  });

  it('다른 카메라는 서로 막지 않는다', async () => {
    const leases = new CameraLeaseRegistry();
    const a = subject({}, leases);
    const b = new LocalCoreProvider({ leases, settleOptions: { sleep: async () => {} } });
    const ctxB = { camera: { id: 'cam-b' }, driver: driver() } as unknown as CoreContext;
    await expect(Promise.all([a.provider.center(a.ctx, { x: 1, y: 1 }), b.center(ctxB, { x: 1, y: 1 })])).resolves.toHaveLength(2);
  });

  it('센터링이 실패해도 점유가 반납된다', async () => {
    const leases = new CameraLeaseRegistry();
    const { provider, ctx } = subject({ centerPoint: async () => { throw new Error('카메라 오류'); } }, leases);
    await expect(provider.center(ctx, { x: 1, y: 1 })).rejects.toThrow('카메라 오류');
    expect(leases.isBusy('cam-a')).toBe(false);
  });
});
