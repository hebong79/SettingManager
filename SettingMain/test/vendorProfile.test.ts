import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { hfovFromZoomPos, pixelToPtzDelta, vfovFromHfov, ZOOM_HFOV_TABLE } from '../src/vendor/baro-profile/index.mjs';

/**
 * 벤더링한 `@baro/profile` 이 **원본 그대로인지** 지킨다.
 *
 * 두 가지를 본다.
 *   ① 지문 — 파일이 손으로 고쳐지지 않았는가. 벤더링의 계약은 "고치지 않는다"이고,
 *      그 계약을 지키는 것은 문서가 아니라 이 검사다.
 *   ② 계산 — 복사본이 상류와 같은 답을 내는가. 값의 근거는 상류 소스의 실측 표
 *      (`packages/profile/src/camera-intrinsics.mjs` 의 ZOOM_HFOV_TABLE, 실기 cam-001 재실측 2026-07-14).
 *
 * 지문이 깨졌는데 계산이 맞을 수도 있고 그 반대도 있다 — 둘 다 봐야 "그대로"가 증명된다.
 */

/** 근거: `src/vendor/baro-profile/VENDOR.md` §복사본 지문. 갱신 순서는 그 문서를 따른다. */
const FINGERPRINTS: Record<string, string> = {
  'calibration.mjs': '6be03db9e06154322c294f66f739181825676ed7a807ccd30aa149fa0766c384',
  'camera-intrinsics.mjs': '1ba7981fbb5bb0648de7a51597c1db59615040e39e500afa843dd47a63095de8',
  'camera-projection.mjs': 'd4f07ae995eb2b83c87df2795939c0cd362f1aa1a00afeb08142d3b7ab332816',
  'errors.mjs': '2f14398741b74cec9be2ed783f5bf0e420b5e45418c608a64856ca726141b677',
  'fov-convert.mjs': '280da51fee98813794209333d863202beb5cab60eca289a499aabd0aef1d3c3c',
  'frame-scale.mjs': '929c899f7d8da84375d333bde1bda62716743d772464b5260888772c7130c6ef',
  'index.mjs': '4b0f6911382bb649e17eb2b0f81b7a82d58969607e44c0a1abadf61acdd2c2b9',
};

describe('벤더링 지문 — 남의 코드를 고치지 않았다', () => {
  it.each(Object.entries(FINGERPRINTS))('%s 가 복사본 그대로다', async (file, expected) => {
    const bytes = await readFile(new URL(`../src/vendor/baro-profile/${file}`, import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
  });
});

describe('벤더링 계산 — 상류와 같은 답을 낸다', () => {
  it('줌→화각 표의 앵커를 그대로 읽는다', () => {
    // 표의 양 끝과 중간 앵커. 앵커 위에서는 보간이 아니라 그 값 자체가 나와야 한다.
    expect(hfovFromZoomPos(0)).toBeCloseTo(57.14, 6);
    expect(hfovFromZoomPos(8000)).toBeCloseTo(22.59, 6);
    expect(hfovFromZoomPos(16384)).toBeCloseTo(2.39, 6);
  });

  it('앵커 사이는 선형 보간이다', () => {
    // z=2500 은 2000(47.89)과 3000(43.37)의 정확히 중간.
    expect(hfovFromZoomPos(2500)).toBeCloseTo((47.89 + 43.37) / 2, 6);
  });

  it('표 밖은 외삽하지 않고 양 끝에서 잘린다 — 실제 렌즈가 포화한다', () => {
    expect(hfovFromZoomPos(-9999)).toBeCloseTo(57.14, 6);
    expect(hfovFromZoomPos(999_999)).toBeCloseTo(2.39, 6);
  });

  it('세로 화각은 tan 관계다 — 고정 비율이 아니다', () => {
    // 상류 주석의 예시 그대로: hfov 69.88° 에서 vfov/hfov=0.614, 28.4° 에서 0.570.
    // (69.88 은 **옛 와이드 앵커**다. 표는 2026-07-14 에 57.14 로 재측정됐지만, 이 단정은
    //  표가 아니라 tan 관계 자체를 보는 것이라 옛 값으로도 성립한다 — 오히려 표를 갈아도
    //  이 관계가 살아 있는지 확인해 준다.)
    expect(vfovFromHfov(69.88) / 69.88).toBeCloseTo(0.614, 3);
    expect(vfovFromHfov(28.4) / 28.4).toBeCloseTo(0.570, 3);
    // 요점은 두 비율이 **다르다**는 것 — 선형 비율로 대체하면 그리는 그림이 틀어진다.
    expect(vfovFromHfov(69.88) / 69.88).toBeGreaterThan(vfovFromHfov(28.4) / 28.4);
  });

  it('화면 중앙 클릭은 움직이지 않는다', () => {
    expect(pixelToPtzDelta({ x: 960, y: 540, hfovDeg: 57.14 })).toEqual({ panDelta: 0, tiltDelta: 0 });
  });

  it('가로로만 클릭해도 광축이 기울어 있으면 틸트가 딸려 간다 — 짐벌 기하', () => {
    // 상류가 반증한 가정: "펌웨어는 픽셀→각을 선형으로 매핑한다". 선형이라면 가로 클릭에
    // 틸트가 0 이어야 하는데 실기는 그렇지 않았다(cam-001, 와이드·틸트 16.81°, dx=480).
    // **값이 아니라 이 성질을 고정한다** — 상류가 인용한 -62cd 는 화각표 재측정(2026-07-14) 전
    // 곡선의 수치이고, 지금 표(와이드 57.14°)에서는 -61cd 다. 값을 박으면 표를 다시 잴 때마다
    // 이 테스트가 상류를 따라 흔들리는데, 지켜야 하는 것은 표가 아니라 기하다.
    const delta = pixelToPtzDelta({ x: 960 + 480, y: 540, hfovDeg: 57.14, tiltDeg: 16.81 });
    expect(delta.panDelta).toBeGreaterThan(0);
    expect(delta.tiltDelta).toBeLessThan(0);

    // 광축이 수평(tilt 0)이면 가로 클릭에 틸트가 딸려 오지 않는다 — 짐벌 기하의 반대쪽 증거.
    expect(pixelToPtzDelta({ x: 960 + 480, y: 540, hfovDeg: 57.14, tiltDeg: 0 }).tiltDelta).toBe(0);
  });

  it('부호 규약이 유지된다 — panpos+ 는 대상이 오른쪽, tiltpos+ 는 아래', () => {
    expect(pixelToPtzDelta({ x: 1440, y: 540, hfovDeg: 57.14 }).panDelta).toBeGreaterThan(0);
    expect(pixelToPtzDelta({ x: 960, y: 810, hfovDeg: 57.14 }).tiltDelta).toBeGreaterThan(0);
  });

  it('표는 z 오름차순이다 — 보간이 성립하는 전제', () => {
    const zs = ZOOM_HFOV_TABLE.map((row: { z: number }) => row.z);
    expect(zs).toEqual([...zs].sort((a, b) => a - b));
  });
});
