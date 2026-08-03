import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function source(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), 'utf8');
}

describe('Options/주차면 탐색 BackendCore 선택 UI', () => {
  it('Options는 카메라별 backend-core 타입 selector 대신 전역 BackendCore URL만 편집한다', async () => {
    const html = await source('../web/options.html');
    const js = await source('../web/options.js');

    expect(html).toContain('BackendCore URL');
    expect(html).not.toContain('id="newCameraKind"');
    expect(html).not.toContain('id="fieldKind"');
    expect(js).not.toContain("['fieldKind', 'kind']");
    expect(js).not.toContain("$('fieldKind')");
  });
});