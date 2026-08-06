/**
 * 벤더링한 `@baro/profile` 의 **타입 선언 — 이 파일만 우리 것이다.**
 *
 * 옆의 `.mjs` 는 상류 원본이라 손대지 않는다(§VENDOR.md). 그런데 그 JS 에는 타입 주석이 없어
 * tsc 가 추론하면 필수 인자(`x`·`y` 처럼 기본값 없는 것)가 아예 매개변수 타입에서 빠진다 —
 * 그 상태로 strict 코드에서 부르면 오히려 정상 호출이 오류가 된다.
 *
 * 그래서 계약을 **여기 따로 적는다.** 상류 파일을 고치는 것이 아니므로 벤더링 규칙을 깨지 않고,
 * 이 선언이 상류와 어긋나면 `test/vendorProfile.test.ts` 의 계산 검사가 잡는다.
 * 상류를 갱신할 때는 이 선언도 함께 확인한다.
 */

export declare class HucomsCameraError extends Error {
  constructor(message: string, details?: Record<string, unknown>);
}

/** 줌 눈금 → 수평 화각(도) 앵커. z 오름차순이며 표 밖은 외삽하지 않고 잘린다. */
export declare const ZOOM_HFOV_TABLE: ReadonlyArray<{ z: number; h: number }>;

export declare const CAMERA_CALIBRATIONS: Record<string, unknown>;

export declare function resolveIntrinsics(spec?: unknown): unknown;

/**
 * 줌 눈금 → 수평 화각(도).
 * `table` 은 **그 기기의 실측 곡선**이다. 생략하면 내장 cam-001 표를 쓰는데,
 * 다른 렌즈에 그대로 쓰면 화각이 조용히 틀린 값으로 보고된다(§VENDOR.md 주의).
 */
export declare function hfovFromZoomPos(
  zoomPos: number,
  wideHFovDeg?: number,
  table?: ReadonlyArray<{ z: number; h: number }>,
): number;

/** 수평 화각 → 수직 화각(도). tan 핀홀 관계이며 고정 비율이 아니다. */
export declare function vfovFromHfov(hfovDeg: number, frameWidth?: number, frameHeight?: number): number;

export declare function centeringGain(zoomPos: number, table?: ReadonlyArray<{ z: number; g: number }>): number;

export declare function applyCenteringGain(
  delta: { panDelta: number; tiltDelta: number },
  options?: Record<string, unknown>,
): { panDelta: number; tiltDelta: number; [extra: string]: unknown };

export declare function ptzCamera(options?: Record<string, unknown>): unknown;
export declare function projectWorldToPixel(options?: Record<string, unknown>): unknown;
export declare function projectPoints(options?: Record<string, unknown>): unknown;

/** 클로즈업 PTZ 를 와이드 프레임의 픽셀로 되쏜다 — **표시**용이다. */
export declare function ptzToWidePixel(options: {
  closeup: { panpos: number; tiltpos: number; zoompos?: number };
  wide: { panpos: number; tiltpos: number; zoompos?: number };
  hfov?: number;
  vfov?: number;
  zoomHfovTable?: ReadonlyArray<{ z: number; h: number }>;
  frameWidth?: number;
  frameHeight?: number;
}): { x: number; y: number; xExact: number; yExact: number; inFrame: boolean };

/**
 * 클릭 픽셀 → pan/tilt 델타(centi-degree). **조준**용이다(표시와 섞지 않는다).
 * 광축이 기울어 있으면 가로 클릭에도 틸트가 딸려 움직인다 — 짐벌 기하이며 실측으로 확인됐다.
 */
export declare function pixelToPtzDelta(options: {
  x: number;
  y: number;
  hfovDeg: number;
  tiltDeg?: number;
  focalGain?: number;
  frameWidth?: number;
  frameHeight?: number;
}): { panDelta: number; tiltDelta: number };

/** `hfovFromZoomPos` 의 별칭(상류가 옛 호출부를 위해 유지). */
export declare function zoomPosToHFov(
  zoomPos: number,
  wideHFovDeg?: number,
  table?: ReadonlyArray<{ z: number; h: number }>,
): number;

/** 임의 프레임 좌표를 Hucoms 논리 프레임(1920×1080)으로 정규화한다. */
export declare function scalePointToHucomsFrame(options: {
  x: number;
  y: number;
  frameWidth?: number;
  frameHeight?: number;
}): { x: number; y: number };

export declare const HUCOMS_FRAME: { width: number; height: number };

export declare function buildCalibration(options: Record<string, unknown>): Record<string, unknown>;
export declare function solveZoom(options: Record<string, unknown>): Record<string, unknown>;
export declare function usableSamples(samples: unknown[]): unknown[];
export declare const MIN_PEAK: number;
export declare const MIN_MARGIN: number;
