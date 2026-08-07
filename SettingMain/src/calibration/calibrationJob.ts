import { waitForSettle, type SettleOptions } from '../devices/waitForSettle.js';
import { clampPtz, type PtzRaw } from '../domain/ptz.js';
import type { CameraDriver } from '../devices/cameraDriver.js';
import type { CameraConfig, CameraIntrinsics } from '../config/types.js';
import {
  MIN_MARGIN,
  MIN_PEAK,
  applyCenteringGain,
  buildCalibration,
  centeringGain,
  solveZoom,
  type CalibrationResult,
  type CalibrationSample,
} from '../vendor/baro-profile/index.mjs';
import { CameraLockStore } from './cameraLock.js';
import type { GrayFrame } from './frameDecode.js';
import { assertSameSize, locateClicked } from './frameMatch.js';
import { planSweep, type SweepMode } from './sweepPlan.js';

/**
 * 캘리브레이션 스윕 잡 — 화면을 여기저기 클릭해 보고 **어디에 떨어지는지 지켜본다.**
 *
 * 근거: baro_calory `apps/backend-core/src/calibration-manager.mjs`.
 *
 * ## 반드시 지켜야 하는 넷 (넷 다 상류가 실제로 당한 사고다)
 *
 * 1. **full 은 보정 없이(raw) 조준한다.** 그러지 않으면 *자기가 도출하려는 보정을 통과해서*
 *    카메라를 재게 된다.
 * 2. **verify 는 설치된 보정을 통과해서 조준한다.** 답해야 할 질문이 "이 보정이 이 카메라에
 *    맞나"이므로 보정이 루프 안에 있어야 맞다.
 * 3. **줌 앵커는 기기 눈금이어야 한다**(`sweepPlan.ts`).
 * 4. **카메라를 반드시 돌려준다** — 실패·취소·프로세스 사망 전부. 그래서 유언장이 있다.
 *
 * ## 이 잡은 `centering/` 을 import 하지 않는다
 *
 * verify 가 게인을 통과해야 하지만, 게인은 벤더링된 **순수 함수**(`applyCenteringGain`)다.
 * 두 컴포넌트가 같은 함수를 **각자 부른다** — 서로를 부르지 않는다. 그것이 이 설계에서
 * "독립"의 뜻이다.
 */

/** 논리 프레임 중앙. 클릭 오프셋의 기준점이다. */
const CX = 960;
const CY = 540;

/** RMS 대비가 이보다 낮으면 영상에 **아무것도 없는 것**이다(빈 벽, 야간 20배 줌). */
const LOW_CONTRAST = 12;

/**
 * JS 의 `%` 는 피제수 부호를 따르므로 `+36000` 재정규화가 **필수**다.
 * 없으면 팬 심(0/36000)을 넘는 이동에서 최단 부호 차 대신 원시 차가 나온다 —
 * `wrapCd(300, 35800)` 이 `+500` 이 아니라 `-35500` 이 되어 심 근처에 설치된 카메라에서만
 * 샘플이 통째로 기각된다. 상류에서 실제로 잠복해 있던 버그다(2026-07-29 수정).
 */
const wrapCd = (after: number, before: number): number => ((((after - before + 18000) % 36000) + 36000) % 36000) - 18000;

export type JobState = 'idle' | 'running' | 'done' | 'failed' | 'stopped';

export interface CalibrationJobStatus {
  state: JobState;
  mode?: SweepMode;
  cameraId?: string;
  startedAt?: string;
  message?: string;
  error?: string;
  progress?: { done: number; total: number; percent: number };
  result?: CalibrationRunResult | null;
  /** 최근 샘플 여섯. 화면이 "지금 잘 되고 있나"를 사람 눈으로 판단하게 한다. */
  recent?: Array<Record<string, unknown>>;
  /** 줌 앵커 출처. "왜 이 눈금인가"에 답한다. */
  zoomSource?: 'device-seed' | 'builtin';
}

/** 건너뛴 줌에 **사유가 붙는다** — 솔버는 개수만 알고, 왜 그랬는지는 잡이 안다. */
export interface SkippedZoom {
  zoom: number;
  usable: number;
  of: number;
  why: string;
}

