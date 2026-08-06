import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IdisCameraClient } from '../src/devices/idis/index.js';
import { MODE } from '../src/devices/idis/idisConstants.js';

/**
 * 계획 §7 `test/idisCamera.test.ts` — T-M1~T-M25 + T-ISO.
 *
 * 픽스처 응답 문자열은 `[매뉴얼 §56:8513 Example]`·`[매뉴얼 §50 Example]` 원문이거나
 * `[실측 DC-S6286HRXLT 덤프]` 다. 지어낸 문자열은 없다.
 *
 * 목은 `node:http` 로 띄운다 — 이 드라이버는 요청별 TLS 옵션 때문에 `fetch` 를 쓰지 않아
 * `vi.stubGlobal('fetch', …)` 로는 아무것도 가로챌 수 없다.
 */

const PASSWORD = 'secret-not-real';

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

interface Hit {
  method: string;
  url: string;
  body: string;
  /** GET 이면 쿼리, POST 면 본문에서 읽은 파라미터. 두 경로를 한 눈으로 본다. */
  params: URLSearchParams;
  action: string | null;
}

async function mockCamera(handler: (hit: Hit, res: ServerResponse) => void): Promise<{ baseUrl: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      const body = Buffer.concat(chunks).toString('utf8');
      const params = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : body);
      const hit: Hit = { method: req.method ?? '', url, body, params, action: params.get('action') };
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
  return { baseUrl: `http://127.0.0.1:${port}`, hits };
}

/** 액션별로 답을 정해 준다. 목록에 없으면 `returnCode=9000`(그런 API 없음)이 기본이다. */
async function mockByAction(table: Record<string, string>): Promise<{ baseUrl: string; hits: Hit[] }> {
  return mockCamera((hit, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(table[hit.action ?? ''] ?? 'returnCode=9000');
  });
}

const client = (baseUrl: string, options: { timeoutMs?: number } = {}): IdisCameraClient =>
  new IdisCameraClient({
    cameraId: 'idis-1', baseUrl, username: 'admin', password: PASSWORD,
    timeoutMs: options.timeoutMs ?? 2000,
  });

/** 벤더 확인만 통과시키는 최소 응답 `[매뉴얼 §4]` 의 필드 이름. */
const MODEL_OK = 'returnCode=0&model=DC-S6261XT&modelGroup=5&softwareVersion=1.4.2&webApiVersion=2.20';

// ---------------------------------------------------------------------------

describe('T-M1·T-M2 getPtz — 와이어 좌표가 계약 좌표로 뒤집힌다', () => {
  it('`[매뉴얼 §56:8513 Example]` → {pan:18000, tilt:150, zoom:3000} (tilt = 9000 − 8850)', async () => {
    const { baseUrl, hits } = await mockByAction({ ptzAbsolute: 'returnCode=0&absPan=18000&absTilt=8850&absZoom=3000' });
    expect(await client(baseUrl).getPtz()).toEqual({ pan: 18000, tilt: 150, zoom: 3000 });
    // 읽기는 GET + mode=1 이다 — mode=0 으로 읽으면 카메라가 실제로 움직인다.
    expect(hits[0]!.method).toBe('GET');
    expect(hits[0]!.params.get('mode')).toBe(String(MODE.READ));
  });

  it('`[실측]` 자세 absPan=-1000&absTilt=0&absZoom=1200 → {pan:35000, tilt:9000, zoom:1200}', async () => {
    const { baseUrl } = await mockByAction({ ptzAbsolute: 'returnCode=0&absPan=-1000&absTilt=0&absZoom=1200' });
    expect(await client(baseUrl).getPtz()).toEqual({ pan: 35000, tilt: 9000, zoom: 1200 });
  });

  it('정수가 아닌 값이 오면 지어내지 않고 던진다', async () => {
    const { baseUrl } = await mockByAction({ ptzAbsolute: 'returnCode=0&absPan=&absTilt=8850&absZoom=3000' });
    await expect(client(baseUrl).getPtz()).rejects.toThrow(/absPan/);
  });
});

