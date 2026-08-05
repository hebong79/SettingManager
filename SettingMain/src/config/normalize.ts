import type {
  AppConfig,
  CameraConfig,
  CameraKind,
  CameraPatch,
  CoreConfig,
  CoreProviderChoice,
  DetectorEndpointConfig,
  DetectorsConfig,
  PublicCamera,
  SettingsPatch,
  StreamingConfig,
} from './types.js';

/** 파일 I/O 없는 순수 정규화·병합 계층. 파서와 저장 로직이 같은 규칙을 쓰도록 여기 한 곳에 둔다. */

const CAMERA_KINDS: readonly CameraKind[] = ['hucoms', 'backend-core', 'park3d-rpc'];

const DEFAULT_STREAMING: StreamingConfig = {
  ffmpegPath: 'ffmpeg',
  rtspTransport: 'tcp',
  fps: 5,
  jpegQuality: 5,
  startupTimeoutMs: 10_000,
};

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function int(value: unknown, fallback: number, low: number, high: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(high, Math.max(low, Math.round(n)));
}

/**
 * park3d-rpc 의 camId 전용. 클램프하는 `int()` 와 달리 **유효하지 않으면 값을 만들지 않는다** —
 * 잘못 적은 값을 1 로 보정하면 엉뚱한 카메라를 조작하게 되고, 그 사고는 화면에 아무 흔적도 남기지 않는다.
 */
function positiveInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

export class ConfigError extends Error {
  constructor(message: string, readonly statusCode = 400, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** 카메라 1건을 정규화한다. id 가 없으면 등록하지 않는다(익명 기기는 선택도 저장도 불가). */
export function normalizeCamera(raw: unknown): CameraConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const kind = CAMERA_KINDS.includes(r.kind as CameraKind) ? (r.kind as CameraKind) : 'hucoms';
  const camId = positiveInt(r.camId);
  return {
    id,
    label: str(r.label) || id,
    kind,
    controlUrl: stripTrailingSlash(str(r.controlUrl)),
    username: str(r.username),
    password: typeof r.password === 'string' ? r.password : '',
    // `rtspUrl` 은 옛 이름이다 — 기존 설정 파일이 그대로 열리도록 별칭으로 받는다.
    streamUrl: str(r.streamUrl) || str(r.rtspUrl),
    timeoutMs: int(r.timeoutMs, 5000, 500, 60_000),
    // park3d-rpc 가 아닌 카메라에는 키 자체가 생기지 않는다(공개 응답의 키 집합을 넓히지 않는다).
    ...(camId !== undefined ? { camId } : {}),
  };
}

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** config.json 원문 → AppConfig. 알 수 없는 필드는 조용히 버리고 기본값으로 채운다. */
export function normalizeConfig(raw: unknown): AppConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const server = (r.server ?? {}) as Record<string, unknown>;
  const simulator = (r.simulator ?? {}) as Record<string, unknown>;
  const streaming = (r.streaming ?? {}) as Record<string, unknown>;
  const core = normalizeCore(r.core);

  const cameras = (Array.isArray(r.cameras) ? r.cameras : [])
    .map(normalizeCamera)
    .filter((c): c is CameraConfig => c !== null);
  if (cameras.length === 0) throw new ConfigError('config.json 에 카메라가 1개 이상 있어야 합니다');

  const requested = str(r.activeCameraId);
  const activeCameraId = cameras.some((c) => c.id === requested) ? requested : cameras[0]!.id;

