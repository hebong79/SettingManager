import { describe, expect, it } from 'vitest';
import { hfovAt, zoomPosForHfov } from '../src/core/bridge/zoomTable.js';
import type { CameraIntrinsics } from '../src/config/types.js';

/**
 * 화각 → 줌 눈금 **역보간**. 정방향은 벤더링한 `@baro/profile` 이 하고, 역방향은 이 파일이 세운다
 * (상류에는 없다 — 상류는 줌을 정하고 화각을 읽기만 하면 됐다).
 *
 * 표는 상류의 실측 cam-001 곡선에서 앵커 몇 개를 뽑은 것이다.
 * 근거: baro_calory `packages/profile/src/camera-intrinsics.mjs` ZOOM_HFOV_TABLE.
 */
const TABLE: CameraIntrinsics = {
  zoomHfov: [
    { z: 0, h: 57.14 },
    { z: 2000, h: 47.89 },
    { z: 8000, h: 22.59 },
    { z: 16384, h: 2.39 },
  ],
};

describe('zoomPosForHfov', () => {
  it('앵커 화각은 그 앵커의 줌 눈금을 돌려준다', () => {
    expect(zoomPosForHfov(TABLE, 57.14)).toBe(0);
    expect(zoomPosForHfov(TABLE, 47.89)).toBe(2000);
    expect(zoomPosForHfov(TABLE, 22.59)).toBe(8000);
    expect(zoomPosForHfov(TABLE, 2.39)).toBe(16384);
  });

  it('앵커 사이는 선형 역보간이다 — 정방향과 왕복이 맞는다', () => {
    for (const z of [500, 1000, 3500, 7000, 12000, 15000]) {
      const hfov = hfovAt(TABLE, z);
      // 왕복 오차는 반올림 1눈금 이내여야 한다. 그보다 크면 두 방향이 다른 곡선을 보고 있다.
      expect(Math.abs(zoomPosForHfov(TABLE, hfov) - z)).toBeLessThanOrEqual(1);
    }
  });

  it('표보다 넓은 화각을 요구하면 최광각 눈금에서 멈춘다 — 외삽하지 않는다', () => {
    expect(zoomPosForHfov(TABLE, 120)).toBe(0);
  });

  it('표보다 좁은 화각을 요구하면 최망원 눈금에서 멈춘다 — 렌즈가 포화한다', () => {
    expect(zoomPosForHfov(TABLE, 0.1)).toBe(16384);
  });

  it('화각이 좁아질수록 줌 눈금은 커진다 — 단조성이 깨지면 박스 줌이 반대로 간다', () => {
    const zs = [50, 40, 30, 20, 10, 5].map((h) => zoomPosForHfov(TABLE, h));
    expect(zs).toEqual([...zs].sort((a, b) => a - b));
  });

  it('평평한 구간에서는 덜 줌인한 쪽을 고른다 — 지나치게 당기지 않는다', () => {
    const flat: CameraIntrinsics = { zoomHfov: [{ z: 0, h: 10 }, { z: 100, h: 10 }, { z: 200, h: 5 }] };
    expect(zoomPosForHfov(flat, 10)).toBe(0);
  });
});
