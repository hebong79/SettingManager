import { describe, expect, it, vi } from 'vitest';
import { aimPixel, hfovForBox } from '../src/centering/aimChain.js';
import { CenteringComponent } from '../src/centering/centeringComponent.js';
import { SoftwareCenteringError, planSoftwareCenter, softwareCenteringGate } from '../src/centering/softwareCentering.js';
import type { CameraConfig, CameraIntrinsics } from '../src/config/types.js';
import type { CameraDriver, CenterPoint } from '../src/devices/cameraDriver.js';
import type { PtzRaw } from '../src/domain/ptz.js';

/**
 * 센터라이징 — **살아 있던 결함을 고쳤다는 것을 값으로 못 박는다.**
 *
 * 2026-08-07 이전 `BridgeCoreProvider.center()` 는 클릭 픽셀을 게인 없이 넘겼다. 증상이
 * 조용해서(중앙 근처는 멀쩡) 아무도 신고하지 않았다 — 그래서 테스트가 필요하다.
 */

/** cam-001 실측 곡선의 앵커 일부. */
const INTRINSICS: CameraIntrinsics = {
  zoomHfov: [{ z: 0, h: 57.14 }, { z: 8000, h: 22.59 }, { z: 16384, h: 2.39 }],
  // z8000 에서 **10% 부족 회전**, z16384 에서는 반대로 **과회전**(1 아래) — 단조가 아니다.
  centeringGain: [{ z: 0, k: 0.988 }, { z: 8000, k: 1.11 }, { z: 16384, k: 0.765 }],
};

function camera(overrides: Partial<CameraConfig> = {}): CameraConfig {
  return {
    id: 'cam-a', label: 'cam-a', kind: 'hucoms', controlUrl: 'http://10.0.0.1',
    username: 'u', password: 'p', streamUrl: '', timeoutMs: 2000, ...overrides,
  };
}

interface FakeDriverOptions {
  ptz?: PtzRaw;
  withCenterPoint?: boolean;
  zoomRange?: { min: number; max: number };
}

function fakeDriver(options: FakeDriverOptions = {}): CameraDriver & { centered: CenterPoint[]; moved: PtzRaw[] } {
  const state = { ...(options.ptz ?? { pan: 12_000, tilt: 1_681, zoom: 8000 }) };
  const centered: CenterPoint[] = [];
  const moved: PtzRaw[] = [];
  const driver: CameraDriver & { centered: CenterPoint[]; moved: PtzRaw[] } = {
    cameraId: 'cam-a',
    kind: 'fake',
    centered,
    moved,
    ...(options.zoomRange ? { zoomRange: options.zoomRange } : {}),
    async getPtz() { return { ...state }; },
    async goPtz(target) { moved.push({ ...target }); Object.assign(state, target); },
    async getSnapshot() { return Buffer.alloc(0); },
    async listSlots() { return []; },
  };
  if (options.withCenterPoint !== false) driver.centerPoint = async (point) => { centered.push(point); };
  return driver;
}

const settleOptions = { sleep: async () => {}, pollMs: 0 };

