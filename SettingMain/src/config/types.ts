/** SettingManager 설정 타입. config/config.json 의 구조와 1:1 이다. */

/**
 * 카메라 종류 — **프로토콜**이지 실물/시뮬 구분이 아니다.
 * - `hucoms`      : Hucoms HTTP CGI 로 직접 제어. **실카메라와 UE 시뮬레이터가 모두 여기 해당한다**
 *                   — UE 시뮬은 별도 프로토콜이 아니라 Hucoms CGI 를 그대로 모사한다
 *                   (실측 확인: `192.168.0.22:8083` 이 `getptzfpos` 에 정상 응답).
 * - `backend-core`: baro_calory backend-core 의 REST 제어면(`/api/ptz` 등)을 **경유**한다.
 */
export type CameraKind = 'hucoms' | 'backend-core';

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
}

export interface StreamingConfig {
  ffmpegPath: string;
  rtspTransport: 'tcp' | 'udp';
  fps: number;
  jpegQuality: number;
  startupTimeoutMs: number;
}

/** 어느 코어 구현으로 돌릴 것인가. **질의 파라미터가 아니라 설정**이다. */
export type CoreProviderChoice = 'local' | 'remote';

export interface CoreConfig {
  /** 전역 기본값. */
  provider: CoreProviderChoice;
  /** 기기별 재정의. 있으면 전역을 이긴다. */
  perCamera: Record<string, CoreProviderChoice>;
}

export interface AppConfig {
  server: { host: string; port: number };
  simulator: { baseUrl: string };
  streaming: StreamingConfig;
  core: CoreConfig;
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
