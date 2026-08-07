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

const PANELS = ['simtool.js', 'simtoolPreset.js', 'simtoolCar.js', 'simtoolCam.js', 'simtoolMeasure.js', 'simtoolOpen.js'];

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
   *   simParseFile·simSerializePresets  PC 파일 해석·저장 — **브라우저가 축을 만지지 않는다**
   *   simRpc         RPC 호출
   *
   * 여섯째가 생기면 그때는 경계가 새고 있는지 다시 봐야 한다. **중요한 것은 개수가 아니라
   * 전부 `/api/sim/` 이라는 것**이다 — 카메라·코어 경로가 하나라도 섞이면 독립이 깨진다.
   */
  it('시뮬툴 API 표면은 전부 /api/sim/* 이다', async () => {
    const api = await read('api.js');
    const block = api.slice(api.indexOf('시뮬레이터 툴'), api.indexOf('settings:'));
    const surface = [...block.matchAll(/^\s{2}(sim\w+):/gm)].map((m) => m[1]);
    expect(surface).toEqual(['simCatalog', 'simCarCatalog', 'simFiles', 'simFile', 'simParseFile', 'simSerializePresets', 'simRpc']);
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

describe('프리셋 메이커', () => {
  /**
   * 시뮬레이터의 `preset.list` 는 RPC 가 만든 것만 보여 준다(위젯이 그린 배치는 안 보인다).
   * 목록은 사람이 「새로 만들기」로 짓거나 「열기…」로 PC 파일에서 읽는다.
   */
  it('목록을 preset.list 로 채우지 않는다', async () => {
    const script = await read('simtoolPreset.js');
    expect(script).not.toContain("rpc('preset.list')");
    expect(script).toContain('wireOpenDialog');
  });

  /** 지시: "새롭게 처음부터 시작할 수도 있어야 한다." */
  it('빈 목록에서 시작할 수 있고, 저장 안 한 편집을 버리기 전에 묻는다', async () => {
    expect(await read('simtool.html')).toContain('id="spNew"');
    const script = await read('simtoolPreset.js');
    expect(script).toContain('confirmDiscard');
    const handler = script.slice(script.indexOf("el('spNew')"));
    expect(handler.slice(0, 300)).toContain('confirmDiscard');
  });

  it('열기·저장 버튼이 둘 다 있다', async () => {
    const html = await read('simtool.html');
    for (const id of ['spOpen', 'spSave']) expect(html).toContain(`id="${id}"`);
    expect(await read('simtoolPreset.js')).toContain('wireSaveDialog');
  });

  /** 빈 목록에서 손으로 채우려면 편집이 열려 있어야 한다. */
  it('상세가 편집 가능하고 추가·수정·삭제가 있다', async () => {
    const html = await read('simtool.html');
    for (const id of ['spOffsetX', 'spOffsetY', 'spOffsetZ', 'spIdx']) {
      expect(html, id).not.toMatch(new RegExp(`id="${id}"[^>]*readonly`));
    }
    for (const id of ['spAdd', 'spUpdate', 'spDelete']) expect(html).toContain(`id="${id}"`);
  });

  /** 같은 번호가 둘이면 어느 것을 고쳤는지 알 수 없다. */
  it('번호가 겹치면 추가를 거절한다', async () => {
    const script = await read('simtoolPreset.js');
    const handler = script.slice(script.indexOf("el('spAdd')"));
    expect(handler.slice(0, 700)).toContain('이미 있는 번호입니다');
  });

  /**
   * 편집(이 화면)·파일·시뮬레이터가 서로 다른 것을 들고 있다. 어느 것을 건드리는지
   * 화면이 말하지 않으면 사람이 잃는다.
   */
  it('편집이 파일·시뮬레이터를 건드리지 않는다고 화면이 말한다', async () => {
    const html = await read('simtool.html');
    expect(html).toMatch(/이 화면의 목록만.*파일도 시뮬레이터도/s);
  });

  it('탭에 경고 배너가 있고 위험한 쓰기에 확인을 받는다', async () => {
    const html = await read('simtool.html');
    expect(html).toContain('id="spDanger"');
    expect(html).toMatch(/시뮬레이터 UI 로 그린 주차면을 지웁니다/);

    const script = await read('simtoolPreset.js');
    for (const marker of ['spPush', 'spClear', 'spSimLoad']) {
      const handler = script.slice(script.indexOf(`el('${marker}')`));
      expect(handler.slice(0, 700), marker).toContain('confirm(');
    }
  });

  /** 하나가 실패해도 멈추지 않는다 — 멈추면 시뮬레이터가 **반쯤 지워진** 상태로 남는다. */
  it('보내기는 실패한 건을 모아 끝에 보고한다', async () => {
    const push = (await read('simtoolPreset.js'));
    const body = push.slice(push.indexOf('async function push('));
    expect(body).toContain('failed.push');
    expect(body).toContain('sent.length');
  });

  /**
   * 저장은 파일 모양(Unity 좌표)으로 되돌려야 한다. **브라우저가 축을 만지면** 읽기와
   * 쓰기의 규약이 갈려, 열었다 저장한 것만으로 배치가 틀어진다.
   */
  it('저장 시 축 변환을 서버에 맡긴다', async () => {
    const script = await read('simtoolPreset.js');
    expect(script).toContain('ctx.serializePresets(presets)');
    expect(script).not.toContain('offsetPos');
  });

  /** 파일·편집은 이 PC 안에서 끝난다 — 시뮬레이터가 꺼져 있다고 막을 이유가 없다. */
  it('시뮬레이터 연결 없이도 새로 만들기·열기·저장·편집이 열려 있다', async () => {
    const shell = await read('simtool.js');
    expect(shell).toContain('OFFLINE_OK');
    for (const id of ['spNew', 'spOpen', 'spSave', 'spAdd', 'spUpdate', 'spDelete']) {
      expect(shell, id).toContain(`'${id}'`);
    }
  });
});

describe('「열기…」 — 이 PC 의 파일', () => {
  it('두 탭에 파일 대화상자가 있고 버튼이 그것을 연다', async () => {
    const html = await read('simtool.html');
    for (const id of ['spOpenInput', 'carOpenInput']) {
      expect(html, id).toMatch(new RegExp(`id="${id}" type="file" accept="[^"]*json`));
    }
    for (const id of ['spOpen', 'carOpen']) expect(html).toContain(`id="${id}"`);
    expect(await read('simtoolOpen.js')).toContain('input.click()');
  });

  /**
   * 브라우저가 해석하면 저장 폴더 경로와 업로드 경로가 **서로 다른 해석기**를 갖게 되고,
   * 축 규약(Unity Y-up ↔ 언리얼 Z-up)이 두 벌이 된다. 그 실패는 오류로 뜨지 않는다.
   */
  it('해석·좌표변환을 브라우저에서 하지 않는다 — 서버로 넘긴다', async () => {
    const script = await read('simtoolOpen.js');
    // 브라우저가 하는 것은 BOM 제거와 JSON.parse 뿐이다.
    expect(script).toContain('JSON.parse(text.replace(');
    expect(script).toContain('parse(kind, fileName, data)');
    // 축을 만지는 흔적이 있으면 안 된다.
    expect(script).not.toMatch(/offsetPos|fileToRpc|z:\s*\w+\.y/);
  });

  /**
   * `<input type="file">` 은 같은 파일을 다시 고르면 `change` 가 안 난다(값이 그대로다).
   * 비우지 않으면 "파일을 고쳤는데 화면이 그대로"가 된다.
   */
  it('같은 파일을 다시 열 수 있게 값을 비운다', async () => {
    const script = await read('simtoolOpen.js');
    const handler = script.slice(script.indexOf("input.addEventListener('change'"));
    // 읽기 전에 비운다 — 아래에서 던지더라도 다음 선택이 살아 있어야 한다.
    expect(handler.indexOf("input.value = ''")).toBeLessThan(handler.indexOf('file.text()'));
  });

  /** 차량 탭은 폴더 드롭다운을 함께 쓰므로, PC 파일을 열면 그 선택을 풀어야 한다. */
  it('차량 탭은 PC 파일을 열면 폴더 선택을 푼다 — 이름이 섞이면 엉뚱한 곳에 저장된다', async () => {
    const source = await read('simtoolCar.js');
    const onLoad = source.slice(source.indexOf('onLoad: (result, fileName)'));
    expect(onLoad.slice(0, 500)).toMatch(/el\('carFile'\)\.value = ''/);
    expect(onLoad.slice(0, 500)).toContain('내 PC');
  });

  /** 되돌릴 수 없는 동작이다 — 무엇을 보내는지 모르고 누르면 안 된다. */
  it('보내기 확인 문구가 출처를 밝힌다', async () => {
    const preset = await read('simtoolPreset.js');
    expect(preset.slice(preset.indexOf('async function push('), preset.indexOf('async function push(') + 800)).toContain('${origin}');
    const car = await read('simtoolCar.js');
    expect(car.slice(car.indexOf('async function push('), car.indexOf('async function push(') + 800)).toContain('${source}');
  });

  /**
   * 브라우저는 대화상자의 시작 폴더를 임의 경로로 **지정할 수 없다**(보안 제한).
   * 할 수 있는 것은 파일명 제안과 `id` 로 마지막 폴더 기억뿐 — 화면이 그 사실을 말한다.
   */
  it('시작 폴더를 지정할 수 없다는 사실과 표준 위치를 화면이 말한다', async () => {
    const html = await read('simtool.html');
    expect(html).toContain('SettingMain/save/3D/Preset');
    expect(html).toMatch(/시작 폴더를 지정할 수 없습니다/);
    const script = await read('simtoolOpen.js');
    expect(script).toContain('id: `sim-${kind}`');
    expect(script).toContain('suggestedName');
  });
});
