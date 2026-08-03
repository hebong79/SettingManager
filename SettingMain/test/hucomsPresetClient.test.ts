import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HucomsPresetClient } from '../src/devices/hucoms/hucomsPresetClient.js';

let socketServer: Server | undefined;
let receivedRequest = '';

async function direct(body: string, status = 200): Promise<HucomsPresetClient> {
  socketServer = createServer((socket) => {
    socket.once('data', (request) => {
      receivedRequest = request.toString('utf8');
      socket.end(`HTTP/1.1 ${status} Test\nContent-Type: text/plain\nContent-Length: ${Buffer.byteLength(body)}\n\n${body}`);
    });
  });
  await new Promise<void>((resolve) => socketServer!.listen(0, '127.0.0.1', resolve));
  const port = (socketServer.address() as AddressInfo).port;
  return new HucomsPresetClient({ baseUrl: `http://127.0.0.1:${port}/ignored`, username: 'admin', password: 's ecret', timeoutMs: 500 });
}

afterEach(async () => {
  if (socketServer) await new Promise<void>((resolve) => socketServer!.close(() => resolve()));
  socketServer = undefined;
  receivedRequest = '';
});

describe('HucomsPresetClient', () => {
  it.each([
    ['Yes', null, 255],
    ['No', null, 0],
    ['1', 1, 1],
    ['255', 255, 255],
  ])('LF-only 장비 header와 PresetSupported=%s 를 직접 읽는다', async (raw, advertised, usable) => {
    const client = await direct(`PresetSupported = ${raw}\n`);
    const capability = await client.getCapability();
    expect(receivedRequest).toContain('GET /cgi-bin/control/capabilityptz.cgi?id=admin&passwd=s+ecret&action=getPTZ HTTP/1.1');
    expect(capability).toMatchObject({ supported: raw !== 'No', advertisedMaxPresetNumber: advertised, usableMaxPresetNumber: usable });
    expect(capability.slots).toHaveLength(usable);
    if (usable) expect(capability.slots.at(-1)).toEqual({ index: usable, registration: 'unknown', name: null });
  });

  it.each(['', '0', '256', 'oops'])('잘못된 값 %j 은 fail-safe 계약 오류다', async (raw) => {
    const client = await direct(`PresetSupported = ${raw}\n`);
    await expect(client.getCapability()).rejects.toThrow(/PresetSupported/);
  });

  it('장비 오류 본문에서도 비밀번호를 노출하지 않는다', async () => {
    const client = await direct('Error: failed passwd=s%20ecret\n');
    await expect(client.getCapability()).rejects.toThrow(/\*\*\*/);
    await expect(client.getCapability()).rejects.not.toThrow(/s ecret|s%20ecret/);
  });

  it('http(s)가 아니거나 query가 섞인 base URL은 거부한다', () => {
    expect(() => new HucomsPresetClient({ baseUrl: 'ftp://camera', username: '', password: '', timeoutMs: 10 })).toThrow(/http/);
    expect(() => new HucomsPresetClient({ baseUrl: 'http://camera/?action=other', username: '', password: '', timeoutMs: 10 })).toThrow(/query/);
  });

  it('gopreset은 제공 계약의 number query만 전송한다', async () => {
    const client = await direct('rc = 0\n');
    await client.goPreset(7);
    expect(receivedRequest).toContain('GET /cgi-bin/control/preset_control.cgi?id=admin&passwd=s+ecret&action=gopreset&number=7 HTTP/1.1');
    expect(receivedRequest).not.toContain('setpreset');
  });

  it('getptzfpos와 goptzfpos는 raw 좌표와 일반 PTZ 기본 속도 50 계약을 쓴다', async () => {
    const readClient = await direct('panpos = 100\ntiltpos = -200\nzoompos = 300\n');
    await expect(readClient.getPtz()).resolves.toEqual({ pan: 100, tilt: -200, zoom: 300 });
    expect(receivedRequest).toContain('action=getptzfpos');
    await new Promise<void>((resolve) => socketServer!.close(() => resolve()));
    socketServer = undefined;
    const moveClient = await direct('rc = 0\n');
    await moveClient.goPtz({ pan: 100, tilt: -200, zoom: 300 });
    expect(receivedRequest).toContain('action=goptzfpos&panpos=100&tiltpos=-200&zoompos=300&panspeed=50&tiltspeed=50&zoomspeed=50');
  });
});
