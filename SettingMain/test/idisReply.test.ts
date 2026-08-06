import { describe, expect, it } from 'vitest';
import {
  classifyReply,
  describeReturnCode,
  isIdisReply,
  parseQueryReply,
  returnCodeOf,
} from '../src/devices/idis/idisReply.js';
import { MODE, RETURN_CODE } from '../src/devices/idis/idisConstants.js';

/**
 * 계획 §7 `test/idisReply.test.ts` — T-R1~T-R9.
 *
 * **"이 응답을 믿어도 되는가" 의 단일 판정소**를 못으로 박는다. 미구현이 드러나는 경로가 둘
 * (무관한 설정 덤프 / `returnCode=9000`)이고 그 둘이 한 값으로 합쳐지는 자리라, 여기가 느슨해지면
 * "없는 기능"이 "성공"으로 읽힌다.
 *
 * 픽스처 문자열은 전부 `[매뉴얼]` Example 이거나 `[실측 덤프]` 다.
 */

/** `[실측 DC-S6286HRXLT 덤프]` — 존재하지 않는 액션명에 200 + 무관한 설정 덤프가 왔다. */
const DUMP = 'motion_type="rect"\narea_count=1';
/** `[매뉴얼 §56:8513 Example]` */
const PTZ_EXAMPLE = 'returnCode=0&absPan=18000&absTilt=8850&absZoom=3000';

describe('T-R1 returnCode= 로 시작하지 않는 본문은 미구현이다', () => {
  it('설정 덤프는 200 이고 본문이 있어도 응답이 아니다', () => {
    expect(isIdisReply(DUMP)).toBe(false);
    expect(classifyReply(DUMP)).toBe('unknown-action');
  });

  it('빈 본문·HTML 오류 페이지도 마찬가지다', () => {
    expect(classifyReply('')).toBe('unknown-action');
    expect(classifyReply('<html><body>404</body></html>')).toBe('unknown-action');
  });

  it('본문 **중간**에 returnCode 가 있어도 응답이 아니다 — 앵커는 앞이다', () => {
    expect(classifyReply('motion_type="rect"\nreturnCode=0')).toBe('unknown-action');
  });
});

describe('T-R2 returnCode=9000 (Unknown API)', () => {
  it('미구현으로 읽는다', () => {
    expect(classifyReply('returnCode=9000')).toBe('unknown-action');
  });

  it('**`MODE.SYSTEM_RESTART`(9000) 과 섞이지 않는다** — 같은 숫자, 다른 축이다', () => {
    // 두 상수는 값이 같지만 뜻이 반대다. 이것을 섞으면 "이 액션이 있나"를 묻다가 카메라를 재부팅시킨다.
    expect(RETURN_CODE.UNKNOWN_API).toBe(9000);
    expect(MODE.SYSTEM_RESTART).toBe(9000);
    // 판정은 **응답의 returnCode** 만 본다 — mode=9000 이 실린 응답이라도 rc 가 0 이면 성공이다.
    expect(classifyReply('returnCode=0&mode=9000')).toBe('answer');
    expect(parseQueryReply('returnCode=0&mode=9000').mode).toBe('9000');
  });
});

describe('T-R3 310 / 308 도 미구현이다', () => {
  it('FUNCTION_NOT_SUPPORTED(310) · NOT_SUPPORT_CMD_THIS_VERSION(308)', () => {
    expect(classifyReply('returnCode=310')).toBe('unknown-action');
    expect(classifyReply('returnCode=308')).toBe('unknown-action');
    expect(RETURN_CODE.FUNCTION_NOT_SUPPORTED).toBe(310);
    expect(RETURN_CODE.NOT_SUPPORT_CMD_THIS_VERSION).toBe(308);
  });
});

describe('T-R4 returnCode=0 은 응답이고, 값 넷이 파싱된다', () => {
  it('`[매뉴얼 §56:8513 Example]` 원문', () => {
    expect(classifyReply(PTZ_EXAMPLE)).toBe('answer');
    expect(parseQueryReply(PTZ_EXAMPLE)).toEqual({
      returnCode: '0', absPan: '18000', absTilt: '8850', absZoom: '3000',
    });
    expect(returnCodeOf(PTZ_EXAMPLE)).toBe(0);
  });

  it('값은 **문자열 그대로** 온다 — 정수 변환은 호출자 몫이다', () => {
    const values = parseQueryReply(PTZ_EXAMPLE);
    for (const value of Object.values(values)) expect(typeof value).toBe('string');
  });
});

