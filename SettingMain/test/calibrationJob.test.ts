import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CalibrationJobRunner, type FrameDecoderPort } from '../src/calibration/calibrationJob.js';
import { CameraLockStore } from '../src/calibration/cameraLock.js';
import { planSweep } from '../src/calibration/sweepPlan.js';
import type { GrayFrame } from '../src/calibration/frameDecode.js';
import type { CameraConfig, CameraIntrinsics } from '../src/config/types.js';
import type { CameraDriver, CenterPoint } from '../src/devices/cameraDriver.js';
import type { PtzRaw } from '../src/domain/ptz.js';

/**
 * 캘리브레이션 잡 — **반드시 지켜야 하는 넷**이 이 파일의 뼈대다.
 *   ① full 은 보정 없이(raw) 조준한다
 *   ② verify 는 설치된 보정을 통과해서 조준한다
 *   ③ 줌 앵커는 기기 눈금이어야 한다
 *   ④ 카메라를 반드시 돌려준다 — 실패·취소·프로세스 사망 전부
 */

const HOME: PtzRaw = { pan: 12_000, tilt: 1_681, zoom: 0 };

const INTRINSICS: CameraIntrinsics = {
  zoomHfov: [{ z: 0, h: 57.14 }, { z: 8000, h: 22.59 }, { z: 16384, h: 2.39 }],
  centeringGain: [{ z: 0, k: 0.988 }, { z: 8000, k: 1.11 }, { z: 16384, k: 0.765 }],
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'settingmanager-cal-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * 이동을 **기하학적으로 정확하게** 흉내 내는 카메라. 클릭한 픽셀이 정확히 중앙으로 오므로
 * 잔차가 0 이고 게인은 1 이 나와야 한다 — 시뮬레이터가 그렇듯이.
 */
function fakeCamera(options: { failAfter?: number; centerPoint?: boolean } = {}) {
  const state: PtzRaw = { ...HOME };
  const clicks: CenterPoint[] = [];
  const moves: PtzRaw[] = [];
  let calls = 0;

  const driver: CameraDriver = {
    cameraId: 'cam-a',
    kind: 'fake',
    async getPtz() { return { ...state }; },
    async goPtz(target) { moves.push({ ...target }); Object.assign(state, target); },
    async getSnapshot() { return Buffer.from([0xff, 0xd8]); },
    async listSlots() { return []; },
  };
  if (options.centerPoint !== false) {
    driver.centerPoint = async (point) => {
      calls += 1;
      if (options.failAfter !== undefined && calls > options.failAfter) throw new Error('카메라가 응답하지 않습니다');
      clicks.push(point);
      // 클릭 오프셋만큼 팬·틸트를 움직였다고 둔다(정확한 기하).
      state.pan += Math.round((point.x - 960) / 10);
      state.tilt += Math.round((point.y - 540) / 10);
    };
  }
  return { driver, clicks, moves, state };
}

/**
 * 착지를 **우리가 정한다.** 실제 상관을 돌리지 않는 이유: 여기서 보려는 것은 매칭 품질이
 * 아니라 **잡의 흐름**(무엇을 클릭하고, 무엇을 유언장에 남기고, 언제 되돌리는가)이다.
 * 매칭 자체는 `frameMatch.test.ts` 가 지어낸 프레임으로 따로 겨눈다.
 */
function fakeDecoder(): FrameDecoderPort {
  const frame: GrayFrame = { data: new Uint8Array(4), width: 2, height: 2 };
  return {
    async probe() { return { ok: true }; },
    async toGray() { return frame; },
  };
}

function camera(overrides: Partial<CameraConfig> = {}): CameraConfig {
  return {
    id: 'cam-a', label: 'cam-a', kind: 'hucoms', controlUrl: 'http://10.0.0.1',
    username: 'u', password: 'p', streamUrl: '', timeoutMs: 2000, ...overrides,
  };
}

function runner(): CalibrationJobRunner {
  return new CalibrationJobRunner({
    decoder: fakeDecoder(),
    locks: new CameraLockStore({ dir, now: () => '2026-08-07T00:00:00.000Z' }),
    settleOptions: { sleep: async () => {}, pollMs: 0 },
    now: () => '2026-08-07T00:00:00.000Z',
  });
}

/** 잡이 끝날 때까지 기다린다(비동기로 돌기 때문에). */
async function settle(job: CalibrationJobRunner, cameraId: string): Promise<void> {
  for (let i = 0; i < 2000 && job.isBusy(cameraId); i += 1) await new Promise((r) => setImmediate(r));
}

describe('스윕 계획 — 줌 앵커는 기기 눈금이어야 한다', () => {
  it('선언된 표가 없으면 내장 cam-001 눈금을 쓴다', () => {
    const plan = planSweep('full');
    expect(plan.zoomSource).toBe('builtin');
    expect(plan.zooms[0]).toBe(0);
    expect(plan.total).toBe(14 * 8);
  });

  it('기기가 자기 표를 갖고 있으면 **그 z 축**을 앵커로 쓴다', () => {
    // 상류 리뷰 확정: cam-001 눈금(0~65535)을 IDIS(100~1200)에 보내면 범위 밖 앵커가
    // rc=0 으로 조용히 최망원에 클램프되고, 요청값을 키로 쓰는 표가 오염된 채 발행된다.
    const idis: CameraIntrinsics = { zoomHfov: [{ z: 100, h: 57 }, { z: 600, h: 12 }, { z: 1200, h: 5 }] };
    const plan = planSweep('full', idis);
    expect(plan.zoomSource).toBe('device-seed');
    expect(plan.zooms).toEqual([100, 600, 1200]);
  });

  it('verify 는 양 끝과 가운데만 본다 — 예/아니오에 필요한 최소한이다', () => {
    expect(planSweep('verify', INTRINSICS).zooms).toEqual([0, 8000, 16384]);
    expect(planSweep('verify').zooms).toEqual([0, 8000, 16384]);
  });
});

describe('시작 게이트', () => {
  it('centerPoint 가 없는 드라이버는 501 — 클릭 스윕을 돌릴 수 없다', async () => {
    const { driver } = fakeCamera({ centerPoint: false });
    await expect(runner().start(camera(), driver, 'full')).rejects.toThrow(/픽셀 센터링/);
  });

  it('ffmpeg 가 없으면 501 이고 무엇이 없는지 말한다', async () => {
    const job = new CalibrationJobRunner({
      decoder: { async probe() { return { ok: false, reason: 'ffmpeg 를 실행할 수 없습니다 (ffmpeg)' }; }, async toGray() { throw new Error('불가'); } },
      locks: new CameraLockStore({ dir }),
    });
    await expect(job.start(camera(), fakeCamera().driver, 'full')).rejects.toThrow(/ffmpeg/);
  });

  it('게인이 없는 기기의 verify 는 409 — 검증할 보정이 없다', async () => {
    // 게인 1 로 도는 full 스윕을 "검증했다"고 부르면 20분을 쓰고 거짓 결론을 낸다.
    await expect(runner().start(camera(), fakeCamera().driver, 'verify')).rejects.toThrow(/설치된 센터링 게인이 없습니다/);
  });

  it('같은 카메라에서 두 번 시작하면 409', async () => {
    const job = runner();
    const { driver } = fakeCamera();
    await job.start(camera({ intrinsics: INTRINSICS }), driver, 'full');
    await expect(job.start(camera({ intrinsics: INTRINSICS }), driver, 'full')).rejects.toThrow(/이미 진행 중/);
    await settle(job, 'cam-a');
  });
});

describe('full 스윕 — 보정 없이 조준한다', () => {
  it('클릭 픽셀에 게인을 걸지 않는다 — 도출하려는 보정을 통과해서 재면 안 된다', async () => {
    const job = runner();
    const { driver, clicks } = fakeCamera();
    // 게인 표가 **설치돼 있는데도** full 은 그것을 쓰지 않아야 한다.
    await job.start(camera({ intrinsics: INTRINSICS }), driver, 'full');
    await settle(job, 'cam-a');

    // 첫 클릭은 dx=-720 → x = 960-720 = 240. 게인이 걸렸다면 240 이 아니다.
    expect(clicks[0]).toEqual({ x: 240, y: 540 });
    expect(clicks.every((c) => c.x === 960 || c.y === 540)).toBe(true); // 한 번에 한 축
  });

  it('앵커 수 × 클릭 수만큼 진행하고 상태로 보고한다', async () => {
    const job = runner();
    const { driver } = fakeCamera();
    await job.start(camera({ intrinsics: INTRINSICS }), driver, 'full');
    await settle(job, 'cam-a');

    const status = job.status('cam-a');
    expect(status.progress).toMatchObject({ done: 3 * 8, total: 3 * 8, percent: 100 });
    expect(status.zoomSource).toBe('device-seed');
    expect(status.recent).toHaveLength(6);
  });
});

describe('verify 스윕 — 설치된 보정을 통과해서 조준한다', () => {
  it('클릭 픽셀에 게인이 걸린다 — 보정이 루프 안에 있어야 그 질문에 답할 수 있다', async () => {
    const job = runner();
    const { driver, clicks } = fakeCamera();
    await job.start(camera({ intrinsics: INTRINSICS }), driver, 'verify');
    await settle(job, 'cam-a');

    // z=0 에서 k=0.988, 첫 클릭 dx=-600 → 960 + (-600 × 0.988) = 367.2 → 367
    expect(clicks[0]).toEqual({ x: 367, y: 540 });
  });
});

describe('카메라를 반드시 돌려준다', () => {
  it('스윕 시작 전에 홈 자세를 유언장으로 남기고, 끝나면 찢는다', async () => {
    const locks = new CameraLockStore({ dir });
    const job = new CalibrationJobRunner({
      decoder: fakeDecoder(),
      locks,
      settleOptions: { sleep: async () => {}, pollMs: 0 },
    });
    const { driver, moves } = fakeCamera();

    await job.start(camera({ intrinsics: INTRINSICS }), driver, 'full');
    await settle(job, 'cam-a');

    // 성공했으므로 유언장은 남아 있지 않다.
    expect(await locks.pending()).toEqual([]);
    // 마지막 이동은 홈 복귀다.
    expect(moves.at(-1)).toEqual(HOME);
  });

  it('중간에 실패해도 홈으로 되돌린다 — 20배 줌으로 하늘을 보게 두지 않는다', async () => {
    const job = runner();
    const { driver, moves } = fakeCamera({ failAfter: 3 });

    await job.start(camera({ intrinsics: INTRINSICS }), driver, 'full');
    await settle(job, 'cam-a');

    expect(job.status('cam-a').state).toBe('failed');
    expect(moves.at(-1)).toEqual(HOME);
  });

  it('복귀에 실패하면 유언장을 **남긴다** — 다음 기동이 대신 되돌린다', async () => {
    const locks = new CameraLockStore({ dir });
    const job = new CalibrationJobRunner({
      decoder: fakeDecoder(),
      locks,
      settleOptions: { sleep: async () => {}, pollMs: 0 },
    });
    const { driver } = fakeCamera();
    let goCalls = 0;
    driver.goPtz = async () => {
      goCalls += 1;
      // 첫 이동(첫 앵커)은 되고 그 뒤 전부 실패한다 — 복귀도 실패한다.
      if (goCalls > 1) throw new Error('카메라 연결 끊김');
    };

    await job.start(camera({ intrinsics: INTRINSICS }), driver, 'full');
    await settle(job, 'cam-a');

    const pending = await locks.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ cameraId: 'cam-a', home: HOME });
    expect(pending[0]!.job).toContain('캘리브레이션');
  });

  it('중지하면 진행 중인 클릭이 끝난 뒤 멈추고 홈으로 돌아간다', async () => {
    const job = runner();
    const { driver, moves } = fakeCamera();
    await job.start(camera({ intrinsics: INTRINSICS }), driver, 'full');
    job.stop('cam-a');
    await settle(job, 'cam-a');

    expect(job.status('cam-a').state).toBe('stopped');
    expect(moves.at(-1)).toEqual(HOME);
    expect(await new CameraLockStore({ dir }).pending()).toEqual([]);
  });

  it('실행 중이 아닐 때의 중지는 오류가 아니다 — 이미 만족된 요청이다', () => {
    expect(runner().stop('cam-a')).toEqual({ state: 'idle' });
  });
});

describe('유언장 저장소', () => {
  it('깨진 파일은 건너뛴다 — 그것 때문에 기동이 막히면 안 된다', async () => {
    const locks = new CameraLockStore({ dir });
    await locks.hold('cam-a', '캘리브레이션(full)', HOME);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'broken.json'), '{ 반쪽', 'utf8');

    const pending = await locks.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.cameraId).toBe('cam-a');
  });

  it('폴더가 없으면 빈 목록이다 — 그것이 정상 상태다', async () => {
    expect(await new CameraLockStore({ dir: join(dir, 'nope') }).pending()).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });
});
