import { createCoreProvider, type CoreProviderDeps } from '../../core/providerFactory.js';
import type { CoreContext } from '../../core/coreProvider.js';
import { HttpError, readJsonBody, requireString, sendJson } from '../httpUtil.js';
import { asId, requireCenterCoordinate, type RouteHandler } from './routeContext.js';

/**
 * 카메라 코어 — **기능 하나에 경로 하나.**
 *
 * 어느 구현(bridge·remote)이 답하든 URL·요청·응답 모양이 같다. 화면은 구현 이름으로
 * 분기하지 않고 `GET /api/core/capabilities` 로 무엇을 할 수 있는지만 묻는다.
 *
 * 이 파일에는 `if (provider === …)` 가 없다 — 구현 분기는 `core/providerFactory.ts` 하나뿐이다.
 */
export function createCoreRoutes(deps: CoreProviderDeps): RouteHandler {
  return async (ctx) => {
    const { req, res, pathname, method, driverFor } = ctx;
    if (!pathname.startsWith('/api/core/')) return false;

    const body = ['POST', 'PUT'].includes(method) ? await readJsonBody(req) : undefined;
    const { camera, config, driver } = driverFor(asId(body?.cameraId));
    const provider = createCoreProvider(camera, config, deps);
    const coreCtx: CoreContext = { camera, driver };

    // --- 능력 --------------------------------------------------------------
    if (method === 'GET' && pathname === '/api/core/capabilities') {
      sendJson(res, 200, await provider.capabilities(coreCtx));
      return true;
    }

    // --- 센터링 ------------------------------------------------------------
    if (method === 'POST' && pathname === '/api/core/center') {
      const point = { x: requireCenterCoordinate(body!, 'x', 1920), y: requireCenterCoordinate(body!, 'y', 1080) };
      sendJson(res, 200, { provider: provider.name, ...(await provider.center(coreCtx, point)) });
      return true;
    }
    if (method === 'POST' && pathname === '/api/core/center-box') {
      const box = {
        startX: requireCenterCoordinate(body!, 'startX', 1920),
        startY: requireCenterCoordinate(body!, 'startY', 1080),
        endX: requireCenterCoordinate(body!, 'endX', 1920),
        endY: requireCenterCoordinate(body!, 'endY', 1080),
      };
      sendJson(res, 200, { provider: provider.name, ...(await provider.centerBox(coreCtx, box)) });
      return true;
    }

    // --- 탐색 프리셋·점 ----------------------------------------------------
    const preset = /^\/api\/core\/discovery\/presets\/([^/]+)(?:\/points(?:\/([^/]+))?)?(\/goto)?$/.exec(pathname);
    if (pathname === '/api/core/discovery/presets') {
      if (method === 'GET') {
        sendJson(res, 200, { cameraId: camera.id, ...(await provider.discoveryPresets.list(coreCtx)) });
        return true;
      }
      if (method === 'POST') {
        sendJson(res, 200, { cameraId: camera.id, ...(await provider.discoveryPresets.create(coreCtx, body!)) });
        return true;
      }
    }
    if (preset) {
      const presetId = decodeURIComponent(preset[1]!);
      const pointId = preset[2] ? decodeURIComponent(preset[2]) : undefined;
      const send = (result: Record<string, unknown>) => sendJson(res, 200, { cameraId: camera.id, ...result });

      if (preset[3] && method === 'POST') {
        send(await provider.discoveryPresets.goto(coreCtx, presetId));
        return true;
      }
      if (pathname.includes('/points')) {
        if (method === 'GET') send(await provider.discoveryPoints.list(coreCtx, presetId));
        else if (method === 'POST') send(await provider.discoveryPoints.create(coreCtx, presetId, body ?? {}));
        else if (method === 'PUT') {
          if (!pointId) throw new HttpError(404, `찾을 수 없습니다: ${method} ${pathname}`);
          send(await provider.discoveryPoints.update(coreCtx, presetId, pointId, body ?? {}));
        } else if (method === 'DELETE') send(await provider.discoveryPoints.remove(coreCtx, presetId, pointId));
        else throw new HttpError(404, `찾을 수 없습니다: ${method} ${pathname}`);
        return true;
      }
      if (!pointId && method === 'PUT') {
        send(await provider.discoveryPresets.update(coreCtx, presetId, body!));
        return true;
      }
      if (!pointId && method === 'DELETE') {
        send(await provider.discoveryPresets.remove(coreCtx, presetId));
        return true;
      }
    }

    // --- 잡(캘리브레이션·번호판 호밍) --------------------------------------
    const job = /^\/api\/core\/(calibration|plate-homing)\/(start|status|stop)$/.exec(pathname);
    if (job) {
      const port = job[1] === 'calibration' ? provider.calibration : provider.plateHoming;
      const action = job[2];
      if (action === 'status' && method === 'GET') {
        sendJson(res, 200, { cameraId: camera.id, ...(await port.status(coreCtx)) });
        return true;
      }
      if (action === 'stop' && method === 'POST') {
        sendJson(res, 200, { cameraId: camera.id, ...(await port.stop(coreCtx)) });
        return true;
      }
      if (action === 'start' && method === 'POST') {
        const options = job[1] === 'calibration' ? calibrationOptions(body!) : plateHomingOptions(body!);
        sendJson(res, 200, { cameraId: camera.id, ...(await (port.start as (c: CoreContext, o: unknown) => Promise<Record<string, unknown>>)(coreCtx, options)) });
        return true;
      }
    }

    throw new HttpError(404, `찾을 수 없습니다: ${method} ${pathname}`);
  };
}

function calibrationOptions(body: Record<string, unknown>): { mode: 'full' | 'verify' } {
  const mode = requireString(body, 'mode');
  if (mode !== 'full' && mode !== 'verify') throw new HttpError(400, 'mode 는 full 또는 verify 여야 합니다');
  return { mode };
}

function plateHomingOptions(body: Record<string, unknown>): { presetId: string; pointIds?: string[] } {
  const presetId = requireString(body, 'presetId');
  if (body.pointIds === undefined) return { presetId };
  if (!Array.isArray(body.pointIds) || !body.pointIds.every((id) => typeof id === 'string' && id.trim())) {
    throw new HttpError(400, 'pointIds 는 비어 있지 않은 문자열 배열이어야 합니다');
  }
  return { presetId, pointIds: body.pointIds as string[] };
}
