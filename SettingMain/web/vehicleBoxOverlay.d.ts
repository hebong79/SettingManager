/**
 * `vehicleBoxOverlay.js` 의 계약 — **이 파일만 타입이고 구현은 옆의 JS 다.**
 *
 * 화면 코드는 브라우저가 그대로 실행하므로 JS 로 둔다(빌드 단계를 화면에 들이지 않는다).
 * 그래도 순수 기하는 테스트가 있어야 하고, 테스트는 TypeScript 다 — 그 사이를 잇는 자리다.
 * `streamCentering.d.ts` 와 같은 관례다.
 */

export interface Box {
  width: number;
  height: number;
}

export interface ContentBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** `object-fit: contain` 의 실제 내용 영역. 아직 로드되지 않았으면 `null`. */
export function contentBox(box: Box, naturalWidth: number, naturalHeight: number): ContentBox | null;

/** 논리 프레임(1920×1080) 좌표 → 캔버스 좌표. */
export function toCanvas(point: [number, number] | number[], content: ContentBox): Point;

/**
 * 검출 하나의 `segments` → 캔버스 선분들.
 * **개수를 가정하지 않고**, 4원소가 아니거나 숫자가 아닌 항목만 버린다.
 */
export function segmentsToCanvas(
  detection: { segments?: unknown } | null | undefined,
  content: ContentBox,
): Array<{ from: Point; to: Point }>;

export function drawSegments(canvas: HTMLCanvasElement, image: HTMLImageElement, detections?: unknown[]): void;
