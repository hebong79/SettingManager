import type {
  AppConfig,
  CameraConfig,
  CameraIntrinsics,
  CameraKind,
  CameraPatch,
  CoreConfig,
  CoreProviderChoice,
  DetectorEndpointConfig,
  DetectorsConfig,
  Object3dConfig,
  PublicCamera,
  SettingsPatch,
  StreamingConfig,
} from './types.js';

/** 파일 I/O 없는 순수 정규화·병합 계층. 파서와 저장 로직이 같은 규칙을 쓰도록 여기 한 곳에 둔다. */

const CAMERA_KINDS: readonly CameraKind[] = ['hucoms', 'backend-core', 'park3d-rpc', 'idis'];

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
  const intrinsics = normalizeIntrinsics(r.intrinsics);
  // 장소는 문서 규약대로 1 이 기본이다. 잘못 적힌 값은 1 로 되돌린다 — 없는 장소를 가리키면 DB 가 거절한다.
  const placeId = positiveInt(r.place_id) ?? 1;
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
    // 같은 규칙 — **idis 가 아니면 키 자체를 만들지 않는다.** 다른 종류의 드라이버는 이 값을
    // 보지 않으므로, 화면·API 응답에 뜻 없는 `insecureTls:false` 가 섞이지 않게 한다.
    ...(kind === 'idis' && r.insecureTls === true ? { insecureTls: true } : {}),
    ...(intrinsics !== undefined ? { intrinsics } : {}),
    place_id: placeId,
  };
}

/**
 * 실측 줌→화각 곡선. **쓸 수 있는 표일 때만** 만든다 — 앵커 2개 미만이거나 z 가 오름차순이
 * 아니면 보간이 성립하지 않는다. 반쯤 맞는 표로 조준하면 조용히 빗나가므로, 못 쓰는 표는
 * 고쳐 주지 않고 **없는 것으로** 둔다(그러면 능력이 꺼지고 사유가 화면에 뜬다).
 */
function normalizeIntrinsics(raw: unknown): CameraIntrinsics | undefined {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (!Array.isArray(r.zoomHfov)) return undefined;
  const rows: Array<{ z: number; h: number }> = [];
  for (const entry of r.zoomHfov) {
    const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const z = Number(e.z);
    const h = Number(e.h);
    if (!Number.isFinite(z) || !Number.isFinite(h) || h <= 0) return undefined;
    rows.push({ z, h });
  }
  if (rows.length < 2) return undefined;
  if (rows.some((row, i) => i > 0 && row.z <= rows[i - 1]!.z)) return undefined;
  return { zoomHfov: rows };
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

  // **카메라는 여기서 오지 않는다.** 정본은 DB(`camera_info`)이고 `ConfigStore.load()` 가 채운다.
  // 빈 배열로 두는 이유: 읽는 쪽(`driverFactory`·라우트·화면)이 예전처럼 `config.cameras` 를
  // 그대로 보게 하기 위해서다 — 그 배열이 어디서 오는가만 바뀌었다.
  const cameras: CameraConfig[] = [];

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
    object3d: normalizeObject3d(r.object3d),
    // 가리키는 기기가 실제로 있는지는 카메라를 채운 **뒤에** 판정한다(ConfigStore.pickActive).
    activeCameraId: str(r.activeCameraId),
    cameras,
  };
}

/** 3D 차량 박스 사이드카. `baseUrl` 이 비면 브리지의 `vehicleBox` 능력이 꺼진다. */
export function normalizeObject3d(raw: unknown): Object3dConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    baseUrl: stripTrailingSlash(str(r.baseUrl)),
    // 상류(baro_calory object3d-client.mjs)의 기본 별칭과 같은 값이다.
    model: str(r.model) || 'object3d-primary',
    timeoutMs: int(r.timeoutMs, 30_000, 500, 120_000),
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