describe('T-M3·T-M4·T-M5 goPtz', () => {
  it('사전 클램프가 **와이어에 반영된다** — absTilt 가 음수로 나가지 않는다', async () => {
    const { baseUrl, hits } = await mockByAction({ ptzAbsolute: 'returnCode=0' });
    await client(baseUrl).goPtz({ pan: 35000, tilt: -2000, zoom: 3000 });

    expect(hits[0]!.params.get('absPan')).toBe('-1000');
    expect(hits[0]!.params.get('absTilt')).toBe('9000');
    expect(hits[0]!.params.get('absTilt')).not.toBe('11000');   // 오토플립을 부르는 값
    expect(hits[0]!.params.get('absZoom')).toBe('1200');
  });

  it('speed 는 와이어에 실리지 않는다 `[매뉴얼 §56 — 속도 파라미터 없음]`', async () => {
    const { baseUrl, hits } = await mockByAction({ ptzAbsolute: 'returnCode=0' });
    await client(baseUrl).goPtz({ pan: 100, tilt: 100, zoom: 600 }, 50);

    expect(hits[0]!.params.get('speed')).toBeNull();
    expect(hits[0]!.params.get('panspeed')).toBeNull();
    expect([...hits[0]!.params.keys()].sort()).toEqual(['absPan', 'absTilt', 'absZoom', 'action', 'mode']);
  });

  it('GET 이 아니라 POST 이고 mode=0 이 **본문**에 있다 — 쓰기 값이 URL 에 남지 않는다', async () => {
    const { baseUrl, hits } = await mockByAction({ ptzAbsolute: 'returnCode=0' });
    await client(baseUrl).goPtz({ pan: 100, tilt: 100, zoom: 600 });

    expect(hits[0]!.method).toBe('POST');
    expect(hits[0]!.url).toBe('/cgi-bin/webSetup.cgi');
    expect(hits[0]!.body).toContain(`mode=${MODE.WRITE}`);
    expect(hits[0]!.params.get('mode')).toBe('0');
  });
});

describe('T-M6·T-M7 미구현 액션 판정 — 두 얼굴이 한 오류로 합쳐진다', () => {
  it('무관한 설정 덤프 `[실측 DC-S6286HRXLT]` → 501 "이 펌웨어에 없습니다"', async () => {
    const { baseUrl } = await mockCamera((_hit, res) => res.end('motion_type="rect"\narea_count=1'));
    const error = await client(baseUrl).getPtz().catch((e: unknown) => e) as { statusCode: number; message: string };
    expect(error.statusCode).toBe(501);
    expect(error.message).toContain('이 펌웨어에 없습니다');
    expect(error.message).toContain('returnCode= 로 시작하지 않습니다');
  });

  it('returnCode=9000 단독 → 같은 501, 그리고 사유에 9000 이 실린다', async () => {
    const { baseUrl } = await mockByAction({ ptzAbsolute: 'returnCode=9000' });
    const error = await client(baseUrl).getPtz().catch((e: unknown) => e) as { statusCode: number; message: string };
    expect(error.statusCode).toBe(501);
    expect(error.message).toContain('이 펌웨어에 없습니다');
    expect(error.message).toContain('9000');
  });

  it('**`mode=9000`(System Restart)을 보내지 않는다** — 9000 은 응답에서만 읽는 숫자다', async () => {
    const { baseUrl, hits } = await mockByAction({
      modelInformation: MODEL_OK, ptzAbsolute: 'returnCode=0&absPan=0&absTilt=0&absZoom=100',
      ptzPreset: 'returnCode=0', videoSnapshot: 'returnCode=9000',
    });
    const camera = client(baseUrl);
    await camera.probeCapabilities().catch(() => {});
    await camera.getPtz().catch(() => {});
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.params.get('mode'), `mode=9000 이 나갔다: ${hit.url} ${hit.body}`).not.toBe(String(MODE.SYSTEM_RESTART));
    }
  });
});

