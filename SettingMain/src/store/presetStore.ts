import type { DatabaseSync } from 'node:sqlite';
import { toPreset } from '../db/configPresets.js';
import { SetupRepository, type PresetRow } from '../db/setupRepository.js';
import { normalizeName, PresetError, type Preset } from '../domain/preset.js';
import { clampPtz, type PtzRaw } from '../domain/ptz.js';

/**
 * 프리셋 영속 계층. **정본은 `preset_info` 표다**(2026-08-06).
 *
 * 전에는 `config/presets.json` 을 읽어 메모리 배열로 들고 있었다. 그래서 옵션 화면의 DB 탭에서
 * 같은 프리셋을 고쳐도 카메라 제어 화면은 옛 값을 계속 보여줬다 — **정본이 둘이었다.**
 *
 * **캐시를 두지 않는다.** 모든 메서드가 그때그때 표를 읽는다. 카메라(`ConfigStore.reloadCameras()`)
 * 처럼 재수화 시점을 관리해야 했다면 "DB 는 고쳤는데 화면은 옛 값"이 그대로 남았을 것이다.
 * 프리셋은 호출 빈도가 낮아(화면을 열 때·저장할 때) 매번 읽어도 값이 싸다.
 *
 * 메서드 이름과 시그니처는 파일 시절 그대로다 — `presetRoutes` 와 화면은 한 줄도 바뀌지 않는다.
 */
export class PresetStore {
  private readonly repo: SetupRepository;

  constructor(private readonly db: DatabaseSync) {
    this.repo = new SetupRepository(db);
  }

  list(cameraId: string): Preset[] {
    const camera = this.repo.getCameraByUuid(cameraId);
    if (!camera) return [];
    return this.repo.listPresets(camera.cam_id).map((row) => toPreset(row, cameraId));
  }

  get(id: string): Preset | undefined {
    const found = this.findById(id);
    return found ? toPreset(found.row, found.camUuid) : undefined;
  }

  async add(input: { cameraId: string; name: string; ptz: PtzRaw }): Promise<Preset> {
    const camera = this.repo.getCameraByUuid(input.cameraId);
    if (!camera) throw new PresetError(`등록되지 않은 카메라입니다: ${input.cameraId}`, 404);
    const name = normalizeName(input.name);
    this.assertNameFree(camera.cam_id, name);
    // place_id 는 카메라를 따라간다 — 프리셋만 다른 주차장에 속하는 일은 없다.
    const row = this.repo.upsertPreset({
      preset_name: name,
      cam_id: camera.cam_id,
      pos: clampPtz(input.ptz),
      place_id: camera.place_id,
    });
    return toPreset(row, camera.cam_uuid);
  }

  async update(id: string, change: { name?: string; ptz?: PtzRaw }): Promise<Preset> {
    const { row, camUuid, camId } = this.require(id);
    const name = change.name === undefined ? row.preset_name : normalizeName(change.name);
    if (name !== row.preset_name) this.assertNameFree(camId, name, row.id);
    const saved = this.repo.upsertPreset({
      preset_id: row.preset_id,
      preset_name: name,
      cam_id: camId,
      pos: change.ptz ? clampPtz(change.ptz) : { pan: row.pos_pan, tilt: row.pos_tilt, zoom: row.pos_zoom },
      place_id: row.place_id,
    });
    return toPreset(saved, camUuid);
  }

  async remove(id: string): Promise<Preset> {
    const { row, camUuid, camId } = this.require(id);
    const removed = toPreset(row, camUuid);
    // 그 프리셋의 주차면(slot_setup)도 외래키 CASCADE 로 함께 지워진다.
    this.repo.removePreset(camId, row.preset_id);
    return removed;
  }

  /** 같은 카메라 안에서 이름은 유일해야 한다 — 콤보박스에서 구분이 안 되면 잘못 이동한다. */
  private assertNameFree(camId: number, name: string, exceptRowId?: number): void {
    const clash = this.repo.listPresets(camId).some((row) => row.preset_name === name && row.id !== exceptRowId);
    if (clash) throw new PresetError(`같은 이름의 프리셋이 이미 있습니다: ${name}`, 409);
  }

  private require(id: string): { row: PresetRow; camUuid: string; camId: number } {
    const found = this.findById(id);
    if (!found) throw new PresetError(`프리셋을 찾을 수 없습니다: ${id}`, 404);
    return found;
  }

  /**
   * 대리키 한 개로 줄과 그 카메라를 함께 찾는다.
   * `cam_uuid` 까지 한 번에 읽는 이유: 부르는 쪽(`/api/presets/:id/goto`)이 **어느 카메라를
   * 움직일지**를 이 값으로 정한다. 따로 두 번 조회하면 그 사이에 `movePreset` 이 끼어들 수 있다.
   */
  private findById(id: string): { row: PresetRow; camUuid: string; camId: number } | undefined {
    const rowId = Number(id);
    if (!Number.isInteger(rowId) || rowId < 1) return undefined;
    const row = this.db.prepare(`
      SELECT p.*, c.cam_uuid AS cam_uuid FROM preset_info p
      JOIN camera_info c ON c.cam_id = p.cam_id
      WHERE p.id = ?
    `).get(rowId) as unknown as (PresetRow & { cam_uuid: string }) | undefined;
    return row ? { row, camUuid: row.cam_uuid, camId: row.cam_id } : undefined;
  }
}
