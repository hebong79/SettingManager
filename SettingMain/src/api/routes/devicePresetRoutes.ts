import { findCamera } from '../../devices/driverFactory.js';
import { HucomsPresetClient } from '../../devices/hucoms/hucomsPresetClient.js';
import { waitForSettle } from '../../devices/waitForSettle.js';
import type { CameraConfig } from '../../config/types.js';
import type { PtzRaw } from '../../domain/ptz.js';
import { HttpError, readJsonBody, sendJson } from '../httpUtil.js';
import type { DirectPresetClient, RouteHandler, ServerDeps } from './routeContext.js';

/**
 * 장비(카메라 펌웨어) 프리셋 — 로컬 `/api/presets` 와 **다른 정본**이다.
 * 로컬 프리셋은 SettingManager 가 저장한 좌표이고, 이쪽은 장비에 등록된 번호를 다룬다.
 */

/** 카메라별 장비 프리셋 이동 점유. 같은 카메라에 두 이동이 겹치면 좌표 학습이 오염된다. */
const devicePresetBusy = new Set<string>();

export const devicePresetRoutes: RouteHandler = async (ctx) => {
  const { req, res, deps, pathname, method, searchParams } = ctx;

  if (method === 'GET' && pathname === '/api/device-preset-capability') {
    const config = deps.configStore.get();
    const camera = findCamera(config, searchParams.get('cameraId') ?? undefined);
    if (camera.kind !== 'hucoms') throw new HttpError(501, '현재 카메라는 장비 프리셋 capability를 지원하지 않습니다');
    const capability = await createDirectPresetClient(camera, deps).getCapability();
    sendJson(res, 200, { cameraId: camera.id, ...capability });
    return true;
  }

  const route = /^\/api\/cameras\/([^/]+)\/device-presets(?:\/(\d+)\/(go|sync-coordinate))?$/.exec(pathname);
  if (!route) return false;

  const cameraId = decodeURIComponent(route[1]!);
  const camera = findCamera(deps.configStore.get(), cameraId);
  if (camera.kind !== 'hucoms') throw new HttpError(501, 'Hucoms 카메라에서만 장비 프리셋을 실행할 수 있습니다');

  if (method === 'GET' && !route[2]) {
    const capability = await createDirectPresetClient(camera, deps).getCapability();
    if (!capability.supported) throw new HttpError(501, '이 카메라는 장비 프리셋을 지원하지 않습니다');
    sendJson(res, 200, {
      cameraId: camera.id,
      entries: deps.devicePresetRegistryStore.list(camera.id, capability.usableMaxPresetNumber),
      capability,
    });
    return true;
  }

  if (method === 'POST' && route[2] && route[3]) {
    const number = Number(route[2]);
    if (!Number.isInteger(number) || number < 1 || number > 255) throw new HttpError(400, '장비 프리셋 번호가 capability 범위를 벗어났습니다');
    const body = await readJsonBody(req, 16 * 1024);
    const mode = route[3] === 'go' ? readDevicePresetMode(body) : readEmptyDevicePresetBody(body);
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
      const settleWith = () => waitForSettle(readOnlyDriver(camera.id, mover.getPtz), deps.settleOptions);

      if (mode === 'preset' || mode === 'synced') {
        await mover.goPreset(number);
        const settled = await settleWith();
        if (mode === 'synced') {
          if (!settled.settled) {
            throw new HttpError(504, '좌표가 제한 시간 안에 안정화되지 않았습니다. 이동 여부를 카메라에서 확인하세요. 자동 재시도하지 않았습니다');
          }
          const learned = await deps.devicePresetRegistryStore.learn(camera.id, number, settled.ptz);
          sendJson(res, 200, { mode: 'synced', entry: toDevicePresetEntryView(learned), ptz: settled.ptz, settled: true });
          return true;
        }
        sendJson(res, 200, { mode: 'preset', entry: entry ? toDevicePresetEntryView(entry) : null, ptz: settled.ptz, settled: settled.settled });
        return true;
      }

      await mover.goPtz(entry!.ptz!);
      const settled = await settleWith();
      sendJson(res, 200, { mode: 'coordinate', entry: toDevicePresetEntryView(entry!), ptz: settled.ptz, settled: settled.settled });
      return true;
    } finally {
      devicePresetBusy.delete(camera.id);
    }
  }

  return false;
};

export function createDirectPresetClient(camera: CameraConfig, deps: ServerDeps): DirectPresetClient {
  return deps.directPresetClientFactory?.(camera) ?? new HucomsPresetClient({
    baseUrl: camera.controlUrl,
    username: camera.username,
    password: camera.password,
    timeoutMs: camera.timeoutMs,
  });
}

/**
 * 정착 대기는 좌표 읽기만 필요하다. 나머지 계약 표면은 호출되지 않으므로 빈 구현을 준다
 * — 여기서 실제 이동을 허용하면 정착 대기가 카메라를 움직일 수 있게 된다.
 */
function readOnlyDriver(cameraId: string, getPtz: () => Promise<PtzRaw>) {
  return {
    cameraId,
    kind: 'hucoms',
    getPtz,
    goPtz: async () => {},
    getSnapshot: async () => Buffer.alloc(0),
    listSlots: async () => [],
  };
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

function requireDirectPresetMover(client: DirectPresetClient): Required<Pick<HucomsPresetClient, 'goPreset' | 'getPtz' | 'goPtz'>> {
  if (!client.goPreset || !client.getPtz || !client.goPtz) throw new HttpError(500, '장비 프리셋 직접 어댑터가 이동 계약을 제공하지 않습니다');
  return { goPreset: client.goPreset.bind(client), getPtz: client.getPtz.bind(client), goPtz: client.goPtz.bind(client) };
}

function toDevicePresetEntryView(entry: { number: number; name: string | null; seeded: boolean; ptz: PtzRaw | null; learnedAt: string | null }): object {
  return { ...entry, flags: [entry.seeded ? 'seeded' : 'generic', entry.ptz ? 'learned' : 'unlearned'] };
}
