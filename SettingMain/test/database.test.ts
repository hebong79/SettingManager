import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseError, migrate, openDatabase } from '../src/db/database.js';
import { DatabaseSync as DatabaseCtor } from '../src/db/sqlite.js';
import { SCHEMA_VERSION } from '../src/db/schema.js';
import { ParkingRepository } from '../src/db/parkingRepository.js';
import { SetupRepository, type CameraRow } from '../src/db/setupRepository.js';
import { readCameras, toCameraConfig } from '../src/db/configCameras.js';

/**
 * 커미셔닝 DB 자체를 지킨다 — 스키마 판, 무결성 제약, 두 저장소의 계약.
 *
 * 스키마 근거: `docs/my_think/my_db_table.md`. 해석이 들어간 자리는 `src/db/schema.ts` 머리말에
 * 7개로 적어 두었고, 그 해석들이 실제로 그렇게 동작하는지가 여기서 확인된다.
 */

const AT = '2026-08-05T00:00:00.000Z';
let db: DatabaseSync;

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
});
afterEach(() => {
  db.close();
});

const setup = () => new SetupRepository(db, { now: () => AT });
const parking = () => new ParkingRepository(db, { now: () => AT });

/** 슬롯을 넣으려면 장소 → 카메라 → 프리셋이 먼저 있어야 한다. */
function seed(): { camId: number; presetId: number } {
  const repo = setup();
  const camera = repo.upsertCamera({
    cam_name: '리얼 1', cam_uuid: 'real-camera-1', url: 'http://10.0.0.1:80',
    user_id: 'admin', password: 'secret', rtsp_url: 'rtsp://10.0.0.1:554/stream1',
    cam_type: 'ptz', place_id: 1,
  });
  const preset = repo.upsertPreset({ preset_name: '입구', cam_id: camera.cam_id, pos: { pan: 4200, tilt: 900, zoom: 3000 }, place_id: 1 });
  return { camId: camera.cam_id, presetId: preset.preset_id };
}

