import type { DatabaseSync } from 'node:sqlite';
import { DatabaseError, transaction } from './database.js';
import type { SpotFile, StoredSpot } from '../store/spotStore.js';

/**
 * 커미셔닝 주차면(스팟)을 **SQLite 에 담고 backend-core 모양으로 답하는** 저장소.
 *
 * `SpotStore`(JSON 파일)와 같은 표면이라 `BridgeCoreProvider` 와 REST 응답이 바뀌지 않는다.
 *
 * ## 스팟과 탐색 점은 DB 에서 **같은 줄**이다
 *
 * 문서(`my_db_table.md`)의 `slot_setup` 한 줄이 곧 "프리셋 안의 주차면"이고, 그 줄에
 * 찍은 픽셀(`marked_*`)과 번호판 중심 조준해(`ptz_*`)가 함께 있다. backend-core 는 이 둘을
 * 다른 기능(탐색 점 / 스팟)으로 나눠 두었지만, **문서의 모델은 하나**다:
 * *"프리셋내 주차면들을 만들고 … 번호판 중심으로 센터라이징하고 줌을 하여 PTZ값을 저장한다."*
 *
 * 그래서 여기서 스팟을 저장하는 것은 **새 줄을 만드는 일이 아니라 그 줄의 `ptz_*` 를 채우는
 * 일**에 가깝다. `spot-<slot_id>` 는 전체 슬롯 통번을 그대로 쓴다.
 *
 * ## 프리셋이 필요하다
 * 모든 슬롯은 (카메라, 프리셋)에 속한다. 그래서 스팟을 새로 만들 때 어느 프리셋인지가
 * 정해져야 한다. 프리셋이 **정확히 하나면** 그것을 쓰고, 없거나 둘 이상이면 **묻는다** —
 * 아무거나 고르면 그 슬롯은 나중에 엉뚱한 구도의 점으로 읽힌다.
 */

export interface SpotDbStoreOptions {
  now?: () => string;
  placeId?: number;
}

export class SpotDbStore {
  private readonly now: () => string;
  private readonly placeId: number;

  constructor(private readonly db: DatabaseSync, readonly cameraId: string, options: SpotDbStoreOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.placeId = options.placeId ?? 1;
  }

  async load(): Promise<SpotFile> {
    const camId = this.camId();
    const spots = camId === null ? [] : (this.db.prepare(`
      SELECT * FROM slot_setup WHERE cam_id = ? AND ptz_pan IS NOT NULL ORDER BY slot_id
    `).all(camId) as unknown as SlotRow[]).map((row) => this.toSpot(row));
    return {
      schemaVersion: 1,
      cameraId: this.cameraId,
      // 와이드샷은 프리셋이 대신한다 — 프리셋 자체가 "이 구도에서 찍었다"는 기준이다.
      wideShot: this.wideShot(camId),
      nextSpotId: spots.length === 0 ? 1 : Math.max(...spots.map((s) => Number(s.slotId))) + 1,
      spots,
    };
  }

