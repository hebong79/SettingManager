/**
 * **이 서브트리가 SettingMain 에 매달린 유일한 자리.**
 *
 * `src/devices/idis/` 의 다른 모든 파일은 `./contract.js` 만 import 한다 — `../` 로 시작하는
 * import 는 이 파일에만 존재한다. 폴더째 다른 프로젝트로 옮길 때 고칠 파일이 정확히 1개가
 * 되게 하기 위해서다(옮기고 하나를 빠뜨리면 빌드가 아니라 런타임 `ERR_MODULE_NOT_FOUND`
 * 에서 터진다).
 *
 * **런타임 값 의존은 `CameraDriverError` 하나뿐**이고 나머지 넷은 타입이다. 즉 옮긴 곳에서는
 * `statusCode` 를 갖는 등가 오류 클래스 하나만 있으면 된다.
 *
 * `domain/ptz.js` 에서는 `PtzRaw` **타입만** 가져온다 — 그쪽의 `clampPtz`·`wrapPan` 은
 * **계약 범위**(tilt −2000..9000, zoom 0..65535)로 자르는데, IDIS 에 보내기 전 잘라야 하는
 * 것은 **이 기기의 와이어 범위**다. 계약 상수로 자르면 `zoom=65535` 가 그대로 나가고 기기가
 * 조용히 1200 으로 클램프한다(실측). 그래서 클램프는 `idisCoords.ts` 가 자체로 갖는다.
 */

export type { CameraDriver, CenterPoint, Slot } from '../cameraDriver.js';
export { CameraDriverError } from '../cameraDriver.js';
export type { PtzRaw } from '../../domain/ptz.js';
