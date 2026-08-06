import type { DatabaseSync } from 'node:sqlite';
import { DatabaseError } from './database.js';

/**
 * DB 테이블 뷰어의 질의 조립.
 *
 * **화면이 보낸 이름을 SQL 에 그대로 붙이지 않는다.** 값은 전부 바인딩 파라미터로 나가고,
 * 식별자(테이블·열)는 SQLite 가 스스로 답한 목록(`PRAGMA table_info`)과 **대조해서만** 쓴다.
 * 비교 연산자도 정해진 목록 안에서 고른다. 이 셋이 이 파일의 안전 전부다 —
 * 식별자는 바인딩할 수 없으므로 화이트리스트 말고는 막을 방법이 없다.
 */

/** 뷰어가 열 수 있는 것. 뷰(`floor_ROI`)도 읽기 전용으로 포함한다. */
export const VIEWABLE_TABLES = [
  'place_info',
  'camera_info',
  'preset_info',
  'slot_setup',
  'floor_ROI',
  'parking_slot',
  'parking_evnt',
] as const;

export type ViewableTable = (typeof VIEWABLE_TABLES)[number];

/**
 * 기간 검색이 쓸 시간 열. 테이블마다 이름이 다르고, **없는 테이블도 있다** —
 * 없는 곳에서 기간을 주면 조용히 무시하지 않고 400 으로 거절한다.
 */
const TIME_COLUMN: Partial<Record<ViewableTable, string>> = {
  slot_setup: 'updated_at',
  parking_slot: 'update_time',
  parking_evnt: 'update_time',
};

/**
 * 값을 내보내지 않는 열. 뜻은 `dbRoutes.publicCamera` 와 같다 — 있는지만 보이고 값은 감춘다.
 *
 * 가리는 것으로 끝나지 않는다. **훑기·조건·정렬에서도 뺀다** — 값이 `***` 로 나가도
 * `password LIKE '%secre%'` 가 행을 잡아 주면 한 글자씩 되물어 원문을 알아낼 수 있다.
 */
const MASKED_COLUMNS: Partial<Record<ViewableTable, readonly string[]>> = {
  camera_info: ['password'],
};

/** 빈 값은 가리지 않는다 — 없는 비밀번호를 있는 것처럼 보이면 안 된다. */
const MASK = '***';

const OPERATORS = ['=', '!=', '<', '<=', '>', '>=', 'LIKE', 'IS NULL', 'IS NOT NULL'] as const;
export type Operator = (typeof OPERATORS)[number];

export interface Condition {
  column: string;
  op: Operator;
  value?: string | number | null;
}

export interface QueryInput {
  table: string;
  /** 자유 텍스트. 열을 지정하지 않으면 **문자열로 볼 수 있는 열 전부**를 훑는다. */
  text?: string;
  textColumn?: string;
  /** ISO 문자열. 시간 열이 있는 테이블에서만 쓸 수 있다. */
  from?: string;
  to?: string;
  conditions?: Condition[];
  orderBy?: string;
  desc?: boolean;
  limit?: number;
  offset?: number;
}

export interface QueryResult {
  table: string;
  columns: string[];
  timeColumn: string | null;
  rows: Array<Record<string, unknown>>;
  /** 조건에 맞는 전체 개수(페이지 아님). */
  total: number;
  limit: number;
  offset: number;
}

export interface TableInfo {
  name: string;
  columns: string[];
  timeColumn: string | null;
  /** 뷰는 고칠 수 없다 — 화면이 편집 단추를 그리지 않게 미리 말한다. */
  readOnly: boolean;
}

export function listTables(db: DatabaseSync): TableInfo[] {
  return VIEWABLE_TABLES.map((name) => ({
    name,
    columns: columnsOf(db, name),
    timeColumn: TIME_COLUMN[name] ?? null,
    readOnly: name === 'floor_ROI',
  }));
}

