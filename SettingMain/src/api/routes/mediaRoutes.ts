import type { IncomingMessage, ServerResponse } from 'node:http';
import { createDriver, findCamera } from '../../devices/driverFactory.js';
import { createFrameSource } from '../../media/frameSource.js';
import { sendError } from '../httpUtil.js';
import type { RouteHandler, ServerDeps } from './routeContext.js';

const MJPEG_BOUNDARY = 'settingmanager-frame';

export const mediaRoutes: RouteHandler = async (ctx) => {
  const { req, res, deps, pathname, method, searchParams, driverFor } = ctx;

  if (method === 'GET' && pathname === '/api/snapshot') {
    const { driver } = driverFor();
    const jpeg = await driver.getSnapshot();
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': jpeg.length, 'cache-control': 'no-store' });
    res.end(jpeg);
    return true;
  }

  if (method === 'GET' && pathname === '/api/stream') {
    await streamMjpeg(req, res, deps, searchParams.get('cameraId') ?? undefined);
    return true;
  }

  return false;
};

/** multipart/x-mixed-replace 로 프레임을 밀어 넣는다. 브라우저는 <img src> 로 그대로 받는다. */
async function streamMjpeg(req: IncomingMessage, res: ServerResponse, deps: ServerDeps, cameraId?: string): Promise<void> {
  const config = deps.configStore.get();
  const camera = findCamera(config, cameraId);
  const driver = createDriver(camera, config, deps.fetchImpl);
  const source = createFrameSource(camera, driver, config.streaming);

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  let headerSent = false;
  try {
    for await (const frame of source(controller.signal)) {
      if (!headerSent) {
        res.writeHead(200, {
          'content-type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
          'cache-control': 'no-store',
          connection: 'close',
        });
        headerSent = true;
      }
      if (res.writableEnded) break;
      res.write(`--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
      res.write(frame);
      res.write('\r\n');
    }
  } catch (error) {
    // 첫 프레임 전에 실패하면 아직 헤더를 안 보냈으므로 정직한 상태코드를 줄 수 있다.
    if (!headerSent) {
      sendError(res, 502, error instanceof Error ? error.message : String(error));
      return;
    }
  } finally {
    controller.abort();
    if (!res.writableEnded) res.end();
  }
}
