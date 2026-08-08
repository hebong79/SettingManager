import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { UNIMPLEMENTED, findSimMethod } from '../src/sim/simCatalog.js';

/**
 * 시뮬레이터 툴 화면의 **배선 검사**.
 *
 * 브라우저 없이 잡을 수 있는 실패 셋을 본다.
 *   ① 스크립트가 찾는 id 가 HTML 에 없다 → 모듈 로딩이 멈춰 **다섯 탭이 통째로 죽는다**
 *   ② 화면이 부르는 RPC 가 카탈로그에 없거나 **등록만 되고 죽어 있다**
 *   ③ 세 파일 툴의 형태가 어긋난다 (마스터 지시: 모두 같은 형태)
 */

const read = (name: string) => readFile(new URL(`../web/${name}`, import.meta.url), 'utf8');

const PANELS = [
  'simtool.js', 'simtoolPreset.js', 'simtoolCar.js', 'simtoolCam.js',
  'simtoolMeasure.js', 'simtoolOpen.js', 'simtoolFileBar.js',
  'simtoolViewControl.js',
];

/** 세 툴(프리셋·차량·카메라)이 **같은 형태**여야 한다 — 마스터 지시 2026-08-07. */
const FILE_TOOLS = [
  { name: '프리셋 메이커', script: 'simtoolPreset.js', prefix: 'sp', folder: 'Preset' },
  { name: '차량 배치', script: 'simtoolCar.js', prefix: 'car', folder: 'CarPos' },
  { name: '카메라 컨트롤', script: 'simtoolCam.js', prefix: 'k', folder: 'CameraPos' },
];

const requiredIds = (script: string): string[] =>
  [...script.matchAll(/\bel\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]!);

const declaredIds = (html: string): Set<string> =>
  new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!));

