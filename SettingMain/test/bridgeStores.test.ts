import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.js';
import { DiscoveryDbStore } from '../src/db/discoveryDbStore.js';
import { SpotDbStore } from '../src/db/spotDbStore.js';
import { exportBackendCoreFiles } from '../src/db/backendCoreExport.js';

/**
 * 브리지 저장소는 이제 **SQLite 가 정본**이다. 그런데 밖으로 답하는 모양은
 * backend-core 파일 형식 그대로여야 한다 — REST 응답이 그 모양이고, 내보내기가 그 결과를
 * 그대로 쓰기 때문이다.
 *
 * 그래서 여기서 지키는 것은 셋이다.
 *   ① id·필드명·정규화 규칙이 backend-core 어휘 그대로다(`p-1`·`pt-1`·`panpos`…)
 *   ② DB 로 옮기면서 **얻은 것**이 실려 나온다 — 전체 슬롯 통번(`slotId`)
 *   ③ 내보낸 파일이 backend-core 가 읽을 수 있는 모양이다
 *
 * 스키마 근거: `docs/my_think/my_db_table.md` · baro_calory `discovery-store.mjs`·`spot-store.mjs`.
 */

const AT = '2026-08-05T00:00:00.000Z';
let db: DatabaseSync;
let dir: string;

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  dir = await mkdtemp(join(tmpdir(), 'settingmanager-export-'));
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const discovery = (cameraId = 'cam-a') => new DiscoveryDbStore(db, cameraId, { now: () => AT });
const spots = (cameraId = 'cam-a') => new SpotDbStore(db, cameraId, { now: () => AT });

describe('DiscoveryDbStore — backend-core 어휘로 답한다', () => {
  it('카메라가 아직 없으면 빈 저장소다', async () => {
    expect(await discovery().load()).toEqual({ schemaVersion: 1, cameraId: 'cam-a', nextPresetId: 1, presets: [] });
  });

  it('프리셋 id 는 p-N, 점 id 는 pt-N 이다', async () => {
    const store = discovery();
    expect((await store.addPreset({ name: '입구' })).id).toBe('p-1');
    expect((await store.addPreset({})).id).toBe('p-2');
    expect((await store.addPreset({})).name).toBe('프리셋 3');

    expect((await store.addPoint('p-1', { x: 100, y: 200 }))?.id).toBe('pt-1');
    expect((await store.addPoint('p-1', {}))?.id).toBe('pt-2');
  });

  it('PTZ 는 상류 필드명(panpos·tiltpos·zoompos·focuspos)으로 나온다', async () => {
    const preset = await discovery().addPreset({ name: 'x', ptz: { panpos: 1000, tiltpos: 500, zoompos: 2000 } });
    expect(preset.ptz).toEqual({ panpos: 1000, tiltpos: 500, zoompos: 2000, focuspos: 0 });
  });

  it('팬은 감고 틸트·줌은 자른다 — 상류 normPtz 와 같은 규칙', async () => {
    const preset = await discovery().addPreset({ ptz: { panpos: 36500, tiltpos: 99_999, zoompos: -5 } });
    expect(preset.ptz).toMatchObject({ panpos: 500, tiltpos: 9000, zoompos: 0 });
  });

  it('점 좌표는 1920×1080 안으로 자른다', async () => {
    const store = discovery();
    await store.addPreset({});
    expect(await store.addPoint('p-1', { x: 9999, y: -50 })).toMatchObject({ x: 1920, y: 0 });
  });

  /** DB 로 옮기면서 **얻은 것**. JSON 파일 시절에는 없던 값이다. */
  it('점마다 전체 슬롯 통번이 실려 나온다 — 카메라·프리셋을 가로질러 1씩 오른다', async () => {
    const a = discovery('cam-a');
    const b = discovery('cam-b');
    await a.addPreset({});
    await b.addPreset({});
    expect((await a.addPoint('p-1', { x: 1, y: 1 }))?.slotId).toBe(1);
    expect((await b.addPoint('p-1', { x: 2, y: 2 }))?.slotId).toBe(2);
    expect((await a.addPoint('p-1', { x: 3, y: 3 }))?.slotId).toBe(3);
    // 프리셋 안의 순번은 프리셋마다 따로 1부터다 — 통번과 다른 축이다.
    expect((await b.addPoint('p-1', { x: 4, y: 4 }))?.id).toBe('pt-2');
  });

  it('프리셋을 지우면 그 점들도 함께 사라진다 — 유령 슬롯을 남기지 않는다', async () => {
    const store = discovery();
    await store.addPreset({});
    await store.addPoint('p-1', { x: 1, y: 1 });
    expect(await store.removePreset('p-1')).toBe(true);
    expect((await store.load()).presets).toEqual([]);
  });

  it('없는 프리셋·점 조작은 null·false 로 답한다', async () => {
    const store = discovery();
    expect(await store.updatePreset('p-99', {})).toBeNull();
    expect(await store.removePreset('p-99')).toBe(false);
    expect(await store.listPoints('p-99')).toBeNull();
    expect(await store.addPoint('p-99', { x: 1, y: 1 })).toBeNull();
    expect(await store.clearPoints('p-99')).toBeNull();
  });

  it('점 일괄 삭제는 지운 개수를 답한다', async () => {
    const store = discovery();
    await store.addPreset({});
    await store.addPoint('p-1', { x: 1, y: 1 });
    await store.addPoint('p-1', { x: 2, y: 2 });
    expect(await store.clearPoints('p-1')).toBe(2);
    expect(await store.listPoints('p-1')).toEqual([]);
  });

  it('카메라마다 프리셋이 갈린다 — 프리셋 PTZ 는 그 카메라의 좌표다', async () => {
    await discovery('cam-a').addPreset({ name: 'A' });
    expect((await discovery('cam-b').load()).presets).toEqual([]);
  });
});

