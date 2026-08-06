import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './database.js';
import { SetupRepository, type CameraRow } from './setupRepository.js';
import { normalizeCamera } from '../config/normalize.js';
import type { CameraConfig } from '../config/types.js';

/**
 * 카메라의 **정본은 `camera_info` 다.** 이 파일이 그 표와 `AppConfig.cameras` 사이를 잇는다.
 *
 * `config.json` 에서 카메라를 들어내면서도 읽는 쪽(`driverFactory`·`routeContext`·라우트·화면)을
 * 하나도 고치지 않은 이유가 여기다 — **기동할 때 DB 로 `config.cameras` 를 채운다.**
 * 그래서 "그 배열이 어디서 오는가"만 바뀌고 "그 배열을 어떻게 쓰는가"는 그대로다.
 *
 * 대신 값이 하나 생겼다: **재수화 시점.** DB 를 고쳐도 메모리의 배열은 옛 값이라,
 * 카메라를 쓰기한 뒤에는 반드시 다시 채워야 한다(`ConfigStore.reloadCameras()`).
 * 안 하면 방금 URL 을 바꿨는데 다음 PTZ 명령이 **옛 주소로 나간다.**
 */

/** `camera_info` 한 줄 → 서비스가 쓰는 카메라 1대. */
export function toCameraConfig(row: CameraRow): CameraConfig {
  return {
    id: row.cam_uuid,
    label: row.cam_name,
    kind: row.kind,
    controlUrl: row.url,
    username: row.user_id,
    password: row.password,
    streamUrl: row.rtsp_url,
    timeoutMs: row.timeout_ms,
    place_id: row.place_id,
    // 값이 없는 기기에는 **키 자체를 만들지 않는다** — 공개 응답의 키 집합을 넓히지 않기 위해서다.
    ...(row.park3d_cam_id ? { camId: row.park3d_cam_id } : {}),
    ...(row.kind === 'idis' && row.insecure_tls ? { insecureTls: true } : {}),
    ...(parseIntrinsics(row.intrinsics) ?? {}),
  };
}

/** 서비스가 쓰는 카메라 1대 → `camera_info` 입력. */
export function toCameraRow(camera: CameraConfig, defaults: { cam_type?: 'ptz' | 'static' } = {}): Parameters<SetupRepository['upsertCamera']>[0] {
  return {
    cam_name: camera.label,
    cam_uuid: camera.id,
    url: camera.controlUrl,
    user_id: camera.username,
    password: camera.password,
    rtsp_url: camera.streamUrl,
    cam_type: defaults.cam_type ?? 'ptz',
    place_id: camera.place_id ?? 1,
    timeout_ms: camera.timeoutMs,
    kind: camera.kind,
    park3d_cam_id: camera.camId ?? null,
    insecure_tls: camera.insecureTls ? 1 : 0,
    intrinsics: camera.intrinsics ? JSON.stringify(camera.intrinsics) : null,
  };
}

/** DB 의 카메라 전부를 등록 순서(cam_id)대로. */
export function readCameras(db: DatabaseSync): CameraConfig[] {
  return new SetupRepository(db).listCameras().map(toCameraConfig);
}

export interface ImportResult {
  imported: string[];
  skipped: string[];
  /** 이관본을 DB 에서 다시 읽어 원본과 대조한 결과. 비어 있어야 성공이다. */
  mismatches: string[];
}

/**
 * `config.json` 의 카메라를 DB 로 **1회 이관**한다.
 *
 * 이미 그 `cam_uuid` 가 DB 에 있으면 **건너뛴다** — 두 번 돌아도 DB 쪽 수정을 덮지 않는다.
 * 이관 뒤에는 **다시 읽어 원본과 필드 단위로 대조**한다. `config.json` 은 `.gitignore` 대상이라
 * 실 IP·계정이 git 어디에도 없고, 대조 없이 원본을 지우면 되돌릴 곳이 사라진다.
 */
export function importCameras(db: DatabaseSync, rawCameras: unknown[]): ImportResult {
  const result: ImportResult = { imported: [], skipped: [], mismatches: [] };
  const repo = new SetupRepository(db);

  transaction(db, () => {
    for (const raw of rawCameras) {
      // 파일에서 온 값이므로 서비스가 쓰는 것과 **같은 정규화**를 거친다.
      const camera = normalizeCamera(raw);
      if (!camera) continue;
      if (repo.getCameraByUuid(camera.id)) {
        result.skipped.push(camera.id);
        continue;
      }
      repo.upsertCamera(toCameraRow(camera));
      result.imported.push(camera.id);
    }
  });

  // 대조는 트랜잭션 밖에서 — 커밋된 것을 읽어야 진짜 확인이다.
  for (const raw of rawCameras) {
    const camera = normalizeCamera(raw);
    if (!camera || !result.imported.includes(camera.id)) continue;
    const stored = repo.getCameraByUuid(camera.id);
    if (!stored) {
      result.mismatches.push(`${camera.id}: DB 에서 다시 찾지 못했습니다`);
      continue;
    }
    result.mismatches.push(...diff(camera, toCameraConfig(stored)));
  }
  return result;
}

/** 필드 단위 대조. 무엇이 어떻게 달라졌는지 사람 문장으로 남긴다. */
function diff(before: CameraConfig, after: CameraConfig): string[] {
  const problems: string[] = [];
  const keys = ['id', 'label', 'kind', 'controlUrl', 'username', 'password', 'streamUrl', 'timeoutMs', 'camId', 'place_id'] as const;
  for (const key of keys) {
    if (before[key] !== after[key]) problems.push(`${before.id}.${key}: "${String(before[key])}" → "${String(after[key])}"`);
  }
  if (JSON.stringify(before.intrinsics ?? null) !== JSON.stringify(after.intrinsics ?? null)) {
    problems.push(`${before.id}.intrinsics 가 이관 중에 달라졌습니다`);
  }
  return problems;
}

function parseIntrinsics(raw: string | null): { intrinsics: CameraConfig['intrinsics'] } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { zoomHfov?: unknown };
    return Array.isArray(parsed?.zoomHfov) ? { intrinsics: parsed as CameraConfig['intrinsics'] } : null;
  } catch {
    // 깨진 JSON 은 "표가 없다"로 본다 — 반쯤 맞는 표로 조준하면 조용히 빗나간다.
    return null;
  }
}
