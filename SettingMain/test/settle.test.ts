import { describe, expect, it, vi } from 'vitest';
import { waitForSettle } from '../src/devices/waitForSettle.js';
import type { CameraDriver } from '../src/devices/cameraDriver.js';
import { isSameSpot, panDistance } from '../src/domain/settle.js';
import type { PtzRaw } from '../src/domain/ptz.js';

/**
 * 실측 근거(UE 시뮬레이터 192.168.0.22:8083):
 *   pan 1296 에서 목표 1496 으로 이동 명령 → **직후 읽기 1446**(이동 중) → 2초 뒤 1496.
 * 명령 직후 읽은 값을 최종값으로 쓰면 화면이 "안 움직인다"로 보이고,
 * 그 값을 기준으로 다음 상대 이동을 계산하면 목표가 계속 뒤로 밀린다.
 */

/** 대본대로 좌표를 순서대로 돌려주는 가짜 카메라. */
function scriptedDriver(positions: PtzRaw[]): CameraDriver & { calls: number } {
  let index = 0;
  return {
    cameraId: 'fake',
    kind: 'fake',
    calls: 0,
    async getPtz() {
      const value = positions[Math.min(index, positions.length - 1)]!;
      index += 1;
      this.calls += 1;
      return value;
    },
    async goPtz() {},
    async getSnapshot() {
      return Buffer.alloc(0);
    },
    async getDevicePresetCapability() {
      return { supported: false, advertisedMaxPresetNumber: 0, usableMaxPresetNumber: 0, listing: 'unsupported' as const, naming: 'unsupported' as const, slots: [] };
    },
    async listSlots() {
      return [];
    },
  } as CameraDriver & { calls: number };
}

const noSleep = async (): Promise<void> => {};

describe('panDistance — 0/36000 심을 순환 거리로 잰다', () => {
  it('가까운 값은 그대로', () => {
    expect(panDistance(1000, 1010)).toBe(10);
  });

  it('심을 넘어도 거리는 작다 — 이게 없으면 심 근처에서 정착 판정이 영원히 안 난다', () => {
    expect(panDistance(35990, 5)).toBe(15);
    expect(panDistance(5, 35990)).toBe(15);
  });

  it('반대편은 최대 18000', () => {
    expect(panDistance(0, 18000)).toBe(18000);
  });
});

describe('isSameSpot', () => {
  const base: PtzRaw = { pan: 1000, tilt: 500, zoom: 8000 };

  it('허용오차 안이면 같은 자리', () => {
    expect(isSameSpot(base, { pan: 1008, tilt: 495, zoom: 8005 })).toBe(true);
  });

  it('한 축이라도 벗어나면 아직 이동 중', () => {
    expect(isSameSpot(base, { pan: 1050, tilt: 500, zoom: 8000 })).toBe(false);
    expect(isSameSpot(base, { pan: 1000, tilt: 600, zoom: 8000 })).toBe(false);
    expect(isSameSpot(base, { pan: 1000, tilt: 500, zoom: 8100 })).toBe(false);
  });
});

describe('waitForSettle', () => {
  it('연속 두 번 같은 값이 나올 때까지 기다린다 — 실측 시나리오 1296 → 1446 → 1496 → 1496', async () => {
    const driver = scriptedDriver([
      { pan: 1296, tilt: 1516, zoom: 100 },
      { pan: 1446, tilt: 1516, zoom: 100 },
      { pan: 1496, tilt: 1516, zoom: 100 },
      { pan: 1496, tilt: 1516, zoom: 100 },
    ]);
    const result = await waitForSettle(driver, { sleep: noSleep });

    expect(result.settled).toBe(true);
    expect(result.ptz.pan).toBe(1496); // 중간값 1446 이 아니라 최종값
    expect(result.reads).toBe(4);
  });

  it('처음부터 멈춰 있으면 두 번만 읽는다', async () => {
    const driver = scriptedDriver([{ pan: 100, tilt: 200, zoom: 300 }]);
    const result = await waitForSettle(driver, { sleep: noSleep });
    expect(result.settled).toBe(true);
    expect(result.reads).toBe(2);
  });

  it('계속 움직이면 상한에서 멈추고 settled:false 로 알린다 — 던지지 않는다', async () => {
    let pan = 0;
    const driver: CameraDriver = {
      cameraId: 'moving',
      kind: 'fake',
      async getPtz() {
        pan += 500;
        return { pan, tilt: 0, zoom: 0 };
      },
      async goPtz() {},
      async getSnapshot() {
        return Buffer.alloc(0);
      },
      async listSlots() {
        return [];
      },
    };
    let clock = 0;
    const result = await waitForSettle(driver, {
      sleep: async () => {
        clock += 250;
      },
      now: () => clock,
      timeoutMs: 1000,
    });

    expect(result.settled).toBe(false);
    expect(result.ptz.pan).toBeGreaterThan(0); // 마지막으로 읽은 값은 여전히 쓸모 있다
  });

  it('심을 넘는 이동도 정착으로 판정한다 — 35995 와 3 은 순환 거리 8cd 라 같은 자리다', async () => {
    const driver = scriptedDriver([
      { pan: 35900, tilt: 0, zoom: 0 },
      { pan: 35995, tilt: 0, zoom: 0 },
      { pan: 3, tilt: 0, zoom: 0 },
    ]);
    const result = await waitForSettle(driver, { sleep: noSleep });
    expect(result.settled).toBe(true);
    expect(result.ptz.pan).toBe(3);
    expect(result.reads).toBe(3);
  });

  it('심을 넘어 계속 이동 중이면 정착으로 오판하지 않는다', async () => {
    const driver = scriptedDriver([
      { pan: 35000, tilt: 0, zoom: 0 },
      { pan: 35500, tilt: 0, zoom: 0 },
      { pan: 200, tilt: 0, zoom: 0 },
      { pan: 205, tilt: 0, zoom: 0 },
    ]);
    const result = await waitForSettle(driver, { sleep: noSleep });
    expect(result.ptz.pan).toBe(205);
    expect(result.reads).toBe(4);
  });

  it('폴링 간격을 설정대로 쓴다', async () => {
    const sleep = vi.fn(async () => {});
    await waitForSettle(scriptedDriver([{ pan: 0, tilt: 0, zoom: 0 }]), { sleep, pollMs: 123 });
    expect(sleep).toHaveBeenCalledWith(123);
  });
});
