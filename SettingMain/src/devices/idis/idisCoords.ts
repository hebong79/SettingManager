import type { CenterPoint, PtzRaw } from './contract.js';
import { CONTRACT_FRAME, POINT_SCALE, WIRE_RANGE } from './idisConstants.js';

/**
 * 계약 좌표 ↔ IDIS 와이어 좌표. 외부 I/O 없는 순수 계층.
 *
 * 계약은 Hucoms 논리 좌표다 — `pan` 0..35999(무부호), `tilt` −2000..9000(**+ 가 아래**,
 * 0=수평), `zoom` 0..65535(불투명 raw).
 *
 * ## 틸트가 이 파일에서 가장 위험한 축인 이유
 *
 * 매뉴얼은 **범위만 말하고 원점을 말하지 않는다.** 원점은 실측으로만 닫혔다
 * `[실측 DC-S6261XT 2026-07-29]`: `absTilt=0` 에서 카메라 자기 다리가 보이고(수직 아래),
 * `absTilt=9000` 에서 사무실 수평 전경이 나온다. Hucoms 는 **+ 가 아래**라 부호도 원점도
 * 반대다. 다행히 두 범위가 정확히 겹쳐 `9000 − x` 한 식(자기역함수)으로 왕복한다.
 *
 * 독립 교차검증 `[실측]`: `absZoom=100` 에서 5°씩 움직여 상호상관으로 화면 이동을 재면
 * tilt 37.6 px/°, pan 29.6 px/°. 그대로 보면 두 축 화각이 어긋나지만(28.7° vs 64.9°),
 * 위 규약대로 카메라가 수평에서 40° 내려가 있다면 팬의 화면 변위는 `cos40°=0.766` 배라
 * 38.6 px/° 가 되어 틸트와 3% 안에서 일치한다. **원점이 수평이었다면 이 일치가 나오지 않는다.**
 *
 * ## 줌은 눈금의 뜻이 다르다
 *
 * Hucoms `zoom` 은 불투명 raw 0..65535 이고 IDIS `absZoom` 은 **배율×100** 이다. 숫자 범위가
 * 계약 안에 들어가므로 항등 통과는 계약 위반이 아니지만, **"0 = 광각" 이 아니라 "100 = 광각"**
 * 이다. 이 차이를 무시하고 Hucoms 기본 화각 곡선을 폴백으로 들면 화각이 약 5배 틀린다
 * `[실측 사고]`. 그래서 이 드라이버는 `intrinsics` 를 **절대 지어내지 않는다.**
 */

const FULL_TURN = 36_000;

function round(value: number): number {
  return Math.round(Number(value));
}

function clamp(value: number, min: number, max: number): number {
  const n = round(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** 와이어 `absPan`(±18000) → 계약 `pan`(0..35999). 원이므로 감는다. */
export function panToContract(absPan: number): number {
  return ((round(absPan) % FULL_TURN) + FULL_TURN) % FULL_TURN;
}

/**
 * 계약 `pan`(0..35999) → 와이어 `absPan`(±18000).
 * **자르지 않고 감는다** — ±180° 는 원이라 −18000 과 +18000 이 같은 방향이다 `[실측]`.
 */
export function panToWire(pan: number): number {
  const folded = panToContract(pan);
  return folded > 18_000 ? folded - FULL_TURN : folded;
}

/** 와이어 `absTilt`(+ 위, 0=수직아래) → 계약 `tilt`(+ 아래, 0=수평). 자기역함수다. */
export function tiltToContract(absTilt: number): number {
  return 9_000 - round(absTilt);
}

/**
 * 계약 `tilt` → 와이어 `absTilt`. **뒤집은 뒤 실측 도달 범위 `[0, 9000]` 으로 자른다.**
 *
 * 자르지 않으면 계약이 허용하는 `tilt=−2000`(수평 위 20°)이 `absTilt=11000` 으로 나가고,
 * 기기는 `returnCode=0` 으로 답하면서 **오토플립으로 팬을 180° 돌려 버린다** `[실측]`.
 * 성공 응답을 받고 정반대를 보는 것보다, 수평에서 멈추는 편이 예측 가능하다.
 */
export function tiltToWire(tilt: number): number {
  const { min, max } = WIRE_RANGE.measured.tilt;
  return clamp(9_000 - round(tilt), min, max);
}

/** 와이어 `absZoom` → 계약 `zoom`. 항등(반올림만) — 눈금의 뜻이 다를 뿐 숫자는 그대로다. */
export function zoomToContract(absZoom: number): number {
  return round(absZoom);
}

/** 계약 `zoom` → 와이어 `absZoom`. 실측 도달 범위 `[100, 1200]` 으로 자른다 `[실측]`. */
export function zoomToWire(zoom: number): number {
  const { min, max } = WIRE_RANGE.measured.zoom;
  return clamp(zoom, min, max);
}

/** IDIS `ptzAbsolute&mode=1` 응답의 세 값 → 계약 `PtzRaw`. */
export function ptzToContract(wire: { absPan: number; absTilt: number; absZoom: number }): PtzRaw {
  return {
    pan: panToContract(wire.absPan),
    tilt: tiltToContract(wire.absTilt),
    zoom: zoomToContract(wire.absZoom),
  };
}

/** 계약 `PtzRaw` → `ptzAbsolute&mode=0` 로 보낼 세 값. **여기서 이미 잘려 있다.** */
export function ptzToWire(target: PtzRaw): { absPan: number; absTilt: number; absZoom: number } {
  return {
    absPan: panToWire(target.pan),
    absTilt: tiltToWire(target.tilt),
    absZoom: zoomToWire(target.zoom),
  };
}

/**
 * 계약 프레임(1920×1080 절대 픽셀) → §58 정규화 좌표(0~100000).
 * 프레임 범위 검사는 호출자(`IdisCameraClient.centerPoint`)가 먼저 한다.
 */
export function pointToWire(point: CenterPoint): { pointPan: number; pointTilt: number } {
  return {
    pointPan: Math.round((point.x / CONTRACT_FRAME.width) * POINT_SCALE),
    pointTilt: Math.round((point.y / CONTRACT_FRAME.height) * POINT_SCALE),
  };
}