/** SQLite 가 스스로 답한 열 목록. 화이트리스트의 정본이라 코드에 베껴 두지 않는다. */
export function columnsOf(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as unknown as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

export function runQuery(db: DatabaseSync, input: QueryInput): QueryResult {
  const table = requireTable(input.table);
  const columns = columnsOf(db, table);
  const timeColumn = TIME_COLUMN[table] ?? null;
  const masked = MASKED_COLUMNS[table] ?? [];

  const where: string[] = [];
  const params: Array<string | number | null> = [];

  // --- 자유 텍스트 --------------------------------------------------------
  const text = (input.text ?? '').trim();
  if (text) {
    const targets = input.textColumn
      ? [requireColumn(columns, input.textColumn, table, masked)]
      : columns.filter((c) => !masked.includes(c));
    // 숫자 열도 CAST 로 훑는다 — 사람은 "슬롯 12"를 찾을 때 열 종류를 생각하지 않는다.
    where.push(`(${targets.map((c) => `CAST(${quoteIdent(c)} AS TEXT) LIKE ?`).join(' OR ')})`);
    for (const _ of targets) params.push(`%${text}%`);
  }

  // --- 기간 --------------------------------------------------------------
  if (input.from || input.to) {
    if (!timeColumn) {
      throw new DatabaseError(`${table} 에는 시간 열이 없어 기간으로 거를 수 없습니다`, 400);
    }
    if (input.from) {
      where.push(`${quoteIdent(timeColumn)} >= ?`);
      params.push(input.from);
    }
    if (input.to) {
      // 날짜만 준 경우(2026-08-05)에도 그날 전체가 들어오도록 끝을 넓힌다 —
      // 안 그러면 그날 00:00:00 한 순간만 잡혀 "왜 오늘 게 안 나오나"가 된다.
      where.push(`${quoteIdent(timeColumn)} <= ?`);
      params.push(/^\d{4}-\d{2}-\d{2}$/.test(input.to) ? `${input.to}T23:59:59.999Z` : input.to);
    }
  }

  // --- 조건 --------------------------------------------------------------
  for (const condition of input.conditions ?? []) {
    const column = requireColumn(columns, condition.column, table, masked);
    if (!OPERATORS.includes(condition.op)) {
      throw new DatabaseError(`쓸 수 없는 비교입니다: ${String(condition.op)} (가능: ${OPERATORS.join(' · ')})`, 400);
    }
    if (condition.op === 'IS NULL' || condition.op === 'IS NOT NULL') {
      where.push(`${quoteIdent(column)} ${condition.op}`);
      continue;
    }
    where.push(`${quoteIdent(column)} ${condition.op} ?`);
    params.push(condition.value ?? null);
  }

  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}${clause}`).get(...params) as { n: number }).n);

  const limit = clampInt(input.limit, 200, 1, 2000);
  const offset = clampInt(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const order = input.orderBy
    ? ` ORDER BY ${quoteIdent(requireColumn(columns, input.orderBy, table, masked))} ${input.desc ? 'DESC' : 'ASC'}`
    : defaultOrder(table, columns, timeColumn);

  const rows = db.prepare(`SELECT * FROM ${quoteIdent(table)}${clause}${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as unknown as Array<Record<string, unknown>>;

  return { table, columns, timeColumn, rows: rows.map((row) => maskRow(row, masked)), total, limit, offset };
}

/** 값이 있는 가림 열만 `***` 로 바꾼다. 열 자체는 지우지 않는다 — 표의 머리와 칸 수가 어긋나면 안 된다. */
function maskRow(row: Record<string, unknown>, masked: readonly string[]): Record<string, unknown> {
  if (masked.length === 0) return row;
  const copy = { ...row };
  for (const column of masked) {
    if (copy[column] !== null && copy[column] !== undefined && String(copy[column]) !== '') copy[column] = MASK;
  }
  return copy;
}

/** 시간이 있으면 최신 먼저, 없으면 첫 열 오름차순. 정렬 없는 목록은 페이지가 흔들린다. */
function defaultOrder(table: string, columns: string[], timeColumn: string | null): string {
  if (timeColumn) return ` ORDER BY ${quoteIdent(timeColumn)} DESC`;
  return columns.length ? ` ORDER BY ${quoteIdent(columns[0]!)} ASC` : '';
}

export function requireTable(name: unknown): ViewableTable {
  if (typeof name === 'string' && (VIEWABLE_TABLES as readonly string[]).includes(name)) return name as ViewableTable;
  throw new DatabaseError(`볼 수 없는 테이블입니다: ${String(name)} (가능: ${VIEWABLE_TABLES.join(' · ')})`, 400);
}

function requireColumn(columns: string[], name: unknown, table: string, masked: readonly string[]): string {
  if (typeof name !== 'string' || !columns.includes(name)) {
    throw new DatabaseError(`${table} 에 없는 열입니다: ${String(name)}`, 400);
  }
  if (masked.includes(name)) {
    throw new DatabaseError(`${table}.${name} 은 가려진 열이라 검색·정렬에 쓸 수 없습니다`, 400);
  }
  return name;
}

/**
 * 식별자를 큰따옴표로 감싼다. 여기 오는 값은 이미 화이트리스트를 지났지만,
 * `PRAGMA table_info` 에 넘기는 이름처럼 대조 **전에** 쓰이는 자리가 있어 인용이 필요하다.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function clampInt(value: unknown, fallback: number, low: number, high: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(high, Math.max(low, Math.floor(n)));
}
