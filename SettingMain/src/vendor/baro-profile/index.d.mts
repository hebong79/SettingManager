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

/** 줌 눈금 → 센터링 게인 앵커. `k = f_firmware / f_lens` 이며 **단조가 아니다**. */
export type GainCurve = ReadonlyArray<{ z: number; k: number }>;
/** 줌 눈금 → 수평 화각(도) 앵커. */
export type HfovCurve = ReadonlyArray<{ z: number; h: number }>;

export declare function resolveIntrinsics(spec?: unknown): {
  zoomHfov: HfovCurve;
  centeringGain: GainCurve | null;
  source: string;
  label?: string;
  measuredAt?: string;
  residual?: unknown;
};

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

/** 표가 없거나 비면 **1** 이다 — 내장 곡선으로 대체하지 않는다. */
export declare function centeringGain(zoomPos: number, table?: GainCurve | null): number;

/**
 * 클릭 픽셀을 게인만큼 **미리 늘려** 펌웨어의 부족 회전을 상쇄한다.
 * 보정된 점이 프레임 밖으로 나가면 잘라 넣고 `clamped` 로 알린다 —
 * 그 클릭은 절반만 보정된 것이므로 삼키면 안 된다.
 */
export declare function applyCenteringGain(options: {
  x: number;
  y: number;
  zoomPos: number;
  table?: GainCurve | null;
  frameWidth?: number;
  frameHeight?: number;
}): { x: number; y: number; k: number; clamped: boolean };

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

// --- 캘리브레이션 솔버 -------------------------------------------------------
//
// **인자가 둘이다**(`samples`, `options`). 한 덩어리로 선언하면 호출부가 조용히 어긋난다.

/** 클릭 1회. 스윕 잡이 채워 넣는 측정 결과이며 솔버의 유일한 입력이다. */
export interface CalibrationSample {
  dx: number;
  dy: number;
  clickX: number;
  clickY: number;
  zoomAnchor: number;
  ptzBefore: { panpos: number; tiltpos: number; zoompos: number };
  ptzAfter: { panpos: number; tiltpos: number; zoompos: number };
  dpanCd: number;
  dtiltCd: number;
  /** 매칭이 성공했을 때만 채워진다. */
  landedX?: number;
  landedY?: number;
  residualX?: number;
  residualY?: number;
  peak?: number;
  margin?: number;
  contrast?: number;
  usable?: boolean;
  reason?: string;
  [extra: string]: unknown;
}

/** 줌 앵커 하나의 해. 게인은 **잔차 기울기**에서, 화각은 **초점 피팅**에서 나온다. */
export interface ZoomSolution {
  zoom: number;
  /** 그리는 데 쓴다. 초점 피팅(≥3점)이 실패하면 `null`. */
  hfov: number | null;
  /** 조준하는 데 쓴다. 기울기(≥2점)만 있으면 나온다. */
  gain: number | null;
  focalTrue: number | null;
  focalFirmware: number | null;
  residualSlope: number;
  /** 1/4 프레임 클릭 기준 빗나간 픽셀. **이 패스가 무엇이었는지에 따라 뜻이 반대다.** */
  residualPx: number;
  fitRmsPx: number | null;
  samples: number;
  of: number;
}

export interface CalibrationResult {
  zoomHfov: Array<{ z: number; h: number }>;
  centeringGain: Array<{ z: number; k: number }>;
  measuredAt?: string;
  residual: {
    /** **보정 전** 오차다. 보정 후 남는 오차가 아니다 — verify 패스만 그것을 말할 수 있다. */
    beforePx: number;
    /** 앵커별 **최댓값**. 앵커 하나가 시끄러우면 그것만으로 올라간다. */
    fitRmsPx: number;
    /** 대표 앵커. **발행 게이트는 이쪽으로 판정한다**(최댓값은 보고에만 남긴다). */
    fitRmsMedianPx: number;
    anchors: number;
    byZoom: Record<string, number>;
    byZoomFitRms: Record<string, number>;
  };
  /** 장면이 답하지 못한 줌. 숨기지 않는다 — 곡선은 그 커버리지만큼만 좋다. */
  skipped: Array<{ zoom: number; usable: number; of: number }>;
  points: ZoomSolution[];
}

/** 앵커가 2개 미만이면 **던진다**(사람 문장). */
export declare function buildCalibration(
  samples: CalibrationSample[],
  options?: { gainApplied?: (zoom: number) => number; measuredAt?: string },
): CalibrationResult;

/** 쓸 수 있는 표본이 모자라면 `null`. */
export declare function solveZoom(
  samples: CalibrationSample[],
  options?: { gainApplied?: number; minSamples?: number },
): ZoomSolution | null;

export declare function usableSamples(samples: CalibrationSample[]): CalibrationSample[];
/** 이보다 약한 매칭은 카메라가 아니라 **장면이 실패한 것**이다(하늘·빈 아스팔트). */
export declare const MIN_PEAK: number;
/** 점수는 훌륭한데 **위치를 특정 못 하는** 경우를 거른다. 점수보다 이쪽이 중요하다. */
export declare const MIN_MARGIN: number;
