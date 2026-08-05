import type { AppConfig, CameraConfig } from '../config/types.js';
import { BackendCoreClient } from './backendCore/backendCoreClient.js';
import { CameraDriverError, type CameraDriver } from './cameraDriver.js';
import { HucomsClient } from './hucoms/hucomsClient.js';
import { Park3DRpcClient } from './park3d/park3dRpcClient.js';

/**
 * 설정의 카메라 1건을 드라이버로 조립하는 **유일한 지점**.
 * 종류 분기는 여기에만 있고, 상위 계층은 CameraDriver 표면만 본다.
 */
export function createDriver(camera: CameraConfig, config: AppConfig, fetchImpl?: typeof fetch): CameraDriver {
  switch (camera.kind) {
    case 'hucoms':
      return new HucomsClient({
        cameraId: camera.id,
        baseUrl: camera.controlUrl,
        username: camera.username,
        password: camera.password,
        timeoutMs: camera.timeoutMs,
        fetchImpl,
      });
    case 'backend-core':
      // 제어 URL 을 따로 적었으면 그것을, 아니면 전역 시뮬레이터 URL 을 쓴다.
      return new BackendCoreClient({
        cameraId: camera.id,
        baseUrl: camera.controlUrl || config.simulator.baseUrl,
        timeoutMs: camera.timeoutMs,
        fetchImpl,
      });
    case 'park3d-rpc':
      // 언리얼 Park3D JSON-RPC. controlUrl 에 경로 접미사를 붙이지 않는다(`/rpc` 는 드라이버가 붙인다).
      return new Park3DRpcClient({
        cameraId: camera.id,
        baseUrl: camera.controlUrl,
        camId: camera.camId,
        timeoutMs: camera.timeoutMs,
        fetchImpl,
      });
    default: {
      const unknown: never = camera.kind;
      throw new CameraDriverError(`알 수 없는 카메라 종류입니다: ${String(unknown)}`, 400);
    }
  }
}

export function findCamera(config: AppConfig, cameraId?: string): CameraConfig {
  const id = cameraId || config.activeCameraId;
  const camera = config.cameras.find((c) => c.id === id);
  if (!camera) throw new CameraDriverError(`등록되지 않은 카메라입니다: ${id}`, 404);
  return camera;
}
