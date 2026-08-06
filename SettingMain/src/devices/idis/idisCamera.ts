import { CameraDriverError, type CameraDriver, type CenterPoint, type PtzRaw, type Slot } from './contract.js';
import {
  ACTION,
  CGI_PATH,
  CONTRACT_FRAME,
  MODE,
  MOVE_COMMANDS,
  MOVE_SPEED_RANGE,
  PRESET_ID_RANGE,
} from './idisConstants.js';
import { pointToWire, ptzToContract, ptzToWire } from './idisCoords.js';
import {
  IdisAuthError,
  IdisUnknownActionError,
  classifyReply,
  describeReturnCode,
  isIdisReply,
  parseQueryReply,
  returnCodeOf,
} from './idisReply.js';
import {
  IdisTransportError,
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  authorizedRequest,
  isTransportError,
  type IdisRequestOptions,
  type IdisResponse,
} from './idisTransport.js';

/**
 * IDIS WebAPI v2.20 카메라 드라이버.
 *
 * 단일 CGI(`/cgi-bin/webSetup.cgi`)에 `action=` 으로 분기하고 인증은 Digest 다. 실측기
 * DC-S6261XT 는 절대 PTZ 를 갖고 평문 HTTP(80)로 열려 있으며, **미구현 액션에는
 * `returnCode=9000`(Unknown API)으로 정직하게 답한다** `[실측 2026-07-29]`.
 *
 * ## 이 파일이 지키는 두 가지 함정
 *
 * 1. **200 이고 본문이 있다는 것은 성공 판정이 될 수 없다.** 같은 CGI 가 존재하지 않는
 *    액션명에도 무관한 설정 덤프를 돌려준 적이 있다 `[실측 DC-S6286HRXLT]`. 유일한 신뢰
 *    신호는 본문이 `returnCode=` 로 시작하는지이며, 그 판정은 `idisReply.ts` 한 곳에 있다.
 * 2. **범위 밖 값에는 `returnCode=0` 으로 답하면서 조용히 다른 데로 간다.** `absZoom=3000`
 *    → 1200, `absTilt=−3000` → **오토플립으로 팬 180° 회전** `[실측]`. 그래서 `goPtz` 는
 *    보내기 전에 `idisCoords.ts` 의 와이어 범위로 자른다 — 계약 범위(`domain/ptz.ts` 의
 *    `clampPtz`)로 자르면 이 기기에서는 아무 소용이 없다.
 *
 * ## 능력은 상한만 선언하고 프로브가 좁힌다
 *
 * 같은 벤더·같은 CGI 인데 DC-S6286HRXLT 에는 `ptzAbsolute` 가 아예 없다 `[실측 2026-07-31]`.
 * **경계는 벤더가 아니라 개체(모델·펌웨어)** 이므로 상한에 낙관을 두고 `probeCapabilities()`
 * 가 기기에 물어 좁힌다. 상한에 비관을 두면 멀쩡히 되는 기기가 프로브 전까지 거부된다.
 */

export interface IdisClientOptions {
  cameraId: string;
  /** `http://host:port`. 자격증명·query·fragment 가 붙어 있으면 400 으로 거절한다. */
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
  /**
   * 이 기기 **하나에** 한해 TLS 인증서 검증을 끈다. 공장 자체서명 인증서를 쓰는 모델이
   * 있고, 프로세스 전역 `NODE_TLS_REJECT_UNAUTHORIZED` 는 서비스 전체의 검증을 끄므로
   * 답이 아니다. 기본값은 검증(안전한 쪽).
   */
  insecureTls?: boolean;
  /**
   * 스냅샷 스트림 번호 `[매뉴얼 §24]`. 실측기에서 1 이 동작한다 — 설정·DB 로 올리지 않고
   * 드라이버 옵션으로만 둔다.
   */
  streamIndex?: number;
}

/** 이 드라이버가 아는 능력 어휘. **`CameraDriver` 계약 밖이며 이 서브트리 안에만 있다.** */
export interface IdisCapabilities {
  snapshot: boolean;
  absolutePosition: boolean;
  relativeMove: boolean;
  presets: boolean;
  pixelCentering: boolean;
  boxZoom: boolean;
}

export interface IdisPreset {
  id: number;
  name: string;
}

/**
 * 능력 **상한** 선언. `false` 를 미리 박지 않는다 — 참조구현은 실측기 한 대의 사실
 * (`pixelCentering`/`boxZoom` 없음)을 벤더 전체의 상한으로 옮겨 적었고, 그러면
 * `ptzMoveToPoint` 를 가진 모델에서 있는 기능을 스스로 버린다.
 */
