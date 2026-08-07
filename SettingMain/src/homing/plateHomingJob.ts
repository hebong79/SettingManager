import { waitForSettle, type SettleOptions } from '../devices/waitForSettle.js';
import { clampPtz, type PtzRaw } from '../domain/ptz.js';
import type { CameraDriver } from '../devices/cameraDriver.js';
import type { CameraConfig } from '../config/types.js';
import type { DetectorClient } from '../detectors/detectorTypes.js';
import { jpegSize } from '../calibration/jpegSize.js';
import { ptzToWidePixel } from '../vendor/baro-profile/index.mjs';
import { CameraLockStore } from '../calibration/cameraLock.js';
import { HomeTraceStore, type HomeStep } from './homeTraceStore.js';
import {
  FRAME,
  createPlateTrack,
  matchPlateTrack,
  normalizeMasks,
  normalizePlates,
  platesInsideMask,
  vehicleMaskAtPoint,
  type PlateBox,
  type PlateTrack,
  type VehicleMask,
} from './plateTargetTracker.js';

/**
 * 번호판 호밍 — 점마다 **판이 읽히는 PTZ 를 찾아 저장한다.**
 *
 * 근거: baro_calory `apps/backend-core/src/discovery-manager.mjs` + `help/homing.md`.
 *
 * ## 산출물은 조준이지 번호가 아니다
 *
 * 이 잡은 번호를 읽지 않는다. **"여기를 이렇게 보면 판이 읽힌다"는 자세**(`closeupPtz`)를
 * 남기는 것이 전부다. 실제로 읽는 것은 그 자세로 가서 프레임을 떠 LPR 에 넘기는 별도 단계다.
 *
 * ## 한 점을 처리하는 절차
 *
 * ```
 * 와이드 프리셋으로 복귀
 *   → 스냅샷 → 차량 세그멘테이션 → 마킹점이 든 차량 하나를 고정   ← 표적 확정
 *   → 마킹점으로 조준
 *   → [줌 한 단계 → 스냅샷 → 판 검출 → 실루엣 안쪽 판만 후보]
 *        · 잠금 전: 후보가 정확히 하나면 잠근다
 *        · 잠금 후: plateTrack 으로 같은 판인지만 재확인(VPD 생략)
 *      → 판 중심으로 재조준 → 폭이 targetPx 이상이면 그 자세를 확정
 * ```
 *
 * ## 반드시 지켜야 하는 다섯 (캘리브레이션 잡과 같은 규율)
 *
 * 1. **즉시 반환하고 뒤에서 돈다.** 점 12개면 9분이다 — HTTP 요청 하나로 붙들 수 없다.
 * 2. **유언장을 첫 이동 전에 남긴다.** 프로세스가 죽으면 아래 `finally` 의 복귀도 같이 죽는다.
 * 3. **언제나 와이드로 되돌린다** — 실패·취소·시간초과 전부. 되돌리지 못하면 `cameraStranded`
 *    를 세워 사람에게 알린다. 카메라 한 대를 고배율로 버려 두는 것이 최악이다.
 * 4. **`parking`(복귀 중)도 busy 로 센다.** 그 동안에도 카메라는 움직인다.
 * 5. **잠금 전에는 줌만 바꾼다.** 옆으로 재조준하면 옆차를 표적으로 삼을 수 있다 —
 *    상류가 실제로 겪고 금지한 동작이다.
 *
 * ## 잠근 뒤 VPD 를 생략하는 이유
 *
 * 고줌에서 차량은 화면 밖으로 잘려 마스크가 깨진다. 깨진 마스크로 "실루엣 안쪽" 을 물으면
 * 정답인 판이 밖으로 판정된다. 그래서 잠근 뒤에는 마스크를 **다시 믿지 않고**
 * `plateTrack` 의 크기·종횡비·IoU 게이트로만 같은 판인지 확인한다.
 */

export type HomingState = 'idle' | 'running' | 'done' | 'failed' | 'stopped';

export type HomingCode =
  | 'plate_not_found'
  | 'plate_too_small'
  | 'target_not_found'
  | 'target_ambiguous'
  | 'target_lost'
  | 'detector_error'
  | 'runtime_error'
  | 'stopped';

