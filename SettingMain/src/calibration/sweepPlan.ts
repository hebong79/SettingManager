import type { CameraIntrinsics } from '../config/types.js';

/**
 * 어디를 몇 번 클릭할 것인가.
 *
 * 근거: baro_calory `apps/backend-core/src/calibration-manager.mjs` 의 `FULL_ZOOMS`·`VERIFY_ZOOMS`.
 */

/**
 * 방문할 줌. **렌즈가 있는 곳에 촘촘하다** — 화각이 15000~16384 사이에서 절반으로 꺾이고,
 * 그 구간을 성기게 잡으면 보간이 절벽을 직선으로 뭉개 거짓말을 한다. 마지막 둘은 광학이
 * 더 이상 변하지 않는 지점 너머를 찔러 본다 — **그 포화는 실재하는 물리이고 곡선이 그것을
 * 보여야 한다.**
 */
export const FULL_ZOOMS = [0, 2000, 3000, 5129, 8000, 10338, 12161, 14000, 15000, 15400, 15800, 16100, 16384, 22000] as const;
const FULL_DX = [-720, -480, -240, 240, 480, 720] as const;
const FULL_DY = [-300, 300] as const;

/**
 * 검증은 예/아니오만 답하면 되므로 **아니오라고 말할 수 있는 최소한**만 묻는다 —
 * 다만 나쁜 매칭 하나가 줌 하나를 통째로 앗아갈 만큼 적어서는 안 된다.
 * 장면은 군데군데 심심해도 되고, 그때 패스는 살아남아 **그렇다고 말할 수 있어야 한다.**
 */
export const VERIFY_ZOOMS = [0, 8000, 16384] as const;
const VERIFY_DX = [-600, -300, 300, 600] as const;
const VERIFY_DY = [-300, 300] as const;

export type SweepMode = 'full' | 'verify';

export interface SweepPlan {
  zooms: number[];
  /** `[dx, dy]` — 화면 중앙에서의 오프셋. 한 번에 한 축만 움직인다(교차축 게이트가 성립하도록). */
  targets: Array<[number, number]>;
  total: number;
  /** 줌 앵커를 어디서 얻었는가. 화면·응답이 "왜 이 눈금인가"에 답할 수 있어야 한다. */
  zoomSource: 'device-seed' | 'builtin';
}

/**
 * **줌 앵커는 기기 눈금이어야 한다.**
 *
 * `FULL_ZOOMS` 는 cam-001(Hucoms, 0~65535) 실측 눈금이다. 자기 줌 범위를 선언하는 기기
 * (IDIS: 배율×100, 100~1200)에 그대로 보내면 범위 밖 앵커가 **`rc=0` 으로 성공을 답하며 조용히
 * 최망원에 클램프**되고, 요청값을 키로 쓰는 표가 오염된 채 발행된다(상류 리뷰 확정).
 *
 * 그래서 이 기기가 **자기 시드 표**를 갖고 있으면 그 z 축을 앵커로 쓴다 — 시드가 곧 "이 기기가
 * 도달하는 눈금"의 실측이고, 재캘리브레이션은 같은 축 위에서 값을 정밀화하는 일이다.
 */
export function planSweep(mode: SweepMode, intrinsics?: CameraIntrinsics): SweepPlan {
  const seed = intrinsics?.zoomHfov?.length ? intrinsics.zoomHfov.map((point) => Number(point.z)) : null;

  const zooms = mode === 'verify'
    ? (seed ? verifyAnchorsFrom(seed) : [...VERIFY_ZOOMS])
    : (seed ?? [...FULL_ZOOMS]);

  const targets: Array<[number, number]> = mode === 'verify'
    ? [...VERIFY_DX.map((dx) => [dx, 0] as [number, number]), ...VERIFY_DY.map((dy) => [0, dy] as [number, number])]
    : [...FULL_DX.map((dx) => [dx, 0] as [number, number]), ...FULL_DY.map((dy) => [0, dy] as [number, number])];

  return { zooms, targets, total: zooms.length * targets.length, zoomSource: seed ? 'device-seed' : 'builtin' };
}

/** 시드 표에서 양 끝과 가운데. 세 점이면 "광각·중간·망원에서 맞나"에 답할 수 있다. */
function verifyAnchorsFrom(seed: number[]): number[] {
  if (seed.length <= 3) return [...seed];
  return [seed[0]!, seed[Math.floor(seed.length / 2)]!, seed[seed.length - 1]!];
}
