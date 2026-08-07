import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { UNIMPLEMENTED, findSimMethod } from '../src/sim/simCatalog.js';

/**
 * 시뮬레이터 툴 화면의 **배선 검사**.
 *
 * 브라우저 없이 잡을 수 있는 실패 둘을 본다.
 *   ① 스크립트가 찾는 id 가 HTML 에 없다 → 모듈 로딩이 멈춰 **다섯 탭이 통째로 죽는다**
 *   ② 화면이 부르는 RPC 가 카탈로그에 없다 → 프록시가 400 으로 거절한다
 */

const read = (name: string) => readFile(new URL(`../web/${name}`, import.meta.url), 'utf8');

const PANELS = ['simtool.js', 'simtoolPreset.js', 'simtoolCar.js', 'simtoolCam.js', 'simtoolMeasure.js'];

const requiredIds = (script: string): string[] =>
  [...script.matchAll(/\bel\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]!);

const declaredIds = (html: string): Set<string> =>
  new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!));

/** 화면이 실제로 부르는 RPC 이름. `ctx.rpc('x.y')` · `rpc('x.y')` 둘 다 잡는다. */
const calledMethods = (script: string): string[] =>
  [...script.matchAll(/\brpc\(\s*'([a-z]+\.[A-Za-z]+)'/g)].map((m) => m[1]!);

describe('시뮬레이터 툴 화면', () => {
  it.each(PANELS)('%s 가 찾는 id 가 전부 simtool.html 에 있다', async (script) => {
    const [html, source] = await Promise.all([read('simtool.html'), read(script)]);
    const missing = [...new Set(requiredIds(source))].filter((id) => !declaredIds(html).has(id));
    expect(missing).toEqual([]);
  });

  it('탭 다섯이 있고 첫 탭만 열려 있다', async () => {
    const html = await read('simtool.html');
    expect(html).toContain('<nav class="tabs" id="simTabs">');
    expect(html).toContain('data-panel="panelPreset" class="active"');
    for (const panel of ['panelCar', 'panelCam', 'panelMeasure', 'panelLight']) {
      expect(html).toContain(`<div id="${panel}" hidden>`);
    }
  });

  /** 카탈로그 밖은 프록시가 400 으로 거절한다 — 화면이 먼저 어긋나 있으면 눌러야 안다. */
  it('화면이 부르는 RPC 가 전부 카탈로그에 있다', async () => {
    const unknown: string[] = [];
    for (const script of PANELS) {
      for (const method of calledMethods(await read(script))) {
        if (!findSimMethod(method)) unknown.push(`${script} → ${method}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  /**
   * `system.catalog` 는 **등록 여부만** 알려주므로 등록됐지만 죽은 10개를 구분하지 못한다.
   * 화면이 그중 하나를 부르면 눌러 봐야 실패를 안다 — 여기서 미리 막는다.
   */
  it('등록만 되고 동작하지 않는 메서드를 화면이 부르지 않는다', async () => {
    const dead = new Set(UNIMPLEMENTED.map((entry) => entry.method));
    expect(dead.size).toBeGreaterThanOrEqual(8);
    const offences: string[] = [];
    for (const script of PANELS) {
      for (const method of calledMethods(await read(script))) {
        if (dead.has(method)) offences.push(`${script} → ${method}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('스캔이 실제로 RPC 호출을 찾았다', async () => {
    const all = (await Promise.all(PANELS.map(read))).flatMap(calledMethods);
    expect(new Set(all).size).toBeGreaterThan(15);
  });
});

describe('시뮬레이터 툴의 독립', () => {
  /**
   * 지시 7. 화면이 `/api/cameras` 나 `/api/core/*` 를 부르는 순간, 카메라 설정이 깨지면
   * 시뮬레이터 툴도 같이 죽는다 — 시뮬레이터는 카메라와 아무 상관이 없는데도.
   */
  it('카메라·코어·DB API 를 부르지 않는다', async () => {
    for (const script of PANELS) {
      const source = await read(script);
      for (const forbidden of ['api.cameras', 'api.coreCapabilities', 'api.dbCameras', '/api/core/', '/api/ptz']) {
        expect(source, `${script} → ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  /**
   * 표면은 **다섯**이고 전부 `/api/sim/*` 이다:
   *   simCatalog     허용 메서드 목록
   *   simCarCatalog  차량 프리팹 이름 (시뮬레이터가 안 준다 — config/car_catalog.json)
   *   simFiles·simFile  저장 파일 목록·내용 (preset.list 가 실체를 안 보여 준다)
   *   simRpc         RPC 호출
   *
   * 여섯째가 생기면 그때는 경계가 새고 있는지 다시 봐야 한다. **중요한 것은 개수가 아니라
   * 전부 `/api/sim/` 이라는 것**이다 — 카메라·코어 경로가 하나라도 섞이면 독립이 깨진다.
   */
  it('시뮬툴 API 표면은 전부 /api/sim/* 이다', async () => {
    const api = await read('api.js');
    const block = api.slice(api.indexOf('시뮬레이터 툴'), api.indexOf('settings:'));
    const surface = [...block.matchAll(/^\s{2}(sim\w+):/gm)].map((m) => m[1]);
    expect(surface).toEqual(['simCatalog', 'simCarCatalog', 'simFiles', 'simFile', 'simRpc']);
    // 이 블록 안의 모든 경로가 /api/sim/ 으로 시작해야 한다.
    for (const path of [...block.matchAll(/'(\/api\/[^'`]*)/g)].map((m) => m[1])) {
      expect(path, path).toMatch(/^\/api\/sim\//);
    }
    for (const path of [...block.matchAll(/`(\/api\/[^'`]*)/g)].map((m) => m[1])) {
      expect(path, path).toMatch(/^\/api\/sim\//);
    }
  });

  /** 드라이버 계층은 ×100 정수 raw, 시뮬툴은 도·배율. 두 곳에서 환산하면 갈린다. */
  it('PTZ 단위를 환산하지 않는다', async () => {
    for (const script of PANELS) {
      const source = (await read(script)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(source, script).not.toMatch(/[*/]\s*100\b/);
    }
  });
});

describe('없는 기능을 흉내 내지 않는다', () => {
  /**
   * 부를 곳이 없는 입력칸을 그려 두면 값을 넣고 「적용」을 눌러도 아무 일이 안 일어나는데
   * 사용자는 적용됐다고 믿는다. 조명 탭은 **안내만** 있고 조작 요소가 없다.
   */
  it('조명 탭에는 조작 요소가 없고 미구현 사유가 적혀 있다', async () => {
    const html = await read('simtool.html');
    const panel = html.slice(html.indexOf('id="panelLight"'), html.indexOf('parking-view'));
    expect(panel).toContain('미등록 method: light.get');
    expect(panel).not.toMatch(/<input|<select/);
  });

  it('main 카메라 스트림이 아직 없다는 사실을 화면이 말한다', async () => {
    const html = await read('simtool.html');
    expect(html).toContain('main 카메라」 스트림은 아직 없습니다');
    expect(html).toContain('view.');
  });

  it('클릭 피킹이 없다는 사실을 두 탭이 말한다', async () => {
    const html = await read('simtool.html');
    expect(html.match(/view\.pick/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('프리셋 메이커 — 파일이 목록의 출처다', () => {
  /**
   * 시뮬레이터의 `preset.list` 는 RPC 가 만든 것만 보여 준다(위젯이 그린 배치는 안 보인다).
   * 실체는 `save/3D/Preset` 의 저장 파일에 있다.
   */
  it('목록을 저장 파일에서 읽는다 — preset.list 로 채우지 않는다', async () => {
    const script = await read('simtoolPreset.js');
    expect(script).toContain("ctx.file('preset'");
    expect(script).toContain("ctx.files('preset')");
    expect(script).not.toContain("rpc('preset.list')");
  });

  /**
   * `preset.*` 호출은 시뮬레이터 UI 로 그린 주차면을 지운다. 사람이 모르고 누르면
   * 작업물을 잃는다 — 탭에 배너를 두고 쓰기에는 확인을 받는다(마스터 결정 2026-08-07).
   */
  it('탭에 경고 배너가 있고 위험한 쓰기에 확인을 받는다', async () => {
    const html = await read('simtool.html');
    expect(html).toContain('id="spDanger"');
    expect(html).toMatch(/시뮬레이터 UI 로 그린 주차면을 지웁니다/);

    const script = await read('simtoolPreset.js');
    // 시뮬레이터 상태를 지우는 셋은 전부 confirm 을 거친다.
    for (const marker of ['spPush', 'spClear', 'spSimLoad']) {
      const handler = script.slice(script.indexOf(`el('${marker}')`));
      expect(handler.slice(0, 600), marker).toContain('confirm(');
    }
  });

  /** 편집의 정본은 파일과 시뮬레이터 UI 다 — 화면에서 고치게 두면 어느 쪽이 맞는지 모른다. */
  it('상세는 읽기 전용이다', async () => {
    const html = await read('simtool.html');
    for (const id of ['spOffsetX', 'spOffsetY', 'spOffsetZ']) {
      expect(html, id).toMatch(new RegExp(`id="${id}"[^>]*readonly`));
    }
    expect(await read('simtoolPreset.js')).not.toContain("rpc('preset.update'");
  });

  /** 하나가 실패해도 멈추지 않는다 — 멈추면 시뮬레이터가 **반쯤 지워진** 상태로 남는다. */
  it('보내기는 실패한 건을 모아 끝에 보고한다', async () => {
    const script = await read('simtoolPreset.js');
    const push = script.slice(script.indexOf('async function push('));
    expect(push).toContain('failed.push');
    expect(push).toContain('sent.length');
  });
});