export interface HomingPointResult {
  pointId: string;
  name?: string;
  status: 'ok' | 'failed' | 'uncertain';
  code?: HomingCode;
  reason?: string;
  plateW?: number;
  closeupPtz?: PtzRaw;
  /** 클로즈업 자세를 와이드 프레임 픽셀로 되쏜 값. **표시용**이고, 프레임 밖이면 없다. */
  homedPixel?: { x: number; y: number };
  steps: number;
}

export interface HomingStatus {
  state: HomingState;
  presetId?: string;
  presetName?: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
  total: number;
  currentIdx: number;
  current?: {
    pointId: string;
    name?: string;
    zoom?: number;
    plateW?: number;
    phase: string;
    thought: string;
  } | null;
  results: HomingPointResult[];
  targetPx?: number;
  /** 잡이 끝났는데 카메라를 와이드로 못 돌려놨다. **사람이 확인해야 한다.** */
  cameraStranded: boolean;
}

/** 상류(baro_calory)의 실측 기본값. 바꿀 이유가 생기기 전에는 그대로 둔다. */
export const HOME_DEFAULTS = {
  /** 이 폭(px)이면 사람이 읽는다. */
  targetPx: 160,
  startZoom: 8000,
  zStep: 1500,
  maxZoom: 16384,
  maxSteps: 10,
  /** 최대줌까지 갔을 때 이 폭이면 "그런대로 읽힌다"고 본다. */
  minOkPx: 90,
} as const;

/**
 * 기본값 위에 얹는 조정치. **`Partial<typeof HOME_DEFAULTS>` 가 아니다** — `as const` 가 붙어
 * 있어 그렇게 쓰면 `targetPx: 160` 같은 리터럴만 받는 타입이 되어, 조정 자체가 불가능해진다.
 */
export type HomingOptions = Partial<Record<keyof typeof HOME_DEFAULTS, number>>;

/** 이 잡이 저장소에 요구하는 전부. 구현이 아니라 이 표면에 의존한다. */
export interface HomingPoint {
  id: string;
  name?: string;
  x: number;
  y: number;
}

export interface HomingPreset {
  id: string;
  name?: string;
  /** 와이드 구도. 점 좌표는 이 구도에서만 뜻이 있다. */
  ptz: { panpos: number; tiltpos: number; zoompos: number };
  points: HomingPoint[];
}

export interface HomingStorePort {
  getPreset(presetId: string): Promise<HomingPreset | null>;
  /** 확정된 조준을 굳힌다. 실패한 점은 `null` 로 **지운다** — 옛 성공이 남으면 안 된다. */
  saveAim(presetId: string, pointId: string, aim: { closeupPtz: PtzRaw | null; plateBox: number[] | null }): Promise<void>;
}

export interface PlateHomingJobDeps {
  /** 번호판 검출(LPD). */
  plates: DetectorClient;
  /** 차량 **세그멘테이션**(VPD seg). 상자만 주는 검출 경로로는 옆차를 못 막는다. */
  vehicles: DetectorClient;
  traces: HomeTraceStore;
  locks: CameraLockStore;
  settleOptions?: SettleOptions;
  now?: () => string;
  /** 테스트가 실시간을 흘려보내지 않도록 주입한다. */
  clock?: () => number;
  speed?: number;
}

interface JobRecord {
  cameraId: string;
  state: HomingState;
  presetId: string;
  presetName?: string;
  startedAt: string;
  endedAt?: string;
  error?: string;
  deadline: number;
  total: number;
  currentIdx: number;
  current: HomingStatus['current'];
  results: HomingPointResult[];
  stopRequested: boolean;
  cameraStranded: boolean;
  /** 와이드 복귀 중. **이 동안에도 카메라는 움직인다** — busy 로 센다. */
  parking: boolean;
  options: Record<keyof typeof HOME_DEFAULTS, number>;
}

export class PlateHomingError extends Error {
  constructor(message: string, readonly statusCode = 500) {
    super(message);
    this.name = 'PlateHomingError';
  }
}

export class PlateHomingJobRunner {
  private readonly jobs = new Map<string, JobRecord>();
  /** 시작 경합 차단 — `start()` 의 await 사이에 두 번째 요청이 끼어드는 창을 닫는다. */
  private readonly starting = new Set<string>();
  private readonly now: () => string;
  private readonly clock: () => number;
  private readonly speed: number;

