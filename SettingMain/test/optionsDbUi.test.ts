import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ROUTE_CATALOG } from '../src/mcp/routeCatalog.js';

/**
 * 옵션의 DB 탭과 테이블 뷰어의 **화면 규약**. 기존 UI 테스트와 같은 소스 검사 방식이다.
 *
 * 여기서 지키는 것은 셋이다.
 *   ① 접속 정보는 DB 탭에 없다 — 그 주인은 config 이고 「서비스 설정」 탭이 담당한다
 *   ② 화면이 SQL 을 만들지 않는다 — 서버가 준 열 목록으로만 그린다
 *   ③ 새 라우트가 MCP 카탈로그에 등재돼 있다
 */

const source = (relative: string): Promise<string> => readFile(new URL(relative, import.meta.url), 'utf8');

describe('옵션 DB 탭', () => {
  it('네 개의 서브탭이 있고 기본은 서비스 설정이다', async () => {
    const html = await source('../web/options.html');
    for (const panel of ['panelService', 'panelPlace', 'panelCamera', 'panelPreset']) {
      expect(html).toContain(`data-panel="${panel}"`);
      expect(html).toContain(`id="${panel}"`);
    }
    // 서비스 패널만 열려 있다 — 나머지는 hidden 으로 시작한다.
    expect(html).toMatch(/id="panelPlace" hidden/);
    expect(html).toMatch(/id="panelCamera" hidden/);
    expect(html).toMatch(/id="panelPreset" hidden/);
  });

  it('카메라의 전 필드를 이 탭이 보낸다 — 정본이 camera_info 이므로 접속 정보도 여기서 고친다', async () => {
    const js = await source('../web/optionsDb.js');
    for (const key of ['cam_name', 'kind', 'cam_type', 'url', 'user_id', 'rtsp_url', 'place_id', 'timeout_ms', 'park3d_cam_id', 'intrinsics']) {
      expect(js, `${key} 를 보내야 한다`).toContain(`${key}:`);
    }
    // 비밀번호는 **입력했을 때만** 보낸다 — 빈 값을 보내면 기존 자격증명을 지울 위험이 있다.
    expect(js).toContain("else if (password) patch.password = password;");
  });

  /**
   * v4 — 제조사 칸은 화면에서도 사라졌다. **js·html 을 함께 본다**: 한쪽만 지우면
   * 「입력칸은 있는데 `draft()` 가 안 보내는」(또는 그 반대의) 어긋난 상태가 되고,
   * 그때 사람은 값을 적고 저장했는데 아무 일도 일어나지 않는 화면을 보게 된다.
   */
  it('제조사 칸이 화면 어디에도 없다 — optionsDb.js 와 options.html 양쪽', async () => {
    expect(await source('../web/optionsDb.js')).not.toContain('cam_company');
    const html = await source('../web/options.html');
    expect(html).not.toContain('camCompany');
    expect(html).not.toContain('cam_company');
  });

  it('저장된 비밀번호는 **** 로만 보이고 값은 되돌아오지 않는다', async () => {
    const js = await source('../web/optionsDb.js');
    expect(js).toContain("$('camPassword').placeholder = camera?.hasPassword ? '****' : '(없음)'");
    // 별표를 **값**으로 채우면 저장할 때 그 별표가 그대로 비밀번호가 된다.
    expect(js).not.toMatch(/camPassword'\)\.value\s*=\s*'\*/);
    expect(js).toContain("$('camPassword').value = '';");
  });

  it('비밀번호를 지울 길이 있다 — 빈 문자열로는 그 뜻을 낼 수 없다', async () => {
    const html = await source('../web/options.html');
    expect(html).toContain('id="camPasswordClear"');
    const js = await source('../web/optionsDb.js');
    expect(js).toContain("if ($('camPasswordClear').checked) patch.password = null;");
  });

  it('프리셋 표는 preset_id · cam_id 순이고 둘 다 고칠 수 있다', async () => {
    const html = await source('../web/options.html');
    const head = html.slice(html.indexOf('id="dbPresetTable"'));
    expect(head.indexOf('preset_id')).toBeLessThan(head.indexOf('cam_id'));

    const js = await source('../web/optionsDb.js');
    // 열쇠 둘을 실제로 보낸다 — 읽기 전용 td 였다면 이 문자열이 없다.
    expect(js).toContain('save({ preset_id: Number(value) })');
    expect(js).toContain('save({ cam_id: Number(value) })');
    // 그리는 순서도 머리와 같아야 한다.
    const body = js.slice(js.indexOf('async function loadPresets'));
    expect(body.indexOf('preset_id: Number(value)')).toBeLessThan(body.indexOf('cam_id: Number(value)'));
  });

  it('기기 편집은 카메라 탭 하나로 합쳐졌다 — 편집 화면이 두 곳이면 어느 쪽이 이겼는지 알 수 없다', async () => {
    const html = await source('../web/options.html');
    // 옛 「기기」·「기기 편집」 카드는 사라졌다.
    expect(html).not.toContain('id="editCard"');
    expect(html).not.toContain('id="fieldControlUrl"');
    // 그 기능은 카메라 탭에 있다 — 접속 정보·연결 테스트·활성 전환·추가·삭제.
    for (const id of ['camUrl', 'camUser', 'camPassword', 'camRtsp', 'camTest', 'camActivate', 'camAdd', 'camDelete']) {
      expect(html).toContain(`id="${id}"`);
    }
    // 서비스 설정 탭에는 코어 구현과 BackendCore 주소만 남는다.
    expect(html).toContain('id="coreProvider"');
    expect(html).toContain('id="simulatorUrl"');
  });
});