describe('T-R5 301 / 302 / 304 는 파라미터 탓 — 기기가 액션을 알아들었다는 증거다', () => {
  it('프로브에서 이 갈래를 "없음" 으로 읽으면 지원 기기에서 거짓 음성이 난다', () => {
    expect(classifyReply('returnCode=301')).toBe('param');
    expect(classifyReply('returnCode=302')).toBe('param');
    expect(classifyReply('returnCode=304')).toBe('param');
  });
});

describe('T-R6 900 / 903 / 306 은 인증·권한이다', () => {
  it('능력 프로브가 이 갈래에서 능력을 낮추면 비밀번호 오타가 고장난 카메라로 저장된다', () => {
    expect(classifyReply('returnCode=900')).toBe('auth');
    expect(classifyReply('returnCode=903')).toBe('auth');
    expect(classifyReply('returnCode=306')).toBe('auth');
    // 307(세션 정보 없음)도 같은 갈래다.
    expect(classifyReply('returnCode=307')).toBe('auth');
  });
});

describe('T-R7 그 밖의 코드는 오류다', () => {
  it('9999 처럼 전표에 없는 코드는 error — 성공으로 읽지 않는다(안전한 쪽)', () => {
    expect(classifyReply('returnCode=9999')).toBe('error');
    expect(classifyReply('returnCode=500')).toBe('error');
  });

  it('returnCode 가 정수가 아니면 error 다 — 숫자로 강제하지 않는다', () => {
    expect(classifyReply('returnCode=abc')).toBe('error');
    expect(returnCodeOf('returnCode=abc')).toBeNull();
    expect(returnCodeOf('returnCode=')).toBeNull();
  });
});

describe('T-R8 선행 공백·개행이 있는 본문', () => {
  it('앵커가 `/^\\s*returnCode\\s*=/` 라 공백·개행·CRLF 를 넘어 읽는다', () => {
    expect(classifyReply('\n  returnCode=0&absPan=100')).toBe('answer');
    expect(classifyReply('\r\nreturnCode=0')).toBe('answer');
    expect(classifyReply('   returnCode = 0')).toBe('answer');
    expect(parseQueryReply('\n  returnCode=0&absPan=100')).toEqual({ returnCode: '0', absPan: '100' });
  });
});

describe('T-R9 값은 URI 인코딩이다', () => {
  it('`presetName1=door%20A` → `door A` `[매뉴얼 §0:314]`', () => {
    expect(parseQueryReply('returnCode=0&presetName1=door%20A').presetName1).toBe('door A');
  });

  it('한글도 풀린다 — 풀지 않으면 화면에 %EC%9E%85 이 그대로 나간다', () => {
    const encoded = encodeURIComponent('입구 A');
    expect(parseQueryReply(`returnCode=0&presetName1=${encoded}`).presetName1).toBe('입구 A');
  });

  it('잘못된 이스케이프는 **원문을 지킨다** — 던져서 응답 전체를 버리지 않는다', () => {
    expect(parseQueryReply('returnCode=0&presetName1=%zz&presetName2=EL1')).toEqual({
      returnCode: '0', presetName1: '%zz', presetName2: 'EL1',
    });
  });

  it('`+` 는 공백으로 접지 않는다 — URI 인코딩이지 form 인코딩이 아니다 `[미확인 · 실기 확인 대상]`', () => {
    expect(parseQueryReply('returnCode=0&presetName1=A+B').presetName1).toBe('A+B');
  });

  it('`=` 가 값 안에 있어도 첫 `=` 에서만 나눈다', () => {
    expect(parseQueryReply('returnCode=0&note=a=b').note).toBe('a=b');
  });
});

describe('사람 문장 — describeReturnCode', () => {
  it('전표에 있는 코드는 사유가 붙고, 모르는 코드는 번호만 남는다', () => {
    expect(describeReturnCode(9000)).toContain('9000');
    expect(describeReturnCode(9000)).toMatch(/\(.+\)/);
    expect(describeReturnCode(424242)).toBe('returnCode=424242');
    expect(describeReturnCode(null)).toBe('returnCode 없음');
  });
});
