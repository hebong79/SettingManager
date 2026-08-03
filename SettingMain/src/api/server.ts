import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { CameraDriverError } from '../devices/cameraDriver.js';
import { createDriver, findCamera } from '../devices/driverFactory.js';
import { HucomsPresetClient } from '../devices/hucoms/hucomsPresetClient.js';
import { BackendCoreClient } from '../devices/backendCore/backendCoreClient.js';
import { waitForSettle, type SettleOptions } from '../devices/waitForSettle.js';
import type { ConfigStore } from '../config/configStore.js';
import { ConfigError, mergeSettings, toPublicCamera } from '../config/normalize.js';
import type { CameraConfig, SettingsPatch } from '../config/types.js';
import { PresetError } from '../domain/preset.js';
import { clampPtz, limitedAxes, nudge, toView, type Axis, type PtzRaw } from '../domain/ptz.js';
import type { DevicePresetRegistryStore } from '../store/devicePresetRegistryStore.js';
import { createFrameSource } from '../media/frameSource.js';
import type { PresetStore } from '../store/presetStore.js';
import type { SlotStore } from '../store/slotStore.js';
import { HttpError, optionalNumber, readJsonBody, requireNumber, requireString, sendError, sendJson } from './httpUtil.js';
import { serveStatic } from './staticFiles.js';
import { IndependentCameraCore } from '../independentCameraCore/independentCameraCore.js';
import { CameraLeaseError } from '../independentCameraCore/cameraLease.js';

export interface ServerDeps {
  configStore: ConfigStore;
  presetStore: PresetStore;
  slotStore: SlotStore;
  devicePresetRegistryStore: DevicePresetRegistryStore;
  /** 테스트에서 외부 HTTP 를 가로채기 위한 주입 지점. */
  fetchImpl?: typeof fetch;
  /** 정착 대기 파라미터. 테스트가 실제 시간을 흘려보내지 않도록 주입한다. */
  settleOptions?: SettleOptions;
  /** 장비 capability 직접 조회의 테스트 주입 지점. production에서는 native HTTP adapter를 쓴다. */
  directPresetClientFactory?: (camera: CameraConfig) => Pick<HucomsPresetClient, 'getCapability'> & Partial<Pick<HucomsPresetClient, 'goPreset' | 'getPtz' | 'goPtz'>>;
}

const AXES: readonly Axis[] = ['pan', 'tilt', 'zoom'];
const MJPEG_BOUNDARY = 'settingmanager-frame';
const devicePresetBusy = new Set<string>();