  return {
    server: {
      host: str(server.host) || '127.0.0.1',
      port: int(server.port, 13030, 1, 65535),
    },
    simulator: { baseUrl: stripTrailingSlash(str(simulator.baseUrl)) },
    streaming: {
      ffmpegPath: str(streaming.ffmpegPath) || DEFAULT_STREAMING.ffmpegPath,
      rtspTransport: streaming.rtspTransport === 'udp' ? 'udp' : 'tcp',
      fps: int(streaming.fps, DEFAULT_STREAMING.fps, 1, 30),
      jpegQuality: int(streaming.jpegQuality, DEFAULT_STREAMING.jpegQuality, 1, 31),
      startupTimeoutMs: int(streaming.startupTimeoutMs, DEFAULT_STREAMING.startupTimeoutMs, 1000, 60_000),
    },
    core,
    detectors: normalizeDetectors(r.detectors),
    activeCameraId,
    cameras,
  };
}

/**
 * 검출 서비스 접속 정보. **없으면 빈 baseUrl** 이고, 그 상태가 곧 "설정되지 않았다"다.
 * 기본 URL 을 지어 넣지 않는 이유: 아무 데도 없는 주소로 15초를 기다린 뒤 나는 타임아웃보다,
 * "설정되지 않았습니다" 라는 즉답이 훨씬 빨리 원인을 알려 준다.
 */
export function normalizeDetectors(raw: unknown): DetectorsConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const one = (value: unknown): DetectorEndpointConfig => {
    const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    // 추론은 초 단위로 걸린다 — 카메라 제어(5초)보다 넉넉한 기본값을 쓴다.
    return { baseUrl: stripTrailingSlash(str(v.baseUrl)), timeoutMs: int(v.timeoutMs, 15_000, 500, 120_000) };
  };
  return { vpd: one(r.vpd), lpd: one(r.lpd), lpr: one(r.lpr) };
}

/**
 * 코어 구현 선택. 기본값은 **bridge** — 자체 구현이 정본이고 원격은 갈아 끼우는 쪽이다.
 *
 * `"local"` 은 `bridge` 의 **옛 이름**이다. 이미 저장된 `config.json` 이 그 값을 들고 있으므로
 * 여기서 접어 읽는다 — 접지 않으면 옛 설정이 조용히 기본값으로 떨어져, 기기별 재정의를
 * 걸어 둔 사용자가 이유 없이 다른 구현으로 도는 것을 눈치채지 못한다.
 */
export function normalizeCore(raw: unknown): CoreConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const perCamera: Record<string, CoreProviderChoice> = {};
  const entries = (r.perCamera && typeof r.perCamera === 'object' ? r.perCamera : {}) as Record<string, unknown>;
  for (const [cameraId, choice] of Object.entries(entries)) {
    const folded = coreChoice(choice);
    if (folded) perCamera[cameraId] = folded;
  }
  return { provider: r.provider === 'remote' ? 'remote' : 'bridge', perCamera };
}

/** 알아듣는 값만 돌려준다. 오타를 조용히 기본값으로 바꾸지 않는다(호출자가 무시하도록 undefined). */
function coreChoice(value: unknown): CoreProviderChoice | undefined {
  if (value === 'remote') return 'remote';
  if (value === 'bridge' || value === 'local') return 'bridge';
  return undefined;
}

/** 이 카메라를 어느 구현으로 돌릴 것인가. 기기별 재정의가 전역을 이긴다. */
export function coreProviderFor(config: AppConfig, cameraId: string): CoreProviderChoice {
  return config.core.perCamera[cameraId] ?? config.core.provider;
}

/** 비밀번호를 제거한 공개 형태. 화면·API 응답은 반드시 이것만 쓴다. */
export function toPublicCamera(camera: CameraConfig): PublicCamera {
  const { password, ...rest } = camera;
  return { ...rest, hasPassword: password.length > 0 };
}

/**
 * 옛 필드명을 새 이름으로 승격한다.
 *
 * 갱신에서 이걸 안 하면 `{...camera, ...change}` 병합에서 **기존 streamUrl 이 남아 있어**
 * 새로 보낸 rtspUrl 이 정규화 단계의 `streamUrl || rtspUrl` 에 밀려 조용히 버려진다.
 * 브라우저에 옛 화면이 열려 있으면 "저장했는데 안 바뀐다"로 나타난다(실측 재현).
 */