describe('조준 사슬 — 게인', () => {
  it('게인 표가 있으면 클릭 픽셀을 미리 늘려 보낸다 (z8000 에서 약 11%)', () => {
    // 중앙에서 오른쪽으로 480px. k=1.11 이면 480 × 1.11 = 532.8 → 960 + 533.
    const aimed = aimPixel({ x: 960 + 480, y: 540 }, 8000, INTRINSICS);
    expect(aimed.k).toBeCloseTo(1.11, 3);
    expect(aimed.x).toBe(1493);
    expect(aimed.y).toBe(540); // 중앙선 클릭은 세로로 움직이지 않는다
  });

  it('망원 끝에서는 **반대로 줄인다** — 곡선이 단조가 아니라는 것이 요점이다', () => {
    const aimed = aimPixel({ x: 960 + 480, y: 540 }, 16384, INTRINSICS);
    expect(aimed.k).toBeCloseTo(0.765, 3);
    expect(aimed.x).toBeLessThan(960 + 480); // 1.11 을 그대로 유지했다면 여기서 악화됐을 것이다
  });

  it('게인 표가 없으면 k=1 이다 — 내장 cam-001 곡선을 기본값으로 들지 않는다', () => {
    const aimed = aimPixel({ x: 960 + 480, y: 540 }, 8000, { zoomHfov: INTRINSICS.zoomHfov });
    expect(aimed.k).toBe(1);
    expect(aimed.x).toBe(960 + 480);
  });

  it('광학이 아예 없어도 k=1 로 지나간다 — 조준을 막지는 않는다', () => {
    expect(aimPixel({ x: 100, y: 100 }, 0, undefined).k).toBe(1);
  });

  it('보정된 점이 프레임 밖이면 잘라 넣고 알린다 — 그 클릭은 절반만 보정된 것이다', () => {
    const aimed = aimPixel({ x: 1919, y: 540 }, 8000, INTRINSICS);
    expect(aimed.clamped).toBe(true);
    expect(aimed.x).toBe(1920);
  });

  it('박스 화각은 가로·세로 중 **큰 쪽**을 쓴다 — 작은 쪽이면 박스가 잘린다', () => {
    // 폭 비율 0.5, 높이 비율 0.75 → 0.75 를 써야 세로가 안 잘린다.
    expect(hfovForBox(40, 960, 810)).toBeCloseTo(30, 6);
  });
});

describe('센터링 — 펌웨어 경로', () => {
  it('보정된 픽셀을 드라이버에 넘기고 적용된 게인을 응답에 싣는다', async () => {
    const driver = fakeDriver();
    const result = await new CenteringComponent({ settleOptions }).center(camera({ intrinsics: INTRINSICS }), driver, { x: 1440, y: 540 });

    expect(driver.centered).toEqual([{ x: 1493, y: 540 }]); // ← 게인이 걸린 값
    expect(result.centering).toBe('firmware');
    expect(result.gain).toBeCloseTo(1.11, 3);
    expect(result.settled).toBe(true);
  });

  it('게인이 없어도 센터링은 되고, gain:1 로 **그 사실을 보고한다**', async () => {
    const driver = fakeDriver();
    const result = await new CenteringComponent({ settleOptions }).center(camera(), driver, { x: 1440, y: 540 });
    expect(driver.centered).toEqual([{ x: 1440, y: 540 }]);
    expect(result.gain).toBe(1);
  });
});

describe('소프트웨어 센터링 — 게이트', () => {
  it('실측 화각표가 없으면 세우지 않고, 무엇을 채워야 하는지 말한다', () => {
    const gate = softwareCenteringGate(camera(), fakeDriver({ withCenterPoint: false }));
    expect(gate).toMatchObject({ ok: false });
    expect((gate as { reason: string }).reason).toContain('intrinsics.zoomHfov');
  });

  it('부분 표는 거절한다 — 표 밖 줌에서 조용한 오조준이 된다', () => {
    // 상류 실측: 1점짜리 x1 표 + x12 줌 = 12배 과회전. 여기서는 표가 100~3600 중 100~800 만 덮는다.
    const partial: CameraIntrinsics = { zoomHfov: [{ z: 100, h: 57 }, { z: 800, h: 8 }] };
    const gate = softwareCenteringGate(camera({ intrinsics: partial }), fakeDriver({ withCenterPoint: false, zoomRange: { min: 100, max: 3600 } }));
    expect(gate).toMatchObject({ ok: false });
    expect((gate as { reason: string }).reason).toContain('덮지 않습니다');
  });

  it('범위를 선언하지 않는 기기에는 묻지 않는다 — 우리가 모르는 것을 미달로 삼지 않는다', () => {
    expect(softwareCenteringGate(camera({ intrinsics: INTRINSICS }), fakeDriver({ withCenterPoint: false }))).toEqual({ ok: true });
  });

  it('centerPoint 가 없고 표도 없으면 사유가 **두 겹**이다 — 하나는 못 고치고 하나는 고칠 수 있다', () => {
    const support = new CenteringComponent().centerSupport(camera(), fakeDriver({ withCenterPoint: false }));
    expect(support).toMatchObject({ ok: false });
    const reason = (support as { reason: string }).reason;
    expect(reason).toContain('픽셀 센터링');       // 고칠 수 없는 사실
    expect(reason).toContain('intrinsics.zoomHfov'); // 사람이 채울 수 있는 것
  });
});