export type CalibrationRunResult =
  | (Omit<CalibrationResult, 'skipped'> & { mode: 'full'; usable: number; of: number; skipped: SkippedZoom[] })
  | {
      mode: 'verify';
      checks: Array<{ zoom: number; residualPx: number; gainNeeded: number | null; gainApplied: number }>;
      unmeasured: Array<{ zoom: number; why: string }>;
      worstPx: number | null;
      verdict: 'pass' | 'fail' | 'incomplete' | 'unknown';
      hint?: string;
      usable: number;
      of: number;
    };

/**
 * 잡이 디코더에 요구하는 전부. **구현이 아니라 이 표면에 의존한다** — 그래야 테스트가
 * ffmpeg 없이 돌고, 프레임을 지어내 매칭 게이트를 정확히 겨눌 수 있다.
 */
export interface FrameDecoderPort {
  probe(): Promise<{ ok: true } | { ok: false; reason: string }>;
  toGray(jpeg: Buffer): Promise<GrayFrame>;
}

export interface CalibrationJobDeps {
  decoder: FrameDecoderPort;
  locks: CameraLockStore;
  settleOptions?: SettleOptions;
  now?: () => string;
  /** 이동 속도. 상류와 같은 기본값. */
  speed?: number;
}

interface JobRecord {
  cameraId: string;
  mode: SweepMode;
  state: JobState;
  startedAt: string;
  message: string;
  error?: string;
  done: number;
  total: number;
  samples: CalibrationSample[];
  cancelled: boolean;
  /** 스윕이 끝난 뒤 홈으로 돌아가는 중. **이 동안에도 카메라는 움직인다.** */
  parking: boolean;
  home?: PtzRaw;
  result?: CalibrationRunResult;
  zoomSource: 'device-seed' | 'builtin';
}

export class CalibrationJobRunner {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly now: () => string;
  private readonly speed: number;

  constructor(private readonly deps: CalibrationJobDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.speed = deps.speed ?? 50;
  }

  /**
   * 이 카메라가 잡에 묶여 있는가.
   *
   * **`parking` 도 busy 로 센다.** 스윕이 끝난 뒤에도 홈 복귀가 남아 있고 그 동안 카메라는
   * 여전히 움직인다. `state === 'running'` 만 보면 그 구간이 idle 로 보여서, 두 번째 잡이
   * 슬루 중인 카메라 위에서 시작하고 먼저 끝난 잡의 `finally` 가 **새 잡의 유언장을 지운다.**
   */
  isBusy(cameraId: string): boolean {
    const job = this.jobs.get(cameraId);
    return Boolean(job && (job.state === 'running' || job.parking));
  }

