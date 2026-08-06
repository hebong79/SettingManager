import { describe, expect, it } from 'vitest';
import {
  panToContract,
  panToWire,
  pointToWire,
  ptzToContract,
  ptzToWire,
  tiltToContract,
  tiltToWire,
  zoomToContract,
  zoomToWire,
} from '../src/devices/idis/idisCoords.js';

/**
 * 계획 `_workspace/01_architect_plan.md` §7 `test/idisCoords.test.ts` — T-C1~T-C7.
 *
 * 이 파일이 지키는 것은 **부호·원점·클램프 세 가지**다. 셋 다 틀려도 타입은 통과하고 기기도
 * `returnCode=0` 으로 답한다 — 오직 카메라가 엉뚱한 데를 볼 뿐이라, 런타임 값으로만 잡힌다.
 *
 * 픽스처 숫자의 근거는 계획 §2 좌표표와 `[매뉴얼 §56:8513 Example]`·`[매뉴얼 §58:8660 Example]`
 * 이며 지어낸 값이 없다.
 */

describe('T-C1 tilt 부호·원점 반전 — 계약(+아래·0=수평) ↔ 와이어(+위·0=수직아래)', () => {
  it('계약 0(수평) ↔ 와이어 9000, 계약 9000(수직아래) ↔ 와이어 0, 4500 은 자기 자신', () => {
    expect(tiltToWire(0)).toBe(9000);
    expect(tiltToContract(9000)).toBe(0);

    expect(tiltToWire(9000)).toBe(0);
    expect(tiltToContract(0)).toBe(9000);

    expect(tiltToWire(4500)).toBe(4500);
    expect(tiltToContract(4500)).toBe(4500);
  });

  it('9000 이 그대로 나가면(=반전을 잊으면) 수평 요청이 수직 아래가 된다 — 그 사고를 못으로 박는다', () => {
    // 반전이 빠진 구현은 tiltToWire(0) === 0 이 된다. 그것이 실측에서 카메라 자기 다리를 본 자세다.
    expect(tiltToWire(0)).not.toBe(0);
  });
});

describe('T-C2 tilt 자기역함수 — 0..9000 전 구간', () => {
  it('fromWire(toWire(t)) === t 가 9001개 값 전부에서 성립한다', () => {
    const broken: number[] = [];
    for (let t = 0; t <= 9000; t += 1) {
      if (tiltToContract(tiltToWire(t)) !== t) broken.push(t);
    }
    expect(broken).toEqual([]);
  });

  it('반대 방향도 같다 — toWire(fromWire(w)) === w', () => {
    const broken: number[] = [];
    for (let w = 0; w <= 9000; w += 1) {
      if (tiltToWire(tiltToContract(w)) !== w) broken.push(w);
    }
    expect(broken).toEqual([]);
  });
});

describe('T-C3 pan modulo 왕복', () => {
  it('계약 35000 → 와이어 −1000 → 계약 35000', () => {
    expect(panToWire(35000)).toBe(-1000);
    expect(panToContract(-1000)).toBe(35000);
    expect(panToContract(panToWire(35000))).toBe(35000);
  });

  it('경계 — 18000→18000, 18001→−17999, 0→0', () => {
    expect(panToWire(18000)).toBe(18000);
    expect(panToWire(18001)).toBe(-17999);
    expect(panToWire(0)).toBe(0);
  });

  it('계약 전 구간(0..35999)에서 왕복이 항등이다', () => {
    const broken: number[] = [];
    for (let pan = 0; pan < 36000; pan += 1) {
      if (panToContract(panToWire(pan)) !== pan) broken.push(pan);
    }
    expect(broken).toEqual([]);
  });

  it('와이어는 언제나 ±18000 안이다 — 범위를 넘겨 보내면 기기가 조용히 다른 데로 간다', () => {
    for (let pan = 0; pan < 36000; pan += 7) {
      const wire = panToWire(pan);
      expect(wire).toBeGreaterThanOrEqual(-18000);
      expect(wire).toBeLessThanOrEqual(18000);
    }
  });
});

