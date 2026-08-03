import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function source(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), 'utf8');
}

describe('주차면 탐색 영상 클릭 센터링 UI 계약', () => {
  it('고정 중앙 십자와 마지막 클릭 원을 영상 viewport에 둔다', async () => {
    const html = await source('../web/discovery.html');
    expect(html).toContain('id="discoveryStreamViewport"');
    expect(html).toContain('class="stream-center-cross"');
    expect(html).toContain('id="discoveryStreamClickMarker"');
  });

  it('왼쪽 클릭은 구현과 무관하게 단일 코어 센터링 경로로 간다', async () => {
    const js = await source('../web/discovery.js');
    expect(js).toContain("import { streamPointFromPointer } from './streamCentering.js';");
    expect(js).toContain("$('discoveryStreamViewport').addEventListener('mousedown'");
    // 화면이 구현을 고르던 흔적이 남아 있으면 안 된다.
    expect(js).not.toContain('useBackendCore');
    expect(js).not.toContain('independent-core');
    expect(js).toContain("api('/api/core/center'");
  });

  it('영상 위에 커서 십자를 강제하지 않는다', async () => {
    const css = await source('../web/app.css');
    expect(css).not.toContain('.viewport:has(img.live) { cursor: crosshair; }');
    expect(css).toContain('.stream-center-cross');
  });
});
