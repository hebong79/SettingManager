import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { callTool, catalogTool } from '../src/mcp/tools.js';
import { matchCatalog, ROUTE_CATALOG } from '../src/mcp/routeCatalog.js';

/**
 * MCP 도구는 SettingManager 자신의 REST 를 부른다 — 규칙을 두 벌로 만들지 않기 위해서다.
 * 여기서 지키는 것은 셋이다: 카탈로그가 실제 라우트와 어긋나지 않을 것,
 * 카메라를 움직이는 호출이 confirm 없이 나가지 않을 것, 카탈로그 밖 경로를 부르지 않을 것.
 */


describe('routeCatalog — 실제 라우트와 어긋나지 않는다', () => {
  it('라우트 소스의 모든 고정 경로가 카탈로그에 있다', async () => {
    const dir = new URL('../src/api/routes/', import.meta.url);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.ts'));
    const declared = new Set<string>();
    for (const file of files) {
      const source = await readFile(new URL(file, dir), 'utf8');
      for (const match of source.matchAll(/pathname === '(\/api\/[^']+)'/g)) declared.add(match[1]!);
    }
    expect(declared.size).toBeGreaterThan(5); // 스캔이 실제로 뭔가 찾았다는 확인

    const missing = [...declared].filter((path) => !ROUTE_CATALOG.some((entry) => entry.path === path));
    // /api/stream 은 무한 스트림이라 MCP 대화에 실을 수 없다 — 의도적으로 제외한다.
    expect(missing).toEqual(['/api/stream']);
  });

  it('경로 템플릿이 실제 경로와 맞는다', () => {
    expect(matchCatalog('GET', '/api/core/capabilities')?.title).toContain('코어');
    expect(matchCatalog('POST', '/api/cameras/cam-a/test')?.mutating).toBe(false);
    expect(matchCatalog('DELETE', '/api/core/discovery/presets/p1/points/pt1')).toBeTruthy();
    expect(matchCatalog('GET', '/api/nope')).toBeUndefined();
    // 템플릿 한 조각은 슬래시를 넘지 않는다
    expect(matchCatalog('DELETE', '/api/presets/a/b')).toBeUndefined();
  });

  it('카메라를 움직이는 경로가 빠짐없이 표시돼 있다', () => {
    const moving = ROUTE_CATALOG.filter((e) => e.movesCamera).map((e) => e.path);
    expect(moving).toEqual(expect.arrayContaining([
      '/api/ptz/absolute', '/api/ptz/nudge', '/api/core/center', '/api/core/center-box',
      '/api/presets/:id/goto', '/api/core/discovery/presets/:id/goto',
      '/api/core/calibration/start', '/api/core/plate-homing/start',
    ]));
    // 읽기 전용이 이동으로 잘못 표시되면 confirm 을 요구해 쓸 수 없게 된다
    expect(ROUTE_CATALOG.find((e) => e.path === '/api/ptz' && e.method === 'GET')!.movesCamera).toBe(false);
    expect(ROUTE_CATALOG.find((e) => e.path === '/api/core/capabilities')!.movesCamera).toBe(false);
  });
});

describe('settingmanager_catalog 도구', () => {
  it('경로 목록과 기준 주소를 답한다', async () => {
    const result = catalogTool({ baseUrl: 'http://127.0.0.1:13030' }) as any;
    expect(result.ok).toBe(true);
    expect(result.baseUrl).toBe('http://127.0.0.1:13030');
    expect(result.routes.length).toBe(ROUTE_CATALOG.length);
  });
});

describe('settingmanager_call 도구', () => {
  function subject(response: Response) {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response);
    const deps = { baseUrl: 'http://127.0.0.1:13030', fetchImpl: fetchImpl as unknown as typeof fetch };
    return { call: (args: any) => callTool(args, deps) as Promise<any>, fetchImpl };
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('읽기 호출은 그대로 통과시키고 상태·본문을 함께 답한다', async () => {
    const { call, fetchImpl } = subject(json({ provider: 'bridge' }));
    const result = await call({ method: 'GET', path: '/api/core/capabilities' });
    expect(result).toMatchObject({ ok: true, status: 200, data: { provider: 'bridge' } });
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://127.0.0.1:13030/api/core/capabilities');
  });

  it('카메라를 움직이는 호출은 confirm 없이 거절하고 **요청을 보내지 않는다**', async () => {
    const { call, fetchImpl } = subject(json({}));
    const result = await call({ method: 'POST', path: '/api/core/center', body: { x: 10, y: 20 } });
    expect(result).toMatchObject({ ok: false, movesCamera: true });
    expect(result.error).toContain('confirm:true');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('confirm:true 면 실행한다', async () => {
    const { call, fetchImpl } = subject(json({ provider: 'bridge', settled: true }));
    const result = await call({ method: 'POST', path: '/api/core/center', body: { x: 10, y: 20 }, confirm: true });
    expect(result.ok).toBe(true);
    expect(JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body))).toEqual({ x: 10, y: 20 });
  });

  it('카탈로그에 없는 경로는 거절한다 — 임의 요청을 대신 쏘지 않는다', async () => {
    const { call, fetchImpl } = subject(json({}));
    const result = await call({ method: 'GET', path: '/api/secret' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('카탈로그에 없는');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('오류 상태코드를 뭉개지 않는다 — 501 과 409 는 재시도 판단이 다르다', async () => {
    for (const status of [501, 409, 422]) {
      const { call } = subject(json({ error: '사유' }, status));
      const result = await call({ method: 'GET', path: '/api/core/discovery/presets' });
      expect(result).toMatchObject({ ok: false, status });
    }
  });

  it('바이너리 응답은 대화에 싣지 않고 크기만 답한다', async () => {
    const { call } = subject(new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    const result = await call({ method: 'GET', path: '/api/snapshot' });
    expect(result).toMatchObject({ ok: true, contentType: 'image/jpeg', bytes: 4 });
    expect(JSON.stringify(result)).not.toContain('data');
  });

  it('통신 실패를 조용히 성공으로 만들지 않는다', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = (await callTool({ method: 'GET', path: '/api/health' }, { baseUrl: 'http://127.0.0.1:13030', fetchImpl: fetchImpl as unknown as typeof fetch })) as any;
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('주소를 모르면 호출하지 않는다', async () => {
    const result = (await callTool({ method: 'GET', path: '/api/health' }, { baseUrl: '' })) as any;
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('주소');
  });
});
