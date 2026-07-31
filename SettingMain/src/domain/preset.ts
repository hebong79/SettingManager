import { clampPtz, type PtzRaw } from './ptz.js';

/** 프리셋 도메인. 파일 I/O 없는 순수 계층 — 목록 변환만 한다. */

export interface Preset {
  id: string;
  cameraId: string;
  name: string;
  ptz: PtzRaw;
  updatedAt: string;
}

export class PresetError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

export function listFor(presets: Preset[], cameraId: string): Preset[] {
  return presets.filter((p) => p.cameraId === cameraId);
}

/** 같은 카메라 안에서 이름은 유일해야 한다 — 콤보박스에서 구분이 안 되면 잘못 이동한다. */
function assertNameFree(presets: Preset[], cameraId: string, name: string, exceptId?: string): void {
  const clash = presets.some((p) => p.cameraId === cameraId && p.name === name && p.id !== exceptId);
  if (clash) throw new PresetError(`같은 이름의 프리셋이 이미 있습니다: ${name}`, 409);
}

function normalizeName(name: unknown): string {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!value) throw new PresetError('프리셋 이름이 필요합니다');
  if (value.length > 60) throw new PresetError('프리셋 이름은 60자 이하여야 합니다');
  return value;
}

export function addPreset(
  presets: Preset[],
  input: { cameraId: string; name: string; ptz: PtzRaw },
  now: string,
  nextId: string,
): { presets: Preset[]; preset: Preset } {
  const name = normalizeName(input.name);
  assertNameFree(presets, input.cameraId, name);
  const preset: Preset = {
    id: nextId,
    cameraId: input.cameraId,
    name,
    ptz: clampPtz(input.ptz),
    updatedAt: now,
  };
  return { presets: [...presets, preset], preset };
}

export function updatePreset(
  presets: Preset[],
  id: string,
  change: { name?: string; ptz?: PtzRaw },
  now: string,
): { presets: Preset[]; preset: Preset } {
  const current = presets.find((p) => p.id === id);
  if (!current) throw new PresetError(`프리셋을 찾을 수 없습니다: ${id}`, 404);

  const name = change.name === undefined ? current.name : normalizeName(change.name);
  if (name !== current.name) assertNameFree(presets, current.cameraId, name, id);

  const preset: Preset = {
    ...current,
    name,
    ptz: change.ptz ? clampPtz(change.ptz) : current.ptz,
    updatedAt: now,
  };
  return { presets: presets.map((p) => (p.id === id ? preset : p)), preset };
}

export function removePreset(presets: Preset[], id: string): { presets: Preset[]; removed: Preset } {
  const removed = presets.find((p) => p.id === id);
  if (!removed) throw new PresetError(`프리셋을 찾을 수 없습니다: ${id}`, 404);
  return { presets: presets.filter((p) => p.id !== id), removed };
}