const DECLARED_CAPABILITIES: IdisCapabilities = {
  snapshot: true,
  absolutePosition: true,
  relativeMove: true,
  presets: true,
  pixelCentering: true,
  boxZoom: true,
};

type Params = Record<string, string | number>;

export class IdisCameraClient implements CameraDriver {
  readonly kind = 'idis';
  readonly cameraId: string;

  private readonly origin: URL;
  private readonly insecureTls: boolean;
  private readonly streamIndex: number;
  private capabilityState: IdisCapabilities = { ...DECLARED_CAPABILITIES };
  /** `centerPoint` 첫 호출에서 한 번만 프로브하고 기억한다. */
  private pixelCentering: boolean | undefined;

  constructor(private readonly options: IdisClientOptions) {
    this.cameraId = options.cameraId;
    this.origin = controlOrigin(options.baseUrl);
    this.insecureTls = options.insecureTls === true;
    this.streamIndex = Number.isInteger(options.streamIndex) ? Number(options.streamIndex) : 1;
  }

  /** 지금까지 알려진 능력. 프로브 전에는 상한 선언 그대로다. */
  get capabilities(): IdisCapabilities {
    return { ...this.capabilityState };
  }

  // --- CameraDriver 계약 ------------------------------------------------------

  async getPtz(): Promise<PtzRaw> {
    const values = await this.answer(ACTION.PTZ_ABSOLUTE, { mode: MODE.READ });
    return ptzToContract({
      absPan: requireInt(values, 'absPan'),
      absTilt: requireInt(values, 'absTilt'),
      absZoom: requireInt(values, 'absZoom'),
    });
  }

  /**
   * **`speed` 는 받되 버린다.** `ptzAbsolute` 에 속도 파라미터가 없다 `[매뉴얼 §56]`.
   * 조용히 버리지 않고 여기 적어 두는 이유는, 속도를 준 호출자가 "느리게 갈 것" 으로
   * 기대하고 타이밍을 짜면 어긋나기 때문이다. (상대 이동 `ptzCommand` 에는 속도가 있다 —
   * 다만 눈금이 1~16 이라 Hucoms 의 1~100 과 다르다.)
   */
  async goPtz(target: PtzRaw, _speed?: number): Promise<void> {
    await this.answer(ACTION.PTZ_ABSOLUTE, { mode: MODE.WRITE, ...ptzToWire(target) }, 'POST');
  }

  /**
   * 픽셀 센터링. **소프트웨어 센터링으로 대신하지 않는다** — 이 기기의 광학을 모르는 채
   * 각도를 계산하면 조준이 조용히 빗나간다. 기기에 `ptzMoveToPoint` 가 없으면 501 로
   * 명시 거절한다.
   */
  async centerPoint(point: CenterPoint): Promise<void> {
    if (!Number.isInteger(point.x) || point.x < 0 || point.x > CONTRACT_FRAME.width
      || !Number.isInteger(point.y) || point.y < 0 || point.y > CONTRACT_FRAME.height) {
      throw new CameraDriverError('센터링 좌표는 1920×1080 프레임의 정수여야 합니다', 400);
    }
    if (this.pixelCentering === undefined) {
      this.pixelCentering = await this.probeAction(ACTION.PTZ_MOVE_TO_POINT, { mode: MODE.READ });
    }
    if (!this.pixelCentering) {
      throw new IdisUnknownActionError('이 IDIS 기기에는 ptzMoveToPoint 가 없습니다 — 픽셀 센터링을 지원하지 않습니다');
    }
    await this.answer(ACTION.PTZ_MOVE_TO_POINT, { mode: MODE.WRITE, ...pointToWire(point) }, 'POST');
  }

  async getSnapshot(): Promise<Buffer> {
    const response = await this.send(ACTION.VIDEO_SNAPSHOT, { mode: MODE.READ, streamIndex: this.streamIndex }, 'GET', MAX_IMAGE_BYTES);
    this.requireHttpOk(response, ACTION.VIDEO_SNAPSHOT);
    const body = response.body;
    // 미구현·오류는 이미지 자리에 텍스트로 온다 — 그 판정을 먼저 한다.
    if (isIdisReply(body.subarray(0, 64).toString('latin1'))) {
      throw this.replyError(ACTION.VIDEO_SNAPSHOT, body.subarray(0, MAX_TEXT_BYTES).toString('utf8'));
    }
    // **바이트가 1차 신호다.** §25 는 Content-Type 을 `image/webp` 라 적어 놓고 Data 는
    // JPEG 라고 적는 모순이 있어 헤더만 믿을 수 없다 `[매뉴얼 §25]`.
    if (body.length < 2 || body[0] !== 0xff || body[1] !== 0xd8) {
      throw new CameraDriverError('스냅샷이 JPEG 가 아닙니다 — 계정·권한과 해당 스트림이 JPEG 로 설정돼 있는지 확인하세요');
    }
    return body;
  }

