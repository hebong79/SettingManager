import { hfovFromZoomPos } from '../vendor/baro-profile/index.mjs';
import type { CameraIntrinsics } from '../config/types.js';

/**
 * 줌 눈금 ↔ 수평 화각. 정방향은 **벤더링한 `@baro/profile` 을 그대로 쓴다**(다시 구현하지 않는다).
 * 역방향(화각 → 줌 눈금)은 상류에 함수가 없어 여기서 세운다 — 상류는 줌을 정하고 화각을
 * 읽기만 하면 됐지만, 박스 줌은 "이만큼 보고 싶다"에서 눈금을 거꾸로 찾아야 한다.
 */

/** 표 밖으로 나가지 않는다 — 실제 렌즈는 양 끝에서 포화한다(상류 `sampleCurve` 와 같은 규약). */
export function zoomPosForHfov(intrinsics: CameraIntrinsics, hfovDeg: number): number {
  const table = intrinsics.zoomHfov;
  const first = table[0]!;
  const last = table[table.length - 1]!;
  // 표는 z 오름차순이고 h 는 (줌인할수록) 줄어든다. 요청 화각이 표의 범위를 넘으면 끝값이다.
  if (hfovDeg >= first.h) return first.z;
  if (hfovDeg <= last.h) return last.z;

  for (let i = 0; i < table.length - 1; i += 1) {
    const lo = table[i]!;
    const hi = table[i + 1]!;
    // 이 구간이 요청 화각을 감싸는가. h 는 감소하므로 부등호 방향이 z 쪽과 반대다.
    if (hfovDeg <= lo.h && hfovDeg >= hi.h) {
      const span = lo.h - hi.h;
      // 구간 안에서 화각이 변하지 않으면(평평한 구간) 더 넓은 쪽 눈금을 고른다 — 덜 줌인한다.
      if (span === 0) return lo.z;
      const f = (lo.h - hfovDeg) / span;
      return Math.round(lo.z + f * (hi.z - lo.z));
    }
  }
  return last.z;
}

/** 이 기기의 실측 표로 읽은 현재 화각. 표가 없는 기기에는 애초에 부르지 않는다. */
export function hfovAt(intrinsics: CameraIntrinsics, zoomPos: number): number {
  return hfovFromZoomPos(zoomPos, undefined, intrinsics.zoomHfov);
}
