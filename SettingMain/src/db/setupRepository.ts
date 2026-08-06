import type { DatabaseSync } from 'node:sqlite';
import { DatabaseError, transaction } from './database.js';

/**
 * 커미셔닝 산출 저장소 — 장소·카메라·프리셋·슬롯.
 *
 * SQL 이 이 파일 밖으로 새지 않는다. 라우트나 코어가 문자열 질의를 들기 시작하면
 * 스키마를 바꿀 때 어디까지 고쳐야 하는지 아무도 모르게 된다.
 *
 * 좌표·픽셀 규약은 `schema.ts` 머리말과 같다.
 */

export interface PlaceRow {
  place_id: number;
  place_name: string;
}

export interface CameraRow {
  cam_id: number;
  cam_name: string;
  /** SettingManager 의 기기 id(`real-camera-1` 같은 문자열). */
  cam_uuid: string;
  url: string;
  user_id: string;
  password: string;
  rtsp_url: string;
  cam_type: 'ptz' | 'static';
  place_id: number;
  timeout_ms: number;
  /** 프로토콜. v4 에서 제조사를 여기로 합쳤다 — 열은 이것 하나다. 드라이버를 고르는 값이다. */
  kind: 'hucoms' | 'backend-core' | 'park3d-rpc';
  /** park3d-rpc 전용 1-based 번호. `cam_id`(우리 통번)와 다른 값이다. */
  park3d_cam_id: number | null;
  /** `{"zoomHfov":[{"z","h"}, …]}` JSON. 없으면 브리지 박스줌이 꺼진다. */
  intrinsics: string | null;
}

/** 넣을 때의 입력. v2 필드 넷은 생략하면 기존 값을 지킨다. */
export type CameraInput =
  Omit<CameraRow, 'cam_id' | 'timeout_ms' | 'kind' | 'park3d_cam_id' | 'intrinsics'>
  & Partial<Pick<CameraRow, 'cam_id' | 'timeout_ms' | 'kind' | 'park3d_cam_id' | 'intrinsics'>>;

export interface PresetRow {
  id: number;
  preset_id: number;
  preset_name: string;
  cam_id: number;
  pos_pan: number;
  pos_tilt: number;
  pos_zoom: number;
  place_id: number;
}

export interface SlotSetupRow {
  slot_id: number;
  cam_id: number;
  preset_id: number;
  preset_slotidx: number;
  marked_x: number | null;
  marked_y: number | null;
  slot_roi: string | null;
  slot3d_front_center: string | null;
  vpd_bbox: string | null;
  lpd_obb: string | null;
  ptz_pan: number | null;
  ptz_tilt: number | null;
  ptz_zoom: number | null;
  img1: string | null;
  updated_at: string;
}

/** 문서의 1번 표. `slot_setup` 에서 뽑은 것이며 저장되는 자리가 따로 없다. */
export interface FloorRoiRow {
  slot_id: number;
  cam_id: number;
  preset_id: number;
  preset_slotidx: number;
  slot_roi: string | null;
  /** `[pan, tilt, zoom]` JSON. 아직 센터라이징 안 된 슬롯은 null. */
  pos: string | null;
}

export interface Ptz {
  pan: number;
  tilt: number;
  zoom: number;
}

export interface SlotSetupInput {
  slot_id: number;
  cam_id: number;
  preset_id: number;
  preset_slotidx: number;
  /** 와이드 구도에서 사람이 찍은 픽셀. */
  marked?: { x: number; y: number } | null;
  /** 바닥 ROI 4점 `[[x,y], …]`. */
  slot_roi?: Array<[number, number]> | null;
  /** 3D 육면체 앞면 중심의 이미지 좌표. */
  slot3d_front_center?: { x: number; y: number } | null;
  /** VPD 바운딩 박스 `[x1,y1,x2,y2]`. */
  vpd_bbox?: [number, number, number, number] | null;
  /** LPD 번호판 OBB 4점 `[[x,y], …]`(TL→TR→BR→BL). */
  lpd_obb?: Array<[number, number]> | null;
  /** 번호판 중심 센터라이징 결과. 아직이면 생략한다 — 0 으로 채우지 않는다. */
  ptz?: Ptz | null;
  /** 차량 스냅샷의 **상대 경로**. 이미지 바이트는 DB 에 넣지 않는다. */
  img1?: string | null;
}

