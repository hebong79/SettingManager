import { createDriver, findCamera } from '../../devices/driverFactory.js';
import { mergeSettings, toPublicCamera } from '../../config/normalize.js';
import type { SettingsPatch } from '../../config/types.js';
import { toView } from '../../domain/ptz.js';
import { readJsonBody, requireString, sendJson } from '../httpUtil.js';
import type { RouteHandler } from './routeContext.js';

/** 옵션 페이지가 쓰는 설정 조회·저장과 기기 CRUD. */
export const settingsRoutes: RouteHandler = async (ctx) => {
  const { req, res, deps, pathname, method } = ctx;

  if (pathname === '/api/settings') {
    const config = deps.configStore.get();
    if (method === 'GET') {
      sendJson(res, 200, {
        simulator: config.simulator,
        core: config.core,
        streaming: config.streaming,
        activeCameraId: config.activeCameraId,
        cameras: config.cameras.map(toPublicCamera),
      });
      return true;
    }
    if (method === 'PUT') {
      const body = await readJsonBody(req);
      const next = await deps.configStore.patch(body as SettingsPatch);
      sendJson(res, 200, {
        saved: true,
        simulator: next.simulator,
        core: next.core,
        activeCameraId: next.activeCameraId,
        cameras: next.cameras.map(toPublicCamera),
      });
      return true;
    }
  }

  if (method === 'GET' && pathname === '/api/cameras') {
    const config = deps.configStore.get();
    sendJson(res, 200, { activeCameraId: config.activeCameraId, cameras: config.cameras.map(toPublicCamera) });
    return true;
  }

  if (method === 'POST' && pathname === '/api/cameras/active') {
    const body = await readJsonBody(req);
    const next = await deps.configStore.patch({ activeCameraId: requireString(body, 'id') });
    sendJson(res, 200, { activeCameraId: next.activeCameraId });
    return true;
  }

  if (method === 'POST' && pathname === '/api/cameras') {
    const body = await readJsonBody(req);
    const { config, camera } = await deps.configStore.addCamera({ ...body, id: requireString(body, 'id') } as never);
    sendJson(res, 200, {
      camera: toPublicCamera(camera),
      activeCameraId: config.activeCameraId,
      cameras: config.cameras.map(toPublicCamera),
    });
    return true;
  }

  // 연결 테스트 — 저장하지 않고 시험한다. body.camera 를 주면 그 값으로 덮어 쓴 사본으로 시도하므로
  // URL·계정을 고치는 중에도 「적용」 전에 확인할 수 있다(비밀번호 생략 시 저장된 값을 쓴다).
  const cameraTest = /^\/api\/cameras\/([^/]+)\/test$/.exec(pathname);
  if (method === 'POST' && cameraTest) {
    const id = decodeURIComponent(cameraTest[1]!);
    const body = await readJsonBody(req);
    const saved = deps.configStore.get();
    const draft = body.camera && typeof body.camera === 'object'
      ? mergeSettings(saved, { cameras: [{ ...(body.camera as object), id } as never] })
      : saved;
    const camera = findCamera(draft, id);
    const started = Date.now();
    try {
      const driver = createDriver(camera, draft, deps.fetchImpl);
      const ptz = await driver.getPtz();
      // 연결 실패는 요청의 오류가 아니라 시험의 **결과**다 — 200 에 ok 로 싣는다.
      sendJson(res, 200, { ok: true, cameraId: id, kind: camera.kind, elapsedMs: Date.now() - started, ptz: toView(ptz) });
    } catch (error) {
      sendJson(res, 200, {
        ok: false,
        cameraId: id,
        kind: camera.kind,
        elapsedMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  const cameraItem = /^\/api\/cameras\/([^/]+)$/.exec(pathname);
  if (method === 'DELETE' && cameraItem) {
    const id = decodeURIComponent(cameraItem[1]!);
    const { config, removed } = await deps.configStore.removeCamera(id);
    // 없는 기기를 가리키는 프리셋을 남기지 않는다.
    const removedPresets = await deps.presetStore.removeByCamera(id);
    sendJson(res, 200, {
      removed: removed.id,
      removedPresets,
      activeCameraId: config.activeCameraId,
      cameras: config.cameras.map(toPublicCamera),
    });
    return true;
  }

  return false;
};
