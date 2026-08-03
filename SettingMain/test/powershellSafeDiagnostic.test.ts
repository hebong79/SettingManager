import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Windows PowerShell 안전 진단', () => {
  it('PTZ 이동 없이 health와 cameras만 GET으로 확인한다', async () => {
    const script = await readFile(new URL('../../scripts/test-settingmanager-safe.ps1', import.meta.url), 'utf8');
    expect(script).toContain("'/api/health'");
    expect(script).toContain("'/api/cameras'");
    expect(script).not.toMatch(/\/api\/(center|ptz\/absolute|ptz\/nudge)/i);
    expect(script).not.toMatch(/-Method\s+(POST|PUT|DELETE)/i);
  });
});