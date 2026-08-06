import { readFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CONFIG_DIR } from '../paths.js';
import { clampPtz } from '../domain/ptz.js';
import type { Preset } from '../domain/preset.js';
import { transaction } from './database.js';
import { SetupRepository, type PresetRow } from './setupRepository.js';
import type { ImportResult } from './configCameras.js';

/**
 * 프리셋의 **정본은 `preset_info` 다**(2026-08-06). 이 파일이 그 표와 서비스가 쓰는
 * `Preset` 사이를 잇는다 — 카메라에 대해 `configCameras.ts` 가 하는 일과 같은 자리다.
 *
 * ## 왜 옮겼나
 * 프리셋이 **두 곳에 따로** 있었다: 카메라 제어 화면은 `config/presets.json`,
 * 옵션 화면의 DB 탭과 주차면 탐색 화면은 `preset_info` 표. 같은 이름의 프리셋이 두 화면에서
 * 서로 다른 좌표를 가리켰고, 어느 쪽이 맞는지 판단할 근거가 없었다.
 * `slot_setup` 이 `(cam_id, preset_id)` 로 `preset_info` 를 가리키므로 **표 쪽이 정본이어야 한다** —
 * 파일 쪽을 정본으로 삼으면 주차면이 없는 프리셋을 가리키게 된다.
 *
 * ## id 두 벌
 * | 밖(REST·화면) | DB |
 * |---|---|
 * | `Preset.id` = `"7"` | `preset_info.id` (**대리키**, 표 전체에서 유일) |
 * | `Preset.cameraId` = `simulator-2` | `camera_info.cam_uuid` |
 *
 * 대리키를 쓰는 이유: `/api/presets/:id` 계열은 **id 하나만으로** 한 줄을 찾는다.
 * 탐색 화면이 쓰는 `p-3`(= `preset_id`, 카메라 안에서 1부터)은 카메라를 함께 알아야만
 * 유일해지므로 이 자리에 쓸 수 없다 — `p-1` 이 카메라마다 하나씩 있다.
 * 대리키는 DB 탭에서 `cam_id`·`preset_id` 를 옮겨도(`movePreset`) 변하지 않는다.
 */

/** `preset_info` 한 줄 + 그 카메라의 uuid → 서비스가 쓰는 프리셋 1개. */
export function toPreset(row: PresetRow, camUuid: string): Preset {
  return {
    id: String(row.id),
    cameraId: camUuid,
    name: row.preset_name,
    ptz: { pan: row.pos_pan, tilt: row.pos_tilt, zoom: row.pos_zoom },
  };
}

interface LegacyPreset {
  cameraId: string;
  name: string;
  ptz: { pan: number; tilt: number; zoom: number };
}

/**
 * 옛 `config/presets.json` 을 `preset_info` 로 **1회 이관**한다.
 *
 * `importCameras` 와 같은 규칙이다 — 이미 그 카메라에 **같은 이름**이 있으면 건너뛴다.
 * 두 번 돌아도 표 쪽 수정을 덮지 않고, 이관 뒤에는 **다시 읽어 원본과 대조**한다.
 * (열쇠가 아니라 이름으로 대조하는 이유: 파일에는 `preset_id` 라는 개념이 없어서
 *  이관하면서 새로 붙는다. 같은 이름을 두 번 넣으면 화면 콤보박스에서 구분이 안 된다.)
 */
export function importPresets(db: DatabaseSync, rawPresets: unknown[]): ImportResult {
  const result: ImportResult = { imported: [], skipped: [], mismatches: [] };
  const repo = new SetupRepository(db);
  const legacy = rawPresets.map(normalizeLegacy).filter((p): p is LegacyPreset => p !== null);

  transaction(db, () => {
    for (const preset of legacy) {
      const camera = repo.getCameraByUuid(preset.cameraId);
      if (!camera) {
        // 없는 카메라의 프리셋은 옮길 자리가 없다. 버리지 않고 사유를 남긴다.
        result.skipped.push(`${label(preset)}: 등록되지 않은 카메라`);
        continue;
      }
      if (repo.listPresets(camera.cam_id).some((row) => row.preset_name === preset.name)) {
        result.skipped.push(`${label(preset)}: 같은 이름이 이미 있음`);
        continue;
      }
      repo.upsertPreset({
        preset_name: preset.name,
        cam_id: camera.cam_id,
        pos: clampPtz(preset.ptz),
        place_id: camera.place_id,
      });
      result.imported.push(label(preset));
    }
  });

  // 대조는 트랜잭션 밖에서 — 커밋된 것을 읽어야 진짜 확인이다.
  for (const preset of legacy) {
    if (!result.imported.includes(label(preset))) continue;
    const camera = repo.getCameraByUuid(preset.cameraId);
    const stored = camera && repo.listPresets(camera.cam_id).find((row) => row.preset_name === preset.name);
    if (!stored) {
      result.mismatches.push(`${label(preset)}: DB 에서 다시 찾지 못했습니다`);
      continue;
    }
    const want = clampPtz(preset.ptz);
    if (stored.pos_pan !== want.pan || stored.pos_tilt !== want.tilt || stored.pos_zoom !== want.zoom) {
      result.mismatches.push(
        `${label(preset)}: 좌표가 달라졌습니다 — ${want.pan}/${want.tilt}/${want.zoom} → ${stored.pos_pan}/${stored.pos_tilt}/${stored.pos_zoom}`,
      );
    }
  }
  return result;
}

export const LEGACY_PRESET_PATH = resolve(CONFIG_DIR, 'presets.json');

/**
 * 기동 시 1회. `presets.json` 이 남아 있으면 표로 옮기고 **파일 이름을 바꿔 물러나게 한다.**
 *
 * 이름을 바꾸는 것이 핵심이다 — 남겨 두면 다음 기동에 또 이관을 시도하고, 무엇보다
 * **정본이 둘로 보이는 상태**가 계속된다. 지우지 않고 `.bak-migrated` 로 남기는 이유는
 * `presets.json` 이 `.gitignore` 대상이라 되돌릴 곳이 git 어디에도 없기 때문이다.
 *
 * 대조가 어긋나면 **파일을 손대지 않고** 그대로 둔다 — 되돌릴 원본을 남긴다.
 *
 * @returns 이관 결과. 옮길 파일이 없으면 `null`(정상이다 — 이미 옮겼거나 처음 띄우는 것이다).
 */
export async function migratePresetsFile(db: DatabaseSync, path = LEGACY_PRESET_PATH): Promise<ImportResult | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // 깨진 파일을 조용히 버리지 않는다 — 사람이 보고 판단할 수 있게 그대로 둔다.
    return { imported: [], skipped: [], mismatches: [`${path}: JSON 을 해석할 수 없습니다`] };
  }
  const list = Array.isArray((raw as { presets?: unknown })?.presets) ? (raw as { presets: unknown[] }).presets : [];

  const result = importPresets(db, list);
  if (result.mismatches.length === 0) await rename(path, `${path}.bak-migrated`);
  return result;
}

function normalizeLegacy(raw: unknown): LegacyPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const ptz = p.ptz as Record<string, unknown> | undefined;
  if (typeof p.cameraId !== 'string' || typeof p.name !== 'string' || !ptz) return null;
  const values = [ptz.pan, ptz.tilt, ptz.zoom];
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return {
    cameraId: p.cameraId,
    name: p.name,
    ptz: { pan: ptz.pan as number, tilt: ptz.tilt as number, zoom: ptz.zoom as number },
  };
}

function label(preset: LegacyPreset): string {
  return `${preset.cameraId}/${preset.name}`;
}