describe('T-M8·T-M9·T-M10·T-M11·T-M12 프로브 — 못 닿은 것과 못 하는 것의 구분', () => {
  it('T-M8 덤프·9000 은 능력을 내린다', async () => {
    const { baseUrl } = await mockByAction({ modelInformation: MODEL_OK });   // 나머지는 전부 9000
    const capabilities = await client(baseUrl).probeCapabilities();
    expect(capabilities.absolutePosition).toBe(false);
    expect(capabilities.presets).toBe(false);
    expect(capabilities.snapshot).toBe(false);
    expect(capabilities.relativeMove).toBe(true);   // 프로브하지 않는 축은 상한 그대로다
  });

  it('T-M9 전송 실패는 **던지고** 능력을 내리지 않는다', async () => {
    const camera = new IdisCameraClient({
      cameraId: 'idis-1', baseUrl: 'http://10.255.255.1:80', username: 'admin', password: PASSWORD, timeoutMs: 350,
    });
    const started = Date.now();
    await expect(camera.probeCapabilities()).rejects.toMatchObject({ transport: true });
    expect(Date.now() - started).toBeLessThan(1200);
    expect(camera.capabilities.snapshot).toBe(true);
    expect(camera.capabilities.absolutePosition).toBe(true);
  });

  it('T-M10 인증 실패(rc=900)는 던지고 능력을 내리지 않는다 — 비밀번호 오타가 고장난 카메라로 저장되면 안 된다', async () => {
    // 벤더 확인은 통과하고 능력 프로브에서 900 이 나오는 경우.
    const { baseUrl } = await mockByAction({ modelInformation: MODEL_OK, ptzAbsolute: 'returnCode=900' });
    const camera = client(baseUrl);
    await expect(camera.probeCapabilities()).rejects.toThrow(/인증·권한/);
    expect(camera.capabilities).toEqual({
      snapshot: true, absolutePosition: true, relativeMove: true, presets: true, pixelCentering: true, boxZoom: true,
    });
  });

  it('T-M10 인증 실패는 401 이 아니라 502 다 — 그 401 은 우리와 카메라 사이의 것이다', async () => {
    const { baseUrl } = await mockByAction({ modelInformation: MODEL_OK, ptzAbsolute: 'returnCode=900' });
    const error = await client(baseUrl).probeCapabilities().catch((e: unknown) => e) as { statusCode: number };
    expect(error.statusCode).toBe(502);
  });

  it('T-M10 HTTP 401 도 같은 갈래다 — 능력을 내리지 않는다', async () => {
    const { baseUrl } = await mockCamera((hit, res) => {
      if (hit.action === 'modelInformation') return void res.end(MODEL_OK);
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer x' });   // 우리가 못 푸는 방식 → 401 이 그대로 올라온다
      res.end();
    });
    const camera = client(baseUrl);
    await expect(camera.probeCapabilities()).rejects.toThrow(/계정·권한/);
    expect(camera.capabilities.presets).toBe(true);
  });

  it('T-M11 `ptzMoveToPoint&mode=1` 에 returnCode=304 는 **있음**이다', async () => {
    const { baseUrl } = await mockByAction({ modelInformation: MODEL_OK, ptzMoveToPoint: 'returnCode=304' });
    expect((await client(baseUrl).probeCapabilities()).pixelCentering).toBe(true);
  });

  it('T-M11 301 도 있음이다 — Write 전용 절의 mode=1 프로브가 rc=0 이 아닐 수 있다', async () => {
    const { baseUrl } = await mockByAction({ modelInformation: MODEL_OK, ptzMoveToArea: 'returnCode=301' });
    expect((await client(baseUrl).probeCapabilities()).boxZoom).toBe(true);
  });

  it('T-M12 벤더 확인 실패는 능력을 내리는 대신 **던진다** (FlexWatch 오인 사고 대응)', async () => {
    const { baseUrl, hits } = await mockCamera((_hit, res) => res.end('motion_type="rect"'));
    const camera = client(baseUrl);
    await expect(camera.probeCapabilities()).rejects.toThrow(/IDIS WebAPI 로 응답하지 않습니다/);
    expect(camera.capabilities.snapshot).toBe(true);
    // 첫 줄에서 멈춘다 — 나머지 액션을 두드리지 않는다.
    expect(hits).toHaveLength(1);
    expect(hits[0]!.action).toBe('modelInformation');
  });

  it('프로브는 **mode=1(읽기)만** 쓴다 — mode=0 으로 프로브하면 카메라가 실제로 움직인다', async () => {
    const { baseUrl, hits } = await mockByAction({ modelInformation: MODEL_OK });
    await client(baseUrl).probeCapabilities();
    for (const hit of hits) {
      expect(hit.params.get('mode'), `${hit.action} 가 mode=0 으로 나갔다`).not.toBe(String(MODE.WRITE));
    }
  });
});

