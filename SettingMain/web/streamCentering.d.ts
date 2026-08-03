export interface StreamRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface StreamPointerInput {
  button: number;
  clientX: number;
  clientY: number;
  viewport: StreamRect;
  image: StreamRect;
  naturalWidth: number;
  naturalHeight: number;
}

export interface StreamPoint {
  x: number;
  y: number;
  left: number;
  top: number;
}

export function streamPointFromPointer(input: StreamPointerInput): StreamPoint | null;
