import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseError, migrate, openDatabase } from '../src/db/database.js';
import { DatabaseSync as DatabaseCtor } from '../src/db/sqlite.js';
import { SCHEMA_SQL, SCHEMA_VERSION } from '../src/db/schema.js';
import { SetupRepository } from '../src/db/setupRepository.js';
import { readCameras, toCameraConfig } from '../src/db/configCameras.js';

/**
 * 계획 §7 `test/database.test.ts` (추가분) — T-DB1~T-DB4.
 *
 * `test/database.test.ts` 에 얹지 않고 별도 파일로 세운 이유는 `park3dRpcServerRoutes.test.ts` 가
 * `server.test.ts` 옆에 선 것과 같다 — 저쪽은 커미셔닝 DB 전반의 계약을 지키는 큰 파일이고,
 * 이쪽은 **이번에 새로 생긴 가드 하나**를 세 상태로 몰아붙이는 파일이라 수명이 다르다.
 *
 * ## 이 파일이 가장 우선인 이유
 *
 * `verifyCameraKindConstraint()` 는 `openDatabase()` 안에서 **`DatabaseError` 를 던진다.**
 * 거짓 양성이면 서비스가 아예 뜨지 않는다 — 운영 DB(상태 가)를 잘못 잡으면 그 순간 전면 장애다.
 * 그래서 세 상태를 전부 **실제 SQLite 파일**로 만들어 확인한다(계획 §5-C 표).
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'settingmanager-idis-db-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const dbPath = (name: string): string => join(dir, name);

/**
 * **(가) `ALTER TABLE … ADD COLUMN` 유래 — 운영 DB 의 모습.**
 *
 * SQLite 는 `ADD COLUMN` 에 CHECK 를 붙일 수 없어 `upgradeToV2()` 가 의도적으로 생략했다.
 * 그래서 `kind` 열에 CHECK 자체가 없다. `test/database.test.ts` 의 `writeV3AugmentedFixture` 와
 * 같은 순서(옛 10열 → ALTER → UPDATE → user_version=3)를 밟는다 — 그 파일과 공유하지 않는 이유도
 * 같다: "그때 디스크에 있던 사실"은 지금 코드를 따라가면 안 된다.
 */
function writeAlterDerivedFixture(path: string): void {
  const legacy = new DatabaseCtor(path);
  try {
    legacy.exec('PRAGMA foreign_keys = ON');
    legacy.exec(`
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
`);
    legacy.exec(`INSERT INTO place_info (place_id, place_name) VALUES (1, '기본 주차장')`);
    legacy.prepare(`
      INSERT INTO camera_info (cam_id, cam_name, cam_uuid, url, user_id, password, rtsp_url, cam_type, cam_company, place_id)
      VALUES (1, '리얼 1', 'real-camera-1', 'http://192.168.0.21:80', 'admin', 'pw1', 'rtsp://192.168.0.21:554/stream1', 'ptz', '휴컴스', 1)
    `).run();

    // `database.ts` 의 `upgradeToV2()` 와 같은 정의를 손으로 베낀다(CHECK 없음이 요점이다).
    legacy.exec(`ALTER TABLE camera_info ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 5000`);
    legacy.exec(`ALTER TABLE camera_info ADD COLUMN kind TEXT NOT NULL DEFAULT 'hucoms'`);
    legacy.exec(`ALTER TABLE camera_info ADD COLUMN park3d_cam_id INTEGER`);
    legacy.exec(`ALTER TABLE camera_info ADD COLUMN intrinsics TEXT`);
    legacy.exec('PRAGMA user_version = 3');
  } finally {
    legacy.close();
  }
}

/**
 * **(다) 옛 판의 `SCHEMA_SQL` 이 만든 파일.**
 *
 * 아래 문자열은 **HEAD(v4) `src/db/schema.ts` 의 `camera_info` 정의를 그대로 옮긴 것**이다
 * (`git show HEAD:SettingMain/src/db/schema.ts`). 주석까지 그대로 두었다 — `sqlite_master.sql`
 * 은 적은 그대로를 담고, 그 주석에 `kind` 라는 낱말이 들어 있어 가드의 주석 제거가 실제로
 * 필요한지가 이 픽스처에서 갈린다.
 */
