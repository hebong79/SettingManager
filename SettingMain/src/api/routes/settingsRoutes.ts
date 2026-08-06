import { toPublicCamera } from '../../config/normalize.js';
import type { SettingsPatch } from '../../config/types.js';
import { readJsonBody, requireString, sendJson } from '../httpUtil.js';
import type { RouteHandler } from './routeContext.js';

/**
 * 옵션 페이지가 쓰는 **설정** 조회·저장과 활성 기기 전환.
 *
 * **카메라 CRUD 는 여기 없다.** 카메라의 정본은 `camera_info`(DB)이고, 추가·수정·삭제·연결
 * 테스트는 전부 `/api/db/cameras` 가 맡는다. 여기 남은 카메라 관련 경로는 둘뿐이다 —
 * 목록 조회(`GET /api/cameras`)와 활성 전환(`POST /api/cameras/active`). 둘 다 **읽기**이거나
 * config 가 주인인 값(활성 선택)이라 이쪽에 남는 것이 맞다.
 */
export const settingsRoutes: RouteHandler = async (ctx) => {
  const { req, res, deps, pathname, method } = ctx;

  if (pathname === '/api/settings') {
    const config = deps.configStore.get();
    if (method === 'GET') {
      sendJson(res, 200, {
        simulator: config.simulator,
        core: config.core,
        streaming: config.streaming,
        activeCameraId: config.activeCameraId,
        cameras: config.cameras.map(toPublicCamera),
      });
      return true;
    }
    if (method === 'PUT') {
      const body = await readJsonBody(req);
      const next = await deps.configStore.patch(body as SettingsPatch);
      sendJson(res, 200, {
        saved: true,
        simulator: next.simulator,
        core: next.core,
        activeCameraId: next.activeCameraId,
        cameras: next.cameras.map(toPublicCamera),
      });
      return true;
    }
  }

  if (method === 'GET' && pathname === '/api/cameras') {
    const config = deps.configStore.get();
    sendJson(res, 200, { activeCameraId: config.activeCameraId, cameras: config.cameras.map(toPublicCamera) });
    return true;
  }

  if (method === 'POST' && pathname === '/api/cameras/active') {
    const body = await readJsonBody(req);
    const next = await deps.configStore.patch({ activeCameraId: requireString(body, 'id') });
    sendJson(res, 200, { activeCameraId: next.activeCameraId });
    return true;
  }

  return false;
};
