import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * 주차면 페이지의 **배선 검사**.
 *
 * 브라우저를 띄우지 않고도 잡을 수 있는 실패가 하나 있고, 그것이 가장 흔하다:
 * **스크립트가 찾는 id 가 HTML 에 없는 것.** `getElementById` 는 `null` 을 돌려주고
 * `addEventListener` 에서 터지는데, 그 시점에는 모듈 로딩이 통째로 멈춰 **화면이 조용히
 * 아무것도 안 하게 된다** — 콘솔을 열기 전에는 "버튼이 안 먹는다"로만 보인다.
 *
 * 세 화면이 한 페이지의 탭이 되면서 이 검사가 더 중요해졌다: 패널 모듈이 하나라도
 * 로드 중에 터지면 **세 탭이 다 죽는다.**
 */

const read = (name: string) => readFile(new URL(`../web/${name}`, import.meta.url), 'utf8');

/** 스크립트가 `el('x')`·`getElementById('x')` 로 찾는 id 전부. */
function requiredIds(script: string): string[] {
  return [...script.matchAll(/(?:\bel|getElementById)\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]!);
}

function declaredIds(html: string): Set<string> {
  return new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!));
}

const PANEL_SCRIPTS = ['parking.js', 'parkingDiscovery.js', 'parkingCalibration.js', 'parkingVehicleBox.js'];

describe('주차면 페이지', () => {
  it.each(PANEL_SCRIPTS)('%s 가 찾는 id 가 전부 parking.html 에 있다', async (script) => {
    const [html, source] = await Promise.all([read('parking.html'), read(script)]);
    const declared = declaredIds(html);
    const missing = [...new Set(requiredIds(source))].filter((id) => !declared.has(id));
    expect(missing).toEqual([]);
  });

  it('영상 조작 버튼 셋과 뷰포트가 있다', async () => {
    const declared = declaredIds(await read('parking.html'));
    for (const id of ['streamStart', 'streamStop', 'snapshotOnce', 'streamTag', 'viewport']) {
      expect(declared).toContain(id);
    }
  });

  it('카메라 선택은 하나뿐이다 — 탭마다 따로 고르면 어느 카메라인지 잃는다', async () => {
    const html = await read('parking.html');
    expect([...html.matchAll(/id="cameraSelect"/g)]).toHaveLength(1);
    expect([...html.matchAll(/id="stream"/g)]).toHaveLength(1);
  });

  it('공용 영상 뷰어를 쓴다 — 화면마다 다시 짜지 않는다', async () => {
    expect(await read('parking.js')).toContain("from './streamView.js'");
  });

  it('nav 는 다섯 링크다 — 세 커미셔닝 화면이 주차면 탭으로 합쳐졌다', async () => {
    for (const page of ['parking.html', 'index.html', 'options.html', 'dbtable.html']) {
      const html = await read(page);
      expect(html).toContain('href="/parking"');
      expect(html).toContain('href="/simtool"');
      expect(html).not.toContain('href="/discovery"');
      expect(html).not.toContain('href="/calibration"');
      expect(html).not.toContain('href="/vehiclebox"');
    }
  });

  /**
   * 비활성 패널이 계속 폴링하면 20분짜리 스윕 중에 세 배로 두드린다.
   * 껍데기가 `onDeactivate` 를 부르고, 패널은 거기서 타이머를 반드시 끈다.
   */
  it('패널은 비활성일 때 타이머를 끈다', async () => {
    expect(await read('parking.js')).toContain('active?.panel.onDeactivate?.()');
    for (const script of ['parkingDiscovery.js', 'parkingCalibration.js']) {
      const source = await read(script);
      const deactivate = source.slice(source.indexOf('onDeactivate'));
      expect(deactivate).toContain('stopTimer()');
    }
  });
});

describe('캘리브레이션 탭의 규율', () => {
  it('**클릭 센터링을 붙이지 않는다** — 스윕 중 사람이 끼어들면 샘플이 오염된다', async () => {
    const script = await read('parkingCalibration.js');
    expect(script).not.toContain('/api/core/center');
    expect(script).not.toContain('centerPoint');
  });

  it('full 스윕은 확인을 받고 시작한다 — 20분 점유는 확인 없이 시작할 일이 아니다', async () => {
    expect(await read('parkingCalibration.js')).toContain('confirm(');
  });

  it('게이트 미달에 **화면 안의 탈출구**가 있다 — API 에만 두면 우회로가 아니다', async () => {
    expect(await read('parkingCalibration.js')).toContain('그래도 발행');
  });
});

describe('차량 3D 탭의 규율', () => {
  it('흐르는 영상 위에는 선분을 그리지 않는다', async () => {
    const [html, script] = await Promise.all([read('parking.html'), read('parkingVehicleBox.js')]);
    // 스트리밍을 시작하면 오버레이를 비우고, 왜 비었는지 화면이 말한다.
    expect(script).toContain('clearOverlay');
    expect(html).toContain('staleNotice');
  });

  it('검출은 그 프레임에서 멈춘다 — 큐보이드는 한 장의 것이다', async () => {
    expect(await read('parkingVehicleBox.js')).toContain('ctx.view.snapshot()');
  });

  /**
   * 세 탭이 `img#stream` 하나를 나눠 쓴다. 탭을 떠나며 지우지 않으면 **캘리브레이션 스윕
   * 화면 위에 차량 큐보이드가 얹힌 채로** 남고, 그건 어느 탭의 그림도 아니다.
   */
  it('탭을 떠날 때 오버레이를 지운다', async () => {
    const source = await read('parkingVehicleBox.js');
    const deactivate = source.slice(source.indexOf('onDeactivate'));
    expect(deactivate).toContain("drawSegments(el('overlay'), el('stream'), [])");
  });
});

describe('번호판 호밍 화면', () => {
  it('시작 전에 대가를 말하고 확인을 받는다', async () => {
    const script = await read('parkingDiscovery.js');
    expect(script).toContain('confirm(');
    expect(script).toContain('고배율로 돌리며');
  });

  /** 카메라를 못 돌려놨다는 사실을 조용히 넘기면 고배율로 엉뚱한 곳을 보는 채 남는다. */
  it('카메라 미복귀(cameraStranded)를 화면이 말한다', async () => {
    expect(await read('parkingDiscovery.js')).toContain('cameraStranded');
    expect(await read('parking.html')).toContain('id="homeStranded"');
  });

  it('실패 사유마다 처방이 다르다 — 코드별 문구를 갖는다', async () => {
    const script = await read('parkingDiscovery.js');
    for (const code of ['plate_not_found', 'plate_too_small', 'target_ambiguous', 'target_lost', 'detector_error']) {
      expect(script).toContain(code);
    }
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