export interface SetupRepositoryOptions {
  now?: () => string;
}

export class SetupRepository {
  private readonly now: () => string;

  constructor(private readonly db: DatabaseSync, options: SetupRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  // --- 장소 ---------------------------------------------------------------

  listPlaces(): PlaceRow[] {
    return this.db.prepare('SELECT * FROM place_info ORDER BY place_id').all() as unknown as PlaceRow[];
  }

  upsertPlace(place: PlaceRow): PlaceRow {
    this.db.prepare(`
      INSERT INTO place_info (place_id, place_name) VALUES (?, ?)
      ON CONFLICT(place_id) DO UPDATE SET place_name = excluded.place_name
    `).run(place.place_id, place.place_name);
    return place;
  }

  /** 이 장소를 쓰는 카메라가 있으면 외래키(RESTRICT)가 막는다 — 호출자가 먼저 확인한다. */
  removePlace(placeId: number): boolean {
    return Number(this.db.prepare('DELETE FROM place_info WHERE place_id = ?').run(placeId).changes) > 0;
  }

  // --- 카메라 -------------------------------------------------------------

  listCameras(): CameraRow[] {
    return this.db.prepare('SELECT * FROM camera_info ORDER BY cam_id').all() as unknown as CameraRow[];
  }

  getCameraByUuid(camUuid: string): CameraRow | null {
    return (this.db.prepare('SELECT * FROM camera_info WHERE cam_uuid = ?').get(camUuid) as unknown as CameraRow) ?? null;
  }

  /**
   * `cam_uuid`(= SettingManager 기기 id)를 열쇠로 넣거나 갱신한다.
   * `cam_id` 를 주지 않으면 **다음 번호를 붙인다** — 문서 규약대로 1부터 센다.
   *
   * v2 에서 늘어난 넷은 생략할 수 있다. 생략하면 **기존 값을 지키고**, 처음 넣는 것이면
   * 기본값이 들어간다 — 분류만 고치는 호출이 접속 정보를 지우지 않게 하기 위해서다.
   */
  upsertCamera(input: CameraInput): CameraRow {
    return transaction(this.db, () => {
      const existing = this.getCameraByUuid(input.cam_uuid);
      const camId = input.cam_id ?? existing?.cam_id ?? this.nextCameraId();
      const filled: CameraRow = {
        ...input,
        cam_id: camId,
        timeout_ms: input.timeout_ms ?? existing?.timeout_ms ?? 5000,
        kind: input.kind ?? existing?.kind ?? 'hucoms',
        park3d_cam_id: input.park3d_cam_id === undefined ? (existing?.park3d_cam_id ?? null) : input.park3d_cam_id,
        intrinsics: input.intrinsics === undefined ? (existing?.intrinsics ?? null) : input.intrinsics,
      };
      // 장소가 없으면 만들어 둔다 — 외래키가 걸려 있어 없는 장소를 가리키면 카메라가 아예 안 들어간다.
      this.db.prepare(`INSERT OR IGNORE INTO place_info (place_id, place_name) VALUES (?, ?)`)
        .run(filled.place_id, `장소 ${filled.place_id}`);
      this.db.prepare(`
        INSERT INTO camera_info (cam_id, cam_name, cam_uuid, url, user_id, password, rtsp_url, cam_type, place_id,
                                 timeout_ms, kind, park3d_cam_id, intrinsics)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cam_id) DO UPDATE SET
          cam_name = excluded.cam_name, cam_uuid = excluded.cam_uuid, url = excluded.url,
          user_id = excluded.user_id, password = excluded.password, rtsp_url = excluded.rtsp_url,
          cam_type = excluded.cam_type, place_id = excluded.place_id,
          timeout_ms = excluded.timeout_ms, kind = excluded.kind,
          park3d_cam_id = excluded.park3d_cam_id, intrinsics = excluded.intrinsics
      `).run(
        camId, filled.cam_name, filled.cam_uuid, filled.url, filled.user_id, filled.password,
        filled.rtsp_url, filled.cam_type, filled.place_id,
        filled.timeout_ms, filled.kind, filled.park3d_cam_id, filled.intrinsics,
      );
      return filled;
    });
  }

  /** 프리셋·슬롯이 CASCADE 로 함께 사라진다 — 그 카메라로 찍은 커미셔닝 결과 전부다. */
  removeCamera(camId: number): boolean {
    return Number(this.db.prepare('DELETE FROM camera_info WHERE cam_id = ?').run(camId).changes) > 0;
  }

  private nextCameraId(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(cam_id), 0) + 1 AS next FROM camera_info').get() as { next: number };
    return Number(row.next);
  }

