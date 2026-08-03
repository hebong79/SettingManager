import { describe, expect, it } from 'vitest';
import { streamPointFromPointer } from '../web/streamCentering.js';

const viewport = { left: 10, top: 20, width: 960, height: 540 };
const image = { left: 10, top: 20, width: 960, height: 540 };

function point(overrides = {}) {
  return streamPointFromPointer({
    button: 0,
    clientX: 490,
    clientY: 290,
    viewport,
    image,
    naturalWidth: 1920,
    naturalHeight: 1080,
    ...overrides,
  });
}

describe('streamPointFromPointer', () => {
  it('16:9 표시 영상의 중앙 클릭을 Hucoms 1920×1080 중앙으로 환산한다', () => {
    expect(point()).toMatchObject({ x: 960, y: 540, left: 480, top: 270 });
  });

  it('왼쪽 버튼만 센터링 좌표를 만든다', () => {
    expect(point({ button: 1 })).toBeNull();
    expect(point({ button: 2 })).toBeNull();
  });

  it('letterbox 여백 클릭은 카메라 이동 명령으로 환산하지 않는다', () => {
    const squareImage = { left: 10, top: 20, width: 600, height: 600 };
    expect(point({ image: squareImage, clientY: 40 })).toBeNull();
    expect(point({ image: squareImage, clientX: 310, clientY: 320 })).toMatchObject({ x: 960, y: 540 });
  });

  it('영상 가장자리는 유효 범위의 양 끝으로 clamp 한다', () => {
    expect(point({ clientX: 10, clientY: 20 })).toMatchObject({ x: 0, y: 0 });
    expect(point({ clientX: 970, clientY: 560 })).toMatchObject({ x: 1920, y: 1080 });
  });
});