describe('스키마·마이그레이션', () => {
  it('연 직후 판이 기록돼 있다', () => {
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
  });

  it('장소 1번이 미리 들어 있다 — 문서 규약(현재는 무조건 1)', () => {
    expect(setup().listPlaces()).toEqual([{ place_id: 1, place_name: '기본 주차장' }]);
  });

  it('같은 파일을 다시 열어도 스키마를 두 번 만들지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'settingmanager-db-'));
    try {
      const path = join(dir, 'setup.db');
      const first = openDatabase({ path });
      new SetupRepository(first).upsertPlace({ place_id: 2, place_name: '지하' });
      first.close();

      const second = openDatabase({ path });
      expect(new SetupRepository(second).listPlaces()).toHaveLength(2);
      second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('DB 판이 코드보다 높으면 던진다 — 옛 코드가 새 파일을 조용히 망가뜨리지 않는다', () => {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    // 이미 열린 핸들로 migrate 를 다시 부르는 상황을 흉내 낸다.
    expect(() => migrate(db)).toThrow(DatabaseError);
  });

  it('외래키가 켜져 있다 — 없는 장소를 가리키는 카메라가 들어가지 않는다', () => {
    // 저장소를 거치면 없는 장소를 **만들어 주므로**(카메라가 아예 못 들어가는 것을 막는다)
    // 제약 자체는 SQL 로 직접 확인한다.
    expect(() => db.prepare(`INSERT INTO camera_info (cam_id, cam_name, cam_uuid, place_id) VALUES (9, 'x', 'x', 99)`).run()).toThrow();
  });

  it('저장소는 없는 장소를 만들어 준다 — 그 카메라가 통째로 사라지는 것보다 낫다', () => {
    setup().upsertCamera({ cam_name: 'x', cam_uuid: 'x', url: '', user_id: '', password: '', rtsp_url: '', cam_type: 'ptz', place_id: 99 });
    expect(setup().listPlaces().map((p) => p.place_id)).toContain(99);
  });

  it('cam_type 은 ptz·static 만 받는다', () => {
    expect(() => db.prepare(`INSERT INTO camera_info (cam_id, cam_name, cam_uuid, cam_type, place_id) VALUES (9, 'x', 'x', 'dome', 1)`).run()).toThrow();
  });

  it('ROI 칸에 JSON 이 아닌 것을 넣을 수 없다', () => {
    const { camId, presetId } = seed();
    expect(() => db.prepare(`
      INSERT INTO slot_setup (slot_id, cam_id, preset_id, preset_slotidx, slot_roi, updated_at) VALUES (1, ?, ?, 1, '깨진값', ?)
    `).run(camId, presetId, AT)).toThrow();
  });
});

describe('SetupRepository', () => {
  it('cam_id 는 1부터 붙고, cam_uuid 가 열쇠다', () => {
    const repo = setup();
    const first = repo.upsertCamera({ cam_name: 'A', cam_uuid: 'cam-a', url: '', user_id: '', password: '', rtsp_url: '', cam_type: 'ptz', place_id: 1 });
    const second = repo.upsertCamera({ cam_name: 'B', cam_uuid: 'cam-b', url: '', user_id: '', password: '', rtsp_url: '', cam_type: 'static', place_id: 1 });
    expect([first.cam_id, second.cam_id]).toEqual([1, 2]);

    // 같은 uuid 로 다시 넣으면 새 카메라가 아니라 갱신이다.
    const again = repo.upsertCamera({ cam_name: 'A2', cam_uuid: 'cam-a', url: '', user_id: '', password: '', rtsp_url: '', cam_type: 'ptz', place_id: 1 });
    expect(again.cam_id).toBe(1);
    expect(repo.listCameras()).toHaveLength(2);
    expect(repo.getCameraByUuid('cam-a')?.cam_name).toBe('A2');
  });

  it('preset_id 는 **카메라 안에서** 1부터 센다', () => {
    const repo = setup();
    const a = repo.upsertCamera({ cam_name: 'A', cam_uuid: 'cam-a', url: '', user_id: '', password: '', rtsp_url: '', cam_type: 'ptz', place_id: 1 });
    const b = repo.upsertCamera({ cam_name: 'B', cam_uuid: 'cam-b', url: '', user_id: '', password: '', rtsp_url: '', cam_type: 'ptz', place_id: 1 });
    expect(repo.upsertPreset({ preset_name: 'p', cam_id: a.cam_id, pos: { pan: 0, tilt: 0, zoom: 0 }, place_id: 1 }).preset_id).toBe(1);
    expect(repo.upsertPreset({ preset_name: 'q', cam_id: a.cam_id, pos: { pan: 0, tilt: 0, zoom: 0 }, place_id: 1 }).preset_id).toBe(2);
    // 다른 카메라는 다시 1부터다.
    expect(repo.upsertPreset({ preset_name: 'r', cam_id: b.cam_id, pos: { pan: 0, tilt: 0, zoom: 0 }, place_id: 1 }).preset_id).toBe(1);
  });

  it('없는 프리셋에 슬롯을 달 수 없다 — 404 로 거절한다', () => {
    const { camId } = seed();
    expect(() => setup().upsertSlot({ slot_id: 1, cam_id: camId, preset_id: 99, preset_slotidx: 1 }))
      .toThrow(/등록되지 않은 프리셋/);
  });

  it('슬롯은 단계마다 조금씩 채워진다 — 주지 않은 칸은 지우지 않는다', () => {
    const { camId, presetId } = seed();
    const repo = setup();
    repo.upsertSlot({ slot_id: 1, cam_id: camId, preset_id: presetId, preset_slotidx: 1, marked: { x: 300, y: 400 } });
    repo.upsertSlot({ slot_id: 1, cam_id: camId, preset_id: presetId, preset_slotidx: 1, slot_roi: [[0, 0], [10, 0], [10, 10], [0, 10]] });
    repo.upsertSlot({ slot_id: 1, cam_id: camId, preset_id: presetId, preset_slotidx: 1, ptz: { pan: 4300, tilt: 950, zoom: 9000 } });

    const slot = repo.getSlot(1)!;
    expect(slot.marked_x).toBe(300);                        // 1단계 결과가 살아 있다
    expect(JSON.parse(slot.slot_roi!)).toHaveLength(4);      // 2단계도
    expect([slot.ptz_pan, slot.ptz_tilt, slot.ptz_zoom]).toEqual([4300, 950, 9000]);
  });

  it('null 을 **명시로** 주면 그때는 지운다', () => {
    const { camId, presetId } = seed();
    const repo = setup();
    repo.upsertSlot({ slot_id: 1, cam_id: camId, preset_id: presetId, preset_slotidx: 1, ptz: { pan: 1, tilt: 2, zoom: 3 } });
    repo.upsertSlot({ slot_id: 1, cam_id: camId, preset_id: presetId, preset_slotidx: 1, ptz: null });
    expect(repo.getSlot(1)!.ptz_pan).toBeNull();
  });

  it('센터라이징 전 슬롯은 ptz 가 NULL 이다 — 0 으로 채우지 않는다', () => {
    const { camId, presetId } = seed();
    const repo = setup();
    repo.upsertSlot({ slot_id: 1, cam_id: camId, preset_id: presetId, preset_slotidx: 1 });
    repo.upsertSlot({ slot_id: 2, cam_id: camId, preset_id: presetId, preset_slotidx: 2, ptz: { pan: 1, tilt: 2, zoom: 3 } });
    expect(repo.listUncentered().map((s) => s.slot_id)).toEqual([1]);
  });

  it('한 프리셋 안에서 슬롯 순번이 겹칠 수 없다', () => {
    const { camId, presetId } = seed();
    const repo = setup();
    repo.upsertSlot({ slot_id: 1, cam_id: camId, preset_id: presetId, preset_slotidx: 1 });
    expect(() => repo.upsertSlot({ slot_id: 2, cam_id: camId, preset_id: presetId, preset_slotidx: 1 })).toThrow();
  });

  it('프리셋을 지우면 슬롯이 함께 사라진다', () => {
    const { camId, presetId } = seed();
    const repo = setup();
    repo.upsertSlot({ slot_id: 1, cam_id: camId, preset_id: presetId, preset_slotidx: 1 });
    expect(repo.removePreset(camId, presetId)).toBe(true);
    expect(repo.listSlots()).toEqual([]);
  });

  it('floor_ROI 는 slot_setup 에서 뽑은 뷰다 — 저장되는 자리가 없다', () => {
    const { camId, presetId } = seed();
    const repo = setup();
    repo.upsertSlot({
      slot_id: 1, cam_id: camId, preset_id: presetId, preset_slotidx: 1,
      slot_roi: [[0, 0], [10, 0], [10, 10], [0, 10]], ptz: { pan: 4300, tilt: 950, zoom: 9000 },
    });
    repo.upsertSlot({ slot_id: 2, cam_id: camId, preset_id: presetId, preset_slotidx: 2 });

    const rows = repo.floorRoi();
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]!.pos!)).toEqual([4300, 950, 9000]);
    // 아직 센터라이징 안 된 슬롯은 pos 가 없다 — 0 을 지어내지 않는다.
    expect(rows[1]!.pos).toBeNull();

    // 뷰이므로 원본을 고치면 따라 바뀐다.
    repo.upsertSlot({ slot_id: 1, cam_id: camId, preset_id: presetId, preset_slotidx: 1, ptz: { pan: 1, tilt: 2, zoom: 3 } });
    expect(JSON.parse(repo.floorRoi()[0]!.pos!)).toEqual([1, 2, 3]);
  });
});

