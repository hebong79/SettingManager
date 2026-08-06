import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './database.js';
import type {
  DiscoveryFile,
  DiscoveryPointRecord,
  DiscoveryPresetRecord,
  StoredPtz,
} from '../store/discoveryStore.js';
import { normPtz } from '../store/discoveryStore.js';

/**
 * 탐색 프리셋·점을 **SQLite 에 담고 backend-core 모양으로 답하는** 저장소.
 *
 * `DiscoveryStore`(JSON 파일)와 **같은 표면**을 가진다 — 그래서 `BridgeCoreProvider` 도
 * REST 응답 모양도 한 줄 바뀌지 않는다. 바뀐 것은 바이트가 어디에 있느냐뿐이다.
 *
 * ## id 두 벌을 잇는 자리
 *
 * | 밖(backend-core 어휘) | DB |
 * |---|---|
 * | 프리셋 `p-3` | `preset_info.preset_id = 3` (카메라 안에서 1부터) |
 * | 점 `pt-2` | `slot_setup.preset_slotidx = 2` (프리셋 안에서 1부터) |
 * | — | `slot_setup.slot_id` (**전체 슬롯 통번**) |
 *
 * 문서(`my_db_table.md`)의 목적 첫 줄이 정확히 이 대응이다 —
 * *"프리셋내 주차면들을 만들고 전체 슬롯 인덱스에 매핑한다."*
 * JSON 파일에는 통번 개념이 없었으므로, **DB 로 옮기면서 얻는 것**이 그 통번이다.
 *
 * ## 내보내기가 공짜인 이유
 * `load()` 가 backend-core 파일과 같은 객체를 만든다. 그래서 그 결과를 그대로 쓰면
 * `discovery-<id>.json` 이 된다(`backendCoreExport.ts`). 형식 변환 코드가 따로 없으므로
 * 내보내기와 실제 동작이 어긋날 수 없다.
 */

export interface DiscoveryDbStoreOptions {
  now?: () => string;
  /** 문서 규약: 현재는 무조건 1. */
  placeId?: number;
}

export class DiscoveryDbStore {
  private readonly now: () => string;
  private readonly placeId: number;

  constructor(private readonly db: DatabaseSync, readonly cameraId: string, options: DiscoveryDbStoreOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.placeId = options.placeId ?? 1;
  }

  async load(): Promise<DiscoveryFile> {
    const presets = await this.listPresets();
    return {
      schemaVersion: 1,
      cameraId: this.cameraId,
      nextPresetId: presets.length === 0 ? 1 : Math.max(...presets.map((p) => idNumber(p.id))) + 1,
      presets,
    };
  }

  async listPresets(): Promise<DiscoveryPresetRecord[]> {
    const camId = this.camId();
    if (camId === null) return [];
    const rows = this.db.prepare(`
      SELECT preset_id, preset_name, pos_pan, pos_tilt, pos_zoom FROM preset_info
      WHERE cam_id = ? ORDER BY preset_id
    `).all(camId) as unknown as Array<{ preset_id: number; preset_name: string; pos_pan: number; pos_tilt: number; pos_zoom: number }>;
    return rows.map((row) => this.toPreset(camId, row));
  }

  async getPreset(id: string): Promise<DiscoveryPresetRecord | null> {
    const camId = this.camId();
    const presetId = idNumber(id);
    if (camId === null || presetId === 0) return null;
    const row = this.db.prepare(`
      SELECT preset_id, preset_name, pos_pan, pos_tilt, pos_zoom FROM preset_info WHERE cam_id = ? AND preset_id = ?
    `).get(camId, presetId) as unknown as { preset_id: number; preset_name: string; pos_pan: number; pos_tilt: number; pos_zoom: number } | undefined;
    return row ? this.toPreset(camId, row) : null;
  }

