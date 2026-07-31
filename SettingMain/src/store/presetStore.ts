import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { addPreset, listFor, removePreset, updatePreset, type Preset } from '../domain/preset.js';
import type { PtzRaw } from '../domain/ptz.js';
import { SERVICE_ROOT } from '../config/configStore.js';

export const DEFAULT_PRESET_PATH = resolve(SERVICE_ROOT, 'config', 'presets.json');

/** 프리셋 영속 계층. 도메인 순수 함수를 감싸고 파일 I/O 만 담당한다. */
export class PresetStore {
  private presets: Preset[] = [];
  private sequence = 0;

  constructor(
    readonly path: string = DEFAULT_PRESET_PATH,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      // 파일이 아직 없는 것은 정상이다 — 첫 저장에서 만들어진다.
      this.presets = [];
      return;
    }
    const parsed = JSON.parse(text) as { presets?: unknown };
    const list = Array.isArray(parsed.presets) ? parsed.presets : [];
    this.presets = list.filter(isPreset);
    this.sequence = this.presets.reduce((max, p) => Math.max(max, idNumber(p.id)), 0);
  }

  list(cameraId: string): Preset[] {
    return listFor(this.presets, cameraId);
  }

  get(id: string): Preset | undefined {
    return this.presets.find((p) => p.id === id);
  }

  async add(input: { cameraId: string; name: string; ptz: PtzRaw }): Promise<Preset> {
    this.sequence += 1;
    const { presets, preset } = addPreset(this.presets, input, this.now(), `p-${this.sequence}`);
    await this.commit(presets);
    return preset;
  }

  async update(id: string, change: { name?: string; ptz?: PtzRaw }): Promise<Preset> {
    const { presets, preset } = updatePreset(this.presets, id, change, this.now());
    await this.commit(presets);
    return preset;
  }

  async remove(id: string): Promise<Preset> {
    const { presets, removed } = removePreset(this.presets, id);
    await this.commit(presets);
    return removed;
  }

  /**
   * 카메라가 지워질 때 그 카메라의 프리셋도 함께 지운다.
   * 남겨 두면 없는 기기를 가리키는 프리셋이 되고, 같은 id 로 다른 기기를 등록하는 순간
   * 남의 좌표로 이동하는 프리셋이 되살아난다.
   */
  async removeByCamera(cameraId: string): Promise<number> {
    const kept = this.presets.filter((p) => p.cameraId !== cameraId);
    const removedCount = this.presets.length - kept.length;
    if (removedCount > 0) await this.commit(kept);
    return removedCount;
  }

  private async commit(presets: Preset[]): Promise<void> {
    const temp = `${this.path}.tmp`;
    await writeFile(temp, `${JSON.stringify({ presets }, null, 2)}\n`, 'utf8');
    await rename(temp, this.path);
    this.presets = presets;
  }
}

function isPreset(raw: unknown): raw is Preset {
  if (!raw || typeof raw !== 'object') return false;
  const p = raw as Record<string, unknown>;
  const ptz = p.ptz as Record<string, unknown> | undefined;
  return (
    typeof p.id === 'string' &&
    typeof p.cameraId === 'string' &&
    typeof p.name === 'string' &&
    !!ptz &&
    typeof ptz.pan === 'number' &&
    typeof ptz.tilt === 'number' &&
    typeof ptz.zoom === 'number'
  );
}

function idNumber(id: string): number {
  const match = /^p-(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}