describe('DB 테이블 뷰어', () => {
  it('테이블 콤보·텍스트·기간·조건 검색 칸이 있다', async () => {
    const html = await source('../web/dbtable.html');
    for (const id of ['tableSelect', 'searchText', 'searchColumn', 'fromDate', 'toDate', 'condColumn', 'condOp', 'condValue']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('열 목록을 화면이 지어내지 않는다 — 서버가 준 것으로 그린다', async () => {
    const js = await source('../web/dbtable.js');
    expect(js).toContain('api.dbTables()');
    expect(js).toContain('table.columns');
    // SQL 조각이 화면에 없다. `SELECT\s` 만 보면 `<select>` 변수에 걸리므로 **문장 모양**으로 찾는다.
    expect(js).not.toMatch(/SELECT\s+[\w*]+\s+FROM/i);
    expect(js).not.toMatch(/\bFROM\s+\w+\s+WHERE\b/i);
    expect(js).not.toMatch(/\bDROP\s+TABLE\b|\bINSERT\s+INTO\b/i);
  });

  it('시간 열이 없는 테이블에서는 기간 입력을 잠근다 — 조용히 무시하지 않는다', async () => {
    const js = await source('../web/dbtable.js');
    expect(js).toContain('table.timeColumn');
    expect(js).toContain('disabled = !hasTime');
  });

  it('읽기 전용임을 화면이 말한다', async () => {
    expect(await source('../web/dbtable.html')).toMatch(/읽기 전용/);
  });

  it('모든 화면에서 뷰어로 갈 수 있다', async () => {
    for (const page of ['options.html', 'index.html', 'parking.html', 'dbtable.html']) {
      expect(await source(`../web/${page}`)).toContain('href="/dbtable"');
    }
  });
});

describe('어두운 테마를 따른다', () => {
  /**
   * 실제로 겪은 결함의 회귀 방지 — 탭에 밝은 배경(`#f2f4f7`·`#fff`)을 박아 넣었더니
   * 글자색은 전역 `button` 규칙의 밝은 `--text` 를 그대로 물려받아 **밝은 글자 위 밝은 배경**이
   * 되어 탭 이름이 보이지 않았다. 색은 팔레트 변수에서만 온다.
   */
  it('탭·표 스타일에 밝은 색을 박아 넣지 않는다', async () => {
    const css = await source('../web/app.css');
    const block = css.slice(css.indexOf('옵션 서브탭'));
    expect(block.length).toBeGreaterThan(500);   // 블록을 실제로 찾았다는 확인
    // 16진 색상 리터럴이 하나도 없어야 한다(투명도 있는 겹침만 rgba 로 허용).
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('배경을 지정한 곳은 글자색도 함께 정한다 — 둘 중 하나만 바꾸면 대비가 무너진다', async () => {
    const css = await source('../web/app.css');
    for (const selector of ['.tabs button', '.tabs button.active', 'table.grid th']) {
      const rule = css.slice(css.indexOf(`${selector} {`));
      const body = rule.slice(0, rule.indexOf('}'));
      expect(body, `${selector} 에 background 가 있으면 color 도 있어야 한다`).toMatch(/color:/);
    }
  });
});

describe('새 라우트가 카탈로그에 있다', () => {
  it.each([
    ['GET', '/api/db/tables'],
    ['POST', '/api/db/query'],
    ['GET', '/api/db/places'],
    ['POST', '/api/db/places'],
    ['DELETE', '/api/db/places/:id'],
    ['GET', '/api/db/cameras'],
    ['PUT', '/api/db/cameras/:id'],
    ['GET', '/api/db/presets'],
    ['POST', '/api/db/presets'],
    ['DELETE', '/api/db/presets/:camId/:presetId'],
  ])('%s %s', (method, path) => {
    expect(ROUTE_CATALOG.some((entry) => entry.method === method && entry.path === path)).toBe(true);
  });

  it('DB 라우트는 카메라를 움직이지 않는다', () => {
    const moving = ROUTE_CATALOG.filter((entry) => entry.path.startsWith('/api/db/') && entry.movesCamera);
    expect(moving).toEqual([]);
  });
});
