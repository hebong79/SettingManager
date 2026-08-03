import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SERVICE_ROOT } from '../config/configStore.js';
import { EMPTY_DEVICE_PRESET_REGISTRY, parseDevicePresetRegistry, seededEntries, toDevicePresetViews, upsertLearnedEntry, type DevicePresetEntry, type DevicePresetRegistry, type DevicePresetView } from '../domain/devicePresetRegistry.js';
import type { PtzRaw } from '../domain/ptz.js';

export const DEFAULT_DEVICE_PRESET_REGISTRY_PATH = resolve(SERVICE_ROOT, 'config', 'device-preset-registry.json');

/** 카메라 장비 프리셋의 메타데이터/학습 좌표만 별도 JSON으로 보관한다. */
export class DevicePresetRegistryStore {
  private registry: DevicePresetRegistry = EMPTY_DEVICE_PRESET_REGISTRY;
  private pending = Promise.resolve();

  constructor(readonly path: string = DEFAULT_DEVICE_PRESET_REGISTRY_PATH, private readonly now: () => string = () => new Date().toISOString()) {}

  async load(): Promise<void> {
    try {
      this.registry = parseDevicePresetRegistry(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (cause) {
      if (isMissingFile(cause)) {
        this.registry = EMPTY_DEVICE_PRESET_REGISTRY;
        await this.ensureSeeds();
        return;
      }
      throw new Error(`장비 프리셋 레지스트리를 읽을 수 없습니다: ${this.path}`, { cause });
    }
    await this.ensureSeeds();
  }

  list(cameraId: string, usableMaximum: number): DevicePresetView[] {
    return toDevicePresetViews(cameraId, this.registry.cameras[cameraId] ?? [], usableMaximum);
  }

  get(cameraId: string, number: number): DevicePresetEntry | undefined {
    return seededEntries(cameraId, this.registry.cameras[cameraId] ?? []).find((entry) => entry.number === number);
  }

  async learn(cameraId: string, number: number, ptz: PtzRaw): Promise<DevicePresetEntry> {
    return this.mutate(async (current) => {
      const entries = upsertLearnedEntry(current.cameras[cameraId] ?? [], number, ptz, this.now());
      const next: DevicePresetRegistry = { version: 1, cameras: { ...current.cameras, [cameraId]: entries } };
      return { next, result: entries.find((entry) => entry.number === number)! };
    });
  }

  private async ensureSeeds(): Promise<void> {
    const entries = seededEntries('real-camera-2', this.registry.cameras['real-camera-2'] ?? []);
    if (sameEntries(entries, this.registry.cameras['real-camera-2'] ?? [])) return;
    await this.commit({ version: 1, cameras: { ...this.registry.cameras, 'real-camera-2': entries } });
  }

  private mutate<T>(operation: (current: DevicePresetRegistry) => Promise<{ next: DevicePresetRegistry; result: T }>): Promise<T> {
    const run = this.pending.then(async () => {
      const { next, result } = await operation(this.registry);
      await this.commit(next);
      return result;
    });
    this.pending = run.then(() => undefined, () => undefined);
    return run;
  }

  private async commit(next: DevicePresetRegistry): Promise<void> {
    const temp = `${this.path}.tmp`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(temp, this.path);
    this.registry = next;
  }
}

function isMissingFile(cause: unknown): boolean {
  return !!cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT';
}

function sameEntries(left: readonly DevicePresetEntry[], right: readonly DevicePresetEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