  // --- 프리셋 -------------------------------------------------------------

  listPresets(camId?: number): PresetRow[] {
    const sql = camId === undefined
      ? 'SELECT * FROM preset_info ORDER BY cam_id, preset_id'
      : 'SELECT * FROM preset_info WHERE cam_id = ? ORDER BY preset_id';
    const stmt = this.db.prepare(sql);
    return (camId === undefined ? stmt.all() : stmt.all(camId)) as unknown as PresetRow[];
  }

  getPreset(camId: number, presetId: number): PresetRow | null {
    return (this.db.prepare('SELECT * FROM preset_info WHERE cam_id = ? AND preset_id = ?').get(camId, presetId) as unknown as PresetRow) ?? null;
  }

  /** `preset_id` 를 주지 않으면 **그 카메라 안에서** 다음 번호를 붙인다(1부터). */
  upsertPreset(input: { preset_id?: number; preset_name: string; cam_id: number; pos: Ptz; place_id: number }): PresetRow {
    return transaction(this.db, () => {
      const presetId = input.preset_id ?? this.nextPresetId(input.cam_id);
      this.db.prepare(`
        INSERT INTO preset_info (preset_id, preset_name, cam_id, pos_pan, pos_tilt, pos_zoom, place_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cam_id, preset_id) DO UPDATE SET
          preset_name = excluded.preset_name, pos_pan = excluded.pos_pan,
          pos_tilt = excluded.pos_tilt, pos_zoom = excluded.pos_zoom, place_id = excluded.place_id
      `).run(presetId, input.preset_name, input.cam_id, input.pos.pan, input.pos.tilt, input.pos.zoom, input.place_id);
      const saved = this.getPreset(input.cam_id, presetId);
      if (!saved) throw new DatabaseError('프리셋을 저장했는데 다시 읽지 못했습니다');
      return saved;
    });
  }

