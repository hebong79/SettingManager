import { describe, expect, it } from 'vitest';
import { jpegSize } from '../src/calibration/jpegSize.js';
import { assertSameSize, locateClicked } from '../src/calibration/frameMatch.js';
import type { GrayFrame } from '../src/calibration/frameDecode.js';

/**
 * 캘리브레이션의 **측정 앞단** — 여기가 틀리면 그 뒤 모든 것이 자기일관되게 오염된다.
 *
 * 프레임을 지어내 쓰는 이유가 있다: 착지 지점을 **우리가 정해 놓고** 매처가 그것을 찾아내는지
 * 보아야, 매처가 맞았는지 장면이 쉬웠는지를 구별할 수 있다.
 */

const W = 480;
const H = 270;

/** 결정적 의사난수 — 매 실행 같은 장면이어야 실패가 재현된다. */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/** 무늬 있는 장면. `shift` 만큼 통째로 민 프레임을 만든다. */
function scene(shiftX: number, shiftY: number, seed = 7): GrayFrame {
  const random = noise(seed);
  const base = new Uint8Array(W * H);
  // 같은 seed 로 같은 텍스처를 만들고, 읽을 때 오프셋을 준다 — 실제 카메라 이동과 같은 모양.
  const texture: number[] = [];
  for (let i = 0; i < (W + 400) * (H + 400); i += 1) texture.push(Math.floor(random() * 256));
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const sx = x + shiftX + 200;
      const sy = y + shiftY + 200;
      base[y * W + x] = texture[sy * (W + 400) + sx]!;
    }
  }
  return { data: base, width: W, height: H };
}

/** 가로로 반복되는 무늬. 상관은 잘 되는데 **위치를 특정할 수 없는** 장면이다. */
function stripes(shiftX: number): GrayFrame {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      data[y * W + x] = ((x + shiftX) % 16 < 8 ? 40 : 210);
    }
  }
  return { data, width: W, height: H };
}

/** 아무것도 없는 장면(빈 벽·야간). 잡음만 있고 대비가 없다. */
function blank(): GrayFrame {
  const random = noise(3);
  const data = new Uint8Array(W * H);
  // ±2 그레이 레벨 — RMS 대비가 LOW_CONTRAST(12) 아래로 떨어진다.
  for (let i = 0; i < data.length; i += 1) data[i] = 128 + Math.round(random() * 4 - 2);
  return { data, width: W, height: H };
}

describe('jpegSize — SOF 마커 직독', () => {
  /** 최소 JPEG: SOI + APP0(건너뛰어야 함) + SOF0 + EOI. */
  function fakeJpeg(width: number, height: number, sofMarker = 0xc0): Buffer {
    const sof = Buffer.alloc(11);
    sof.writeUInt16BE(0xff00 | sofMarker, 0);
    sof.writeUInt16BE(8, 2);       // 세그먼트 길이
    sof.writeUInt8(8, 4);          // 정밀도
    sof.writeUInt16BE(height, 5);
    sof.writeUInt16BE(width, 7);
    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46]);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
  }

  it('APP0 를 건너뛰고 SOF0 에서 치수를 읽는다', () => {
    expect(jpegSize(fakeJpeg(1920, 1080))).toMatchObject({ width: 1920, height: 1080, progressive: false });
  });

  it('progressive(SOF2)도 읽고 그렇다고 표시한다', () => {
    expect(jpegSize(fakeJpeg(3840, 2160, 0xc2))).toMatchObject({ width: 3840, height: 2160, progressive: true });
  });

  it('DHT(C4)를 SOF 로 오독하지 않는다 — 허프만 표를 치수로 읽으면 그럴듯한 헛값이 나온다', () => {
    const dht = Buffer.concat([Buffer.from([0xff, 0xc4, 0x00, 0x07]), Buffer.from([1, 2, 3])]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), dht, fakeJpeg(640, 480).subarray(2)]);
    expect(jpegSize(jpeg)).toMatchObject({ width: 640, height: 480 });
  });

  it('JPEG 가 아니면 던진다 — 조용히 0×0 을 답하지 않는다', () => {
    expect(() => jpegSize(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toThrow(/JPEG 이 아닙니다/);
  });
});

describe('locateClicked — 착지 픽셀', () => {
  it('알고 있는 이동량을 되찾는다', () => {
    // 화면 중앙에서 (+120, +60) 떨어진 픽셀을 클릭했고, 카메라가 그만큼 움직여
    // 그 내용이 중앙으로 왔다고 두면 — 매처는 중앙 근처를 답해야 한다.
    const clickX = 1920 / 2 + 120 * (1920 / W);
    const clickY = 1080 / 2 + 60 * (1080 / H);
    const before = scene(0, 0);
    const after = scene(120, 60);

    const match = locateClicked(before, after, { clickX, clickY, half: 24, search: 160, step: 2 });

    expect(match.peak).toBeGreaterThan(0.9);
    expect(match.margin).toBeGreaterThan(0.02);
    // 논리 프레임 좌표로 답하므로 클릭 픽셀과 직접 비교된다.
    expect(match.landedX).toBeCloseTo(960, -1);
    expect(match.landedY).toBeCloseTo(540, -1);
  });

  it('반복 무늬는 **점수가 높아도** 마진이 무너진다 — 이것이 이 매처의 핵심이다', () => {
    const before = stripes(0);
    const after = stripes(8);
    const match = locateClicked(before, after, { clickX: 960 + 200, clickY: 540, half: 24, search: 120, step: 2 });

    // 줄무늬는 자기 자신과 여러 오프셋에서 거의 완벽히 상관된다 — 점수는 훌륭하다.
    expect(match.peak).toBeGreaterThan(0.9);
    // 그런데 어느 줄인지는 말할 수 없다. **점수가 아니라 이 값이 샘플을 기각한다.**
    expect(match.margin).toBeLessThan(0.02);
  });

  it('빈 장면은 대비로 갈라진다 — "어둡다"와 "무늬가 없다"는 처방이 다르다', () => {
    const match = locateClicked(blank(), blank(), { clickX: 960 + 100, clickY: 540, half: 24, search: 100, step: 2 });
    // LOW_CONTRAST(12) 아래 — 잡은 이것을 보고 "밝을 때 다시 오세요"라고 말한다.
    expect(match.contrast).toBeLessThan(12);
  });

  it('크기가 다른 두 스냅샷은 비교 자체를 거절한다', () => {
    expect(() => assertSameSize(scene(0, 0), { data: new Uint8Array(4), width: 2, height: 2 }))
      .toThrow(/크기가 다릅니다/);
  });
});