export function createServer(deps: ServerDeps): Server {
  const independentCore = new IndependentCameraCore(deps.settleOptions);
  return createHttpServer((req, res) => {
    handle(req, res, deps, independentCore).catch((error) => fail(res, error));
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ServerDeps, independentCore: IndependentCameraCore): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const { pathname, searchParams } = url;
  const method = req.method ?? 'GET';

  if (!pathname.startsWith('/api/')) {
    // 확장자 없는 경로는 페이지로 본다: /options → options.html
    const candidate = pathname === '/' || pathname.includes('.') ? pathname : `${pathname}.html`;
    if (await serveStatic(res, candidate)) return;
    sendError(res, 404, `찾을 수 없습니다: ${pathname}`);
    return;
  }

  const driverFor = (cameraId?: string) => {
    const config = deps.configStore.get();
    const camera = findCamera(config, cameraId ?? searchParams.get('cameraId') ?? undefined);
    return { camera, config, driver: createDriver(camera, config, deps.fetchImpl) };
  };

  // --- 상태 -------------------------------------------------------------------
  if (method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true, service: 'settingmanager', activeCameraId: deps.configStore.get().activeCameraId });
    return;
  }

  // --- SettingMain 독립 CameraCore --------------------------------------------
  // 외부 BackendCore의 active device를 보거나 변경하지 않는다.
  const independentRoute = /^\/api\/independent-core\/cameras\/([^/]+)\/(capabilities|center)$/.exec(pathname);
  if (independentRoute) {
    const cameraId = decodeURIComponent(independentRoute[1]!);
    const action = independentRoute[2]!;
    const { camera, driver } = driverFor(cameraId);
    if (method === 'GET' && action === 'capabilities') {
      sendJson(res, 200, independentCore.capability(camera.id, driver));
      return;
    }
    if (method === 'POST' && action === 'center') {
      const body = await readJsonBody(req);
      const point = { x: requireCenterCoordinate(body, 'x', 1920), y: requireCenterCoordinate(body, 'y', 1080) };
      try {
        const result = await independentCore.center(camera.id, driver, point);
        sendJson(res, 200, { cameraId: camera.id, ...result });
      } catch (error) {
        if (error instanceof CameraLeaseError) throw new HttpError(409, error.message);
        throw error;
      }
      return;
    }
    throw new HttpError(404, `찾을 수 없습니다: ${method} ${pathname}`);
  }

  // --- BackendCore 탐색·보정 ---------------------------------------------------
  // 로컬 presets/slots와 정본이 다르므로 새 namespace 에서만 프록시한다.
  if (pathname.startsWith('/api/discovery/') || pathname === '/api/center' || pathname === '/api/center-box' || pathname === '/api/vla/tour') {
    await handleDiscovery(req, res, deps, pathname, method);
    return;
  }

  // --- 설정(옵션 페이지) -------------------------------------------------------
  if (pathname === '/api/settings') {
    const config = deps.configStore.get();
    if (method === 'GET') {
      sendJson(res, 200, {
        simulator: config.simulator,
        streaming: config.streaming,
        activeCameraId: config.activeCameraId,
        cameras: config.cameras.map(toPublicCamera),
      });
      return;
    }
    if (method === 'PUT') {
      const body = await readJsonBody(req);
      const next = await deps.configStore.patch(body as SettingsPatch);
      sendJson(res, 200, {
        saved: true,
        simulator: next.simulator,
        activeCameraId: next.activeCameraId,
        cameras: next.cameras.map(toPublicCamera),
      });
      return;
    }
  }

  // --- 카메라 -----------------------------------------------------------------
  if (method === 'GET' && pathname === '/api/cameras') {
    const config = deps.configStore.get();
    sendJson(res, 200, { activeCameraId: config.activeCameraId, cameras: config.cameras.map(toPublicCamera) });
    return;
  }
  if (method === 'POST' && pathname === '/api/cameras/active') {
    const body = await readJsonBody(req);
    const next = await deps.configStore.patch({ activeCameraId: requireString(body, 'id') });
    sendJson(res, 200, { activeCameraId: next.activeCameraId });
    return;
  }

  // --- 장비 프리셋 capability --------------------------------------------------
  // 로컬 /api/presets 및 BackendCore discovery presets와 서로 다른 read-only namespace다.
  if (method === 'GET' && pathname === '/api/device-preset-capability') {
    const config = deps.configStore.get();
    const camera = findCamera(config, searchParams.get('cameraId') ?? undefined);
    if (camera.kind !== 'hucoms') throw new HttpError(501, '현재 카메라는 장비 프리셋 capability를 지원하지 않습니다');
    const directClient = deps.directPresetClientFactory?.(camera) ?? new HucomsPresetClient({
      baseUrl: camera.controlUrl,
      username: camera.username,
      password: camera.password,
      timeoutMs: camera.timeoutMs,
    });
    const capability = await directClient.getCapability();
    sendJson(res, 200, { cameraId: camera.id, ...capability });
    return;
  }
  const devicePresetRoute = /^\/api\/cameras\/([^/]+)\/device-presets(?:\/(\d+)\/(go|sync-coordinate))?$/.exec(pathname);
  if (devicePresetRoute) {
    const cameraId = decodeURIComponent(devicePresetRoute[1]!);
    const camera = findCamera(deps.configStore.get(), cameraId);
    if (camera.kind !== 'hucoms') throw new HttpError(501, 'Hucoms 카메라에서만 장비 프리셋을 실행할 수 있습니다');
    if (method === 'GET' && !devicePresetRoute[2]) {
      const directClient = createDirectPresetClient(camera, deps);
      const capability = await directClient.getCapability();
      if (!capability.supported) throw new HttpError(501, '이 카메라는 장비 프리셋을 지원하지 않습니다');
      sendJson(res, 200, { cameraId: camera.id, entries: deps.devicePresetRegistryStore.list(camera.id, capability.usableMaxPresetNumber), capability });
      return;
    }
    if (method === 'POST' && devicePresetRoute[2] && devicePresetRoute[3]) {
      const number = Number(devicePresetRoute[2]);
      if (!Number.isInteger(number) || number < 1 || number > 255) throw new HttpError(400, '장비 프리셋 번호가 capability 범위를 벗어났습니다');
      const body = await readJsonBody(req, 16 * 1024);
      const action = devicePresetRoute[3];
      const mode = action === 'go' ? readDevicePresetMode(body) : readEmptyDevicePresetBody(body);
      const entry = deps.devicePresetRegistryStore.get(camera.id, number);
      if (mode === 'coordinate' && !entry?.ptz) throw new HttpError(409, 'COORDINATE_NOT_SYNCED');
      const directClient = createDirectPresetClient(camera, deps);
      const capability = await directClient.getCapability();
      if (!capability.supported) throw new HttpError(501, '이 카메라는 장비 프리셋을 지원하지 않습니다');
      if (number > capability.usableMaxPresetNumber) throw new HttpError(400, '장비 프리셋 번호가 capability 범위를 벗어났습니다');
      if (devicePresetBusy.has(camera.id)) throw new HttpError(409, 'CAMERA_BUSY');
      devicePresetBusy.add(camera.id);
      try {
        const mover = requireDirectPresetMover(directClient);
        if (mode === 'preset' || mode === 'synced') {
          await mover.goPreset(number);
          const settled = await waitForSettle({ cameraId: camera.id, kind: 'hucoms', getPtz: mover.getPtz, goPtz: async () => {}, getSnapshot: async () => Buffer.alloc(0), listSlots: async () => [] }, deps.settleOptions);
          if (mode === 'synced') {
            if (!settled.settled) throw new HttpError(504, '좌표가 제한 시간 안에 안정화되지 않았습니다. 이동 여부를 카메라에서 확인하세요. 자동 재시도하지 않았습니다');
            const learned = await deps.devicePresetRegistryStore.learn(camera.id, number, settled.ptz);
            sendJson(res, 200, { mode: 'synced', entry: toDevicePresetEntryView(learned), ptz: settled.ptz, settled: true });
            return;
          }
          sendJson(res, 200, { mode: 'preset', entry: entry ? toDevicePresetEntryView(entry) : null, ptz: settled.ptz, settled: settled.settled });
          return;
        }
        await mover.goPtz(entry!.ptz!);
        const settled = await waitForSettle({ cameraId: camera.id, kind: 'hucoms', getPtz: mover.getPtz, goPtz: async () => {}, getSnapshot: async () => Buffer.alloc(0), listSlots: async () => [] }, deps.settleOptions);
        sendJson(res, 200, { mode: 'coordinate', entry: toDevicePresetEntryView(entry!), ptz: settled.ptz, settled: settled.settled });
        return;
      } finally {
        devicePresetBusy.delete(camera.id);
      }
    }
  }
  if (method === 'POST' && pathname === '/api/cameras') {
    const body = await readJsonBody(req);
    const { config, camera } = await deps.configStore.addCamera({ ...body, id: requireString(body, 'id') } as never);
    sendJson(res, 200, {
      camera: toPublicCamera(camera),
      activeCameraId: config.activeCameraId,
      cameras: config.cameras.map(toPublicCamera),
    });
    return;
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
    return;
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
    return;
  }

  // --- PTZ --------------------------------------------------------------------
  if (method === 'GET' && pathname === '/api/ptz') {
    const { camera, driver } = driverFor();
    sendJson(res, 200, { cameraId: camera.id, ptz: toView(await driver.getPtz()) });
    return;
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
    return;
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
    return;
  }
  if (method === 'POST' && pathname === '/api/ptz/center') {
    const body = await readJsonBody(req);
    const point = { x: requireCenterCoordinate(body, 'x', 1920), y: requireCenterCoordinate(body, 'y', 1080) };
    const { camera, driver } = driverFor(asId(body.cameraId));
    if (!driver.centerPoint) throw new HttpError(501, '현재 카메라는 영상 클릭 센터링을 지원하지 않습니다');
    await driver.centerPoint(point);
    const settle = await waitForSettle(driver, deps.settleOptions);
    sendJson(res, 200, { cameraId: camera.id, point, ptz: toView(settle.ptz), settled: settle.settled });
    return;
  }

  // --- 프리셋 -----------------------------------------------------------------
  if (pathname === '/api/presets') {
    if (method === 'GET') {
      const { camera } = driverFor();
      sendJson(res, 200, { cameraId: camera.id, presets: deps.presetStore.list(camera.id) });
      return;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const { camera, driver } = driverFor(asId(body.cameraId));
      // ptz 를 안 주면 현재 자세를 저장한다 — 좌표를 지어내지 않는다.
      const ptz = readPtz(body) ?? (await driver.getPtz());
      const preset = await deps.presetStore.add({ cameraId: camera.id, name: requireString(body, 'name'), ptz });
      sendJson(res, 200, { preset });
      return;
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
    return;
  }
  const presetItem = /^\/api\/presets\/([^/]+)$/.exec(pathname);
  if (presetItem) {
    const id = decodeURIComponent(presetItem[1]!);
    if (method === 'PUT') {
      const body = await readJsonBody(req);
      const name = body.name === undefined ? undefined : requireString(body, 'name');
      const preset = await deps.presetStore.update(id, { name, ptz: readPtz(body) });
      sendJson(res, 200, { preset });
      return;
    }
    if (method === 'DELETE') {
      const removed = await deps.presetStore.remove(id);
      sendJson(res, 200, { removed: removed.id });
      return;
    }
  }

  // --- 주차면 -----------------------------------------------------------------
  if (method === 'GET' && pathname === '/api/slots') {
    const { camera, driver } = driverFor();
    // 시뮬레이터는 씬이 진실의 출처이고, 실카메라는 답할 곳이 없어 로컬 등록본을 쓴다.
    const fromDriver = await driver.listSlots().catch(() => [] as never[]);
    const slots = fromDriver.length > 0 ? fromDriver : deps.slotStore.list(camera.id);
    sendJson(res, 200, {
      cameraId: camera.id,
      source: fromDriver.length > 0 ? 'simulator' : 'local',
      slots,
    });
    return;
  }

  // --- 영상 -------------------------------------------------------------------
  if (method === 'GET' && pathname === '/api/snapshot') {
    const { driver } = driverFor();
    const jpeg = await driver.getSnapshot();
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': jpeg.length, 'cache-control': 'no-store' });
    res.end(jpeg);
    return;
  }
  if (method === 'GET' && pathname === '/api/stream') {
    await streamMjpeg(req, res, deps, searchParams.get('cameraId') ?? undefined);
    return;
  }

  sendError(res, 404, `찾을 수 없습니다: ${method} ${pathname}`);
}