  /**
   * 프리셋의 **열쇠**(`cam_id`·`preset_id`)를 옮긴다. 이름·좌표를 고치는 것과 다른 일이라
   * `upsertPreset` 으로는 표현할 수 없다 — 그쪽은 열쇠로 찾아가는 갱신이다.
   *
   * `slot_setup` 이 `(cam_id, preset_id)` 로 이 줄을 가리키므로 **주차면도 함께 옮긴다.**
   * 스키마에 `ON UPDATE CASCADE` 가 없어 두 갱신 사이에는 외래키가 반드시 한 번 깨지는데,
   * `defer_foreign_keys` 로 그 순간만 검사를 미룬다(커밋에서 다시 검사되므로 짝이 안 맞으면
   * 통째로 되돌아간다. 이 PRAGMA 는 커밋·롤백에서 스스로 꺼진다).
   *
   * @returns 따라 옮겨진 주차면 수.
   */
  movePreset(from: { cam_id: number; preset_id: number }, to: { cam_id: number; preset_id: number }): number {
    return transaction(this.db, () => {
      const source = this.getPreset(from.cam_id, from.preset_id);
      if (!source) {
        throw new DatabaseError(`등록되지 않은 프리셋입니다: cam_id=${from.cam_id} preset_id=${from.preset_id}`, 404);
      }
      if (to.cam_id === from.cam_id && to.preset_id === from.preset_id) return 0;
      if (!Number.isInteger(to.preset_id) || to.preset_id < 1) {
        throw new DatabaseError(`preset_id 는 1 이상의 정수여야 합니다: ${to.preset_id}`, 400);
      }
      if (!this.db.prepare('SELECT 1 FROM camera_info WHERE cam_id = ?').get(to.cam_id)) {
        throw new DatabaseError(`등록되지 않은 카메라입니다: cam_id=${to.cam_id}`, 400);
      }
      // 덮어쓰지 않는다 — 겹치는 자리로 옮기면 그쪽 프리셋의 주차면까지 뒤섞인다.
      if (this.getPreset(to.cam_id, to.preset_id)) {
        throw new DatabaseError(`이미 있는 프리셋입니다: cam_id=${to.cam_id} preset_id=${to.preset_id}`, 409);
      }

      this.db.exec('PRAGMA defer_foreign_keys = ON');
      const moved = Number(this.db.prepare('UPDATE slot_setup SET cam_id = ?, preset_id = ? WHERE cam_id = ? AND preset_id = ?')
        .run(to.cam_id, to.preset_id, from.cam_id, from.preset_id).changes);
      this.db.prepare('UPDATE preset_info SET cam_id = ?, preset_id = ? WHERE id = ?')
        .run(to.cam_id, to.preset_id, source.id);
      return moved;
    });
  }