  /** 이 기계에 JPEG 디코딩이 있는가. 한 번만 묻고 기억된다(`FrameDecoder.probe`). */
  async probeDecoder(): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.deps.decoder.probe();
  }

  status(cameraId: string): CalibrationJobStatus {
    const job = this.jobs.get(cameraId);
    if (!job) return { state: 'idle' };
    return {
      state: job.state,
      mode: job.mode,
      cameraId: job.cameraId,
      startedAt: job.startedAt,
      message: job.message,
      ...(job.error ? { error: job.error } : {}),
      progress: job.total ? { done: job.done, total: job.total, percent: Math.round((job.done / job.total) * 100) } : undefined,
      result: job.result ?? null,
      recent: job.samples.slice(-6).map(summarize),
      zoomSource: job.zoomSource,
    };
  }

  stop(cameraId: string): CalibrationJobStatus {
    const job = this.jobs.get(cameraId);
    // 실행 중이 아니어도 오류가 아니다 — 멈춰 있길 바라는 요청은 이미 만족돼 있다.
    if (job && this.isBusy(cameraId)) {
      job.cancelled = true;
      job.message = '중지 요청 — 진행 중인 클릭이 끝나면 멈춥니다';
    }
    return this.status(cameraId);
  }

  /**
   * 스윕 시작. **즉시 돌아오고 뒤에서 돈다** — 20분을 HTTP 요청 하나로 붙들 수 없다.
   * 진행은 `status()` 로 본다.
   */
  async start(camera: CameraConfig, driver: CameraDriver, mode: SweepMode): Promise<CalibrationJobStatus> {
    if (this.isBusy(camera.id)) throw new CalibrationError(`카메라 ${camera.id} 에서 캘리브레이션이 이미 진행 중입니다`, 409);
    if (typeof driver.centerPoint !== 'function') {
      throw new CalibrationError('이 카메라 드라이버는 픽셀 센터링을 지원하지 않아 클릭 스윕을 돌릴 수 없습니다', 501);
    }
    // verify 는 **설치된 보정을 통과해서** 돌아야 의미가 있다. 보정이 없으면 검증할 것도 없다.
    if (mode === 'verify' && !camera.intrinsics?.centeringGain) {
      throw new CalibrationError(
        `기기 ${camera.id} 에 설치된 센터링 게인이 없습니다 — 검증은 "설치된 보정이 이 카메라에 맞나"를 묻는 패스라 보정 없이는 성립하지 않습니다. 먼저 full 스윕을 돌리십시오`,
        409,
      );
    }
    const probe = await this.deps.decoder.probe();
    if (!probe.ok) throw new CalibrationError(probe.reason, 501);

    const plan = planSweep(mode, camera.intrinsics);
    // **이 실행이 소유한 레코드다.** 아래 비동기 본문은 절대 `this.jobs.get()` 을 다시 읽지
    // 않는다 — 리파크 도중 새 잡이 시작되면 그 맵은 새 잡을 가리키고, 그러면 이 실행이 남의
    // home 으로 카메라를 되돌리고 남의 유언장을 지운다.
    const job: JobRecord = {
      cameraId: camera.id,
      mode,
      state: 'running',
      startedAt: this.now(),
      message: '시작하는 중',
      done: 0,
      total: plan.total,
      samples: [],
      cancelled: false,
      parking: false,
      zoomSource: plan.zoomSource,
    };
    this.jobs.set(camera.id, job);

    void this.run(camera, driver, mode, job).catch(() => {
      /* run() 이 스스로 job.state 를 채운다 — 여기서 삼키는 것은 미처리 거부뿐이다 */
    });
    return this.status(camera.id);
  }

  // --- 실행 -----------------------------------------------------------------

  private async run(camera: CameraConfig, driver: CameraDriver, mode: SweepMode, job: JobRecord): Promise<void> {
    try {
      job.result = await this.sweep(camera, driver, mode, job);
      job.state = job.cancelled ? 'stopped' : 'done';
      job.message = describe(job.result);
    } catch (error) {
      job.state = job.cancelled ? 'stopped' : 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.message = `실패: ${job.error}`;
    } finally {
      // **언제나 카메라를 돌려준다.** 취소되거나 죽은 스윕이 20배 줌으로 하늘을 보게 두는 것은
      // 이 기능이 아예 없는 것보다 나쁘다.
      job.parking = true;
      try {
        if (job.home) {
          try {
            await this.settleGoto(driver, job.home, 2);
            // **복귀에 성공했을 때만 유언장을 찢는다.** 실패하면 남겨 다음 기동이 대신 되돌린다.
            await this.deps.locks.release(camera.id);
          } catch {
            /* 카메라에 닿지 못한다 — 위의 오류가 이미 그것을 말하고 있다 */
          }
        }
      } finally {
        job.parking = false;
      }
    }
  }

  private async sweep(camera: CameraConfig, driver: CameraDriver, mode: SweepMode, job: JobRecord): Promise<CalibrationRunResult> {
    const home = await driver.getPtz();
    job.home = home;
    const plan = planSweep(mode, camera.intrinsics);

    // 유언장을 **스윕 시작 전에** 남긴다. 이 줄과 첫 이동 사이에서 죽는 것만이 유일한 빈틈이다.
    await this.deps.locks.hold(camera.id, `캘리브레이션(${mode})`, home);

    const installed = camera.intrinsics;
    const rawAim = mode !== 'verify';

    for (const zoomAnchor of plan.zooms) {
      for (const [dx, dy] of plan.targets) {
        if (job.cancelled) throw new CalibrationError('사용자가 중지했습니다', 409);
        job.message = `zoom ${zoomAnchor} · 클릭 (${signed(dx)}, ${signed(dy)})`;
        job.samples.push(await this.measureClick(driver, { dx, dy, zoomAnchor, home, rawAim, installed }));
        job.done += 1;
      }
    }

    const usable = job.samples.filter((sample) => sample.usable);
    const byZoomAll = groupBy(job.samples, (sample) => sample.zoomAnchor);

    if (mode === 'verify') {
      return this.verifyResult(plan.zooms, job.samples, byZoomAll, installed, usable.length);
    }

    const calibration = buildCalibration(job.samples, { measuredAt: this.now() });
    // 건너뛴 줌마다 **진짜 사유**를 붙인다 — 운영자가 다시 조준할지, 낮에 다시 올지,
    // 보간을 받아들일지 판단할 근거다.
    const skipped: SkippedZoom[] = calibration.skipped.map((entry) => ({ ...entry, why: explain(byZoomAll.get(entry.zoom) ?? []) }));
    return { mode: 'full', ...calibration, skipped, usable: usable.length, of: job.samples.length };
  }

  private verifyResult(
    zooms: number[],
    samples: CalibrationSample[],
    byZoomAll: Map<number, CalibrationSample[]>,
    installed: CameraIntrinsics | undefined,
    usableCount: number,
  ): CalibrationRunResult {
    const byZoomUsable = groupBy(samples.filter((sample) => sample.usable), (sample) => sample.zoomAnchor);
    const checks: Array<{ zoom: number; residualPx: number; gainNeeded: number | null; gainApplied: number }> = [];
    const unmeasured: Array<{ zoom: number; why: string }> = [];

    for (const zoom of zooms) {
      const rows = byZoomUsable.get(zoom) ?? [];
      const applied = gainAt(zoom, installed);
      const solved = rows.length ? solveZoom(rows, { gainApplied: applied }) : null;
      if (solved) {
        checks.push({
          zoom,
          // 같은 숫자가 두 패스에서 정반대 뜻이다. **이 패스는 verify 이므로 "보정 후 살아남은
          // 오차"** 이고, full 의 같은 이름은 "카메라가 가진 오차"다.
          residualPx: round(solved.residualPx, 1),
          gainNeeded: solved.gain === null ? null : round(solved.gain, 3),
          gainApplied: round(applied, 3),
        });
      } else {
        unmeasured.push({ zoom, why: explain(byZoomAll.get(zoom) ?? []) });
      }
    }

    const worstPx = checks.length ? Math.max(...checks.map((check) => check.residualPx)) : null;
    // **장면이 답하지 못한 줌은 통과가 아니다.** 통과라고 부르는 것이 이 기능이 낼 수 있는 최악의
    // 결과다 — 그 줌에서 쓸 수 있는 프레임을 한 장도 못 봤는데 운영자는 "멀쩡하다"고 듣는다.
    const verdict = unmeasured.length > 0
      ? 'incomplete'
      : worstPx === null
        ? 'unknown'
        // 1/4 프레임 클릭에서 10px 쯤이 사람이 빗나감을 못 느끼기 시작하는 지점이다.
        : worstPx <= 10 ? 'pass' : 'fail';

    return {
      mode: 'verify',
      checks,
      unmeasured,
      worstPx,
      verdict,
      ...(unmeasured.length ? { hint: unmeasured.map((entry) => `줌 ${entry.zoom}: ${entry.why}`).join(' · ') } : {}),
      usable: usableCount,
      of: samples.length,
    };
  }

  /** 클릭 한 번 = 샘플 하나. */
  private async measureClick(
    driver: CameraDriver,
    options: { dx: number; dy: number; zoomAnchor: number; home: PtzRaw; rawAim: boolean; installed?: CameraIntrinsics },
  ): Promise<CalibrationSample> {
    const { dx, dy, zoomAnchor, home, rawAim, installed } = options;
    const x = CX + dx;
    const y = CY + dy;

    await this.settleGoto(driver, clampPtz({ pan: home.pan, tilt: home.tilt, zoom: zoomAnchor }));
    const before = await driver.getSnapshot();
    const ptzBefore = await driver.getPtz();

    // ★ full 은 **날것으로**, verify 는 **설치된 게인을 통과해서**. 이 한 줄이 두 패스의 차이다.
    const aim = rawAim
      ? { x, y }
      : applyCenteringGain({ x, y, zoomPos: ptzBefore.zoom, table: installed?.centeringGain ?? null });
    await driver.centerPoint!({ x: aim.x, y: aim.y });

    const settle = await waitForSettle(driver, this.deps.settleOptions);
    const ptzAfter = settle.ptz;
    const after = await driver.getSnapshot();

    const sample: CalibrationSample = {
      dx,
      dy,
      clickX: x,
      clickY: y,
      zoomAnchor,
      ptzBefore: toWire(ptzBefore),
      ptzAfter: toWire(ptzAfter),
      dpanCd: wrapCd(ptzAfter.pan, ptzBefore.pan),
      dtiltCd: ptzAfter.tilt - ptzBefore.tilt,
      settled: settle.settled,
    };

    try {
      const [beforeGray, afterGray] = await Promise.all([
        this.deps.decoder.toGray(before),
        this.deps.decoder.toGray(after),
      ]);
      assertSameSize(beforeGray, afterGray);
      const match = locateClicked(beforeGray, afterGray, { clickX: x, clickY: y });
      Object.assign(sample, {
        landedX: match.landedX,
        landedY: match.landedY,
        peak: match.peak,
        margin: match.margin,
        contrast: match.contrast,
        residualX: match.landedX - CX,
        residualY: match.landedY - CY,
      });
      // 빈 벽에 대한 클릭이나 똑같이 생긴 세 번째 주차선에 대한 클릭은 카메라에 대해 아무것도
      // 말하지 않는다. 적합을 조용히 오염시키는 대신 **그렇다고 분명히 말하고**, 무엇 때문인지도
      // 말한다 — 처방이 다르기 때문이다.
      sample.usable = match.peak >= MIN_PEAK && match.margin >= MIN_MARGIN;
      if (!sample.usable) {
        // "훌륭하게 매칭됐는데 **어디인지** 말할 수 없다"(높은 peak, 없는 margin)는
        // "아무것도 못 봤다"(낮은 peak)와 다른 실패다. 몇 픽셀 옆도 똑같이 잘 맞는다는 뜻이고,
        // 야간 고배율에서 잡음 제거가 남기는 것이 정확히 그것이다. 0.93 점이 무용한 이유다.
        if (match.contrast < LOW_CONTRAST) sample.reason = 'dark';
        else if (match.peak >= MIN_PEAK) sample.reason = 'smooth';
        else sample.reason = 'featureless';
      }
    } catch (error) {
      sample.usable = false;
      sample.reason = 'error';
      sample.matchError = error instanceof Error ? error.message : String(error);
    }
    return sample;
  }

  /**
   * 목표까지 보내고 멈출 때까지 기다린다.
   *
   * 긴 줌 이동은 렌즈가 아직 움직이는 동안 정착 상한을 넘길 수 있다. **같은 절대 이동을 다시
   * 내면** 목표에 더 가까운 자리에서 다시 잡는다 — 정착 타임아웃만 재시도할 가치가 있고,
   * 범위 오류는 저절로 낫지 않는다.
   */
  private async settleGoto(driver: CameraDriver, target: PtzRaw, attempts = 4): Promise<void> {
    for (let i = 0; i < attempts; i += 1) {
      try {
        await driver.goPtz(target, this.speed);
        await waitForSettle(driver, this.deps.settleOptions);
        return;
      } catch (error) {
        if (i === attempts - 1) throw error;
      }
    }
  }
}