  /**
   * 지금 자세를 그 주차면의 조준해로 저장한다.
   * 실제로는 `slot_setup` 한 줄을 만들고 `marked_*` 와 `ptz_*` 를 함께 채운다.
   */
  async addSpot(input: { x: number; y: number; box?: unknown; name?: string; closeupPtz: unknown }): Promise<StoredSpot> {
    return transaction(this.db, () => {
      const camId = this.requireCamId();
      const presetId = this.solePresetId(camId);
      const idx = Number((this.db.prepare('SELECT COALESCE(MAX(preset_slotidx), 0) + 1 AS n FROM slot_setup WHERE cam_id = ? AND preset_id = ?').get(camId, presetId) as { n: number }).n);
      const slotId = Number((this.db.prepare('SELECT COALESCE(MAX(slot_id), 0) + 1 AS n FROM slot_setup').get() as { n: number }).n);
      const ptz = asStoredPtz(input.closeupPtz);
      const at = this.now();
      this.db.prepare(`
        INSERT INTO slot_setup (slot_id, cam_id, preset_id, preset_slotidx, marked_x, marked_y,
                                vpd_bbox, ptz_pan, ptz_tilt, ptz_zoom, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        slotId, camId, presetId, idx, Math.round(input.x), Math.round(input.y),
        input.box === undefined || input.box === null ? null : JSON.stringify(input.box),
        ptz.panpos, ptz.tiltpos, ptz.zoompos, at,
      );
      const saved = this.db.prepare('SELECT * FROM slot_setup WHERE slot_id = ?').get(slotId) as unknown as SlotRow;
      return { ...this.toSpot(saved), name: input.name || `spot-${slotId}` };
    });
  }

  async getSpot(id: string): Promise<StoredSpot | null> {
    const row = this.db.prepare('SELECT * FROM slot_setup WHERE slot_id = ? AND ptz_pan IS NOT NULL').get(idNumber(id)) as unknown as SlotRow | undefined;
    return row ? this.toSpot(row) : null;
  }

  async removeSpot(id: string): Promise<boolean> {
    return this.db.prepare('DELETE FROM slot_setup WHERE slot_id = ?').run(idNumber(id)).changes > 0;
  }

  /**
   * 와이드샷 저장. **프리셋의 자세를 갱신하는 것**과 같은 일이라 그쪽에 쓴다 —
   * 별도 표를 만들면 "이 구도에서 찍었다"는 사실이 두 자리에 생긴다.
   */
  async setWideShot(ptz: unknown): Promise<{ ptz: unknown; savedAt: string }> {
    return transaction(this.db, () => {
      const camId = this.requireCamId();
      const presetId = this.solePresetId(camId);
      const p = asStoredPtz(ptz);
      this.db.prepare('UPDATE preset_info SET pos_pan = ?, pos_tilt = ?, pos_zoom = ? WHERE cam_id = ? AND preset_id = ?')
        .run(p.panpos, p.tiltpos, p.zoompos, camId, presetId);
      return { ptz: p, savedAt: this.now() };
    });
  }

  // --- 내부 ---------------------------------------------------------------

  private camId(): number | null {
    const row = this.db.prepare('SELECT cam_id FROM camera_info WHERE cam_uuid = ?').get(this.cameraId) as { cam_id: number } | undefined;
    return row ? Number(row.cam_id) : null;
  }

  private requireCamId(): number {
    const existing = this.camId();
    if (existing !== null) return existing;
    const next = Number((this.db.prepare('SELECT COALESCE(MAX(cam_id), 0) + 1 AS n FROM camera_info').get() as { n: number }).n);
    this.db.prepare('INSERT INTO camera_info (cam_id, cam_name, cam_uuid, place_id) VALUES (?, ?, ?, ?)')
      .run(next, this.cameraId, this.cameraId, this.placeId);
    return next;
  }

  /** 프리셋이 하나면 그것. 없거나 여럿이면 **고르지 않고 묻는다**. */
  private solePresetId(camId: number): number {
    const rows = this.db.prepare('SELECT preset_id FROM preset_info WHERE cam_id = ? ORDER BY preset_id').all(camId) as unknown as Array<{ preset_id: number }>;
    if (rows.length === 1) return Number(rows[0]!.preset_id);
    if (rows.length === 0) {
      throw new DatabaseError(`기기 ${this.cameraId} 에 탐색 프리셋이 없습니다 — 주차면은 프리셋(구도)에 속하므로 먼저 프리셋을 만드십시오`, 409);
    }
    throw new DatabaseError(
      `기기 ${this.cameraId} 에 프리셋이 ${rows.length}개 있습니다 — 어느 구도의 주차면인지 정해야 합니다(아무거나 고르면 나중에 엉뚱한 구도의 점으로 읽힙니다)`,
      409,
    );
  }

  private wideShot(camId: number | null): SpotFile['wideShot'] {
    if (camId === null) return null;
    const row = this.db.prepare('SELECT pos_pan, pos_tilt, pos_zoom FROM preset_info WHERE cam_id = ? ORDER BY preset_id LIMIT 1')
      .get(camId) as { pos_pan: number; pos_tilt: number; pos_zoom: number } | undefined;
    if (!row) return null;
    return { ptz: { panpos: row.pos_pan, tiltpos: row.pos_tilt, zoompos: row.pos_zoom, focuspos: 0 }, savedAt: '' };
  }

  private toSpot(row: SlotRow): StoredSpot {
    return {
      id: `spot-${row.slot_id}`,
      name: `spot-${row.slot_id}`,
      markedPixel: { x: row.marked_x ?? 0, y: row.marked_y ?? 0 },
      box: row.vpd_bbox ? (JSON.parse(row.vpd_bbox) as unknown) : null,
      widePtz: null,
      closeupPtz: row.ptz_pan === null ? null : { panpos: row.ptz_pan, tiltpos: row.ptz_tilt, zoompos: row.ptz_zoom, focuspos: 0 },
      createdAt: row.updated_at,
      /** DB 로 옮기면서 생긴 전체 슬롯 통번. */
      slotId: row.slot_id,
      presetSlotIdx: row.preset_slotidx,
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
  vpd_bbox: string | null;
  ptz_pan: number | null;
  ptz_tilt: number | null;
  ptz_zoom: number | null;
  updated_at: string;
}

function idNumber(id: string): number {
  const match = /(\d+)$/.exec(String(id));
  return match ? Number(match[1]) : 0;
}

/** 계약 좌표(`pan`)로 와도, 저장 형식(`panpos`)으로 와도 읽는다. */
function asStoredPtz(raw: unknown): { panpos: number; tiltpos: number; zoompos: number } {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pick = (a: string, b: string): number => Math.round(Number(p[a] ?? p[b]) || 0);
  return { panpos: pick('panpos', 'pan'), tiltpos: pick('tiltpos', 'tilt'), zoompos: pick('zoompos', 'zoom') };
}
