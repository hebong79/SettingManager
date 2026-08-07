import { spawn } from 'node:child_process';
import { jpegSize } from './jpegSize.js';

/**
 * JPEG → 그레이 래스터. **ffmpeg 외부 프로세스로 한다.**
 *
 * ## 왜 sharp 가 아닌가 (마스터 확정 2026-08-07)
 *
 * 상류(baro_calory `frame-match.mjs`)는 `sharp` 를 쓴다. 이 서비스는 런타임 npm 의존성을
 * 2개(MCP SDK·zod)로 유지하고 **ffmpeg 는 이미 하드 의존**이다(RTSP 전사에 쓴다). 그래서
 * 이미 있는 외부 프로세스 계약을 재사용한다 — 배포물이 커지지 않고 네이티브 빌드도 없다.
 *
 * 비용은 샘플당 spawn 2회(~80ms)다. 112샘플 스윕에서 **약 18초**이고, 그 스윕은 20분짜리다.
 * 상관 계산 자체는 상류와 같은 JS 이므로 **연산 비용은 동일하다**(상류도 sharp 는 디코딩에만 쓴다).
 *
 * ## ffmpeg 가 없는 기계
 *
 * 조용히 죽지 않는다. `probeFrameDecode()` 가 미리 물어보고, 없으면 **캘리브레이션 능력만**
 * 사유와 함께 꺼진다. 센터링·차량 3D 는 영향받지 않는다.
 */

export interface GrayFrame {
  data: Uint8Array;
  width: number;
  height: number;
}

export class FrameDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameDecodeError';
  }
}

export interface FrameDecoderOptions {
  ffmpegPath?: string;
  /** 한 장 디코딩의 상한. 프레임 한 장에 이보다 오래 걸리면 무언가 잘못된 것이다. */
  timeoutMs?: number;
}

export class FrameDecoder {
  private readonly ffmpegPath: string;
  private readonly timeoutMs: number;
  private probed?: Promise<{ ok: true } | { ok: false; reason: string }>;

  constructor(options: FrameDecoderOptions = {}) {
    this.ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /**
   * 이 기계에서 캘리브레이션이 설 수 있는가. 사유가 필요하면 문자열로 온다.
   *
   * **한 번만 묻고 기억한다.** `capabilities()` 는 화면이 주기적으로 폴링하는 경로라,
   * 물을 때마다 프로세스를 띄우면 버튼 하나 그리는 데 초당 여러 번 spawn 하게 된다.
   * ffmpeg 가 설치되고 말고는 프로세스 수명 안에서 바뀌지 않는 종류의 사실이다.
   */
  async probe(): Promise<{ ok: true } | { ok: false; reason: string }> {
    this.probed ??= run(this.ffmpegPath, ['-hide_banner', '-version'], Buffer.alloc(0), 5_000).then(
      () => ({ ok: true }) as const,
      (error: unknown) => ({
        ok: false,
        reason: `ffmpeg 를 실행할 수 없습니다 (${this.ffmpegPath}) — 캘리브레이션은 프레임 매칭에 JPEG 디코딩이 필요합니다: ${error instanceof Error ? error.message : String(error)}`,
      }) as const,
    );
    return this.probed;
  }

  /**
   * 한 장. **치수는 JPEG 헤더에서 읽고, 나온 바이트 수와 대조한다.**
   *
   * 그 단언이 이 함수의 안전장치다 — 헤더 파서와 ffmpeg 가 같은 그림을 봤다는 증거이고,
   * 어긋나면 계산을 이어 가는 대신 여기서 끊는다. 어긋난 채로 계속하면 착지 픽셀이 조용히
   * 틀린 좌표계로 나오고, 그 오염은 발행본까지 자기일관되게 흘러간다.
   */
  async toGray(jpeg: Buffer): Promise<GrayFrame> {
    const { width, height, progressive } = jpegSize(jpeg);
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      // 파일 확장자로 형식을 추측할 수 없는 파이프 입력이므로 명시한다.
      '-f', 'image2pipe',
      '-i', 'pipe:0',
      '-pix_fmt', 'gray',
      '-f', 'rawvideo',
      'pipe:1',
    ];
    const raw = await run(this.ffmpegPath, args, jpeg, this.timeoutMs);

    const expected = width * height;
    if (raw.length !== expected) {
      throw new FrameDecodeError(
        `디코딩 결과가 ${raw.length}바이트인데 헤더는 ${width}×${height}=${expected} 을 말합니다`
        + `${progressive ? ' (progressive JPEG 입니다)' : ''}`
        + ' — 두 해석이 갈렸으므로 이 프레임은 쓰지 않습니다',
      );
    }
    return { data: new Uint8Array(raw.buffer, raw.byteOffset, raw.length), width, height };
  }
}

/** stdin 으로 밀어 넣고 stdout 을 모은다. stderr 는 실패했을 때만 사유로 쓴다. */
function run(command: string, args: string[], input: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new FrameDecodeError(`ffmpeg 가 ${timeoutMs}ms 안에 끝나지 않았습니다`));
    }, timeoutMs);

    const finish = (error: Error | null, value?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };

    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    // 실행 파일이 아예 없을 때(ENOENT) 여기로 온다 — 종료 코드가 아니라 오류다.
    child.on('error', (cause) => finish(new FrameDecodeError(`ffmpeg 실행 실패: ${cause.message}`)));
    child.on('close', (code) => {
      if (code === 0) return finish(null, Buffer.concat(out));
      const detail = Buffer.concat(err).toString('utf8').trim().slice(0, 300);
      finish(new FrameDecodeError(`ffmpeg 가 코드 ${code} 로 끝났습니다${detail ? `: ${detail}` : ''}`));
    });

    // 입력을 다 받기 전에 ffmpeg 가 끝나면 EPIPE 가 난다 — 그건 위의 close 가 이미 사유를
    // 들고 있으므로 여기서 다시 던지지 않는다.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