export class CalibrationError extends Error {
  constructor(message: string, readonly statusCode = 500) {
    super(message);
    this.name = 'CalibrationError';
  }
}

// --- 순수 도우미 ---------------------------------------------------------------

/** 계약 좌표(`pan`) → 솔버가 읽는 와이어 이름(`panpos`). 솔버는 상류 어휘를 쓴다. */
function toWire(ptz: PtzRaw): { panpos: number; tiltpos: number; zoompos: number } {
  return { panpos: ptz.pan, tiltpos: ptz.tilt, zoompos: ptz.zoom };
}

/** 이 줌에서 설치된 게인. 표가 없으면 **1** 이다 — 내장 곡선으로 대체하지 않는다. */
function gainAt(zoom: number, intrinsics?: CameraIntrinsics): number {
  return centeringGain(zoom, intrinsics?.centeringGain ?? null);
}

/**
 * 왜 이 줌이 측정되지 않았나.
 *
 * 운영자는 **진짜 사유**로만 행동할 수 있으므로 하나로 단정하지 않고 증거를 보고한다 —
 * 야간에는 같은 장면이 두 실패를 동시에 낳고(어두워 안 보이는 곳 + 잡음 제거로 뭉개진 곳),
 * 하나만 골라 이름 붙이면 문제의 절반을 쫓게 만든다.
 */
