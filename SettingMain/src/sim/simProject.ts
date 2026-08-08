import type { Vec3 } from './simCoords.js';

/**
 * 시뮬레이터 카메라의 **월드 ↔ 화면** 변환.
 *
 * ## 상수 하나가 전부다 — 그리고 그것은 실측했다 (2026-08-08)
 *
 * 줌 1배의 가로 화각 `WIDE_HFOV_DEG` 만 알면 나머지는 해석적으로 따라온다.
 * 언리얼에 화각을 **읽는** RPC 는 없지만(`cam.setFOV` 는 쓰기 전용), 쓰기와 읽기를
 * 엮으면 역산된다 — `cam.setFOV(F)` 를 넣고 `cam.getPTZ` 로 줌을 읽으면
 * `zoom = tan(H₁/2) / tan(F/2)` 이므로 `H₁ = 2·atan(zoom·tan(F/2))` 다.
 *
 * ```
 *  넣은 FOV  →  읽은 zoom  →  역산 H₁
 *    45.0°       1.29720       56.500°
 *    30.0°       2.00530       56.500°
 *    20.0°       3.04729       56.500°
 * ```
 *
 * 세 점이 소수점까지 같다. (80°·60° 는 zoom 이 1 로 걸려 무효다 — 그보다 넓어질 수 없다.)
 *
 * 이 값이 **정말 렌더되는 화각인지**는 설정값이 아니라 영상으로 확인했다. 같은 장면을
 * tilt 만 2° 옮겨 두 장 찍고 세로 이동량을 재면 세로 화각이 나온다:
 *
 * ```
 *  zoom 2.4 : 100px / 720  →  VFOV 14.33°   (이 식 14.36°)
 *  zoom 6.0 : 250px / 720  →  VFOV  5.76°   (이 식  5.77°)
 * ```
 *
 * 덤으로 `cam.setFOV` 의 fov 가 **가로**임도 이걸로 정해졌다 — 세로였다면 zoom 2.4 에서
 * 25.2° 가 나왔어야 한다.
 *
 * ## pan 은 곧 월드 방위각이다 — `measure.angles` 와 기준이 다르다
 *
 * `pan = atan2(dy, dx)` 그대로다(도). 줌 10배(화각 6.2°)에서 계산한 pan·tilt 로 조준했을 때
 * 목표 차량이 화면 중앙에 들어오는 것으로 확인했다.
 *
 * **`measure.angles` 를 그대로 pan 에 넣으면 안 된다.** 그쪽은 카메라 설치 기준(1번
 * 카메라의 경우 20.54°)에서 잰 값이라 `pan` 과 20.54° 어긋난다. 두 값이 "그럴듯하게"
 * 비슷해서 한 대만 놓고 보면 맞는 것처럼 보인다 — 실제로 처음에 그렇게 속았다.
 *
 * ## tilt 는 양수가 하향
 *
 * 카메라 제어 화면과 같은 규약이다. 화면 위쪽이 `up` 양수다.
 *
 * ## 왜 서버에 두는가
 *
 * `simCoords` 와 같은 이유다. 이 식을 화면에도 한 벌 두면 언젠가 한쪽만 고쳐지고,
 * 그 실패는 오류로 뜨지 않는다 — 좌표가 조용히 어긋날 뿐이다.
 */

/** 줌 1배의 가로 화각(도). 실측값 — 추측이 아니다. */
export const WIDE_HFOV_DEG = 56.5;

