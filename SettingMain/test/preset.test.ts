import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.js';
import { importPresets, toPreset } from '../src/db/configPresets.js';
import { SetupRepository } from '../src/db/setupRepository.js';
import { PresetError } from '../src/domain/preset.js';
import { PresetStore } from '../src/store/presetStore.js';

/**
 * 프리셋 정본이 `config/presets.json` 에서 **`preset_info` 표로** 옮겨진 뒤의 검증이다
 * (2026-08-06). 예전 이 파일은 배열을 받아 새 배열을 내는 순수 함수들을 검사했는데,
 * 그 함수들이 사라졌으므로 **같은 규칙을 새 계층(저장소 + 표)에서** 다시 고정한다.
 *
 * 핵심 관심사는 하나다: **카메라 제어 화면(`PresetStore`)과 옵션 DB 탭(`preset_info`)이
 * 같은 줄을 본다.** 그래서 대부분의 테스트가 한쪽으로 쓰고 **반대쪽으로 읽는다** —
 * 양쪽에서 같은 API 로 읽으면 정본이 둘이어도 통과해 버린다.
 */

let db: DatabaseSync;
let store: PresetStore;
let repo: SetupRepository;

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  repo = new SetupRepository(db);
  repo.upsertCamera({ cam_name: '리얼 1', cam_uuid: 'cam-a', url: 'http://10.0.0.1', user_id: '', password: '', rtsp_url: '', cam_type: 'ptz', place_id: 1 });
  repo.upsertCamera({ cam_name: '리얼 2', cam_uuid: 'cam-b', url: 'http://10.0.0.2', user_id: '', password: '', rtsp_url: '', cam_type: 'ptz', place_id: 1 });
  store = new PresetStore(db);
});

afterEach(() => db.close());

/** DB 탭이 보는 것 — 저장소를 거치지 않고 표를 직접 읽는다. */
function tableRows(camUuid: string): Array<{ preset_id: number; preset_name: string; pos_pan: number }> {
  const camId = repo.getCameraByUuid(camUuid)!.cam_id;
  return repo.listPresets(camId).map((r) => ({ preset_id: r.preset_id, preset_name: r.preset_name, pos_pan: r.pos_pan }));
}

describe('제어 화면 → DB 탭 방향', () => {
  it('저장소로 추가하면 preset_info 에 줄이 생긴다 — 파일이 아니라 표다', async () => {
    await store.add({ cameraId: 'cam-a', name: '정문 와이드', ptz: { pan: 100, tilt: 200, zoom: 300 } });
    expect(tableRows('cam-a')).toEqual([{ preset_id: 1, preset_name: '정문 와이드', pos_pan: 100 }]);
  });

  it('preset_id 는 그 카메라 안에서 1부터 붙는다 — 카메라마다 따로 센다', async () => {
    await store.add({ cameraId: 'cam-a', name: 'A1', ptz: { pan: 1, tilt: 0, zoom: 0 } });
    await store.add({ cameraId: 'cam-a', name: 'A2', ptz: { pan: 2, tilt: 0, zoom: 0 } });
    await store.add({ cameraId: 'cam-b', name: 'B1', ptz: { pan: 3, tilt: 0, zoom: 0 } });
    expect(tableRows('cam-a').map((r) => r.preset_id)).toEqual([1, 2]);
    expect(tableRows('cam-b').map((r) => r.preset_id)).toEqual([1]);
  });

  it('place_id 는 카메라를 따라간다 — 프리셋만 다른 주차장에 속하지 않는다', async () => {
    db.exec(`INSERT INTO place_info (place_id, place_name) VALUES (7, '지하 2층')`);
    repo.upsertCamera({ cam_name: '지하', cam_uuid: 'cam-c', url: '', user_id: '', password: '', rtsp_url: '', cam_type: 'ptz', place_id: 7 });
    const preset = await store.add({ cameraId: 'cam-c', name: '입구', ptz: { pan: 0, tilt: 0, zoom: 0 } });
    const camId = repo.getCameraByUuid('cam-c')!.cam_id;
    expect(repo.getPreset(camId, Number(1))!.place_id).toBe(7);
    expect(preset.cameraId).toBe('cam-c');
  });

  it('지우면 표에서도 사라진다', async () => {
    const preset = await store.add({ cameraId: 'cam-a', name: '지울 것', ptz: { pan: 0, tilt: 0, zoom: 0 } });
    await store.remove(preset.id);
    expect(tableRows('cam-a')).toEqual([]);
  });
});

