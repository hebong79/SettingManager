import type { Detection, Point2 } from '../detectors/detectorTypes.js';

/**
 * 번호판 호밍의 **표적 고정** 판정. 전부 순수 함수다 — 카메라도 네트워크도 모른다.
 *
 * 근거: baro_calory `apps/backend-core/src/plate-target-tracker.mjs`.
 *
 * ## 이 파일이 존재하는 이유 하나: 옆차로 옮겨타지 않기
 *
 * 줌인을 하다 보면 화면 중앙에 번호판이 여러 개 들어온다. "가장 가까운 판"을 고르면
 * **옆차의 판이 더 선명할 때 그쪽으로 옮겨탄다.** 그러면 잡은 성공했다고 말하면서
 * 엉뚱한 주차면의 조준을 저장한다 — 그것이 이 기능이 낼 수 있는 최악의 결과다.
 *
 * 막는 방법이 두 단계다.
 *
 * 1. **잠그기 전**: 광축이 실제로 관통하는 차량을 세그멘테이션 마스크로 고정하고,
 *    그 실루엣 **안쪽** 판만 후보로 본다. 후보가 정확히 하나일 때만 잠근다.
 * 2. **잠근 뒤**: 고줌에서 차량 마스크는 화면 밖으로 잘려 깨지므로 더 이상 믿지 않는다.
 *    대신 직전 판과의 크기·종횡비·중심거리·IoU 로 **같은 판인지**만 재확인한다.
 *    하나라도 더 맞으면 `ambiguous` 로 fail-closed 한다.
 *
 * 과거의 `centerRadius` 고정 탐색반경 게이트는 상류에서 제거됐다 — 고줌에서 판이 반경 밖으로
 * 밀리면 **정답을 걸러내는** 역효과였다. 여기서는 중심거리를 게이트 중 하나로만 쓴다.
 */

/** 논리 프레임 — 센터링·조준이 쓰는 좌표계다(Hucoms 규약). */
export const FRAME = { width: 1920, height: 1080 } as const;

export interface FrameSize {
  width: number;
  height: number;
}

/** 논리 프레임으로 옮겨진 번호판 1건. `cx·cy·w·h` 는 매번 다시 재지 않도록 여기서 굳힌다. */
export interface PlateBox {
  bbox: [number, number, number, number];
  cx: number;
  cy: number;
  w: number;
  h: number;
  confidence: number;
}

/** 차량 실루엣 윤곽(논리 프레임 좌표). 3점 미만은 만들지 않는다 — 안쪽을 물을 수 없다. */
export type VehicleMask = Point2[];

export interface PlateTrack {
  bbox: [number, number, number, number];
  zoom: number;
}

export type MaskMatch =
  | { kind: 'matched'; mask: VehicleMask; masks: VehicleMask[]; count: 1 }
  | { kind: 'ambiguous'; mask: null; masks: VehicleMask[]; count: number }
  | { kind: 'missing'; mask: null; masks: []; count: 0 };

export type TrackMatch =
  | { kind: 'matched'; plate: PlateBox; nextTrack: PlateTrack }
  | { kind: 'lost'; plate: null; nextTrack: PlateTrack }
  | { kind: 'ambiguous'; plate: null; nextTrack: PlateTrack };

// --- 좌표 정규화 ---------------------------------------------------------------

/**
 * 검출기는 **스냅샷 원본 해상도**로 답하고, 조준은 **논리 프레임**(1920×1080)에서 한다.
 * 두 좌표계를 섞으면 4K 스냅샷에서 조준이 정확히 절반만큼 빗나간다.
 */
function scaler(source: FrameSize, frame: FrameSize): { sx: number; sy: number } {
  assertPositive('sourceWidth', source.width);
  assertPositive('sourceHeight', source.height);
  assertPositive('frameWidth', frame.width);
  assertPositive('frameHeight', frame.height);
  return { sx: frame.width / source.width, sy: frame.height / source.height };
}

