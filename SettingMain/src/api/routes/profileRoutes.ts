import { PAN_RANGE, TILT_RANGE, ZOOM_RANGE } from '../../domain/ptz.js';
import { normalizeIntrinsics } from '../../config/normalize.js';
import type { CameraConfig } from '../../config/types.js';
import { profileDrift } from '../../profiles/profileDrift.js';
import { ProfileError, type ProfileStore } from '../../profiles/profileStore.js';
import type { CameraProfile, ProfileMethod, ProfileOptics } from '../../profiles/profileTypes.js';
import { HttpError, readJsonBody, requireString, sendJson } from '../httpUtil.js';
import type { RouteHandler } from './routeContext.js';

/**
 * 프로파일 창구 — **하나뿐이다.**
 *
 * 스윕으로 얻었든(`sweep`), 손으로 넣었든(`import`), 옆 카메라에서 복사했든(`copy`)
 * 전부 같은 문서 형식으로 같은 자리에 앉는다. 창구가 읽기 전용이던 동안 상류에서는
 * **스윕을 못 돌리는 기기의 곡선이 갈 곳이 없어 코드로 새어 나갔다** — 디스크 7곳에 흩어진
 * 칼리브레이션이 그렇게 생겼다.
 *
 * `PUT` 은 두지 않는다. 덮어쓸 수 있는 문을 만들면 "리비전은 불변"이 관습으로 내려앉는다.
 */
export function createProfileRoutes(store: ProfileStore): RouteHandler {
  return async (ctx) => {
    const { req, res, pathname, method, deps } = ctx;
    if (!pathname.startsWith('/api/profiles/')) return false;

    const match = /^\/api\/profiles\/camera\/([^/]+)(?:\/(@\d+|apply|copy))?$/.exec(pathname);
    if (!match) throw new HttpError(404, `찾을 수 없습니다: ${method} ${pathname}`);
    const cameraId = decodeURIComponent(match[1]!);
    const action = match[2];
    const body = ['POST', 'PUT'].includes(method) ? await readJsonBody(req) : {};

    // --- 고정 조회 — 영원히 유효해야 한다 -----------------------------------
    if (action?.startsWith('@')) {
      if (method !== 'GET') throw new HttpError(404, `찾을 수 없습니다: ${method} ${pathname}`);
      const revision = Number(action.slice(1));
      const profile = await store.read(cameraId, revision);
      if (!profile) throw new ProfileError(`기기 ${cameraId} 의 리비전 ${revision} 을(를) 찾을 수 없습니다`, 404);
      sendJson(res, 200, { profile });
      return true;
    }

    // --- 목록 + 현재 적용본 + 드리프트 --------------------------------------
    if (!action && method === 'GET') {
      const [revisions, published] = await Promise.all([store.listRevisions(cameraId), store.read(cameraId)]);
      const runtime = findCameraConfig(deps, cameraId)?.intrinsics;
      sendJson(res, 200, {
        cameraId,
        revisions,
        latest: published?.revision ?? null,
        published,
        runtime: runtime ?? null,
        // 일치하거나 발행본이 없으면 `null` 이다 — 늘 떠 있는 경고는 아무도 읽지 않는다.
        drift: profileDrift(cameraId, published, runtime),
      });
      return true;
    }

    // --- 적용 · 되돌리기 -----------------------------------------------------
    if (action === 'apply' && method === 'POST') {
      const revision = body.revision === undefined ? undefined : asRevision(body.revision);
      sendJson(res, 200, { cameraId, ...(await store.apply(cameraId, revision)) });
      return true;
    }

    // --- 복사 — **광학만 옮긴다** -------------------------------------------
    if (action === 'copy' && method === 'POST') {
      const from = requireString(body, 'from');
      const source = await store.read(from, body.revision === undefined ? undefined : asRevision(body.revision));
      if (!source) throw new ProfileError(`원본 기기 ${from} 에 발행된 프로파일이 없습니다`, 404);
      const target = requireCamera(deps, cameraId);
      sendJson(res, 200, {
        cameraId,
        ...(await store.publish(cameraId, {
          optics: source.optics,
          // **`device` 블록은 새로 찍는다.** 곡선은 렌즈의 성질이지만 그 곡선을 색인하는 눈금은
          // 프로토콜의 성질이다(hucoms `zoom 0..65535` vs IDIS `100..1200`).
          device: deviceBlockFor(target),
          provenance: {
            method: 'copy',
            // 복사의 복사를 지나도 **최초로 실측한 기기**를 가리킨다.
            measuredOn: source.provenance?.measuredOn ?? source.profileId,
            note: `${from} rev-${source.revision} 에서 복사`,
          },
          quality: { ...source.quality, method: 'copy', verify: null, note: `${from} rev-${source.revision} 의 측정을 그대로 복사 — 이 기기에서 재지 않았습니다` },
          apply: body.apply !== false,
          force: body.force === true,
        })),
      });
      return true;
    }

    // --- 손으로 넣기(import) 또는 완성된 문서 발행 ---------------------------
    if (!action && method === 'POST') {
      const target = requireCamera(deps, cameraId);
      const optics = requireOptics(body);
      sendJson(res, 200, {
        cameraId,
        ...(await store.publish(cameraId, {
          optics,
          device: deviceBlockFor(target),
          provenance: {
            method: asMethod(body.method) ?? 'import',
            measuredOn: typeof body.measuredOn === 'string' && body.measuredOn.trim() ? body.measuredOn.trim() : cameraId,
            ...(typeof body.note === 'string' && body.note.trim() ? { note: body.note.trim() } : {}),
          },
          // **재지 않은 값이 실측처럼 보이면 없느니만 못하다.** import 는 근거를 싣지 않으므로
          // 게이트가 볼 것도 없고(막지 않는다), 문서가 스스로 "재지 않았다"고 말한다.
          quality: { method: 'import', verify: null, note: '손으로 넣은 곡선입니다 — 이 기기에서 스윕으로 재지 않았습니다' },
          apply: body.apply !== false,
          force: body.force === true,
        })),
      });
      return true;
    }

    // --- 퇴역 ---------------------------------------------------------------
    if (!action && method === 'DELETE') {
      sendJson(res, 200, { cameraId, retired: true, ...(await store.retire(cameraId)) });
      return true;
    }

    throw new HttpError(404, `찾을 수 없습니다: ${method} ${pathname}`);
  };
}

