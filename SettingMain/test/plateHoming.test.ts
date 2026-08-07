import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CameraLockStore } from '../src/calibration/cameraLock.js';
import { HomeTraceStore } from '../src/homing/homeTraceStore.js';
import {
  PlateHomingJobRunner,
  type HomingPreset,
  type HomingStatus,
  type HomingStorePort,
} from '../src/homing/plateHomingJob.js';
import { PlateHomingComponent } from '../src/homing/plateHomingComponent.js';
import type { CameraConfig } from '../src/config/types.js';
import type { CameraDriver, CenterPoint, Slot } from '../src/devices/cameraDriver.js';
import type { Detection, DetectorClient, DetectorResult } from '../src/detectors/detectorTypes.js';
import type { PtzRaw } from '../src/domain/ptz.js';

/**
 * 호밍 잡의 **모든 종료 경로**를 가짜 카메라·가짜 검출기로 훑는다.
 *
 * 이 잡은 실제로 카메라를 수십 번 움직이고 검출기를 그만큼 두드리므로, 진짜 장비로는
 * 실패 경로 하나를 재현하는 데 몇 분이 든다. 여기서 값싸게 다 밟아 두면 현장에서는
 * "판이 읽히는가" 하나만 확인하면 된다.
 */

// --- 가짜 장비 -----------------------------------------------------------------

/** 1920×1080 을 말하는 최소 JPEG 헤더. `jpegSize` 가 이것만 읽는다. */
function fakeJpeg(width = 1920, height = 1080): Buffer {
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(9, 2);      // 길이
  sof.writeUInt8(8, 4);          // 정밀도
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.writeUInt8(1, 9);
  sof.writeUInt8(1, 10);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

class FakeDriver implements CameraDriver {
  readonly kind = 'hucoms';
  readonly cameraId = 'cam-1';
  ptz: PtzRaw = { pan: 1000, tilt: 500, zoom: 0 };
  readonly moves: PtzRaw[] = [];
  readonly centers: CenterPoint[] = [];
  /** 이 횟수를 넘긴 이동부터 실패한다 — 마지막 홈 복귀만 깨서 `cameraStranded` 를 재현한다. */
  failAfterMoves = Number.POSITIVE_INFINITY;

  async getPtz(): Promise<PtzRaw> { return { ...this.ptz }; }
  async goPtz(target: PtzRaw): Promise<void> {
    if (this.moves.length >= this.failAfterMoves) throw new Error('카메라에 닿지 못했습니다');
    this.ptz = { ...target };
    this.moves.push({ ...target });
  }
  async getSnapshot(): Promise<Buffer> { return fakeJpeg(); }
  async listSlots(): Promise<Slot[]> { return []; }
  async centerPoint(point: CenterPoint): Promise<void> { this.centers.push(point); }
}

/** `centerPoint` 가 없는 드라이버 — park3d-rpc 가 이 모양이다. */
class NoCenterDriver extends FakeDriver {
  centerPoint = undefined as unknown as (point: CenterPoint) => Promise<void>;
}

const detector = (name: 'lpd' | 'vpd', frames: Detection[][] | (() => never)): DetectorClient => {
  let call = 0;
  return {
    name,
    async detect(): Promise<DetectorResult> {
      if (typeof frames === 'function') frames();
      // 프레임 목록을 다 쓰면 마지막 것을 반복한다 — 스텝 수를 테스트마다 세지 않아도 된다.
      const detections = (frames as Detection[][])[Math.min(call++, frames.length - 1)] ?? [];
      return { detector: name, success: detections.length > 0, imageId: call, detections };
    },
  };
};

const plate = (cx: number, cy: number, w: number, h = 30): Detection =>
  ({ className: 'plate', confidence: 0.9, bbox: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2] });

const car = (x1: number, y1: number, x2: number, y2: number): Detection => ({
  className: 'car', confidence: 0.9,
  polygon: [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }],
});

const CENTRE = { x: 960, y: 540 };
const WHOLE_FRAME = car(0, 0, 1920, 1080);

const camera: CameraConfig = {
  id: 'cam-1', label: '테스트', kind: 'hucoms',
  controlUrl: 'http://x', streamUrl: '', username: '', password: '', timeoutMs: 1000,
} as CameraConfig;

