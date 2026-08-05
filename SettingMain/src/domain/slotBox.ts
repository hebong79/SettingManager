/**
 * 주차면 3D 육면체화 — 구성도(`docs/my_think/my_setting_manager_구성.md`)의 독립 항목.
 *
 * **SettingManager 가 자체 계산한다**(backend-core 에 묻지 않는다). 다만 이 모듈이 책임지는 것은
 * 딱 한 가지, **월드 좌표 바닥 사각형을 위로 밀어 올리는 것**이다.
 *
 * 여기 없는 것 — 픽셀 → 월드 변환. 그것은 카메라 캘리브레이션의 산출물이 있어야 가능하고
 * 아직 그 산출물이 없다. 없는 값을 지어내 좌표를 만들면 화면에는 그럴듯한 육면체가 그려지지만
 * 실제 주차면과는 아무 관계가 없는 도형이 된다. **입력이 생길 때까지 그 단계는 만들지 않는다.**
 *
 * 외부 I/O 없음 — 순수 함수다.
 */

/** 월드 좌표 한 점. 단위는 미터, **+Z 가 위**다(언리얼 좌표계와 같은 축 방향). */
export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** 주차면 바닥 사각형. 네 점의 **차례가 곧 변**이다 — 0-1, 1-2, 2-3, 3-0. */
export type SlotFloor = readonly [Point3, Point3, Point3, Point3];

export interface SlotBox {
  floor: SlotFloor;
  /** 바닥을 `height` 만큼 +Z 로 올린 사각형. 차례는 바닥과 같다. */
  ceiling: SlotFloor;
  /** 미터. */
  height: number;
  /** 바닥 4점 → 천장 4점 순서의 8정점. 렌더러가 그대로 쓸 수 있게 평평하게 편 형태다. */
  vertices: Point3[];
}

export class SlotBoxError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'SlotBoxError';
  }
}

/**
 * 바닥 사각형을 `height` 미터만큼 압출해 육면체를 만든다.
 *
 * 바닥이 평면인지·볼록인지는 검사하지 않는다. 압출 결과는 어차피 바닥을 그대로 옮긴 것이라
 * 바닥이 어그러져 있으면 육면체도 같은 만큼 어그러진다 — 그 왜곡은 **입력의 문제**이고,
 * 여기서 조용히 보정하면 어디서 틀어졌는지 추적할 수 없게 된다.
 */
export function buildSlotBox(floor: readonly Point3[], height: number): SlotBox {
  if (floor.length !== 4) {
    throw new SlotBoxError(`주차면 바닥은 정확히 4점이어야 합니다 (받은 점: ${floor.length}개)`);
  }
  floor.forEach((point, index) => {
    for (const axis of ['x', 'y', 'z'] as const) {
      if (!Number.isFinite(point?.[axis])) {
        throw new SlotBoxError(`바닥 ${index}번 점의 ${axis} 가 유한한 숫자가 아닙니다`);
      }
    }
  });
  if (!Number.isFinite(height) || height <= 0) {
    throw new SlotBoxError(`육면체 높이는 0보다 큰 숫자여야 합니다 (받은 값: ${height})`);
  }

  const base = floor.map((p) => ({ x: p.x, y: p.y, z: p.z })) as unknown as SlotFloor;
  const ceiling = base.map((p) => ({ x: p.x, y: p.y, z: p.z + height })) as unknown as SlotFloor;
  return { floor: base, ceiling, height, vertices: [...base, ...ceiling] };
}
