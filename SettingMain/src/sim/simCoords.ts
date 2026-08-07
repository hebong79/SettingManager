/**
 * 저장 파일 ↔ RPC 좌표 변환.
 *
 * ## 두 좌표계가 다르다 (2026-08-07 실측)
 *
 * `save/3D/` 의 JSON 은 **Unity 좌표(Y-up)** 이고 RPC 는 **언리얼 좌표(Z-up)** 다.
 * 같은 대상을 양쪽에서 읽어 대조했더니 두 건 모두 정확히 맞았다:
 *
 * ```
 * Camera-1     파일 {x:-13.6,     y:13.5,    z:-36.3}
 *              RPC  {x:-36.3,     y:-13.6,   z:13.5}
 *
 * 차량 0-13.50.46  파일 {x:-8.167922, y:0.0220000744, z:14.76307}
 *                  RPC  {x:14.763070, y:-8.1679220,   z:0.02200007}
 * ```
 *
 * 곧 **`RPC(x, y, z) = 파일(z, x, y)`** 이고 그 역이 **`파일(x, y, z) = RPC(y, z, x)`** 다.
 * 교차 확인: `measure.cameraHeight` 가 13.5 를 주고 파일의 `y` 가 13.5 다 —
 * **파일의 높이는 `y`, RPC 의 높이는 `z`**.
 *
 * ## 왜 이 파일이 따로 있는가
 *
 * 변환을 쓰는 곳마다 손으로 적으면 한 곳만 틀려도 **카메라가 땅속으로 들어가거나 맵 밖으로
 * 날아간다.** 그리고 그 실패는 화면에 오류로 뜨지 않는다 — 좌표가 "그럴듯하게" 틀리기
 * 때문이다. 그래서 축을 바꾸는 자리는 여기 둘뿐이어야 한다.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 저장 파일(Unity Y-up) → RPC(언리얼 Z-up). */
export function fileToRpc(v: Vec3): Vec3 {
  return { x: v.z, y: v.x, z: v.y };
}

/** RPC(언리얼 Z-up) → 저장 파일(Unity Y-up). */
export function rpcToFile(v: Vec3): Vec3 {
  return { x: v.y, y: v.z, z: v.x };
}

/** 숫자가 아닌 자리는 0 으로 본다 — 없는 축을 `undefined` 로 흘리면 RPC 가 조용히 0 을 쓴다. */
export function vec3(raw: unknown): Vec3 {
  const source = (raw ?? {}) as Record<string, unknown>;
  const read = (key: string): number => {
    const value = Number(source[key]);
    return Number.isFinite(value) ? value : 0;
  };
  return { x: read('x'), y: read('y'), z: read('z') };
}
