import { PAN_RANGE, TILT_RANGE, ZOOM_RANGE, type PtzRaw } from './ptz.js';

export interface DevicePresetEntry {
  number: number;
  name: string | null;
  seeded: boolean;
  ptz: PtzRaw | null;
  learnedAt: string | null;
}

export interface DevicePresetRegistry {
  version: 1;
  cameras: Record<string, DevicePresetEntry[]>;
}

export interface DevicePresetView extends DevicePresetEntry {
  flags: Array<'seeded' | 'generic' | 'learned' | 'unlearned'>;
}

export const EMPTY_DEVICE_PRESET_REGISTRY: DevicePresetRegistry = { version: 1, cameras: {} };

export function parseDevicePresetRegistry(raw: unknown): DevicePresetRegistry {
  if (!raw || typeof raw !== 'object') throw new Error('장비 프리셋 레지스트리의 최상위 값이 객체가 아닙니다');
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || !value.cameras || typeof value.cameras !== 'object' || Array.isArray(value.cameras)) {
    throw new Error('장비 프리셋 레지스트리 버전 또는 cameras 형식이 올바르지 않습니다');
  }
  const cameras: Record<string, DevicePresetEntry[]> = {};
  for (const [cameraId, entries] of Object.entries(value.cameras)) {
    if (!cameraId || !Array.isArray(entries)) throw new Error('장비 프리셋 카메라 항목 형식이 올바르지 않습니다');
    const parsed = entries.map(parseEntry);
    const numbers = new Set(parsed.map((entry) => entry.number));
    if (numbers.size !== parsed.length) throw new Error(`장비 프리셋 번호가 중복되었습니다: ${cameraId}`);
    cameras[cameraId] = parsed.sort((left, right) => left.number - right.number);
  }
  return { version: 1, cameras };
}

export function seededEntries(cameraId: string, entries: readonly DevicePresetEntry[]): DevicePresetEntry[] {
  const copy = entries.map(copyEntry);
  if (cameraId !== 'real-camera-2') return copy;
  for (const seed of [seedEntry(1, 'EV1'), seedEntry(2, 'EV2')]) {
    if (!copy.some((entry) => entry.number === seed.number)) copy.push(seed);
  }
  return copy.sort((left, right) => left.number - right.number);
}

export function toDevicePresetViews(cameraId: string, entries: readonly DevicePresetEntry[], usableMaximum: number): DevicePresetView[] {
  const seeded = seededEntries(cameraId, entries).filter((entry) => entry.number <= usableMaximum);
  const result = new Map(seeded.map((entry) => [entry.number, entry]));
  for (let number = 1; number <= Math.min(10, usableMaximum); number += 1) {
    if (!result.has(number)) result.set(number, { number, name: null, seeded: false, ptz: null, learnedAt: null });
  }
  return [...result.values()].sort((left, right) => left.number - right.number).map((entry) => ({
    ...copyEntry(entry),
    flags: [entry.seeded ? 'seeded' : 'generic', entry.ptz ? 'learned' : 'unlearned'],
  }));
}

export function upsertLearnedEntry(entries: readonly DevicePresetEntry[], number: number, ptz: PtzRaw, learnedAt: string): DevicePresetEntry[] {
  assertNumber(number);
  assertPtz(ptz);
  const current = entries.find((entry) => entry.number === number);
  const learned: DevicePresetEntry = { number, name: current?.name ?? null, seeded: current?.seeded ?? false, ptz: { ...ptz }, learnedAt };
  return [...entries.filter((entry) => entry.number !== number).map(copyEntry), learned].sort((left, right) => left.number - right.number);
}

function parseEntry(raw: unknown): DevicePresetEntry {
  if (!raw || typeof raw !== 'object') throw new Error('장비 프리셋 항목이 객체가 아닙니다');
  const value = raw as Record<string, unknown>;
  const number = value.number;
  if (typeof number !== 'number' || !Number.isInteger(number)) throw new Error('장비 프리셋 번호는 정수여야 합니다');
  assertNumber(number);
  if (value.name !== null && typeof value.name !== 'string') throw new Error('장비 프리셋 이름 형식이 올바르지 않습니다');
  if (value.name === '') throw new Error('장비 프리셋 이름의 빈 문자열은 허용되지 않습니다');
  if (typeof value.seeded !== 'boolean') throw new Error('장비 프리셋 seeded 형식이 올바르지 않습니다');
  if (value.learnedAt !== null && typeof value.learnedAt !== 'string') throw new Error('장비 프리셋 learnedAt 형식이 올바르지 않습니다');
  if (value.ptz !== null && !isPtz(value.ptz)) throw new Error('장비 프리셋 PTZ 형식이 올바르지 않습니다');
  if (value.ptz !== null) assertPtz(value.ptz);
  return { number, name: value.name, seeded: value.seeded, ptz: value.ptz === null ? null : { ...value.ptz }, learnedAt: value.learnedAt };
}

function isPtz(value: unknown): value is PtzRaw {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return Number.isInteger(raw.pan) && Number.isInteger(raw.tilt) && Number.isInteger(raw.zoom);
}

function assertNumber(number: number): void {
  if (!Number.isInteger(number) || number < 1 || number > 255) throw new Error('장비 프리셋 번호는 1..255 정수여야 합니다');
}

function assertPtz(ptz: PtzRaw): void {
  if (ptz.pan < PAN_RANGE[0] || ptz.pan > PAN_RANGE[1] || ptz.tilt < TILT_RANGE[0] || ptz.tilt > TILT_RANGE[1] || ptz.zoom < ZOOM_RANGE[0] || ptz.zoom > ZOOM_RANGE[1]) {
    throw new Error('장비 프리셋 PTZ raw 범위가 올바르지 않습니다');
  }
}

function seedEntry(number: number, name: string): DevicePresetEntry {
  return { number, name, seeded: true, ptz: null, learnedAt: null };
}

function copyEntry(entry: DevicePresetEntry): DevicePresetEntry {
  return { ...entry, ptz: entry.ptz ? { ...entry.ptz } : null };
}