  constructor(private readonly deps: PlateHomingJobDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.clock = deps.clock ?? (() => Date.now());
    this.speed = deps.speed ?? 50;
  }

  isBusy(cameraId: string): boolean {
    if (this.starting.has(cameraId)) return true;
    const job = this.jobs.get(cameraId);
    return Boolean(job && (job.state === 'running' || job.parking));
  }

  status(cameraId: string): HomingStatus {
    const job = this.jobs.get(cameraId);
    if (!job) return { state: 'idle', total: 0, currentIdx: 0, results: [], cameraStranded: false };
    return {
      state: job.state,
      presetId: job.presetId,
      presetName: job.presetName,
      startedAt: job.startedAt,
      ...(job.endedAt ? { endedAt: job.endedAt } : {}),
      ...(job.error ? { error: job.error } : {}),
      total: job.total,
      currentIdx: job.currentIdx,
      current: job.current,
      results: job.results,
      targetPx: job.options.targetPx,
      cameraStranded: job.cameraStranded,
    };
  }

  stop(cameraId: string): HomingStatus {
    const job = this.jobs.get(cameraId);
    // 실행 중이 아니어도 오류가 아니다 — 멈춰 있길 바라는 요청은 이미 만족돼 있다.
    if (job && this.isBusy(cameraId)) job.stopRequested = true;
    return this.status(cameraId);
  }

  /**
   * **저장소를 인자로 받는다.** 탐색 데이터는 카메라마다 다른 곳에 있고, 잡은 프로세스당
   * 하나다 — 생성 시점에 저장소를 굳히면 두 번째 카메라가 첫 카메라의 프리셋을 읽는다.
   */
  async start(
    camera: CameraConfig,
    driver: CameraDriver,
    store: HomingStorePort,
    request: { presetId: string; pointIds?: string[] },
    options: HomingOptions = {},
  ): Promise<HomingStatus> {
    if (this.isBusy(camera.id)) throw new PlateHomingError(`카메라 ${camera.id} 에서 호밍이 이미 진행 중입니다`, 409);
    if (typeof driver.centerPoint !== 'function') {
      throw new PlateHomingError('이 카메라 드라이버는 픽셀 센터링을 지원하지 않아 호밍을 돌릴 수 없습니다', 501);
    }
    this.starting.add(camera.id);
    try {
      const preset = await store.getPreset(request.presetId);
      if (!preset) throw new PlateHomingError(`프리셋 ${request.presetId} 를 찾을 수 없습니다`, 404);

      let points = preset.points;
      if (request.pointIds?.length) {
        const want = new Set(request.pointIds);
        points = points.filter((point) => want.has(point.id));
        if (!points.length) throw new PlateHomingError('선택한 점을 찾을 수 없습니다', 404);
      }
      if (!points.length) throw new PlateHomingError('프리셋에 점이 없습니다 — 먼저 와이드 화면에서 주차면을 찍으십시오', 409);

      const merged = { ...HOME_DEFAULTS, ...sanitize(options) };
      const job: JobRecord = {
        cameraId: camera.id,
        state: 'running',
        presetId: preset.id,
        presetName: preset.name,
        startedAt: this.now(),
        // 점당 45초, 최소 2분. 이걸 안 두면 검출기가 먹통일 때 잡이 영원히 카메라를 잡는다.
        deadline: this.clock() + Math.max(120_000, points.length * 45_000),
        total: points.length,
        currentIdx: 0,
        current: null,
        results: [],
        stopRequested: false,
        cameraStranded: false,
        parking: false,
        options: merged,
      };
      this.jobs.set(camera.id, job);

      void this.run(camera, driver, store, preset, points, job).catch(() => {
        /* run() 이 스스로 job.state 를 채운다 — 여기서 삼키는 것은 미처리 거부뿐이다 */
      });
      return this.status(camera.id);
    } finally {
      this.starting.delete(camera.id);
    }
  }

  // --- 실행 -----------------------------------------------------------------

