import { createDetector, detectorUnavailableReason } from '../../detectors/detectorFactory.js';
import { DETECTOR_NAMES, type DetectorName } from '../../detectors/detectorTypes.js';
import { HttpError, sendJson } from '../httpUtil.js';
import type { RouteHandler } from './routeContext.js';

/**
 * API 계층(VPD·LPD·LPR) 로 나가는 얇은 통로.
 *
 * 이 라우트는 **이미지를 받지 않는다** — 대상 카메라의 스냅샷을 이쪽에서 찍어 보낸다.
 * 브라우저가 프레임을 받아 되올려 보내면 같은 그림이 망을 두 번 건너고, 그 사이에 카메라가
 * 움직이면 "언제 찍힌 그림인지" 아무도 답할 수 없게 된다.
 */
export const detectorRoutes: RouteHandler = async (ctx) => {
  const { res, deps, pathname, method, driverFor } = ctx;

  if (method === 'GET' && pathname === '/api/detectors') {
    const config = deps.configStore.get();
    sendJson(res, 200, {
      detectors: DETECTOR_NAMES.map((name) => {
        // 실제 호출과 **같은 판정 함수**를 쓴다 — 여기서 쓸 수 있다고 답한 것은 반드시 호출된다.
        const reason = detectorUnavailableReason(name, config);
        return {
          name,
          available: reason === undefined,
          ...(reason ? { reason } : {}),
          baseUrl: config.detectors[name].baseUrl,
          timeoutMs: config.detectors[name].timeoutMs,
        };
      }),
    });
    return true;
  }

  const detect = /^\/api\/detectors\/([^/]+)\/detect$/.exec(pathname);
  if (method === 'POST' && detect) {
    const name = detect[1] as DetectorName;
    if (!DETECTOR_NAMES.includes(name)) {
      throw new HttpError(404, `알 수 없는 검출기입니다: ${detect[1]} (가능: ${DETECTOR_NAMES.join('·')})`);
    }
    const { camera, config, driver } = driverFor();
    // **검출기를 먼저 세운다.** 쓸 수 없는 검출기 때문에 카메라를 괜히 두드리면, 501 이어야 할
    // 답이 카메라 통신 실패 502 로 뒤덮여 진짜 사유가 사라진다(실기 확인된 순서 버그).
    const client = createDetector(name, config, deps.fetchImpl);
    const image = await driver.getSnapshot();
    sendJson(res, 200, { cameraId: camera.id, ...(await client.detect(image)) });
    return true;
  }

  return false;
};