function explain(rows: CalibrationSample[]): string {
  const bad = rows.filter((row) => !row.usable);
  if (bad.length === 0) return '쓸 수 있는 샘플이 부족합니다';
  const count = (why: string): number => bad.filter((row) => row.reason === why).length;
  const parts: string[] = [];
  if (count('dark')) parts.push(`${count('dark')}개는 너무 어둡고`);
  if (count('smooth')) parts.push(`${count('smooth')}개는 미세 디테일이 없어 위치를 특정할 수 없고`);
  if (count('featureless')) parts.push(`${count('featureless')}개는 무늬가 없고`);
  if (count('error')) parts.push(`${count('error')}개는 매칭에 실패했고`);
  const detail = parts.length ? `(${parts.join(', ').replace(/,([^,]*)$/, '$1')})` : '';
  const dim = count('dark') + count('smooth') >= bad.length / 2;
  return dim
    ? `이 배율에서 화면을 읽을 수 없습니다 ${detail} — 야간·저조도면 영상이 뭉개져 고배율일수록 심합니다. 밝을 때 다시 시도하세요`
    : `이 배율에서 화면을 읽을 수 없습니다 ${detail} — 차량·주차선처럼 무늬가 있는 쪽을 향하게 두고 다시 시도하세요`;
}

function describe(result: CalibrationRunResult): string {
  if (result.mode === 'verify') {
    return result.verdict === 'incomplete'
      ? `검증 미완 — 줌 ${result.unmeasured.map((u) => u.zoom).join(', ')} 에서 화면을 읽지 못했습니다`
      : `검증 완료 — 최악 잔차 ${result.worstPx}px (${result.verdict})`;
  }
  // **보정 전** 오차라고 명시한다. 보정 후 남는 오차는 verify 만 말할 수 있다.
  return `캘리브레이션 완료 — 보정 전 조준 오차 ${result.residual.beforePx}px (검증으로 확인하세요)`;
}

function summarize(sample: CalibrationSample): Record<string, unknown> {
  return {
    zoom: sample.zoomAnchor,
    dx: sample.dx,
    dy: sample.dy,
    residualX: roundOpt(sample.residualX, 1),
    residualY: roundOpt(sample.residualY, 1),
    peak: roundOpt(sample.peak, 2),
    margin: roundOpt(sample.margin, 3),
    usable: sample.usable,
    ...(sample.reason ? { reason: sample.reason } : {}),
  };
}

function groupBy<T>(rows: T[], key: (row: T) => number): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = map.get(k);
    if (bucket) bucket.push(row);
    else map.set(k, [row]);
  }
  return map;
}

const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value}`;
const round = (value: number, digits: number): number => Number(value.toFixed(digits));
/** 매칭이 실패한 샘플에는 잔차·점수가 아예 없다 — 0 으로 채우면 "중앙에 떨어졌다"는 거짓말이 된다. */
const roundOpt = (value: number | undefined, digits: number): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : undefined;
