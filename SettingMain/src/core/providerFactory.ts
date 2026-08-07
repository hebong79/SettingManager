import { HttpBackendCoreTransport } from '../devices/backendCore/backendCoreTransport.js';
import type { SettleOptions } from '../devices/waitForSettle.js';
import { coreProviderFor } from '../config/normalize.js';
import type { AppConfig, CameraConfig } from '../config/types.js';
import type { DatabaseSync } from 'node:sqlite';
import { DiscoveryDbStore } from '../db/discoveryDbStore.js';
import { SpotDbStore } from '../db/spotDbStore.js';
import { CalibrationComponent } from '../calibration/calibrationComponent.js';
import { CalibrationJobRunner } from '../calibration/calibrationJob.js';
import { CameraLockStore } from '../calibration/cameraLock.js';
import { FrameDecoder } from '../calibration/frameDecode.js';
import { CenteringComponent } from '../centering/centeringComponent.js';
import { Object3dClient } from '../vehiclebox/object3dClient.js';
import { VehicleBoxComponent } from '../vehiclebox/vehicleBoxComponent.js';
import { VehicleBoxStore } from '../vehiclebox/vehicleBoxStore.js';
import type { ProfileStore } from '../profiles/profileStore.js';
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
 *
 * ## 세 컴포넌트는 **프로세스당 하나**다
 *
 * `createCoreProvider` 는 요청마다 불린다. 컴포넌트를 여기서 새로 만들면 캘리브레이션 잡
 * 기록이 요청마다 초기화되어 **진행 중인 20분짜리 스윕이 매 폴링마다 사라진다.** 그래서
 * 수명이 긴 것은 `createCoreComponents()` 가 서버 조립 시 한 번 만들어 `deps` 로 들고 다닌다.
 */

export interface CoreComponents {
  calibration: CalibrationComponent;
  centering: CenteringComponent;
  vehicleBox: VehicleBoxComponent;
}

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
  /** 세 독립 컴포넌트. 프로세스당 하나이며 요청마다 다시 만들지 않는다. */
  components?: CoreComponents;
}

export interface CreateComponentsOptions {
  config: AppConfig;
  profiles: ProfileStore;
  settleOptions?: SettleOptions;
  fetchImpl?: typeof fetch;
  db?: DatabaseSync;
}

/** 세 컴포넌트를 한 번 조립한다. **서버 기동 시 한 번만 부른다.** */
export function createCoreComponents(options: CreateComponentsOptions): CoreComponents {
  const { config, profiles, settleOptions, fetchImpl, db } = options;
  return {
    calibration: new CalibrationComponent(
      new CalibrationJobRunner({
        // 설정의 ffmpeg 경로를 그대로 쓴다 — RTSP 전사와 같은 실행 파일이다.
        decoder: new FrameDecoder({ ffmpegPath: config.streaming.ffmpegPath }),
        locks: new CameraLockStore(),
        settleOptions,
      }),
      profiles,
    ),
    centering: new CenteringComponent({ settleOptions }),
    vehicleBox: new VehicleBoxComponent({
      // 주소가 비어 있으면 클라이언트를 만들지 않는다 — 그 상태가 곧 `vehicleBox` 미지원 사유가 된다.
      client: config.object3d.baseUrl ? new Object3dClient({ ...config.object3d, fetchImpl }) : undefined,
      storeFor: db ? (cameraId) => new VehicleBoxStore(db, cameraId) : undefined,
    }),
  };
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
    calibration: deps.components?.calibration,
    centering: deps.components?.centering,
    vehicleBox: deps.components?.vehicleBox,
  });
}

export { CameraLeaseRegistry };
