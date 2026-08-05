import { HttpBackendCoreTransport } from '../devices/backendCore/backendCoreTransport.js';
import type { SettleOptions } from '../devices/waitForSettle.js';
import { coreProviderFor } from '../config/normalize.js';
import type { AppConfig, CameraConfig } from '../config/types.js';
import type { CoreProvider } from './coreProvider.js';
import { CameraLeaseRegistry } from './bridge/cameraLease.js';
import { BridgeCoreProvider } from './bridge/bridgeCoreProvider.js';
import { RemoteCoreProvider } from './remote/remoteCoreProvider.js';

/**
 * **구현 분기가 있는 유일한 지점.**
 * 라우트에는 `if (provider === …)` 가 없다 — 포트 표면만 호출한다.
 *
 * 선택은 설정이 정한다(`core.provider` · `core.perCamera`). 질의 파라미터로 고르지 않는 이유는
 * 요청마다 달라지는 값으로 구현을 고르면 "지금 무엇으로 도는가"에 답할 곳이 없기 때문이다.
 */

export interface CoreProviderDeps {
  /** 카메라별 점유는 프로세스 수명 동안 유지돼야 하므로 밖에서 하나만 만들어 넘긴다. */
  leases: CameraLeaseRegistry;
  settleOptions?: SettleOptions;
  fetchImpl?: typeof fetch;
}

export function createCoreProvider(camera: CameraConfig, config: AppConfig, deps: CoreProviderDeps): CoreProvider {
  if (coreProviderFor(config, camera.id) === 'remote') {
    return new RemoteCoreProvider({
      transport: new HttpBackendCoreTransport({
        baseUrl: config.simulator.baseUrl,
        timeoutMs: camera.timeoutMs,
        fetchImpl: deps.fetchImpl,
      }),
    });
  }
  return new BridgeCoreProvider({ leases: deps.leases, settleOptions: deps.settleOptions });
}

export { CameraLeaseRegistry };
