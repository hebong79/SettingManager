import { HttpBackendCoreTransport } from '../../devices/backendCore/backendCoreTransport.js';
import { createDriver, findCamera } from '../../devices/driverFactory.js';
import { RemoteCoreProvider } from '../../core/remote/remoteCoreProvider.js';
import type { CoreContext } from '../../core/coreProvider.js';
import { HttpError, optionalNumber, readJsonBody, requireNumber, requireString, sendJson } from '../httpUtil.js';
import type { RouteHandler } from './routeContext.js';

/**
 * BackendCore 탐색·보정 프록시.
 *
 * M4 에서 **호출을 `CoreProvider` 포트 뒤로 옮겼다** — 라우트는 이제 backend-core 를
 * 직접 알지 않고 `RemoteCoreProvider` 만 부른다. 응답 모양은 바뀌지 않았다.
 *
 * ⚠ **경로는 여전히 폐기 예정** — 기능 가용성이 `?useBackendCore=1` 질의 파라미터에 매달려 있다.
 * `docs/20260803_141528_전체구조_정리.md` §3 S3 의 근거이며, M5 에서 `/api/core/*` 와
 * 설정 기반 provider 선택으로 대체한다.
 */
const DISCOVERY_PATHS = ['/api/center', '/api/center-box'];

export function ownsDiscoveryPath(pathname: string): boolean {
  return pathname.startsWith('/api/discovery/') || DISCOVERY_PATHS.includes(pathname);
}

export const discoveryRoutes: RouteHandler = async (ctx) => {
  const { req, res, deps, pathname, method, searchParams } = ctx;
  if (!ownsDiscoveryPath(pathname)) return false;

  const config = deps.configStore.get();
  const camera = findCamera(config);
  if (searchParams.get('useBackendCore') !== '1') throw new HttpError(409, '주차면 탐색 화면의 BackendCore 사용 체크박스를 켜세요');
  if (!config.simulator.baseUrl) throw new HttpError(409, '옵션의 BackendCore URL을 먼저 설정하세요');

  const provider = new RemoteCoreProvider({
    transport: new HttpBackendCoreTransport({
      baseUrl: config.simulator.baseUrl,
      timeoutMs: camera.timeoutMs,
      fetchImpl: deps.fetchImpl,
    }),
  });
  const coreCtx: CoreContext = { camera, driver: createDriver(camera, config, deps.fetchImpl) };
  const body = ['POST', 'PUT'].includes(method) ? await readJsonBody(req) : undefined;

  // BackendCore discovery point는 x/y/name만 영속화한다. 별도 box 정본을 만들지 않는
  // 한 point 기반 "센터+줌"은 성공 경로가 없으므로, 직접 box를 받아 우회시키지 않는다.
  if (pathname === '/api/center-box') {
    await provider.centerBox(coreCtx, { startX: 0, startY: 0, endX: 0, endY: 0 });
    return true; // 위에서 반드시 CoreUnsupportedError(501) 가 난다
  }

  const preset = /^\/api\/discovery\/presets\/([^/]+)(?:\/points(?:\/([^/]+))?)?(\/goto)?$/.exec(pathname);
  let result: Record<string, unknown>;

  if (pathname === '/api/discovery/presets' && ['GET', 'POST'].includes(method)) {
    result = method === 'GET'
      ? await provider.discoveryPresets.list(coreCtx)
      : await provider.discoveryPresets.create(coreCtx, body!);
  } else if (preset) {
    const presetId = decodeURIComponent(preset[1]!);
    const pointId = preset[2] ? decodeURIComponent(preset[2]) : undefined;
    if (preset[3] && method === 'POST') result = await provider.discoveryPresets.goto(coreCtx, presetId);
    else if (pathname.includes('/points')) {
      if (method === 'GET') result = await provider.discoveryPoints.list(coreCtx, presetId);
      else if (method === 'POST') result = await provider.discoveryPoints.create(coreCtx, presetId, body ?? {});
      else if (method === 'PUT') {
        if (!pointId) throw new HttpError(404, `찾을 수 없습니다: ${method} ${pathname}`);
        result = await provider.discoveryPoints.update(coreCtx, presetId, pointId, body ?? {});
      } else if (method === 'DELETE') result = await provider.discoveryPoints.remove(coreCtx, presetId, pointId);
      else throw new HttpError(404, `찾을 수 없습니다: ${method} ${pathname}`);
    } else if (!pointId && method === 'PUT') result = await provider.discoveryPresets.update(coreCtx, presetId, body!);
    else if (!pointId && method === 'DELETE') result = await provider.discoveryPresets.remove(coreCtx, presetId);
    else throw new HttpError(404, `찾을 수 없습니다: ${method} ${pathname}`);
  } else if (pathname === '/api/discovery/calibration/status' && method === 'GET') result = await provider.calibration.status(coreCtx);
  else if (pathname === '/api/discovery/calibration/start' && method === 'POST') result = await provider.calibration.start(coreCtx, calibrationBody(body!));
  else if (pathname === '/api/discovery/calibration/stop' && method === 'POST') result = await provider.calibration.stop(coreCtx);
  else if (pathname === '/api/discovery/plate-home/status' && method === 'GET') result = await provider.plateHoming.status(coreCtx);
  else if (pathname === '/api/discovery/plate-home/start' && method === 'POST') result = await provider.plateHoming.start(coreCtx, plateHomeBody(body!));
  else if (pathname === '/api/discovery/plate-home/stop' && method === 'POST') result = await provider.plateHoming.stop(coreCtx);
  else if (pathname === '/api/center' && method === 'POST') result = await provider.center(coreCtx, centerPoint(body!));
  else throw new HttpError(404, `찾을 수 없습니다: ${method} ${pathname}`);

  sendJson(res, 200, { cameraId: camera.id, ...result });
  return true;
};

function calibrationBody(body: Record<string, unknown>): { mode: 'full' | 'verify' } {
  const mode = requireString(body, 'mode');
  if (mode !== 'full' && mode !== 'verify') throw new HttpError(400, 'mode 는 full 또는 verify 여야 합니다');
  return { mode };
}

function centerPoint(body: Record<string, unknown>): { x: number; y: number } {
  // frameWidth·frameHeight·speed 는 provider 가 계약값(1920×1080·50)으로 채운다.
  optionalNumber(body, 'frameWidth');
  optionalNumber(body, 'frameHeight');
  optionalNumber(body, 'speed');
  return { x: requireNumber(body, 'x'), y: requireNumber(body, 'y') };
}

function plateHomeBody(body: Record<string, unknown>): { presetId: string; pointIds?: string[] } {
  const presetId = requireString(body, 'presetId');
  if (body.pointIds === undefined) return { presetId };
  if (!Array.isArray(body.pointIds) || !body.pointIds.every((id) => typeof id === 'string' && id.trim())) {
    throw new HttpError(400, 'pointIds 는 비어 있지 않은 문자열 배열이어야 합니다');
  }
  return { presetId, pointIds: body.pointIds as string[] };
}