function promoteLegacyFields(change: CameraPatch): Partial<CameraConfig> & { id: string } {
  const { rtspUrl, ...rest } = change;
  if (typeof rtspUrl === 'string' && rest.streamUrl === undefined) {
    return { ...rest, streamUrl: rtspUrl };
  }
  return rest;
}

/**
 * 옵션 페이지의 부분 갱신을 현재 설정에 병합한다.
 * 비밀번호는 **빈 문자열이면 기존 값을 유지**한다 — 화면이 비밀번호를 되돌려받지 않으므로
 * 빈 값을 그대로 쓰면 저장 한 번에 자격증명이 지워진다.
 */
export function mergeSettings(current: AppConfig, patch: SettingsPatch): AppConfig {
  const next: AppConfig = {
    ...current,
    core: patch.core ? normalizeCore({ ...current.core, ...patch.core }) : current.core,
    simulator: { baseUrl: patch.simulator?.baseUrl !== undefined ? stripTrailingSlash(str(patch.simulator.baseUrl)) : current.simulator.baseUrl },
    cameras: current.cameras.map((camera) => {
      const change = patch.cameras?.find((c) => c.id === camera.id);
      if (!change) return camera;
      const merged = normalizeCamera({ ...camera, ...promoteLegacyFields(change), password: undefined });
      if (!merged) return camera;
      const password = typeof change.password === 'string' && change.password.length > 0 ? change.password : camera.password;
      return { ...merged, password };
    }),
  };

  if (patch.activeCameraId !== undefined) {
    const requested = str(patch.activeCameraId);
    if (!next.cameras.some((c) => c.id === requested)) {
      throw new ConfigError(`등록되지 않은 카메라입니다: ${requested}`, 404);
    }
    next.activeCameraId = requested;
  }
  return next;
}

/** 기기 ID 규칙: 경로·파일명·URL 에 그대로 들어가므로 안전한 문자만 허용한다. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** 새 기기를 등록한다. 채우지 않은 필드는 정규화 기본값이 들어간다. */
export function addCamera(current: AppConfig, input: Partial<CameraConfig> & { id: string }): { config: AppConfig; camera: CameraConfig } {
  const id = str(input.id);
  if (!ID_RE.test(id)) {
    throw new ConfigError('기기 ID 는 영문·숫자로 시작하고 영문·숫자·`_ - .` 만 쓸 수 있습니다 (최대 64자)');
  }
  if (current.cameras.some((c) => c.id === id)) {
    throw new ConfigError(`이미 있는 기기 ID 입니다: ${id}`, 409);
  }
  const camera = normalizeCamera({ ...input, id, label: str(input.label) || id });
  if (!camera) throw new ConfigError('기기를 만들 수 없습니다');
  return { config: { ...current, cameras: [...current.cameras, camera] }, camera };
}

/**
 * 기기를 지운다.
 * 마지막 한 대는 지울 수 없다 — 조작할 대상이 없는 설정은 다음 기동에서 로드 자체가 실패한다.
 * 활성 기기를 지우면 남은 첫 기기로 활성이 옮겨 간다(활성이 유령 id 를 가리키지 않게).
 */
export function removeCamera(current: AppConfig, id: string): { config: AppConfig; removed: CameraConfig } {
  const removed = current.cameras.find((c) => c.id === id);
  if (!removed) throw new ConfigError(`등록되지 않은 카메라입니다: ${id}`, 404);
  if (current.cameras.length === 1) {
    throw new ConfigError('마지막 기기는 삭제할 수 없습니다 — 최소 1개가 있어야 합니다', 409);
  }
  const cameras = current.cameras.filter((c) => c.id !== id);
  const activeCameraId = current.activeCameraId === id ? cameras[0]!.id : current.activeCameraId;
  return { config: { ...current, cameras, activeCameraId }, removed };
}
