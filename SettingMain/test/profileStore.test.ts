import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProfileError, ProfileStore, type PublishInput } from '../src/profiles/profileStore.js';
import { profileDrift } from '../src/profiles/profileDrift.js';
import { publishGateFailures } from '../src/profiles/publishGate.js';
import type { CameraIntrinsics } from '../src/config/types.js';

/**
 * 프로파일 생명주기 — **정본은 baro_calory `docs/calibration.md` §프로파일 생명주기 정책**이다.
 * 그 문서가 "여기 적힌 것과 다르게 동작하는 코드가 있으면 코드가 틀린 것"이라 못 박았으므로,
 * 이 파일은 그 정책 하나하나를 **강제하는 자리**다.
 */

let dir: string;
let applied: Array<{ cameraId: string; intrinsics: CameraIntrinsics }>;
let applyFails: boolean;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'settingmanager-profiles-'));
  applied = [];
  applyFails = false;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function store(): ProfileStore {
  return new ProfileStore({
    root: dir,
    now: () => '2026-08-07T00:00:00.000Z',
    sink: {
      apply(cameraId, intrinsics) {
        if (applyFails) throw new ProfileError('런타임 적용 실패(시험)', 500);
        applied.push({ cameraId, intrinsics });
      },
    },
  });
}

function input(overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    optics: {
      interpolation: 'piecewise-linear',
      extrapolation: 'clamp',
      zoomHfov: [{ z: 0, h: 57.14 }, { z: 16384, h: 2.39 }],
      centeringGain: [{ z: 0, k: 0.988 }, { z: 16384, k: 0.765 }],
    },
    device: { type: 'hucoms', frame: { width: 1920, height: 1080 }, ptzRange: { pan: [0, 35999], tilt: [-2000, 9000], zoom: [0, 65535] } },
    provenance: { method: 'sweep', measuredOn: 'cam-a' },
    quality: {
      method: 'click-sweep.zncc.v1',
      samples: { usable: 69, of: 112 },
      residual: { beforePx: 152.4, fitRmsPx: 14.6, fitRmsMedianPx: 6.0 },
      verify: null,
    },
    ...overrides,
  };
}

describe('발행 게이트 — 파국은 막고, 우회는 흔적을 남긴다', () => {
  it('cam-real-001 수준(중앙값 6.0px · 62%)은 통과한다 — 실측이 기준이다', () => {
    expect(publishGateFailures(input().quality)).toEqual([]);
  });

  it('**중앙값**으로 판정한다 — 앵커 하나가 시끄럽다고 좋은 스윕을 버리지 않는다', () => {
    // cam-real-002 의 첫 실측: 최댓값 67.3px 인데 중앙값은 5.8px 였고, 최댓값 게이트가
    // "모델이 이 스윕을 설명하지 못했습니다"라고 **거짓으로** 답했다(2026-08-05 상류 실측).
    const failures = publishGateFailures({ ...input().quality, residual: { beforePx: 100, fitRmsPx: 67.3, fitRmsMedianPx: 5.8 } });
    expect(failures).toEqual([]);
  });

  it('중앙값이 상한을 넘으면 막는다 — 앵커의 절반 이상이 나쁘다는 뜻이다', () => {
    const failures = publishGateFailures({ ...input().quality, residual: { beforePx: 100, fitRmsPx: 90, fitRmsMedianPx: 45 } });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toContain('앵커의 절반 이상');
  });

  it('중앙값이 없는 옛 측정본은 최댓값으로 판정하되 **그 사실이 문구에 드러난다**', () => {
    const failures = publishGateFailures({ ...input().quality, residual: { beforePx: 100, fitRmsPx: 45 } });
    expect(failures[0]!.reason).toContain('최댓값');
  });

  it('판단 근거가 없으면 막지 않는다 — 모르는 것을 미달로 취급하지 않는다', () => {
    expect(publishGateFailures({ method: 'import', verify: null })).toEqual([]);
  });

  it('쓸 수 있는 표본이 절반 미만이면 막는다', () => {
    const failures = publishGateFailures({ ...input().quality, samples: { usable: 20, of: 112 } });
    expect(failures.some((f) => f.metric === 'usableRatio')).toBe(true);
  });
});

