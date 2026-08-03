import { spawn } from 'node:child_process';
import type { CameraDriver } from '../devices/cameraDriver.js';
import type { CameraConfig, StreamingConfig } from '../config/types.js';
import { httpMjpegFrames } from './httpMjpeg.js';
import { splitJpegFrames } from './jpegFrames.js';
import { authenticatedRtspUrl, buildFfmpegArgs, safeRtspUrl } from './rtspUrl.js';

/**
 * 프레임 공급원. 세 경로가 있고 **화면에서는 구분되지 않는다**.
 *   1. `rtsp://` → ffmpeg 로 MJPEG 전사 (실카메라)
 *   2. `http://` → 연속 MJPEG 를 그대로 중계 (UE 시뮬의 직결 포트 — ffmpeg 불필요)
 *   3. 비움      → 스냅샷 폴링
 * 어느 쪽도 못 하면 던진다 — 검은 화면을 조용히 보여주지 않는다.
 */
export type FrameSource = (signal: AbortSignal) => AsyncGenerator<Buffer>;

export type StreamTransport = 'rtsp-ffmpeg' | 'http-mjpeg' | 'snapshot-poll';

/** 영상 URL 의 스킴이 경로를 정한다. 설정 화면과 서버가 같은 규칙을 쓰도록 여기 한 곳에 둔다. */
export function streamTransportFor(streamUrl: string): StreamTransport {
  const url = streamUrl.trim().toLowerCase();
  if (url.startsWith('rtsp://') || url.startsWith('rtsps://')) return 'rtsp-ffmpeg';
  if (url.startsWith('http://') || url.startsWith('https://')) return 'http-mjpeg';
  return 'snapshot-poll';
}

export function createFrameSource(camera: CameraConfig, driver: CameraDriver, streaming: StreamingConfig): FrameSource {
  switch (streamTransportFor(camera.streamUrl)) {
    case 'rtsp-ffmpeg':
      return (signal) => rtspFrames(camera, streaming, signal);
    case 'http-mjpeg':
      return (signal) =>
        httpMjpegFrames(
          {
            url: camera.streamUrl,
            username: camera.username,
            password: camera.password,
            startupTimeoutMs: streaming.startupTimeoutMs,
          },
          signal,
        );
    default:
      return (signal) => snapshotFrames(driver, streaming.fps, signal);
  }
}

/** RTSP → ffmpeg → JPEG 프레임. */
export async function* rtspFrames(
  camera: CameraConfig,
  streaming: StreamingConfig,
  signal: AbortSignal,
): AsyncGenerator<Buffer> {
  if (signal.aborted) return;
  const inputUrl = authenticatedRtspUrl(camera.streamUrl, camera.username, camera.password);
  const args = buildFfmpegArgs(inputUrl, streaming);

  const child = spawn(streaming.ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  const frames: Buffer[] = [];
  let rest: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr = '';
  let finished = false;
  let firstFrame = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;

  const notify = (): void => {
    const current = wake;
    wake = undefined;
    current?.();
  };
  const fail = (error: Error): void => {
    failure ??= error;
    finished = true;
    if (!child.killed) child.kill();
    notify();
  };

  const startupTimer = setTimeout(() => {
    fail(new Error(`RTSP 첫 프레임 시간 초과: ${safeRtspUrl(inputUrl)}`));
  }, streaming.startupTimeoutMs);

  const onStdout = (chunk: Buffer): void => {
    const parsed = splitJpegFrames(Buffer.concat([rest, chunk]));
    rest = parsed.rest;
    if (parsed.frames.length === 0) return;
    if (!firstFrame) {
      firstFrame = true;
      clearTimeout(startupTimer);
    }
    frames.push(...parsed.frames.map((frame) => Buffer.from(frame)));
    notify();
  };
  const onStderr = (chunk: Buffer): void => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4096);
  };
  const onError = (cause: Error): void => {
    const notFound = (cause as NodeJS.ErrnoException).code === 'ENOENT';
    fail(new Error(notFound ? `ffmpeg 를 찾을 수 없습니다: ${streaming.ffmpegPath}` : `ffmpeg 실행 오류: ${cause.message}`));
  };
  const onClose = (code: number | null): void => {
    clearTimeout(startupTimer);
    finished = true;
    if (!signal.aborted && !firstFrame && !failure) {
      failure = new Error(`RTSP 스트림 시작 실패 (ffmpeg ${code ?? '?'}): ${cleanError(stderr, inputUrl, camera.password)}`);
    }
    notify();
  };
  const onAbort = (): void => {
    finished = true;
    if (!child.killed) child.kill();
    notify();
  };

  child.stdout.on('data', onStdout);
  child.stderr.on('data', onStderr);
  child.once('error', onError);
  child.once('close', onClose);
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      if (frames.length > 0) {
        yield frames.shift()!;
        continue;
      }
      if (failure) throw failure;
      if (finished || signal.aborted) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    clearTimeout(startupTimer);
    signal.removeEventListener('abort', onAbort);
    child.stdout.off('data', onStdout);
    child.stderr.off('data', onStderr);
    child.off('error', onError);
    child.off('close', onClose);
    if (!child.killed) child.kill();
  }
}

/** 스냅샷 폴링. RTSP 가 없는 기기의 유일하게 정직한 프리뷰다. */
export async function* snapshotFrames(driver: CameraDriver, fps: number, signal: AbortSignal): AsyncGenerator<Buffer> {
  const intervalMs = Math.max(50, Math.round(1000 / Math.max(1, fps)));
  while (!signal.aborted) {
    const started = Date.now();
    yield await driver.getSnapshot();
    const wait = intervalMs - (Date.now() - started);
    if (wait > 0) await sleep(wait, signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function cleanError(message: string, inputUrl: string, password: string): string {
  let cleaned = message.replaceAll(inputUrl, safeRtspUrl(inputUrl));
  if (password) cleaned = cleaned.replaceAll(password, '***');
  return cleaned.trim().replace(/\s+/g, ' ').slice(0, 300);
}