  private async run(
    camera: CameraConfig,
    driver: CameraDriver,
    store: HomingStorePort,
    preset: HomingPreset,
    points: HomingPoint[],
    job: JobRecord,
  ): Promise<void> {
    const home = toRaw(preset.ptz);
    // 유언장을 **첫 이동 전에** 남긴다. 이 줄과 첫 이동 사이에서 죽는 것만이 유일한 빈틈이다.
    await this.deps.locks.hold(camera.id, '번호판 호밍', home);
    try {
      for (const [index, point] of points.entries()) {
        if (job.stopRequested) { job.state = 'stopped'; break; }
        if (this.clock() > job.deadline) { job.state = 'failed'; job.error = '시간 초과'; break; }
        job.currentIdx = index;
        job.current = { pointId: point.id, name: point.name, phase: '조준', thought: `점 ‘${point.name ?? point.id}’ 마킹 지점으로 조준하는 중…` };

        let result: HomingPointResult;
        try {
          result = await this.homeOnePoint(camera, driver, preset, point, job, home);
        } catch (error) {
          result = {
            pointId: point.id, name: point.name, status: 'failed', code: 'runtime_error',
            reason: error instanceof Error ? error.message : String(error), steps: 0,
          };
        }
        // **실패한 재호밍이 옛 성공을 남겨 두면 안 된다** — 그 조준은 다른 차의 것일 수 있다.
        await store.saveAim(preset.id, point.id, {
          closeupPtz: result.status === 'ok' ? result.closeupPtz ?? null : null,
          plateBox: null,
        }).catch(() => { /* 저장 실패가 잡을 멈추지는 않는다 — 결과는 status 에 남는다 */ });
        job.results.push(result);
      }
      if (job.state === 'running') job.state = job.stopRequested ? 'stopped' : 'done';
    } catch (error) {
      job.state = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      // `current` 를 **복귀보다 먼저** 지운다. 안 그러면 state=done 을 잡은 폴링이 복귀 중에
      // 끝난 점을 여전히 "처리 중"으로 표시한다.
      job.current = null;
      job.parking = true;
      try {
        await this.settleGoto(driver, home);
        // 스스로 복귀했으니 유언장을 찢는다. 실패했으면 **남겨** 다음 기동이 대신 되돌린다 —
        // 여기가 락이 실제로 값을 하는 유일한 분기다.
        await this.deps.locks.release(camera.id);
      } catch {
        job.cameraStranded = true;
      } finally {
        job.parking = false;
        job.endedAt = this.now();
      }
    }
  }

