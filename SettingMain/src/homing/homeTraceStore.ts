import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from '../paths.js';

/**
 * 호밍 **과정 다시보기** 저장소 — 스텝별 프레임(JPEG)과 그 스텝이 본 것(JSON).
 *
 * ## 왜 남기는가
 *
 * 호밍은 점마다 성패가 갈리고 실패 사유가 다르다. "번호판을 못 찾았다"는 결과만으로는
 * **무엇을 고쳐야 하는지 알 수 없다** — 점을 잘못 찍은 것인지, 옆차와 겹친 것인지,
 * 검출기가 못 본 것인지가 전부 다른 처방이다. 잡이 실제로 본 그림과 상자를 남겨 두면
 * 사람이 그 자리에서 판단할 수 있다.
 *
 * ## 카메라 id 가 경로에 들어가는 이유
 *
 * 점 id(`pt-7`)는 **프리셋 안에서만** 1부터 매겨진다. 카메라를 빼면 카메라 B 를 호밍할 때
 * 같은 `p-1/pt-7` 이 카메라 A 의 프레임을 지운다(상류가 실제로 겪은 사고).
 *
 * ## 재호밍은 옛 기록을 **덮지 않고 지운다**
 *
 * 6스텝짜리 옛 기록 위에 3스텝짜리 새 기록을 얹으면 4~6번 프레임이 남아, 이번에 보지도
 * 않은 그림이 이번 결과의 근거처럼 보인다.
 */

export interface HomeStep {
  step: number;
  zoom: number;
  /** 이 스텝에서 확정한 판의 폭(px). 못 찾았으면 없다 — 0 으로 채우면 "폭이 0인 판"이 된다. */
  plateW?: number;
  found: boolean;
  /** 이 프레임에서 검출된 판 전부(논리 프레임 좌표). 후보 판정 전의 날것이다. */
  boxes: Array<[number, number, number, number]>;
  /** 그중 표적으로 고른 것. 없으면 아무것도 고르지 못한 스텝이다. */
  pick?: [number, number, number, number];
  /** 왜 못 골랐나 — `target_missing` · `target_ambiguous` · `track_lost` · `no_candidate`. */
  reason?: string;
  /** 프레임이 저장됐는가. 저장 실패(디스크 가득 등)에도 잡은 계속 돈다. */
  hasFrame: boolean;
}

export interface HomeTrace {
  cameraId: string;
  presetId: string;
  pointId: string;
  name?: string;
  endedAt: string;
  steps: Array<HomeStep & { frameUrl?: string }>;
}

export interface HomeTraceStoreOptions {
  dir?: string;
  now?: () => string;
}

/** 경로에 들어가도 안전한 조각인가. **여기서 막지 않으면 `..` 하나로 저장소 밖이 열린다.** */
export function isSafeSegment(value: string): boolean {
  return /^[\w.-]+$/.test(value) && value !== '.' && value !== '..';
}

export class HomeTraceStore {
  private readonly dir: string;
  private readonly now: () => string;

  constructor(options: HomeTraceStoreOptions = {}) {
    this.dir = options.dir ?? join(CONFIG_DIR, 'home-frames');
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** 이 점의 옛 기록을 통째로 버리고 새로 시작한다. */
  async begin(cameraId: string, presetId: string, pointId: string): Promise<void> {
    const dir = this.dirOf(cameraId, presetId, pointId);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
  }

  /**
   * 스텝 프레임 1장. **실패해도 던지지 않는다** — 다시보기를 못 남기는 것이 호밍을 멈출
   * 이유는 아니다. 대신 `HomeStep.hasFrame` 이 false 가 되어 화면이 그 사실을 안다.
   */
  async putFrame(cameraId: string, presetId: string, pointId: string, step: number, jpeg: Buffer): Promise<boolean> {
    try {
      await writeFile(join(this.dirOf(cameraId, presetId, pointId), `step-${step}.jpg`), jpeg);
      return true;
    } catch {
      return false;
    }
  }

  /** 점 하나가 끝났다. 스텝 기록을 파일로 굳힌다 — 재기동해도 다시보기가 남는다. */
  async commit(cameraId: string, presetId: string, pointId: string, steps: HomeStep[], name?: string): Promise<void> {
    const trace: HomeTrace = { cameraId, presetId, pointId, name, endedAt: this.now(), steps };
    try {
      await writeFile(join(this.dirOf(cameraId, presetId, pointId), 'steps.json'), `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
    } catch {
      /* 다시보기를 못 남기는 것이 결과를 무효로 만들지는 않는다 */
    }
  }

  /** 프레임 URL 은 **여기서만** 만든다 — 화면이 경로를 조립하면 서버의 검증과 어긋난다. */
  async read(cameraId: string, presetId: string, pointId: string): Promise<HomeTrace | null> {
    this.assertSegments(cameraId, presetId, pointId);
    try {
      const raw = await readFile(join(this.dirOf(cameraId, presetId, pointId), 'steps.json'), 'utf8');
      const trace = JSON.parse(raw) as HomeTrace;
      const base = `/api/core/home-frame/${encode(cameraId)}/${encode(presetId)}/${encode(pointId)}`;
      return {
        ...trace,
        steps: trace.steps.map((step) => (step.hasFrame ? { ...step, frameUrl: `${base}/${step.step}` } : step)),
      };
    } catch {
      return null;
    }
  }

  async frame(cameraId: string, presetId: string, pointId: string, step: number): Promise<Buffer | null> {
    this.assertSegments(cameraId, presetId, pointId);
    if (!Number.isInteger(step) || step < 1 || step > 999) throw new HomeTraceError('스텝 번호가 올바르지 않습니다');
    try {
      return await readFile(join(this.dirOf(cameraId, presetId, pointId), `step-${step}.jpg`));
    } catch {
      return null;
    }
  }

  private dirOf(cameraId: string, presetId: string, pointId: string): string {
    this.assertSegments(cameraId, presetId, pointId);
    return join(this.dir, cameraId, presetId, pointId);
  }

  private assertSegments(...segments: string[]): void {
    for (const segment of segments) {
      if (!isSafeSegment(segment)) throw new HomeTraceError(`경로에 쓸 수 없는 값입니다: ${segment}`);
    }
  }
}

export class HomeTraceError extends Error {
  readonly statusCode = 403;
  constructor(message: string) {
    super(message);
    this.name = 'HomeTraceError';
  }
}

const encode = (value: string): string => encodeURIComponent(value);
