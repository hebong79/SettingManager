import { BackendCoreClient } from '../../devices/backendCore/backendCoreClient.js';
import { findCamera } from '../../devices/driverFactory.js';
import { HttpError, optionalNumber, readJsonBody, requireNumber, requireString, sendJson } from '../httpUtil.js';
import type { RouteHandler } from './routeContext.js';

/**
 * BackendCore 탐색·보정 프록시.
 *
 * ⚠ **폐기 예정** — 기능 가용성이 `?useBackendCore=1` 질의 파라미터에 매달려 있다.
 * `docs/20260803_141528_전체구조_정리.md` §3 S3 의 근거이며, M5 에서 `/api/core/*` 와
 * 설정 기반 provider 선택으로 대체한다. M2 에서는 **동작을 바꾸지 않기 위해** 옮겨만 둔다.
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

  // BackendCore discovery point는 x/y/name만 영속화한다. 별도 box 정본을 만들지 않는
  // 한 point 기반 "센터+줌"은 성공 경로가 없으므로, 직접 box를 받아 우회시키지 않는다.
  if (pathname === '/api/center-box') {
    throw new HttpError(501, 'BackendCore discovery point는 box 좌표를 저장하지 않아 개별 센터+줌을 지원하지 않습니다');
  }

  const client = new BackendCoreClient({ cameraId: camera.id, baseUrl: config.simulator.baseUrl, timeoutMs: camera.timeoutMs, fetchImpl: deps.fetchImpl });
  const body = ['POST', 'PUT'].includes(method) ? await readJsonBody(req) : undefined;
  const preset = /^\/api\/discovery\/presets\/([^/]+)(?:\/points(?:\/([^/]+))?)?(\/goto)?$/.exec(pathname);

  let result: Record<string, unknown>;
  if (pathname === '/api/discovery/presets' && ['GET', 'POST'].includes(method)) {
    result = method === 'GET' ? await client.listDiscoveryPresets() : await client.createDiscoveryPreset(body!);
  } else if (preset) {
    const presetId = decodeURIComponent(preset[1]!);
    const pointId = preset[2] ? decodeURIComponent(preset[2]) : undefined;
    if (preset[3] && method === 'POST') result = await client.gotoDiscoveryPreset(presetId);
    else if (pathname.includes('/points')) {
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) throw new HttpError(404, `찾을 수 없습니다: ${method} ${pathname}`);
      result = await client.discoveryPoints(method as 'GET' | 'POST' | 'PUT' | 'DELETE', presetId, pointId, body);
    } else if (!pointId && ['PUT', 'DELETE'].includes(method)) {
      result = method === 'PUT' ? await client.updateDiscoveryPreset(presetId, body!) : await client.deleteDiscoveryPreset(presetId);
    } else throw new HttpError(404, `찾을 수 없습니다: ${method} ${pathname}`);
  } else if (pathname === '/api/discovery/calibration/status' && method === 'GET') result = await client.calibration('status');
  else if (pathname === '/api/discovery/calibration/start' && method === 'POST') result = await client.calibration('start', calibrationBody(body!));
  else if (pathname === '/api/discovery/calibration/stop' && method === 'POST') result = await client.calibration('stop');
  else if (pathname === '/api/discovery/plate-home/status' && method === 'GET') result = await client.plateHome('status');
  else if (pathname === '/api/discovery/plate-home/start' && method === 'POST') result = await client.plateHome('start', plateHomeBody(body!));
  else if (pathname === '/api/discovery/plate-home/stop' && method === 'POST') result = await client.plateHome('stop');
  else if (pathname === '/api/center' && method === 'POST') result = await client.center(centerBody(body!));
  else throw new HttpError(404, `찾을 수 없습니다: ${method} ${pathname}`);

  sendJson(res, 200, { cameraId: camera.id, ...result });
  return true;
};

function calibrationBody(body: Record<string, unknown>): Record<string, unknown> {
  const mode = requireString(body, 'mode');
  if (mode !== 'full' && mode !== 'verify') throw new HttpError(400, 'mode 는 full 또는 verify 여야 합니다');
  return { mode };
}

function centerBody(body: Record<string, unknown>): Record<string, unknown> {
  return {
    x: requireNumber(body, 'x'),
    y: requireNumber(body, 'y'),
    frameWidth: optionalNumber(body, 'frameWidth') ?? 1920,
    frameHeight: optionalNumber(body, 'frameHeight') ?? 1080,
    speed: optionalNumber(body, 'speed') ?? 50,
  };
}

function plateHomeBody(body: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { presetId: requireString(body, 'presetId') };
  if (body.pointIds !== undefined) {
    if (!Array.isArray(body.pointIds) || !body.pointIds.every((id) => typeof id === 'string' && id.trim())) {
      throw new HttpError(400, 'pointIds 는 비어 있지 않은 문자열 배열이어야 합니다');
    }
    result.pointIds = body.pointIds;
  }
  return result;
}
