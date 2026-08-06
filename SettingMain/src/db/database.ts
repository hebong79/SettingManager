import type { DatabaseSync } from 'node:sqlite';
import { DatabaseSync as DatabaseCtor } from './sqlite.js';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CONFIG_DIR } from '../paths.js';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

/**
 * SQLite 열기 한 곳.
 *
 * **드라이버를 설치하지 않는다** — Node 22.5+ 의 내장 `node:sqlite` 를 쓴다. 이 서비스의
 * 런타임 의존성 0 원칙 때문이고, 그래서 `better-sqlite3` 같은 네이티브 빌드가 필요 없다.
 * (Node 가 실험적 기능이라는 경고를 한 줄 찍는다 — 기능은 안정적으로 동작한다.)
 */

export const DEFAULT_DB_PATH = resolve(CONFIG_DIR, 'setup.db');

export class DatabaseError extends Error {
  constructor(message: string, readonly statusCode = 500, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseError';
  }
}

export interface OpenDatabaseOptions {
  /** `:memory:` 를 주면 파일 없이 연다(테스트용). */
  path?: string;
}

/**
 * DB 를 열고 스키마를 현재 판까지 올린다.
 *
 * 세 PRAGMA 가 계약이다.
 *   `foreign_keys`  기본이 **꺼짐**이다. 켜지 않으면 없는 카메라를 가리키는 프리셋이 조용히 들어간다.
 *   `journal_mode`  WAL — 읽는 쪽이 쓰는 쪽을 막지 않는다. 메모리 DB 에는 적용되지 않는다.
 *   `busy_timeout`  잠깐의 경합에서 즉시 `SQLITE_BUSY` 로 던지지 않게 한다.
 */
