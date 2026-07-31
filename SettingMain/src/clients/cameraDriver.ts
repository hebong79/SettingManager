import type { PtzRaw } from '../domain/ptz.js';

/** 주차면 1건. 출처(시뮬레이터/로컬)에 따라 채워지는 필드가 다르다. */
export interface Slot {
  id: string;
  label: string;
  occupied?: boolean;
  carId?: string | null;
}

/**
 * 카메라 계약 표면. 종류(hucoms · backend-core)가 달라도 상위 계층은 이것만 안다.
 * 못 하는 기능은 지어내지 않고 던진다 — 조용한 성공이 가장 추적하기 어려운 실패다.
 */
export interface CameraDriver {
  readonly cameraId: string;
  readonly kind: string;
  getPtz(): Promise<PtzRaw>;
  goPtz(target: PtzRaw, speed?: number): Promise<void>;
  getSnapshot(): Promise<Buffer>;
  /** 주차면 목록. 지원하지 않는 기기는 빈 배열을 돌려준다(오류가 아니다). */
  listSlots(): Promise<Slot[]>;
}

export class CameraDriverError extends Error {
  constructor(message: string, readonly statusCode = 502, options?: { cause?: unknown }) {
    super(message, options);
  }
}
