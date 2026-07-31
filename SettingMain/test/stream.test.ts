import { describe, expect, it, vi } from 'vitest';
import { streamTransportFor } from '../src/stream/frameSource.js';
import { authenticatedHttpUrl, httpMjpegFrames, HttpMjpegError, safeHttpUrl } from '../src/stream/httpMjpeg.js';
import { splitJpegFrames } from '../src/stream/jpegFrames.js';
import { authenticatedRtspUrl, buildFfmpegArgs, RtspUrlError, safeRtspUrl } from '../src/stream/rtspUrl.js';

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const frame = (marker: number) => Buffer.from([...SOI, marker, ...EOI]);

describe('splitJpegFrames', () => {
  it('완결된 프레임만 잘라낸다', () => {
    const { frames, rest } = splitJpegFrames(Buffer.concat([frame(1), frame(2)]));
    expect(frames).toHaveLength(2);
    expect(rest).toHaveLength(0);
  });

  it('잘린 꼬리는 rest 로 남겨 다음 청크와 이어 붙인다 — 이게 없으면 프레임이 절반씩 깨진다', () => {
    const stream = Buffer.concat([frame(1), Buffer.from([...SOI, 0x99])]);
    const first = splitJpegFrames(stream);
    expect(first.frames).toHaveLength(1);
    expect(first.rest).toHaveLength(3);

    const second = splitJpegFrames(Buffer.concat([first.rest, Buffer.from(EOI)]));
    expect(second.frames).toHaveLength(1);
    expect(second.frames[0]).toEqual(Buffer.from([...SOI, 0x99, ...EOI]));
  });

  it('SOI 앞의 쓰레기 바이트를 버린다', () => {
    const { frames } = splitJpegFrames(Buffer.concat([Buffer.from([0x00, 0x11]), frame(1)]));
    expect(frames).toHaveLength(1);
  });

  it('빈 입력은 빈 결과다', () => {
    expect(splitJpegFrames(Buffer.alloc(0))).toEqual({ frames: [], rest: Buffer.alloc(0) });
  });
});

describe('authenticatedRtspUrl', () => {
  it('URL 에 계정이 없을 때만 설정 계정을 주입한다', () => {
    expect(authenticatedRtspUrl('rtsp://10.0.0.1:554/stream1', 'admin', 'pw')).toBe('rtsp://admin:pw@10.0.0.1:554/stream1');
  });

  it('URL 에 적힌 계정이 우선이다', () => {
    expect(authenticatedRtspUrl('rtsp://u:p@10.0.0.1:554/s', 'admin', 'pw')).toBe('rtsp://u:p@10.0.0.1:554/s');
  });

  it('rtsp 가 아니면 던진다 — http 를 넘기면 ffmpeg 가 알 수 없는 이유로 실패한다', () => {
    expect(() => authenticatedRtspUrl('http://10.0.0.1/stream')).toThrow(RtspUrlError);
  });

  it('형식이 깨지면 던진다', () => {
    expect(() => authenticatedRtspUrl('not a url')).toThrow(RtspUrlError);
  });
});

describe('safeRtspUrl — 로그에 계정이 새지 않게 한다', () => {
  it('userinfo 를 지운다', () => {
    expect(safeRtspUrl('rtsp://admin:pw@10.0.0.1:554/s')).toBe('rtsp://10.0.0.1:554/s');
  });

  it('깨진 URL 도 문자열을 그대로 흘리지 않는다', () => {
    expect(safeRtspUrl('rtsp://admin:pw@')).toBe('<invalid-rtsp-url>');
  });
});

describe('buildFfmpegArgs', () => {
  const args = buildFfmpegArgs('rtsp://x/s', { rtspTransport: 'tcp', fps: 5, jpegQuality: 5 });

  it('카메라 타임스탬프를 믿지 않는 인자를 짝으로 넣는다 (근거: baro_calory/docs/cameras.md §RTSP 타임스탬프)', () => {
    expect(args).toContain('-use_wallclock_as_timestamps');
    expect(args[args.indexOf('-use_wallclock_as_timestamps') + 1]).toBe('1');
    expect(args).toContain('-fps_mode');
    expect(args[args.indexOf('-fps_mode') + 1]).toBe('vfr');
  });

  it('MJPEG image2pipe 로 내보낸다', () => {
    expect(args.slice(-5)).toEqual(['-vcodec', 'mjpeg', '-q:v', '5', 'pipe:1']);
  });

  it('전송 방식과 fps 가 설정대로 실린다', () => {
    expect(args[args.indexOf('-rtsp_transport') + 1]).toBe('tcp');
    expect(args).toContain('fps=5');
  });
});