export interface CameraPose {
  /** RPC 좌표(언리얼 Z-up)의 카메라 위치. */
  pos: Vec3;
  /** 월드 방위각(도). */
  pan: number;
  /** 부각(도) — 양수가 하향. */
  tilt: number;
  /** 배율(1 이상). */
  zoom: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** 화면 절반에 해당하는 tan 값. 세로는 가로에서 화면비로 따라온다. */
export function halfExtent(zoom: number, viewport: Viewport): { tanH: number; tanV: number } {
  // 줌이 0 이나 음수로 오면 배율 1 로 본다 — 0 으로 나누어 무한대 화각을 만드는 것보다 낫다.
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const tanH = Math.tan(rad(WIDE_HFOV_DEG) / 2) / scale;
  return { tanH, tanV: (tanH * viewport.height) / viewport.width };
}

/**
 * 월드 점 → 화면 픽셀. **카메라 뒤쪽이면 `null`** 이다 — 뒤에 있는 점을 억지로
 * 투영하면 화면 반대편에 그럴듯한 좌표가 찍힌다.
 */
export function projectToScreen(pose: CameraPose, viewport: Viewport, point: Vec3): ScreenPoint | null {
  const yaw = rad(pose.pan);
  const tilt = rad(pose.tilt);
  const dx = point.x - pose.pos.x;
  const dy = point.y - pose.pos.y;
  const dz = point.z - pose.pos.z;

  const e1 = dx * Math.cos(yaw) + dy * Math.sin(yaw);
  const e2 = -dx * Math.sin(yaw) + dy * Math.cos(yaw);

  const forward = e1 * Math.cos(tilt) - dz * Math.sin(tilt);
  if (forward <= 1e-6) return null;
  const up = e1 * Math.sin(tilt) + dz * Math.cos(tilt);
  const right = -e2;

  const { tanH, tanV } = halfExtent(pose.zoom, viewport);
  return {
    x: ((right / forward / tanH + 1) / 2) * viewport.width,
    y: ((1 - up / forward / tanV) / 2) * viewport.height,
  };
}

/**
 * 화면 픽셀 → **지면(`groundZ` 높이의 수평면) 위의 월드 점**.
 *
 * 클릭 하나는 광선 하나일 뿐이라 평면을 하나 정해야 답이 나온다. 지면 위쪽을 찍었거나
 * (광선이 평면을 향하지 않음) 카메라가 이미 그 평면 아래에 있으면 **`null`** 이다 —
 * 이때 억지로 값을 내면 카메라 뒤편 지면에 차를 놓게 된다.
 */
export function screenToGround(
  pose: CameraPose,
  viewport: Viewport,
  screen: ScreenPoint,
  groundZ = 0,
): Vec3 | null {
  const { tanH, tanV } = halfExtent(pose.zoom, viewport);
  const right = ((2 * screen.x) / viewport.width - 1) * tanH;
  const up = (1 - (2 * screen.y) / viewport.height) * tanV;

  const yaw = rad(pose.pan);
  const tilt = rad(pose.tilt);
  // projectToScreen 의 회전을 그대로 되돌린다.
  const e1 = Math.cos(tilt) + up * Math.sin(tilt);
  const dz = -Math.sin(tilt) + up * Math.cos(tilt);
  const e2 = -right;

  const dx = e1 * Math.cos(yaw) - e2 * Math.sin(yaw);
  const dy = e1 * Math.sin(yaw) + e2 * Math.cos(yaw);

  const drop = groundZ - pose.pos.z;
  if (dz >= -1e-9 || drop >= 0) return null;
  const t = drop / dz;
  if (!Number.isFinite(t) || t <= 0) return null;
  return { x: pose.pos.x + dx * t, y: pose.pos.y + dy * t, z: groundZ };
}

// --- 메인 뷰(자유 시점) 이동 ------------------------------------------------
//
// 위쪽은 PTZ 카메라의 월드↔화면이고, 여기는 **메인 뷰를 WASD 로 옮기는 것**이다.
// 다른 일이지만 같은 자리에 둔다 — 화면(브라우저)이 카메라 규약을 한 벌 더 갖는 것을
// 막는 것이 이 파일의 존재 이유이고, 방향 벡터도 그 규약의 일부다.
//
// ⚠ 메인 뷰는 `cam.*` 와 **부호 규약이 다르다**: `view` 의 pitch 는 **양수가 위**이고
//   `cam` 의 tilt 는 양수가 하향이다. 그 차이가 이 함수 안에 갇혀 있어야 한다.

/** 메인 뷰가 갈 수 있는 방향. `forward` 는 보는 쪽, `right` 는 오른쪽이다. */
export type ViewAxis = 'forward' | 'right';

/**
 * 메인 뷰를 제 시선 기준으로 `distance` 미터만큼 옮긴 자리.
 *
 * 언리얼 규약(X 앞 · Y 오른쪽 · Z 위, roll = 0):
 * ```
 *   forward = (cos p · cos y,  cos p · sin y,  sin p)   ← pitch 를 포함한다
 *   right   = (−sin y,         cos y,          0    )   ← 항상 수평이다
 * ```
 *
 * 그래서 **앞뒤는 보는 방향으로** 가고(내려다보고 있으면 내려간다 — 언리얼 뷰포트와 같다),
 * **좌우는 높이를 지키며** 간다. 지면을 뚫고 내려가도 반대로 누르면 되돌아오므로,
 * 위아래 전용 키가 없어도 갇히지 않는다.
 */
export function moveAlongView(
  pos: Vec3,
  rot: { pitch: number; yaw: number },
  axis: ViewAxis,
  distance: number,
): Vec3 {
  const yaw = (rot.yaw * Math.PI) / 180;
  const pitch = (rot.pitch * Math.PI) / 180;
  const unit = axis === 'forward'
    ? [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)]
    : [-Math.sin(yaw), Math.cos(yaw), 0];
  return {
    x: pos.x + unit[0]! * distance,
    y: pos.y + unit[1]! * distance,
    z: pos.z + unit[2]! * distance,
  };
}

/** `view.get` 응답에서 위치·회전을 뽑는다. 숫자가 아닌 자리는 받아들이지 않는다. */
export function viewPoseFrom(raw: unknown): { pos: Vec3; rot: { pitch: number; yaw: number } } | null {
  const source = (raw ?? {}) as Record<string, unknown>;
  const pos = (source.pos ?? {}) as Record<string, unknown>;
  const rot = (source.rot ?? {}) as Record<string, unknown>;
  const nums = [pos.x, pos.y, pos.z, rot.pitch, rot.yaw].map(Number);
  if (nums.some((value) => !Number.isFinite(value))) return null;
  return { pos: { x: nums[0]!, y: nums[1]!, z: nums[2]! }, rot: { pitch: nums[3]!, yaw: nums[4]! } };
}

/** `cam.get` 응답에서 자세를 뽑는다. 숫자가 아닌 자리는 받아들이지 않는다. */
export function poseFrom(raw: unknown): CameraPose | null {
  const source = (raw ?? {}) as Record<string, unknown>;
  const pos = (source.pos ?? {}) as Record<string, unknown>;
  const nums = [pos.x, pos.y, pos.z, source.pan, source.tilt, source.zoom].map(Number);
  if (nums.some((value) => !Number.isFinite(value))) return null;
  return {
    pos: { x: nums[0]!, y: nums[1]!, z: nums[2]! },
    pan: nums[3]!,
    tilt: nums[4]!,
    zoom: nums[5]!,
  };
}