const preset: HomingPreset = {
  id: 'p-1', name: '와이드',
  ptz: { panpos: 1000, tiltpos: 500, zoompos: 0 },
  points: [{ id: 'pt-1', name: '1번', x: 960, y: 540 }],
};

// --- 조립 -----------------------------------------------------------------------

let dir = '';
let saved: Array<{ pointId: string; closeupPtz: PtzRaw | null }> = [];

const store = (): HomingStorePort => ({
  async getPreset(id) { return id === preset.id ? preset : null; },
  async saveAim(_presetId, pointId, aim) { saved.push({ pointId, closeupPtz: aim.closeupPtz }); },
});

function runner(plates: DetectorClient, vehicles: DetectorClient): PlateHomingJobRunner {
  return new PlateHomingJobRunner({
    plates,
    vehicles,
    traces: new HomeTraceStore({ dir: join(dir, 'frames') }),
    locks: new CameraLockStore({ dir: join(dir, 'locks') }),
    // 정착 대기를 0 으로 — 이 테스트가 재는 것은 시간이 아니라 판단이다.
    settleOptions: { pollMs: 0, timeoutMs: 0, sleep: async () => undefined },
  });
}

/**
 * 잡은 **즉시 반환하고 뒤에서 돈다** — 끝날 때까지 상태를 폴링한다.
 * `endedAt` 이 서는 순간이 곧 복귀까지 끝났다는 뜻이다(`finally` 의 마지막 줄).
 */
async function settle(get: () => HomingStatus): Promise<HomingStatus> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = get();
    if (status.endedAt) return status;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`잡이 끝나지 않았습니다: ${JSON.stringify(get())}`);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'homing-'));
  saved = [];
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

// --- 성공 경로 -------------------------------------------------------------------

describe('번호판 호밍 — 성공', () => {
  it('판이 targetPx 를 넘으면 그 자세를 조준으로 확정하고 저장한다', async () => {
    const driver = new FakeDriver();
    // 스텝마다 1장. 두 번째 스텝에서 판이 충분히 커진다 — **종횡비를 유지하며** 자란다.
    // 폭만 늘리면 추적 게이트(종횡비 0.65~1.55)에 걸려 잠금이 풀리는데, 실제 줌인에서는
    // 가로·세로가 같은 비율로 커지므로 그런 데이터는 현실을 재현하지 못한다.
    const job = runner(
      detector('lpd', [[plate(CENTRE.x, CENTRE.y, 100, 30)], [plate(CENTRE.x, CENTRE.y, 180, 54)]]),
      detector('vpd', [[WHOLE_FRAME]]),
    );
    await job.start(camera, driver, store(), { presetId: 'p-1' });
    const status = await settle(() => job.status('cam-1'));

    expect(status.state).toBe('done');
    expect(status.results).toHaveLength(1);
    expect(status.results[0]!.status).toBe('ok');
    expect(status.results[0]!.plateW).toBe(180);
    expect(status.results[0]!.closeupPtz).toBeDefined();
    // 확정된 조준이 저장소로 간다.
    expect(saved).toHaveLength(1);
    expect(saved[0]!.closeupPtz).not.toBeNull();
  });

  it('**언제나 와이드로 되돌린다** — 마지막 이동이 프리셋 자세다', async () => {
    const driver = new FakeDriver();
    const job = runner(
      detector('lpd', [[plate(CENTRE.x, CENTRE.y, 180)]]),
      detector('vpd', [[WHOLE_FRAME]]),
    );
    await job.start(camera, driver, store(), { presetId: 'p-1' });
    await settle(() => job.status('cam-1'));

    expect(driver.moves.at(-1)).toEqual({ pan: 1000, tilt: 500, zoom: 0 });
    expect(job.status('cam-1').cameraStranded).toBe(false);
  });
});

// --- 실패 경로 -------------------------------------------------------------------

