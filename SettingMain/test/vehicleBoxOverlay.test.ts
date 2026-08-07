import { describe, expect, it } from 'vitest';
// 구현은 JS(브라우저가 그대로 실행한다), 계약은 옆의 `.d.ts` — `streamCentering` 과 같은 관례다.
import { contentBox, segmentsToCanvas, toCanvas } from '../web/vehicleBoxOverlay.js';

/**
 * 오버레이 기하 — **화면 코드에서 순수 부분만 떼어 검사한다.**
 *
 * 여기서 지키는 것은 하나다: **`segments` 개수를 가정하지 않는다.** 큐보이드는 12모서리지만
 * 사이드카가 화면 밖으로 날아간 모서리를 개별적으로 버리므로 7개일 수도, 0개일 수도 있다.
 * 12를 기대하고 인덱스로 면을 재구성하면 그 순간 조용히 깨진다.
 */

const CONTENT = { left: 0, top: 0, width: 1920, height: 1080 };

describe('contentBox — 레터박스 여백은 영상이 아니다', () => {
  it('가로가 남으면 좌우에 여백이 생긴다(pillarbox)', () => {
    // 16:9 영상을 2:1 상자에 넣으면 좌우가 남는다.
    const box = contentBox({ width: 2000, height: 1000 }, 1920, 1080);
    expect(box).not.toBeNull();
    if (!box) return;
    expect(box.height).toBe(1000);
    expect(box.width).toBeCloseTo(1000 * (1920 / 1080), 6);
    expect(box.left).toBeGreaterThan(0);
    expect(box.top).toBe(0);
  });

  it('세로가 남으면 위아래에 여백이 생긴다(letterbox)', () => {
    const box = contentBox({ width: 1920, height: 2000 }, 1920, 1080);
    expect(box).not.toBeNull();
    if (!box) return;
    expect(box.width).toBe(1920);
    expect(box.top).toBeGreaterThan(0);
    expect(box.left).toBe(0);
  });

  it('아직 로드되지 않은 이미지에는 null — NaN 좌표로 캔버스를 지우지 않는다', () => {
    expect(contentBox({ width: 100, height: 100 }, 0, 0)).toBeNull();
    expect(contentBox({ width: 0, height: 0 }, 1920, 1080)).toBeNull();
  });
});

describe('toCanvas — 논리 프레임 → 캔버스', () => {
  it('1:1 이면 그대로다', () => {
    expect(toCanvas([960, 540], CONTENT)).toEqual({ x: 960, y: 540 });
  });

  it('축소된 상자에서는 비율로 줄어든다', () => {
    const half = { left: 0, top: 0, width: 960, height: 540 };
    expect(toCanvas([1920, 1080], half)).toEqual({ x: 960, y: 540 });
  });

  it('여백만큼 밀린다', () => {
    expect(toCanvas([0, 0], { left: 40, top: 10, width: 1920, height: 1080 })).toEqual({ x: 40, y: 10 });
  });
});

describe('segmentsToCanvas — 개수를 가정하지 않는다', () => {
  it('12개가 아니어도 받은 만큼만 잇는다', () => {
    // 실제 사이드카 응답: 투영이 화면의 3배를 넘어 날아간 모서리는 버려진다.
    const seven = Array.from({ length: 7 }, (_, i) => [i, i, i + 1, i + 1]);
    expect(segmentsToCanvas({ segments: seven }, CONTENT)).toHaveLength(7);
  });

  it('선분이 하나도 없어도 조용히 넘어간다', () => {
    expect(segmentsToCanvas({ segments: [] }, CONTENT)).toEqual([]);
    expect(segmentsToCanvas({}, CONTENT)).toEqual([]);
    expect(segmentsToCanvas(null, CONTENT)).toEqual([]);
  });

  it('모양이 이상한 항목은 버린다 — NaN 좌표 하나가 캔버스 전체를 조용히 비운다', () => {
    const mixed = [[0, 0, 10, 10], [1, 2, 3], ['a', 'b', 'c', 'd'], [5, 5, 6, 6]];
    expect(segmentsToCanvas({ segments: mixed }, CONTENT)).toHaveLength(2);
  });

  it('문자열 숫자도 읽는다 — JSON 을 지나온 값이 늘 number 는 아니다', () => {
    const converted = segmentsToCanvas({ segments: [['960', '540', '1920', '1080']] }, CONTENT);
    expect(converted[0]).toEqual({ from: { x: 960, y: 540 }, to: { x: 1920, y: 1080 } });
  });
});
