/** RTSP URL 조립·마스킹. 순수 함수라 유닛 테스트가 실제 스트림 없이 검증한다. */

export class RtspUrlError extends Error {}

/** URL 에 계정이 없을 때만 설정 계정을 주입한다(URL 에 적힌 것이 우선). */
export function authenticatedRtspUrl(raw: string, username?: string, password?: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new RtspUrlError('RTSP URL 형식이 올바르지 않습니다', { cause });
  }
  if (!['rtsp:', 'rtsps:'].includes(url.protocol)) {
    throw new RtspUrlError('RTSP URL 은 rtsp:// 또는 rtsps:// 여야 합니다');
  }
  if (!url.username && username) url.username = encodeURIComponent(username);
  if (!url.password && password) url.password = encodeURIComponent(password);
  return url.toString();
}

/** 로그·오류 문구용. 계정 정보는 항상 지운다. */
export function safeRtspUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return '<invalid-rtsp-url>';
  }
}

export function buildFfmpegArgs(
  inputUrl: string,
  options: { rtspTransport: 'tcp' | 'udp'; fps: number; jpegQuality: number },
): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-rtsp_transport', options.rtspTransport,
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    // 카메라 타임스탬프를 믿지 않는다 — RTP 타임스탬프가 실제 프레임률과 다르면 기본 CFR
    // 동기화가 빈 자리를 복제 프레임으로 채워 대역폭이 같은 그림에 쓰인다.
    // 근거: baro_calory/docs/cameras.md §RTSP 타임스탬프는 믿지 않습니다
    '-use_wallclock_as_timestamps', '1',
    '-i', inputUrl,
    '-an',
    '-fps_mode', 'vfr',
    '-vf', `fps=${options.fps}`,
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-q:v', String(options.jpegQuality),
    'pipe:1',
  ];
}