export function normalizePlates(detections: Detection[], source: FrameSize, frame: FrameSize = FRAME): PlateBox[] {
  const { sx, sy } = scaler(source, frame);
  const boxes: PlateBox[] = [];
  for (const detection of detections) {
    // LPD 는 회전 상자(4점)를 준다. 축정렬 상자로 감싸 쓴다 — 이후 판정(IoU·종횡비)이
    // 전부 축정렬 기준이고, 여기서 한 번만 변환해야 두 표현이 갈리지 않는다.
    const raw = detection.bbox ?? boundsOf(detection.polygon);
    if (!raw) continue;
    const bbox: [number, number, number, number] = [
      clamp(raw[0] * sx, 0, frame.width),
      clamp(raw[1] * sy, 0, frame.height),
      clamp(raw[2] * sx, 0, frame.width),
      clamp(raw[3] * sy, 0, frame.height),
    ];
    const w = bbox[2] - bbox[0];
    const h = bbox[3] - bbox[1];
    // 폭이나 높이가 0 이면 종횡비가 무한대가 되어 아래 게이트가 전부 무의미해진다.
    if (!(w > 0) || !(h > 0)) continue;
    boxes.push({ bbox, cx: (bbox[0] + bbox[2]) / 2, cy: (bbox[1] + bbox[3]) / 2, w, h, confidence: detection.confidence });
  }
  return boxes;
}

export function normalizeMasks(detections: Detection[], source: FrameSize, frame: FrameSize = FRAME): VehicleMask[] {
  const { sx, sy } = scaler(source, frame);
  const masks: VehicleMask[] = [];
  for (const detection of detections) {
    if (!detection.polygon || detection.polygon.length < 3) continue;
    const points = detection.polygon.map((point) => ({
      x: clamp(point.x * sx, 0, frame.width),
      y: clamp(point.y * sy, 0, frame.height),
    }));
    masks.push(points);
  }
  return masks;
}

