import type { CameraDriver, CenterPoint } from '../devices/cameraDriver.js';
import type { CameraConfig } from '../config/types.js';
import type { PtzView } from '../domain/ptz.js';

/**
 * 카메라 코어 계약(포트).
 *
 * driver 계층(`CameraDriver`)과는 **다른 층**이다 — driver 는 "기기를 어떻게 두드리는가",
 * 이쪽은 "카메라로 무슨 일을 하는가"다.
 *
 * **이 파일은 어떤 구현도 import 하지 않는다.** 계약이 구현에 오염되면
 * "두 구현이 서로 대체 가능한가"를 검증할 방법이 사라진다.
 * 계약의 정본은 이 타입이 아니라 `test/coreProviderConformance.ts` 의 적합성 스위트다.
 */

export type CoreProviderName = 'remote' | 'local';

export const CORE_CAPABILITY_NAMES = [
  'center',
  'centerBox',
  'discoveryPresets',
  'discoveryPoints',
  'calibration',
  'plateHoming',
] as const;

export type CoreCapabilityName = (typeof CORE_CAPABILITY_NAMES)[number];

/** 능력 하나의 가용 여부. 못 하면 **사람 문장으로** 사유를 남긴다. */
export interface CoreCapabilityState {
  ok: boolean;
  reason?: string;
}

export interface CoreCapabilities {
  /**
   * 지금 붙어 있는 구현의 이름. **진단·표시용이며 소비자가 분기해서는 안 된다.**
   * 화면이 이 값으로 경로를 고르기 시작하면 교체 가능성이 다시 깨진다.
   */
  provider: CoreProviderName;
  cameraId: string;
  supported: Record<CoreCapabilityName, CoreCapabilityState>;
  /** 이 카메라에서 코어 작업이 진행 중인가. */
  busy: boolean;
}

/** 요청 1건의 실행 맥락. 카메라 설정과 그 드라이버를 함께 넘긴다. */
export interface CoreContext {
  camera: CameraConfig;
  driver: CameraDriver;
  signal?: AbortSignal;
}

export interface CenterBox {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export interface CenterResult {
  cameraId: string;
  point?: CenterPoint;
  box?: CenterBox;
  /** 정착 후 좌표. 구현이 좌표를 알 수 없으면 생략한다 — 지어내지 않는다. */
  ptz?: PtzView;
  /** 이동이 멈춘 것을 확인했는가. 확인할 수 없는 구현은 생략한다. */
  settled?: boolean;
  /**
   * 구현이 추가로 실어 보낸 것. 계약은 **위 필드만 보장**하고 나머지는 잃지 않고 통과시킨다
   * — 원격 코어의 응답을 깎아 내면 그쪽이 늘린 정보가 조용히 사라진다.
   */
  [extra: string]: unknown;
}

export type JobState = 'idle' | 'running' | 'done' | 'failed' | 'stopped';

export interface JobStatus {
  state: JobState;
  progress?: { done: number; total: number; percent: number };
  message?: string;
  error?: string;
  result?: unknown;
  /** 구현별 추가 필드(원격 코어의 mode·deviceId·recent 등)를 잃지 않고 통과시킨다. */
  [extra: string]: unknown;
}

/** 시작 → 폴링 → 중단. 캘리브레이션과 번호판 호밍이 같은 모양이다. */
export interface JobPort<TStart> {
  start(ctx: CoreContext, options: TStart): Promise<JobStatus>;
  status(ctx: CoreContext): Promise<JobStatus>;
  /** 실행 중이 아니어도 오류가 아니다 — 멈춰 있길 바라는 요청은 이미 만족돼 있다. */
  stop(ctx: CoreContext): Promise<JobStatus>;
}

export interface CalibrationStartOptions {
  mode: 'full' | 'verify';
}

export interface PlateHomingStartOptions {
  presetId: string;
  pointIds?: string[];
}

/** 탐색 프리셋과 그 안의 점. backend-core 의 discovery 평면에 대응한다. */
export interface DiscoveryPreset {
  id: string;
  name: string;
  [extra: string]: unknown;
}

export interface DiscoveryPoint {
  id: string;
  [extra: string]: unknown;
}

export interface DiscoveryPresetPort {
  list(ctx: CoreContext): Promise<{ presets: DiscoveryPreset[]; busy?: boolean }>;
  create(ctx: CoreContext, body: Record<string, unknown>): Promise<{ preset: DiscoveryPreset }>;
  update(ctx: CoreContext, presetId: string, body: Record<string, unknown>): Promise<{ preset: DiscoveryPreset }>;
  remove(ctx: CoreContext, presetId: string): Promise<{ removed: string }>;
  goto(ctx: CoreContext, presetId: string): Promise<{ preset: DiscoveryPreset; ptz?: PtzView }>;
}

export interface DiscoveryPointPort {
  list(ctx: CoreContext, presetId: string): Promise<{ points: DiscoveryPoint[] }>;
  create(ctx: CoreContext, presetId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  update(ctx: CoreContext, presetId: string, pointId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  remove(ctx: CoreContext, presetId: string, pointId?: string): Promise<Record<string, unknown>>;
}

/**
 * 카메라 코어. `RemoteCoreProvider`(backend-core 경유)와 `LocalCoreProvider`(자체 구현)가
 * 이 표면을 **똑같이** 채운다. 라우트는 이것만 호출하고 구현 이름으로 분기하지 않는다.
 */
export interface CoreProvider {
  readonly name: CoreProviderName;

  capabilities(ctx: CoreContext): Promise<CoreCapabilities>;

  center(ctx: CoreContext, point: CenterPoint): Promise<CenterResult>;
  centerBox(ctx: CoreContext, box: CenterBox): Promise<CenterResult>;

  readonly discoveryPresets: DiscoveryPresetPort;
  readonly discoveryPoints: DiscoveryPointPort;
  readonly calibration: JobPort<CalibrationStartOptions>;
  readonly plateHoming: JobPort<PlateHomingStartOptions>;
}

/**
 * "이 구현은 그것을 하지 않는다"는 **확정 답**이다.
 * 일시 장애(502)와 구분해야 소비자가 재시도 여부를 판단할 수 있다.
 * 근거: baro_calory/docs/architecture.md §프리뷰 경로 — 501 을 일시 장애로 보고 재시도하면
 * 아무 일도 일어나지 않는 대기만 늘어난다.
 */
export class CoreUnsupportedError extends Error {
  readonly statusCode = 501;
  constructor(readonly capability: CoreCapabilityName, reason: string) {
    super(reason);
    this.name = 'CoreUnsupportedError';
  }
}

/** 같은 카메라에서 다른 코어 작업이 진행 중이다. */
export class CoreBusyError extends Error {
  readonly statusCode = 409;
  constructor(readonly cameraId: string, message = `카메라 ${cameraId}에서 다른 코어 작업이 진행 중입니다`) {
    super(message);
    this.name = 'CoreBusyError';
  }
}

/** 능력 전부를 한 값으로 채운다. 구현이 supported 맵을 만들 때 빠뜨리지 않게 한다. */
export function allCapabilities(state: CoreCapabilityState): Record<CoreCapabilityName, CoreCapabilityState> {
  return Object.fromEntries(CORE_CAPABILITY_NAMES.map((name) => [name, state])) as Record<CoreCapabilityName, CoreCapabilityState>;
}