const V4_CAMERA_INFO_SQL = `
CREATE TABLE IF NOT EXISTS place_info (
  place_id   INTEGER PRIMARY KEY,
  place_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS camera_info (
  cam_id      INTEGER PRIMARY KEY,
  cam_name    TEXT    NOT NULL,
  cam_uuid    TEXT    NOT NULL UNIQUE,
  url         TEXT    NOT NULL DEFAULT '',
  user_id     TEXT    NOT NULL DEFAULT '',
  password    TEXT    NOT NULL DEFAULT '',
  rtsp_url    TEXT    NOT NULL DEFAULT '',
  cam_type    TEXT    NOT NULL DEFAULT 'ptz' CHECK (cam_type IN ('ptz', 'static')),
  place_id    INTEGER NOT NULL REFERENCES place_info(place_id) ON DELETE RESTRICT,
  -- v2: config.json 이 갖고 있던 나머지. kind 가 없으면 드라이버를 만들 수 없다.
  timeout_ms  INTEGER NOT NULL DEFAULT 5000,
  kind        TEXT    NOT NULL DEFAULT 'hucoms' CHECK (kind IN ('hucoms', 'backend-core', 'park3d-rpc')),
  -- park3d-rpc 전용 1-based 카메라 번호. **cam_id 와 다른 값이다**(그쪽은 우리 통번).
  park3d_cam_id INTEGER,
  -- 실측 줌→화각 곡선 JSON: {"zoomHfov":[{"z":0,"h":57.14}, …]}. 없으면 브리지 박스줌이 꺼진다.
  intrinsics  TEXT    CHECK (intrinsics IS NULL OR json_valid(intrinsics))
);
`;

function writeOldSchemaFixture(path: string, options: { userVersion: number } = { userVersion: 4 }): void {
  const legacy = new DatabaseCtor(path);
  try {
    legacy.exec('PRAGMA foreign_keys = ON');
    legacy.exec(V4_CAMERA_INFO_SQL);
    legacy.exec(`INSERT INTO place_info (place_id, place_name) VALUES (1, '기본 주차장')`);
    if (options.userVersion >= SCHEMA_VERSION) {
      // 판이 이미 최신인 (다) 파일을 만들려면 **나머지 표까지 다 있어야** 한다 — 아니면
      // `verifySchema` 가 먼저 걸려 kind 가드가 실행되지도 않는다(그 사실 자체를 아래에서 못박는다).
      // `CREATE TABLE IF NOT EXISTS` 라 이미 있는 옛 `camera_info` 는 그대로 남는다.
      legacy.exec(SCHEMA_SQL);
      legacy.exec(`ALTER TABLE camera_info ADD COLUMN insecure_tls INTEGER NOT NULL DEFAULT 0`);
    }
    legacy.exec(`PRAGMA user_version = ${options.userVersion}`);
  } finally {
    legacy.close();
  }
}

/** `sqlite_master` 에 적힌 `camera_info` 정의 원문. 가드가 읽는 바로 그 문자열이다. */
function tableSqlOf(handle: DatabaseSync, table: string): string {
  return (handle.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table) as { sql: string }).sql;
}

// ---------------------------------------------------------------------------

describe('T-DB1 새 DB 에 IDIS 카메라', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = openDatabase({ path: ':memory:' }); });
  afterEach(() => { db.close(); });

  it('kind=`idis` 로 upsert 되고 되읽힌다', () => {
    const repo = new SetupRepository(db);
    const saved = repo.upsertCamera({
      cam_name: 'IDIS 1', cam_uuid: 'idis-1', url: 'https://192.168.0.30:443',
      user_id: 'admin', password: 'pw', rtsp_url: 'rtsp://192.168.0.30:554/trackID=1',
      cam_type: 'ptz', place_id: 1, kind: 'idis',
    });
    expect(saved.kind).toBe('idis');

    const read = repo.listCameras().find((c) => c.cam_uuid === 'idis-1')!;
    expect(read.kind).toBe('idis');
    expect(read.insecure_tls).toBe(0);   // 기본은 **검증 켬**(안전한 쪽)
  });

  it('새 파일에는 CHECK 가 있고 `idis` 가 그 목록에 있다', () => {
    const sql = tableSqlOf(db, 'camera_info');
    expect(sql).toContain("CHECK (kind IN ('hucoms', 'backend-core', 'park3d-rpc', 'idis'))");
  });

  it('새 파일의 CHECK 는 **모르는 kind 를 실제로 막는다** — 제약이 장식이 아님을 확인한다', () => {
    expect(() => db.prepare(
      `INSERT INTO camera_info (cam_id, cam_name, cam_uuid, place_id, kind) VALUES (99, 'x', 'x', 1, 'flexwatch')`,
    ).run()).toThrow();
  });

  it('`insecure_tls` 에도 CHECK 가 있어 0/1 밖의 값이 들어가지 않는다', () => {
    expect(() => db.prepare(
      `INSERT INTO camera_info (cam_id, cam_name, cam_uuid, place_id, insecure_tls) VALUES (98, 'x', 'y', 1, 7)`,
    ).run()).toThrow();
  });
});