describe('DB 탭 → 제어 화면 방향', () => {
  it('표에 직접 넣은 줄이 제어 화면 목록에 바로 보인다 — 캐시가 없다', () => {
    const camId = repo.getCameraByUuid('cam-a')!.cam_id;
    repo.upsertPreset({ preset_name: 'DB에서 만듦', cam_id: camId, pos: { pan: 11, tilt: 22, zoom: 33 }, place_id: 1 });
    expect(store.list('cam-a')).toEqual([
      { id: expect.any(String), cameraId: 'cam-a', name: 'DB에서 만듦', ptz: { pan: 11, tilt: 22, zoom: 33 } },
    ]);
  });

  it('표에서 이름·좌표를 고치면 다음 조회에 반영된다', async () => {
    const preset = await store.add({ cameraId: 'cam-a', name: '옛 이름', ptz: { pan: 1, tilt: 2, zoom: 3 } });
    const camId = repo.getCameraByUuid('cam-a')!.cam_id;
    repo.upsertPreset({ preset_id: 1, preset_name: '새 이름', cam_id: camId, pos: { pan: 9, tilt: 8, zoom: 7 }, place_id: 1 });
    expect(store.get(preset.id)).toEqual({ id: preset.id, cameraId: 'cam-a', name: '새 이름', ptz: { pan: 9, tilt: 8, zoom: 7 } });
  });

  it('DB 탭에서 프리셋을 다른 카메라로 옮겨도 id 는 그대로다 — 대리키를 쓰기 때문', async () => {
    const preset = await store.add({ cameraId: 'cam-a', name: '이사감', ptz: { pan: 5, tilt: 5, zoom: 5 } });
    const from = repo.getCameraByUuid('cam-a')!.cam_id;
    const to = repo.getCameraByUuid('cam-b')!.cam_id;
    repo.movePreset({ cam_id: from, preset_id: 1 }, { cam_id: to, preset_id: 1 });

    expect(store.list('cam-a')).toEqual([]);
    expect(store.get(preset.id)).toMatchObject({ id: preset.id, cameraId: 'cam-b', name: '이사감' });
  });
});

describe('규칙 — 파일 시절부터 지키던 것', () => {
  it('도달범위 밖 좌표는 저장 전에 자른다 — 못 가는 자리를 프리셋으로 남기지 않는다', async () => {
    const preset = await store.add({ cameraId: 'cam-a', name: '한계', ptz: { pan: 36100, tilt: 12000, zoom: -1 } });
    expect(preset.ptz).toEqual({ pan: 100, tilt: 9000, zoom: 0 });
  });

  it('같은 카메라 안에서 이름이 겹치면 409 — 콤보박스에서 구분이 안 되면 잘못 이동한다', async () => {
    await store.add({ cameraId: 'cam-a', name: '정문 와이드', ptz: { pan: 0, tilt: 0, zoom: 0 } });
    await expect(store.add({ cameraId: 'cam-a', name: '정문 와이드', ptz: { pan: 1, tilt: 1, zoom: 1 } }))
      .rejects.toThrow(expect.objectContaining({ statusCode: 409 }));
  });

  it('다른 카메라에서는 같은 이름을 허용한다', async () => {
    await store.add({ cameraId: 'cam-a', name: '정문 와이드', ptz: { pan: 0, tilt: 0, zoom: 0 } });
    await expect(store.add({ cameraId: 'cam-b', name: '정문 와이드', ptz: { pan: 0, tilt: 0, zoom: 0 } })).resolves.toBeTruthy();
  });

  it('자기 이름을 그대로 두는 것은 중복이 아니다', async () => {
    const preset = await store.add({ cameraId: 'cam-a', name: '정문 와이드', ptz: { pan: 1, tilt: 2, zoom: 3 } });
    await expect(store.update(preset.id, { name: '정문 와이드' })).resolves.toMatchObject({ name: '정문 와이드' });
  });

  it('이름만 / 좌표만 따로 고칠 수 있다', async () => {
    const preset = await store.add({ cameraId: 'cam-a', name: '정문 와이드', ptz: { pan: 100, tilt: 200, zoom: 300 } });
    expect(await store.update(preset.id, { name: '정문 클로즈업' })).toMatchObject({ name: '정문 클로즈업', ptz: { pan: 100, tilt: 200, zoom: 300 } });
    expect(await store.update(preset.id, { ptz: { pan: 9, tilt: 8, zoom: 7 } })).toMatchObject({ name: '정문 클로즈업', ptz: { pan: 9, tilt: 8, zoom: 7 } });
  });

  it('빈 이름은 거부한다', async () => {
    await expect(store.add({ cameraId: 'cam-a', name: '   ', ptz: { pan: 0, tilt: 0, zoom: 0 } })).rejects.toThrow(/이름/);
  });

  it('없는 id 는 404 — 숫자가 아닌 옛 id(`p-1`) 도 마찬가지다', async () => {
    await expect(store.update('9999', { name: 'x' })).rejects.toThrow(expect.objectContaining({ statusCode: 404 }));
    await expect(store.remove('p-1')).rejects.toThrow(expect.objectContaining({ statusCode: 404 }));
    expect(store.get('p-1')).toBeUndefined();
  });

  it('등록되지 않은 카메라에는 넣지 않는다 — 표의 외래키가 막기 전에 사유를 준다', async () => {
    await expect(store.add({ cameraId: 'ghost', name: 'x', ptz: { pan: 0, tilt: 0, zoom: 0 } }))
      .rejects.toThrow(PresetError);
    expect(store.list('ghost')).toEqual([]);
  });
});

