import { CameraDriverError } from './contract.js';
import { RETURN_CODE, RETURN_CODE_DESCRIPTIONS } from './idisConstants.js';

/**
 * **"이 응답을 믿어도 되는가" 의 단일 판정소.** 외부 I/O 없는 순수 계층.
 *
 * 미구현 액션이 드러나는 경로가 둘이고(무관한 설정 덤프 / `returnCode=9000`), 그 둘이
 * `'unknown-action'` 이라는 한 값으로 합쳐지는 자리가 여기다. 그래서 "미구현" 의 정의가
 * 코드 전체에 딱 한 군데만 있다.
 */

export type ReplyClass = 'answer' | 'unknown-action' | 'auth' | 'param' | 'error';

/**
 * 본문이 이 API 의 응답인지 판정한다.
 *
 * **`returnCode=` 로 시작하는지가 유일한 신뢰 신호다.** 같은 CGI 가 존재하지 않는 액션명에도
 * 200 + 무관한 설정 덤프를 돌려준 적이 있다 `[실측 DC-S6286HRXLT]` — HTTP 상태도, 본문의
 * 유무도 성공 판정이 될 수 없다. 선행 공백·개행은 허용한다.
 */
export function isIdisReply(text: string): boolean {
  return /^\s*returnCode\s*=/.test(text);
}

/**
 * `returnCode=0&a=1&b=2` → `{ returnCode:'0', a:'1', b:'2' }`.
 *
 * 값은 URI 인코딩이므로 `decodeURIComponent` 로 푼다 `[매뉴얼 §0]` — 풀지 않으면 프리셋
 * 이름에 공백·한글이 들어갈 때 `door%20A` 가 그대로 화면에 나간다. 디코딩이 실패하는
 * 이스케이프(`%zz`)는 **원문을 그대로 남긴다** — 던져서 응답 전체를 버리는 것보다 낫다.
 *
 * `+` 를 공백으로 바꾸지 **않는다**. 매뉴얼이 말하는 것은 form 인코딩이 아니라 URI
 * 인코딩(공백은 `%20`)이고, `+` 를 접으면 이름에 정말로 `+` 가 든 프리셋이 깨진다.
 */
export function parseQueryReply(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of text.trim().split('&')) {
    const at = pair.indexOf('=');
    if (at < 0) continue;
    out[pair.slice(0, at).trim()] = decodeValue(pair.slice(at + 1).trim());
  }
  return out;
}

function decodeValue(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 응답에서 `returnCode` 를 정수로 뽑는다. 없거나 정수가 아니면 `null`. */
export function returnCodeOf(text: string): number | null {
  const value = parseQueryReply(text).returnCode;
  return value !== undefined && /^-?\d+$/.test(value) ? Number(value) : null;
}

/** 미구현으로 읽는 코드. 셋 다 "이 펌웨어에 그 기능이 없다" 는 뜻이다. */
const UNKNOWN_ACTION_CODES: readonly number[] = [
  RETURN_CODE.UNKNOWN_API,
  RETURN_CODE.FUNCTION_NOT_SUPPORTED,
  RETURN_CODE.NOT_SUPPORT_CMD_THIS_VERSION,
];

/**
 * 파라미터 탓. **기기가 액션을 알아들었다는 증거**이므로 프로브에서는 '있음' 으로 읽는다.
 *
 * §58·§59 는 Write 전용이라 `mode=1` 프로브가 지원 기기에서도 `returnCode=0` 이 **아닐** 수
 * 있다. 참조구현은 `returnCode !== 0` 을 전부 "없음" 으로 읽어 지원 기기에서 거짓 음성을
 * 낸다 — 이 갈래가 그것을 고친다. 다만 **어느 코드가 실제로 오는지는 `[미확인]`** 이다.
 */
const PARAM_CODES: readonly number[] = [
  RETURN_CODE.INVALID_PARAMETER,
  RETURN_CODE.READ_ONLY_OR_MISMATCH,
  RETURN_CODE.NOT_ENOUGH_PARAMETERS,
];

/**
 * 인증·권한. **프로브도 이 갈래에서는 능력을 낮추지 않고 던진다** — 비밀번호 오타 하나가
 * "이 카메라는 아무것도 못 한다" 로 저장되면 고장난 카메라와 구분되지 않는다.
 * 참조구현에는 이 갈래가 없다(이 설계의 추가분이며 실측 대조는 `[미확인]`).
 */
const AUTH_CODES: readonly number[] = [
  RETURN_CODE.PASSWORD_AUTHENTICATION_FAILED,
  RETURN_CODE.PASSWORD_POLICY_VIOLATION,
  RETURN_CODE.NO_MATCHING_USER,
  RETURN_CODE.NOT_HAS_PERMISSION,
  RETURN_CODE.NOT_FOUND_SESSION_INFO,
];

/**
 * 응답 본문 하나를 다섯 갈래로 나눈다. 호출자의 처리는 다음과 같다.
 *
 * | 분류 | 일반 호출 | 능력 프로브 |
 * |---|---|---|
 * | `answer`         | 파싱 결과 반환 | 있음 |
 * | `param`          | 400 던짐      | **있음**(기기가 액션을 알아들었다) |
 * | `unknown-action` | 501 던짐      | 없음 |
 * | `auth`           | 던짐          | **던짐**(능력을 낮추지 않는다) |
 * | `error`          | 502 던짐      | 없음(안전한 쪽) |
 */
export function classifyReply(text: string): ReplyClass {
  if (!isIdisReply(text)) return 'unknown-action';
  const code = returnCodeOf(text);
  if (code === RETURN_CODE.SUCCESS) return 'answer';
  if (code === null) return 'error';
  if (UNKNOWN_ACTION_CODES.includes(code)) return 'unknown-action';
  if (PARAM_CODES.includes(code)) return 'param';
  if (AUTH_CODES.includes(code)) return 'auth';
  return 'error';
}

/** `returnCode` 에 §75 전표의 사람 문장을 붙인다. 모르는 코드는 번호만 남긴다. */
export function describeReturnCode(code: number | null): string {
  if (code === null) return 'returnCode 없음';
  const description = RETURN_CODE_DESCRIPTIONS[code];
  return description ? `returnCode=${code} (${description})` : `returnCode=${code}`;
}

/**
 * 자격증명·권한 문제. **능력 프로브가 이것을 만나면 능력을 낮추지 않고 그대로 올린다.**
 *
 * `statusCode` 를 401 이 아니라 502 로 두는 이유: 이 401 은 **우리와 카메라 사이**의 것이고,
 * 그대로 브라우저에 내보내면 사용자 자신의 세션이 끊긴 것처럼 보인다.
 */
export class IdisAuthError extends CameraDriverError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 502, options);
    this.name = 'IdisAuthError';
  }
}

/** 이 펌웨어에 그 액션이 없다. 지어내지 않고 501 로 명시 거절한다. */
export class IdisUnknownActionError extends CameraDriverError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 501, options);
    this.name = 'IdisUnknownActionError';
  }
}
