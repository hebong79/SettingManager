import { DetectorError } from './detectorTypes.js';

/**
 * 3D 차량 박스 추론 사이드카(`baro_calory/tools/baro_object3d_api`, 기본 :9070) 클라이언트.
 *
 * 근거: baro_calory `apps/backend-core/src/object3d-client.mjs` (와이어)와
 * `control-api.mjs:530-604` (봉투·상태 매핑).
 *
 * **중계가 아니라 소비다.** 스냅샷은 이쪽이 뜨고, 캘리브레이션 키(`cameraId`)도 이쪽이 안다.
 * 다만 경계는 정확히 지킨다 — 봉투(`cameraId`·`capturedAt`·`count`·`model`·`latencyMs`)는
 * 우리 어휘이고, `detections[]`·`calibration` 은 **사이드카 어휘 그대로** 통과시킨다.
 * 측정값을 개명하면 사이드카 로그와 대조가 안 되고 좌표계 규약이 두 벌이 된다.
 *
 * 사이드카의 오류 `code` 를 뭉개지 않는 것이 이 파일의 핵심이다. 뭉개면 "이 기기의
 * 캘리브레이션 파일 하나 없음"(운영자가 5분이면 고친다)이 "3D 서비스 죽음"으로 보고된다.
 *
 * **`DetectorName`(vpd·lpd·lpr)에 넣지 않았다.** 그 셋은 구성도의 *API 계층*이라는 상자이고,
 * object3d 는 코어 능력(`vehicleBox`)을 채우는 사이드카다 — 같은 "사이드카"라는 이유로 한
 * 목록에 넣으면 `GET /api/detectors` 가 코어 능력을 API 계층인 양 보고하게 된다.
 * 다만 오류 봉투는 공유한다(`DetectorError` → 서버가 상태코드로 옮기는 자리가 하나다).
 */

export interface Object3dClientOptions {
  baseUrl: string;
  /** 사이드카에 등록된 모델 별칭. 상류 기본값과 같다. */
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export interface Object3dStatus {
  configured: boolean;
  ready: boolean;
  [extra: string]: unknown;
}

/** 사이드카가 `{"detail":{"code","message"}}` 로 준 거절. `code` 마다 조치가 다르다. */
export class Object3dError extends DetectorError {
  constructor(message: string, readonly code: string, statusCode: number) {
    super(message, statusCode);
    this.name = 'Object3dError';
  }
}

export class Object3dClient {
  private readonly base: string;

  constructor(private readonly options: Object3dClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, '');
  }

  get model(): string {
    return this.options.model;
  }

  /**
   * 모델이 실제로 떴는가. **503 도 정상 응답**이다(아직 준비 안 됨) — 던지지 않고 사실로 답한다.
   * 사이드카에 닿지 못한 것도 `ready:false` 이지 오류가 아니다: 상태를 묻는 질문에
   * 오류로 답하면 화면이 "모른다"와 "안 됐다"를 구별할 수 없다.
   */
  async ready(): Promise<Object3dStatus> {
    try {
      const res = await this.request('/readyz', { method: 'GET' });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { configured: true, ...body, ready: res.status === 200 && body.ready === true };
    } catch (error) {
      return { configured: true, ready: false, loadError: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 프레임 한 장 → 3D 박스. `cameraId` 는 사이드카의 캘리브레이션 키다(없으면 사이드카가 422). */
  async detect(image: Buffer, cameraId: string): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ model: this.options.model, camera_id: cameraId });
    const res = await this.request(`/detect?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg' },
      body: image,
    });
    if (!res.ok) throw await this.readError(res, cameraId);
    return (await res.json()) as Record<string, unknown>;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const call = this.options.fetchImpl ?? fetch;
    try {
      return await call(`${this.base}${path}`, { ...init, signal: AbortSignal.timeout(this.options.timeoutMs) });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Object3dError(`3D 추론 사이드카에 닿지 못했습니다 (${this.base}): ${message}`, 'unreachable', 502);
    }
  }

  /**
   * 사이드카 `code` → 이 서비스의 상태코드. 상류 `control-api.mjs:552-579` 의 매핑을 따른다.
   * 상류 상태코드를 그대로 흘리지 않는 이유는 두 서비스의 계약이 붙어 버리기 때문이다.
   */
  private async readError(res: Response, cameraId: string): Promise<DetectorError> {
    const text = await res.text().catch(() => '');
    let code = '';
    let message = text.slice(0, 300) || `HTTP ${res.status}`;
    try {
      const detail = (JSON.parse(text) as { detail?: { code?: string; message?: string } }).detail;
      if (detail) {
        code = detail.code ?? '';
        message = detail.message ?? message;
      }
    } catch {
      /* 본문이 JSON 이 아니면 원문 앞부분만 싣는다 */
    }

    if (code === 'no_calibration') {
      // 설정 문제다 — 운영자가 파일 하나 놓으면 끝난다. 어느 파일인지까지 말한다.
      return new Object3dError(
        `기기 "${cameraId}" 의 3D 캘리브레이션을 쓸 수 없습니다 — baro_calory/tools/baro_object3d_api/config/cameras/${cameraId}.json (사이드카 사유: ${message})`,
        code,
        422,
      );
    }
    if (code === 'model_unavailable') {
      // 이 호스트에 런타임이 없다는 **확정 답**이다 — 재시도해 봐야 같은 답이 온다.
      return new Object3dError(
        `이 호스트에 3D 런타임이 준비되지 않았습니다 — baro_object3d_api 의 준비 스크립트를 먼저 돌리십시오. (${message})`,
        code,
        501,
      );
    }
    return new Object3dError(message, code || 'object3d_failed', 502);
  }
}
