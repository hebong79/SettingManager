import { describe, expect, it, vi } from 'vitest';
import { HucomsClient } from '../src/devices/hucoms/hucomsClient.js';
import { CameraDriverError } from '../src/devices/cameraDriver.js';
import { parseHucomsText, requireInt } from '../src/devices/hucoms/hucomsText.js';

/**
 * 와이어 근거:
 *   AgentVLA/ParkAgent/SettingAgent/src/clients/hucoms/HucomsClient.ts (CGI 경로·파라미터·인증)
 *   baro_calory/docs/cameras.md §Hucoms — HTTP CGI (좌표 범위·평문 쿼리 인증)
 * 실기 응답 예시는 SettingAgent parser.ts 가 다루는 `key = value` 형식을 따른다.
 */

const PTZ_BODY = '[PTZF]\r\npanpos = 3844\r\ntiltpos = 1188\r\nzoompos = 10711\r\nfocuspos = 512\r\n';

function client(fetchImpl: typeof fetch) {
  return new HucomsClient({
    cameraId: 'cam-a',
    baseUrl: 'http://10.0.0.1:80',
    username: 'admin',
    password: 'secret',
    timeoutMs: 3000,
    fetchImpl,
  });
}

function textResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
}

describe('parseHucomsText', () => {
  it('key = value 를 읽고 섹션 머리글은 건너뛴다', () => {
    expect(parseHucomsText(PTZ_BODY).values).toMatchObject({ panpos: '3844', tiltpos: '1188', zoompos: '10711' });
  });

  it('본문의 Error: 를 오류로 잡는다 — HTTP 200 으로 오므로 상태코드만 보면 조용히 틀린다', () => {
    expect(parseHucomsText('Error: Invalid ID or Password').errorMessage).toBe('Invalid ID or Password');
  });

  it('값 뒤의 * 주석을 잘라낸다', () => {
    expect(parseHucomsText('panpos = 100 * 0~35999').values.panpos).toBe('100');
  });

  it('없는 필드를 요구하면 던진다 — 0 으로 대체하면 카메라가 원점으로 간다', () => {
    expect(() => requireInt(parseHucomsText('a = 1'), 'panpos')).toThrow(/panpos/);
  });
});

describe('HucomsClient.getPtz', () => {
  it('getptzfpos 를 호출하고 세 축을 정수로 돌려준다', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => textResponse(PTZ_BODY));
    const ptz = await client(fetchImpl as unknown as typeof fetch).getPtz();

    expect(ptz).toEqual({ pan: 3844, tilt: 1188, zoom: 10711 });
    const url = new URL(fetchImpl.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/cgi-bin/control/ptzf_status.cgi');
    expect(url.searchParams.get('action')).toBe('getptzfpos');
    expect(url.searchParams.get('id')).toBe('admin');
    expect(url.searchParams.get('passwd')).toBe('secret');
  });

  it('본문 오류를 502 로 올린다', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => textResponse('Error: apictrlstatus disabled'));
    await expect(client(fetchImpl as unknown as typeof fetch).getPtz()).rejects.toThrow(/apictrlstatus disabled/);
  });

  it('HTTP 오류를 그대로 흘리지 않고 드라이버 오류로 감싼다', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('nope', { status: 401, statusText: 'Unauthorized' }));
    await expect(client(fetchImpl as unknown as typeof fetch).getPtz()).rejects.toBeInstanceOf(CameraDriverError);
  });
});

describe('HucomsClient.goPtz', () => {
  it('goptzfpos 로 세 축과 속도를 보낸다', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => textResponse('rc = 0\r\n'));
    await client(fetchImpl as unknown as typeof fetch).goPtz({ pan: 1000, tilt: 500, zoom: 8000 }, 30);

    const url = new URL(fetchImpl.mock.calls[0]![0] as string);
    expect(url.searchParams.get('action')).toBe('goptzfpos');
    expect(url.searchParams.get('panpos')).toBe('1000');
    expect(url.searchParams.get('tiltpos')).toBe('500');
    expect(url.searchParams.get('zoompos')).toBe('8000');
    expect(url.searchParams.get('panspeed')).toBe('30');
  });

  it('도달범위 밖 목표는 보내기 전에 자른다 — 기기는 성공이라 답하며 조용히 다른 데로 간다', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => textResponse('rc = 0\r\n'));
    await client(fetchImpl as unknown as typeof fetch).goPtz({ pan: 36100, tilt: 12000, zoom: 99999 });

    const url = new URL(fetchImpl.mock.calls[0]![0] as string);
    expect(url.searchParams.get('panpos')).toBe('100');
    expect(url.searchParams.get('tiltpos')).toBe('9000');
    expect(url.searchParams.get('zoompos')).toBe('65535');
  });
});

describe('HucomsClient.centerPoint', () => {
  it('Hucoms 공식 point-centering CGI에 1920×1080 논리 좌표를 보낸다', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => textResponse('rc = 0'));
    await client(fetchImpl as unknown as typeof fetch).centerPoint({ x: 1400, y: 800 });

    const url = new URL(fetchImpl.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/cgi-bin/control/ptz_centering.cgi');
    expect(url.searchParams.get('action')).toBe('setcenter');
    expect(url.searchParams.get('type')).toBe('point');
    expect(url.searchParams.get('center.pointx')).toBe('1400');
    expect(url.searchParams.get('center.pointy')).toBe('800');
    expect(url.searchParams.get('id')).toBe('admin');
    expect(url.searchParams.get('passwd')).toBe('secret');
  });

  it.each([{ x: -1, y: 0 }, { x: 1921, y: 0 }, { x: 0, y: 1081 }, { x: 1.5, y: 0 }])('프레임 밖 또는 소수 좌표 %j는 전송 전에 거부한다', async (point) => {
    const fetchImpl = vi.fn();
    await expect(client(fetchImpl as unknown as typeof fetch).centerPoint(point)).rejects.toThrow(/1920×1080/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('HucomsClient.getSnapshot', () => {
  it('JPEG SOI 가 있으면 그대로 돌려준다', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(jpeg, { status: 200 }));
    const body = await client(fetchImpl as unknown as typeof fetch).getSnapshot();
    expect(body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it('인증 실패는 200 + text 로 오므로 JPEG 여부로 판정한다', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => textResponse('Error: Invalid ID or Password'));
    await expect(client(fetchImpl as unknown as typeof fetch).getSnapshot()).rejects.toThrow(/JPEG/);
  });
});

describe('HucomsClient 오류 문구', () => {
  it('통신 오류 메시지에서 비밀번호를 가린다', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      throw new Error('connect failed to http://10.0.0.1?passwd=secret');
    });
    await expect(client(fetchImpl as unknown as typeof fetch).getPtz()).rejects.toThrow(/\*\*\*/);
  });

  it('제어 URL 이 비어 있으면 조립 시점에 400 으로 던진다', () => {
    expect(() => new HucomsClient({ cameraId: 'x', baseUrl: '', username: '', password: '', timeoutMs: 1000 })).toThrow(/제어 URL/);
  });
});

describe('HucomsClient.listSlots', () => {
  it('Hucoms 기기는 주차면 개념이 없어 빈 목록이다 (오류가 아니다)', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => textResponse(''));
    await expect(client(fetchImpl as unknown as typeof fetch).listSlots()).resolves.toEqual([]);
  });
});