  /** IDIS 기기는 주차면 개념이 없다. 오류가 아니라 빈 배열이다. */
  async listSlots(): Promise<Slot[]> {
    return [];
  }

  // --- 서브트리 전용 (계약 밖) --------------------------------------------------

  /**
   * "정말 이 벤더인가". `modelInformation` 은 `model`·`modelGroup`·`softwareVersion`·
   * `webApiVersion` 을 준다 `[매뉴얼 §4]`. 원문 Method 가 **POST** 라 POST 로 보낸다.
   */
  async identify(): Promise<Record<string, string>> {
    return this.answer(ACTION.MODEL_INFORMATION, { mode: MODE.READ }, 'POST');
  }

  /** 기기가 스스로 답하는 역량 원문 `[매뉴얼 §47]`. **자칭이므로 참고만 한다** — 이 벤더는 픽셀 센터링이 없는데도 `supportPan=on` 이라고 답한다 `[실측]`. */
  async getPtzCapabilities(): Promise<Record<string, string>> {
    return this.answer(ACTION.PTZ_CAPABILITY, { mode: MODE.READ });
  }

  async getPtzStatus(): Promise<Record<string, string>> {
    return this.answer(ACTION.PTZ_STATUS, { mode: MODE.READ });
  }

  /** 장비에 등록된 프리셋 목록과 **이름** `[매뉴얼 §50]`. id 오름차순. */
  async listPresets(): Promise<IdisPreset[]> {
    const values = await this.answer(ACTION.PTZ_PRESET, { mode: MODE.READ });
    const presets: IdisPreset[] = [];
    for (const [key, name] of Object.entries(values)) {
      const matched = /^presetName(\d+)$/.exec(key);
      if (matched) presets.push({ id: Number(matched[1]), name });
    }
    return presets.sort((a, b) => a.id - b.id);
  }

  async gotoPreset(id: number): Promise<void> {
    await this.answer(ACTION.PTZ_PRESET, { mode: MODE.WRITE, command: 'moveTo', id: assertPresetId(id) }, 'POST');
  }

  async setPreset(id: number, presetName: string): Promise<void> {
    await this.answer(ACTION.PTZ_PRESET, { mode: MODE.WRITE, command: 'set', id: assertPresetId(id), presetName }, 'POST');
  }

  async removePreset(id: number): Promise<void> {
    await this.answer(ACTION.PTZ_PRESET, { mode: MODE.WRITE, command: 'remove', id: assertPresetId(id) }, 'POST');
  }

  /** 상대 이동 `[매뉴얼 §48]`. `step=0` 이 연속 이동이고, 속도 눈금은 1~16 이다. */
  async ptzCommand(input: { command: string; step?: number; speed?: number }): Promise<Record<string, string>> {
    if (!(MOVE_COMMANDS as readonly string[]).includes(input.command)) {
      throw new CameraDriverError(`알 수 없는 IDIS PTZ 명령입니다: ${input.command} — 아는 명령은 ${MOVE_COMMANDS.join(', ')} 입니다`, 400);
    }
    const step = Number.isInteger(input.step) ? Number(input.step) : 0;
    const speed = clamp(input.speed ?? 4, MOVE_SPEED_RANGE.min, MOVE_SPEED_RANGE.max);
    return this.answer(ACTION.PTZ_COMMAND, { mode: MODE.WRITE, command: input.command, step, speed }, 'POST');
  }

  async stop(): Promise<Record<string, string>> {
    return this.ptzCommand({ command: 'stop' });
  }

  /**
   * **원본 액션 통로.** 매뉴얼의 나머지 60여 절(`ACTION_CATALOG`)을 래퍼 없이 부르는 자리다.
   * §75 판정을 그대로 거치므로 미구현·인증·파라미터 갈래가 코어와 똑같이 다뤄진다.
   */
  async raw(action: string, params: Params = {}, method: 'GET' | 'POST' = 'GET'): Promise<Record<string, string>> {
    return this.answer(action, params, method);
  }

