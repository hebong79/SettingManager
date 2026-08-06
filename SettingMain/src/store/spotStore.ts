/**
 * 커미셔닝 주차면(스팟)의 **backend-core 파일 형식 정의**.
 *
 * 근거: baro_calory `apps/backend-core/src/spot-store.mjs`.
 *
 * `SlotStore`(이미 있는 `config/slots.json`)와 **다른 것**이다. 그쪽은 시뮬레이터·현장이 주는
 * 주차면 **목록**이고, 이쪽은 사람이 "이 픽셀을 이 자세로 찍는다"고 확정해 저장한 커미셔닝
 * 산출물이다. 같은 낱말을 쓰지만 출처도 수명도 다르므로 파일과 경로를 갈라 둔다.
 *
 * 상류가 원자적 쓰기를 하지 않는 부분(`spot-store.mjs` 의 `#save` 는 그냥 writeFile 이다)은
 * **여기서 임시파일+rename 으로 올린다.** 형식 호환은 파일 *내용*의 문제이고 쓰는 방식은
 * 아니라서, 이 강화는 호환을 깨지 않는다.
 */

export interface StoredSpot {
  id: string;
  name: string;
  markedPixel: { x: number; y: number };
  box: unknown | null;
  widePtz: unknown | null;
  closeupPtz: unknown;
  createdAt: string;
  [extra: string]: unknown;
}

export interface SpotFile {
  schemaVersion: number;
  cameraId: string;
  wideShot: { ptz: unknown; savedAt: string } | null;
  nextSpotId: number;
  spots: StoredSpot[];
  [extra: string]: unknown;
}

