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
    expect(html).toContain('id="useBackendCore"');
  });

  it('BackendCore 선택에 따라 왼쪽 클릭을 BackendCore 또는 선택 카메라 센터링 endpoint로 보낸다', async () => {
    const js = await source('../web/discovery.js');
    expect(js).toContain("import { streamPointFromPointer } from './streamCentering.js';");
    expect(js).toContain("$('discoveryStreamViewport').addEventListener('mousedown'");
    expect(js).toContain("$('useBackendCore').checked");
    expect(js).toContain("useBackendCore=1");
    expect(js).toContain("const useBackendCore=$('useBackendCore').checked;");
    expect(js).toContain("const path = useBackendCore ? '/api/center' : `/api/independent-core/cameras/${encodeURIComponent(cameraId)}/center`;");
    expect(js).toContain("? {x:point.x,y:point.y,frameWidth:1920,frameHeight:1080,speed:50}");
    expect(js).toContain(": {x:point.x,y:point.y};");
  });

  it('영상 위에 커서 십자를 강제하지 않는다', async () => {
    const css = await source('../web/app.css');
    expect(css).not.toContain('.viewport:has(img.live) { cursor: crosshair; }');
    expect(css).toContain('.stream-center-cross');
  });
});
