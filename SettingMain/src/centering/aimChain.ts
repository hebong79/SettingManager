import { applyCenteringGain, hfovFromZoomPos, pixelToPtzDelta } from '../vendor/baro-profile/index.mjs';
import type { CameraIntrinsics } from '../config/types.js';
import type { PtzRaw } from '../domain/ptz.js';

/**
 * 조준 사슬 — **클릭 픽셀에서 명령까지, 순수 계산으로.**
 *
 * 이 파일에는 I/O 가 없다. 카메라를 읽지도 움직이지도 않으므로 테스트가 시간이나 기기를
 * 필요로 하지 않고, 그래서 **게인이 실제로 걸리는지**를 값 하나로 못 박을 수 있다.
 *
 * ## 여기서 고치는 살아 있는 결함
 *
 * 2026-08-07 이전 `BridgeCoreProvider.center()` 는 클릭 픽셀을 **게인 없이** 펌웨어에 그대로
 * 넘겼다. 상류가 실측한 *z8000 이상 약 10% 부족 회전*이 그대로 살아 있었고, 증상이 조용해서
 * (중앙 근처는 멀쩡하다) 아무도 신고하지 않는 종류였다.
 *
 * ## 게인 표가 없으면 k=1 이다
 *
 * **내장 `CENTERING_GAIN_TABLE` 을 기본값으로 들지 않는다.** 그 표는 cam-001 한 대의 곡선이고
 * **단조가 아니다** — z8000 에서 1.11, z16384 에서 0.765. 다른 렌즈에 씌우면 망원 오차를
 * 개선이 아니라 **악화**시킨다. 벤더 `centeringGain()` 이 빈 표에 1 을 돌려주므로 `null` 을
 * 그대로 넘기는 것이 곧 그 규율이다.
 */

export const FRAME = { width: 1920, height: 1080 } as const;

export interface AimPoint {
  x: number;
  y: number;
}

export interface AimedPixel {
  /** 실제로 기기에 보낼 픽셀. 게인이 없으면 클릭 그대로다. */
  x: number;
  y: number;
  /** 적용된 게인. **응답에 실어 화면이 무엇이 걸렸는지 알게 한다** — 조용한 보정은 조용한 미보정만큼 나쁘다. */
  k: number;
  /** 보정된 점이 프레임 밖이라 잘렸는가. 그 클릭은 **절반만** 보정된 것이다. */
  clamped: boolean;
}

/** 클릭 픽셀 → 보정된 픽셀. 펌웨어가 자기 오차로 되돌려 놓을 만큼 미리 늘려 보낸다. */
export function aimPixel(point: AimPoint, zoomPos: number, intrinsics?: CameraIntrinsics): AimedPixel {
  return applyCenteringGain({
    x: point.x,
    y: point.y,
    zoomPos,
    table: intrinsics?.centeringGain ?? null,
    frameWidth: FRAME.width,
    frameHeight: FRAME.height,
  });
}

export interface AimDelta {
  panDelta: number;
  tiltDelta: number;
  /** 이 줌에서 읽은 수평 화각(도). 진단·표시에 쓴다. */
  hfovDeg: number;
}

/**
 * 보정된 픽셀 → 팬/틸트 델타(centi-degree). **드라이버에 `centerPoint` 가 없을 때 쓴다.**
 *
 * 광축이 기울어 있으면 가로 클릭에도 틸트가 딸려 움직인다 — 팬 축이 월드 수직축이라 생기는
 * 짐벌 결합이고, 실측으로 확인됐다(와이드·틸트 16.81°에서 `dx=480` 수평 클릭에 펌웨어가
 * `dtilt=-62cd` 를 함께 냈고 이 식이 **0 centidegree 오차**로 재현했다).
 */
export function aimDelta(pixel: AimPoint, current: PtzRaw, intrinsics: CameraIntrinsics): AimDelta {
  const hfovDeg = hfovFromZoomPos(current.zoom, undefined, intrinsics.zoomHfov);
  const delta = pixelToPtzDelta({
    x: pixel.x,
    y: pixel.y,
    hfovDeg,
    tiltDeg: current.tilt / 100,
    frameWidth: FRAME.width,
    frameHeight: FRAME.height,
  });
  return { ...delta, hfovDeg };
}

/**
 * 이 박스가 프레임을 채울 화각.
 *
 * 가로·세로 중 **큰 쪽**을 쓴다 — 작은 쪽을 쓰면 박스가 화면 밖으로 잘린다.
 */
export function hfovForBox(currentHfovDeg: number, boxWidth: number, boxHeight: number): number {
  return currentHfovDeg * Math.max(boxWidth / FRAME.width, boxHeight / FRAME.height);
}
