import { clampPtz, type PtzRaw } from '../../domain/ptz.js';
import { CameraDriverError, type CameraDriver, type Slot } from '../cameraDriver.js';

/**
 * 언리얼 Park3D JSON-RPC 2.0 드라이버 (`POST /rpc`).
 *
 * **Hucoms CGI 가 아니다** — 같은 시뮬레이터라도 이쪽은 `cam.getPTZ`·`cam.setPTZ` 를 쓰고,
 * `/cgi-bin/...` 을 두드리면 UE HTTP 서버가 `route_handler_not_found` 로 404 를 돌려준다.
 *
 * **인증을 쓰지 않는다.** 이 서버는 무인증으로 열려 있다(실측: 토큰 헤더 없이 `POST /rpc`·`GET /stream` 모두 200).
 * 지금 없는 인증을 미리 배선하지 않는다 — 서버가 나중에 인증을 켜면 401/403 이 아래 `!response.ok` 분기에서
 * 오류로 즉시 드러나므로 조용히 실패하지 않는다.
 *
 * **단위 변환은 이 클래스 안에 갇힌다.** 상위 계층(PtzRaw·clampPtz·toView·화면)은 지금까지처럼 정수 raw 만 보고,
 * Park3D 가 쓰는 도(度)·배율 실수 ↔ raw 환산은 여기서만 일어난다.
 *   pan/tilt : 도 × 100 (centi-deg) — Hucoms 와 같은 단위라 화면의 도 표시가 그대로 맞는다
 *   zoom     : **배율 × 100** (1.58배 ↔ 158) — Hucoms 의 불투명 raw 와 뜻이 다르다
 *
 * 계약 근거(라이브 서버 실측 + 형제 프로젝트 SettingAgent/src/clients/RpcCameraClient.ts):
 *   POST /rpc  {jsonrpc,id,method,params}
 *   cam.getPTZ    {camId}                  → {pan, tilt, zoom}  (도·배율 실수)
 *   cam.setPTZ    {camId, pan, tilt, zoom} (도·배율 실수)
 *   cam.captureJPG{camId}                  → {img_bytes: base64}
 */

export interface Park3DRpcClientOptions {
  cameraId: string;
  baseUrl: string;
  /** Park3D 카메라 번호. **1-based**. 없으면 조작 시점에 400 으로 던진다(임의로 1번을 움직이지 않는다). */
  camId?: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** zoom raw 유효범위. 근거: SettingAgent/config/tools.config.json `camera.zoomMin=1 / zoomMax=36` (배율 × 100). */
const ZOOM_RAW_MIN = 100;
const ZOOM_RAW_MAX = 3600;

interface RpcEnvelope {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export class Park3DRpcClient implements CameraDriver {
  readonly kind = 'park3d-rpc';
  readonly cameraId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: Park3DRpcClientOptions) {
    this.cameraId = options.cameraId;
    if (!options.baseUrl) throw new CameraDriverError('제어 URL 이 설정되지 않았습니다', 400);
    // `/rpc`·`/health`·`/stream` 은 모두 루트 서비스다. controlUrl 에 경로 접미사가 붙어 있으면
    // `/stream/rpc` 같은 주소로 조립돼 404 가 난다(형제 프로젝트에서 실제로 겪은 사고).
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getPtz(): Promise<PtzRaw> {
    const result = await this.callRpc('cam.getPTZ', { camId: this.requireCamId() });
    const values = (result ?? {}) as Record<string, unknown>;
    return {
      pan: Math.round(this.requireNumber(values, 'pan') * 100),
      tilt: Math.round(this.requireNumber(values, 'tilt') * 100),
      zoom: Math.round(this.requireNumber(values, 'zoom') * 100),
    };
  }

  /**
   * 입력은 상위 계층의 raw 정수다. `speed` 는 **무시한다** — Park3D `cam.setPTZ` 계약에 속도 파라미터가 없다.
   * 없는 파라미터를 지어 보내면 서버가 조용히 버려 "속도를 줬는데 왜 안 먹지"가 된다.
   */
  async goPtz(target: PtzRaw, _speed?: number): Promise<void> {
    const camId = this.requireCamId();
    const safe = clampPtz(target);
    // zoom 만 기기별 범위가 다르다. 공유 ZOOM_RANGE(0~65535)는 Hucoms 것이므로 여기서 한 번 더 자른다.
    const zoomRaw = Math.min(ZOOM_RAW_MAX, Math.max(ZOOM_RAW_MIN, safe.zoom));
    await this.callRpc('cam.setPTZ', {
      camId,
      pan: safe.pan / 100,
      tilt: safe.tilt / 100,
      zoom: zoomRaw / 100,
    });
  }

  async getSnapshot(): Promise<Buffer> {
    const result = await this.callRpc('cam.captureJPG', { camId: this.requireCamId() });
    const encoded = ((result ?? {}) as Record<string, unknown>).img_bytes;
    if (typeof encoded !== 'string' || !encoded) {
      throw new CameraDriverError('Park3D 가 스냅샷 데이터(img_bytes)를 주지 않았습니다');
    }
    const body = Buffer.from(encoded, 'base64');
    // base64 디코드는 쓰레기 입력도 조용히 통과시킨다. JPEG SOI 로 실제 이미지인지 판정한다.
    if (body.length < 2 || body[0] !== 0xff || body[1] !== 0xd8) {
      throw new CameraDriverError('스냅샷이 JPEG 가 아닙니다 — cam.captureJPG 응답을 확인하세요');
    }
    return body;
  }

  /** Park3D 에는 주차면 개념이 없다(오류가 아니다). */
  async listSlots(): Promise<Slot[]> {
    return [];
  }

  // `centerPoint` 는 구현하지 않는다 — Park3D 에 대응 계약이 없다.
  // CameraDriver 의 선택 메서드이므로, 없으면 코어가 center 능력을 ok:false 로 광고한다.

  private async callRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const url = `${this.baseUrl}/rpc`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        // 인증 헤더를 싣지 않는다 — 이 서버는 무인증이다.
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new CameraDriverError(`Park3D RPC 통신 실패 (${url} ${method}): ${reason}`, 502, { cause });
    }

