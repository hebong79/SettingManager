/**
 * 탐색 프리셋·점의 **backend-core 파일 형식 정의**.
 *
 * 근거: baro_calory `apps/backend-core/src/discovery-store.mjs`.
 * 형식을 그대로 따르는 이유는 두 구현 사이에서 **파일을 옮겨 쓸 수 있어야** 하기 때문이다 —
 * backend-core 로 커미셔닝한 현장을 브리지로 이어받거나 그 반대로 하는 일이 실제로 일어난다.
 * 우리 취향으로 스키마를 다시 짜면 그 순간 두 저장소가 서로 못 읽는다.
 *
 * 카메라 하나당 파일 하나다(`config/discovery-<cameraId>.json`). 상류가 카메라별 스토어를
 * 쓰는 것과 같은 이유 — 프리셋의 PTZ 는 그 카메라의 좌표라 다른 카메라에서 의미가 없다.
 *
 * 상류에 있으나 여기 **없는 것**: `slug`(상류의 작업 폴더 이름 — 이 저장소에는 그 폴더가 없다),
 * `detector`/`judge` 기본값(상류가 "OAJM 실행의 잔재"라고 적어 둔 필드다).
 * 읽을 때는 있으면 그대로 보존하고, 새로 만들 때 지어내지 않는다.
 */

const PAN_WRAP = 36000;
const TILT = { min: -2000, max: 9000 };
const ZOOM = { min: 0, max: 65535 };
const FRAME = { width: 1920, height: 1080 };

/** 상류 형식의 PTZ. 계약 좌표(`PtzRaw`)와 **필드명이 다르다** — 파일 호환이 우선이다. */
export interface StoredPtz {
  panpos: number;
  tiltpos: number;
  zoompos: number;
  focuspos: number;
}

export interface DiscoveryPointRecord {
  id: string;
  name: string;
  x: number;
  y: number;
  createdAt: string;
  [extra: string]: unknown;
}

export interface DiscoveryPresetRecord {
  id: string;
  name: string;
  ptz: StoredPtz;
  createdAt: string;
  updatedAt: string;
  points?: DiscoveryPointRecord[];
  nextPointId?: number;
  [extra: string]: unknown;
}

export interface DiscoveryFile {
  schemaVersion: number;
  cameraId: string;
  nextPresetId: number;
  presets: DiscoveryPresetRecord[];
  [extra: string]: unknown;
}

/** 상류 `normPtz` 와 같은 규칙 — 팬은 감고, 틸트·줌은 자른다. */
export function normPtz(raw: unknown): StoredPtz {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    panpos: (((Math.round(Number(p.panpos) || 0) % PAN_WRAP) + PAN_WRAP) % PAN_WRAP),
    tiltpos: clamp(Number(p.tiltpos) || 0, TILT.min, TILT.max),
    zoompos: clamp(Number(p.zoompos) || 0, ZOOM.min, ZOOM.max),
    focuspos: Math.round(Number(p.focuspos) || 0),
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Math.round(value)));
}

function clampPx(value: unknown, max: number): number {
  return Math.max(0, Math.min(max, Math.round(Number(value) || 0)));
}
