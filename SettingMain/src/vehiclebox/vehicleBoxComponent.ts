import type { CameraConfig } from '../config/types.js';
import type { CameraDriver } from '../devices/cameraDriver.js';
import { Object3dClient, Object3dError } from './object3dClient.js';
import type { VehicleBoxRecord, VehicleBoxStore } from './vehicleBoxStore.js';

/**
 * 차량 3D 육면체 컴포넌트 — **지금 이 프레임의 차량마다 3D 큐보이드.**
 *
 * `calibration/`·`centering/` 을 import 하지 않는다. 프로파일과도 무관하다 — 사이드카는
 * **자기 캘리브레이션 파일**(`baro_object3d_api/config/cameras/<기기id>.json`)을 쓰고,
 * 그것은 우리 발행본과 **다른 것**이다(설계서 §12 미해결 3번). 뭉개지 않고 별개로 둔다.
 *
 * ## 카메라를 움직이지 않는다
 *
 * 그래서 점유(lease)하지 않는다. 상류도 같다 — 잡이 도는 중에도 이 경로는 막히지 않는다.
 *
 * ## 어휘의 경계
 *
 * ```
 * 봉투    cameraId · capturedAt · count · model · latencyMs   ← 우리 어휘
 * 측정값  detections[] · calibration                          ← 사이드카 어휘 그대로
 * ```
 *
 * 측정값을 개명하지 않는 이유는 **그것이 곧 결과의 의미**이기 때문이다. 대신 호스트의 내부
 * 사실(사이드카 주소·캘리브 파일 경로)은 싣지 않는다 — 그건 측정이 아니라 배치다.
 */

export interface VehicleBoxStatus {
  configured: boolean;
  ready: boolean;
  [extra: string]: unknown;
}

export interface VehicleBoxDetectResult {
  cameraId: string;
  capturedAt: string;
  count: number;
  detections: unknown[];
  calibration: unknown;
  model: string | null;
  latencyMs: number | null;
  source: 'object3d';
  /** 저장된 이력 행 번호. 기기가 DB 에 없으면 `null` 이다(검출 자체는 성공했다). */
  detectId: number | null;
}

export interface VehicleBoxComponentOptions {
  /** 없으면 능력이 꺼진다 — `config.json` 의 `object3d.baseUrl` 이 비어 있는 상태다. */
  client?: Object3dClient;
  /** 없으면 저장하지 않고 검출만 한다. 저장은 부가가치이지 검출의 조건이 아니다. */
  storeFor?: (cameraId: string) => VehicleBoxStore;
}

const NOT_CONFIGURED = '3D 차량 박스 사이드카가 설정되지 않았습니다 — config.json 의 object3d.baseUrl 을 채우십시오';

export class VehicleBoxComponent {
  constructor(private readonly options: VehicleBoxComponentOptions = {}) {}

  support(): { ok: true } | { ok: false; reason: string } {
    return this.options.client ? { ok: true } : { ok: false, reason: NOT_CONFIGURED };
  }

  /**
   * 지금 답할 수 있는가. **사이드카가 죽어 있어도 오류가 아니라 사실로 답한다** —
   * 상태를 묻는 질문에 오류로 답하면 화면이 "모른다"와 "안 됐다"를 구별할 수 없다.
   */
  async status(camera: CameraConfig): Promise<VehicleBoxStatus> {
    const client = this.options.client;
    if (!client) return { configured: false, ready: false, cameraId: camera.id, reason: NOT_CONFIGURED };
    return { ...(await client.ready()), cameraId: camera.id, model: client.model };
  }

  /** 프레임 한 장 → 3D 박스 → 저장. */
  async detect(camera: CameraConfig, driver: CameraDriver): Promise<VehicleBoxDetectResult> {
    const client = this.options.client;
    if (!client) throw new Object3dError(NOT_CONFIGURED, 'not_configured', 501);

    const image = await driver.getSnapshot();
    const raw = await client.detect(image, camera.id);
    const detections = Array.isArray(raw.detections) ? (raw.detections as unknown[]) : [];
    const capturedAt = new Date().toISOString();
    const model = (raw.model_id as string | undefined) ?? client.model;
    const latencyMs = asNumber(raw.total_ms) ?? asNumber(raw.latency_ms);

    // 자세는 **검출 뒤에** 읽는다. 앞에서 읽으면 그 사이 사람이 조작했을 때 그림과 자세가
    // 어긋난 채 저장된다 — 어차피 완벽히 같은 순간일 수 없지만, 가까운 쪽이 낫다.
    const ptz = await driver.getPtz().catch(() => null);
    const detectId = this.options.storeFor?.(camera.id).save({
      capturedAt,
      ptz,
      model,
      latencyMs,
      detections,
      calibration: raw.calibration,
    }) ?? null;

    return {
      cameraId: camera.id,
      capturedAt,
      count: detections.length,
      detections,
      calibration: raw.calibration,
      model,
      latencyMs,
      source: 'object3d',
      detectId,
    };
  }

  /** 저장된 검출. 저장소가 없으면 빈 목록이다(오류가 아니다). */
  history(camera: CameraConfig, limit?: number): VehicleBoxRecord[] {
    return this.options.storeFor?.(camera.id).list(limit) ?? [];
  }
}

function asNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
