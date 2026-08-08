import { describe, expect, it } from 'vitest';
import { SimRpcClient, SimRpcError } from '../src/sim/simRpcClient.js';
import { SIM_CATALOG, findSimMethod } from '../src/sim/simCatalog.js';

/**
 * 언리얼 Park3D RPC 규약. 응답·오류 모양은 **2026-08-07 라이브 실측**에서 왔다
 * (`192.168.0.125:13510`).
 */

const reply = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

const client = (fetchImpl: typeof fetch) =>
  new SimRpcClient({ rpcUrl: 'http://sim:13510', timeoutMs: 1000, fetchImpl });

describe('SimRpcClient', () => {
  it('POST {rpcUrl}/rpc 로 JSON-RPC 2.0 봉투를 보낸다', async () => {
    let seenUrl = '';
    let seenBody: any = null;
    const spy = (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;

    await client(spy).call('cam.getPTZ', { camId: 1 });
    expect(seenUrl).toBe('http://sim:13510/rpc');
    expect(seenBody).toEqual({ jsonrpc: '2.0', id: 1, method: 'cam.getPTZ', params: { camId: 1 } });
  });

  /** 주소에 경로 접미사가 붙으면 `/stream/rpc` 같은 주소로 조립돼 404 가 난다. */
  it('주소 끝 슬래시를 정리한다', async () => {
    let seenUrl = '';
    const spy = (async (url: string) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    await new SimRpcClient({ rpcUrl: 'http://sim:13510///', timeoutMs: 1000, fetchImpl: spy }).call('system.ping');
    expect(seenUrl).toBe('http://sim:13510/rpc');
  });

  it('도·배율 실수를 그대로 돌려준다 — 드라이버처럼 ×100 하지 않는다', async () => {
    const result = await client(reply({ result: { pan: 47.1, tilt: 30.4, zoom: 2.4 } })).call('cam.getPTZ', { camId: 1 });
    expect(result).toEqual({ pan: 47.1, tilt: 30.4, zoom: 2.4 });
  });

  describe('오류 봉투 (전부 HTTP 200 으로 온다 — 실측)', () => {
    /**
     * 상태코드를 먼저 보면 `-32000 타겟점 미설정` 같은 **사유가 통째로 사라진다.**
     * 서버가 준 한글 문장을 다시 쓰지 않고 그대로 싣는다 — 우리가 지어낸 것보다 정확하다.
     */
    it('도메인 위반(-32000)은 409 + 서버의 한글 사유 그대로', async () => {
      const fail = reply({ error: { code: -32000, message: '타겟점 미설정 — measure.setTargetPoint 를 먼저 호출하세요.', data: null } });
      await expect(client(fail).call('measure.distance', { camId: 1 })).rejects.toMatchObject({
        statusCode: 409,
        rpcCode: -32000,
        message: '타겟점 미설정 — measure.setTargetPoint 를 먼저 호출하세요.',
      });
    });

    /** "이 시뮬레이터에 그 기능이 없다"는 **확정 답**이다 — 일시 장애와 구분돼야 한다. */
    it('미등록 method(-32601)는 501', async () => {
      const fail = reply({ error: { code: -32601, message: '미등록 method: light.get' } });
      await expect(client(fail).call('map.get')).rejects.toMatchObject({ statusCode: 501, rpcCode: -32601 });
    });

    it('잘못된 파라미터(-32602)는 400', async () => {
      const fail = reply({ error: { code: -32602, message: 'camId 필요' } });
      await expect(client(fail).call('cam.get')).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  it('봉투 없는 non-2xx 는 502 + 원문 — result:undefined 로 조용히 통과시키지 않는다', async () => {
    const fail = reply({ notAnEnvelope: true }, 404);
    await expect(client(fail).call('map.get')).rejects.toThrow(/HTTP 404/);
  });

  it('JSON 이 아닌 응답은 502 + 원문 200자', async () => {
    const html = (async () => new Response('<html>route_handler_not_found</html>', { status: 200 })) as unknown as typeof fetch;
    await expect(client(html).call('map.get')).rejects.toThrow(/route_handler_not_found/);
  });

  it('연결 실패는 502 — 어디로 갔는지 모르는 실패를 만들지 않는다', async () => {
    const dead = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(client(dead).call('map.get')).rejects.toMatchObject({ statusCode: 502 });
    await expect(client(dead).call('map.get')).rejects.toThrow(/http:\/\/sim:13510\/rpc/);
  });

  /** 통로를 열면 "이 서비스가 시뮬레이터에 무엇을 할 수 있는가"에 답할 곳이 사라진다. */
  it('카탈로그 밖 메서드는 서버를 두드리기 전에 400 으로 거절한다', async () => {
    let called = false;
    const spy = (async () => { called = true; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    await expect(client(spy).call('scene.nuke')).rejects.toThrow(/허용되지 않은/);
    expect(called).toBe(false);
  });

  it('주소가 비면 생성 자체를 501 로 거절한다 — 빈 주소로 나가지 않는다', () => {
    expect(() => new SimRpcClient({ rpcUrl: '', timeoutMs: 1000 })).toThrow(SimRpcError);
    expect(() => new SimRpcClient({ rpcUrl: '', timeoutMs: 1000 })).toThrow(/simTool\.rpcUrl/);
  });
});

describe('SIM_CATALOG', () => {
  it('메서드 이름이 중복되지 않는다', () => {
    const names = SIM_CATALOG.map((entry) => entry.method);
    expect(new Set(names).size).toBe(names.length);
  });

  it('다섯 툴이 쓰는 계열이 다 있다', () => {
    for (const prefix of ['system.', 'cam.', 'measure.', 'preset.', 'car.', 'random.', 'map.']) {
      expect(SIM_CATALOG.some((entry) => entry.method.startsWith(prefix)), prefix).toBe(true);
    }
  });

  /** 아직 그 서버에 없는 것들(실측 -32601). 생기면 카탈로그에 더한다. */
  it('언리얼에 아직 없는 계열은 담지 않는다', () => {
    for (const missing of ['light.get', 'file.list', 'cam.setLimits']) {
      expect(findSimMethod(missing), missing).toBeUndefined();
    }
  });

  /** view.* 는 2026-08-08 언리얼에 신설됐다(ViewRpcModule) — 그래서 위 목록에서 빠졌다. */
  it('메인 뷰 view.* 4개가 있다', () => {
    for (const method of ['view.get', 'view.set', 'view.pick', 'view.lookAt']) {
      expect(findSimMethod(method), method).toBeDefined();
    }
  });

  /** 메인 뷰를 움직이는 것도 movesCamera 다 — 자동화 게이트가 걸릴 자리다. */
  it('메인 뷰를 움직이는 것과 읽기만 하는 것이 갈려 있다', () => {
    expect(findSimMethod('view.set')?.movesCamera).toBe(true);
    expect(findSimMethod('view.lookAt')?.movesCamera).toBe(true);
    expect(findSimMethod('view.get')?.movesCamera).toBe(false);
    expect(findSimMethod('view.pick')?.movesCamera).toBe(false);
  });

  it('카메라를 움직이는 것과 아닌 것이 갈려 있다', () => {
    expect(findSimMethod('cam.setPTZ')?.movesCamera).toBe(true);
    expect(findSimMethod('cam.getPTZ')?.movesCamera).toBe(false);
    expect(findSimMethod('preset.create')?.movesCamera).toBe(false);
  });
});
