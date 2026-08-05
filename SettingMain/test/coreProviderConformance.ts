import { describe, expect, it } from 'vitest';
import {
  CORE_CAPABILITY_NAMES,
  CoreUnsupportedError,
  type CoreCapabilities,
  type CoreCapabilityName,
  type CoreContext,
  type CoreProvider,
  type CoreProviderName,
} from '../src/core/coreProvider.js';

/**
 * CoreProvider 적합성 스위트 — **계약의 정본**이다.
 *
 * 두 구현(RemoteCore·BridgeCore)이 이 파일을 공유해 통과해야 "서로 대체 가능하다"가
 * 말이 아니라 사실이 된다. 그래서 이 파일은 **어떤 구현도 import 하지 않는다.**
 *
 * 판정은 순수 함수(`check*`)가 하고 `runCoreProviderConformance` 는 그것을 감싸기만 한다.
 * 스위트 자신이 제대로 판정하는지는 `coreProviderContract.test.ts` 가 검증한다 —
 * 아무것도 잡아내지 못하는 스위트는 통과해도 아무것도 증명하지 못하기 때문이다.
 */

/**
 * 능력 이름 → 그 능력을 **실제로 행하는** 최소 요청.
 *
 * 읽기(status·list)가 아니라 **행위**를 고른다. 못 하는 기기에서도 "지금 idle 이다"를
 * 읽는 것은 거짓말이 아니지만, 못 하는 일을 **실행했는데 성공하는 것**은 거짓말이다.
 *
 * `Partial` 인 이유: `vehicleBox`·`slotCreate` 는 이름만 세워 두고 **포트가 아직 없다**.
 * 없는 메서드를 부를 수는 없으므로 프로브도 없다. 대신 아래 `checkUnsupportedRejects` 가
 * "실행 표면이 없는 능력을 `ok:true` 로 답하면 위반"이라고 못 박는다 — 포트를 만들면서
 * 여기 프로브를 빠뜨리면 그 순간 잡힌다.
 */
const INVOKE: Partial<Record<CoreCapabilityName, (provider: CoreProvider, ctx: CoreContext) => Promise<unknown>>> = {
  center: (p, ctx) => p.center(ctx, { x: 960, y: 540 }),
  centerBox: (p, ctx) => p.centerBox(ctx, { startX: 100, startY: 100, endX: 300, endY: 300 }),
  discoveryPresets: (p, ctx) => p.discoveryPresets.create(ctx, { name: 'conformance' }),
  discoveryPoints: (p, ctx) => p.discoveryPoints.create(ctx, 'preset-1', { x: 10, y: 20 }),
  calibration: (p, ctx) => p.calibration.start(ctx, { mode: 'verify' }),
  plateHoming: (p, ctx) => p.plateHoming.start(ctx, { presetId: 'preset-1' }),
};

// --- 판정 함수 (위반 목록을 돌려준다. 빈 배열 = 적합) ---------------------------

export function checkCapabilitiesShape(capabilities: CoreCapabilities, expectedProvider: CoreProviderName, expectedCameraId: string): string[] {
  const violations: string[] = [];
  if (capabilities.provider !== expectedProvider) {
    violations.push(`provider 가 ${expectedProvider} 여야 하는데 ${String(capabilities.provider)} 입니다`);
  }
  if (capabilities.cameraId !== expectedCameraId) {
    violations.push(`cameraId 가 ${expectedCameraId} 여야 하는데 ${String(capabilities.cameraId)} 입니다`);
  }
  if (typeof capabilities.busy !== 'boolean') violations.push('busy 는 boolean 이어야 합니다');

  for (const name of CORE_CAPABILITY_NAMES) {
    const state = capabilities.supported?.[name];
    if (!state || typeof state.ok !== 'boolean') {
      // 빠뜨린 능력은 "모른다"가 되어 화면이 버튼을 어떻게 그릴지 판단할 수 없다.
      violations.push(`supported.${name} 이(가) 없습니다 — 모든 능력을 빠짐없이 답해야 합니다`);
      continue;
    }
    if (!state.ok && !state.reason?.trim()) {
      violations.push(`supported.${name} 이 false 인데 사유(reason)가 없습니다`);
    }
  }
  return violations;
}

/**
 * 미지원이라 선언한 능력을 **실행하면 실패해야 한다.**
 *
 * 오류의 종류까지 못 박지는 않는다 — 구현마다 정직한 답이 다르다.
 * 자체 구현은 501(이 구현이 하지 않음), 원격 프록시는 422(기기가 못 함)나
 * 502(도달 불가)가 정직한 답이다. 금지 대상은 오직 **조용한 성공**이다.
 * 단, `CoreUnsupportedError` 를 쓴다면 능력 이름이 맞아야 한다 — 틀리면 사유가 엉뚱해진다.
 */
