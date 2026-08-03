import { describe, expect, it } from 'vitest';
import {
  allCapabilities,
  CoreUnsupportedError,
  type CoreCapabilities,
  type CoreContext,
  type CoreProvider,
} from '../src/core/coreProvider.js';
import { checkCapabilitiesShape, checkJobLifecycle, checkUnsupportedRejects } from './coreProviderConformance.js';

/**
 * **적합성 스위트가 실제로 판정하는지**를 검증한다.
 * 아무것도 잡아내지 못하는 스위트는 두 구현이 통과해도 아무것도 증명하지 못한다.
 * 그래서 일부러 계약을 어기는 가짜 구현을 넣고, 위반이 잡히는지 본다.
 */

const CTX = { camera: { id: 'cam-a' }, driver: {} } as unknown as CoreContext;

function capabilities(overrides: Partial<CoreCapabilities> = {}): CoreCapabilities {
  return {
    provider: 'local',
    cameraId: 'cam-a',
    busy: false,
    supported: allCapabilities({ ok: false, reason: '아직 구현하지 않았습니다' }),
    ...overrides,
  };
}

/** 능력 전부를 미지원으로 선언하고 정직하게 501 을 던지는 최소 구현. */
function honestProvider(): CoreProvider {
  const deny = (capability: never): never => {
    throw new CoreUnsupportedError(capability, '아직 구현하지 않았습니다');
  };
  // 잡 포트마다 자기 능력 이름을 실어야 한다 — 공용 객체를 쓰면 plateHoming 오류에
  // calibration 이 실린다(적합성 스위트가 이 실수를 실제로 잡아냈다).
  const job = (capability: 'calibration' | 'plateHoming') => ({
    start: async () => deny(capability as never),
    status: async () => deny(capability as never),
    stop: async () => deny(capability as never),
  });
  return {
    name: 'local',
    capabilities: async () => capabilities(),
    center: async () => deny('center' as never),
    centerBox: async () => deny('centerBox' as never),
    discoveryPresets: {
      list: async () => deny('discoveryPresets' as never),
      create: async () => deny('discoveryPresets' as never),
      update: async () => deny('discoveryPresets' as never),
      remove: async () => deny('discoveryPresets' as never),
      goto: async () => deny('discoveryPresets' as never),
    },
    discoveryPoints: {
      list: async () => deny('discoveryPoints' as never),
      create: async () => deny('discoveryPoints' as never),
      update: async () => deny('discoveryPoints' as never),
      remove: async () => deny('discoveryPoints' as never),
    },
    calibration: job('calibration'),
    plateHoming: job('plateHoming'),
  } as unknown as CoreProvider;
}

describe('checkCapabilitiesShape', () => {
  it('정직한 선언은 위반이 없다', () => {
    expect(checkCapabilitiesShape(capabilities(), 'local', 'cam-a')).toEqual([]);
  });

  it('능력을 빠뜨리면 잡는다 — 빠진 능력은 화면이 버튼을 그릴 근거를 잃는다', () => {
    const broken = capabilities();
    delete (broken.supported as Record<string, unknown>).calibration;
    expect(checkCapabilitiesShape(broken, 'local', 'cam-a')).toEqual([
      expect.stringContaining('supported.calibration'),
    ]);
  });

  it('미지원인데 사유가 없으면 잡는다', () => {
    const broken = capabilities({ supported: { ...allCapabilities({ ok: true }), center: { ok: false } } });
    expect(checkCapabilitiesShape(broken, 'local', 'cam-a')).toEqual([expect.stringContaining('사유(reason)가 없습니다')]);
  });

  it('provider 이름이 어긋나면 잡는다', () => {
    expect(checkCapabilitiesShape(capabilities({ provider: 'remote' }), 'local', 'cam-a')).toEqual([
      expect.stringContaining('provider'),
    ]);
  });

  it('cameraId 가 어긋나면 잡는다', () => {
    expect(checkCapabilitiesShape(capabilities(), 'local', 'cam-b')).toEqual([expect.stringContaining('cameraId')]);
  });
});

describe('checkUnsupportedRejects', () => {
  it('정직하게 501 을 던지는 구현은 위반이 없다', async () => {
    const provider = honestProvider();
    expect(await checkUnsupportedRejects(provider, CTX, await provider.capabilities(CTX))).toEqual([]);
  });

  it('미지원이라 해 놓고 조용히 성공하면 잡는다 — 이것이 가장 추적하기 어려운 실패다', async () => {
    const liar = { ...honestProvider(), center: async () => ({ cameraId: 'cam-a' }) } as CoreProvider;
    const violations = await checkUnsupportedRejects(liar, CTX, await liar.capabilities(CTX));
    expect(violations).toEqual([expect.stringContaining('실행이 성공했습니다')]);
  });

  it('다른 오류로 거절하는 것은 허용한다 — 원격 프록시에는 422·502 가 정직한 답이다', async () => {
    const other = {
      ...honestProvider(),
      center: async () => {
        throw new Error('backend-core HTTP 422');
      },
    } as CoreProvider;
    expect(await checkUnsupportedRejects(other, CTX, await other.capabilities(CTX))).toEqual([]);
  });

  it('CoreUnsupportedError 에 엉뚱한 능력 이름을 실으면 잡는다 — 사유가 다른 기능을 가리킨다', async () => {
    const mislabeled = {
      ...honestProvider(),
      center: async () => {
        throw new CoreUnsupportedError('plateHoming', '엉뚱한 능력 이름');
      },
    } as CoreProvider;
    const violations = await checkUnsupportedRejects(mislabeled, CTX, await mislabeled.capabilities(CTX));
    expect(violations).toEqual([expect.stringContaining('capability 가 plateHoming 로 잘못 실렸습니다')]);
  });

  it('지원한다고 선언한 능력은 검사하지 않는다 — 여기서 실제 동작까지 보지는 않는다', async () => {
    const provider = honestProvider();
    const claimed = capabilities({ supported: allCapabilities({ ok: true }) });
    expect(await checkUnsupportedRejects(provider, CTX, claimed)).toEqual([]);
  });
});

describe('checkJobLifecycle', () => {
  it('잡을 지원하지 않으면 검사하지 않는다', async () => {
    const provider = honestProvider();
    expect(await checkJobLifecycle(provider, CTX, await provider.capabilities(CTX))).toEqual([]);
  });

  it('status 가 JobStatus 모양이 아니면 잡는다', async () => {
    const broken = {
      ...honestProvider(),
      calibration: { start: async () => ({}), status: async () => ({}), stop: async () => ({ state: 'idle' }) },
    } as unknown as CoreProvider;
    const claimed = capabilities({ supported: { ...allCapabilities({ ok: false, reason: 'x' }), calibration: { ok: true } } });
    expect(await checkJobLifecycle(broken, CTX, claimed)).toEqual([expect.stringContaining('JobStatus 모양이 아닙니다')]);
  });

  it('stop 이 실행 중이 아닐 때 던지면 잡는다', async () => {
    const broken = {
      ...honestProvider(),
      calibration: {
        start: async () => ({ state: 'idle' }),
        status: async () => ({ state: 'idle' }),
        stop: async () => {
          throw new Error('실행 중이 아닙니다');
        },
      },
    } as unknown as CoreProvider;
    const claimed = capabilities({ supported: { ...allCapabilities({ ok: false, reason: 'x' }), calibration: { ok: true } } });
    expect(await checkJobLifecycle(broken, CTX, claimed)).toEqual([expect.stringContaining('오류가 아니어야 합니다')]);
  });
});
