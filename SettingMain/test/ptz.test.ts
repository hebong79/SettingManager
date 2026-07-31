import { describe, expect, it } from 'vitest';
import { clampAxis, clampPtz, limitedAxes, nudge, toView, wrapPan } from '../src/domain/ptz.js';

/**
 * 계약 좌표 근거: baro_calory/docs/cameras.md §Hucoms — HTTP CGI
 *   panpos 0~35999 · tiltpos −2000~9000 (둘 다 0.01°) · zoompos 0~65535 불투명 raw
 */

describe('wrapPan — 팬은 원이라 자르지 않고 감는다', () => {
  it('범위 안 값은 그대로 둔다', () => {
    expect(wrapPan(0)).toBe(0);
    expect(wrapPan(18000)).toBe(18000);
    expect(wrapPan(35999)).toBe(35999);
  });

  it('상한을 넘으면 0 으로 돌아온다', () => {
    expect(wrapPan(36000)).toBe(0);
    expect(wrapPan(36500)).toBe(500);
  });

  it('음수도 양수로 재정규화한다 — JS 의 %는 피제수 부호를 따르므로 이 처리가 없으면 심을 넘는 이동이 깨진다', () => {
    expect(wrapPan(-1)).toBe(35999);
    expect(wrapPan(-36100)).toBe(35900);
  });
});

describe('clampAxis — 틸트·줌은 도달범위 밖이 존재하지 않으므로 자른다', () => {
  it('틸트 상하한', () => {
    expect(clampAxis('tilt', 12000)).toBe(9000);
    expect(clampAxis('tilt', -5000)).toBe(-2000);
    expect(clampAxis('tilt', 1188)).toBe(1188);
  });

  it('줌 상하한', () => {
    expect(clampAxis('zoom', 70000)).toBe(65535);
    expect(clampAxis('zoom', -10)).toBe(0);
  });

  it('소수는 반올림한다 — 와이어는 정수만 받는다', () => {
    expect(clampAxis('tilt', 100.6)).toBe(101);
  });
});

describe('limitedAxes — 잘린 축을 숨기지 않는다', () => {
  it('범위 안 목표는 아무 축도 보고하지 않는다', () => {
    expect(limitedAxes({ pan: 1000, tilt: 500, zoom: 8000 })).toEqual([]);
  });

  it('틸트와 줌이 각각 잘리면 그 축을 보고한다', () => {
    expect(limitedAxes({ tilt: 12000 })).toEqual(['tilt']);
    expect(limitedAxes({ zoom: 99999 })).toEqual(['zoom']);
    expect(limitedAxes({ tilt: -9999, zoom: 99999 })).toEqual(['tilt', 'zoom']);
  });

  it('팬은 감기므로 잘림으로 보고하지 않는다', () => {
    expect(limitedAxes({ pan: 40000 })).toEqual([]);
  });
});

describe('toView — pan·tilt 만 각도로 환산한다', () => {
  it('0.01° 단위를 도로 바꾼다', () => {
    const view = toView({ pan: 3844, tilt: 1188, zoom: 10711 });
    expect(view.panDeg).toBe(38.44);
    expect(view.tiltDeg).toBe(11.88);
  });

  it('줌은 raw 그대로 남는다 — 불투명 눈금이라 환산할 근거가 없다', () => {
    const view = toView({ pan: 0, tilt: 0, zoom: 10711 });
    expect(view.zoom).toBe(10711);
    expect(view).not.toHaveProperty('zoomDeg');
  });

  it('음수 틸트도 그대로 환산한다', () => {
    expect(toView({ pan: 0, tilt: -2000, zoom: 0 }).tiltDeg).toBe(-20);
  });
});

describe('nudge — 방향 이동 목표', () => {
  const current = { pan: 100, tilt: 8900, zoom: 65000 };

  it('축 하나만 움직인다', () => {
    expect(nudge(current, 'pan', 200)).toEqual({ pan: 300, tilt: 8900, zoom: 65000 });
  });

  it('한계를 넘는 이동은 한계에서 멈춘다', () => {
    expect(nudge(current, 'tilt', 500).tilt).toBe(9000);
    expect(nudge(current, 'zoom', 1000).zoom).toBe(65535);
  });

  it('팬은 0 을 넘어 감긴다', () => {
    expect(nudge(current, 'pan', -200).pan).toBe(35900);
  });
});

describe('clampPtz', () => {
  it('세 축을 한 번에 정규화한다', () => {
    expect(clampPtz({ pan: 36100, tilt: 12000, zoom: -5 })).toEqual({ pan: 100, tilt: 9000, zoom: 0 });
  });
});