  private nextPresetId(camId: number): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(preset_id), 0) + 1 AS next FROM preset_info WHERE cam_id = ?').get(camId) as { next: number };
    return Number(row.next);
  }

  removePreset(camId: number, presetId: number): boolean {
    // 슬롯은 외래키 ON DELETE CASCADE 로 함께 지워진다 — 없는 프리셋을 가리키는 슬롯을 남기지 않는다.
    return Number(this.db.prepare('DELETE FROM preset_info WHERE cam_id = ? AND preset_id = ?').run(camId, presetId).changes) > 0;
  }

  // --- 슬롯 ---------------------------------------------------------------

  listSlots(filter: { camId?: number; presetId?: number } = {}): SlotSetupRow[] {
    if (filter.camId !== undefined && filter.presetId !== undefined) {
      return this.db.prepare('SELECT * FROM slot_setup WHERE cam_id = ? AND preset_id = ? ORDER BY preset_slotidx')
        .all(filter.camId, filter.presetId) as unknown as SlotSetupRow[];
    }
    if (filter.camId !== undefined) {
      return this.db.prepare('SELECT * FROM slot_setup WHERE cam_id = ? ORDER BY preset_id, preset_slotidx')
        .all(filter.camId) as unknown as SlotSetupRow[];
    }
    return this.db.prepare('SELECT * FROM slot_setup ORDER BY slot_id').all() as unknown as SlotSetupRow[];
  }

  getSlot(slotId: number): SlotSetupRow | null {
    return (this.db.prepare('SELECT * FROM slot_setup WHERE slot_id = ?').get(slotId) as unknown as SlotSetupRow) ?? null;
  }

  /**
   * 슬롯 1건을 넣거나 갱신한다.
   *
   * **주지 않은 필드는 건드리지 않는다.** 커미셔닝은 여러 단계가 같은 줄을 조금씩 채우는
   * 일이라(ROI → 3D → 검출 → 센터라이징 → 스냅샷), 매번 전체를 요구하면 앞 단계 결과가
   * 지워진다. `null` 을 **명시로** 주면 그때는 지운다.
   */
  upsertSlot(input: SlotSetupInput): SlotSetupRow {
    return transaction(this.db, () => {
      if (!this.getPreset(input.cam_id, input.preset_id)) {
        throw new DatabaseError(`등록되지 않은 프리셋입니다: cam_id=${input.cam_id} preset_id=${input.preset_id}`, 404);
      }
      const previous = this.getSlot(input.slot_id);
      const pick = <K extends keyof SlotSetupInput>(key: K, column: keyof SlotSetupRow): string | number | null =>
        input[key] === undefined ? ((previous?.[column] as string | number | null) ?? null) : jsonOrNull(input[key]);

      const marked = input.marked === undefined
        ? { x: previous?.marked_x ?? null, y: previous?.marked_y ?? null }
        : input.marked === null ? { x: null, y: null } : { x: input.marked.x, y: input.marked.y };

      const ptz = input.ptz === undefined
        ? { pan: previous?.ptz_pan ?? null, tilt: previous?.ptz_tilt ?? null, zoom: previous?.ptz_zoom ?? null }
        : input.ptz === null
          ? { pan: null, tilt: null, zoom: null }
          : { pan: input.ptz.pan, tilt: input.ptz.tilt, zoom: input.ptz.zoom };

      this.db.prepare(`
        INSERT INTO slot_setup (slot_id, cam_id, preset_id, preset_slotidx, marked_x, marked_y,
                                slot_roi, slot3d_front_center,
                                vpd_bbox, lpd_obb, ptz_pan, ptz_tilt, ptz_zoom, img1, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(slot_id) DO UPDATE SET
          cam_id = excluded.cam_id, preset_id = excluded.preset_id, preset_slotidx = excluded.preset_slotidx,
          marked_x = excluded.marked_x, marked_y = excluded.marked_y,
          slot_roi = excluded.slot_roi, slot3d_front_center = excluded.slot3d_front_center,
          vpd_bbox = excluded.vpd_bbox, lpd_obb = excluded.lpd_obb,
          ptz_pan = excluded.ptz_pan, ptz_tilt = excluded.ptz_tilt, ptz_zoom = excluded.ptz_zoom,
          img1 = excluded.img1, updated_at = excluded.updated_at
      `).run(
        input.slot_id, input.cam_id, input.preset_id, input.preset_slotidx,
        marked.x, marked.y,
        pick('slot_roi', 'slot_roi'), pick('slot3d_front_center', 'slot3d_front_center'),
        pick('vpd_bbox', 'vpd_bbox'), pick('lpd_obb', 'lpd_obb'),
        ptz.pan, ptz.tilt, ptz.zoom,
        input.img1 === undefined ? (previous?.img1 ?? null) : input.img1,
        this.now(),
      );
      const saved = this.getSlot(input.slot_id);
      if (!saved) throw new DatabaseError('슬롯을 저장했는데 다시 읽지 못했습니다');
      return saved;
    });
  }

  removeSlot(slotId: number): boolean {
    return Number(this.db.prepare('DELETE FROM slot_setup WHERE slot_id = ?').run(slotId).changes) > 0;
  }

  /** 아직 번호판 센터라이징이 안 끝난 슬롯. 커미셔닝 진행률의 근거다. */
  listUncentered(): SlotSetupRow[] {
    return this.db.prepare('SELECT * FROM slot_setup WHERE ptz_pan IS NULL ORDER BY slot_id').all() as unknown as SlotSetupRow[];
  }

  // --- 최종 산출 ----------------------------------------------------------

  /** 문서 1번 표. 저장된 자리가 아니라 `slot_setup` 에서 뽑은 것이다. */
  floorRoi(): FloorRoiRow[] {
    return this.db.prepare('SELECT * FROM floor_ROI ORDER BY slot_id').all() as unknown as FloorRoiRow[];
  }
}

/** 객체·배열은 JSON 문자열로, 그 외(문자열·null)는 그대로. 스키마의 `json_valid` 와 짝이다. */
function jsonOrNull(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  return JSON.stringify(value);
}