function createDirectPresetClient(camera: CameraConfig, deps: ServerDeps): Pick<HucomsPresetClient, 'getCapability'> & Partial<Pick<HucomsPresetClient, 'goPreset' | 'getPtz' | 'goPtz'>> {
  return deps.directPresetClientFactory?.(camera) ?? new HucomsPresetClient({
    baseUrl: camera.controlUrl,
    username: camera.username,
    password: camera.password,
    timeoutMs: camera.timeoutMs,
  });
}

function readDevicePresetMode(body: Record<string, unknown>): 'preset' | 'coordinate' {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'mode' || (body.mode !== 'preset' && body.mode !== 'coordinate')) {
    throw new HttpError(400, '본문은 mode: preset 또는 coordinate 만 허용합니다');
  }
  return body.mode;
}

function readEmptyDevicePresetBody(body: Record<string, unknown>): 'synced' {
  if (Object.keys(body).length !== 0) throw new HttpError(400, '동기화 본문은 빈 JSON 객체만 허용합니다');
  return 'synced';
}

function requireDirectPresetMover(client: Pick<HucomsPresetClient, 'getCapability'> & Partial<Pick<HucomsPresetClient, 'goPreset' | 'getPtz' | 'goPtz'>>): Pick<HucomsPresetClient, 'goPreset' | 'getPtz' | 'goPtz'> {
  if (!client.goPreset || !client.getPtz || !client.goPtz) throw new HttpError(500, '장비 프리셋 직접 어댑터가 이동 계약을 제공하지 않습니다');
  return { goPreset: client.goPreset.bind(client), getPtz: client.getPtz.bind(client), goPtz: client.goPtz.bind(client) };
}