  /**
   * 능력 실측. **못 닿은 것과 못 하는 것을 구분하는 것이 이 함수의 전부다.**
   *
   * 전송 실패·인증 실패는 능력을 낮추지 않고 **던진다** — 케이블 하나 빠진 것이나 비밀번호
   * 오타 하나가 "이 카메라는 아무것도 못 한다" 로 저장되면 고장난 카메라와 구분되지 않는다.
   */
  async probeCapabilities(): Promise<IdisCapabilities> {
    // 첫 줄은 벤더 확인이다. `type:"flexwatch"` 로 등록된 기기가 실은 IDIS 였고 모든 호출이
    // 실패해 능력이 전부 false 로 나온 사고가 있었다 `[실측 2026-07-31]`.
    try {
      await this.identify();
    } catch (error) {
      if (isTransportError(error) || error instanceof IdisAuthError) throw error;
      throw new CameraDriverError(
        `${this.cameraId} 는 IDIS WebAPI 로 응답하지 않습니다 — 카메라 종류(kind) 설정을 확인하세요`,
        502,
        { cause: error },
      );
    }

    const next: IdisCapabilities = { ...this.capabilityState };
    next.absolutePosition = await this.probeAction(ACTION.PTZ_ABSOLUTE, { mode: MODE.READ });
    next.pixelCentering = await this.probeAction(ACTION.PTZ_MOVE_TO_POINT, { mode: MODE.READ });
    next.boxZoom = await this.probeAction(ACTION.PTZ_MOVE_TO_AREA, { mode: MODE.READ });
    next.presets = await this.probeAction(ACTION.PTZ_PRESET, { mode: MODE.READ });
    // `relativeMove` 는 프로브하지 않는다 — 실제로 확인하려면 카메라를 움직여야 하고,
    // `ptzCapability` 의 `supportPTZ` 는 자칭이라 믿을 수 없다. 상한 true 를 유지한다.
    try {
      await this.getSnapshot();
      next.snapshot = true;
    } catch (error) {
      if (isTransportError(error) || error instanceof IdisAuthError) throw error;
      next.snapshot = false;
    }

    this.capabilityState = next;
    // `centerPoint` 의 메모이즈와 같은 사실이므로 함께 채운다(같은 것을 두 번 묻지 않는다).
    this.pixelCentering = next.pixelCentering;
    return { ...next };
  }

  // --- 내부 -------------------------------------------------------------------

  /**
   * 액션 하나가 이 펌웨어에 있는지 묻는다. **`mode=1`(읽기)만 쓴다** — `mode=0` 으로
   * 프로브하면 카메라가 실제로 움직인다.
   *
   * `param`(301/302/304)을 **'있음'** 으로 읽는 것이 참조구현과 다른 자리다. §58·§59 는
   * Write 전용이라 지원 기기에서도 `mode=1` 이 `returnCode=0` 이 아닐 수 있고, 그것을 전부
   * "없음" 으로 읽으면 지원 기기에서 거짓 음성이 난다. **어느 코드가 실제로 오는지는
   * `[미확인]`** 이라 나머지 갈래는 안전한 쪽('없음')에 둔다.
   */
  private async probeAction(action: string, params: Params): Promise<boolean> {
    // 전송 실패는 여기서 잡지 않는다 — 그대로 올라가 호출자가 던진다.
    const response = await this.send(action, params, 'GET', MAX_TEXT_BYTES);
    if (response.status === 401 || response.status === 403) {
      throw new IdisAuthError(`IDIS 액션 "${action}" 이 HTTP ${response.status} 로 거절됐습니다 — 계정·권한을 확인하세요`);
    }
    if (response.status < 200 || response.status >= 300) return false;
    const verdict = classifyReply(response.body.toString('utf8'));
    if (verdict === 'auth') {
      throw new IdisAuthError(`IDIS 액션 "${action}" 이 인증·권한으로 거절됐습니다 — 계정·권한을 확인하세요`);
    }
    return verdict === 'answer' || verdict === 'param';
  }

  /** 응답을 §75 판정에 걸어 통과한 것만 파싱해 돌려준다. */
  private async answer(action: string, params: Params, method: 'GET' | 'POST' = 'GET'): Promise<Record<string, string>> {
    const response = await this.send(action, params, method, MAX_TEXT_BYTES);
    this.requireHttpOk(response, action);
    const text = response.body.toString('utf8');
    if (classifyReply(text) !== 'answer') throw this.replyError(action, text);
    return parseQueryReply(text);
  }

