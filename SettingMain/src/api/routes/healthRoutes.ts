import { sendJson } from '../httpUtil.js';
import type { RouteHandler } from './routeContext.js';

export const healthRoutes: RouteHandler = async ({ res, deps, pathname, method }) => {
  if (method !== 'GET' || pathname !== '/api/health') return false;
  sendJson(res, 200, { ok: true, service: 'settingmanager', activeCameraId: deps.configStore.get().activeCameraId });
  return true;
};