describe('presets.json 이관', () => {
  const LEGACY = [
    { id: 'p-1', cameraId: 'cam-a', name: 'Preset1', ptz: { pan: 4260, tilt: 3380, zoom: 230 } },
    { id: 'p-2', cameraId: 'cam-b', name: 'Preset1', ptz: { pan: 11380, tilt: 1000, zoom: 150 } },
  ];

  it('파일의 프리셋이 좌표째 표로 들어간다', () => {
    const result = importPresets(db, LEGACY);
    expect(result.imported).toEqual(['cam-a/Preset1', 'cam-b/Preset1']);
    expect(result.mismatches).toEqual([]);
    expect(store.list('cam-a')).toEqual([{ id: expect.any(String), cameraId: 'cam-a', name: 'Preset1', ptz: { pan: 4260, tilt: 3380, zoom: 230 } }]);
  });

  it('두 번 돌려도 표 쪽을 덮지 않는다 — 같은 이름은 건너뛴다', () => {
    importPresets(db, LEGACY);
    const again = importPresets(db, LEGACY);
    expect(again.imported).toEqual([]);
    expect(again.skipped).toEqual(['cam-a/Preset1: 같은 이름이 이미 있음', 'cam-b/Preset1: 같은 이름이 이미 있음']);
    expect(store.list('cam-a')).toHaveLength(1);
  });

  it('없는 카메라의 프리셋은 사유를 남기고 건너뛴다 — 조용히 버리지 않는다', () => {
    const result = importPresets(db, [{ cameraId: '사라진-카메라', name: 'X', ptz: { pan: 0, tilt: 0, zoom: 0 } }]);
    expect(result.imported).toEqual([]);
    expect(result.skipped).toEqual(['사라진-카메라/X: 등록되지 않은 카메라']);
  });

  it('모양이 깨진 줄은 건너뛰고 나머지는 옮긴다', () => {
    const result = importPresets(db, [null, { cameraId: 'cam-a' }, { cameraId: 'cam-a', name: 'OK', ptz: { pan: 1, tilt: 2, zoom: 3 } }]);
    expect(result.imported).toEqual(['cam-a/OK']);
  });
});

describe('toPreset', () => {
  it('표의 대리키가 밖으로 나가는 id 다 — preset_id(카메라 안 번호)가 아니다', () => {
    const preset = toPreset({ id: 42, preset_id: 3, preset_name: '입구', cam_id: 1, pos_pan: 1, pos_tilt: 2, pos_zoom: 3, place_id: 1 }, 'cam-a');
    expect(preset).toEqual({ id: '42', cameraId: 'cam-a', name: '입구', ptz: { pan: 1, tilt: 2, zoom: 3 } });
  });
});