  private async homeOnePoint(
    camera: CameraConfig,
    driver: CameraDriver,
    preset: HomingPreset,
    point: HomingPoint,
    job: JobRecord,
    home: PtzRaw,
  ): Promise<HomingPointResult> {
    const steps: HomeStep[] = [];
    const cfg = job.options;
    const done = (partial: Omit<HomingPointResult, 'pointId' | 'name' | 'steps'>): HomingPointResult =>
      ({ pointId: point.id, name: point.name, steps: steps.length, ...partial });

    await this.deps.traces.begin(camera.id, preset.id, point.id);

    // --- 표적 확정: 와이드에서 마킹점이 든 차량 하나를 고정한다 --------------
    await this.settleGoto(driver, home);
    job.current = { pointId: point.id, name: point.name, zoom: home.zoom, phase: '타깃 확인', thought: '마킹점이 가리키는 차량을 와이드 화면에서 고정하는 중…' };

    let wide: Buffer;
    try {
      wide = await driver.getSnapshot();
    } catch (error) {
      return done({ status: 'failed', code: 'detector_error', reason: `와이드 스냅샷 오류: ${message(error)}` });
    }

    let wideMasks: VehicleMask[];
    try {
      wideMasks = await this.detectMasks(wide);
    } catch (error) {
      return done({ status: 'failed', code: 'detector_error', reason: `차량 검출기 오류: ${message(error)}` });
    }

    const anchor = vehicleMaskAtPoint(wideMasks, { x: point.x, y: point.y });
    if (anchor.kind === 'missing') {
      return done({ status: 'uncertain', code: 'target_not_found', reason: '마킹점 자리에 차량이 없습니다 — 점을 차량 위로 다시 찍으세요' });
    }
    if (anchor.kind === 'ambiguous') {
      return done({ status: 'uncertain', code: 'target_ambiguous', reason: '마킹점에 차량 실루엣이 겹쳐 표적을 확정할 수 없습니다 — 점을 차량 중앙으로 옮기세요' });
    }
    if (job.stopRequested) return done({ status: 'failed', code: 'stopped', reason: '중지됨' });

    await driver.centerPoint!({ x: point.x, y: point.y });
    await this.settle(driver);

    // --- 줌인 루프 -----------------------------------------------------------
    let zoom = Math.max(home.zoom, cfg.startZoom);
    let locked = false;
    let track: PlateTrack | null = null;
    let lastGood: { ptz: PtzRaw; plateW: number } | null = null;
    let lastMaskKind: 'matched' | 'ambiguous' | 'missing' | 'skipped' = anchor.kind;
    let lastCandidates = 0;

    for (let step = 1; step <= cfg.maxSteps; step += 1) {
      if (job.stopRequested) return done({ status: 'failed', code: 'stopped', reason: '중지됨' });

      const before = await driver.getPtz();
      await this.settleGoto(driver, clampPtz({ pan: before.pan, tilt: before.tilt, zoom }));
      job.current = {
        pointId: point.id, name: point.name, zoom,
        phase: locked ? '번호판 추적' : '검출',
        thought: locked ? `z${zoom} 에서 잠근 번호판을 재확인하는 중…` : `z${zoom} 에서 번호판과 차량을 검출하는 중…`,
      };

      let snap: Buffer;
      try {
        snap = await driver.getSnapshot();
      } catch (error) {
        if (job.stopRequested) return done({ status: 'failed', code: 'stopped', reason: '중지됨' });
        return done({ status: 'failed', code: 'detector_error', reason: `스냅샷 오류: ${message(error)}` });
      }

      // 잠근 뒤에는 VPD 를 부르지 않는다 — 고줌에서 깨진 마스크가 정답을 밖으로 판정한다.
      const skipVehicles = locked;
      let plates: PlateBox[];
      let masks: VehicleMask[] = [];
      try {
        [plates, masks] = await Promise.all([
          this.detectPlates(snap),
          skipVehicles ? Promise.resolve([] as VehicleMask[]) : this.detectMasks(snap),
        ]);
      } catch (error) {
        const record: HomeStep = { step, zoom, found: false, boxes: [], reason: 'detector_error', hasFrame: false };
        steps.push(record);
        return done({ status: 'failed', code: 'detector_error', reason: message(error) });
      }

      const hasFrame = await this.deps.traces.putFrame(camera.id, preset.id, point.id, step, snap);
      const boxes = plates.map((plate) => plate.bbox);

      // 후보 좁히기 — 잠금 전에는 실루엣 안쪽, 잠금 후에는 추적 게이트.
      const centre = { x: FRAME.width / 2, y: FRAME.height / 2 };
      let target: PlateBox | null = null;
      let reason: string | undefined;

      if (skipVehicles && track) {
        const match = matchPlateTrack(track, plates, { zoom });
        if (match.kind === 'matched') {
          target = match.plate;
          track = match.nextTrack;
        } else {
          reason = match.kind === 'ambiguous' ? 'track_ambiguous' : 'track_lost';
        }
        lastMaskKind = 'skipped';
      } else {
        const centreMask = vehicleMaskAtPoint(masks, centre);
        lastMaskKind = centreMask.kind;
        const candidates = centreMask.kind === 'matched' ? platesInsideMask(plates, centreMask.mask) : [];
        lastCandidates = candidates.length;
        // **정확히 하나일 때만 잠근다.** 둘 중 가까운 것을 고르면 그 순간 옆차가 될 수 있다.
        if (candidates.length === 1) {
          target = candidates[0]!;
          locked = true;
          track = createPlateTrack(target, zoom);
        } else {
          reason = centreMask.kind === 'matched'
            ? (candidates.length === 0 ? 'no_candidate' : 'target_ambiguous')
            : `target_${centreMask.kind}`;
        }
      }

      const atMaxZoom = zoom >= cfg.maxZoom - 100;

      if (target) {
        await driver.centerPoint!({ x: Math.round(target.cx), y: Math.round(target.cy) });
        await this.settle(driver);
        const settled = await driver.getPtz();
        const plateW = Math.round(target.w);
        lastGood = { ptz: settled, plateW };
        steps.push({ step, zoom, plateW, found: true, boxes, pick: target.bbox, hasFrame });
        job.current = {
          pointId: point.id, name: point.name, zoom: settled.zoom, plateW,
          phase: '재조준',
          thought: `번호판을 중앙으로 당겨 줌인 (판 ${plateW}px, z${settled.zoom})`,
        };

        if (plateW >= cfg.targetPx) {
          await this.deps.traces.commit(camera.id, preset.id, point.id, steps, point.name);
          return done({ status: 'ok', plateW, closeupPtz: settled, ...this.reproject(camera, settled, home) });
        }
        if (settled.zoom >= cfg.maxZoom - 100) {
          await this.deps.traces.commit(camera.id, preset.id, point.id, steps, point.name);
          return plateW >= cfg.minOkPx
            ? done({ status: 'ok', reason: '최대줌', plateW, closeupPtz: settled, ...this.reproject(camera, settled, home) })
            : done({ status: 'failed', code: 'plate_too_small', reason: `최대줌인데 판이 ${plateW}px 입니다 — 더 가까운 와이드 프리셋이 필요합니다`, plateW, closeupPtz: settled });
        }
        zoom = Math.min(zoom + cfg.zStep, cfg.maxZoom);
        continue;
      }

      // 못 골랐다. **옆으로 재조준하지 않는다** — 축을 유지한 채 한 단계만 더 접근한다.
      steps.push({ step, zoom, found: false, boxes, reason, hasFrame });
      job.current = {
        pointId: point.id, name: point.name, zoom,
        phase: `접근 ${step}`,
        thought: describeMiss(reason, zoom),
      };
      if (atMaxZoom) {
        await this.deps.traces.commit(camera.id, preset.id, point.id, steps, point.name);
        return done(terminal(locked, lastMaskKind, lastCandidates));
      }
      zoom = Math.min(zoom + cfg.zStep, cfg.maxZoom);
    }

    await this.deps.traces.commit(camera.id, preset.id, point.id, steps, point.name);

    // 스텝을 다 썼다. 마지막 스텝에서 표적을 잡고 있었고 폭이 최소치를 넘으면 그것을 쓴다.
    const matchedAtEnd = steps.at(-1)?.found === true;
    if (lastGood && matchedAtEnd && lastGood.plateW >= cfg.minOkPx) {
      return done({ status: 'ok', reason: '스텝 소진', plateW: lastGood.plateW, closeupPtz: lastGood.ptz, ...this.reproject(camera, lastGood.ptz, home) });
    }
    if (locked && !matchedAtEnd) {
      return done({ status: 'failed', code: 'target_lost', reason: '잠근 번호판을 다시 찾지 못한 채 스텝을 소진했습니다' });
    }
    if (lastGood) {
      return done({ status: 'failed', code: 'plate_too_small', reason: `스텝을 소진했고 판이 ${lastGood.plateW}px 입니다`, plateW: lastGood.plateW, closeupPtz: lastGood.ptz });
    }
    return done(terminal(locked, lastMaskKind, lastCandidates));
  }