export function openDatabase(options: OpenDatabaseOptions = {}): DatabaseSync {
  const path = options.path ?? DEFAULT_DB_PATH;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseCtor(path);
  // **여는 데 실패하면 핸들을 닫고 나간다.** `migrate()` 는 던질 수 있고(판 역행·스키마 불일치·
  // `verifyCameraKindConstraint`), 던진 채 핸들을 두면 파일 잠금이 남는다 — Windows 에서는
  // 그 파일을 지우지도 옮기지도 못하게 되어(EBUSY) 사람이 손쓸 방법까지 막힌다.
  try {
    db.exec('PRAGMA foreign_keys = ON');
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * 스키마 판 올리기. 판이 뒤처진 파일만 손대고, 마지막에 **언제나** 대조로 확인한다.
 *
 * **앞선 판을 되돌리지 않는다** — DB 판이 코드보다 높으면 던진다. 옛 코드가 새 파일을 열어
 * 모르는 열을 무시한 채 쓰면, 그 순간 새 코드가 기대하는 값이 조용히 비어 버린다.
 */
export function migrate(db: DatabaseSync): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0);
  if (current > SCHEMA_VERSION) {
    throw new DatabaseError(
      `DB 스키마 판(${current})이 이 코드가 아는 판(${SCHEMA_VERSION})보다 높습니다 — 더 새로운 SettingManager 로 여십시오`,
    );
  }

  if (current < SCHEMA_VERSION) {
    db.exec('BEGIN');
    try {
      // `CREATE TABLE IF NOT EXISTS` 는 **이미 있는 표에 열을 더해 주지 않는다.** 이미 있는 표는
      // 여기서 따로 올린다. 순서가 중요하다 — 아래 SCHEMA_SQL 이 지나가면 표는 존재하는데
      // 열은 옛날 그대로라, 새 코드가 없는 열을 읽고 조용히 undefined 를 얻는다.
      // **판 번호로 분기하지 않는다** — 열이 있는지 스스로 묻는 쪽이 판 번호보다 정확하고,
      // 판 번호로 갈랐던 자리가 바로 v2 열 넷을 통째로 빠뜨린 자리다.
      upgradeToV2(db);
      dropCamCompany(db);
      addInsecureTls(db);
      db.exec(SCHEMA_SQL);
      // 문서 규약: 장소는 현재 무조건 1. 없으면 만들어 둔다 — 외래키가 걸려 있어 이것이 없으면
      // 카메라를 한 대도 넣을 수 없다.
      db.exec(`INSERT OR IGNORE INTO place_info (place_id, place_name) VALUES (1, '기본 주차장')`);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (cause) {
      db.exec('ROLLBACK');
      throw new DatabaseError('DB 스키마 생성에 실패했습니다', 500, { cause });
    }
  }

  // 판을 올렸든 안 올렸든 **항상** 확인한다. 판이 이미 최신이라 위를 통째로 건너뛴 파일이
  // 이번 사고의 모습이었다 — 판만 맞고 열은 없었다.
  verifySchema(db);
  verifyCameraKindConstraint(db);
}

/**
 * `camera_info` 에 카메라의 나머지 정보를 담을 열 넷(v2 에 더해진 것)을 채워 넣는다.
 * **어느 옛 판에서 올라와도 멱등하다** — 판 번호가 아니라 열이 있는지로 판단하므로,
 * 없는 것만 더하고 있는 것은 건너뛴다. 표 자체가 없는 새 파일에서는 그냥 빠져나간다.
 *
 * `ADD COLUMN` 은 되돌릴 수 없지만 **기존 줄을 건드리지 않는다** — 새 열은 기본값으로 채워지고
 * 옛 값은 그대로다. 이미 있는 열을 다시 더하면 SQLite 가 던지므로, 무엇이 있는지 먼저 묻는다
 * (`ALTER TABLE … ADD COLUMN IF NOT EXISTS` 는 SQLite 에 없다).
 *
 * `CHECK` 는 `ADD COLUMN` 으로 붙일 수 없어(기존 줄 검사가 필요하다) 여기서는 생략한다.
 * 새로 만드는 파일은 `SCHEMA_SQL` 이 제약까지 갖춘 표를 만들고, 옛 파일은 저장소 계층이
 * 값을 좁혀 넣는다 — 제약이 두 파일에서 다른 것은 감수하고, 그 대신 데이터를 잃지 않는다.
 */
function upgradeToV2(db: DatabaseSync): void {
  const existing = new Set((db.prepare(`PRAGMA table_info("camera_info")`).all() as unknown as Array<{ name: string }>).map((row) => row.name));
  if (existing.size === 0) return; // 표 자체가 없다 — 새 파일이므로 SCHEMA_SQL 이 만든다.
  const additions: Array<[string, string]> = [
    ['timeout_ms', `INTEGER NOT NULL DEFAULT 5000`],
    ['kind', `TEXT NOT NULL DEFAULT 'hucoms'`],
    ['park3d_cam_id', `INTEGER`],
    ['intrinsics', `TEXT`],
  ];
  for (const [name, definition] of additions) {
    if (!existing.has(name)) db.exec(`ALTER TABLE camera_info ADD COLUMN ${name} ${definition}`);
  }
}

/**
 * v4: 제조사(`cam_company`)를 프로토콜(`kind`) 하나로 합쳤다(마스터 결정 2026-08-06).
 * 근거와 감수한 손실은 `schema.ts` 머리말 7번에 적어 두었다.
 *
 * **`upgradeToV2()` 와 같은 관례다 — 판 번호가 아니라 열이 있는지로 판단한다.** 판 번호로
 * 갈랐던 자리가 바로 v2 열 넷을 통째로 빠뜨린 자리다. 그래서 이미 지운 파일에는 아무 일도
 * 하지 않는다(멱등).
 *
 * **왜 `DROP COLUMN` 이 되는가**: SQLite 는 그 열을 PRIMARY KEY·UNIQUE·인덱스·뷰·CHECK·
 * 외래키·생성열이 참조할 때만 거부한다. `cam_company` 는 어디서도 참조되지 않는다 — 이 표의
 * 유일한 인덱스 `idx_camera_place` 는 `place_id`, 뷰 `floor_ROI` 는 `slot_setup` 에서 뽑고,
 * CHECK 셋은 `cam_type`·`kind`·`intrinsics` 에 걸려 있다. 새 파일 모양과 ALTER 로 보강된
 * 옛 파일 모양 양쪽에서 실측했다 — 나머지 열 값·인덱스·CHECK 는 전부 보존된다.
 */
function dropCamCompany(db: DatabaseSync): void {
  const columns = new Set((db.prepare(`PRAGMA table_info("camera_info")`).all() as unknown as Array<{ name: string }>).map((row) => row.name));
  if (columns.has('cam_company')) db.exec('ALTER TABLE camera_info DROP COLUMN cam_company');
}

/**
 * v5: `camera_info` 에 `insecure_tls` 를 더한다 — idis 기기 하나에 한해 TLS 검증을 끄는 값이다.
 *
 * **`upgradeToV2()`·`dropCamCompany()` 와 같은 관례다** — 판 번호가 아니라 열이 있는지로
 * 판단하므로 멱등하고, 표가 아직 없는 새 파일에서는 그냥 빠져나간다(`SCHEMA_SQL` 이 만든다).
 * `CHECK (insecure_tls IN (0,1))` 는 `ADD COLUMN` 으로 붙일 수 없어 여기서는 생략한다 —
 * 새 파일만 제약을 갖고 옛 파일은 저장소 계층이 값을 0/1 로 좁혀 넣는다. `kind` 열이 v2 에서
 * 겪은 것과 같은 상황이며, 같은 이유로 감수한다(데이터를 잃지 않는 쪽).
 */
function addInsecureTls(db: DatabaseSync): void {
  const columns = new Set((db.prepare(`PRAGMA table_info("camera_info")`).all() as unknown as Array<{ name: string }>).map((row) => row.name));
  if (columns.size === 0) return;
  if (!columns.has('insecure_tls')) db.exec(`ALTER TABLE camera_info ADD COLUMN insecure_tls INTEGER NOT NULL DEFAULT 0`);
}

/**
 * `camera_info.kind` 의 CHECK 가 `idis` 를 허용하는지 **검사만** 한다.
 *
 * 파일은 세 모습뿐이다.
 *   (가) `ALTER TABLE … ADD COLUMN` 으로 kind 가 붙은 파일(= 운영 DB) — **CHECK 자체가 없다.**
 *        SQLite 는 `ADD COLUMN` 에 CHECK 를 붙일 수 없어 `upgradeToV2()` 가 의도적으로 생략했다.
 *   (나) 이 판의 `SCHEMA_SQL` 이 새로 만든 파일 — 목록에 `idis` 가 있다.
 *   (다) **옛 판의 `SCHEMA_SQL` 이 만든 파일** — 옛 목록의 CHECK 가 표 정의에 박혀 있고,
 *        `CREATE TABLE IF NOT EXISTS` 는 이미 있는 표의 정의를 바꾸지 않으므로 그대로 남는다.
 *
 * (다)만 문제이고 `verifySchema` 는 이것을 잡지 못한다 — 그쪽은 표·뷰 이름과 **열 이름만**
 * 대조하고 제약은 보지 않는다.
 *
 * **고치지 않고 던지는 이유.** 표 재작성(12-step rebuild)에는 데이터 손실 위험이 실재한다:
 * `migrate()` 는 `BEGIN`…`COMMIT` 안에서 돌고 `PRAGMA foreign_keys` 는 **트랜잭션 안에서
 * 무효(no-op)** 다. 그 상태로 `DROP TABLE camera_info` 를 하면 SQLite 가 암묵 `DELETE FROM` 을
 * 수행하고 `preset_info.cam_id … ON DELETE CASCADE` 가 발동해 **프리셋 전부 → `slot_setup`
 * 전부**가 연쇄 삭제된다. 커미셔닝 산출물을 다루는 코드에서 (다)라는 드문 상태 하나 때문에
 * 그 위험을 감수하지 않는다. `verifySchema` 의 철학("검사만 하고 고치지 않는다")과도 같다.
 *
 * **판 번호가 아니라 사실로 판단한다** — 술어가 `user_version` 이 아니라 `sqlite_master.sql`
 * 문자열이므로 멱등하고 (가)·(나)에서는 아무 일도 하지 않는다.
 */
function verifyCameraKindConstraint(db: DatabaseSync): void {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'camera_info'`).get() as { sql?: string } | undefined;
  if (!row?.sql) return;
  // `sqlite_master.sql` 은 **적은 그대로**를 담으므로 주석도 들어 있다. 우리 스키마의 주석에
  // `kind` 라는 낱말이 있어 먼저 걷어낸다 — 안 걷으면 주석에서 시작한 매칭이 실제 열 정의를
  // 지나쳐 엉뚱한 CHECK 를 읽는다.
  const sql = row.sql.replace(/--[^\n]*/g, ' ');
  // `kind` 열 하나의 `CHECK ( … )` 만 본다 — 열 구분자(콤마)를 넘지 않으므로 같은 표의 다른
  // CHECK(cam_type·intrinsics)를 섞어 읽지 않는다.
  const constraint = /\bkind\b[^,]*?CHECK\s*\(([^)]*)\)/is.exec(sql);
  if (!constraint) return; // (가) — kind 에 CHECK 가 없다. 운영 DB 의 모습이며 삽입에 아무 문제가 없다.
  if (constraint[1]!.includes("'idis'")) return; // (나)
  throw new DatabaseError(
    `이 DB 파일의 camera_info.kind 제약이 idis 를 허용하지 않습니다 — 옛 판으로 새로 만들어진 파일입니다. `
    + `표 재작성이 필요합니다(설계 §5-C). 현재 제약: CHECK (${constraint[1]!.trim()})`,
  );
}

/**
 * 열기 시점 스키마 대조 — **판 번호와 무관한 안전망**.
 *
 * 판 올리기를 잊거나 마이그레이션 단계를 빠뜨리면, 표는 있는데 열은 없는 파일이 아무 소리 없이
 * 열린다. 없는 열은 `undefined` 가 되어 한참 떨어진 자리에서 400 으로 새어 나오고, 그때는
 * 원인이 DB 라는 것조차 보이지 않는다(`camera_info.kind` 가 그랬다). 그래서 여기서
 * **의도(`SCHEMA_SQL`)와 현실(파일)을 직접 맞대 본다** — 기대 목록을 손으로 적지 않고
 * `SCHEMA_SQL` 에서 뽑으므로 목록 자체가 낡을 수 없다.
 *
 * **검사만 하고 고치지 않는다.** 보정까지 하면 무엇이 왜 어긋났는지 아무도 다시 안 보게 되고,
 * 대조가 두 번째 마이그레이션 엔진이 된다 — 고치는 것은 마이그레이션의 일이다.
 *
 * 실제에만 있는 여분의 표·열은 문제 삼지 않는다. 앞선 판이 연 파일은 `user_version` 검사가
 * 이미 막고, 그 밖의 여분은 우리 코드가 읽지 않으므로 해가 없다.
 */
function verifySchema(db: DatabaseSync): void {
  // 기준은 **갓 만든 빈 DB** 다. SCHEMA_SQL 만 태워 SQLite 스스로 답하게 하면, 코드가 정말로
  // 만들려던 모습이 나온다.
  const reference = new DatabaseCtor(':memory:');
  let expected: Map<string, SchemaObject>;
  try {
    reference.exec(SCHEMA_SQL);
    expected = schemaObjectsOf(reference);
  } finally {
    reference.close(); // 일회용이다. 안 닫으면 열 때마다 하나씩 쌓인다.
  }

  const actual = schemaObjectsOf(db);
  const missing: string[] = [];
  for (const [name, want] of expected) {
    const have = actual.get(name);
    if (!have) {
      missing.push(`${name} ${want.type === 'view' ? '뷰' : '표'}가 없습니다`);
      continue;
    }
    const gone = want.columns.filter((column) => !have.columns.includes(column));
    if (gone.length > 0) missing.push(`${name} 에 ${gone.join(', ')} 가 없습니다`);
  }
  // 이름을 그대로 싣는다 — "스키마가 다릅니다"만 있으면 결국 사람이 DB 를 직접 열어 봐야 한다.
  if (missing.length > 0) {
    throw new DatabaseError(`DB 스키마가 코드의 기대와 다릅니다 — ${missing.join('; ')}`);
  }
}

interface SchemaObject {
  type: string;
  columns: string[];
}

/**
 * 표·뷰 이름 → 열 이름들. 뷰(`floor_ROI`)도 담는다 — 뽑는 열이 바뀌면 그것도 어긋남이다.
 *
 * `sqlite_` 로 시작하는 것은 뺀다. `sqlite_sequence` 는 AUTOINCREMENT 표를 만들 때 SQLite 가
 * 스스로 만드는 장부라 우리 의도가 아니고, 양쪽에 있고 없고가 우리와 무관한 사정으로 갈려
 * 거짓 경보가 된다.
 */
function schemaObjectsOf(db: DatabaseSync): Map<string, SchemaObject> {
  const rows = db
    .prepare(`SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'`)
    .all() as unknown as Array<{ name: string; type: string }>;
  return new Map(
    rows.map((row) => [
      row.name,
      {
        type: row.type,
        // 이름은 SQLite 가 답한 것 그대로지만, 큰따옴표 안에 넣어야 예약어와 겹쳐도 안전하다.
        columns: (db.prepare(`PRAGMA table_info("${row.name}")`).all() as unknown as Array<{ name: string }>).map((column) => column.name),
      },
    ]),
  );
}

/**
 * 여러 쓰기를 한 덩어리로 묶는다. 중간에 던지면 전부 되돌린다 —
 * 반쯤 들어간 커미셔닝 결과는 없느니만 못하다.
 */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  // **재진입 가능해야 한다.** 저장소 메서드가 저마다 트랜잭션을 여는데, 여러 건을 한 덩어리로
  // 묶는 호출(이관 등)이 그것들을 다시 감싼다. SQLite 는 중첩 BEGIN 을 거부하므로
  // (`cannot start a transaction within a transaction`) 이미 열려 있으면 그대로 참여한다 —
  // 바깥이 커밋·롤백을 책임지므로 "전부 되거나 전부 안 된다"는 성질은 그대로다.
  if (OPEN.has(db)) return work();

  OPEN.add(db);
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    OPEN.delete(db);
  }
}

/** 지금 트랜잭션이 열려 있는 DB 들. 핸들이 사라지면 함께 사라진다. */
const OPEN = new WeakSet<DatabaseSync>();
