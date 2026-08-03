import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { CameraDriverError } from '../devices/cameraDriver.js';
import { CoreBusyError, CoreUnsupportedError } from '../core/coreProvider.js';
import { ConfigError } from '../config/normalize.js';
import { PresetError } from '../domain/preset.js';
import { IndependentCameraCore } from '../independentCameraCore/independentCameraCore.js';
import { HttpError, sendError } from './httpUtil.js';
import { devicePresetRoutes } from './routes/devicePresetRoutes.js';
import { discoveryRoutes } from './routes/discoveryRoutes.js';
import { healthRoutes } from './routes/healthRoutes.js';
import { createIndependentCoreRoutes } from './routes/independentCoreRoutes.js';
import { mediaRoutes } from './routes/mediaRoutes.js';
import { presetRoutes, slotRoutes } from './routes/presetRoutes.js';
import { ptzRoutes } from './routes/ptzRoutes.js';
import { createRouteContext, type RouteHandler, type ServerDeps } from './routes/routeContext.js';
import { settingsRoutes } from './routes/settingsRoutes.js';
import { serveStatic } from './staticFiles.js';

export type { ServerDeps } from './routes/routeContext.js';

/**
 * HTTP 조립과 디스패치만 한다.
 * 요청 해석·검증·응답은 `routes/` 의 각 모듈이 소유하고, 여기에는 비즈니스 판단을 두지 않는다.
 */
export function createServer(deps: ServerDeps): Server {
  // 독립 코어는 프로세스 수명 동안 점유 상태를 들고 있어야 하므로 서버당 하나만 만든다.
  const independentCore = new IndependentCameraCore(deps.settleOptions);

  /** 순서가 계약이다 — 앞선 라우트가 false 를 돌려줘야 다음이 본다. */
  const handlers: RouteHandler[] = [
    healthRoutes,
    createIndependentCoreRoutes(independentCore),
    discoveryRoutes,
    settingsRoutes,
    devicePresetRoutes,
    ptzRoutes,
    presetRoutes,
    slotRoutes,
    mediaRoutes,
  ];

  return createHttpServer((req, res) => {
    handle(req, res, deps, handlers).catch((error) => fail(res, error));
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ServerDeps, handlers: RouteHandler[]): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (!url.pathname.startsWith('/api/')) {
    // 확장자 없는 경로는 페이지로 본다: /options → options.html
    const candidate = url.pathname === '/' || url.pathname.includes('.') ? url.pathname : `${url.pathname}.html`;
    if (await serveStatic(res, candidate)) return;
    sendError(res, 404, `찾을 수 없습니다: ${url.pathname}`);
    return;
  }

  const ctx = createRouteContext(req, res, deps, url);
  for (const handler of handlers) {
    if (await handler(ctx)) return;
  }
  sendError(res, 404, `찾을 수 없습니다: ${ctx.method} ${ctx.pathname}`);
}

/** 오류를 상태코드로 옮기는 유일한 지점. 분류되지 않은 오류만 500 이 된다. */
function fail(res: ServerResponse, error: unknown): void {
  if (res.writableEnded) return;
  if (error instanceof HttpError) return sendError(res, error.status, error.message);
  if (error instanceof PresetError) return sendError(res, error.statusCode, error.message);
  if (error instanceof CoreUnsupportedError) return sendError(res, error.statusCode, error.message);
  if (error instanceof CoreBusyError) return sendError(res, error.statusCode, error.message);
  if (error instanceof CameraDriverError) return sendError(res, error.statusCode, error.message);
  if (error instanceof ConfigError) return sendError(res, error.statusCode, error.message);
  sendError(res, 500, error instanceof Error ? error.message : String(error));
}
