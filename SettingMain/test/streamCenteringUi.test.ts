import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function source(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), 'utf8');
}

function expectCompletedCenterMarker(js: string, handlerName: string, markerId: string): void {
  const handler = js.slice(js.indexOf(`async function ${handlerName}`));
  const marker = `$('${markerId}')`;
  expect(handler).toContain(`const marker = ${marker};`);
  const hiddenAtStart = handler.indexOf('marker.hidden = true;');
  const request = handler.indexOf('await api');
  const centeredLeft = handler.indexOf("marker.style.left = '50%';");
  const centeredTop = handler.indexOf("marker.style.top = '50%';");
  const shown = handler.indexOf('marker.hidden = false;');

  expect(hiddenAtStart).toBeGreaterThanOrEqual(0);
  expect(request).toBeGreaterThan(hiddenAtStart);
  expect(centeredLeft).toBeGreaterThan(request);
  expect(centeredTop).toBeGreaterThan(centeredLeft);
  expect(shown).toBeGreaterThan(centeredTop);
}

describe('영상 센터링 완료 원 위치', () => {
  it('카메라 제어는 성공한 클릭 대상 원을 화면 중앙에 표시한다', async () => {
    expectCompletedCenterMarker(await source('../web/control.js'), 'onStreamCenter', 'streamClickMarker');
  });

  it('주차면 탐색은 성공한 클릭 대상 원을 화면 중앙에 표시한다', async () => {
    expectCompletedCenterMarker(await source('../web/discovery.js'), 'centerStreamClick', 'discoveryStreamClickMarker');
  });
});