/** 화면이 실제로 부르는 RPC 이름. `ctx.rpc('x.y')` · `rpc('x.y')` 둘 다 잡는다. */
const calledMethods = (script: string): string[] =>
  [...script.matchAll(/\brpc\(\s*'([a-z]+\.[A-Za-z]+)'/g)].map((m) => m[1]!);

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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

/**
 * 메인 뷰(자유 시점) 조작. 2026-08-08 언리얼 `view.*` 신설로 열렸다.
 *
 * 브라우저 없이 잡을 수 있는 실패를 본다 — 특히 **낡은 안내가 남는 것**은 오류로 뜨지 않고
 * 사람만 속인다("신설이 필요합니다"를 읽고 되는 기능을 안 쓴다).
 */
describe('메인 뷰 조작', () => {
  it('메인 뷰 클릭은 언리얼에게 맡긴다 — 웹이 기하를 재현하지 않는다', async () => {
    const source = stripComments(await read('simtool.js'));
    expect(source).toContain("rpc('view.pick'");
    // PTZ 경로(/api/sim/pick)는 남아 있어야 한다 — 메인 뷰가 그것을 대체하는 것이 아니다.
    expect(source).toContain('api.simPick(');
  });

  /**
   * 포트를 화면이 조립하면 언리얼이 basePort 를 바꾸는 날 조용히 어긋난다.
   * 메인 뷰 판정은 **시뮬레이터가 준 `view.get.streamPort`** 와 맞춰야 한다.
   */
  it('메인 뷰 포트를 화면에 적어 두지 않는다', async () => {
    const source = stripComments(await read('simtool.js'));
    expect(source).not.toContain('13600');
    expect(source).toContain('mainStreamPort()');
  });

  /**
   * 끌면 회전, 그냥 누르면 클릭 — 누를 때 클릭을 처리하면 **드래그 시작이 매번 클릭**이 된다.
   * 「차량 배치」 모드에서는 그것이 차를 한 대씩 놓는다.
   */
  it('클릭은 누를 때가 아니라 뗄 때 판정한다', async () => {
    const source = stripComments(await read('simtool.js'));
    expect(source).toMatch(/addEventListener\('mouseup'/);
    expect(source).not.toMatch(/'mousedown',\s*\(event\)\s*=>\s*void viewportClick/);
  });

  /** 프레임마다 보내면 시뮬레이터가 밀린다 — 한 번에 하나만 띄우고 마지막 것만 살린다. */
  it('시점 이동은 한 번에 한 요청만 띄운다', async () => {
    const source = stripComments(await read('simtoolViewControl.js'));
    expect(source).toContain('inFlight');
    expect(source).toContain('pending');
  });

  /**
   * 언리얼 `SetFOV` 는 잠금을 건다 — 해제 수단이 없으면 휠을 굴린 사람이 기본 화각으로
   * 못 돌아온다(앱 재기동 전까지). `fov: 0` 이 그 해제다.
   */
  it('화각을 되돌릴 길이 있다', async () => {
    const source = stripComments(await read('simtoolViewControl.js'));
    expect(source).toContain('fov: 0');
    expect(await read('simtool.html')).toContain('id="simViewFovReset"');
  });

  /** `view` 의 pitch 는 양수가 위다(`cam.setTilt` 와 반대) — 아래로 끌면 빼야 한다. */
  it('아래로 끌면 pitch 를 뺀다', async () => {
    expect(stripComments(await read('simtoolViewControl.js'))).toMatch(/pitch:\s*rot\(\)\.pitch\s*-/);
  });

  /**
   * 오른쪽 버튼 팝업이 영상 위에 뜨면, 시점을 끄는 도중이던 사람은 **그 메뉴 위에서 손을
   * 뗀다.** 그러면 `mouseup` 이 화면에 오지 않는다 — 아래 테스트와 한 쌍이다.
   */
  it('영상 위에서는 오른쪽 버튼 팝업을 띄우지 않는다', async () => {
    const source = stripComments(await read('simtool.js'));
    expect(source).toMatch(/addEventListener\('contextmenu'[\s\S]{0,80}preventDefault/);
  });

  /**
   * 팝업·창 밖에서 버튼을 떼면 `mouseup` 을 못 받는다. 그 상태가 남으면 **버튼을 놓았는데도
   * 마우스만 움직이면 시점이 계속 돈다.** 매 이동마다 `buttons` 로 회수한다.
   */
  it('놓친 mouseup 을 회수한다 — 버튼이 떨어져 있으면 회전을 멈춘다', async () => {
    expect(stripComments(await read('simtoolViewControl.js'))).toMatch(/event\.buttons\s*&\s*ROTATE_BUTTONS_BIT/);
  });

  /**
   * 회전은 **오른쪽 버튼**이다(마스터 지시). 왼쪽으로 끌면 브라우저가 `<img>` 를
   * 드래그앤드롭으로 집어 회전이 성립하지 않는다.
   */
  it('회전은 오른쪽 버튼이다', async () => {
    const source = stripComments(await read('simtoolViewControl.js'));
    expect(source).toMatch(/ROTATE_BUTTON\s*=\s*2/);
    expect(source).toMatch(/event\.button\s*!==\s*ROTATE_BUTTON/);
  });

  /** 왼쪽으로 끌 때 브라우저가 영상을 집어 가면 그 자리에서 조작이 끊긴다. */
  it('영상을 브라우저가 끌고 가지 못하게 한다', async () => {
    expect(await read('simtool.html')).toMatch(/id="simStream"[^>]*draggable="false"/);
  });

  /**
   * ⚠ `event.key` 로 보면 **한글 입력 상태에서 WASD 가 통째로 죽는다**('ㅈ'·'ㅁ'·'ㄴ'·'ㅇ').
   * 물리 키 위치인 `event.code` 로 봐야 배치·입력기와 무관하게 동작한다.
   */
  it('WASD 는 자판 배치가 아니라 물리 키 위치로 본다', async () => {
    const source = stripComments(await read('simtoolViewControl.js'));
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) expect(source, code).toContain(code);
    expect(stripComments(await read('simtool.js'))).toContain('event.code');
  });

  /** 좌표를 타이핑하다 'a' 를 눌렀는데 카메라가 옆으로 가면 안 된다. */
  it('입력칸에 글자를 넣는 중에는 WASD 가 카메라를 움직이지 않는다', async () => {
    const source = stripComments(await read('simtool.js'));
    const handler = source.slice(source.indexOf("addEventListener('keydown'"));
    for (const tag of ['INPUT', 'SELECT', 'TEXTAREA']) expect(handler, tag).toContain(tag);
    // 브라우저 단축키(Ctrl+S 등)도 비켜 준다.
    expect(handler).toContain('ctrlKey');
  });

  /** 되는 기능을 「신설이 필요합니다」로 안내하고 있으면 아무도 쓰지 않는다. */
  it('view.* 가 없다던 낡은 안내가 남아 있지 않다', async () => {
    const html = await read('simtool.html');
    expect(html).not.toContain('view.pick</code> 신설이 필요합니다');
  });
});

describe('세 툴이 같은 형태다', () => {
  it.each(FILE_TOOLS)('$name — 새로 만들기·열기…·저장… 이 있다', async ({ prefix }) => {
    const html = await read('simtool.html');
    for (const suffix of ['New', 'Open', 'Save', 'OpenInput', 'Status']) {
      expect(html, `${prefix}${suffix}`).toContain(`id="${prefix}${suffix}"`);
    }
    expect(html).toMatch(new RegExp(`id="${prefix}OpenInput" type="file" accept="[^"]*json`));
  });

  /** 「처음부터」가 성립하려면 손으로 채울 수 있어야 한다. */
  it.each(FILE_TOOLS)('$name — 추가·수정·삭제로 편집한다', async ({ prefix }) => {
    const html = await read('simtool.html');
    for (const suffix of ['Add', 'Update', 'Delete', 'List']) {
      expect(html, `${prefix}${suffix}`).toContain(`id="${prefix}${suffix}"`);
    }
  });

  it.each(FILE_TOOLS)('$name — 표준 위치를 화면이 말한다', async ({ folder }) => {
    expect(await read('simtool.html')).toContain(`SettingMain/save/3D/${folder}`);
  });

  /**
   * 같은 일을 세 벌로 두면 한 곳만 고치는 날이 온다 — 특히 "저장 안 한 편집을 버리기 전에
   * 묻는다" 같은 규율은 빠뜨려도 테스트가 아니면 안 보인다.
   */
  it.each(FILE_TOOLS)('$name — 공용 파일 막대를 쓴다 (세 벌로 두지 않는다)', async ({ script }) => {
    const source = await read(script);
    expect(source).toContain('createFileBar');
    // 파일 대화상자를 직접 배선하지 않는다 — 막대가 한다.
    expect(source).not.toContain('wireOpenDialog');
    expect(source).not.toContain('wireSaveDialog');
  });

  it('공용 막대가 저장 안 한 편집을 지킨다', async () => {
    const bar = await read('simtoolFileBar.js');
    expect(bar).toContain('confirmDiscard');
    // 정의 1 + 새로 만들기 1 + 열기 1.
    expect(bar.match(/confirmDiscard\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(bar).toContain('저장 안 함');
  });

  /**
   * 저장은 파일 모양(Unity 좌표)으로 되돌려야 한다. **브라우저가 축을 만지면** 읽기와
   * 쓰기의 규약이 갈려, 열었다 저장한 것만으로 배치가 틀어진다.
   */
  it('저장 시 축 변환을 서버에 맡긴다', async () => {
    expect(await read('simtoolFileBar.js')).toContain('ctx.serializeFile(');
    for (const { script } of FILE_TOOLS) {
      expect(await read(script), script).not.toContain('offsetPos');
    }
  });

  /** 파일·편집은 이 PC 안에서 끝난다 — 시뮬레이터가 꺼져 있다고 막을 이유가 없다. */
  it('시뮬레이터 연결 없이도 파일·편집이 열려 있다', async () => {
    const shell = await read('simtool.js');
    expect(shell).toContain('OFFLINE_OK');
    for (const { prefix } of FILE_TOOLS) {
      for (const suffix of ['New', 'Open', 'Save', 'Add', 'Update', 'Delete']) {
        expect(shell, `${prefix}${suffix}`).toContain(`'${prefix}${suffix}'`);
      }
    }
  });
});

describe('프리셋 메이커', () => {
  /** `preset.list` 는 RPC 가 만든 것만 보여 준다 — 위젯이 그린 배치가 안 보인다. */
  it('목록을 preset.list 로 채우지 않는다', async () => {
    expect(await read('simtoolPreset.js')).not.toContain("rpc('preset.list')");
  });

  /** 같은 번호가 둘이면 어느 것을 고쳤는지 알 수 없다. */
  it('번호가 겹치면 추가를 거절한다', async () => {
    const script = await read('simtoolPreset.js');
    expect(script.slice(script.indexOf("el('spAdd')"), script.indexOf("el('spAdd')") + 700))
      .toContain('이미 있는 번호입니다');
  });

  it('편집이 파일·시뮬레이터를 건드리지 않는다고 화면이 말한다', async () => {
    expect(await read('simtool.html')).toMatch(/이 화면의 목록만[\s\S]*파일도 시뮬레이터도/);
  });

  it('탭에 경고 배너가 있고 위험한 쓰기에 확인을 받는다', async () => {
    const html = await read('simtool.html');
    expect(html).toContain('id="spDanger"');
    expect(html).toMatch(/시뮬레이터 UI 로 그린 주차면을 지웁니다/);
    const script = await read('simtoolPreset.js');
    for (const marker of ['spPush', 'spClear', 'spSimLoad']) {
      expect(script.slice(script.indexOf(`el('${marker}')`), script.indexOf(`el('${marker}')`) + 700), marker)
        .toContain('confirm(');
    }
  });

  /** 하나가 실패해도 멈추지 않는다 — 멈추면 시뮬레이터가 **반쯤 지워진** 상태로 남는다. */
  it('보내기는 실패한 건을 모아 끝에 보고한다', async () => {
    const body = await read('simtoolPreset.js');
    const push = body.slice(body.indexOf('async function push('));
    expect(push).toContain('failed.push');
    expect(push).toContain('sent.length');
  });
});

describe('카메라 프리셋 — 없는 RPC 를 대신한다', () => {
  /**
   * `cam.applyPreset` 은 등록만 돼 있고 동작하지 않는다(per-camera 프리셋 메모리 없음).
   * 없는 것을 부르는 대신 **자세를 직접 만든다.**
   */
  it('applyPreset 을 부르지 않고 setPosition·setPTZ 로 자세를 만든다', async () => {
    const script = await read('simtoolCam.js');
    expect(script).not.toContain("rpc('cam.applyPreset'");
    const handler = script.slice(script.indexOf("el('kApply')"));
    expect(handler.slice(0, 900)).toContain('cam.setPosition');
    expect(handler.slice(0, 900)).toContain('cam.setPTZ');
  });

  it('프리셋의 정본이 파일이라는 사실을 화면이 말한다', async () => {
    expect(await read('simtool.html')).toMatch(/시뮬레이터에는 카메라 프리셋 개념이 없습니다/);
  });
});

describe('차량 배치', () => {
  /** 「시뮬로 보내기」(목록 → 시뮬)와 「시뮬에 줄 배치」(시뮬 직접)는 다른 것이다. */
  it('시뮬에서 가져오기로 현재 상태를 목록에 담을 수 있다', async () => {
    expect(await read('simtool.html')).toContain('id="carPull"');
    expect(await read('simtoolCar.js')).toContain("rpc('car.list')");
  });

  it('죽은 random.* 을 부르지 않는다', async () => {
    const script = await read('simtoolCar.js');
    for (const dead of ['randomizeAll', 'slotJitter', 'frontBack', 'slotPlace', 'placeInView']) {
      expect(script, dead).not.toContain(`random.${dead}`);
    }
  });
});

describe('시뮬레이터 툴의 독립', () => {
  /**
   * 지시 7. 화면이 `/api/cameras` 나 `/api/core/*` 를 부르는 순간, 카메라 설정이 깨지면
   * 시뮬레이터 툴도 같이 죽는다 — 시뮬레이터는 카메라와 아무 상관이 없는데도.
   */
  it('툴 패널은 카메라·코어·DB API 를 부르지 않는다', async () => {
    // 껍데기(simtool.js)만 예외다 — 아래 항목이 그 예외를 정확히 규정한다.
    for (const script of PANELS.filter((name) => name !== 'simtool.js')) {
      const source = await read(script);
      for (const forbidden of ['api.cameras', 'api.coreCapabilities', 'api.dbCameras', '/api/core/', '/api/ptz']) {
        expect(source, `${script} → ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  /**
   * **예외는 영상 소스 하나뿐이다** (마스터 지시 2026-08-08).
   *
   * 시뮬레이터 메인 카메라가 `simulator-99` 로 `camera_info` 에 등록돼 있고, `cam.list` 는
   * PTZ 카메라(13601+)만 알려주므로 메인 뷰가 RPC 목록에 안 나온다. 그래서 영상 소스만
   * 등록 카메라에서 읽는다.
   *
   * 툴 로직은 여전히 `/api/sim/*` 이다 — 코어(`/api/core/*`)·PTZ·DB 편집은 여전히 금지다.
   */
  it('껍데기의 예외는 영상 소스뿐이다 — 코어·PTZ·DB 는 여전히 금지', async () => {
    const shell = await read('simtool.js');
    expect(shell).toContain('api.cameras()');
    expect(shell).toContain('/api/stream?cameraId=');
    for (const forbidden of ['api.coreCapabilities', 'api.dbCameras', 'api.dbPresets', '/api/core/', '/api/ptz']) {
      expect(shell, forbidden).not.toContain(forbidden);
    }
  });

  /** 시뮬레이터 메인 카메라의 등록 id. 바뀌면 영상 기본 선택이 조용히 엉뚱해진다. */
  it('메인 카메라를 simulator-99 로 알고 기본 선택한다', async () => {
    const shell = await read('simtool.js');
    expect(shell).toContain("MAIN_CAMERA_ID = 'simulator-99'");
    expect(await read('simtool.html')).toContain('simulator-99');
  });

  /** 영상은 시뮬 RPC 와 무관하다 — 연결이 끊겨도 나와야 한다. */
  it('영상 소스를 시뮬 연결보다 먼저 채우고, 연결 실패에 잠그지 않는다', async () => {
    const shell = await read('simtool.js');
    const main = shell.slice(shell.indexOf('async function main('));
    expect(main.indexOf('loadStreamCameras')).toBeLessThan(main.indexOf('connect()'));
    const gate = shell.slice(shell.indexOf('function setPanelsEnabled('));
    expect(gate.slice(0, 900)).toContain("el('simStreamStart').disabled = streaming");
  });

  /**
   * 표면은 전부 `/api/sim/*` 이다. **중요한 것은 개수가 아니라** 카메라·코어 경로가
   * 하나도 섞이지 않는다는 것이다.
   */
  it('시뮬툴 API 표면은 전부 /api/sim/* 이다', async () => {
    const api = await read('api.js');
    const block = api.slice(api.indexOf('시뮬레이터 툴'), api.indexOf('settings:'));
    const surface = [...block.matchAll(/^\s{2}(sim\w+):/gm)].map((m) => m[1]);
    expect(surface).toEqual([
      'simCatalog', 'simCarCatalog', 'simFiles', 'simFile', 'simParseFile', 'simSerialize', 'simRpc', 'simPick',
      'simViewMove',
    ]);
    for (const path of [...block.matchAll(/['`](\/api\/[^'`]*)/g)].map((m) => m[1])) {
      expect(path, path).toMatch(/^\/api\/sim\//);
    }
  });

  /** 드라이버 계층은 ×100 정수 raw, 시뮬툴은 도·배율. 두 곳에서 환산하면 갈린다. */
  it('PTZ 단위를 환산하지 않는다', async () => {
    for (const script of PANELS) {
      expect(stripComments(await read(script)), script).not.toMatch(/[*/]\s*100\b/);
    }
  });
});

/**
 * 영상 클릭(마스터 지시 2026-08-08 "2.3번"). 여기서 지키는 것은 **화면이 기하를 다시
 * 계산하지 않는다**는 것과, **못 하는 경우를 못 한다고 말한다**는 것 둘이다.
 */
describe('영상 클릭', () => {
  it('카메라 기하를 화면에서 다시 계산하지 않는다 — 규칙은 서버 한 곳이다', async () => {
    for (const script of PANELS) {
      const source = stripComments(await read(script));
      // 화각 상수나 삼각함수가 화면에 나타나면 그 순간 규칙이 두 벌이 된다.
      expect(source, script).not.toContain('56.5');
      expect(source, script).not.toMatch(/Math\.(tan|atan2?|cos|sin)\b/);
    }
  });

  it('클릭 계산은 /api/sim/pick 하나로만 간다', async () => {
    const shell = stripComments(await read('simtool.js'));
    expect(shell).toContain('api.simPick(');
    // 껍데기가 자세를 따로 물어 화면에서 계산하기 시작하면 위 규칙이 무너진다.
    expect(shell).not.toContain("'cam.get'");
  });

  it('영상 소스와 시뮬 카메라는 **스트림 포트로** 짝짓는다 — 13600+camId 를 다시 계산하지 않는다', async () => {
    const shell = stripComments(await read('simtool.js'));
    expect(shell).toContain('streamPort');
    expect(shell).not.toMatch(/13600\s*\+/);
  });

  /**
   * 2026-08-08 정정 — 언리얼에 `view.*` 가 신설되어 **메인 뷰에서도 클릭이 된다.**
   * 이 테스트가 지키는 것은 "안내가 지금 사실과 맞는가"다. 자세를 알 수 없는 소스
   * (메인도 PTZ 도 아닌 실카메라 등)에는 여전히 안 된다고 말해야 한다.
   */
  it('클릭이 되는 소스와 안 되는 소스를 갈라 말한다', async () => {
    const shell = await read('simtool.js');
    const note = shell.slice(shell.indexOf('function updateClickNote('), shell.indexOf('function updateViewNote('));
    expect(note).toContain('메인 뷰');
    expect(note).toContain('클릭이 되지 않습니다');
    // 메인 뷰는 라인트레이스라 평면 높이를 쓰지 않는다 — 안 쓰는 칸은 꺼 둔다.
    expect(note).toMatch(/simGroundZ'\)\.disabled\s*=.*main/);
  });

  it('클릭 모드와 지면 높이 입력이 HTML 에 있다', async () => {
    const ids = declaredIds(await read('simtool.html'));
    for (const id of ['simClickMode', 'simGroundZ', 'simClickNote', 'simClickMarker']) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it('클릭으로 배치한 차량은 **목록만** 바꾼다 — 시뮬레이터를 바로 건드리지 않는다', async () => {
    const car = await read('simtoolCar.js');
    const handler = car.slice(car.indexOf('async function viewportClick('), car.indexOf('return {\n    onViewportClick'));
    expect(handler).toContain('bar.markDirty()');
    expect(handler).not.toMatch(/ctx\.rpc\(/);
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

  /**
   * 2026-08-08 정정 — `view.pick` 은 신설되어 **차량 배치 탭에서 실제로 쓴다.**
   * 아직 클릭을 받지 않는 탭(거리 측정)은 그 사실을 그대로 말해야 한다 —
   * "된다"고 적어 두고 눌러도 반응이 없으면 고장으로 읽힌다.
   */
  it('아직 클릭을 받지 않는 탭은 그렇다고 말한다', async () => {
    const html = await read('simtool.html');
    const measure = html.slice(html.indexOf('id="panelMeasure"'), html.indexOf('id="panelLight"'));
    expect(measure).toContain('이 탭은 아직 클릭을 받지 않습니다');
  });
});

describe('「열기…」·「저장…」 — 이 PC 의 파일', () => {
  it('버튼이 파일 대화상자를 연다', async () => {
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
    expect(script).not.toMatch(/offsetPos|fileToRpc/);
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

  it('연 파일의 출처를 상태줄이 밝힌다', async () => {
    expect(await read('simtoolFileBar.js')).toContain('내 PC');
  });

  /** 되돌릴 수 없는 동작이다 — 무엇을 보내는지 모르고 누르면 안 된다. */
  it('보내기 확인 문구가 출처를 밝힌다', async () => {
    for (const script of ['simtoolPreset.js', 'simtoolCar.js']) {
      const source = await read(script);
      const push = source.slice(source.indexOf('async function push('));
      expect(push.slice(0, 800), script).toContain('${bar.origin()}');
    }
  });

  /**
   * 브라우저는 대화상자의 시작 폴더를 임의 경로로 **지정할 수 없다**(보안 제한).
   * 할 수 있는 것은 파일명 제안과 `id` 로 마지막 폴더 기억뿐 — 화면이 그 사실을 말한다.
   */
  it('시작 폴더를 지정할 수 없다는 사실과 표준 위치를 화면이 말한다', async () => {
    expect(await read('simtool.html')).toMatch(/시작 폴더를 지정할 수 없습니다/);
    const script = await read('simtoolOpen.js');
    expect(script).toContain('id: `sim-${kind}`');
    expect(script).toContain('suggestedName');
  });
});
