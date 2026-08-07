import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { CameraDriverError } from '../devices/cameraDriver.js';
import { CoreBusyError, CoreNotFoundError, CoreUnsupportedError } from '../core/coreProvider.js';
import { DetectorError, DetectorUnsupportedError } from '../detectors/detectorTypes.js';
import { DatabaseError } from '../db/database.js';
import { ConfigError } from '../config/normalize.js';
import { PresetError } from '../domain/preset.js';
import { CalibrationError } from '../calibration/calibrationJob.js';
import { HomeTraceError } from '../homing/homeTraceStore.js';
import { PlateHomingError } from '../homing/plateHomingJob.js';
import { PlateHomingUnsupported } from '../homing/plateHomingComponent.js';
import { SoftwareCenteringError } from '../centering/softwareCentering.js';
import { ProfileError, ProfileStore } from '../profiles/profileStore.js';
import { DbIntrinsicsSink } from '../profiles/dbIntrinsicsSink.js';
import { HttpError, sendError } from './httpUtil.js';
import { CameraLeaseRegistry, createCoreComponents } from '../core/providerFactory.js';
import { createCoreRoutes } from './routes/coreRoutes.js';
import { createProfileRoutes } from './routes/profileRoutes.js';
import { dbRoutes } from './routes/dbRoutes.js';
import { detectorRoutes } from './routes/detectorRoutes.js';
import { devicePresetRoutes } from './routes/devicePresetRoutes.js';
import { healthRoutes } from './routes/healthRoutes.js';
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
  // 카메라별 점유는 프로세스 수명 동안 유지돼야 하므로 서버당 하나만 만든다.
  const leases = new CameraLeaseRegistry();

  // 발행본 저장소. **런타임 적용본은 DB** 이고, DB 가 없으면 적용할 곳이 없으므로 발행도
  // `apply:false` 로만 가능하다(그 경우 `ProfileStore` 가 501 + 사유로 거절한다).
  const profiles = deps.profiles
    ?? new ProfileStore({ sink: deps.db ? new DbIntrinsicsSink(deps.db, deps.configStore) : undefined });

  // **세 컴포넌트는 프로세스당 하나다.** 요청마다 만들면 20분짜리 스윕 기록이 폴링마다 사라진다.
  const components = createCoreComponents({
    config: deps.configStore.get(),
    profiles,
    settleOptions: deps.settleOptions,
    fetchImpl: deps.fetchImpl,
    db: deps.db,
  });

  const coreRoutes = createCoreRoutes(
    { leases, settleOptions: deps.settleOptions, fetchImpl: deps.fetchImpl, db: deps.db, components },
    components.calibration,
  );

  /** 순서가 계약이다 — 앞선 라우트가 false 를 돌려줘야 다음이 본다. */
  const handlers: RouteHandler[] = [
    healthRoutes,
    coreRoutes,
    createProfileRoutes(profiles),
    settingsRoutes,
    dbRoutes,
    detectorRoutes,
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
  if (error instanceof CoreNotFoundError) return sendError(res, error.statusCode, error.message);
  if (error instanceof ProfileError) return sendError(res, error.statusCode, error.message);
  if (error instanceof CalibrationError) return sendError(res, error.statusCode, error.message);
  if (error instanceof PlateHomingUnsupported) return sendError(res, error.statusCode, error.message);
  if (error instanceof PlateHomingError) return sendError(res, error.statusCode, error.message);
  // 경로 조작은 **403** 이다 — 404 로 뭉개면 "없다"와 "주면 안 된다"가 구별되지 않는다.
  if (error instanceof HomeTraceError) return sendError(res, error.statusCode, error.message);
  if (error instanceof SoftwareCenteringError) return sendError(res, error.statusCode, error.message);
  if (error instanceof DetectorUnsupportedError) return sendError(res, error.statusCode, error.message);
  if (error instanceof DetectorError) return sendError(res, error.statusCode, error.message);
  if (error instanceof DatabaseError) return sendError(res, error.statusCode, error.message);
  if (error instanceof CameraDriverError) return sendError(res, error.statusCode, error.message);
  if (error instanceof ConfigError) return sendError(res, error.statusCode, error.message);
  sendError(res, 500, error instanceof Error ? error.message : String(error));
}