describe('T-M13·T-M14·T-M15 centerPoint', () => {
  it('T-M13 지원 시 §58 정규화 좌표를 POST 한다 (T-C7 과 같은 값)', async () => {
    const { baseUrl, hits } = await mockByAction({ ptzMoveToPoint: 'returnCode=0' });
    await client(baseUrl).centerPoint({ x: 960, y: 540 });

    const posted = hits.find((hit) => hit.method === 'POST')!;
    expect(posted.params.get('pointPan')).toBe('50000');
    expect(posted.params.get('pointTilt')).toBe('50000');
    expect(posted.params.get('mode')).toBe(String(MODE.WRITE));
  });

  it('T-M14 미지원이면 501 이고 **ptzMoveToPoint POST 가 목에 도달하지 않는다**', async () => {
    const { baseUrl, hits } = await mockByAction({});   // 전부 9000
    await expect(client(baseUrl).centerPoint({ x: 960, y: 540 })).rejects.toMatchObject({ statusCode: 501 });
    expect(hits.every((hit) => hit.method === 'GET')).toBe(true);
    expect(hits.filter((hit) => hit.method === 'POST')).toHaveLength(0);
  });

  it('프로브 결과를 기억한다 — 두 번째 호출은 다시 묻지 않는다', async () => {
    const { baseUrl, hits } = await mockByAction({ ptzMoveToPoint: 'returnCode=0' });
    const camera = client(baseUrl);
    await camera.centerPoint({ x: 960, y: 540 });
    await camera.centerPoint({ x: 0, y: 0 });

    expect(hits.filter((hit) => hit.method === 'GET')).toHaveLength(1);    // 프로브는 한 번뿐
    expect(hits.filter((hit) => hit.method === 'POST')).toHaveLength(2);
  });

  it('T-M15 프레임 범위 밖은 400 이고 네트워크 호출이 없다', async () => {
    const { baseUrl, hits } = await mockByAction({ ptzMoveToPoint: 'returnCode=0' });
    const camera = client(baseUrl);
    for (const point of [{ x: 2000, y: 0 }, { x: 0, y: 1081 }, { x: -1, y: 0 }, { x: 1.5, y: 0 }]) {
      await expect(camera.centerPoint(point)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(hits).toHaveLength(0);
  });

  it('프레임 경계값(1920·1080)은 통과한다 — 한 픽셀 차이로 못 쓰게 만들지 않는다', async () => {
    const { baseUrl, hits } = await mockByAction({ ptzMoveToPoint: 'returnCode=0' });
    await client(baseUrl).centerPoint({ x: 1920, y: 1080 });
    const posted = hits.find((hit) => hit.method === 'POST')!;
    expect(posted.params.get('pointPan')).toBe('100000');
    expect(posted.params.get('pointTilt')).toBe('100000');
  });
});

describe('T-M16·T-M17 비밀번호와 자격증명 URL', () => {
  it('T-M17 controlUrl 에 자격증명이 있으면 **400** 이다 (statusCode 까지 고정)', () => {
    const build = (baseUrl: string): IdisCameraClient => new IdisCameraClient({
      cameraId: 'idis-1', baseUrl, username: 'admin', password: PASSWORD, timeoutMs: 200,
    });
    for (const bad of ['http://admin:secret-not-real@127.0.0.1:1', 'http://admin@127.0.0.1:1']) {
      const error = (() => { try { build(bad); return null; } catch (e) { return e as { statusCode: number }; } })();
      expect(error, `${bad} 가 거절되지 않았다`).not.toBeNull();
      expect(error!.statusCode).toBe(400);
    }
  });

  it('query·fragment·비 http(s) 스킴도 400 이다', () => {
    const build = (baseUrl: string): IdisCameraClient => new IdisCameraClient({
      cameraId: 'idis-1', baseUrl, username: 'admin', password: PASSWORD, timeoutMs: 200,
    });
    for (const bad of ['http://127.0.0.1:1/?a=1', 'http://127.0.0.1:1/#x', 'ftp://127.0.0.1:1', 'not a url']) {
      expect(() => build(bad), `${bad} 가 통과했다`).toThrow();
      const error = (() => { try { build(bad); return null; } catch (e) { return e as { statusCode: number }; } })();
      expect(error!.statusCode).toBe(400);
    }
  });

  it('T-M16 어떤 실패 경로에서도 비밀번호가 오류 문구에 실리지 않는다', async () => {
    const messages: string[] = [];
    const collect = async (run: () => Promise<unknown> | unknown): Promise<void> => {
      try {
        await run();
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error));
      }
    };

    const rc900 = await mockByAction({ ptzAbsolute: 'returnCode=900' });
    await collect(() => client(rc900.baseUrl).getPtz());
    const rc301 = await mockByAction({ ptzAbsolute: 'returnCode=301' });
    await collect(() => client(rc301.baseUrl).getPtz());
    const dump = await mockCamera((_hit, res) => res.end('motion_type="rect"'));
    await collect(() => client(dump.baseUrl).getPtz());
    const http500 = await mockCamera((_hit, res) => { res.writeHead(500); res.end('boom'); });
    await collect(() => client(http500.baseUrl).getPtz());
    await collect(() => client(http500.baseUrl).getSnapshot());
    const notJpeg = await mockCamera((_hit, res) => { res.writeHead(200); res.end(Buffer.from('RIFF____WEBP')); });
    await collect(() => client(notJpeg.baseUrl).getSnapshot());
    // 전송 실패 — 마스킹 경로.
    await collect(() => new IdisCameraClient({
      cameraId: 'idis-1', baseUrl: 'http://10.255.255.1:80', username: 'admin', password: PASSWORD, timeoutMs: 200,
    }).getPtz());
    // 자격증명 URL — 생성자 거절.
    await collect(() => new IdisCameraClient({
      cameraId: 'idis-1', baseUrl: `http://admin:${PASSWORD}@127.0.0.1:1`, username: 'admin', password: PASSWORD, timeoutMs: 200,
    }));

    expect(messages).toHaveLength(8);
    for (const message of messages) {
      expect(message, message).not.toContain(PASSWORD);
      expect(message, message).not.toContain(encodeURIComponent(PASSWORD));
    }
  });
});

