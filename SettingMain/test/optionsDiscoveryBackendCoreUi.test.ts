import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function source(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), 'utf8');
}

describe('Options 코어 구현 선택 UI', () => {
  it('코어 구현은 옵션 화면의 설정이다 — 탐색 화면의 체크박스가 아니다', async () => {
    const html = await source('../web/options.html');
    const js = await source('../web/options.js');

    expect(html).toContain('id="coreProvider"');
    expect(html).toContain('backend-core 경유');
    expect(js).toContain("core: { provider: $('coreProvider').value }");
    expect(html).not.toContain('id="newCameraKind"');
    expect(html).not.toContain('id="fieldKind"');
    expect(js).not.toContain("['fieldKind', 'kind']");
    expect(js).not.toContain("$('fieldKind')");
  });
});