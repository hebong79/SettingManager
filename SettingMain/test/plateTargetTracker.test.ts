import { describe, expect, it } from 'vitest';
import {
  FRAME,
  createPlateTrack,
  matchPlateTrack,
  normalizeMasks,
  normalizePlates,
  platesInsideMask,
  vehicleMaskAtPoint,
  type PlateBox,
  type VehicleMask,
} from '../src/homing/plateTargetTracker.js';
import type { Detection } from '../src/detectors/detectorTypes.js';

/** 축정렬 상자 검출 1건. */
const box = (bbox: [number, number, number, number], confidence = 0.9): Detection =>
  ({ className: 'plate', confidence, bbox });

/** 사각형 마스크. */
const rect = (x1: number, y1: number, x2: number, y2: number): Detection => ({
  className: 'car',
  confidence: 0.9,
  polygon: [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }],
});

const plateAt = (cx: number, cy: number, w: number, h: number): PlateBox => ({
  bbox: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
  cx, cy, w, h, confidence: 0.9,
});

const square = (x1: number, y1: number, x2: number, y2: number): VehicleMask =>
  [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];

describe('좌표 정규화', () => {
  /**
   * 검출기는 스냅샷 원본 해상도로 답하고 조준은 논리 프레임에서 한다.
   * 섞으면 4K 스냅샷에서 조준이 정확히 절반만큼 빗나간다.
   */
  it('스냅샷 해상도를 논리 프레임으로 옮긴다', () => {
    const plates = normalizePlates([box([1920, 1080, 2080, 1130])], { width: 3840, height: 2160 });
    expect(plates).toHaveLength(1);
    expect(plates[0]!.bbox).toEqual([960, 540, 1040, 565]);
    expect(plates[0]!.cx).toBe(1000);
    expect(plates[0]!.w).toBe(80);
  });

  it('LPD 회전 상자는 감싸는 축정렬 상자로 바꾼다 — 이후 판정이 전부 축정렬이다', () => {
    const obb: Detection = {
      className: 'plate', confidence: 0.9,
      polygon: [{ x: 100, y: 100 }, { x: 200, y: 120 }, { x: 195, y: 160 }, { x: 95, y: 140 }],
    };
    const [plate] = normalizePlates([obb], FRAME);
    expect(plate!.bbox).toEqual([95, 100, 200, 160]);
  });

  it('폭·높이가 0 인 상자는 버린다 — 종횡비가 무한대가 되면 게이트가 무의미해진다', () => {
    expect(normalizePlates([box([10, 10, 10, 50])], FRAME)).toHaveLength(0);
  });

  it('3점 미만 마스크는 만들지 않는다', () => {
    const thin: Detection = { className: 'car', confidence: 0.9, polygon: [{ x: 1, y: 1 }, { x: 2, y: 2 }] };
    expect(normalizeMasks([thin], FRAME)).toHaveLength(0);
  });

  it('원본 해상도가 0 이면 조용히 넘어가지 않고 던진다', () => {
    expect(() => normalizePlates([box([0, 0, 1, 1])], { width: 0, height: 1080 })).toThrow(/양수/);
  });
});

describe('차량 마스크 판정 — 옆차 차단 1단계', () => {
  it('점이 든 마스크가 하나면 matched', () => {
    const masks = normalizeMasks([rect(0, 0, 100, 100), rect(200, 200, 300, 300)], FRAME);
    expect(vehicleMaskAtPoint(masks, { x: 50, y: 50 }).kind).toBe('matched');
  });

  it('아무 마스크에도 안 들면 missing', () => {
    const masks = normalizeMasks([rect(0, 0, 100, 100)], FRAME);
    expect(vehicleMaskAtPoint(masks, { x: 500, y: 500 }).kind).toBe('missing');
  });

  /**
   * 주차장에서 차량은 서로 가려진다. 겹친 둘 중 하나를 임의로 고르면 그 순간 옆차를
   * 표적으로 삼은 것이 된다 — "모르겠다"가 틀린 조준을 저장하는 것보다 낫다.
   */
  it('겹치면 ambiguous — 하나를 고르지 않는다', () => {
    const masks = normalizeMasks([rect(0, 0, 100, 100), rect(50, 50, 150, 150)], FRAME);
    const match = vehicleMaskAtPoint(masks, { x: 75, y: 75 });
    expect(match.kind).toBe('ambiguous');
    expect(match.count).toBe(2);
    expect(match.mask).toBeNull();
  });

  it('경계 위의 점은 안쪽으로 센다 — 밖으로 밀면 자기 차를 못 찾는다', () => {
    const masks = normalizeMasks([rect(0, 0, 100, 100)], FRAME);
    expect(vehicleMaskAtPoint(masks, { x: 0, y: 50 }).kind).toBe('matched');
    expect(vehicleMaskAtPoint(masks, { x: 100, y: 100 }).kind).toBe('matched');
  });

  it('실루엣 안쪽 판만 후보로 남긴다', () => {
    const mask = square(0, 0, 100, 100);
    const inside = plateAt(50, 50, 20, 8);
    const outside = plateAt(300, 300, 20, 8);
    expect(platesInsideMask([inside, outside], mask)).toEqual([inside]);
  });
});

describe('판 추적 — 옆차 차단 2단계', () => {
  const centre = { x: FRAME.width / 2, y: FRAME.height / 2 };
  const track = createPlateTrack(plateAt(centre.x, centre.y, 80, 30), 8000);

  it('중앙에서 조금 자란 같은 판은 matched 이고 추적이 갱신된다', () => {
    const grown = plateAt(centre.x + 5, centre.y - 3, 100, 38);
    const match = matchPlateTrack(track, [grown], { zoom: 9500 });
    expect(match.kind).toBe('matched');
    expect(match.plate).toBe(grown);
    expect(match.nextTrack.zoom).toBe(9500);
    expect(match.nextTrack.bbox).toEqual(grown.bbox);
  });

  it('중심에서 64px 밖은 후보가 아니다', () => {
    const far = plateAt(centre.x + 200, centre.y, 90, 34);
    expect(matchPlateTrack(track, [far]).kind).toBe('lost');
  });

  it('한 스텝에 2.25배를 넘게 자란 것은 다른 판이다', () => {
    const huge = plateAt(centre.x, centre.y, 80 * 2.6, 30 * 2.6);
    expect(matchPlateTrack(track, [huge]).kind).toBe('lost');
  });

  it('종횡비가 크게 달라지면 다른 판이다 — 번호판 비율은 각도로 크게 안 변한다', () => {
    const squished = plateAt(centre.x, centre.y, 90, 70);
    expect(matchPlateTrack(track, [squished]).kind).toBe('lost');
  });

  /** 하나라도 더 맞으면 멈춘다(fail-closed). 둘 중 하나를 고르는 순간 옆차가 될 수 있다. */
  it('게이트를 통과한 것이 둘이면 ambiguous', () => {
    const a = plateAt(centre.x - 20, centre.y, 85, 32);
    const b = plateAt(centre.x + 20, centre.y, 85, 32);
    const match = matchPlateTrack(track, [a, b]);
    expect(match.kind).toBe('ambiguous');
    expect(match.plate).toBeNull();
    // 추적은 **직전 것을 유지한다** — 실패했다고 표적을 버리면 다음 스텝에 아무 판이나 잡는다.
    expect(match.nextTrack).toBe(track);
  });

  it('후보가 없으면 lost 이고 추적은 그대로다', () => {
    const match = matchPlateTrack(track, []);
    expect(match.kind).toBe('lost');
    expect(match.nextTrack).toBe(track);
  });
});