describe('T-M18·T-M19 getSnapshot — 바이트가 1차 신호다', () => {
  it('T-M18 SOI(FF D8) 로 시작하는 200 은 Buffer 그대로 온다', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(50_000, 7)]);
    const { baseUrl } = await mockCamera((_hit, res) => {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.write(jpeg.subarray(0, 10_000));
      res.end(jpeg.subarray(10_000));
    });
    expect((await client(baseUrl).getSnapshot()).equals(jpeg)).toBe(true);
  });

  it('T-M18 `image/jpeg` 라고 적힌 200 이라도 본문이 returnCode= 면 오류다', async () => {
    const { baseUrl } = await mockCamera((_hit, res) => {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end('returnCode=9000');
    });
    await expect(client(baseUrl).getSnapshot()).rejects.toMatchObject({ statusCode: 501 });
  });

  it('T-M19 SOI 가 없는 200 은 던진다 — §25 의 `image/webp` 표기를 믿지 않는다', async () => {
    const { baseUrl } = await mockCamera((_hit, res) => {
      // 헤더는 image/jpeg 인데 바이트는 WEBP 다. 헤더를 믿으면 여기서 통과해 버린다.
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(Buffer.from('RIFF____WEBP'));
    });
    await expect(client(baseUrl).getSnapshot()).rejects.toThrow(/JPEG 가 아닙니다/);
  });

  it('반대로 Content-Type 이 `image/webp` 여도 바이트가 JPEG 면 받는다 — §25 의 모순 대응', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(16, 1)]);
    const { baseUrl } = await mockCamera((_hit, res) => {
      res.writeHead(200, { 'Content-Type': 'image/webp' });
      res.end(jpeg);
    });
    expect((await client(baseUrl).getSnapshot()).equals(jpeg)).toBe(true);
  });
});

describe('T-M20 listSlots', () => {
  it('IDIS 기기에는 주차면 개념이 없다 — 오류가 아니라 빈 배열이고 네트워크도 두드리지 않는다', async () => {
    const { baseUrl, hits } = await mockByAction({});
    expect(await client(baseUrl).listSlots()).toEqual([]);
    expect(hits).toHaveLength(0);
  });
});