describe('ParkingRepository', () => {
  function seedSlot(): number {
    const { camId, presetId } = seed();
    setup().upsertSlot({ slot_id: 1, cam_id: camId, preset_id: presetId, preset_slotidx: 1 });
    return 1;
  }

  it('상태와 이력을 한 번에 남긴다 — 하나만 성공하는 경우가 없다', () => {
    const slotId = seedSlot();
    const repo = parking();
    const { state, event } = repo.record({ slot_id: slotId, is_occupy: true, plate_num: '12가3456', img1: 'img/1.jpg' });
    expect(state).toMatchObject({ slot_id: 1, is_occupy: 1, plate_num: '12가3456', img1: 'img/1.jpg' });
    expect(event).toMatchObject({ event_id: 1, slot_id: 1, is_occupy: 1 });
  });

  it('상태는 덮어쓰고 이력은 쌓인다', () => {
    const slotId = seedSlot();
    const repo = parking();
    repo.record({ slot_id: slotId, is_occupy: true, plate_num: '12가3456' });
    repo.record({ slot_id: slotId, is_occupy: false });

    expect(repo.listStates()).toHaveLength(1);
    expect(repo.getState(slotId)).toMatchObject({ is_occupy: 0, plate_num: null });
    expect(repo.listEvents(slotId).map((e) => e.is_occupy)).toEqual([0, 1]); // 최신이 먼저
  });

  it('점유 집계를 답한다', () => {
    const { camId, presetId } = seed();
    const repo = setup();
    repo.upsertSlot({ slot_id: 1, cam_id: camId, preset_id: presetId, preset_slotidx: 1 });
    repo.upsertSlot({ slot_id: 2, cam_id: camId, preset_id: presetId, preset_slotidx: 2 });
    parking().record({ slot_id: 1, is_occupy: true });
    parking().record({ slot_id: 2, is_occupy: false });
    expect(parking().occupancy()).toEqual({ total: 2, occupied: 1 });
  });

  it('없는 슬롯의 상태는 넣을 수 없다 — 커미셔닝되지 않은 자리다', () => {
    expect(() => parking().record({ slot_id: 999, is_occupy: true })).toThrow();
  });

  it('슬롯을 지우면 상태·이력이 함께 사라진다', () => {
    const slotId = seedSlot();
    parking().record({ slot_id: slotId, is_occupy: true });
    setup().removeSlot(slotId);
    expect(parking().listStates()).toEqual([]);
    expect(parking().listEvents(slotId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 계획 2단계 — 옛 파일 열기 회귀 (`_workspace/01_architect_plan.md` 2-1 ~ 2-7)
// ---------------------------------------------------------------------------

/**
 * **역사적 10열 `camera_info`** 를 재현하는 **테스트 전용 픽스처**다.
 *
 * `src/db/schema.ts` 의 `SCHEMA_SQL` 과 **공유하면 안 된다** — 저쪽은 "지금 코드가 만들려는
 * 모습"이고 이쪽은 "이미 디스크에 있는 옛 모습"이다. 공유하는 순간 옛 파일이 아니라 새 파일을
 * 여는 시험이 되어 이번 버그(`kind`·`timeout_ms` 열 자체가 없던 파일)를 재현할 수 없다.
 * 그래서 열 정의를 **일부러 손으로 베껴 둔다.** 저쪽이 바뀌어도 이쪽은 따라가지 않는다.
 *
 * 픽스처를 `openDatabase()` 로 만들지 않는 이유도 같다 — 그 함수가 지금 고치는 대상이다.
 */
const LEGACY_SCHEMA_SQL = `
CREATE TABLE place_info (
  place_id   INTEGER PRIMARY KEY,
  place_name TEXT NOT NULL
);
CREATE TABLE camera_info (
  cam_id      INTEGER PRIMARY KEY,
  cam_name    TEXT    NOT NULL,
  cam_uuid    TEXT    NOT NULL UNIQUE,
  url         TEXT    NOT NULL DEFAULT '',
  user_id     TEXT    NOT NULL DEFAULT '',
  password    TEXT    NOT NULL DEFAULT '',
  rtsp_url    TEXT    NOT NULL DEFAULT '',
  cam_type    TEXT    NOT NULL DEFAULT 'ptz' CHECK (cam_type IN ('ptz', 'static')),
  cam_company TEXT    NOT NULL DEFAULT '',
  place_id    INTEGER NOT NULL REFERENCES place_info(place_id) ON DELETE RESTRICT
);
`;

/** 픽스처에 심는 값. 실제 사고 파일의 모습을 본떴다(근거: `config/config.json.bak-cameras`). */
const LEGACY_CAMERAS = [
  { cam_id: 1, cam_name: '리얼 1', cam_uuid: 'real-camera-1', url: 'http://192.168.0.21:80', user_id: 'admin', password: 'pw1', rtsp_url: 'rtsp://192.168.0.21:554/stream1', cam_type: 'ptz', cam_company: '휴컴스', place_id: 1 },
  { cam_id: 2, cam_name: '리얼 2', cam_uuid: 'real-camera-2', url: 'http://192.168.0.22:8083', user_id: 'root', password: 'pw2', rtsp_url: 'rtsp://192.168.0.22:554/stream2', cam_type: 'ptz', cam_company: '휴컴스', place_id: 1 },
] as const;

/** 표(또는 뷰)의 열 이름들. `PRAGMA table_info` 가 답한 순서 그대로. */
function columnsOf(handle: DatabaseSync, table: string): string[] {
  return (handle.prepare(`PRAGMA table_info("${table}")`).all() as unknown as Array<{ name: string }>).map((c) => c.name);
}

function userVersionOf(handle: DatabaseSync): number {
  return Number((handle.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
}

/** 10열 옛 파일을 SQL 로 직접 세운다. `userVersion` 을 위조해 여러 상황을 만든다. */
function writeLegacyFixture(path: string, userVersion = 2): void {
  const legacy = new DatabaseCtor(path);
  try {
    legacy.exec('PRAGMA foreign_keys = ON');
    legacy.exec(LEGACY_SCHEMA_SQL);
    legacy.exec(`INSERT INTO place_info (place_id, place_name) VALUES (1, '기본 주차장')`);
    const insert = legacy.prepare(`
      INSERT INTO camera_info (cam_id, cam_name, cam_uuid, url, user_id, password, rtsp_url, cam_type, cam_company, place_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of LEGACY_CAMERAS) {
      insert.run(c.cam_id, c.cam_name, c.cam_uuid, c.url, c.user_id, c.password, c.rtsp_url, c.cam_type, c.cam_company, c.place_id);
    }
    legacy.exec(`PRAGMA user_version = ${userVersion}`);
  } finally {
    legacy.close();
  }
}

describe('옛 파일 열기 — v2 열 보강 (계획 2단계)', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    // `:memory:` 로는 이 버그를 재현할 수 없다 — "이미 디스크에 있는 옛 파일"이 전제이고
    // 메모리 DB 는 닫으면 사라져 **다시 열 수가 없다.** 그래서 임시 파일 경로가 필수다.
    dir = await mkdtemp(join(tmpdir(), 'settingmanager-legacy-'));
    path = join(dir, 'setup.db');
  });
  afterEach(async () => {
    // `openDatabase()` 가 던지면 그 안에서 만든 핸들을 아무도 닫을 수 없어(반환되지 않으므로)
    // Windows 에서 `rm` 이 EPERM 을 낸다. `force` 로 흘린다 — 임시 디렉토리라 남아도 해가 없다.
    await rm(dir, { recursive: true, force: true });
  });

  it('[2-1] user_version=2 인 10열 옛 파일을 열면 v2 열 넷이 붙고 판이 올라간다', () => {
    writeLegacyFixture(path);
    const opened = openDatabase({ path });
    try {
      // 이 넷이 없어서 `createDriver()` 가 `kind: undefined` 를 받고 400 을 냈다.
      expect(columnsOf(opened, 'camera_info')).toEqual(
        expect.arrayContaining(['timeout_ms', 'kind', 'park3d_cam_id', 'intrinsics']),
      );
      expect(userVersionOf(opened)).toBe(SCHEMA_VERSION);
    } finally {
      opened.close();
    }
  });

  it('[2-2] 보강된 열에 기본값이 들어간다 — readCameras 에 빈 칸이 없다', () => {
    writeLegacyFixture(path);
    const opened = openDatabase({ path });
    try {
      const cameras = readCameras(opened);
      expect(cameras).toHaveLength(2);
      for (const camera of cameras) {
        expect(camera.kind).toBe('hucoms');
        expect(camera.timeoutMs).toBe(5000);
        // 사고의 증상은 정확히 이것이었다 — 이 키들이 `undefined` 로 새어 나갔다.
        for (const key of ['id', 'label', 'kind', 'controlUrl', 'username', 'password', 'streamUrl', 'timeoutMs', 'place_id'] as const) {
          expect(camera[key], `${camera.id}.${key}`).toBeDefined();
        }
      }
    } finally {
      opened.close();
    }
  });

  it('[2-3] 옛 값이 문자 그대로 보존된다 — ADD COLUMN 은 기존 줄을 건드리지 않는다', () => {
    writeLegacyFixture(path);
    const opened = openDatabase({ path });
    try {
      const stored = new SetupRepository(opened).listCameras()
        .map(({ cam_name, cam_uuid, url, user_id, rtsp_url }) => ({ cam_name, cam_uuid, url, user_id, rtsp_url }));
      expect(stored).toEqual(
        LEGACY_CAMERAS.map(({ cam_name, cam_uuid, url, user_id, rtsp_url }) => ({ cam_name, cam_uuid, url, user_id, rtsp_url })),
      );
    } finally {
      opened.close();
    }
  });

  it('[2-4] 새 파일은 처음부터 14열이고 cam_company 가 없다 — 판도 기록된다', () => {
    const opened = openDatabase({ path }); // 아직 아무것도 없는 경로
    try {
      // 개수만 보면 "다른 열 하나를 잃고 cam_company 는 남은" 파일과 구분되지 않는다.
      // **이름으로** 못박는다(계획 5-3 의 4-5).
      expect(columnsOf(opened, 'camera_info')).not.toContain('cam_company');
      expect(columnsOf(opened, 'camera_info')).toHaveLength(14);
      expect(userVersionOf(opened)).toBe(SCHEMA_VERSION);
    } finally {
      opened.close();
    }
  });

  it('[2-5] 보강된 파일을 다시 열어도 던지지 않고 열·행이 그대로다', () => {
    writeLegacyFixture(path);
    const first = openDatabase({ path });
    const columns = columnsOf(first, 'camera_info');
    const count = new SetupRepository(first).listCameras().length;
    first.close();

    // 두 번째 열기는 판이 이미 최신이라 **판 올리기를 통째로 건너뛴다** — 이번 사고의 모습이
    // 바로 그것이었다(판만 맞고 열은 없음). 이제 그 길에도 대조가 있으므로 조용히 지나가지 않는다.
    const second = openDatabase({ path });
    try {
      expect(columnsOf(second, 'camera_info')).toEqual(columns);
      expect(new SetupRepository(second).listCameras()).toHaveLength(count);
    } finally {
      second.close();
    }
  });

  it('[2-6] 앞선 판(SCHEMA_VERSION + 1)은 거절한다 — 경계가 상수를 따라간다', () => {
    writeLegacyFixture(path, SCHEMA_VERSION + 1);
    // 던지는 경로이므로 **테스트가 핸들을 쥐고** `migrate` 만 부른다.
    // `openDatabase()` 로 열면 던진 뒤 그 핸들을 닫을 길이 없다(Windows 에서 rm 이 EPERM).
    const held = new DatabaseCtor(path);
    try {
      expect(() => migrate(held)).toThrow(DatabaseError);
      // 판 번호 둘을 그대로 싣는지 — "높습니다"만 있으면 어느 판인지 사람이 다시 열어 봐야 한다.
      expect(() => migrate(held)).toThrow(new RegExp(`${SCHEMA_VERSION + 1}[\\s\\S]*${SCHEMA_VERSION}`));
    } finally {
      held.close();
    }
    // 반대쪽 경계: 같은 픽스처가 **뒤처진 판(2)** 이면 거절이 아니라 보강이다(2-1 이 확인).
  });

  /**
   * [2-7] 대조 안전망이 실제로 던지는지.
   *
   * 픽스처 선택: **두 갈래를 다 세웠다.** `verifySchema` 의 어긋남 갈래가 둘이고
   * (표/뷰가 통째로 없음 · 표는 있는데 열이 없음), 이번 사고는 **뒤쪽**이었기 때문이다.
   * 앞쪽만 확인하면 정작 이번 클래스를 잡는 갈래가 검증되지 않은 채 남는다.
   *
   *  (가) `preset_info` 를 아예 만들지 않은 파일 + `user_version` 을 최신으로 위조
   *       → 판이 최신이라 `SCHEMA_SQL` 이 돌지 않고 표가 계속 없다. 계획이 예로 든 픽스처다.
   *  (나) 14열 파일에서 `ALTER TABLE … DROP COLUMN park3d_cam_id`
   *       → 이 Node 의 `node:sqlite` 는 DROP COLUMN 을 지원한다(구현자 실측, 02 문서).
   *         "판은 맞는데 열이 없다"는 이번 사고와 **같은 모습**이다.
   */
  it('[2-7가] 없는 표를 이름째 알린다 — preset_info 를 빼고 판만 최신으로 위조한 파일', () => {
    writeLegacyFixture(path, SCHEMA_VERSION);
    const held = new DatabaseCtor(path);
    try {
      expect(() => migrate(held)).toThrow(DatabaseError);
      expect(() => migrate(held)).toThrow(/preset_info/);
      // 이번 사고의 열 넷도 여전히 없으므로 함께 실린다.
      expect(() => migrate(held)).toThrow(/camera_info/);
      expect(() => migrate(held)).toThrow(/kind/);
    } finally {
      held.close();
    }
  });

  it('[2-7나] 판은 맞는데 열이 없는 파일을 열 이름째 알린다 — 이번 사고와 같은 모습', () => {
    const fresh = openDatabase({ path }); // 14열·판 3 으로 정상 생성
    fresh.close();

    const held = new DatabaseCtor(path);
    try {
      held.exec('ALTER TABLE camera_info DROP COLUMN park3d_cam_id');
      expect(() => migrate(held)).toThrow(DatabaseError);
      expect(() => migrate(held)).toThrow(/camera_info 에 park3d_cam_id 가 없습니다/);
    } finally {
      held.close();
    }
  });
});

// ---------------------------------------------------------------------------
// v4 — `cam_company` 삭제 (`_workspace/05_architect_plan_v4.md` 5-3, 4-1 ~ 4-6)
// ---------------------------------------------------------------------------

/**
 * `writeV3AugmentedFixture` 가 심는 값. **마이그레이션 직전 운영 DB 의 세 패턴**을 덮는다.
 *
 *   ① `real-camera-1`  hucoms / 휴컴스        / park3d_cam_id 없음
 *   ② `simulator-1`    hucoms / **시뮬레이터** / park3d_cam_id 없음  ← 제조사와 프로토콜이
 *      1:1 이 아니었던 **유일한 반례**. 마스터가 `kind='hucoms'` 로 확정한 그 줄이다(계획 4단계).
 *   ③ `simulator-3`    park3d-rpc / 언리얼 Park3D 시뮬 / **park3d_cam_id = 2**
 *
 * `timeout_ms` 를 일부러 기본값(5000)이 아닌 값으로 둔다 — 기본값으로 시험하면 "보존됐다"와
 * "지워지고 기본값이 다시 채워졌다"를 구분할 수 없다. `cam_id` 도 1·3·5 로 띄엄띄엄 둔다.
 */
const V3_CAMERAS: ReadonlyArray<CameraRow & { cam_company: string }> = [
  {
    cam_id: 1, cam_name: '리얼 1', cam_uuid: 'real-camera-1', url: 'http://192.168.0.21:80',
    user_id: 'admin', password: 'pw1', rtsp_url: 'rtsp://192.168.0.21:554/stream1',
    cam_type: 'ptz', cam_company: '휴컴스', place_id: 1,
    timeout_ms: 3000, kind: 'hucoms', park3d_cam_id: null, insecure_tls: 0, intrinsics: JSON.stringify({ zoomHfov: [{ z: 0, h: 57.14 }, { z: 16384, h: 2.39 }] }),
  },
  {
    cam_id: 3, cam_name: 'UE 시뮬 1 (8081)', cam_uuid: 'simulator-1', url: 'http://127.0.0.1:8081',
    user_id: 'sim', password: 'pw3', rtsp_url: 'rtsp://127.0.0.1:8554/sim1',
    cam_type: 'ptz', cam_company: '시뮬레이터', place_id: 1,
    timeout_ms: 2500, kind: 'hucoms', park3d_cam_id: null, insecure_tls: 0, intrinsics: null,
  },
  {
    cam_id: 5, cam_name: 'UE 시뮬 3', cam_uuid: 'simulator-3', url: 'http://127.0.0.1:13510',
    user_id: '', password: '', rtsp_url: '',
    cam_type: 'static', cam_company: '언리얼 Park3D 시뮬', place_id: 1,
    timeout_ms: 4000, kind: 'park3d-rpc', park3d_cam_id: 2, insecure_tls: 0, intrinsics: null,
  },
];

/**
 * **마이그레이션 직전 운영 DB 와 같은 모습**의 파일을 세운다 —
 * 옛 10열(`cam_company` 포함) + `upgradeToV2` 가 ALTER 로 붙인 v2 열 넷 + `user_version = 3`.
 *
 * `writeLegacyFixture`(10열·판 2)로는 이 모습이 안 나오고, `SCHEMA_SQL` 로 만들면 **이미
 * `cam_company` 가 없는 새 파일**이라 v4 마이그레이션이 아무것도 시험하지 않게 된다.
 *
 * 판 번호 `3` 은 **상수를 따라가지 않게 일부러 리터럴로 박는다** — 이것은 "지금 코드의 판"이
 * 아니라 **그때 디스크에 있던 사실**이다. `SCHEMA_VERSION` 을 쓰면 판이 같아져 판 올리기
 * 블록을 건너뛰고, 시험하려던 드롭이 아예 돌지 않는다.
 *
 * 넣는 순서(10열 INSERT → ALTER → UPDATE)도 실제 경로 그대로다. `ADD COLUMN` 이 기존 줄을
 * 기본값으로 채우고 그 뒤 값이 들어간 파일이 지금의 운영 DB 다. `ADD COLUMN` 은 CHECK 를 붙일
 * 수 없으므로 이 픽스처의 `kind`·`intrinsics` 에는 제약이 없다 — 그것까지 운영 DB 와 같다.
 */
function writeV3AugmentedFixture(path: string): void {
  const legacy = new DatabaseCtor(path);
  try {
    legacy.exec('PRAGMA foreign_keys = ON');
    legacy.exec(LEGACY_SCHEMA_SQL);
    legacy.exec(`INSERT INTO place_info (place_id, place_name) VALUES (1, '기본 주차장')`);

    const insert = legacy.prepare(`
      INSERT INTO camera_info (cam_id, cam_name, cam_uuid, url, user_id, password, rtsp_url, cam_type, cam_company, place_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of V3_CAMERAS) {
      insert.run(c.cam_id, c.cam_name, c.cam_uuid, c.url, c.user_id, c.password, c.rtsp_url, c.cam_type, c.cam_company, c.place_id);
    }

    // `database.ts` 의 `upgradeToV2()` 와 **같은 정의**를 손으로 베낀다. 공유하지 않는 이유는
    // `LEGACY_SCHEMA_SQL` 과 같다 — 저쪽이 바뀌어도 "그때 디스크의 모습"은 따라가면 안 된다.
    legacy.exec(`ALTER TABLE camera_info ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 5000`);
    legacy.exec(`ALTER TABLE camera_info ADD COLUMN kind TEXT NOT NULL DEFAULT 'hucoms'`);
    legacy.exec(`ALTER TABLE camera_info ADD COLUMN park3d_cam_id INTEGER`);
    legacy.exec(`ALTER TABLE camera_info ADD COLUMN intrinsics TEXT`);

    const fill = legacy.prepare(`UPDATE camera_info SET timeout_ms = ?, kind = ?, park3d_cam_id = ?, intrinsics = ? WHERE cam_id = ?`);
    for (const c of V3_CAMERAS) fill.run(c.timeout_ms, c.kind, c.park3d_cam_id, c.intrinsics, c.cam_id);

    legacy.exec('PRAGMA user_version = 3');
  } finally {
    legacy.close();
  }
}

describe('cam_company 삭제 — 스키마 v4 (계획 5-3)', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'settingmanager-v4-'));
    path = join(dir, 'setup.db');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** 픽스처가 정말 옛 모습인지. 이것이 없으면 픽스처가 조용히 망가져도 아래가 전부 통과한다. */
  it('[전제] 픽스처는 열기 전에 cam_company 를 갖고 있고 판이 3 이다 — 운영 DB 와 같은 모습', () => {
    writeV3AugmentedFixture(path);
    const raw = new DatabaseCtor(path);
    try {
      expect(columnsOf(raw, 'camera_info')).toEqual([
        'cam_id', 'cam_name', 'cam_uuid', 'url', 'user_id', 'password', 'rtsp_url', 'cam_type',
        'cam_company', 'place_id', 'timeout_ms', 'kind', 'park3d_cam_id', 'intrinsics',
      ]);
      expect(userVersionOf(raw)).toBe(3);
      expect(userVersionOf(raw)).toBeLessThan(SCHEMA_VERSION); // 판 올리기 블록이 실제로 돈다
    } finally {
      raw.close();
    }
  });

  it('[4-1] **핵심** — cam_company 가 있는 옛 파일을 열면 그 열이 사라지고 판이 4 가 된다', () => {
    writeV3AugmentedFixture(path);
    const opened = openDatabase({ path });
    try {
      const columns = columnsOf(opened, 'camera_info');
      // 개수가 아니라 **이름**으로 본다 — 14 라는 숫자만으로는 "다른 열 하나를 잃고
      // cam_company 는 남은" 파일과 구분되지 않는다.
      expect(columns).not.toContain('cam_company');
      expect(columns).toHaveLength(14);
      expect(userVersionOf(opened)).toBe(SCHEMA_VERSION);
    } finally {
      opened.close();
    }
  });

  it('[4-2] 나머지 데이터가 문자 그대로 보존된다 — park3d_cam_id 를 잃으면 엉뚱한 카메라를 움직인다', () => {
    writeV3AugmentedFixture(path);
    const opened = openDatabase({ path });
    try {
      // `SELECT *` 를 통째로 비교한다. `toEqual` 은 남은 여분 키도 실패로 보므로
      // "cam_company 가 남았다"와 "값이 달라졌다"를 한 단언이 함께 잡는다.
      const stored = new SetupRepository(opened).listCameras();
      expect(stored).toEqual(V3_CAMERAS.map(({ cam_company, ...rest }) => rest));

      // 가장 비싼 값 하나는 따로 못박는다 — 이 번호가 틀리면 화면은 멀쩡한데 다른 카메라가 돈다.
      expect(stored.find((c) => c.cam_uuid === 'simulator-3')!.park3d_cam_id).toBe(2);
    } finally {
      opened.close();
    }
  });

  it('[4-3] simulator-1 은 제조사만 사라지고 kind 는 hucoms 그대로다 — 데이터 조작 단계가 따로 없다', () => {
    writeV3AugmentedFixture(path);
    const opened = openDatabase({ path });
    try {
      const sim = new SetupRepository(opened).getCameraByUuid('simulator-1')!;
      expect(sim.kind).toBe('hucoms');
      expect(sim).not.toHaveProperty('cam_company');
      // 드라이버를 고르는 값이 이제 이것 하나다 — 설정 계층까지 지나도 같아야 한다.
      expect(readCameras(opened).find((c) => c.id === 'simulator-1')!.kind).toBe('hucoms');
    } finally {
      opened.close();
    }
  });

  it('[4-4] 옛 10열 파일도 같은 결과 — v2 보강과 v4 삭제가 한 번의 열기에서 끝난다', () => {
    writeLegacyFixture(path); // 10열·판 2·cam_company 포함
    const opened = openDatabase({ path });
    try {
      const columns = columnsOf(opened, 'camera_info');
      expect(columns).not.toContain('cam_company');
      expect(columns).toHaveLength(14);
      // 보강이 함께 일어났는지 — 드롭만 돌고 ADD 가 건너뛰어졌다면 여기서 걸린다.
      for (const camera of readCameras(opened)) {
        expect(camera.kind).toBe('hucoms');
        expect(camera.timeoutMs).toBe(5000);
      }
    } finally {
      opened.close();
    }
  });

  it('[4-6] 멱등 — 이미 v4 인 파일을 다시 열어도 던지지 않고 열 집합·행 수가 그대로다', () => {
    writeV3AugmentedFixture(path);
    const first = openDatabase({ path });
    const columns = columnsOf(first, 'camera_info');
    const count = new SetupRepository(first).listCameras().length;
    first.close();

    // 두 번째 열기는 판이 이미 최신이라 **판 올리기 블록을 통째로 건너뛴다**.
    // `dropCamCompany` 는 내보내지 않으므로 이 경로(= `openDatabase`)로만 건드릴 수 있다.
    const second = openDatabase({ path });
    try {
      expect(columnsOf(second, 'camera_info')).toEqual(columns);
      expect(new SetupRepository(second).listCameras()).toHaveLength(count);
      expect(userVersionOf(second)).toBe(SCHEMA_VERSION);
    } finally {
      second.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 경계면 교차 비교 — 같은 클래스의 사고가 다시 나지 않게 못을 박는다
// ---------------------------------------------------------------------------

describe('경계면 교차 — camera_info 표 ↔ CameraRow ↔ upsertCamera INSERT', () => {
  /** 14열 전부를 기본값이 **아닌** 값으로 채운 입력. 기본값이면 누락과 구분되지 않는다. */
  const FULL_ROW: CameraRow = {
    cam_id: 7,
    cam_name: '왕복 시험',
    cam_uuid: 'cam-roundtrip',
    url: 'http://10.0.0.7:80',
    user_id: 'u7',
    password: 'p7',
    rtsp_url: 'rtsp://10.0.0.7:554/s',
    cam_type: 'static',
    place_id: 3,
    timeout_ms: 1234,
    kind: 'park3d-rpc',
    park3d_cam_id: 9,
    insecure_tls: 1,
    intrinsics: JSON.stringify({ zoomHfov: [{ z: 0, h: 57.14 }, { z: 16384, h: 2.39 }] }),
  };

  it('표의 열 집합과 CameraRow 의 키 집합이 정확히 같다', () => {
    // `CameraRow` 는 타입이라 런타임에 지워진다. 대신 `upsertCamera` 가 **CameraRow 로 만들어
    // 돌려주는 객체**의 키를 본다 — 그것이 코드가 믿는 열 목록이다.
    const row = setup().upsertCamera(FULL_ROW);
    expect(Object.keys(row).sort()).toEqual(columnsOf(db, 'camera_info').sort());
  });

  it('14열 전부가 INSERT 를 왕복한다 — 열 목록에서 빠진 열은 조용히 기본값이 된다', () => {
    setup().upsertCamera(FULL_ROW);
    const stored = db.prepare('SELECT * FROM camera_info WHERE cam_id = ?').get(FULL_ROW.cam_id);
    expect(stored).toEqual(FULL_ROW);
  });

  /**
   * 위 셋은 **개수와 집합**으로 어긋남을 잡는다. 그것만으로는 "한쪽만 되돌려 놓고 다른 열
   * 하나를 함께 지운" 상태를 통과시킬 수 있으므로, v4 가 지운 **이름 하나**를 네 자리 모두에서
   * 따로 못박는다(`SCHEMA_SQL` ↔ `CameraRow` ↔ `upsertCamera` INSERT ↔ `toCameraConfig`).
   */
  it('cam_company 는 네 자리 어디에도 없다 — 표·CameraRow·INSERT 결과·설정 변환', () => {
    const row = setup().upsertCamera(FULL_ROW);
    expect(columnsOf(db, 'camera_info')).not.toContain('cam_company');   // ① 표(SCHEMA_SQL)
    expect(row).not.toHaveProperty('cam_company');                        // ② upsertCamera 가 믿는 CameraRow
    const stored = db.prepare('SELECT * FROM camera_info WHERE cam_id = ?').get(FULL_ROW.cam_id) as unknown as CameraRow;
    expect(stored).not.toHaveProperty('cam_company');                     // ③ INSERT 를 지나 실제로 저장된 줄
    expect(toCameraConfig(stored)).not.toHaveProperty('cam_company');     // ④ 설정 계층으로 나가는 모습
  });

  it('toCameraConfig 가 읽는 열이 전부 표에 있다 — undefined 가 새지 않는다', () => {
    setup().upsertCamera(FULL_ROW);
    const stored = db.prepare('SELECT * FROM camera_info WHERE cam_id = ?').get(FULL_ROW.cam_id) as unknown as CameraRow;
    expect(toCameraConfig(stored)).toEqual({
      id: 'cam-roundtrip',
      label: '왕복 시험',
      kind: 'park3d-rpc',
      controlUrl: 'http://10.0.0.7:80',
      username: 'u7',
      password: 'p7',
      streamUrl: 'rtsp://10.0.0.7:554/s',
      timeoutMs: 1234,
      place_id: 3,
      camId: 9,
      intrinsics: { zoomHfov: [{ z: 0, h: 57.14 }, { z: 16384, h: 2.39 }] },
    });
  });
});