describe('T-C4 pan 은 자르지 않고 감는다', () => {
  it('계약 40000 → 와이어 4000 (= 40000 % 36000)', () => {
    expect(panToWire(40000)).toBe(4000);
  });

  it('음수 입력도 감긴다 — 자르면 반대편 끝에 붙어 버린다', () => {
    expect(panToContract(-1)).toBe(35999);
    expect(panToWire(-1)).toBe(-1);
    expect(panToWire(-37000)).toBe(-1000);   // −37000 → 계약 35000 → 와이어 −1000
  });
});

describe('T-C5 사전 클램프 — zoom', () => {
  it('zoompos 3000 → absZoom 1200, 0 → 100, 65535 → 1200', () => {
    // 기기는 3000 에도 returnCode=0 으로 답하면서 1200 으로 간다 `[실측]`. 그래서 우리가 먼저 자른다.
    expect(zoomToWire(3000)).toBe(1200);
    expect(zoomToWire(0)).toBe(100);
    expect(zoomToWire(65535)).toBe(1200);
  });

  it('범위 안 값은 손대지 않는다 — 눈금의 뜻만 다르고 숫자는 그대로다', () => {
    expect(zoomToWire(100)).toBe(100);
    expect(zoomToWire(600)).toBe(600);
    expect(zoomToWire(1200)).toBe(1200);
    expect(zoomToContract(3000)).toBe(3000);   // 읽기는 항등 — 기기가 답한 값을 왜곡하지 않는다
  });
});

describe('T-C6 사전 클램프 — tilt 음수 방지 (오토플립 사고)', () => {
  it('계약 −2000(수평 위 20°) → 와이어 9000 이고, **11000 이 나가지 않는다**', () => {
    expect(tiltToWire(-2000)).toBe(9000);
    expect(tiltToWire(-2000)).not.toBe(11000);
  });

  it('계약 범위 하한 전체(−2000..0)가 9000 에서 멈춘다 — 음수 absTilt 는 단 하나도 나가지 않는다', () => {
    for (let t = -2000; t <= 0; t += 1) {
      expect(tiltToWire(t)).toBe(9000);
    }
  });

  it('계약 상한을 넘겨도 와이어는 0 아래로 내려가지 않는다', () => {
    expect(tiltToWire(12000)).toBe(0);
    expect(tiltToWire(65535)).toBe(0);
  });
});

describe('T-C7 centerPoint 정규화 (§58)', () => {
  it('1920×1080 절대 픽셀 → 0~100000', () => {
    expect(pointToWire({ x: 960, y: 540 })).toEqual({ pointPan: 50000, pointTilt: 50000 });
    expect(pointToWire({ x: 1920, y: 1080 })).toEqual({ pointPan: 100000, pointTilt: 100000 });
    expect(pointToWire({ x: 0, y: 0 })).toEqual({ pointPan: 0, pointTilt: 0 });
    // `[매뉴얼 §58:8660]` Example 과 같은 자리(20% 지점).
    expect(pointToWire({ x: 384, y: 216 })).toEqual({ pointPan: 20000, pointTilt: 20000 });
  });
});

describe('묶음 변환 — ptzToContract / ptzToWire 가 축별 함수와 어긋나지 않는다', () => {
  it('`[매뉴얼 §56:8513 Example]` 응답이 계약 좌표가 된다', () => {
    expect(ptzToContract({ absPan: 18000, absTilt: 8850, absZoom: 3000 }))
      .toEqual({ pan: 18000, tilt: 150, zoom: 3000 });
  });

  it('`[실측]` 자세 — absTilt=0 은 수직 아래(계약 9000), absPan 음수는 감긴다', () => {
    expect(ptzToContract({ absPan: -1000, absTilt: 0, absZoom: 1200 }))
      .toEqual({ pan: 35000, tilt: 9000, zoom: 1200 });
  });

  it('묶음은 축별 함수의 합과 정확히 같다 — 한쪽만 고치는 표류를 막는다', () => {
    const targets = [
      { pan: 0, tilt: 0, zoom: 0 },
      { pan: 35000, tilt: -2000, zoom: 3000 },
      { pan: 18001, tilt: 9000, zoom: 600 },
      { pan: 40000, tilt: 4500, zoom: 65535 },
    ];
    for (const target of targets) {
      expect(ptzToWire(target)).toEqual({
        absPan: panToWire(target.pan),
        absTilt: tiltToWire(target.tilt),
        absZoom: zoomToWire(target.zoom),
      });
    }
  });
});
