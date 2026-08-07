import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * 커미셔닝 화면의 **배선 검사**.
 *
 * 브라우저를 띄우지 않고도 잡을 수 있는 실패가 하나 있고, 그것이 가장 흔하다:
 * **스크립트가 찾는 id 가 HTML 에 없는 것.** `getElementById` 는 `null` 을 돌려주고
 * `addEventListener` 에서 터지는데, 그 시점에는 모듈 로딩이 통째로 멈춰 **화면이 조용히
 * 아무것도 안 하게 된다** — 콘솔을 열기 전에는 "버튼이 안 먹는다"로만 보인다.
 */

const read = (name: string) => readFile(new URL(`../web/${name}`, import.meta.url), 'utf8');

/** 스크립트가 `el('x')`·`getElementById('x')` 로 찾는 id 전부. */
function requiredIds(script: string): string[] {
  return [...script.matchAll(/(?:\bel|getElementById)\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]!);
}

function declaredIds(html: string): Set<string> {
  return new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!));
}

describe.each([
  ['캘리브레이션', 'calibration.html', 'calibration.js'],
  ['차량 3D 육면체', 'vehiclebox.html', 'vehiclebox.js'],
])('%s 화면', (_name, htmlFile, jsFile) => {
  it('스크립트가 찾는 id 가 전부 HTML 에 있다', async () => {
    const [html, script] = await Promise.all([read(htmlFile), read(jsFile)]);
    const declared = declaredIds(html);
    const missing = [...new Set(requiredIds(script))].filter((id) => !declared.has(id));
    expect(missing).toEqual([]);
  });

  it('영상 조작 버튼 셋과 뷰포트가 있다', async () => {
    const declared = declaredIds(await read(htmlFile));
    for (const id of ['streamStart', 'streamStop', 'snapshotOnce', 'streamTag', 'viewport']) {
      expect(declared).toContain(id);
    }
  });

  it('카메라 선택이 있다', async () => {
    expect(declaredIds(await read(htmlFile))).toContain('cameraSelect');
  });

  it('공용 영상 뷰어를 쓴다 — 화면마다 다시 짜지 않는다', async () => {
    expect(await read(jsFile)).toContain("from './streamView.js'");
  });

  it('nav 에 두 커미셔닝 화면이 다 있다', async () => {
    const html = await read(htmlFile);
    expect(html).toContain('href="/calibration"');
    expect(html).toContain('href="/vehiclebox"');
  });
});

describe('캘리브레이션 화면의 규율', () => {
  it('**클릭 센터링을 붙이지 않는다** — 스윕 중 사람이 끼어들면 샘플이 오염된다', async () => {
    const script = await read('calibration.js');
    expect(script).not.toContain('/api/core/center');
    expect(script).not.toContain('centerPoint');
  });

  it('full 스윕은 확인을 받고 시작한다 — 20분 점유는 확인 없이 시작할 일이 아니다', async () => {
    expect(await read('calibration.js')).toContain('confirm(');
  });

  it('게이트 미달에 **화면 안의 탈출구**가 있다 — API 에만 두면 우회로가 아니다', async () => {
    expect(await read('calibration.js')).toContain('그래도 발행');
  });
});

describe('차량 3D 화면의 규율', () => {
  it('흐르는 영상 위에는 선분을 그리지 않는다', async () => {
    const [html, script] = await Promise.all([read('vehiclebox.html'), read('vehiclebox.js')]);
    // 스트리밍을 시작하면 오버레이를 비우고, 왜 비었는지 화면이 말한다.
    expect(script).toContain('clearOverlay');
    expect(html).toContain('staleNotice');
  });

  it('검출은 그 프레임에서 멈춘다 — 큐보이드는 한 장의 것이다', async () => {
    expect(await read('vehiclebox.js')).toContain('view.snapshot()');
  });
});

describe('영상 뷰어 공용 모듈', () => {
  it('자동으로 시작하지 않는다 — 화면을 열었다는 이유만으로 카메라를 쓰지 않는다', async () => {
    const script = await read('streamView.js');
    // 생성 시점에 `show(...)` 를 부르는 자리가 없어야 한다.
    expect(/setControls\(\);\s*return \{/.test(script)).toBe(true);
    expect(script).not.toMatch(/^\s*show\('stream'\);\s*$/m);
  });

  it('스냅샷 전에 스트림을 먼저 끊는다 — 살아 있는 MJPEG 위에 덮어쓰면 안 된다', async () => {
    const script = await read('streamView.js');
    const show = script.slice(script.indexOf('function show('));
    expect(show.indexOf('stop();')).toBeLessThan(show.indexOf('image.src'));
  });
});
