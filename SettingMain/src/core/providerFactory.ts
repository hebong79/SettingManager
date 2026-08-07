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
import { PlateHomingComponent } from '../homing/plateHomingComponent.js';
import { PlateHomingJobRunner } from '../homing/plateHomingJob.js';
import { HomeTraceStore } from '../homing/homeTraceStore.js';
import { homingStoreFor } from '../homing/discoveryHomingStore.js';
import { createDetector, detectorUnavailableReason } from '../detectors/detectorFactory.js';
import type { DetectorClient } from '../detectors/detectorTypes.js';
import { VpdSegClient } from '../detectors/vpdSegClient.js';
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
  plateHoming: PlateHomingComponent;
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
  /** 독립 컴포넌트 넷. 프로세스당 하나이며 요청마다 다시 만들지 않는다. */
  components?: CoreComponents;
}

export interface CreateComponentsOptions {
  config: AppConfig;
  profiles: ProfileStore;
  settleOptions?: SettleOptions;
  fetchImpl?: typeof fetch;
  db?: DatabaseSync;
}

/** 컴포넌트 넷을 한 번 조립한다. **서버 기동 시 한 번만 부른다.** */
export function createCoreComponents(options: CreateComponentsOptions): CoreComponents {
  const { config, profiles, settleOptions, fetchImpl, db } = options;
  const traces = new HomeTraceStore();
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
    plateHoming: createPlateHoming({ config, settleOptions, fetchImpl, db, traces }),
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
    plateHoming: deps.components?.plateHoming,
    vehicleBox: deps.components?.vehicleBox,
  });
}

/**
 * 번호판 호밍 컴포넌트.
 *
 * **검출기 둘이 다 있어야 한다.** LPD 는 판을 찾고, VPD **세그멘테이션**은 "내 차 실루엣"을
 * 준다. 마스크 없이 붙이면 후보 고르기가 "가장 가까운 판"으로 퇴화하고, 그건 고줌에서
 * 옆차로 옮겨탄다 — 상류가 실제로 겪고 고친 결함이다. 그래서 하나라도 없으면 컴포넌트를
 * 세우되 **사유와 함께 꺼진 상태**로 광고한다(지어내지 않는다).
 *
 * VPD 는 `detectorFactory` 를 쓰지 않고 여기서 직접 만든다 — 그쪽은 **검출 경로**
 * (`/det/imgupload`)를 주고, 그 경로는 `masks` 를 빈 배열로 돌려주기 때문이다(실측).
 */
function createPlateHoming(options: {
  config: AppConfig;
  settleOptions?: SettleOptions;
  fetchImpl?: typeof fetch;
  db?: DatabaseSync;
  traces: HomeTraceStore;
}): PlateHomingComponent {
  const { config, settleOptions, fetchImpl, db, traces } = options;
  const lpdReason = detectorUnavailableReason('lpd', config);
  const vpdReason = detectorUnavailableReason('vpd', config);
  const detectorReason = lpdReason
    ? `번호판 검출기(LPD)를 쓸 수 없습니다: ${lpdReason}`
    : vpdReason
      ? `차량 세그멘테이션(VPD)을 쓸 수 없습니다: ${vpdReason} — 마스크가 없으면 옆차 드리프트를 막을 수 없어 호밍을 켜지 않습니다`
      : undefined;

  const runner = new PlateHomingJobRunner({
    // 사유가 있으면 클라이언트를 만들지 않는다. `support()` 가 그 사유로 먼저 거절하므로
    // 여기 더미가 불릴 일이 없고, 빈 주소로 나가 "어디로 갔는지 모르는 실패"도 만들지 않는다.
    plates: detectorReason ? unavailableDetector('lpd') : createDetector('lpd', config, fetchImpl),
    vehicles: detectorReason
      ? unavailableDetector('vpd')
      : new VpdSegClient({ baseUrl: config.detectors.vpd.baseUrl, timeoutMs: config.detectors.vpd.timeoutMs, fetchImpl }),
    traces,
    locks: new CameraLockStore(),
    settleOptions,
  });

  return new PlateHomingComponent({
    runner,
    traces,
    storeFor: db ? (cameraId) => homingStoreFor(new DiscoveryDbStore(db, cameraId)) : undefined,
    detectorReason: () => detectorReason,
  });
}

/** 절대 불리지 않아야 하는 자리. 불렸다면 `support()` 게이트가 새는 것이므로 크게 실패한다. */
function unavailableDetector(name: 'lpd' | 'vpd'): DetectorClient {
  return {
    name,
    detect: async () => {
      throw new Error(`${name.toUpperCase()} 검출기가 설정되지 않았는데 호출됐습니다 — support() 게이트를 확인하세요`);
    },
  };
}

export { CameraLeaseRegistry };
