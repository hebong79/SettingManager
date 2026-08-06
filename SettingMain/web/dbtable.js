import { api, reportError, toast } from './api.js';

/**
 * 커미셔닝 DB **테이블 뷰어** — 읽기 전용.
 *
 * 화면은 열 이름을 스스로 지어내지 않는다. `GET /api/db/tables` 가 준 목록(서버가
 * `PRAGMA table_info` 로 SQLite 에게 직접 물은 것)으로 콤보와 표 머리를 그린다.
 * 그래서 스키마가 바뀌면 이 파일을 고치지 않아도 화면이 따라온다.
 *
 * 기간 검색은 **시간 열이 있는 테이블에서만** 켜진다. 없는 곳에서 날짜를 받으면
 * 조용히 무시되어 "걸렀는데 왜 다 나오지"가 되므로, 아예 입력칸을 비활성으로 만든다.
 */

const $ = (id) => document.getElementById(id);

let tables = [];
let offset = 0;

const current = () => tables.find((table) => table.name === $('tableSelect').value) ?? null;

/** 값 없는 조건(IS NULL 계열)은 값 칸을 쓰지 않는다. */
const needsValue = () => !['IS NULL', 'IS NOT NULL'].includes($('condOp').value);

function fillColumnSelect(select, columns, allLabel) {
  select.replaceChildren();
  const first = document.createElement('option');
  first.value = '';
  first.textContent = allLabel;
  select.append(first);
  for (const column of columns) {
    const option = document.createElement('option');
    option.value = column;
    option.textContent = column;
    select.append(option);
  }
}

function applyTableChoice() {
  const table = current();
  if (!table) return;
  fillColumnSelect($('searchColumn'), table.columns, '전체');
  fillColumnSelect($('condColumn'), table.columns, '(없음)');

  const hasTime = Boolean(table.timeColumn);
  for (const id of ['fromDate', 'toDate']) $(id).disabled = !hasTime;
  $('timeColumnHint').textContent = hasTime ? ` (${table.timeColumn})` : ' — 이 테이블에는 시간 열이 없습니다';
  $('tableTag').textContent = `${table.columns.length}열${table.readOnly ? ' · 뷰' : ''}`;
  offset = 0;
}

function buildQuery() {
  const table = current();
  const query = { table: table.name, limit: Number($('pageSize').value), offset };

  const text = $('searchText').value.trim();
  if (text) {
    query.text = text;
    if ($('searchColumn').value) query.textColumn = $('searchColumn').value;
  }
  if (table.timeColumn) {
    if ($('fromDate').value) query.from = $('fromDate').value;
    if ($('toDate').value) query.to = $('toDate').value;
  }
  if ($('condColumn').value) {
    const condition = { column: $('condColumn').value, op: $('condOp').value };
    if (needsValue()) condition.value = $('condValue').value;
    query.conditions = [condition];
  }
  return query;
}

/** 셀 하나. `null` 과 빈 문자열은 눈으로 구별돼야 한다 — 둘의 뜻이 다르다. */
function cell(value) {
  const element = document.createElement('td');
  if (value === null || value === undefined) {
    element.textContent = 'NULL';
    element.className = 'muted';
    return element;
  }
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  element.textContent = text;
  element.title = text;
  return element;
}

async function run() {
  const table = current();
  if (!table) return;
  const result = await api.dbQuery(buildQuery());

  const head = document.querySelector('#resultTable thead tr');
  head.replaceChildren();
  for (const column of result.columns) {
    const th = document.createElement('th');
    th.textContent = column;
    head.append(th);
  }

  const body = document.querySelector('#resultTable tbody');
  body.replaceChildren();
  for (const row of result.rows) {
    const tr = document.createElement('tr');
    for (const column of result.columns) tr.append(cell(row[column]));
    body.append(tr);
  }

  $('emptyNote').hidden = result.rows.length > 0;
  $('resultTag').textContent = `${result.total}줄 중 ${result.rows.length}줄`;
  const from = result.total === 0 ? 0 : result.offset + 1;
  $('pageInfo').textContent = `${from} ~ ${result.offset + result.rows.length} / ${result.total}`;
  $('prev').disabled = result.offset <= 0;
  $('next').disabled = result.offset + result.rows.length >= result.total;
}

async function guarded(work) {
  try {
    await work();
  } catch (error) {
    reportError(error);
  }
}

async function main() {
  $('tableSelect').addEventListener('change', () => {
    applyTableChoice();
    void guarded(run);
  });
  $('condOp').addEventListener('change', () => {
    $('condValue').disabled = !needsValue();
  });
  $('search').addEventListener('click', () => {
    offset = 0;
    void guarded(run);
  });
  $('reset').addEventListener('click', () => {
    for (const id of ['searchText', 'fromDate', 'toDate', 'condValue']) $(id).value = '';
    $('searchColumn').value = '';
    $('condColumn').value = '';
    offset = 0;
    void guarded(run);
  });
  $('prev').addEventListener('click', () => {
    offset = Math.max(0, offset - Number($('pageSize').value));
    void guarded(run);
  });
  $('next').addEventListener('click', () => {
    offset += Number($('pageSize').value);
    void guarded(run);
  });

  await guarded(async () => {
    tables = (await api.dbTables()).tables;
    const select = $('tableSelect');
    select.replaceChildren();
    for (const table of tables) {
      const option = document.createElement('option');
      option.value = table.name;
      option.textContent = table.readOnly ? `${table.name} (뷰)` : table.name;
      select.append(option);
    }
    applyTableChoice();
    await run();
    toast(`테이블 ${tables.length}개`, 'ok');
  });
}

void main();