describe('T-M21·T-M22·T-M23 프리셋', () => {
  it('T-M21 `returnCode=0&presetName1=EL1&presetName2=FL1` → id 오름차순 배열', async () => {
    const { baseUrl } = await mockByAction({ ptzPreset: 'returnCode=0&presetName1=EL1&presetName2=FL1' });
    expect(await client(baseUrl).listPresets()).toEqual([{ id: 1, name: 'EL1' }, { id: 2, name: 'FL1' }]);
  });

  it('T-M21 정렬은 **숫자** 순이다 — 문자열 정렬이면 10 이 2 앞에 온다', async () => {
    const { baseUrl } = await mockByAction({ ptzPreset: 'returnCode=0&presetName10=열번&presetName2=두번&presetName1=한번' });
    expect(await client(baseUrl).listPresets()).toEqual([
      { id: 1, name: '한번' }, { id: 2, name: '두번' }, { id: 10, name: '열번' },
    ]);
  });

  it('T-M21 presetName 이 아닌 키는 섞이지 않는다', async () => {
    const { baseUrl } = await mockByAction({ ptzPreset: 'returnCode=0&presetName1=EL1&presetCount=1&presetNameX=?' });
    expect(await client(baseUrl).listPresets()).toEqual([{ id: 1, name: 'EL1' }]);
  });

  it('T-M22 명령 표기는 `moveTo`·`set`·`remove` 다 — `moveToPreset`/`setPreset` 이 아니다', async () => {
    const { baseUrl, hits } = await mockByAction({ ptzPreset: 'returnCode=0' });
    const camera = client(baseUrl);
    await camera.gotoPreset(7);
    await camera.setPreset(7, '입구 A');
    await camera.removePreset(7);

    expect(hits.map((hit) => hit.params.get('command'))).toEqual(['moveTo', 'set', 'remove']);
    expect(hits.every((hit) => hit.method === 'POST')).toBe(true);
    expect(hits[1]!.params.get('presetName')).toBe('입구 A');
    expect(hits[0]!.params.get('id')).toBe('7');
    // 매뉴얼 복붙 오류판(§51 Example)의 표기가 어디에도 나가지 않는다.
    for (const hit of hits) {
      expect(hit.body).not.toContain('moveToPreset');
      expect(hit.body).not.toContain('command=setPreset');
    }
  });

  it('T-M23 프리셋 id 범위 밖(0·257·1.5)은 400 이고 네트워크 호출이 없다 `[매뉴얼 §50 — 1~256]`', async () => {
    const { baseUrl, hits } = await mockByAction({ ptzPreset: 'returnCode=0' });
    const camera = client(baseUrl);
    for (const id of [0, 257, 1.5, -1, Number.NaN]) {
      await expect(camera.gotoPreset(id), `id=${id}`).rejects.toMatchObject({ statusCode: 400 });
      await expect(camera.setPreset(id, 'x'), `id=${id}`).rejects.toMatchObject({ statusCode: 400 });
      await expect(camera.removePreset(id), `id=${id}`).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(hits).toHaveLength(0);
  });

  it('T-M23 경계값 1·256 은 통과한다', async () => {
    const { baseUrl, hits } = await mockByAction({ ptzPreset: 'returnCode=0' });
    const camera = client(baseUrl);
    await camera.gotoPreset(1);
    await camera.gotoPreset(256);
    expect(hits.map((hit) => hit.params.get('id'))).toEqual(['1', '256']);
  });
});

describe('T-M24 ptzCommand — 화이트리스트와 눈금', () => {
  it('목록 밖 명령은 400 이고 네트워크 호출이 없다', async () => {
    const { baseUrl, hits } = await mockByAction({ ptzCommand: 'returnCode=0' });
    const camera = client(baseUrl);
    for (const command of ['reboot', 'zoomin', '', 'moveTo']) {
      await expect(camera.ptzCommand({ command }), command).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(hits).toHaveLength(0);
  });

  it('speed 는 1~16 으로 클램프된다 `[매뉴얼 §48]` — Hucoms 의 1~100 눈금이 그대로 나가지 않는다', async () => {
    const { baseUrl, hits } = await mockByAction({ ptzCommand: 'returnCode=0' });
    const camera = client(baseUrl);
    await camera.ptzCommand({ command: 'moveToN', speed: 100 });
    await camera.ptzCommand({ command: 'moveToN', speed: 0 });
    await camera.ptzCommand({ command: 'moveToN', speed: 8 });
    await camera.ptzCommand({ command: 'moveToN' });

    expect(hits.map((hit) => hit.params.get('speed'))).toEqual(['16', '1', '8', '4']);
  });

  it('**`step=0` 이 지워지지 않는다** — 지우면 연속 이동이 1스텝 이동으로 조용히 바뀐다', async () => {
    const { baseUrl, hits } = await mockByAction({ ptzCommand: 'returnCode=0' });
    await client(baseUrl).ptzCommand({ command: 'zoomIn' });          // step 기본값 0
    await client(baseUrl).ptzCommand({ command: 'zoomIn', step: 5 });

    expect(hits[0]!.params.get('step')).toBe('0');
    expect(hits[0]!.body).toContain('step=0');
    expect(hits[1]!.params.get('step')).toBe('5');
  });

  it('stop() 은 화이트리스트의 stop 을 보낸다', async () => {
    const { baseUrl, hits } = await mockByAction({ ptzCommand: 'returnCode=0' });
    await client(baseUrl).stop();
    expect(hits[0]!.params.get('command')).toBe('stop');
    expect(hits[0]!.params.get('step')).toBe('0');
  });
});

describe('T-M25 raw() 원본 통로', () => {
  it('임의 action 을 §75 판정을 거쳐 Record<string,string> 으로 돌려준다', async () => {
    const { baseUrl, hits } = await mockByAction({ networkInformation: 'returnCode=0&ipAddress=192.168.0.21&macAddress=00-11-22-33-44-55' });
    expect(await client(baseUrl).raw('networkInformation', { mode: MODE.READ })).toEqual({
      returnCode: '0', ipAddress: '192.168.0.21', macAddress: '00-11-22-33-44-55',
    });
    expect(hits[0]!.action).toBe('networkInformation');
    expect(hits[0]!.method).toBe('GET');
  });

  it('판정을 우회하지 않는다 — 덤프가 오면 raw() 도 501 이다', async () => {
    const { baseUrl } = await mockCamera((_hit, res) => res.end('motion_type="rect"'));
    await expect(client(baseUrl).raw('whateverAction')).rejects.toMatchObject({ statusCode: 501 });
  });

  it('POST 도 고를 수 있고 파라미터는 본문으로 나간다', async () => {
    const { baseUrl, hits } = await mockByAction({ someWrite: 'returnCode=0' });
    await client(baseUrl).raw('someWrite', { mode: MODE.WRITE, value: 3 }, 'POST');
    expect(hits[0]!.method).toBe('POST');
    expect(hits[0]!.url).toBe('/cgi-bin/webSetup.cgi');
    expect(hits[0]!.params.get('value')).toBe('3');
  });
});

describe('HTTP 상태 판정', () => {
  it('500 은 502 계열 오류이고 501(미구현)로 오인되지 않는다', async () => {
    const { baseUrl } = await mockCamera((_hit, res) => { res.writeHead(500); res.end('boom'); });
    const error = await client(baseUrl).getPtz().catch((e: unknown) => e) as { statusCode: number; message: string };
    expect(error.statusCode).not.toBe(501);
    expect(error.message).toContain('HTTP 500');
  });

  it('403 은 인증·권한 갈래다', async () => {
    const { baseUrl } = await mockCamera((_hit, res) => { res.writeHead(403); res.end(); });
    await expect(client(baseUrl).getPtz()).rejects.toThrow(/계정·권한/);
  });
});

describe('T-ISO 서브트리 격리', () => {
  it('`contract.ts` 를 뺀 모든 파일에 `../` 로 시작하는 import 가 0개다', () => {
    const dir = join(process.cwd(), 'src', 'devices', 'idis');
    const offenders: Array<{ file: string; line: string }> = [];
    let scanned = 0;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      scanned += 1;
      if (name === 'contract.ts') continue;
      for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
        if (/from\s+['"]\.\.\//.test(line)) offenders.push({ file: name, line: line.trim() });
      }
    }
    expect(offenders).toEqual([]);
    expect(scanned).toBeGreaterThanOrEqual(8);   // 파일이 사라져 0개를 세고 통과하는 것을 막는다
  });

  it('`contract.ts` 는 반대로 `../` import 를 **갖고 있다** — 이관 지점이 정말 한 곳인지', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'devices', 'idis', 'contract.ts'), 'utf8');
    expect(/from\s+['"]\.\.\//.test(source)).toBe(true);
  });
});