describe('T-DB2 판 올림', () => {
  it('연 직후 user_version 이 SCHEMA_VERSION(=5) 이다', () => {
    const db = openDatabase({ path: ':memory:' });
    try {
      expect(SCHEMA_VERSION).toBe(5);
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(5);
    } finally {
      db.close();
    }
  });
});

describe('T-DB4 (가) ALTER 유래 픽스처 — **운영 DB 의 모습이다. 반드시 통과해야 한다**', () => {
  it('[전제] 픽스처의 kind 열에 CHECK 가 정말 없다 — 없어야 이 시험이 뜻을 갖는다', () => {
    const path = dbPath('alter.db');
    writeAlterDerivedFixture(path);
    const raw = new DatabaseCtor(path);
    try {
      const sql = tableSqlOf(raw, 'camera_info');
      expect(sql).toContain('kind');
      expect(sql).not.toContain('CHECK (kind IN');
    } finally {
      raw.close();
    }
  });

  it('가드에 걸리지 않고 열린다 — 여기서 던지면 운영 서비스가 기동조차 못 한다', () => {
    const path = dbPath('alter.db');
    writeAlterDerivedFixture(path);
    const db = openDatabase({ path });
    try {
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('열린 뒤 kind=`idis` 삽입까지 된다 — CHECK 가 없으므로 막을 것도 없다', () => {
    const path = dbPath('alter.db');
    writeAlterDerivedFixture(path);
    const db = openDatabase({ path });
    try {
      const repo = new SetupRepository(db);
      repo.upsertCamera({
        cam_name: 'IDIS 1', cam_uuid: 'idis-1', url: 'https://192.168.0.30:443',
        user_id: 'admin', password: 'pw', rtsp_url: '', cam_type: 'ptz', place_id: 1,
        kind: 'idis', insecure_tls: 1,
      });
      const read = repo.listCameras().find((c) => c.cam_uuid === 'idis-1')!;
      expect(read.kind).toBe('idis');
      expect(read.insecure_tls).toBe(1);
      // 기존 카메라가 살아 있다 — 마이그레이션이 데이터를 잃지 않았다.
      expect(repo.listCameras().find((c) => c.cam_uuid === 'real-camera-1')?.kind).toBe('hucoms');
    } finally {
      db.close();
    }
  });

  it('`insecure_tls` 열이 ALTER 로 붙고 기존 줄은 0 으로 채워진다', () => {
    const path = dbPath('alter.db');
    writeAlterDerivedFixture(path);
    const db = openDatabase({ path });
    try {
      const columns = (db.prepare(`PRAGMA table_info("camera_info")`).all() as unknown as Array<{ name: string }>).map((c) => c.name);
      expect(columns).toContain('insecure_tls');
      expect(new SetupRepository(db).listCameras().find((c) => c.cam_uuid === 'real-camera-1')?.insecure_tls).toBe(0);
      // ALTER 유래라 이 열에도 CHECK 가 없다 — 저장소 계층이 0/1 로 좁혀 넣는 것이 그 대가다.
      expect(tableSqlOf(db, 'camera_info')).not.toContain('CHECK (insecure_tls');
    } finally {
      db.close();
    }
  });

  it('**멱등하다** — 같은 파일을 몇 번 다시 열어도 결과가 같다', () => {
    const path = dbPath('alter.db');
    writeAlterDerivedFixture(path);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const db = openDatabase({ path });
      try {
        expect(new SetupRepository(db).listCameras()).toHaveLength(1);
        const columns = (db.prepare(`PRAGMA table_info("camera_info")`).all() as unknown as Array<{ name: string }>)
          .filter((c) => c.name === 'insecure_tls');
        expect(columns, `${attempt}회차`).toHaveLength(1);   // 열이 두 번 붙지 않는다
      } finally {
        db.close();
      }
    }
  });

  it('이미 열린 핸들에 `migrate()` 를 다시 불러도 던지지 않는다 (가드 자체의 멱등)', () => {
    const path = dbPath('alter.db');
    writeAlterDerivedFixture(path);
    const db = openDatabase({ path });
    try {
      expect(() => migrate(db)).not.toThrow();
      expect(() => migrate(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe('T-DB4 (나) 이 판의 SCHEMA_SQL 이 만든 파일 — CHECK 에 idis 가 있어 통과한다', () => {
  it('새로 만들고 닫았다 다시 열어도 통과한다', () => {
    const path = dbPath('fresh.db');
    const first = openDatabase({ path });
    first.close();
    const second = openDatabase({ path });
    try {
      expect(tableSqlOf(second, 'camera_info')).toContain("'idis'");
      expect(() => migrate(second)).not.toThrow();
    } finally {
      second.close();
    }
  });
});

describe('T-DB3 (다) 옛 판 SCHEMA_SQL 이 만든 파일 — **한국어 오류를 던진다**', () => {
  it('[전제] 픽스처의 CHECK 에 idis 가 없다 — 없어야 이 시험이 뜻을 갖는다', () => {
    const path = dbPath('old-schema.db');
    writeOldSchemaFixture(path);
    const raw = new DatabaseCtor(path);
    try {
      const sql = tableSqlOf(raw, 'camera_info');
      expect(sql).toContain("CHECK (kind IN ('hucoms', 'backend-core', 'park3d-rpc'))");
      expect(sql).not.toContain("'idis'");
      // 이 픽스처의 주석에 `kind` 라는 낱말이 들어 있다 — 가드가 주석을 안 걷으면 여기서 엉뚱한
      // CHECK(cam_type)을 읽고 조용히 통과해 버린다.
      expect(sql).toContain('-- v2: config.json 이 갖고 있던 나머지. kind 가 없으면');
    } finally {
      raw.close();
    }
  });

  it('`openDatabase()` 가 `DatabaseError` 를 던진다', () => {
    const path = dbPath('old-schema.db');
    writeOldSchemaFixture(path);
    expect(() => openDatabase({ path })).toThrow(DatabaseError);
  });

  it('메시지에 `camera_info`·`kind`·`idis` 가 모두 실린다 — 사람이 무엇을 고쳐야 하는지 알 수 있어야 한다', () => {
    const path = dbPath('old-schema.db');
    writeOldSchemaFixture(path);
    const error = (() => { try { openDatabase({ path }); return null; } catch (e) { return e as Error; } })();
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error!.message).toContain('camera_info');
    expect(error!.message).toContain('kind');
    expect(error!.message).toContain('idis');
    // 현재 제약 원문도 실린다 — 이것이 없으면 결국 사람이 DB 를 직접 열어 봐야 한다.
    expect(error!.message).toContain("'park3d-rpc'");
  });

  it('**멱등하다** — 다시 열어도 같은 오류다(첫 시도에서 판만 올라가고 조용해지지 않는다)', () => {
    const path = dbPath('old-schema.db');
    writeOldSchemaFixture(path);
    expect(() => openDatabase({ path })).toThrow(DatabaseError);
    expect(() => openDatabase({ path })).toThrow(DatabaseError);
    expect(() => openDatabase({ path })).toThrow(DatabaseError);
  });

  it('판이 이미 최신(5)인 (다) 파일도 잡는다 — `verifySchema` 만으로는 못 잡는 자리다', () => {
    // 판만 5 인 옛 스키마. 마이그레이션 블록을 통째로 건너뛰므로 이 가드가 유일한 그물이다.
    const path = dbPath('old-schema-v5.db');
    writeOldSchemaFixture(path, { userVersion: SCHEMA_VERSION });

    // [전제] 표·열은 전부 갖춰져 있다 — 즉 `verifySchema` 는 이 파일을 통과시킨다.
    const raw = new DatabaseCtor(path);
    try {
      expect(tableSqlOf(raw, 'camera_info')).not.toContain("'idis'");
      const columns = (raw.prepare(`PRAGMA table_info("camera_info")`).all() as unknown as Array<{ name: string }>).map((c) => c.name);
      expect(columns).toContain('insecure_tls');
    } finally {
      raw.close();
    }

    const error = (() => { try { openDatabase({ path }); return null; } catch (e) { return e as Error; } })();
    expect(error).toBeInstanceOf(DatabaseError);
    // 스키마 대조가 아니라 **kind 제약**에서 걸렸다는 것까지 고정한다.
    expect(error!.message).toContain('idis');
    expect(error!.message).not.toContain('스키마가 코드의 기대와 다릅니다');
  });

  it('던지기만 하고 **표를 재작성하지 않는다** — 프리셋·슬롯 연쇄 삭제 위험을 감수하지 않는다', () => {
    const path = dbPath('old-schema.db');
    writeOldSchemaFixture(path);
    expect(() => openDatabase({ path })).toThrow(DatabaseError);

    const raw = new DatabaseCtor(path);
    try {
      // 옛 CHECK 가 그대로 남아 있다 = 표를 다시 만들지 않았다.
      expect(tableSqlOf(raw, 'camera_info')).toContain("CHECK (kind IN ('hucoms', 'backend-core', 'park3d-rpc'))");
    } finally {
      raw.close();
    }
  });
});

describe('가드가 던질 때 **파일 잠금을 남기지 않는다** (검증 중 발견해 고친 결함)', () => {
  it('`openDatabase()` 가 던진 뒤에도 그 파일을 지울 수 있다 — 못 지우면 사람이 손쓸 방법이 막힌다', async () => {
    const path = dbPath('old-schema-unlock.db');
    writeOldSchemaFixture(path);
    expect(() => openDatabase({ path })).toThrow(DatabaseError);
    // 핸들이 새면 Windows 에서 여기가 EBUSY 로 죽는다.
    await expect(rm(path, { force: true })).resolves.toBeUndefined();
  });
});

describe('가드가 **엉뚱한 CHECK 를 읽지 않는다** — 주석 제거의 근거', () => {
  it('`kind` 에 CHECK 가 없고 뒤쪽 열에만 CHECK 가 있는 표를 (다)로 오판하지 않는다', () => {
    // (가)의 모습이면서 `intrinsics` 에 CHECK 가 있는 파일. 열 구분자를 넘어 읽으면 여기서 던진다.
    const path = dbPath('alter-with-later-check.db');
    writeAlterDerivedFixture(path);
    const raw = new DatabaseCtor(path);
    try {
      raw.exec(`ALTER TABLE camera_info ADD COLUMN note TEXT CHECK (note IS NULL OR json_valid(note))`);
    } finally {
      raw.close();
    }
    const db = openDatabase({ path });
    try {
      expect(tableSqlOf(db, 'camera_info')).toContain('CHECK (note IS NULL');
    } finally {
      db.close();
    }
  });
});

describe('T-DB1 DB → CameraConfig 왕복에서 kind 가 살아남는다', () => {
  it('`readCameras` 가 idis 카메라를 그대로 돌려준다', () => {
    const db = openDatabase({ path: ':memory:' });
    try {
      new SetupRepository(db).upsertCamera({
        cam_name: 'IDIS 1', cam_uuid: 'idis-1', url: 'https://192.168.0.30:443',
        user_id: 'admin', password: 'pw', rtsp_url: 'rtsp://192.168.0.30:554/trackID=1',
        cam_type: 'ptz', place_id: 1, kind: 'idis', timeout_ms: 3000,
      });
      const cameras = readCameras(db);
      const idis = cameras.find((c) => c.id === 'idis-1')!;
      expect(idis.kind).toBe('idis');
      expect(idis.controlUrl).toBe('https://192.168.0.30:443');
      expect(idis.timeoutMs).toBe(3000);
      // 켜지 않았으므로 키 자체가 없다.
      expect(idis).not.toHaveProperty('insecureTls');
    } finally {
      db.close();
    }
  });

  it('`toCameraConfig` 는 kind 를 지어내지 않는다 — 표의 값이 그대로 온다', () => {
    const db = openDatabase({ path: ':memory:' });
    try {
      const repo = new SetupRepository(db);
      const row = repo.upsertCamera({
        cam_name: 'IDIS 1', cam_uuid: 'idis-1', url: 'http://10.0.0.9:80',
        user_id: '', password: '', rtsp_url: '', cam_type: 'ptz', place_id: 1, kind: 'idis',
      });
      expect(toCameraConfig(row).kind).toBe('idis');
    } finally {
      db.close();
    }
  });
});
