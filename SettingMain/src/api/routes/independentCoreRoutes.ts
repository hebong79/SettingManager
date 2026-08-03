import { CameraLeaseError } from '../../independentCameraCore/cameraLease.js';
import type { IndependentCameraCore } from '../../independentCameraCore/independentCameraCore.js';
import { HttpError, readJsonBody, sendJson } from '../httpUtil.js';
import { requireCenterCoordinate, type RouteHandler } from './routeContext.js';

/**
 * SettingMain 독립 CameraCore 라우트.
 *
 * ⚠ **폐기 예정** — 같은 일(센터링)을 하는 세 번째 경로다. `docs/20260803_141528_전체구조_정리.md`
 * §3 S1 의 근거이며, M6 에서 `/api/core/*` 단일 경로로 흡수하고 이 파일은 삭제한다.
 * M2 에서는 **동작을 바꾸지 않기 위해** 그대로 옮겨만 둔다.
 */
export function createIndependentCoreRoutes(core: IndependentCameraCore): RouteHandler {
  return async ({ req, res, pathname, method, driverFor }) => {
    const route = /^\/api\/independent-core\/cameras\/([^/]+)\/(capabilities|center)$/.exec(pathname);
    if (!route) return false;

    const cameraId = decodeURIComponent(route[1]!);
    const action = route[2]!;
    const { camera, driver } = driverFor(cameraId);

    if (method === 'GET' && action === 'capabilities') {
      sendJson(res, 200, core.capability(camera.id, driver));
      return true;
    }

    if (method === 'POST' && action === 'center') {
      const body = await readJsonBody(req);
      const point = { x: requireCenterCoordinate(body, 'x', 1920), y: requireCenterCoordinate(body, 'y', 1080) };
      try {
        const result = await core.center(camera.id, driver, point);
        sendJson(res, 200, { cameraId: camera.id, ...result });
      } catch (error) {
        if (error instanceof CameraLeaseError) throw new HttpError(409, error.message);
        throw error;
      }
      return true;
    }

    throw new HttpError(404, `찾을 수 없습니다: ${method} ${pathname}`);
  };
}