describe('소프트웨어 센터링 — 계산 조준', () => {
  it('centerPoint 가 없는 드라이버를 절대 이동으로 세운다 (park3d-rpc 의 수요)', async () => {
    const driver = fakeDriver({ withCenterPoint: false, ptz: { pan: 12_000, tilt: 1_681, zoom: 0 } });
    const result = await new CenteringComponent({ settleOptions })
      .center(camera({ intrinsics: INTRINSICS }), driver, { x: 1440, y: 540 });

    expect(result.centering).toBe('software');
    expect(driver.moved).toHaveLength(1);
    // 오른쪽을 클릭했으니 팬이 커진다(계약 좌표에서 panpos+ 는 대상이 오른쪽).
    expect(driver.moved[0]!.pan).toBeGreaterThan(12_000);
    // 센터링은 줌을 건드리지 않는다.
    expect(driver.moved[0]!.zoom).toBe(0);
  });

  it('가로 클릭에도 틸트가 딸려 움직인다 — 짐벌 결합이며 실측으로 확인된 것이다', () => {
    const plan = planSoftwareCenter({ x: 1440, y: 540 }, { pan: 0, tilt: 1_681, zoom: 0 }, INTRINSICS);
    expect(plan.target.tilt).not.toBe(1_681);
  });

  it('전량 클램프는 **지금** 422 로 거절한다 — 무이동으로 두면 정착 대기 뒤 원인 불명 502 가 된다', () => {
    // 이미 도달범위 위쪽 끝(-2000cd)인데 화면 위를 클릭했다 → 그 방향으로 더 갈 수 없다.
    // 팬은 중앙선 클릭이라 0 이므로 **아무 축도 움직이지 않는다** = 정착이 영원히 안 온다.
    expect(() => planSoftwareCenter({ x: 960, y: 0 }, { pan: 0, tilt: -2_000, zoom: 0 }, INTRINSICS))
      .toThrow(SoftwareCenteringError);
  });

  it('부분 클램프는 막지 않고 **표시**한다 — 갈 수 있는 만큼은 가는 것이 맞다', () => {
    // 위쪽 끝에서 조금 떨어져 있으면 일부는 움직인다. 조용히 자르면 착지 어긋남이 무표시가 된다.
    const plan = planSoftwareCenter({ x: 1440, y: 0 }, { pan: 0, tilt: -1_000, zoom: 0 }, INTRINSICS);
    expect(plan.clamped).toBe(true);
    expect(plan.target.tilt).toBe(-2_000);
    expect(plan.target.pan).not.toBe(0);
  });
});

describe('박스 줌 — 순수 계산', () => {
  it('조준 + 줌인을 한 번의 절대 이동으로 낸다 — 하드웨어 박스줌을 쓰지 않는다', async () => {
    const driver = fakeDriver({ ptz: { pan: 12_000, tilt: 1_681, zoom: 0 } });
    const centerPointSpy = vi.spyOn(driver, 'centerPoint' as never);
    const result = await new CenteringComponent({ settleOptions })
      .centerBox(camera({ intrinsics: INTRINSICS }), driver, { startX: 860, startY: 490, endX: 1060, endY: 590 });

    expect(result.centering).toBe('software');
    expect(centerPointSpy).not.toHaveBeenCalled();
    expect(driver.moved).toHaveLength(1);
    // 박스가 프레임의 일부이므로 줌이 들어가야 한다.
    expect(driver.moved[0]!.zoom).toBeGreaterThan(0);
  });

  it('실측 표가 없으면 501 — 내장 표로 대신 계산하지 않는다', async () => {
    await expect(new CenteringComponent({ settleOptions })
      .centerBox(camera(), fakeDriver(), { startX: 0, startY: 0, endX: 100, endY: 100 }))
      .rejects.toThrow(/zoomHfov/);
  });

  it('1픽셀 미만 박스는 400 으로 거절한다', async () => {
    await expect(new CenteringComponent({ settleOptions })
      .centerBox(camera({ intrinsics: INTRINSICS }), fakeDriver(), { startX: 100, startY: 100, endX: 100, endY: 100 }))
      .rejects.toThrow(/너무 작습니다/);
  });
});
