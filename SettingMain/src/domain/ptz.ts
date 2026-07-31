/**
 * PTZ 좌표 도메인. 외부 I/O 없는 순수 계층.
 *
 * 계약 좌표는 Hucoms 논리 좌표계다(근거: baro_calory/docs/cameras.md §Hucoms — HTTP CGI):
 *   panpos  0..35999   0.01°
 *   tiltpos -2000..9000 0.01°
 *   zoompos 0..65535   **불투명 raw** — 물리적 의미가 없다
 *
 * 그래서 pan/tilt 만 각도로 환산해 보여주고, **줌은 raw 그대로만** 보여준다.
 * 줌 raw 를 배율이나 화각으로 바꾸려면 기기별 실측 표(zoomHfov)가 필요하고,
 * 그 표는 캘리브레이션의 산출물이지 이 계층이 지어낼 수 있는 값이 아니다.
 */

export interface PtzRaw {
  pan: number;
  tilt: number;
  zoom: number;
}

export interface PtzView extends PtzRaw {
  /** 0.00 ~ 359.99 */
  panDeg: number;
  /** -20.00 ~ 90.00 */
  tiltDeg: number;
}

export const PAN_RANGE = [0, 35999] as const;
export const TILT_RANGE = [-2000, 9000] as const;
export const ZOOM_RANGE = [0, 65535] as const;

export type Axis = 'pan' | 'tilt' | 'zoom';

const RANGES: Record<Axis, readonly [number, number]> = {
  pan: PAN_RANGE,
  tilt: TILT_RANGE,
  zoom: ZOOM_RANGE,
};

/** 팬은 원(circular)이라 자르지 않고 감는다. JS 의 %는 피제수 부호를 따르므로 양수 재정규화가 필요하다. */
export function wrapPan(value: number): number {
  const span = PAN_RANGE[1] + 1;
  return ((Math.round(value) % span) + span) % span;
}

/** 틸트·줌은 도달범위 밖이 존재하지 않으므로 자른다. */
export function clampAxis(axis: Axis, value: number): number {
  if (axis === 'pan') return wrapPan(value);
  const [low, high] = RANGES[axis];
  return Math.min(high, Math.max(low, Math.round(value)));
}

export function clampPtz(ptz: PtzRaw): PtzRaw {
  return {
    pan: clampAxis('pan', ptz.pan),
    tilt: clampAxis('tilt', ptz.tilt),
    zoom: clampAxis('zoom', ptz.zoom),
  };
}

/** 요청값이 도달범위 밖이라 잘린 축을 알려준다. 조용히 자르면 착지가 어긋난 것을 알 수 없다. */
export function limitedAxes(requested: Partial<PtzRaw>): Axis[] {
  const limited: Axis[] = [];
  for (const axis of ['tilt', 'zoom'] as const) {
    const value = requested[axis];
    if (value === undefined) continue;
    if (clampAxis(axis, value) !== Math.round(value)) limited.push(axis);
  }
  return limited;
}

export function toView(ptz: PtzRaw): PtzView {
  return {
    ...ptz,
    panDeg: round2(ptz.pan / 100),
    tiltDeg: round2(ptz.tilt / 100),
  };
}

/** 방향 이동(nudge)의 목표 좌표를 낸다. step 은 축의 raw 단위다. */
export function nudge(current: PtzRaw, axis: Axis, delta: number): PtzRaw {
  return clampPtz({ ...current, [axis]: current[axis] + delta });
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
