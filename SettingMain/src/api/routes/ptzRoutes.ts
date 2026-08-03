import { waitForSettle } from '../../devices/waitForSettle.js';
import { limitedAxes, nudge, toView, type Axis, type PtzRaw } from '../../domain/ptz.js';
import { HttpError, optionalNumber, readJsonBody, requireNumber, requireString, sendJson } from '../httpUtil.js';
import { asId, type RouteHandler } from './routeContext.js';

const AXES: readonly Axis[] = ['pan', 'tilt', 'zoom'];

export const ptzRoutes: RouteHandler = async (ctx) => {
  const { req, res, deps, pathname, method, driverFor } = ctx;

  if (method === 'GET' && pathname === '/api/ptz') {
    const { camera, driver } = driverFor();
    sendJson(res, 200, { cameraId: camera.id, ptz: toView(await driver.getPtz()) });
    return true;
  }

  if (method === 'POST' && pathname === '/api/ptz/absolute') {
    const body = await readJsonBody(req);
    const { camera, driver } = driverFor(asId(body.cameraId));
    const requested: PtzRaw = {
      pan: requireNumber(body, 'pan'),
      tilt: requireNumber(body, 'tilt'),
      zoom: requireNumber(body, 'zoom'),
    };
    const limited = limitedAxes(requested);
    await driver.goPtz(requested, optionalNumber(body, 'speed'));
    // 명령 직후 읽으면 이동 중간값이 잡힌다 — 멈출 때까지 기다린 뒤 최종 좌표를 답한다.
    const settle = await waitForSettle(driver, deps.settleOptions);
    // 잘린 축은 숨기지 않는다 — 착지가 어긋났다는 유일한 신호다.
    sendJson(res, 200, { cameraId: camera.id, ptz: toView(settle.ptz), limited, settled: settle.settled });
    return true;
  }

  if (method === 'POST' && pathname === '/api/ptz/nudge') {
    const body = await readJsonBody(req);
    const axis = requireString(body, 'axis') as Axis;
    if (!AXES.includes(axis)) throw new HttpError(400, `axis 는 ${AXES.join(' · ')} 중 하나여야 합니다`);
    const { camera, driver } = driverFor(asId(body.cameraId));
    // 기준 자세도 **멈춘 값**이어야 한다. 이동 중간값을 기준으로 델타를 더하면
    // 누를 때마다 목표가 조금씩 뒤로 밀려 "눌러도 안 움직인다"가 된다(UE 시뮬 실측).
    const current = (await waitForSettle(driver, deps.settleOptions)).ptz;
    const target = nudge(current, axis, requireNumber(body, 'delta'));
    const limited = target[axis] === current[axis] && axis !== 'pan' ? [axis] : [];
    await driver.goPtz(target, optionalNumber(body, 'speed'));
    const settle = await waitForSettle(driver, deps.settleOptions);
    sendJson(res, 200, { cameraId: camera.id, ptz: toView(settle.ptz), limited, settled: settle.settled });
    return true;
  }


  return false;
};