describe('SpotDbStore — 주차면은 프리셋에 속한다', () => {
  it('프리셋이 없으면 409 로 거절한다 — 아무 구도에나 붙이지 않는다', async () => {
    await expect(spots().addSpot({ x: 10, y: 20, closeupPtz: {} })).rejects.toMatchObject({ statusCode: 409 });
    await expect(spots().addSpot({ x: 10, y: 20, closeupPtz: {} })).rejects.toThrow(/프리셋/);
  });

  it('프리셋이 둘 이상이면 어느 구도인지 묻는다', async () => {
    const store = discovery();
    await store.addPreset({});
    await store.addPreset({});
    await expect(spots().addSpot({ x: 1, y: 2, closeupPtz: {} })).rejects.toThrow(/2개/);
  });

  it('프리셋이 하나면 그 구도에 저장하고 spot-<통번> 으로 답한다', async () => {
    await discovery().addPreset({});
    const spot = await spots().addSpot({ x: 10, y: 20, closeupPtz: { panpos: 8800, tiltpos: 2200, zoompos: 6000 } });
    expect(spot).toMatchObject({
      id: 'spot-1',
      markedPixel: { x: 10, y: 20 },
      closeupPtz: { panpos: 8800, tiltpos: 2200, zoompos: 6000, focuspos: 0 },
      slotId: 1,
      presetSlotIdx: 1,
    });
  });

  it('계약 좌표(pan·tilt·zoom)로 줘도 읽는다 — 브리지가 그 이름으로 넘긴다', async () => {
    await discovery().addPreset({});
    const spot = await spots().addSpot({ x: 1, y: 2, closeupPtz: { pan: 100, tilt: 200, zoom: 300 } });
    expect(spot.closeupPtz).toMatchObject({ panpos: 100, tiltpos: 200, zoompos: 300 });
  });

  it('없는 스팟 조회·삭제는 null·false 다', async () => {
    expect(await spots().getSpot('spot-99')).toBeNull();
    expect(await spots().removeSpot('spot-99')).toBe(false);
  });
});

describe('backend-core 형식 내보내기', () => {
  it('두 파일을 backend-core 가 읽을 모양으로 뽑는다', async () => {
    const store = discovery();
    await store.addPreset({ name: '입구', ptz: { panpos: 4200, tiltpos: 900, zoompos: 3000 } });
    await store.addPoint('p-1', { x: 300, y: 400 });
    await spots().addSpot({ x: 300, y: 400, closeupPtz: { panpos: 4300, tiltpos: 950, zoompos: 9000 } });

    const result = await exportBackendCoreFiles(db, 'cam-a', dir);
    expect(result.files.map((f) => f.split(/[\\/]/).pop())).toEqual(['discovery-cam-a.json', 'spots-cam-a.json']);

    const discoveryFile = JSON.parse(await readFile(join(dir, 'discovery-cam-a.json'), 'utf8'));
    expect(discoveryFile).toMatchObject({
      schemaVersion: 1,
      cameraId: 'cam-a',
      nextPresetId: 2,
      presets: [{ id: 'p-1', name: '입구', ptz: { panpos: 4200, tiltpos: 900, zoompos: 3000, focuspos: 0 } }],
    });
    expect(discoveryFile.presets[0].points[0]).toMatchObject({ id: 'pt-1', x: 300, y: 400 });

    const spotFile = JSON.parse(await readFile(join(dir, 'spots-cam-a.json'), 'utf8'));
    expect(spotFile).toMatchObject({ schemaVersion: 1, cameraId: 'cam-a', spots: [{ id: 'spot-2' }] });
  });

  it('내보내기는 저장소가 답하는 것과 **같은 객체**다 — 형식 변환기가 따로 없다', async () => {
    await discovery().addPreset({ name: 'A' });
    await exportBackendCoreFiles(db, 'cam-a', dir);
    const written = JSON.parse(await readFile(join(dir, 'discovery-cam-a.json'), 'utf8'));
    expect(written).toEqual(JSON.parse(JSON.stringify(await discovery().load())));
  });
});
