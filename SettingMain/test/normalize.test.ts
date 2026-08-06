import { describe, expect, it } from 'vitest';
import { ConfigError, mergeSettings, normalizeCamera, normalizeConfig, toPublicCamera } from '../src/config/normalize.js';
import type { AppConfig } from '../src/config/types.js';

function baseConfig(): AppConfig {
  return normalizeConfig({
    server: { host: '127.0.0.1', port: 13030 },
    simulator: { baseUrl: 'http://127.0.0.1:8080/' },
    activeCameraId: 'cam-a',
    cameras: [
      { id: 'cam-a', label: '리얼 1', kind: 'hucoms', controlUrl: 'http://10.0.0.1:80', username: 'admin', password: 'secret', streamUrl: 'rtsp://10.0.0.1:554/stream1', timeoutMs: 5000 },
      { id: 'cam-b', label: '시뮬', kind: 'backend-core', controlUrl: '', username: '', password: '', streamUrl: '', timeoutMs: 5000 },
    ],
  });
}

/**
 * **카메라는 여기서 검사하지 않는다.** 정본이 `camera_info`(DB)로 옮겨지면서
 * `normalizeConfig` 는 빈 배열을 두고, `ConfigStore.load()` 가 DB 로 채운다.
 * "카메라가 0대면 기동 못 함"·"활성이 목록 밖이면 첫 기기로" 규칙은 그 자리로 갔다
 * (`ConfigStore.pickActive` · `test/dbRoutes.test.ts`).
 */
describe('normalizeConfig', () => {
  it('후행 슬래시를 떼어 URL 을 정규화한다 — 경로 조립에서 //api 가 되는 것을 막는다', () => {
    expect(baseConfig().simulator.baseUrl).toBe('http://127.0.0.1:8080');
  });



  it('알 수 없는 kind 는 hucoms 로 본다', () => {
    expect(normalizeCamera({ id: 'x', kind: 'onvif' })?.kind).toBe('hucoms');
  });

  it('id 가 없는 항목은 등록하지 않는다', () => {
    expect(normalizeCamera({ label: '이름만' })).toBeNull();
  });

  it('스트리밍 기본값을 채운다', () => {
    const { streaming } = normalizeConfig({ cameras: [{ id: 'cam-a' }] });
    expect(streaming).toMatchObject({ ffmpegPath: 'ffmpeg', rtspTransport: 'tcp', fps: 5 });
  });

  it('범위 밖 fps 는 기동을 죽이지 않고 잘린다', () => {
    expect(normalizeConfig({ cameras: [{ id: 'a' }], streaming: { fps: 999 } }).streaming.fps).toBe(30);
  });

  it('옛 이름 rtspUrl 도 streamUrl 로 읽는다 — 기존 설정 파일이 그대로 열려야 한다', () => {
    expect(normalizeCamera({ id: 'x', rtspUrl: 'rtsp://10.0.0.1:554/s' })?.streamUrl).toBe('rtsp://10.0.0.1:554/s');
  });

  it('streamUrl 이 있으면 그쪽이 이긴다', () => {
    const camera = normalizeCamera({ id: 'x', rtspUrl: 'rtsp://old/s', streamUrl: 'http://192.168.0.22:8091/' });
    expect(camera?.streamUrl).toBe('http://192.168.0.22:8091/');
  });

  it('시뮬레이터의 HTTP 영상 URL 도 그대로 보존한다 — rtsp 로 강제하지 않는다', () => {
    expect(normalizeCamera({ id: 'sim', streamUrl: 'http://192.168.0.22:8093/' })?.streamUrl).toBe('http://192.168.0.22:8093/');
  });
});

describe('park3d-rpc 카메라', () => {
  it('kind 와 camId 가 정규화를 통과한다', () => {
    const camera = normalizeCamera({ id: 'sim-2', kind: 'park3d-rpc', camId: '2' });
    expect(camera).toMatchObject({ kind: 'park3d-rpc', camId: 2 });
  });

  it('camId 가 유효하지 않으면 키 자체를 만들지 않는다 — 1 로 보정하면 엉뚱한 카메라를 움직인다', () => {
    for (const bad of [0, -1, 'abc', 1.5]) {
      expect(normalizeCamera({ id: 'x', kind: 'park3d-rpc', camId: bad })).not.toHaveProperty('camId');
    }
  });

  it('알 수 없는 kind 는 hucoms 로 떨어진다', () => {
    expect(normalizeCamera({ id: 'x', kind: 'onvif' })?.kind).toBe('hucoms');
  });
});

describe('toPublicCamera — 비밀번호는 절대 나가지 않는다', () => {
  const camera = () => normalizeCamera({ id: 'cam-a', label: '리얼', controlUrl: 'http://10.0.0.1', username: 'admin', password: 'secret' })!;

  it('password 필드가 사라지고 보유 여부만 남는다', () => {
    const publicCamera = toPublicCamera(camera());
    expect(publicCamera).not.toHaveProperty('password');
    expect(publicCamera.hasPassword).toBe(true);
  });

  it('비밀번호가 없으면 hasPassword 가 false', () => {
    expect(toPublicCamera(normalizeCamera({ id: 'x' })!).hasPassword).toBe(false);
  });
});

/**
 * `mergeSettings` 의 **카메라 병합 테스트는 여기서 사라졌다** — 카메라의 정본이 `camera_info` 로
 * 옮겨지면서 그 병합이 `PUT /api/db/cameras/:id` 로 갔기 때문이다. 빈 비밀번호가 기존 값을
 * 지키는 규칙, 영상 URL 을 비우면 실제로 비워지는 규칙은 `test/dbRoutes.test.ts` 가 이어받는다.
 */
describe('mergeSettings — 카메라가 아닌 설정', () => {
  const base = () => normalizeConfig({ simulator: { baseUrl: 'http://old' }, core: { provider: 'bridge' }, activeCameraId: '' });

  it('시뮬레이터 URL 을 바꾼다', () => {
    expect(mergeSettings(base(), { simulator: { baseUrl: 'http://new/' } }).simulator.baseUrl).toBe('http://new');
  });

  it('코어 구현을 바꾼다', () => {
    expect(mergeSettings(base(), { core: { provider: 'remote' } }).core.provider).toBe('remote');
  });

  it('등록되지 않은 카메라를 활성으로 지정하면 404 로 거절한다', () => {
    expect(() => mergeSettings(base(), { activeCameraId: 'ghost' })).toThrow(expect.objectContaining({ statusCode: 404 }));
  });
});

/**
 * `addCamera`·`removeCamera` 테스트는 여기서 사라졌다 — 카메라의 정본이 `camera_info` 로
 * 옮겨지면서 그 두 함수가 `POST·DELETE /api/db/cameras` 로 갔기 때문이다.
 * ID 규칙·중복 409·마지막 1대 보호는 `test/dbRoutes.test.ts` 가 이어받는다.
 */