    // 본문은 text() 로 **1회만** 읽는다 — json() 은 스트림을 소비해, 실패했을 때 원문을 다시 읽을 수 없다.
    // 그러면 오류 메시지에 서버가 실제로 돌려준 내용을 실을 수 없어 오진(경로 오배선 등)이 반복된다.
    const raw = await response.text();
    let body: RpcEnvelope;
    try {
      body = JSON.parse(raw) as RpcEnvelope;
    } catch {
      throw new CameraDriverError(`Park3D RPC 응답을 해석할 수 없습니다: HTTP ${response.status} ${url} ${method} — ${raw.slice(0, 200)}`);
    }

    // ① JSON-RPC error 봉투가 상태코드보다 **먼저**다. 이 서버는 오류도 HTTP 200 으로 보내므로
    //    상태코드를 먼저 보면 `-32000 필수 파라미터 누락` 같은 사유가 통째로 사라진다.
    if (body.error) {
      throw new CameraDriverError(`Park3D RPC 오류 [${body.error.code}]: ${body.error.message ?? '(사유 없음)'}`);
    }
    // ② 봉투 없는 non-2xx 는 요청이 RPC 계층에 닿지도 못했다는 뜻이다(라우트 미존재·인증 거부 등).
    //    이 검사를 빼면 404 본문이 result:undefined 로 조용히 통과해 먼 곳에서 TypeError 로 터진다.
    if (!response.ok) {
      throw new CameraDriverError(`Park3D RPC HTTP ${response.status} (${url} ${method}) — ${raw.slice(0, 200)}`);
    }
    return body.result;
  }

  /** camId 는 park3d-rpc 필수다. 없을 때 1번으로 때우면 **엉뚱한 카메라를 움직인다**. */
  private requireCamId(): number {
    const camId = this.options.camId;
    if (typeof camId !== 'number' || !Number.isInteger(camId) || camId < 1) {
      throw new CameraDriverError(`park3d-rpc 카메라 ${this.cameraId} 에 camId 를 설정하세요 (config.json, 1-based 정수)`, 400);
    }
    return camId;
  }

  /** 조용한 0 폴백을 만들지 않는다 — 스키마가 바뀌면 카메라가 원점으로 가는 대신 오류가 나야 한다. */
  private requireNumber(values: Record<string, unknown>, key: string): number {
    const value = values[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new CameraDriverError(`Park3D 가 PTZ 값 ${key} 를 주지 않았습니다`);
    }
    return value;
  }
}
