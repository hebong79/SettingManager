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
   * 표면이 **셋**이다: 허용 목록 · RPC 호출 · 차량 프리팹 이름.
   * 셋째가 있는 이유는 시뮬레이터가 차종 이름을 주지 않아서다(`config/car_catalog.json`).
   * 넷째가 생기면 그때는 경계가 새고 있는지 다시 봐야 한다.
   */
  it('시뮬툴 API 표면은 셋뿐이다 — 늘어나면 경계가 새는 것이다', async () => {
    const api = await read('api.js');
    const block = api.slice(api.indexOf('시뮬레이터 툴'), api.indexOf('settings:'));
    const surface = [...block.matchAll(/^\s{2}(sim\w+):/gm)].map((m) => m[1]);
    expect(surface).toEqual(['simCatalog', 'simCarCatalog', 'simRpc']);
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
