import type { PtzRaw } from '../domain/ptz.js';

/** 주차면 1건. 출처(시뮬레이터/로컬)에 따라 채워지는 필드가 다르다. */
export interface Slot {
  id: string;
  label: string;
  occupied?: boolean;
  carId?: string | null;
}

/** 장비가 광고한 프리셋 슬롯의 안전한 조회 범위. 실제 등록 목록이나 이름은 포함하지 않는다. */
export interface DevicePresetCapability {
  supported: boolean;
  /** `Yes`는 지원만 광고하므로 최대치는 알 수 없다. */
  advertisedMaxPresetNumber: number | null;
  usableMaxPresetNumber: number;
  listing: 'unsupported';
  naming: 'unsupported';
  slots: DevicePresetSlot[];
}

/** 장비 목록 계약이 없으므로 슬롯의 등록 여부와 이름은 알 수 없다. */
export interface DevicePresetSlot {
  index: number;
  registration: 'unknown';
  name: null;
}

/** Hucoms firmware 기준 논리 프레임(1920×1080)에서 화면 중앙으로 가져올 점이다. */
export interface CenterPoint {
  x: number;
  y: number;
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
  /** 없는 드라이버는 픽셀 센터링을 지원하지 않는다. */
  centerPoint?(point: CenterPoint): Promise<void>;
  /**
   * 이 기기가 **실제로 도달하는** 줌 눈금. 계약 범위(`ZOOM_RANGE` 0~65535)는 Hucoms 것이라
   * 모든 기기에 참이 아니다 — 선언하는 기기만 갖는다.
   *
   * 지어내지 않는 이유가 아니라 **물을 수 있게 하려는** 값이다. 실측 화각표가 이 범위를
   * 덮는지 검사할 수 있어야 소프트웨어 센터링이 표 밖 줌에서 조용히 오조준하지 않는다
   * (상류 실측: 1점짜리 x1 표 + x12 줌 = **12배 과회전**).
   */
  readonly zoomRange?: { min: number; max: number };
  getSnapshot(): Promise<Buffer>;
  /** 주차면 목록. 지원하지 않는 기기는 빈 배열을 돌려준다(오류가 아니다). */
  listSlots(): Promise<Slot[]>;
}

export class CameraDriverError extends Error {
  constructor(message: string, readonly statusCode = 502, options?: { cause?: unknown }) {
    super(message, options);
  }
}
