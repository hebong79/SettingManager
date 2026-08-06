/** SettingManager 설정 타입. config/config.json 의 구조와 1:1 이다. */

/**
 * 카메라 종류 — **프로토콜**이지 실물/시뮬 구분이 아니다.
 * - `hucoms`      : Hucoms HTTP CGI 로 직접 제어. **실카메라와 UE 시뮬레이터가 모두 여기 해당한다**
 *                   — UE 시뮬은 별도 프로토콜이 아니라 Hucoms CGI 를 그대로 모사한다
 *                   (실측 확인: `192.168.0.22:8083` 이 `getptzfpos` 에 정상 응답).
 * - `backend-core`: baro_calory backend-core 의 REST 제어면(`/api/ptz` 등)을 **경유**한다.
 * - `park3d-rpc`  : 언리얼 Park3D JSON-RPC 서버(`POST /rpc` — `cam.getPTZ`·`cam.setPTZ`).
 *                   **Hucoms CGI 가 아니다** — 같은 시뮬레이터라도 프로토콜이 다르고,
 *                   `/cgi-bin/...` 을 두드리면 404(`route_handler_not_found`)가 난다.
 * - `idis`        : IDIS WebAPI v2.20. 단일 CGI(`/cgi-bin/webSetup.cgi`)에 `action=` 으로 분기하고
 *                   인증은 Digest 다. **같은 벤더라도 모델·펌웨어마다 있는 액션이 다르므로**
 *                   드라이버가 능력을 지어내지 않고 기기에 물어 좁힌다(`src/devices/idis/README.md`).
 *                   좌표는 이 서비스의 계약(Hucoms 논리)과 **부호도 원점도 다르고**, 줌은
 *                   불투명 raw 가 아니라 배율×100 이다 — 변환은 드라이버 안에 갇혀 있다.
 */
export type CameraKind = 'hucoms' | 'backend-core' | 'park3d-rpc' | 'idis';

export interface CameraConfig {
  id: string;
  label: string;
  kind: CameraKind;
  /** hucoms 전용. `http://host:port`. backend-core 종류는 simulator.baseUrl 을 쓴다. */
  controlUrl: string;
  username: string;
  password: string;
  /**
   * 영상 URL. **스킴이 경로를 가른다**(설정 이름이 rtspUrl 이던 시절의 값도 그대로 읽는다).
   *   `rtsp://`·`rtsps://` → ffmpeg 로 MJPEG 전사 (실카메라)
   *   `http://`·`https://` → 연속 MJPEG 를 그대로 중계 (UE 시뮬의 직결 포트)
   *   비움                 → 스냅샷 폴링
   */
  streamUrl: string;
  timeoutMs: number;
  /** park3d-rpc 전용. 서버가 요구하는 카메라 번호로 **1-based** 다. 없으면 드라이버가 400 으로 거절한다. */
  camId?: number;
  /**
   * idis 전용. 이 기기 **하나에** 한해 TLS 인증서 검증을 끈다.
   *
   * 공장 자체서명 인증서를 쓰는 모델이 있고, 그 경우 검증을 켜면 전 요청이 연결 단계에서 죽는다.
   * 프로세스 전역 `NODE_TLS_REJECT_UNAUTHORIZED` 는 이 서비스 전체(검출기·코어 포함)의 검증을
   * 끄므로 답이 아니다. 기본은 검증(안전한 쪽)이며, 켠 기기에만 키가 생긴다.
   */
  insecureTls?: boolean;
  /**
   * 이 카메라가 선 **장소(주차장)**. 커미셔닝 DB 의 `place_info.place_id` 와 같은 값이다.
   *
   * 이 값은 그 기기가 DB 에 **처음 등록될 때** 심긴다. 이후에는 **DB 가 기준**이고
   * (옵션의 장소·카메라 탭에서 옮긴다), 여기 값을 고쳐도 이미 등록된 기기는 움직이지 않는다 —
   * 그렇게 하지 않으면 화면에서 옮긴 장소가 다음 기동에 조용히 되돌아간다.
   */
  place_id?: number;
  /**
   * **이 기기의 실측 줌→화각 곡선.** 브리지 코어가 픽셀↔PTZ 를 자체 계산할 때만 쓴다.
   *
   * 없으면 계산을 **켜지 않는다**(501). 내장 표를 기본값으로 들면 안 되기 때문이다 —
   * 그 표는 cam-001(Hucoms) 한 대의 실측 곡선이라, 다른 렌즈·다른 줌 눈금 기기에 그대로
   * 쓰면 화각이 조용히 그 값으로 보고되고 조준이 수 배 어긋난다
   * (근거: baro_calory `docs/architecture.md` §광학은 선언한 기기만 갖습니다).
   */
  intrinsics?: CameraIntrinsics;
}

