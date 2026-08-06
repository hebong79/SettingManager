import { DatabaseError, transaction } from '../../db/database.js';
import { SetupRepository, type CameraRow } from '../../db/setupRepository.js';
import { toCameraConfig, toCameraRow } from '../../db/configCameras.js';
import { listTables, runQuery } from '../../db/tableQuery.js';
import { createDriver } from '../../devices/driverFactory.js';
import { normalizeCamera } from '../../config/normalize.js';
import { toView } from '../../domain/ptz.js';
import { HttpError, readJsonBody, requireNumber, requireString, sendJson } from '../httpUtil.js';
import type { RouteHandler } from './routeContext.js';

/**
 * 커미셔닝 DB 를 화면이 다룰 수 있게 여는 자리 — **옵션의 DB 탭**과 **테이블 뷰어**가 쓴다.
 *
 * 편집을 여는 표는 셋뿐이다(`place_info`·`camera_info`·`preset_info`). 나머지는 커미셔닝
 * 작업이 만드는 산출물이라 손으로 고칠 것이 아니고, 뷰어에서 **읽기로만** 열린다 —
 * 사람이 슬롯 좌표를 직접 고치기 시작하면 그 값이 무엇으로 측정된 것인지 아무도 모르게 된다.
 *
 * **카메라의 정본이 이 표다.** `config.json` 에는 더 이상 카메라가 없고, 접속 정보까지 전부
 * 여기서 고친다. 그래서 규칙이 하나 붙는다 — **카메라를 쓰기했으면 반드시
 * `configStore.reloadCameras()` 를 부른다.** 안 부르면 메모리의 `config.cameras` 가 옛 값이라
 * 방금 바꾼 URL 이 아니라 이전 주소로 다음 명령이 나간다.
 */