  async addPreset(input: { name?: unknown; ptz?: unknown }): Promise<DiscoveryPresetRecord> {
    return transaction(this.db, () => {
      const camId = this.requireCamId();
      const next = Number((this.db.prepare('SELECT COALESCE(MAX(preset_id), 0) + 1 AS n FROM preset_info WHERE cam_id = ?').get(camId) as { n: number }).n);
      const count = Number((this.db.prepare('SELECT COUNT(*) AS c FROM preset_info WHERE cam_id = ?').get(camId) as { c: number }).c);
      const ptz = normPtz(input.ptz);
      this.db.prepare(`
        INSERT INTO preset_info (preset_id, preset_name, cam_id, pos_pan, pos_tilt, pos_zoom, place_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(next, input.name ? String(input.name) : `프리셋 ${count + 1}`, camId, ptz.panpos, ptz.tiltpos, ptz.zoompos, this.placeId);
      return this.toPreset(camId, {
        preset_id: next,
        preset_name: input.name ? String(input.name) : `프리셋 ${count + 1}`,
        pos_pan: ptz.panpos, pos_tilt: ptz.tiltpos, pos_zoom: ptz.zoompos,
      });
    });
  }

  async updatePreset(id: string, patch: { name?: unknown; ptz?: unknown }): Promise<DiscoveryPresetRecord | null> {
    const camId = this.camId();
    const presetId = idNumber(id);
    if (camId === null || !(await this.getPreset(id))) return null;
    if (patch.name !== undefined) {
      this.db.prepare('UPDATE preset_info SET preset_name = ? WHERE cam_id = ? AND preset_id = ?').run(String(patch.name), camId, presetId);
    }
    if (patch.ptz !== undefined) {
      const ptz = normPtz(patch.ptz);
      this.db.prepare('UPDATE preset_info SET pos_pan = ?, pos_tilt = ?, pos_zoom = ? WHERE cam_id = ? AND preset_id = ?')
        .run(ptz.panpos, ptz.tiltpos, ptz.zoompos, camId, presetId);
    }
    return this.getPreset(id);
  }

  async removePreset(id: string): Promise<boolean> {
    const camId = this.camId();
    if (camId === null) return false;
    // 슬롯은 외래키 CASCADE 로 함께 지워진다 — 없는 프리셋을 가리키는 슬롯을 남기지 않는다.
    return this.db.prepare('DELETE FROM preset_info WHERE cam_id = ? AND preset_id = ?').run(camId, idNumber(id)).changes > 0;
  }

  // --- 점 = slot_setup 한 줄 ------------------------------------------------

  async listPoints(id: string): Promise<DiscoveryPointRecord[] | null> {
    const preset = await this.getPreset(id);
    return preset ? (preset.points ?? []) : null;
  }

  async addPoint(id: string, input: { x?: unknown; y?: unknown; name?: unknown }): Promise<DiscoveryPointRecord | null> {
    const camId = this.camId();
    const presetId = idNumber(id);
    if (camId === null || !(await this.getPreset(id))) return null;
    return transaction(this.db, () => {
      const idx = Number((this.db.prepare('SELECT COALESCE(MAX(preset_slotidx), 0) + 1 AS n FROM slot_setup WHERE cam_id = ? AND preset_id = ?').get(camId, presetId) as { n: number }).n);
      // **전체 슬롯 통번** — 프리셋·카메라를 가로질러 하나씩 올라간다(문서의 "전체 슬롯 인덱스").
      const slotId = Number((this.db.prepare('SELECT COALESCE(MAX(slot_id), 0) + 1 AS n FROM slot_setup').get() as { n: number }).n);
      const at = this.now();
      this.db.prepare(`
        INSERT INTO slot_setup (slot_id, cam_id, preset_id, preset_slotidx, marked_x, marked_y, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(slotId, camId, presetId, idx, clampPx(input.x, 1920), clampPx(input.y, 1080), at);
      return {
        id: `pt-${idx}`,
        name: input.name ? String(input.name) : String(idx),
        x: clampPx(input.x, 1920),
        y: clampPx(input.y, 1080),
        createdAt: at,
        slotId,
      } satisfies DiscoveryPointRecord;
    });
  }

  async updatePoint(id: string, pointId: string, patch: Record<string, unknown>): Promise<DiscoveryPointRecord | null> {
    const camId = this.camId();
    const presetId = idNumber(id);
    const idx = idNumber(pointId);
    if (camId === null) return null;
    const row = this.slotRow(camId, presetId, idx);
    if (!row) return null;
    if (patch.x !== undefined || patch.y !== undefined) {
      this.db.prepare('UPDATE slot_setup SET marked_x = ?, marked_y = ?, updated_at = ? WHERE slot_id = ?').run(
        patch.x !== undefined ? clampPx(patch.x, 1920) : row.marked_x,
        patch.y !== undefined ? clampPx(patch.y, 1080) : row.marked_y,
        this.now(),
        row.slot_id,
      );
    }
    return this.toPoint(this.slotRow(camId, presetId, idx)!, patch.name !== undefined ? String(patch.name) : undefined);
  }

  async removePoint(id: string, pointId: string): Promise<boolean> {
    const camId = this.camId();
    if (camId === null) return false;
    return this.db.prepare('DELETE FROM slot_setup WHERE cam_id = ? AND preset_id = ? AND preset_slotidx = ?')
      .run(camId, idNumber(id), idNumber(pointId)).changes > 0;
  }

  async clearPoints(id: string): Promise<number | null> {
    const camId = this.camId();
    if (camId === null || !(await this.getPreset(id))) return null;
    // node:sqlite 의 changes 는 bigint 다 — 그대로 두면 JSON 에 직렬화되지 않는다.
    return Number(this.db.prepare('DELETE FROM slot_setup WHERE cam_id = ? AND preset_id = ?').run(camId, idNumber(id)).changes);
  }

  // --- 내부 ---------------------------------------------------------------

  /** 이 카메라가 DB 에 등록돼 있는가. 없으면 프리셋도 있을 수 없다. */
  private camId(): number | null {
    const row = this.db.prepare('SELECT cam_id FROM camera_info WHERE cam_uuid = ?').get(this.cameraId) as { cam_id: number } | undefined;
    return row ? Number(row.cam_id) : null;
  }

  /**
   * 쓰기 경로에서는 카메라가 **반드시** 있어야 한다. 없으면 여기서 만든다 —
   * 던지면 "프리셋을 만들려면 먼저 카메라를 등록하라"는 요구가 되는데, 이 서비스에서
   * 카메라의 정본은 `config.json` 이고 사용자는 이미 거기에 등록해 두었다.
   */
  private requireCamId(): number {
    const existing = this.camId();
    if (existing !== null) return existing;
    const next = Number((this.db.prepare('SELECT COALESCE(MAX(cam_id), 0) + 1 AS n FROM camera_info').get() as { n: number }).n);
    this.db.prepare(`
      INSERT INTO camera_info (cam_id, cam_name, cam_uuid, place_id) VALUES (?, ?, ?, ?)
    `).run(next, this.cameraId, this.cameraId, this.placeId);
    return next;
  }

  private slotRow(camId: number, presetId: number, idx: number): SlotRow | null {
    return (this.db.prepare('SELECT * FROM slot_setup WHERE cam_id = ? AND preset_id = ? AND preset_slotidx = ?')
      .get(camId, presetId, idx) as unknown as SlotRow) ?? null;
  }

  private toPreset(camId: number, row: { preset_id: number; preset_name: string; pos_pan: number; pos_tilt: number; pos_zoom: number }): DiscoveryPresetRecord {
    const slots = this.db.prepare('SELECT * FROM slot_setup WHERE cam_id = ? AND preset_id = ? ORDER BY preset_slotidx')
      .all(camId, row.preset_id) as unknown as SlotRow[];
    const points = slots.map((slot) => this.toPoint(slot));
    return {
      id: `p-${row.preset_id}`,
      name: row.preset_name,
      ptz: { panpos: row.pos_pan, tiltpos: row.pos_tilt, zoompos: row.pos_zoom, focuspos: 0 } satisfies StoredPtz,
      createdAt: slots[0]?.updated_at ?? '',
      updatedAt: slots[slots.length - 1]?.updated_at ?? '',
      points,
      nextPointId: points.length === 0 ? 1 : Math.max(...slots.map((s) => s.preset_slotidx)) + 1,
    };
  }

  private toPoint(slot: SlotRow, name?: string): DiscoveryPointRecord {
    return {
      id: `pt-${slot.preset_slotidx}`,
      name: name ?? String(slot.preset_slotidx),
      x: slot.marked_x ?? 0,
      y: slot.marked_y ?? 0,
      createdAt: slot.updated_at,
      // JSON 파일에는 없던 값이다 — DB 로 옮기면서 생긴 전체 슬롯 통번을 그대로 실어 보낸다.
      slotId: slot.slot_id,
    };
  }
}

interface SlotRow {
  slot_id: number;
  cam_id: number;
  preset_id: number;
  preset_slotidx: number;
  marked_x: number | null;
  marked_y: number | null;
  updated_at: string;
}

/** `p-3` · `pt-2` → 3 · 2. 모양이 아니면 0(= 없는 것)으로 본다. */
function idNumber(id: string): number {
  const match = /(\d+)$/.exec(String(id));
  return match ? Number(match[1]) : 0;
}

function clampPx(value: unknown, max: number): number {
  return Math.max(0, Math.min(max, Math.round(Number(value) || 0)));
}