  // --- 검출 -----------------------------------------------------------------

  /**
   * 검출기는 **스냅샷 원본 해상도**로 답한다. 논리 프레임으로 옮기지 않으면 4K 스냅샷에서
   * 조준이 정확히 절반만큼 빗나간다 — 헤더에서 치수를 직접 읽어 그 자리에서 환산한다.
   */
  private async detectPlates(snap: Buffer): Promise<PlateBox[]> {
    const source = jpegSize(snap);
    const result = await this.deps.plates.detect(snap);
    return normalizePlates(result.detections, source);
  }

  private async detectMasks(snap: Buffer): Promise<VehicleMask[]> {
    const source = jpegSize(snap);
    const result = await this.deps.vehicles.detect(snap);
    return normalizeMasks(result.detections, source);
  }

  /**
   * 클로즈업 자세를 와이드 프레임 픽셀로 되쏜다 — **표시용**이다.
   *
   * 사람이 찍은 원래 점은 **그대로 둔다.** 재호밍·재캘리브레이션이 가능하려면 출발점이
   * 남아 있어야 하기 때문이다. 프레임 밖으로 떨어지면 아예 싣지 않는다 — 화면 모서리에
   * 붙은 점은 "여기다"라고 말하는 것이 아니라 계산이 빗나갔다는 뜻이다.
   */
  private reproject(camera: CameraConfig, closeup: PtzRaw, home: PtzRaw): Pick<HomingPointResult, 'homedPixel'> {
    const table = camera.intrinsics?.zoomHfov;
    if (!table?.length) return {};
    try {
      const pixel = ptzToWidePixel({
        closeup: { panpos: closeup.pan, tiltpos: closeup.tilt, zoompos: closeup.zoom },
        wide: { panpos: home.pan, tiltpos: home.tilt, zoompos: home.zoom },
        zoomHfovTable: table,
        frameWidth: FRAME.width,
        frameHeight: FRAME.height,
      });
      return pixel.inFrame ? { homedPixel: { x: pixel.x, y: pixel.y } } : {};
    } catch {
      return {};
    }
  }

