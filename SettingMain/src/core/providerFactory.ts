import { HttpBackendCoreTransport } from '../devices/backendCore/backendCoreTransport.js';
import type { SettleOptions } from '../devices/waitForSettle.js';
import { coreProviderFor } from '../config/normalize.js';
import type { AppConfig, CameraConfig } from '../config/types.js';
import { Object3dClient } from '../detectors/object3dClient.js';
import type { DatabaseSync } from 'node:sqlite';
import { DiscoveryDbStore } from '../db/discoveryDbStore.js';
import { SpotDbStore } from '../db/spotDbStore.js';
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
  /**
   * 브리지 저장소(탐색 프리셋·점·주차면)의 **정본 DB**. 없으면 그 능력들이 꺼진다 —
   * 빈 저장소를 지어내면 사용자가 저장한 줄 알고 넘어간다.
   */
  db?: DatabaseSync;
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
  return new BridgeCoreProvider({
    leases: deps.leases,
    settleOptions: deps.settleOptions,
    // SQLite 가 정본이다. 두 저장소는 backend-core **모양 그대로** 답하므로 라우트·응답은 불변이고,
    // 같은 결과를 그대로 파일로 뽑을 수 있다(`db/backendCoreExport.ts`).
    discoveryStoreFor: deps.db ? (cameraId) => new DiscoveryDbStore(deps.db!, cameraId) : undefined,
    spotStoreFor: deps.db ? (cameraId) => new SpotDbStore(deps.db!, cameraId) : undefined,
    // 주소가 비어 있으면 클라이언트를 만들지 않는다 — 그 상태가 곧 `vehicleBox` 미지원 사유가 된다.
    object3d: config.object3d.baseUrl
      ? new Object3dClient({ ...config.object3d, fetchImpl: deps.fetchImpl })
      : undefined,
  });
}

export { CameraLeaseRegistry };