function toDevicePresetEntryView(entry: { number: number; name: string | null; seeded: boolean; ptz: PtzRaw | null; learnedAt: string | null }): object {
  return { ...entry, flags: [entry.seeded ? 'seeded' : 'generic', entry.ptz ? 'learned' : 'unlearned'] };
}

async function handleDiscovery(req: IncomingMessage, res: ServerResponse, deps: ServerDeps, pathname: string, method: string): Promise<void> {
  const config = deps.configStore.get();
  const camera = findCamera(config);
  const useBackendCore = new URL(req.url ?? '/', 'http://localhost').searchParams.get('useBackendCore') === '1';
  if (!useBackendCore) throw new HttpError(409, '주차면 탐색 화면의 BackendCore 사용 체크박스를 켜세요');
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
  else if (pathname === '/api/vla/tour' && method === 'POST') result = await client.vlaTour(tourBody(body!));
  else throw new HttpError(404, `찾을 수 없습니다: ${method} ${pathname}`);
  sendJson(res, 200, { cameraId: camera.id, ...result });
}

function calibrationBody(body: Record<string, unknown>): Record<string, unknown> {
  const mode = requireString(body, 'mode');
  if (mode !== 'full' && mode !== 'verify') throw new HttpError(400, 'mode 는 full 또는 verify 여야 합니다');
  return { mode };
}
function centerBody(body: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { x: requireNumber(body, 'x'), y: requireNumber(body, 'y') };
  result.frameWidth = optionalNumber(body, 'frameWidth') ?? 1920;
  result.frameHeight = optionalNumber(body, 'frameHeight') ?? 1080;
  result.speed = optionalNumber(body, 'speed') ?? 50;
  return result;
}
function plateHomeBody(body: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { presetId: requireString(body, 'presetId') };
  if (body.pointIds !== undefined) {
    if (!Array.isArray(body.pointIds) || !body.pointIds.every((id) => typeof id === 'string' && id.trim())) throw new HttpError(400, 'pointIds 는 비어 있지 않은 문자열 배열이어야 합니다');
    result.pointIds = body.pointIds;
  }
  return result;
}
function tourBody(body: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { saveSpots: false };
  const maxSpots = optionalNumber(body, 'maxSpots'); if (maxSpots !== undefined) result.maxSpots = maxSpots;
  if (body.zoomIn !== undefined) { if (typeof body.zoomIn !== 'boolean') throw new HttpError(400, 'zoomIn 은 boolean 이어야 합니다'); result.zoomIn = body.zoomIn; }
  return result;
}

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

function readPtz(body: Record<string, unknown>): PtzRaw | undefined {
  const raw = body.ptz;
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  const values = [p.pan, p.tilt, p.zoom].map(Number);
  if (!values.every(Number.isFinite)) throw new HttpError(400, 'ptz 는 pan·tilt·zoom 숫자를 가져야 합니다');
  return clampPtz({ pan: values[0]!, tilt: values[1]!, zoom: values[2]! });
}

function asId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireCenterCoordinate(body: Record<string, unknown>, key: 'x' | 'y', maximum: number): number {
  const value = requireNumber(body, key);
  if (!Number.isInteger(value) || value < 0 || value > maximum) throw new HttpError(400, `${key} 는 0..${maximum} 정수여야 합니다`);
  return value;
}

function fail(res: ServerResponse, error: unknown): void {
  if (res.writableEnded) return;
  if (error instanceof HttpError) return sendError(res, error.status, error.message);
  if (error instanceof PresetError) return sendError(res, error.statusCode, error.message);
  if (error instanceof CameraDriverError) return sendError(res, error.statusCode, error.message);
  if (error instanceof ConfigError) return sendError(res, error.statusCode, error.message);
  sendError(res, 500, error instanceof Error ? error.message : String(error));
}
