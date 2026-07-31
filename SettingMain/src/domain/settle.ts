import { PAN_RANGE, type PtzRaw } from './ptz.js';

/**
 * 정착(settle) 판정. 외부 I/O 없는 순수 계층.
 *
 * 카메라는 "이동 완료" 신호를 주지 않는다. 명령 직후 좌표를 읽으면 **이동 중간값**이 잡히고,
 * 그 값을 기준으로 다음 상대 이동을 계산하면 움직임이 계속 모자란다
 * (실측: UE 시뮬에서 pan 1296 → 목표 1496 인데 직후 읽기는 1446).
 * 그래서 연속 두 번 읽은 값이 허용오차 안일 때만 멈춘 것으로 본다.
 */

export interface SettleTolerance {
  /** pan·tilt 허용오차(0.01° 단위). 기본 10 = 0.1° */
  angleCd: number;
  /** zoom 허용오차(raw 눈금). */
  zoomRaw: number;
}

export const DEFAULT_TOLERANCE: SettleTolerance = { angleCd: 10, zoomRaw: 10 };

/**
 * 팬 각도 차이. 0/36000 심을 넘는 이동이 "거대한 차이"로 보이지 않게 순환 거리로 잰다.
 * 이게 없으면 심 근처에서 정착 판정이 영원히 안 난다.
 */
export function panDistance(a: number, b: number): number {
  const span = PAN_RANGE[1] + 1;
  const raw = Math.abs(a - b) % span;
  return Math.min(raw, span - raw);
}

/** 두 좌표가 "같은 자리"인가. */
export function isSameSpot(a: PtzRaw, b: PtzRaw, tolerance: SettleTolerance = DEFAULT_TOLERANCE): boolean {
  return (
    panDistance(a.pan, b.pan) <= tolerance.angleCd &&
    Math.abs(a.tilt - b.tilt) <= tolerance.angleCd &&
    Math.abs(a.zoom - b.zoom) <= tolerance.zoomRaw
  );
}
