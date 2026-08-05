import { describe, expect, it } from 'vitest';
import { addCamera, ConfigError, mergeSettings, normalizeCamera, normalizeConfig, removeCamera, toPublicCamera } from '../src/config/normalize.js';
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

describe('normalizeConfig', () => {
  it('후행 슬래시를 떼어 URL 을 정규화한다 — 경로 조립에서 //api 가 되는 것을 막는다', () => {
    expect(baseConfig().simulator.baseUrl).toBe('http://127.0.0.1:8080');
  });

  it('카메라가 없으면 던진다 — 조작할 대상이 없는 설정은 기동시킬 수 없다', () => {
    expect(() => normalizeConfig({ cameras: [] })).toThrow(ConfigError);
  });

  it('activeCameraId 가 목록에 없으면 첫 카메라로 떨어진다', () => {
    const config = normalizeConfig({ activeCameraId: 'ghost', cameras: [{ id: 'cam-a' }] });
    expect(config.activeCameraId).toBe('cam-a');
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
  it('kind 로 인정한다 — 알 수 없는 kind 를 hucoms 로 떨어뜨리는 규칙에 걸리지 않는다', () => {
    expect(normalizeCamera({ id: 'x', kind: 'park3d-rpc' })?.kind).toBe('park3d-rpc');
  });

  it('camId 는 문자열로 와도 양의 정수로 읽는다', () => {
    expect(normalizeCamera({ id: 'x', kind: 'park3d-rpc', camId: '2' })?.camId).toBe(2);
  });

  it('유효하지 않은 camId 는 보정하지 않고 필드를 만들지 않는다 — 1 로 때우면 엉뚱한 카메라를 움직인다', () => {
    for (const bad of [0, -1, 1.5, 'abc', '', null]) {
      const camera = normalizeCamera({ id: 'x', kind: 'park3d-rpc', camId: bad });
      expect(camera).not.toHaveProperty('camId');
    }
  });

  it('park3d-rpc 가 아닌 카메라에는 camId 키가 생기지 않는다', () => {
    expect(normalizeCamera({ id: 'x', kind: 'hucoms' })).not.toHaveProperty('camId');
  });

  it('설정에 옛 token 값이 남아 있어도 조용히 버린다 — 이 종류는 인증을 쓰지 않는다', () => {
    expect(normalizeCamera({ id: 'x', kind: 'park3d-rpc', token: 'apark3d' })).not.toHaveProperty('token');
  });

  it('저장(병합)을 거쳐도 kind 와 camId 가 유지된다', () => {
    const config = normalizeConfig({
      activeCameraId: 'sim-2',
      cameras: [{ id: 'sim-2', kind: 'park3d-rpc', controlUrl: 'http://192.168.0.125:13510', streamUrl: 'http://192.168.0.125:13510/stream', camId: 1 }],
    });
    const next = mergeSettings(config, { cameras: [{ id: 'sim-2', label: '이름만 변경' }] });
    expect(next.cameras[0]).toMatchObject({ kind: 'park3d-rpc', camId: 1, label: '이름만 변경' });
  });

  it('camId 는 비밀이 아니므로 공개 응답에 그대로 실린다 — 값이 있는 카메라에만', () => {
    const camera = normalizeCamera({ id: 'sim-2', kind: 'park3d-rpc', camId: 1 })!;
    expect(toPublicCamera(camera).camId).toBe(1);
    expect(toPublicCamera(baseConfig().cameras[0]!)).not.toHaveProperty('camId');
  });
});

describe('toPublicCamera — 비밀번호는 절대 나가지 않는다', () => {
  it('password 필드가 사라지고 보유 여부만 남는다', () => {
    const publicCamera = toPublicCamera(baseConfig().cameras[0]!);
    expect(publicCamera).not.toHaveProperty('password');
    expect(publicCamera.hasPassword).toBe(true);
  });

  it('비밀번호가 없으면 hasPassword 가 false', () => {
    expect(toPublicCamera(baseConfig().cameras[1]!).hasPassword).toBe(false);
  });
});

describe('mergeSettings', () => {
  it('빈 비밀번호는 기존 값을 유지한다 — 화면이 비밀번호를 돌려받지 않으므로 그대로 쓰면 자격증명이 지워진다', () => {
    const next = mergeSettings(baseConfig(), { cameras: [{ id: 'cam-a', password: '', label: '이름 변경' }] });
    expect(next.cameras[0]!.password).toBe('secret');
    expect(next.cameras[0]!.label).toBe('이름 변경');
  });

  it('비밀번호를 실제로 주면 교체한다', () => {
    const next = mergeSettings(baseConfig(), { cameras: [{ id: 'cam-a', password: 'new-pass' }] });
    expect(next.cameras[0]!.password).toBe('new-pass');
  });

  it('목록에 없는 카메라를 활성으로 지정하면 던진다', () => {
    expect(() => mergeSettings(baseConfig(), { activeCameraId: 'ghost' })).toThrow(ConfigError);
  });

  it('시뮬레이터 URL 만 바꿔도 카메라는 그대로다', () => {
    const next = mergeSettings(baseConfig(), { simulator: { baseUrl: 'http://sim:9090' } });
    expect(next.simulator.baseUrl).toBe('http://sim:9090');
    expect(next.cameras).toHaveLength(2);
    expect(next.cameras[0]!.password).toBe('secret');
  });

  it('옛 이름 rtspUrl 로 보내도 반영된다 — 읽기에서만 별칭이면 옛 화면의 입력이 조용히 버려진다', () => {
    const next = mergeSettings(baseConfig(), { cameras: [{ id: 'cam-a', rtspUrl: 'http://192.168.0.22:8092/' }] });
    expect(next.cameras[0]!.streamUrl).toBe('http://192.168.0.22:8092/');
  });

  it('둘 다 오면 새 이름이 이긴다', () => {
    const next = mergeSettings(baseConfig(), {
      cameras: [{ id: 'cam-a', rtspUrl: 'http://old/', streamUrl: 'http://new/' }],
    });
    expect(next.cameras[0]!.streamUrl).toBe('http://new/');
  });

  it('영상 URL 을 비우면 실제로 비워진다 — 스냅샷 폴링으로 내려가야 한다', () => {
    expect(mergeSettings(baseConfig(), { cameras: [{ id: 'cam-a', streamUrl: '' }] }).cameras[0]!.streamUrl).toBe('');
    expect(mergeSettings(baseConfig(), { cameras: [{ id: 'cam-a', rtspUrl: '' }] }).cameras[0]!.streamUrl).toBe('');
  });

  it('patch 에 없는 카메라는 손대지 않는다', () => {
    const next = mergeSettings(baseConfig(), { cameras: [{ id: 'cam-b', streamUrl: 'rtsp://sim/s' }] });
    expect(next.cameras[0]).toEqual(baseConfig().cameras[0]);
    expect(next.cameras[1]!.streamUrl).toBe('rtsp://sim/s');
  });
});

describe('addCamera', () => {
  it('ID 만 주면 나머지는 기본값으로 채운다', () => {
    const { config, camera } = addCamera(baseConfig(), { id: 'cam-c' });
    expect(config.cameras).toHaveLength(3);
    expect(camera).toMatchObject({ id: 'cam-c', label: 'cam-c', kind: 'hucoms', controlUrl: '', timeoutMs: 5000 });
  });

  it('활성 기기는 바뀌지 않는다 — 추가가 조작 대상을 말없이 옮기면 안 된다', () => {
    expect(addCamera(baseConfig(), { id: 'cam-c' }).config.activeCameraId).toBe('cam-a');
  });

  it('중복 ID 는 409 로 막는다', () => {
    expect(() => addCamera(baseConfig(), { id: 'cam-a' })).toThrow(expect.objectContaining({ statusCode: 409 }));
  });

  it('경로·URL 에 그대로 들어가므로 안전하지 않은 ID 는 거부한다', () => {
    for (const bad of ['', '  ', '../etc', 'has space', '-leading', 'a/b']) {
      expect(() => addCamera(baseConfig(), { id: bad })).toThrow(ConfigError);
    }
  });

  it('허용 문자는 통과한다', () => {
    expect(() => addCamera(baseConfig(), { id: 'real-camera_3.v2' })).not.toThrow();
  });
});

describe('removeCamera', () => {
  it('해당 기기만 지운다', () => {
    const { config, removed } = removeCamera(baseConfig(), 'cam-b');
    expect(removed.id).toBe('cam-b');
    expect(config.cameras.map((c) => c.id)).toEqual(['cam-a']);
  });

  it('활성 기기를 지우면 남은 첫 기기로 활성이 옮겨 간다 — 활성이 유령 id 를 가리키면 안 된다', () => {
    const { config } = removeCamera(baseConfig(), 'cam-a');
    expect(config.activeCameraId).toBe('cam-b');
  });

  it('활성이 아닌 기기를 지우면 활성은 그대로다', () => {
    expect(removeCamera(baseConfig(), 'cam-b').config.activeCameraId).toBe('cam-a');
  });

  it('마지막 한 대는 못 지운다 — 카메라 0대 설정은 다음 기동에서 로드 자체가 실패한다', () => {
    const single = normalizeConfig({ cameras: [{ id: 'only' }] });
    expect(() => removeCamera(single, 'only')).toThrow(expect.objectContaining({ statusCode: 409 }));
  });

  it('없는 기기는 404', () => {
    expect(() => removeCamera(baseConfig(), 'ghost')).toThrow(expect.objectContaining({ statusCode: 404 }));
  });
});