export async function checkUnsupportedRejects(provider: CoreProvider, ctx: CoreContext, capabilities: CoreCapabilities): Promise<string[]> {
  const violations: string[] = [];
  for (const name of CORE_CAPABILITY_NAMES) {
    const invoke = INVOKE[name];
    if (!invoke) {
      // 실행 표면이 없는 능력은 할 수 있다고 답할 수 없다 — 부를 방법이 없는데 가능하다고
      // 답하면 화면이 버튼을 켜고, 누른 사람은 아무 일도 일어나지 않는 것을 보게 된다.
      if (capabilities.supported?.[name]?.ok === true) {
        violations.push(`${name} 은(는) 실행 표면(포트)이 없는데 ok:true 로 답했습니다 — 포트를 만들었다면 INVOKE 에 프로브를 추가하세요`);
      }
      continue;
    }
    if (capabilities.supported?.[name]?.ok !== false) continue;
    try {
      await invoke(provider, ctx);
      violations.push(`${name} 은(는) 미지원 선언인데 실행이 성공했습니다 — 조용한 성공은 추적 불가능한 실패가 됩니다`);
    } catch (error) {
      if (error instanceof CoreUnsupportedError) {
        if (error.statusCode !== 501) violations.push(`${name} CoreUnsupportedError 의 statusCode 가 501 이 아닙니다: ${error.statusCode}`);
        if (error.capability !== name) violations.push(`${name} 미지원 오류의 capability 가 ${String(error.capability)} 로 잘못 실렸습니다`);
      }
    }
  }
  return violations;
}

/** 잡은 start 전에 idle 이고, stop 은 실행 중이 아니어도 오류가 아니다. */
export async function checkJobLifecycle(provider: CoreProvider, ctx: CoreContext, capabilities: CoreCapabilities): Promise<string[]> {
  const violations: string[] = [];
  for (const name of ['calibration', 'plateHoming'] as const) {
    if (!capabilities.supported?.[name]?.ok) continue;
    const port = provider[name];
    const status = await port.status(ctx);
    if (!isJobStatus(status)) {
      violations.push(`${name}.status 가 JobStatus 모양이 아닙니다`);
      continue;
    }
    try {
      const stopped = await port.stop(ctx);
      if (!isJobStatus(stopped)) violations.push(`${name}.stop 이 JobStatus 를 돌려주지 않습니다`);
    } catch (error) {
      violations.push(`${name}.stop 은 실행 중이 아니어도 오류가 아니어야 합니다: ${describeError(error)}`);
    }
  }
  return violations;
}

function isJobStatus(value: unknown): boolean {
  const state = (value as { state?: unknown } | null)?.state;
  return typeof state === 'string' && ['idle', 'running', 'done', 'failed', 'stopped'].includes(state);
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// --- 스위트 ---------------------------------------------------------------------

export interface ConformanceSubject {
  provider: CoreProvider;
  ctx: CoreContext;
  cleanup?: () => Promise<void> | void;
}

/**
 * 두 구현이 공유하는 시나리오. 구현별 테스트 파일에서 호출한다.
 *   runCoreProviderConformance('RemoteCore', () => makeRemote());
 *   runCoreProviderConformance('BridgeCore', () => makeBridge());
 */
export function runCoreProviderConformance(name: string, make: () => Promise<ConformanceSubject> | ConformanceSubject): void {
  describe(`${name} — CoreProvider 적합성`, () => {
    it('capabilities 는 모든 능력을 빠짐없이 답하고 provider·cameraId 가 일치한다', async () => {
      const { provider, ctx, cleanup } = await make();
      try {
        const capabilities = await provider.capabilities(ctx);
        expect(checkCapabilitiesShape(capabilities, provider.name, ctx.camera.id)).toEqual([]);
      } finally {
        await cleanup?.();
      }
    });

    it('미지원이라 선언한 능력은 실행이 실패한다 — 조용한 성공이 없다', async () => {
      const { provider, ctx, cleanup } = await make();
      try {
        const capabilities = await provider.capabilities(ctx);
        expect(await checkUnsupportedRejects(provider, ctx, capabilities)).toEqual([]);
      } finally {
        await cleanup?.();
      }
    });

    it('잡은 status 를 답하고 stop 은 실행 중이 아니어도 오류가 아니다', async () => {
      const { provider, ctx, cleanup } = await make();
      try {
        const capabilities = await provider.capabilities(ctx);
        expect(await checkJobLifecycle(provider, ctx, capabilities)).toEqual([]);
      } finally {
        await cleanup?.();
      }
    });
  });
}
