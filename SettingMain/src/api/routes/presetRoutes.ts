import { waitForSettle } from '../../devices/waitForSettle.js';
import { toView } from '../../domain/ptz.js';
import { HttpError, readJsonBody, requireString, sendJson } from '../httpUtil.js';
import { asId, readPtz, type RouteHandler } from './routeContext.js';

/** SettingManager 자체 프리셋(이름 + 좌표). 장비 내장 프리셋과는 별개의 정본이다. */
export const presetRoutes: RouteHandler = async (ctx) => {
  const { req, res, deps, pathname, method, driverFor } = ctx;

  if (pathname === '/api/presets') {
    if (method === 'GET') {
      const { camera } = driverFor();
      sendJson(res, 200, { cameraId: camera.id, presets: deps.presetStore.list(camera.id) });
      return true;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const { camera, driver } = driverFor(asId(body.cameraId));
      // ptz 를 안 주면 현재 자세를 저장한다 — 좌표를 지어내지 않는다.
      const ptz = readPtz(body) ?? (await driver.getPtz());
      const preset = await deps.presetStore.add({ cameraId: camera.id, name: requireString(body, 'name'), ptz });
      sendJson(res, 200, { preset });
      return true;
    }
  }

  const presetGoto = /^\/api\/presets\/([^/]+)\/goto$/.exec(pathname);
  if (method === 'POST' && presetGoto) {
    const preset = deps.presetStore.get(decodeURIComponent(presetGoto[1]!));
    if (!preset) throw new HttpError(404, '프리셋을 찾을 수 없습니다');
    const { driver } = driverFor(preset.cameraId);
    await driver.goPtz(preset.ptz);
    const settle = await waitForSettle(driver, deps.settleOptions);
    sendJson(res, 200, { preset, ptz: toView(settle.ptz), settled: settle.settled });
    return true;
  }

  const presetItem = /^\/api\/presets\/([^/]+)$/.exec(pathname);
  if (presetItem) {
    const id = decodeURIComponent(presetItem[1]!);
    if (method === 'PUT') {
      const body = await readJsonBody(req);
      const name = body.name === undefined ? undefined : requireString(body, 'name');
      const preset = await deps.presetStore.update(id, { name, ptz: readPtz(body) });
      sendJson(res, 200, { preset });
      return true;
    }
    if (method === 'DELETE') {
      const removed = await deps.presetStore.remove(id);
      sendJson(res, 200, { removed: removed.id });
      return true;
    }
  }

  return false;
};

/** 주차면 목록. 시뮬은 씬이 진실의 출처이고, 실카메라는 답할 곳이 없어 로컬 등록본을 쓴다. */
export const slotRoutes: RouteHandler = async ({ res, deps, pathname, method, driverFor }) => {
  if (method !== 'GET' || pathname !== '/api/slots') return false;
  const { camera, driver } = driverFor();
  const fromDriver = await driver.listSlots().catch(() => [] as never[]);
  const slots = fromDriver.length > 0 ? fromDriver : deps.slotStore.list(camera.id);
  sendJson(res, 200, { cameraId: camera.id, source: fromDriver.length > 0 ? 'simulator' : 'local', slots });
  return true;
};
