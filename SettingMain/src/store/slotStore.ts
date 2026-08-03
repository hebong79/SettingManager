import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Slot } from '../devices/cameraDriver.js';
import { SERVICE_ROOT } from '../config/configStore.js';

export const DEFAULT_SLOT_PATH = resolve(SERVICE_ROOT, 'config', 'slots.json');

/**
 * 카메라별 주차면 목록(읽기 전용).
 * 시뮬레이터는 씬이 진실의 출처라 드라이버가 답하고, 실카메라는 답할 곳이 없으므로
 * 이 파일이 그 자리를 채운다. 파일이 없으면 빈 목록이다 — 지어내지 않는다.
 */
export class SlotStore {
  private byCamera = new Map<string, Slot[]>();

  constructor(readonly path: string = DEFAULT_SLOT_PATH) {}

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      this.byCamera = new Map();
      return;
    }
    const parsed = JSON.parse(text) as { cameras?: Record<string, unknown> };
    const map = new Map<string, Slot[]>();
    for (const [cameraId, raw] of Object.entries(parsed.cameras ?? {})) {
      if (!Array.isArray(raw)) continue;
      map.set(
        cameraId,
        raw.map((entry, index) => {
          const s = (entry ?? {}) as Record<string, unknown>;
          const id = typeof s.id === 'string' ? s.id : String(index + 1);
          return { id, label: typeof s.label === 'string' && s.label ? s.label : id };
        }),
      );
    }
    this.byCamera = map;
  }

  list(cameraId: string): Slot[] {
    return this.byCamera.get(cameraId) ?? [];
  }
}
