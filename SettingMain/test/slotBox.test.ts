import { describe, expect, it } from 'vitest';
import { buildSlotBox, SlotBoxError, type Point3 } from '../src/domain/slotBox.js';

/**
 * 순수 기하다 — 외부 호출이 없으므로 모킹도 없다.
 * 여기서 지키는 것은 셋: 압출이 +Z 로만 일어날 것, 정점 순서가 계약대로일 것,
 * 쓸 수 없는 입력을 조용히 보정하지 않을 것.
 */

const FLOOR: Point3[] = [
  { x: 0, y: 0, z: 0 },
  { x: 2.5, y: 0, z: 0 },
  { x: 2.5, y: 5, z: 0 },
  { x: 0, y: 5, z: 0 },
];

describe('buildSlotBox', () => {
  it('바닥을 +Z 로만 밀어 올린다 — x·y 는 그대로다', () => {
    const box = buildSlotBox(FLOOR, 1.6);
    expect(box.ceiling).toEqual([
      { x: 0, y: 0, z: 1.6 },
      { x: 2.5, y: 0, z: 1.6 },
      { x: 2.5, y: 5, z: 1.6 },
      { x: 0, y: 5, z: 1.6 },
    ]);
    expect(box.height).toBe(1.6);
  });

  it('바닥이 z=0 이 아니어도 그 높이에서 올라간다', () => {
    const raised = FLOOR.map((p) => ({ ...p, z: 12 }));
    expect(buildSlotBox(raised, 2).ceiling.map((p) => p.z)).toEqual([14, 14, 14, 14]);
  });

  it('정점은 바닥 4점 → 천장 4점 순서의 8개다', () => {
    const box = buildSlotBox(FLOOR, 1);
    expect(box.vertices).toHaveLength(8);
    expect(box.vertices.slice(0, 4)).toEqual(box.floor);
    expect(box.vertices.slice(4)).toEqual(box.ceiling);
  });

  it('입력 배열을 건드리지 않는다 — 호출자의 원본이 조용히 바뀌면 추적할 수 없다', () => {
    const input = FLOOR.map((p) => ({ ...p }));
    const box = buildSlotBox(input, 3);
    expect(input).toEqual(FLOOR);
    expect(box.floor[0]).not.toBe(input[0]);
  });

  it('점이 4개가 아니면 거절한다 — 개수를 맞춰 주지 않는다', () => {
    expect(() => buildSlotBox(FLOOR.slice(0, 3), 1)).toThrow(SlotBoxError);
    expect(() => buildSlotBox([...FLOOR, { x: 1, y: 1, z: 0 }], 1)).toThrow(/4점/);
  });

  it('좌표에 유한하지 않은 값이 있으면 거절한다 — 어느 점의 어느 축인지 말한다', () => {
    const broken = FLOOR.map((p) => ({ ...p }));
    broken[2]!.y = Number.NaN;
    expect(() => buildSlotBox(broken, 1)).toThrow(/2번 점의 y/);
  });

  it('높이가 0·음수·NaN 이면 거절한다 — 부피 없는 육면체는 육면체가 아니다', () => {
    for (const height of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildSlotBox(FLOOR, height)).toThrow(SlotBoxError);
    }
  });

  it('거절은 400 이다 — 라우트에 붙을 때 500 으로 새지 않는다', () => {
    expect(() => buildSlotBox(FLOOR, 0)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});