export const dbRoutes: RouteHandler = async (ctx) => {
  const { req, res, deps, pathname, method, searchParams } = ctx;
  if (!pathname.startsWith('/api/db/')) return false;

  const db = deps.db;
  if (!db) throw new DatabaseError('커미셔닝 DB 가 열려 있지 않습니다', 503);
  const repo = new SetupRepository(db);
  const body = ['POST', 'PUT'].includes(method) ? await readJsonBody(req) : undefined;

  // --- 뷰어 --------------------------------------------------------------
  if (method === 'GET' && pathname === '/api/db/tables') {
    sendJson(res, 200, { tables: listTables(db) });
    return true;
  }
  if (method === 'POST' && pathname === '/api/db/query') {
    sendJson(res, 200, runQuery(db, body as never));
    return true;
  }

  // --- 장소 --------------------------------------------------------------
  if (pathname === '/api/db/places') {
    if (method === 'GET') {
      sendJson(res, 200, { places: repo.listPlaces() });
      return true;
    }
    if (method === 'POST') {
      const place = repo.upsertPlace({ place_id: requireNumber(body!, 'place_id'), place_name: requireString(body!, 'place_name') });
      sendJson(res, 200, { place });
      return true;
    }
  }
  const place = /^\/api\/db\/places\/(\d+)$/.exec(pathname);
  if (place) {
    const placeId = Number(place[1]);
    if (method === 'PUT') {
      sendJson(res, 200, { place: repo.upsertPlace({ place_id: placeId, place_name: requireString(body!, 'place_name') }) });
      return true;
    }
    if (method === 'DELETE') {
      // 카메라가 걸려 있으면 외래키(RESTRICT)가 막는다. 그 사유를 사람 문장으로 옮긴다 —
      // "FOREIGN KEY constraint failed" 는 무엇을 지워야 하는지 말해 주지 않는다.
      const used = repo.listCameras().filter((c) => c.place_id === placeId);
      if (used.length > 0) {
        throw new DatabaseError(`이 장소를 쓰는 카메라가 ${used.length}대 있습니다 (${used.map((c) => c.cam_uuid).join(', ')}) — 먼저 옮기십시오`, 409);
      }
      sendJson(res, 200, { removed: placeId, changed: repo.removePlace(placeId) });
      return true;
    }
  }

  // --- 카메라 (정본) ------------------------------------------------------
  if (pathname === '/api/db/cameras') {
    if (method === 'GET') {
      sendJson(res, 200, { cameras: repo.listCameras().map(publicCamera) });
      return true;
    }
    if (method === 'POST') {
      const id = requireString(body!, 'cam_uuid');
      if (!ID_RE.test(id)) {
        throw new HttpError(400, '기기 ID 는 영문·숫자로 시작하고 영문·숫자·`_ - .` 만 쓸 수 있습니다 (최대 64자)');
      }
      if (repo.getCameraByUuid(id)) throw new HttpError(409, `이미 있는 기기 ID 입니다: ${id}`);
      // 파일에서 오던 값과 **같은 정규화**를 거친다 — 두 경로가 다른 규칙을 쓰면 조용히 갈라진다.
      const draft = normalizeCamera({ ...body, id });
      if (!draft) throw new HttpError(400, '기기를 만들 수 없습니다');
      const saved = repo.upsertCamera({
        ...toCameraRow(draft),
        ...(body!.cam_type === 'static' ? { cam_type: 'static' as const } : {}),
      });
      deps.configStore.reloadCameras();
      sendJson(res, 200, { camera: publicCamera(saved) });
      return true;
    }
  }

  const camera = /^\/api\/db\/cameras\/(\d+)(\/test)?$/.exec(pathname);
  if (camera) {
    const camId = Number(camera[1]);
    const current = repo.listCameras().find((c) => c.cam_id === camId);
    if (!current) throw new HttpError(404, `등록되지 않은 카메라입니다: cam_id=${camId}`);

    // 연결 테스트 — **저장하지 않고** 지금 화면의 값으로 PTZ 를 한 번 읽는다. 움직이지 않는다.
    if (camera[2] && method === 'POST') {
      const draft = merged(current, body ?? {});
      const started = Date.now();
      try {
        const driver = createDriver(toCameraConfig(draft), deps.configStore.get(), deps.fetchImpl);
        const ptz = await driver.getPtz();
        // 연결 실패는 요청의 오류가 아니라 시험의 **결과**다 — 200 에 ok 로 싣는다.
        sendJson(res, 200, { ok: true, cam_id: camId, kind: draft.kind, elapsedMs: Date.now() - started, ptz: toView(ptz) });
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          cam_id: camId,
          kind: draft.kind,
          elapsedMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }

    if (method === 'PUT') {
      const saved = repo.upsertCamera(merged(current, body!));
      deps.configStore.reloadCameras();
      sendJson(res, 200, { camera: publicCamera(saved) });
      return true;
    }
    if (method === 'DELETE') {
      // 마지막 한 대는 지울 수 없다 — 조작할 대상이 없으면 나머지 화면이 전부 404 가 된다.
      if (repo.listCameras().length === 1) {
        throw new HttpError(409, '마지막 기기는 삭제할 수 없습니다 — 최소 1대가 있어야 합니다');
      }
      const removedPresets = repo.listPresets(camId).length;
      repo.removeCamera(camId);
      deps.configStore.reloadCameras();
      sendJson(res, 200, { removed: camId, cam_uuid: current.cam_uuid, removedPresets });
      return true;
    }
  }

  // --- 프리셋 ------------------------------------------------------------
  if (pathname === '/api/db/presets') {
    if (method === 'GET') {
      const camId = searchParams.get('cam_id');
      sendJson(res, 200, { presets: repo.listPresets(camId ? Number(camId) : undefined) });
      return true;
    }
    if (method === 'POST') {
      sendJson(res, 200, { preset: repo.upsertPreset(presetInput(body!)) });
      return true;
    }
  }
  const preset = /^\/api\/db\/presets\/(\d+)\/(\d+)$/.exec(pathname);
  if (preset) {
    const camId = Number(preset[1]);
    const presetId = Number(preset[2]);
    if (method === 'PUT') {
      const current = repo.getPreset(camId, presetId);
      if (!current) throw new HttpError(404, `등록되지 않은 프리셋입니다: cam_id=${camId} preset_id=${presetId}`);
      // 열쇠를 바꿀 수 있다. 경로는 **지금 있는 자리**를 가리키고, 본문의 cam_id·preset_id 가
      // **옮겨 갈 자리**다. 옮기기와 나머지 값 갱신이 한 덩어리여야 한다 — 옮긴 뒤 이름 저장이
      // 실패하면 프리셋이 사람이 찾을 수 없는 번호로 가 있게 된다.
      const target = {
        cam_id: body!.cam_id !== undefined ? requireNumber(body!, 'cam_id') : camId,
        preset_id: body!.preset_id !== undefined ? requireNumber(body!, 'preset_id') : presetId,
      };
      const result = transaction(db, () => {
        const movedSlots = repo.movePreset({ cam_id: camId, preset_id: presetId }, target);
        const preset = repo.upsertPreset({
          preset_id: target.preset_id,
          cam_id: target.cam_id,
          preset_name: body!.preset_name !== undefined ? String(body!.preset_name) : current.preset_name,
          pos: body!.pos !== undefined ? pos(body!.pos) : { pan: current.pos_pan, tilt: current.pos_tilt, zoom: current.pos_zoom },
          place_id: body!.place_id !== undefined ? requireNumber(body!, 'place_id') : current.place_id,
        });
        return { preset, movedSlots };
      });
      sendJson(res, 200, result);
      return true;
    }
    if (method === 'DELETE') {
      // 슬롯이 CASCADE 로 함께 사라진다 — 몇 개가 지워지는지 미리 세어 답에 싣는다.
      const slots = repo.listSlots({ camId, presetId }).length;
      sendJson(res, 200, { removed: { cam_id: camId, preset_id: presetId }, removedSlots: slots, changed: repo.removePreset(camId, presetId) });
      return true;
    }
  }

  throw new HttpError(404, `찾을 수 없습니다: ${method} ${pathname}`);
};

/** 기기 ID 규칙: 경로·URL 에 그대로 들어가므로 안전한 문자만 허용한다(config 시절과 같다). */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** 비밀번호는 화면으로 돌아가지 않는다 — 있는지 없는지만 답한다. */
function publicCamera(row: CameraRow): Record<string, unknown> {
  const { password, ...rest } = row;
  return { ...rest, hasPassword: password.length > 0 };
}

/**
 * 비밀번호의 세 갈래.
 *
 *   보내지 않음 · 빈 문자열 → **기존 값을 지킨다.** 화면은 비밀번호를 되돌려받지 않으므로
 *     빈 값을 그대로 쓰면 이름만 고친 저장 한 번에 자격증명이 사라진다(config 시절과 같은 규칙).
 *   `null` 을 **명시로** 보냄 → 지운다. 계정에 비밀번호가 없는 기기로 되돌리는 유일한 길이며,
 *     빈 문자열과 갈라 둔 이유가 이것이다 — "안 건드림"과 "지움"은 다른 뜻이다.
 *   그 밖의 문자열 → 바꾼다.
 */
function password(patch: Record<string, unknown>, current: CameraRow): string {
  if (patch.password === null) return '';
  return typeof patch.password === 'string' && patch.password.length > 0 ? patch.password : current.password;
}

/** 부분 갱신을 현재 값에 겹친다. */
function merged(current: CameraRow, patch: Record<string, unknown>): CameraRow {
  const text = (key: 'cam_name' | 'url' | 'user_id' | 'rtsp_url'): string =>
    (typeof patch[key] === 'string' ? String(patch[key]) : current[key]);
  return {
    ...current,
    cam_name: text('cam_name'),
    url: text('url'),
    user_id: text('user_id'),
    password: password(patch, current),
    rtsp_url: text('rtsp_url'),
    cam_type: patch.cam_type === 'static' ? 'static' : patch.cam_type === 'ptz' ? 'ptz' : current.cam_type,
    kind: KINDS.includes(patch.kind as CameraRow['kind']) ? (patch.kind as CameraRow['kind']) : current.kind,
    place_id: patch.place_id !== undefined ? requireNumber(patch, 'place_id') : current.place_id,
    timeout_ms: patch.timeout_ms !== undefined ? clampTimeout(patch.timeout_ms) : current.timeout_ms,
    // 값을 **명시로 비우면** 지운다 — park3d 가 아닌 종류로 바꿀 때 필요하다.
    park3d_cam_id: patch.park3d_cam_id === undefined ? current.park3d_cam_id : positiveOrNull(patch.park3d_cam_id),
    // idis 전용 TLS 검증 끄기. 화면은 체크박스라 `true`/`false` 로 오고, DB 는 0/1 이다.
    insecure_tls: patch.insecure_tls === undefined ? current.insecure_tls : (patch.insecure_tls ? 1 : 0),
    intrinsics: patch.intrinsics === undefined ? current.intrinsics : intrinsicsJson(patch.intrinsics),
  };
}

const KINDS: ReadonlyArray<CameraRow['kind']> = ['hucoms', 'backend-core', 'park3d-rpc', 'idis'];

function clampTimeout(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 5000;
  return Math.min(60_000, Math.max(500, Math.round(n)));
}

function positiveOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * 못 쓰는 표는 고쳐 주지 않고 **없는 것으로** 둔다 — 반쯤 맞는 표로 조준하면 조용히 빗나간다.
 * 판정은 `normalizeCamera` 에게 맡긴다: 설정 파일에서 오던 표와 **같은 잣대**여야 한다.
 */
function intrinsicsJson(value: unknown): string | null {
  if (value === null || value === '') return null;
  const raw = typeof value === 'string' ? safeParse(value) : value;
  const normalized = normalizeCamera({ id: 'probe', intrinsics: raw })?.intrinsics;
  return normalized ? JSON.stringify(normalized) : null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function presetInput(body: Record<string, unknown>): { preset_id?: number; preset_name: string; cam_id: number; pos: { pan: number; tilt: number; zoom: number }; place_id: number } {
  return {
    ...(body.preset_id !== undefined ? { preset_id: requireNumber(body, 'preset_id') } : {}),
    preset_name: requireString(body, 'preset_name'),
    cam_id: requireNumber(body, 'cam_id'),
    pos: pos(body.pos),
    place_id: body.place_id !== undefined ? requireNumber(body, 'place_id') : 1,
  };
}

function pos(raw: unknown): { pan: number; tilt: number; zoom: number } {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const read = (key: string): number => {
    const value = Number(p[key]);
    if (!Number.isFinite(value)) throw new HttpError(400, `pos.${key} 는 숫자여야 합니다`);
    return Math.round(value);
  };
  return { pan: read('pan'), tilt: read('tilt'), zoom: read('zoom') };
}