describe('번호판 호밍 — 실패 사유가 갈린다', () => {
  it('마킹점에 차량이 없으면 target_not_found (점을 다시 찍어야 한다)', async () => {
    const job = runner(detector('lpd', [[]]), detector('vpd', [[car(0, 0, 10, 10)]]));
    await job.start(camera, new FakeDriver(), store(), { presetId: 'p-1' });
    const status = await settle(() => job.status('cam-1'));
    expect(status.results[0]).toMatchObject({ status: 'uncertain', code: 'target_not_found' });
  });

  it('마킹점에 차량이 겹치면 target_ambiguous — 하나를 고르지 않는다', async () => {
    const job = runner(
      detector('lpd', [[]]),
      detector('vpd', [[car(0, 0, 1920, 1080), car(500, 300, 1400, 800)]]),
    );
    await job.start(camera, new FakeDriver(), store(), { presetId: 'p-1' });
    const status = await settle(() => job.status('cam-1'));
    expect(status.results[0]).toMatchObject({ status: 'uncertain', code: 'target_ambiguous' });
  });

  it('표적 차량은 잡았는데 판이 끝까지 안 보이면 plate_not_found', async () => {
    const job = runner(detector('lpd', [[]]), detector('vpd', [[WHOLE_FRAME]]));
    await job.start(camera, new FakeDriver(), store(), { presetId: 'p-1' });
    const status = await settle(() => job.status('cam-1'));
    expect(status.results[0]).toMatchObject({ status: 'failed', code: 'plate_not_found' });
    // 실패한 점은 옛 조준을 **지운다**.
    expect(saved[0]!.closeupPtz).toBeNull();
  });

  it('최대줌인데 판이 작으면 plate_too_small', async () => {
    const job = runner(
      detector('lpd', [[plate(CENTRE.x, CENTRE.y, 40)]]),
      detector('vpd', [[WHOLE_FRAME]]),
    );
    await job.start(camera, new FakeDriver(), store(), { presetId: 'p-1' }, { maxSteps: 3, targetPx: 300, minOkPx: 200 });
    const status = await settle(() => job.status('cam-1'));
    expect(status.results[0]!.status).toBe('failed');
    expect(status.results[0]!.code).toBe('plate_too_small');
  });

  it('검출기 오류는 detector_error 로 사유를 그대로 싣는다', async () => {
    const boom = detector('lpd', () => { throw new Error('LPD 사이드카 꺼짐'); });
    const job = runner(boom, detector('vpd', [[WHOLE_FRAME]]));
    await job.start(camera, new FakeDriver(), store(), { presetId: 'p-1' });
    const status = await settle(() => job.status('cam-1'));
    expect(status.results[0]!.code).toBe('detector_error');
    expect(status.results[0]!.reason).toContain('LPD 사이드카 꺼짐');
  });

  /**
   * 실루엣 안 판이 둘이면 **잠그지 않는다.** 가까운 쪽을 고르는 순간 옆차가 될 수 있고,
   * 그러면 잡은 성공했다고 말하면서 엉뚱한 주차면의 조준을 저장한다.
   */
  it('실루엣 안 후보가 둘이면 잠그지 않는다', async () => {
    const job = runner(
      detector('lpd', [[plate(CENTRE.x - 100, CENTRE.y, 100), plate(CENTRE.x + 100, CENTRE.y, 100)]]),
      detector('vpd', [[WHOLE_FRAME]]),
    );
    await job.start(camera, new FakeDriver(), store(), { presetId: 'p-1' }, { maxSteps: 2 });
    const status = await settle(() => job.status('cam-1'));
    expect(status.results[0]!.status).toBe('uncertain');
    expect(status.results[0]!.code).toBe('target_ambiguous');
    expect(saved[0]!.closeupPtz).toBeNull();
  });

  it('복귀에 실패하면 cameraStranded 를 세운다 — 조용히 넘기지 않는다', async () => {
    const driver = new FakeDriver();
    // 이동 둘(와이드 복귀 + 줌 한 단계)까지는 되고, 마지막 홈 복귀에서 깨진다.
    driver.failAfterMoves = 2;
    const job = runner(
      detector('lpd', [[plate(CENTRE.x, CENTRE.y, 180)]]),
      detector('vpd', [[WHOLE_FRAME]]),
    );
    await job.start(camera, driver, store(), { presetId: 'p-1' });
    const status = await settle(() => job.status('cam-1'));
    expect(status.cameraStranded).toBe(true);
    // **유언장은 남는다** — 복귀에 실패했으니 다음 기동이 대신 되돌릴 근거가 있어야 한다.
    expect(await new CameraLockStore({ dir: join(dir, 'locks') }).read('cam-1')).not.toBeNull();
  });
});