  private requireHttpOk(response: IdisResponse, action: string): void {
    if (response.status === 401 || response.status === 403) {
      throw new IdisAuthError(`IDIS 액션 "${action}" 이 HTTP ${response.status} 로 거절됐습니다 — 계정·권한을 확인하세요`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new CameraDriverError(`IDIS 액션 "${action}" 이 HTTP ${response.status} 로 실패했습니다`);
    }
  }

  /** 분류 하나당 오류 하나. `answer` 는 오류가 아니므로 호출자가 먼저 걸러야 한다. */
  private replyError(action: string, text: string): CameraDriverError {
    const code = returnCodeOf(text);
    switch (classifyReply(text)) {
      case 'unknown-action':
        return new IdisUnknownActionError(isIdisReply(text)
          ? `IDIS 액션 "${action}" 이 이 펌웨어에 없습니다 — ${describeReturnCode(code)}`
          : `IDIS 액션 "${action}" 이 이 펌웨어에 없습니다 — 응답이 returnCode= 로 시작하지 않습니다(무관한 설정 덤프)`);
      case 'auth':
        return new IdisAuthError(`IDIS 액션 "${action}" 이 인증·권한으로 거절됐습니다 — ${describeReturnCode(code)}`);
      case 'param':
        return new CameraDriverError(`IDIS 액션 "${action}" 이 파라미터를 거절했습니다 — ${describeReturnCode(code)}`, 400);
      case 'answer':
        return new CameraDriverError(`IDIS 액션 "${action}" 이 예상과 다른 형태로 답했습니다`);
      default:
        return new CameraDriverError(`IDIS 액션 "${action}" 이 오류를 반환했습니다 — ${describeReturnCode(code)}`);
    }
  }

  /**
   * 한 번의 HTTP 왕복. **POST 는 폼 본문으로 나가고 쿼리로 새지 않는다** `[매뉴얼 §50·§56·§58
   * 의 Write 는 POST]` — 쓰기 파라미터가 URL 에 남으면 프록시·접속 로그에 그대로 적힌다.
   */
  private async send(action: string, params: Params, method: 'GET' | 'POST', maxBytes: number): Promise<IdisResponse> {
    const url = new URL(CGI_PATH, this.origin);
    const all = formParams({ action, ...params });
    const init: IdisRequestOptions = {
      method,
      timeoutMs: this.options.timeoutMs,
      rejectUnauthorized: !this.insecureTls,
      maxBytes,
    };
    if (method === 'POST') {
      init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      init.body = new URLSearchParams(all).toString();
    } else {
      for (const [key, value] of Object.entries(all)) url.searchParams.set(key, value);
    }
    try {
      return await authorizedRequest(url, init, this.options.username, this.options.password);
    } catch (error) {
      // 전송 오류는 **표식을 지키면서** 문구만 마스킹해 다시 던진다.
      if (isTransportError(error)) throw new IdisTransportError(this.mask(error.message), { cause: error.cause });
      throw error;
    }
  }

  /** 오류 문구에 비밀번호가 실려 로그로 새는 것을 막는다 `[본체 hucomsClient.ts]` 의 관례. */
  private mask(message: string): string {
    let masked = message;
    for (const secret of [this.options.password, encodeURIComponent(this.options.password)]) {
      if (secret) masked = masked.replaceAll(secret, '***');
    }
    return masked;
  }
}

/** 자격증명이 박힌 URL 은 거절한다 `[본체 hucomsPresetClient.ts]` 의 관례 — 로그·오류로 샌다. */
function controlOrigin(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (cause) {
    throw new CameraDriverError('제어 URL 이 올바르지 않습니다', 400, { cause });
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new CameraDriverError('제어 URL 은 인증·query·fragment 없는 http(s) 주소여야 합니다', 400);
  }
  return new URL(parsed.origin);
}

/** 빈 값은 보내지 않는다. **`0` 은 빈 값이 아니다** — `step=0` 이 연속 이동이라 지우면 뜻이 바뀐다. */
function formParams(params: Params): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = String(value);
  }
  return out;
}

function requireInt(values: Record<string, string>, key: string): number {
  const raw = values[key];
  if (raw === undefined || !/^-?\d+$/.test(raw)) {
    throw new CameraDriverError(`IDIS 응답에 정수 ${key} 가 없습니다`);
  }
  return Number(raw);
}

function assertPresetId(id: number): number {
  if (!Number.isInteger(id) || id < PRESET_ID_RANGE.min || id > PRESET_ID_RANGE.max) {
    throw new CameraDriverError(`IDIS 프리셋 id 는 ${PRESET_ID_RANGE.min}~${PRESET_ID_RANGE.max} 정수여야 합니다`, 400);
  }
  return id;
}

function clamp(value: number, min: number, max: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