  // --- 이동 -----------------------------------------------------------------

  private async settle(driver: CameraDriver): Promise<void> {
    // 정착 실패는 여기서 잡지 않는다 — 다음 스냅샷이 흐릿하면 검출이 그 사실을 말한다.
    await waitForSettle(driver, this.deps.settleOptions).catch(() => undefined);
  }

  private async settleGoto(driver: CameraDriver, target: PtzRaw, attempts = 3): Promise<void> {
    for (let i = 0; i < attempts; i += 1) {
      try {
        await driver.goPtz(target, this.speed);
        await this.settle(driver);
        return;
      } catch (error) {
        if (i === attempts - 1) throw error;
      }
    }
  }
}

// --- 순수 도우미 ---------------------------------------------------------------

function toRaw(ptz: { panpos: number; tiltpos: number; zoompos: number }): PtzRaw {
  return clampPtz({ pan: ptz.panpos, tilt: ptz.tiltpos, zoom: ptz.zoompos });
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** 마지막까지 표적을 못 잡았을 때 **무엇이 문제였는지** 로 사유를 나눈다 — 처방이 다르다. */
function terminal(
  locked: boolean,
  maskKind: 'matched' | 'ambiguous' | 'missing' | 'skipped',
  candidates: number,
): Omit<HomingPointResult, 'pointId' | 'name' | 'steps'> {
  if (locked) return { status: 'failed', code: 'target_lost', reason: '잠근 번호판을 추적하지 못했습니다 — 옆차와 겹쳤을 수 있습니다' };
  if (maskKind === 'missing') return { status: 'failed', code: 'target_lost', reason: '줌인하는 동안 표적 차량을 놓쳤습니다' };
  if (maskKind === 'ambiguous' || candidates > 1) {
    return { status: 'uncertain', code: 'target_ambiguous', reason: '표적 차량을 하나로 확정할 수 없습니다' };
  }
  return { status: 'failed', code: 'plate_not_found', reason: '표적 차량에서 번호판을 찾지 못했습니다' };
}

function describeMiss(reason: string | undefined, zoom: number): string {
  const text: Record<string, string> = {
    track_lost: '잠근 번호판을 이번 프레임에서 확인하지 못했습니다 — 축을 유지하고 한 단계 더 접근',
    track_ambiguous: '비슷한 판이 둘 이상입니다 — 축을 유지하고 한 단계 더 접근',
    no_candidate: '표적 차량은 잡았는데 실루엣 안 번호판이 아직 안 보입니다 — 접근 줌인',
    target_ambiguous: '실루엣 안 번호판이 둘 이상입니다 — 접근 줌인',
    target_missing: '광축이 지나는 차량이 아직 안 잡힙니다 — 마킹점 축을 유지하고 접근',
    target_ambiguous_mask: '차량 실루엣이 겹칩니다 — 접근 줌인',
  };
  return `${text[reason ?? ''] ?? '표적을 확정하지 못했습니다 — 접근 줌인'} (z${zoom})`;
}

/** 0·음수·NaN 은 **없는 것으로 본다.** 0 을 그대로 받으면 줌 스텝 0 으로 무한 루프가 된다. */
function sanitize(options: HomingOptions): HomingOptions {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(options)) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) out[key] = n;
  }
  return out as HomingOptions;
}