/** 줌 눈금 → 수평 화각(도) 앵커. z 오름차순이며, 표 밖은 외삽하지 않고 양 끝에서 잘린다. */
export interface CameraIntrinsics {
  zoomHfov: Array<{ z: number; h: number }>;
}

export interface StreamingConfig {
  ffmpegPath: string;
  rtspTransport: 'tcp' | 'udp';
  fps: number;
  jpegQuality: number;
  startupTimeoutMs: number;
}

/**
 * 어느 코어 구현으로 돌릴 것인가. **질의 파라미터가 아니라 설정**이다.
 * `bridge` = 자체 구현(구성도의 Bridge Backend-Core) · `remote` = backend-core 경유.
 * 옛 값 `"local"` 은 `bridge` 의 이전 이름이며 `normalizeCore` 가 그대로 읽어 준다.
 */
export type CoreProviderChoice = 'bridge' | 'remote';

export interface CoreConfig {
  /** 전역 기본값. */
  provider: CoreProviderChoice;
  /** 기기별 재정의. 있으면 전역을 이긴다. */
  perCamera: Record<string, CoreProviderChoice>;
}

/**
 * 검출 서비스 1개의 접속 정보. `baseUrl` 이 비어 있으면 **설정되지 않은 것**이고,
 * 그 검출기를 부르면 501 로 거절된다(빈 URL 로 호출을 시도하지 않는다).
 */
export interface DetectorEndpointConfig {
  baseUrl: string;
  timeoutMs: number;
}

/** 구성도의 API 계층. 셋 다 SettingManager 밖에서 도는 별도 서비스다. */
export interface DetectorsConfig {
  vpd: DetectorEndpointConfig;
  lpd: DetectorEndpointConfig;
  lpr: DetectorEndpointConfig;
}

/**
 * 3D 차량 박스 추론 사이드카(`baro_calory/tools/baro_object3d_api`).
 * 브리지 코어의 `vehicleBox` 능력이 이것을 소비한다 — 원격 코어는 backend-core 를 거치므로
 * 이 설정을 보지 않는다.
 */
export interface Object3dConfig {
  baseUrl: string;
  /** 사이드카에 등록된 모델 별칭. */
  model: string;
  timeoutMs: number;
}

export interface AppConfig {
  server: { host: string; port: number };
  simulator: { baseUrl: string };
  streaming: StreamingConfig;
  core: CoreConfig;
  detectors: DetectorsConfig;
  object3d: Object3dConfig;
  activeCameraId: string;
  cameras: CameraConfig[];
}

/** 화면·API 로 나가는 카메라 정보. 비밀번호는 절대 싣지 않는다. */
export type PublicCamera = Omit<CameraConfig, 'password'> & { hasPassword: boolean };

/**
 * 카메라 1건의 부분 갱신.
 * `rtspUrl` 은 `streamUrl` 의 **옛 이름**이다 — 갱신에서도 받아 준다. 읽기에서만 받아 주면
 * 옛 화면이 보낸 값이 기존 `streamUrl` 에 밀려 조용히 버려진다(실측 재현된 결함).
 */
export type CameraPatch = Partial<CameraConfig> & { id: string; rtspUrl?: string };

/** 옵션 페이지가 보내는 갱신 요청. 비밀번호는 빈 문자열이면 기존 값을 유지한다. */
export interface SettingsPatch {
  simulator?: { baseUrl?: string };
  core?: { provider?: CoreProviderChoice; perCamera?: Record<string, CoreProviderChoice> };
  activeCameraId?: string;
  cameras?: CameraPatch[];
}