/** 회전 상자를 감싸는 축정렬 상자. */
function boundsOf(polygon: Point2[] | undefined): [number, number, number, number] | null {
  if (!polygon || polygon.length < 3) return null;
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  if (![...xs, ...ys].every(Number.isFinite)) return null;
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// --- 차량 마스크 판정 ------------------------------------------------------------

/**
 * 이 점이 어느 차량 안에 있는가.
 *
 * **겹치면 `ambiguous` 다 — 하나를 고르지 않는다.** 주차장에서 차량은 서로 가려지고,
 * 겹친 두 마스크 중 하나를 임의로 고르면 그 순간 옆차를 표적으로 삼은 것이 된다.
 * "모르겠다"고 말하는 편이 틀린 조준을 저장하는 것보다 언제나 낫다.
 */
export function vehicleMaskAtPoint(masks: VehicleMask[], point: Point2): MaskMatch {
  const matches = masks.filter((mask) => pointInPolygon(point, mask));
  if (matches.length === 0) return { kind: 'missing', mask: null, masks: [], count: 0 };
  if (matches.length > 1) return { kind: 'ambiguous', mask: null, masks: matches, count: matches.length };
  return { kind: 'matched', mask: matches[0]!, masks: matches, count: 1 };
}

/** 이 차량 실루엣 **안쪽**에 중심이 있는 판만. 이것이 옆차 차단의 1단계다. */
export function platesInsideMask(plates: PlateBox[], mask: VehicleMask): PlateBox[] {
  return plates.filter((plate) => pointInPolygon({ x: plate.cx, y: plate.cy }, mask));
}

// --- 판 추적 -------------------------------------------------------------------

export function createPlateTrack(plate: PlateBox, zoom = 0): PlateTrack {
  if (!(plate.w > 0) || !(plate.h > 0)) throw new Error('추적을 시작하려면 폭·높이가 있는 번호판이 필요합니다');
  return { bbox: [...plate.bbox], zoom: Number.isFinite(zoom) ? zoom : 0 };
}

export interface MatchOptions {
  frame?: FrameSize;
  /** 중심에서 이만큼(px) 안쪽에 있는 판만 본다. 상한 64 는 상류 실측값이다. */
  centerRadius?: number;
  zoom?: number;
}

/**
 * 직전에 잠근 판이 이번 프레임의 어느 것인가.
 *
 * 게이트 넷을 **전부** 통과해야 후보다. 통과한 것이 정확히 하나일 때만 `matched` 다 —
 * 둘이면 `ambiguous` 로 멈춘다(fail-closed). 상류가 이 값들을 실측으로 정했다:
 *
 * | 게이트 | 범위 | 왜 |
 * |---|---|---|
 * | 중심거리 | ≤ 64px | 직전에 중앙으로 당겨 놨으므로 같은 판은 중앙 근처에 있다 |
 * | 폭 비율 | 0.65 ~ 2.25 | 한 스텝 줌인이 만드는 배율 한계. 밖이면 다른 판이다 |
 * | 종횡비 비율 | 0.65 ~ 1.55 | 번호판은 각도가 조금 변해도 비율이 크게 안 변한다 |
 * | IoU | ≥ 0.18 | 2.25배까지 커진 중앙 판의 IoU 가 1/2.25² = 0.198 이다. 검출 흔들림 여유만 남긴다 |
 */
export function matchPlateTrack(track: PlateTrack, plates: PlateBox[], options: MatchOptions = {}): TrackMatch {
  const frame = options.frame ?? FRAME;
  const previousW = track.bbox[2] - track.bbox[0];
  const previousH = track.bbox[3] - track.bbox[1];
  if (!(previousW > 0) || !(previousH > 0)) return { kind: 'lost', plate: null, nextTrack: track };
  const previousAspect = previousW / previousH;
  // 직전 판이 **중앙에 있다고 가정한** 상자. 재조준으로 중앙에 놓았으니 그것이 기대 위치다.
  const expected = centeredBox(previousW, previousH, frame);
  const maxDistance = Math.min(Math.max(options.centerRadius ?? 64, 1), 64);

  const matches = plates.filter((plate) => {
    const centerDistance = Math.hypot(plate.cx - frame.width / 2, plate.cy - frame.height / 2);
    const widthRatio = plate.w / previousW;
    const aspectRatio = (plate.w / plate.h) / previousAspect;
    return centerDistance <= maxDistance
      && widthRatio >= 0.65 && widthRatio <= 2.25
      && aspectRatio >= 0.65 && aspectRatio <= 1.55
      && iou(expected, plate.bbox) >= 0.18;
  });

  if (matches.length === 0) return { kind: 'lost', plate: null, nextTrack: track };
  if (matches.length > 1) return { kind: 'ambiguous', plate: null, nextTrack: track };
  const plate = matches[0]!;
  return { kind: 'matched', plate, nextTrack: createPlateTrack(plate, options.zoom ?? 0) };
}

// --- 기하 ----------------------------------------------------------------------

function centeredBox(width: number, height: number, frame: FrameSize): [number, number, number, number] {
  const cx = frame.width / 2;
  const cy = frame.height / 2;
  return [cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2];
}

function iou(a: readonly number[], b: readonly number[]): number {
  const left = Math.max(a[0]!, b[0]!);
  const top = Math.max(a[1]!, b[1]!);
  const right = Math.min(a[2]!, b[2]!);
  const bottom = Math.min(a[3]!, b[3]!);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  if (!intersection) return 0;
  const areaA = Math.max(0, a[2]! - a[0]!) * Math.max(0, a[3]! - a[1]!);
  const areaB = Math.max(0, b[2]! - b[0]!) * Math.max(0, b[3]! - b[1]!);
  return intersection / (areaA + areaB - intersection);
}

/**
 * 광선 교차 판정. **경계 위의 점은 안쪽으로 센다** — 판 중심이 실루엣 경계에 정확히
 * 걸리는 일이 실제로 있고, 그때 밖으로 밀면 자기 차를 못 찾는다.
 */
function pointInPolygon(point: Point2, polygon: VehicleMask): boolean {
  const { x, y } = point;
  if (!Number.isFinite(x) || !Number.isFinite(y) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (pointOnSegment(x, y, a, b)) return true;
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function pointOnSegment(px: number, py: number, a: Point2, b: Point2): boolean {
  const cross = (px - a.x) * (b.y - a.y) - (py - a.y) * (b.x - a.x);
  if (Math.abs(cross) > 1e-6) return false;
  return px >= Math.min(a.x, b.x) - 1e-6 && px <= Math.max(a.x, b.x) + 1e-6
    && py >= Math.min(a.y, b.y) - 1e-6 && py <= Math.max(a.y, b.y) + 1e-6;
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 는 양수여야 합니다 (받은 값: ${value})`);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
