import { createCoreProvider, type CoreProviderDeps } from '../../core/providerFactory.js';
import type { CoreContext } from '../../core/coreProvider.js';
import type { CalibrationComponent } from '../../calibration/calibrationComponent.js';
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
export function createCoreRoutes(deps: CoreProviderDeps, calibration?: CalibrationComponent): RouteHandler {
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

    // --- 차량 3D 육면체 ----------------------------------------------------
    if (method === 'GET' && pathname === '/api/core/vehicle-box/status') {
      sendJson(res, 200, await provider.vehicleBox.status(coreCtx));
      return true;
    }
    if (method === 'POST' && pathname === '/api/core/vehicle-box') {
      sendJson(res, 200, { provider: provider.name, ...(await provider.vehicleBox.detect(coreCtx)) });
      return true;
    }
    // 저장된 검출 이력. **브리지 전용 능력**이라 포트에 두지 않았다 — 원격 코어(backend-core)는
    // 검출을 저장하지 않으므로, 포트에 넣으면 그쪽이 영원히 501 인 표면이 하나 늘어난다.
    if (method === 'GET' && pathname === '/api/core/vehicle-box/history') {
      const component = deps.components?.vehicleBox;
      if (!component) throw new HttpError(501, '차량 3D 육면체 컴포넌트가 배선되지 않았습니다');
      const limit = Number(ctx.searchParams.get('limit') ?? 20);
      sendJson(res, 200, { cameraId: camera.id, records: component.history(camera, Number.isFinite(limit) ? limit : 20) });
      return true;
    }

    // --- 커미셔닝 주차면 ---------------------------------------------------
    // `/api/slots`(시뮬·로컬 목록)와 다른 것이다 — 여기는 사람이 확정해 저장한 조준해다.
    if (pathname === '/api/core/slots') {
      if (method === 'GET') {
        sendJson(res, 200, { cameraId: camera.id, ...(await provider.parkingSlots.list(coreCtx)) });
        return true;
      }
      if (method === 'POST') {
        const input = {
          x: requireCenterCoordinate(body!, 'x', 1920),
          y: requireCenterCoordinate(body!, 'y', 1080),
          ...(typeof body!.name === 'string' ? { name: body!.name } : {}),
          ...(body!.box !== undefined ? { box: body!.box } : {}),
        };
        sendJson(res, 200, { cameraId: camera.id, ...(await provider.parkingSlots.create(coreCtx, input)) });
        return true;
      }
    }
    const slot = /^\/api\/core\/slots\/([^/]+)(\/goto)?$/.exec(pathname);
    if (slot) {
      const slotId = decodeURIComponent(slot[1]!);
      if (slot[2] && method === 'POST') {
        sendJson(res, 200, { cameraId: camera.id, ...(await provider.parkingSlots.goto(coreCtx, slotId)) });
        return true;
      }
      if (!slot[2] && method === 'DELETE') {
        sendJson(res, 200, { cameraId: camera.id, ...(await provider.parkingSlots.remove(coreCtx, slotId)) });
        return true;
      }
    }

    // --- 캘리브레이션 발행 --------------------------------------------------
    //
    // 스윕이 끝나자마자 자동 발행하지 않는 이유가 둘이다: 게이트에 걸렸을 때 사람이
    // 「그래도 발행」을 고를 여지가 있어야 하고, 돌려 **보기만** 할 수도 있어야 한다.
    if (method === 'POST' && pathname === '/api/core/calibration/mint') {
      if (!calibration) throw new HttpError(501, '캘리브레이션 컴포넌트가 배선되지 않았습니다');
      sendJson(res, 200, {
        cameraId: camera.id,
        ...(await calibration.mint(camera, { apply: body?.apply !== false, force: body?.force === true })),
      });
      return true;
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