describe('발행 — 적용이 먼저, 발행이 나중', () => {
  it('통과하면 rev-0001 과 .sha256 과 latest.json 이 함께 남고 런타임에 물린다', async () => {
    const result = await store().publish('cam-a', input());

    expect(result.profile.revision).toBe(1);
    expect(result.profile.supersedes).toBeNull();
    expect(result.applied).toBe(true);
    expect(result.restartRequired).toBe(false);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.intrinsics.centeringGain).toEqual([{ z: 0, k: 0.988 }, { z: 16384, k: 0.765 }]);

    const files = (await readdir(join(dir, 'camera', 'cam-a'))).sort();
    expect(files).toEqual(['latest.json', 'rev-0001.camprof.json', 'rev-0001.camprof.json.sha256']);
  });

  it('사이드카 해시가 **파일 바이트 전체**와 맞는다 — sha256sum 한 줄로 검증된다', async () => {
    const result = await store().publish('cam-a', input());
    const bytes = await readFile(result.path);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(result.sha256);
  });

  it('**적용에 실패하면 문서도 남지 않는다** — 아무도 읽지 않는 발행본을 만들지 않는다', async () => {
    applyFails = true;
    await expect(store().publish('cam-a', input())).rejects.toThrow(/런타임 적용 실패/);
    await expect(readdir(join(dir, 'camera', 'cam-a'))).rejects.toThrow();
  });

  it('apply:false 는 명시해야 하고, restartRequired 로 "런타임은 아직 옛 값"을 말한다', async () => {
    const result = await store().publish('cam-a', input({ apply: false }));
    expect(result.applied).toBe(false);
    expect(result.restartRequired).toBe(true);
    expect(applied).toEqual([]);
  });

  it('게이트 미달은 422 이고 **화면이 그릴 수 있는 우회로**를 함께 준다', async () => {
    const bad = input({ quality: { ...input().quality, residual: { beforePx: 100, fitRmsPx: 90, fitRmsMedianPx: 45 }, } });
    const error = await store().publish('cam-a', bad).catch((e: unknown) => e as ProfileError);

    expect(error).toBeInstanceOf(ProfileError);
    expect((error as ProfileError).statusCode).toBe(422);
    expect((error as ProfileError).details).toMatchObject({ bypass: { force: true } });
    // 막혔으면 적용도 없었어야 한다.
    expect(applied).toEqual([]);
  });

  it('force 로 넘기면 **사유가 문서에 박힌다** — 나중에 읽는 사람이 안다', async () => {
    const bad = input({
      quality: { ...input().quality, residual: { beforePx: 100, fitRmsPx: 90, fitRmsMedianPx: 45 } },
      force: true,
    });
    const result = await store().publish('cam-a', bad);
    expect(result.forced).toHaveLength(1);
    expect(result.profile.quality.forced?.[0]).toContain('앵커의 절반 이상');
  });

  it('게인이 없으면 capabilities 에 aim 이 붙지 않는다 — 못 하는 일을 광고하지 않는다', async () => {
    const result = await store().publish('cam-a', input({
      optics: { interpolation: 'piecewise-linear', extrapolation: 'clamp', zoomHfov: [{ z: 0, h: 57.14 }, { z: 100, h: 20 }], centeringGain: null },
    }));
    expect(result.profile.capabilities).toEqual(['display', 'reproject']);
  });
});