describe('streamTransportFor — 영상 URL 의 스킴이 경로를 가른다', () => {
  it('rtsp 는 ffmpeg 전사', () => {
    expect(streamTransportFor('rtsp://10.0.0.1:554/stream1')).toBe('rtsp-ffmpeg');
    expect(streamTransportFor('rtsps://10.0.0.1:554/s')).toBe('rtsp-ffmpeg');
  });

  it('http 는 MJPEG 중계 — UE 시뮬은 RTSP 서버가 없고 직결 포트로 MJPEG 를 준다', () => {
    expect(streamTransportFor('http://192.168.0.22:8093/')).toBe('http-mjpeg');
    expect(streamTransportFor('https://cam/stream')).toBe('http-mjpeg');
  });

  it('대문자·공백이 섞여도 같은 판정이다', () => {
    expect(streamTransportFor('  RTSP://10.0.0.1/s ')).toBe('rtsp-ffmpeg');
    expect(streamTransportFor(' HTTP://192.168.0.22:8091/ ')).toBe('http-mjpeg');
  });

  it('비어 있으면 스냅샷 폴링', () => {
    expect(streamTransportFor('')).toBe('snapshot-poll');
    expect(streamTransportFor('   ')).toBe('snapshot-poll');
  });
});

describe('authenticatedHttpUrl', () => {
  it('계정이 있고 URL 에 없을 때만 Hucoms 평문 인증을 붙인다 — CGI 경로는 이게 없으면 401', () => {
    const url = new URL(authenticatedHttpUrl('http://192.168.0.22:8083/cgi-bin/image/mjpeg.cgi', 'admin', 'pw'));
    expect(url.searchParams.get('id')).toBe('admin');
    expect(url.searchParams.get('passwd')).toBe('pw');
  });

  it('URL 에 이미 적힌 계정이 우선이다', () => {
    const url = new URL(authenticatedHttpUrl('http://sim/s?id=other&passwd=x', 'admin', 'pw'));
    expect(url.searchParams.get('id')).toBe('other');
  });

  it('계정이 없으면 아무것도 붙이지 않는다 — 직결 MJPEG 포트는 쿼리가 필요 없다', () => {
    expect(authenticatedHttpUrl('http://192.168.0.22:8091/')).toBe('http://192.168.0.22:8091/');
  });

  it('rtsp 를 넘기면 던진다', () => {
    expect(() => authenticatedHttpUrl('rtsp://10.0.0.1/s')).toThrow(HttpMjpegError);
  });
});

describe('safeHttpUrl — 로그에 비밀번호가 새지 않게 한다', () => {
  it('passwd 쿼리를 가린다', () => {
    expect(safeHttpUrl('http://sim/s?id=admin&passwd=secret')).toContain('passwd=***');
  });
});

describe('httpMjpegFrames', () => {
  /** 실측 근거: http://192.168.0.22:8091/ → multipart/x-mixed-replace; boundary=baroframe */
  function multipartBody(frames: Buffer[]): Buffer {
    const parts = frames.flatMap((frame) => [
      Buffer.from('--baroframe\r\nContent-Type: image/jpeg\r\n\r\n'),
      frame,
      Buffer.from('\r\n'),
    ]);
    return Buffer.concat(parts);
  }

  const jpeg = (marker: number) => Buffer.from([0xff, 0xd8, 0xff, marker, 0xff, 0xd9]);

  function streamResponse(body: Buffer, chunkSize: number): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < body.length; i += chunkSize) controller.enqueue(body.subarray(i, i + chunkSize));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'multipart/x-mixed-replace; boundary=baroframe' } });
  }

  async function collect(response: Response, chunkNote = ''): Promise<Buffer[]> {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response);
    const frames: Buffer[] = [];
    for await (const frame of httpMjpegFrames(
      { url: `http://192.168.0.22:8091/${chunkNote}`, startupTimeoutMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch },
      new AbortController().signal,
    )) {
      frames.push(frame);
    }
    return frames;
  }

  it('multipart 헤더를 파싱하지 않고 JPEG 경계로 끊는다 — boundary 이름이 무엇이든 동작한다', async () => {
    const frames = await collect(streamResponse(multipartBody([jpeg(1), jpeg(2), jpeg(3)]), 4096));
    expect(frames).toHaveLength(3);
    expect(frames[0]).toEqual(jpeg(1));
  });

  it('청크 경계가 프레임 중간을 잘라도 프레임이 깨지지 않는다', async () => {
    const frames = await collect(streamResponse(multipartBody([jpeg(1), jpeg(2)]), 3));
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual(jpeg(2));
  });

  it('HTTP 오류는 던진다 — 검은 화면을 조용히 보여주지 않는다', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('nope', { status: 404 }));
    const iterator = httpMjpegFrames(
      { url: 'http://sim/x', startupTimeoutMs: 500, fetchImpl: fetchImpl as unknown as typeof fetch },
      new AbortController().signal,
    );
    await expect(iterator.next()).rejects.toThrow(/404/);
  });

  it('연결 실패도 던진다', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      throw new Error('ECONNREFUSED');
    });
    const iterator = httpMjpegFrames(
      { url: 'http://sim/x', startupTimeoutMs: 500, fetchImpl: fetchImpl as unknown as typeof fetch },
      new AbortController().signal,
    );
    await expect(iterator.next()).rejects.toThrow(/영상 연결 실패/);
  });

  it('이미 취소된 신호면 아무것도 하지 않는다', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();
    const frames = [];
    for await (const frame of httpMjpegFrames(
      { url: 'http://sim/x', startupTimeoutMs: 500, fetchImpl: fetchImpl as unknown as typeof fetch },
      controller.signal,
    )) {
      frames.push(frame);
    }
    expect(frames).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