// --- 잡 제어 --------------------------------------------------------------------

describe('번호판 호밍 — 잡 제어', () => {
  it('진행 중에 두 번째 시작은 409 로 거절한다', async () => {
    const job = runner(detector('lpd', [[]]), detector('vpd', [[WHOLE_FRAME]]));
    await job.start(camera, new FakeDriver(), store(), { presetId: 'p-1' });
    await expect(job.start(camera, new FakeDriver(), store(), { presetId: 'p-1' })).rejects.toThrow(/이미 진행 중/);
    await settle(() => job.status('cam-1'));
  });

  it('없는 프리셋은 404', async () => {
    const job = runner(detector('lpd', [[]]), detector('vpd', [[]]));
    await expect(job.start(camera, new FakeDriver(), store(), { presetId: 'p-9' })).rejects.toThrow(/찾을 수 없습니다/);
  });

  it('선택한 점이 프리셋에 없으면 404', async () => {
    const job = runner(detector('lpd', [[]]), detector('vpd', [[]]));
    await expect(job.start(camera, new FakeDriver(), store(), { presetId: 'p-1', pointIds: ['pt-9'] }))
      .rejects.toThrow(/선택한 점/);
  });

  it('픽셀 센터링이 없는 드라이버는 501', async () => {
    const job = runner(detector('lpd', [[]]), detector('vpd', [[]]));
    await expect(job.start(camera, new NoCenterDriver(), store(), { presetId: 'p-1' }))
      .rejects.toThrow(/픽셀 센터링을 지원하지 않아/);
  });

  it('실행 중이 아닐 때의 stop 은 오류가 아니다 — 이미 만족된 요청이다', () => {
    const job = runner(detector('lpd', [[]]), detector('vpd', [[]]));
    expect(job.stop('cam-1').state).toBe('idle');
  });

  it('idle 상태를 읽는 것은 미지원 기기에서도 거짓말이 아니다', () => {
    const job = runner(detector('lpd', [[]]), detector('vpd', [[]]));
    expect(job.status('cam-1')).toMatchObject({ state: 'idle', total: 0, results: [] });
  });
});

// --- 능력 광고 ------------------------------------------------------------------

describe('PlateHomingComponent.support — 못 하면 사유를 말한다', () => {
  const build = (options: Partial<Parameters<typeof makeComponent>[0]> = {}) => makeComponent({
    detectorReason: undefined,
    hasStore: true,
    ...options,
  });

  function makeComponent(options: { detectorReason?: string; hasStore: boolean }): PlateHomingComponent {
    return new PlateHomingComponent({
      runner: runner(detector('lpd', [[]]), detector('vpd', [[]])),
      traces: new HomeTraceStore({ dir: join(dir, 'frames') }),
      storeFor: options.hasStore ? () => store() : undefined,
      detectorReason: () => options.detectorReason,
    });
  }

  it('전부 갖추면 ok', () => {
    expect(build().support(camera, new FakeDriver())).toEqual({ ok: true });
  });

  it('픽셀 센터링이 없으면 그 사유로 꺼진다', () => {
    const state = build().support(camera, new NoCenterDriver());
    expect(state).toMatchObject({ ok: false });
    expect((state as { reason: string }).reason).toContain('픽셀 센터링');
  });

  it('저장소가 없으면 그 사유로 꺼진다 — 조준을 저장할 곳이 없다', () => {
    const state = build({ hasStore: false }).support(camera, new FakeDriver());
    expect((state as { reason: string }).reason).toContain('저장할 곳이 없습니다');
  });

  /** 마스크 없이 붙이면 "가장 가까운 판"으로 퇴화한다 — 상류가 겪고 고친 결함이다. */
  it('검출기가 없으면 그 사유를 그대로 광고한다', () => {
    const state = build({ detectorReason: 'VPD 가 설정되지 않았습니다' }).support(camera, new FakeDriver());
    expect((state as { reason: string }).reason).toBe('VPD 가 설정되지 않았습니다');
  });

  it('지원하지 않으면 start 가 501 로 거절한다 — 눌러 본 뒤에 알게 하지 않는다', async () => {
    await expect(build({ detectorReason: '검출기 없음' }).start(camera, new FakeDriver(), { presetId: 'p-1' }))
      .rejects.toThrow('검출기 없음');
  });
});