describe('리비전은 불변이다', () => {
  it('정정은 덮어쓰기가 아니라 새 리비전이고 supersedes 가 앞 번호를 가리킨다', async () => {
    const s = store();
    await s.publish('cam-a', input());
    const second = await s.publish('cam-a', input());

    expect(second.profile.revision).toBe(2);
    expect(second.profile.supersedes).toBe(1);
    expect(await s.listRevisions('cam-a')).toEqual([1, 2]);
  });

  it('@N 고정 조회는 새 리비전이 나와도 같은 값을 답한다', async () => {
    const s = store();
    const first = await s.publish('cam-a', input());
    await s.publish('cam-a', input({
      optics: { interpolation: 'piecewise-linear', extrapolation: 'clamp', zoomHfov: [{ z: 0, h: 50 }, { z: 16384, h: 2 }], centeringGain: null },
    }));

    expect((await s.read('cam-a', 1))!.optics.zoomHfov).toEqual(first.profile.optics.zoomHfov);
    expect((await s.read('cam-a'))!.revision).toBe(2); // 생략하면 최신
  });

  it('되돌리기는 apply 하나로 한다 — 옛 리비전을 다시 물린다', async () => {
    const s = store();
    await s.publish('cam-a', input());
    await s.publish('cam-a', input({
      optics: { interpolation: 'piecewise-linear', extrapolation: 'clamp', zoomHfov: [{ z: 0, h: 50 }, { z: 16384, h: 2 }], centeringGain: null },
    }));
    applied = [];

    await s.apply('cam-a', 1);
    expect(applied[0]!.intrinsics.zoomHfov[0]!.h).toBe(57.14);
  });

  it('없는 리비전은 404 다', async () => {
    await expect(store().apply('cam-a', 9)).rejects.toThrow(/리비전 9/);
  });
});

describe('삭제는 파기가 아니라 퇴역이다', () => {
  it('.trash 로 옮기고 **런타임 적용본은 건드리지 않는다**', async () => {
    const s = store();
    await s.publish('cam-a', input());
    applied = [];

    const { movedTo } = await s.retire('cam-a');
    expect(movedTo).toContain('.trash');
    expect(await s.listRevisions('cam-a')).toEqual([]);
    // 문서를 치웠다고 돌고 있는 카메라의 조준이 말없이 바뀌면 그게 더 나쁘다.
    expect(applied).toEqual([]);
    expect((await readdir(join(dir, 'camera', '.trash'))).length).toBe(1);
  });
});

describe('경로 안전', () => {
  it('기기 id 에 구분자나 상위 이동이 있으면 거절한다 — 저장소 밖에 쓰게 된다', async () => {
    await expect(store().publish('../evil', input())).rejects.toThrow(/쓸 수 없는 값/);
    await expect(store().listRevisions('a/b')).rejects.toThrow(/쓸 수 없는 값/);
  });
});

describe('드리프트 — 발행본이 분모다', () => {
  it('일치하면 조용하다 — 늘 떠 있는 경고는 아무도 읽지 않는다', async () => {
    const result = await store().publish('cam-a', input());
    expect(profileDrift('cam-a', result.profile, applied[0]!.intrinsics)).toBeNull();
  });

  it('발행본은 있는데 런타임이 비어 있으면 적용 경로를 알려 준다', async () => {
    const result = await store().publish('cam-a', input({ apply: false }));
    const drift = profileDrift('cam-a', result.profile, undefined);
    expect(drift!.message).toContain('/apply');
  });

  it('값이 벌어지면 어느 앵커에서 몇 % 인지 말한다', async () => {
    const result = await store().publish('cam-a', input());
    const runtime: CameraIntrinsics = {
      zoomHfov: [{ z: 0, h: 57.14 }, { z: 16384, h: 2.5 }],   // 마지막 앵커가 4.6% 다르다
      centeringGain: result.profile.optics.centeringGain!,
    };
    const drift = profileDrift('cam-a', result.profile, runtime);
    expect(drift!.drifted).toBe(true);
    expect(drift!.message).toContain('z=16384');
  });

  it('앵커 구성 자체가 다르면 값이 아니라 **모양**이 다르다고 말한다', async () => {
    const result = await store().publish('cam-a', input());
    const drift = profileDrift('cam-a', result.profile, { zoomHfov: [{ z: 0, h: 57.14 }, { z: 999, h: 10 }] });
    expect(drift!.curves.some((c) => c.shapeChanged)).toBe(true);
  });

  it('발행본이 없으면 조용하다 — 대조할 정본이 없다', () => {
    expect(profileDrift('cam-a', null, { zoomHfov: [{ z: 0, h: 1 }] })).toBeNull();
  });
});
