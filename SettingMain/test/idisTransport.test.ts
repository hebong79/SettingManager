import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_BYTES,
  authorizedRequest,
  isTransportError,
  rawRequest,
} from '../src/devices/idis/idisTransport.js';

/**
 * 계획 §7 `test/idisTransport.test.ts` — T-T1~T-T6.
 *
 * 이 드라이버는 `fetch` 가 아니라 `node:http` 를 쓰므로 `vi.stubGlobal('fetch', …)` 로 가로챌 수
 * 없다. 저장소 선례(`test/hucomsPresetClient.test.ts`)대로 **로컬 소켓 서버**를 띄운다 —
 * Digest 는 401→재시도 2왕복이 필요해서 실제 서버가 있어야 재현된다.
 */

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

interface Hit {
  method: string;
  url: string;
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

async function listen(handler: (hit: Hit, res: ServerResponse) => void): Promise<{ url: (path?: string) => URL; hits: Hit[] }> {
  const hits: Hit[] = [];
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const hit: Hit = { method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks), headers: req.headers };
      hits.push(hit);
      handler(hit, res);
    });
  });
  const port = await new Promise<number>((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      const address = server!.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
  return { url: (path = '/cgi-bin/webSetup.cgi') => new URL(`http://127.0.0.1:${port}${path}`), hits };
}

const md5 = (value: string): string => createHash('md5').update(value).digest('hex');

/** 헤더의 필드 하나를 읽는다. 구현의 파서를 쓰지 않는다 — 목이 **독립적으로** 검증해야 한다. */
function field(header: string, key: string): string | undefined {
  const match = new RegExp(`(?:^|[\\s,])${key}=("([^"]*)"|[^",\\s]+)`).exec(header);
  return match ? (match[2] ?? match[1]) : undefined;
}

describe('T-T1 Digest 왕복 — 401 → 재시도 → 200', () => {
  it('목이 응답 해시를 **스스로 계산해** 검증하고, 인증된 요청이 1회 도달한다', async () => {
    const NONCE = 'deadbeef';
    const authorized: string[] = [];
    const { url, hits } = await listen((hit, res) => {
      const header = hit.headers.authorization as string | undefined;
      if (!header) {
        res.writeHead(401, { 'WWW-Authenticate': `Digest realm="WEB SERVER",qop="auth",algorithm=MD5,nonce="${NONCE}"` });
        res.end();
        return;
      }
      // 목이 RFC2617 을 직접 계산한다. 구현이 틀리면 여기서 401 이 한 번 더 나가고 테스트가 깨진다.
      const nc = field(header, 'nc')!;
      const cnonce = field(header, 'cnonce')!;
      const uri = field(header, 'uri')!;
      const expected = md5(`${md5(`admin:WEB SERVER:secret-not-real`)}:${NONCE}:${nc}:${cnonce}:auth:${md5(`${hit.method}:${uri}`)}`);
      if (field(header, 'response') !== expected) {
        res.writeHead(401, { 'WWW-Authenticate': `Digest realm="WEB SERVER",qop="auth",algorithm=MD5,nonce="${NONCE}"` });
        res.end('BAD DIGEST');
        return;
      }
      authorized.push(header);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('returnCode=0&absPan=18000');
    });

    const response = await authorizedRequest(
      url('/cgi-bin/webSetup.cgi?action=ptzAbsolute&mode=1'),
      { timeoutMs: 2000 }, 'admin', 'secret-not-real',
    );

    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toBe('returnCode=0&absPan=18000');
    expect(hits).toHaveLength(2);                // 401 한 번 + 인증된 것 한 번
    expect(authorized).toHaveLength(1);          // 인증된 요청은 **한 번만** 도달한다
    // uri 에 query 가 살아 있다 — 떼면 목의 HA2 계산과 어긋나 위에서 이미 깨졌을 것이다.
    expect(field(authorized[0]!, 'uri')).toBe('/cgi-bin/webSetup.cgi?action=ptzAbsolute&mode=1');
  });

  it('재시도가 **한 번뿐**이다 — 목이 계속 401 이어도 무한히 두드리지 않는다', async () => {
    const { url, hits } = await listen((_hit, res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="WEB SERVER",qop="auth",algorithm=MD5,nonce="deadbeef"' });
      res.end();
    });
    const response = await authorizedRequest(url(), { timeoutMs: 2000 }, 'admin', 'wrong');
    expect(response.status).toBe(401);
    expect(hits).toHaveLength(2);
  });
});

describe('T-T2 POST 는 폼 본문으로 나가고 쿼리로 새지 않는다', () => {
  it('Content-Type · 본문 · Content-Length 가 그대로 도달하고 URL 에는 쓰기 파라미터가 없다', async () => {
    const { url, hits } = await listen((_hit, res) => res.end('returnCode=0'));
    await rawRequest(url(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=ptzPreset&mode=0&command=moveTo&id=7',
      timeoutMs: 2000,
    });

    expect(hits[0]!.method).toBe('POST');
    expect(hits[0]!.url).toBe('/cgi-bin/webSetup.cgi');    // 쿼리가 비어 있다
    expect(hits[0]!.url).not.toContain('command=');
    expect(hits[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(hits[0]!.headers['content-length']).toBe(String(Buffer.byteLength('action=ptzPreset&mode=0&command=moveTo&id=7')));
    expect(hits[0]!.body.toString('utf8')).toBe('action=ptzPreset&mode=0&command=moveTo&id=7');
  });

  it('Digest 재시도에서도 본문이 다시 실린다 — 두 번째 요청이 빈 본문이면 기기가 파라미터 부족으로 답한다', async () => {
    const bodies: string[] = [];
    const { url } = await listen((hit, res) => {
      bodies.push(hit.body.toString('utf8'));
      if (!hit.headers.authorization) {
        res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="WEB SERVER",qop="auth",algorithm=MD5,nonce="deadbeef"' });
        res.end();
        return;
      }
      res.end('returnCode=0');
    });
    await authorizedRequest(url(), {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=ptzPreset&mode=0&command=set', timeoutMs: 2000,
    }, 'admin', 'secret-not-real');

    expect(bodies).toEqual(['action=ptzPreset&mode=0&command=set', 'action=ptzPreset&mode=0&command=set']);
  });
});

describe('T-T3 바이너리 온전성', () => {
  it('50KB JPEG 이 청크로 쪼개져 와도 바이트가 보존된다', async () => {
    // 무작위가 아니라 결정적 패턴 — 어긋나면 어느 바이트에서 어긋났는지 눈에 보인다.
    const jpeg = Buffer.alloc(50_000);
    for (let i = 0; i < jpeg.length; i += 1) jpeg[i] = i % 256;
    jpeg[0] = 0xff;
    jpeg[1] = 0xd8;

    const { url } = await listen((_hit, res) => {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      for (let at = 0; at < jpeg.length; at += 4096) res.write(jpeg.subarray(at, at + 4096));
      res.end();
    });

    const response = await rawRequest(url(), { timeoutMs: 5000, maxBytes: MAX_IMAGE_BYTES });
    expect(response.body.length).toBe(jpeg.length);
    expect(response.body.equals(jpeg)).toBe(true);
  });

  it('상한을 넘으면 전송 오류로 던진다 — 8MiB 를 통째로 메모리에 담지 않는다', async () => {
    const { url } = await listen((_hit, res) => {
      res.writeHead(200);
      res.write(Buffer.alloc(4096, 1));
      res.write(Buffer.alloc(4096, 2));
      res.end();
    });
    await expect(rawRequest(url(), { timeoutMs: 2000, maxBytes: 4096 })).rejects.toMatchObject({ transport: true });
  });
});

describe('T-T4 Basic 챌린지 폴백', () => {
  it('목이 Basic 을 요구하면 Basic 헤더로 재시도한다 — 우리가 방식을 고르지 않는다', async () => {
    const { url, hits } = await listen((hit, res) => {
      if (!hit.headers.authorization) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="WEB SERVER"' });
        res.end();
        return;
      }
      res.end('returnCode=0');
    });

    const response = await authorizedRequest(url(), { timeoutMs: 2000 }, 'admin', 'secret-not-real');
    expect(response.status).toBe(200);
    expect(hits[1]!.headers.authorization)
      .toBe(`Basic ${Buffer.from('admin:secret-not-real').toString('base64')}`);
  });
});

describe('T-T5 연결 단계 마감', () => {
  it('도달 불가 주소에서 timeoutMs=350 이 지켜진다 — 소켓 유휴 타임아웃으로 되돌아가면 실측 5초다', async () => {
    const started = Date.now();
    await expect(rawRequest(new URL('http://10.255.255.1:80/cgi-bin/webSetup.cgi'), { timeoutMs: 350 }))
      .rejects.toMatchObject({ transport: true });
    expect(Date.now() - started).toBeLessThan(1200);
  });

  it('응답이 늦는 서버에서도 같은 마감이 걸린다', async () => {
    const { url } = await listen((_hit, res) => {
      // 응답 헤더만 보내고 본문을 끝내지 않는다 — 연결은 됐지만 끝나지 않는 상태.
      res.writeHead(200);
      res.write('return');
    });
    const started = Date.now();
    await expect(rawRequest(url(), { timeoutMs: 300 })).rejects.toMatchObject({ transport: true });
    expect(Date.now() - started).toBeLessThan(1200);
  });

  it('전송 오류는 `IdisTransportError` 로 식별된다 — 능력 프로브가 이것을 보고 능력을 안 내린다', async () => {
    const error = await rawRequest(new URL('http://127.0.0.1:1/x'), { timeoutMs: 500 }).catch((e: unknown) => e);
    expect(isTransportError(error)).toBe(true);
  });
});

describe('T-T6 알 수 없는 인증 방식', () => {
  it('401 을 그대로 올린다 — 임의로 Basic 을 시도하지 않는다', async () => {
    const { url, hits } = await listen((_hit, res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="WEB SERVER"' });
      res.end();
    });

    const response = await authorizedRequest(url(), { timeoutMs: 2000 }, 'admin', 'secret-not-real');
    expect(response.status).toBe(401);
    expect(hits).toHaveLength(1);                             // 재시도 자체가 없다
    expect(hits[0]!.headers.authorization).toBeUndefined();   // 자격증명을 흘리지도 않았다
  });

  it('WWW-Authenticate 헤더가 아예 없는 401 도 그대로 올린다', async () => {
    const { url, hits } = await listen((_hit, res) => { res.writeHead(401); res.end(); });
    const response = await authorizedRequest(url(), { timeoutMs: 2000 }, 'admin', 'secret-not-real');
    expect(response.status).toBe(401);
    expect(hits).toHaveLength(1);
  });
});

describe('인증이 필요 없으면 첫 왕복으로 끝난다', () => {
  it('200 이면 재시도하지 않고 자격증명도 보내지 않는다', async () => {
    const { url, hits } = await listen((_hit, res) => res.end('returnCode=0'));
    const response = await authorizedRequest(url(), { timeoutMs: 2000 }, 'admin', 'secret-not-real');
    expect(response.status).toBe(200);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.headers.authorization).toBeUndefined();
  });
});