/**
 * 이 기기의 눈금·프레임. **PTZ 범위는 이 서비스의 계약 좌표(Hucoms 논리)** 이고, 벤더 고유
 * 눈금(IDIS 배율×100 등)은 드라이버 안에서 이 계약으로 변환된 뒤 올라온다 — 그래서 문서가
 * 기록해야 할 것은 곡선의 z 축이 실제로 무엇인지, 즉 **계약 눈금**이다.
 */
function deviceBlockFor(camera: CameraConfig): CameraProfile['device'] {
  return {
    type: camera.kind,
    frame: { width: 1920, height: 1080 },
    ptzRange: {
      pan: [PAN_RANGE[0], PAN_RANGE[1]],
      tilt: [TILT_RANGE[0], TILT_RANGE[1]],
      zoom: [ZOOM_RANGE[0], ZOOM_RANGE[1]],
    },
  };
}

/** 본문의 곡선을 **설정과 같은 정규화**로 통과시킨다 — 두 경로가 다른 표를 받으면 안 된다. */
function requireOptics(body: Record<string, unknown>): ProfileOptics {
  const intrinsics = normalizeIntrinsics(body.optics ?? body);
  if (!intrinsics) {
    throw new HttpError(
      400,
      'optics.zoomHfov 가 필요합니다 — [{z, h}] 앵커 2개 이상, z 오름차순, h 는 양수여야 합니다 (centeringGain 은 [{z, k}] 로 선택)',
    );
  }
  return {
    interpolation: 'piecewise-linear',
    extrapolation: 'clamp',
    zoomHfov: intrinsics.zoomHfov,
    centeringGain: intrinsics.centeringGain ?? null,
  };
}

function asMethod(value: unknown): ProfileMethod | undefined {
  return value === 'sweep' || value === 'import' || value === 'copy' ? value : undefined;
}

function asRevision(value: unknown): number {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) throw new HttpError(400, 'revision 은 1 이상 정수여야 합니다');
  return revision;
}

function findCameraConfig(deps: { configStore: { get(): { cameras: CameraConfig[] } } }, cameraId: string): CameraConfig | undefined {
  return deps.configStore.get().cameras.find((camera) => camera.id === cameraId);
}

/** 발행 대상은 **등록된 기기**여야 한다 — 유령 id 로 발행하면 아무도 못 읽는 문서가 생긴다. */
function requireCamera(deps: { configStore: { get(): { cameras: CameraConfig[] } } }, cameraId: string): CameraConfig {
  const camera = findCameraConfig(deps, cameraId);
  if (!camera) throw new ProfileError(`등록되지 않은 기기입니다: ${cameraId}`, 404);
  return camera;
}
