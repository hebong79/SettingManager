import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildBasicHeader, buildDigestHeader } from '../src/devices/idis/digest.js';

/**
 * 계획 §7 `test/idisDigest.test.ts` — T-D1~T-D5.
 *
 * **RFC2617 식을 테스트 안에 따로 적는다.** 구현 함수를 다시 불러 대조하면 식이 통째로 틀려도
 * 통과한다 — 그러면 기기가 401 만 돌려주고, 원인이 인증 계산이라는 사실이 어디에도 안 드러난다.
 *
 * 챌린지 원문의 realm 은 `[실측 DC-S6261XT — realm="WEB SERVER", qop=auth, algorithm=MD5]` 다.
 */

const md5 = (value: string): string => createHash('md5').update(value).digest('hex');

const CHALLENGE = 'Digest realm="WEB SERVER",qop="auth",algorithm=MD5,nonce="deadbeef"';
const URI = '/cgi-bin/webSetup.cgi?action=ptzAbsolute&mode=1';
const USER = 'admin';
const PASS = 'secret-not-real';

/** 헤더의 `key=value` 를 읽어 낸다(따옴표는 벗긴다). 구현의 파서를 쓰지 않는다 — 독립 검증이 목적이다. */
function field(header: string, key: string): string | undefined {
  const match = new RegExp(`(?:^|[\\s,])${key}=("([^"]*)"|[^",\\s]+)`).exec(header);
  return match ? (match[2] ?? match[1]) : undefined;
}

describe('T-D1 고정 nonce/cnonce 결정적 검증', () => {
  it('response= 가 테스트가 **독립적으로** 계산한 RFC2617 값과 바이트까지 같다', () => {
    const header = buildDigestHeader({
      header: CHALLENGE, method: 'GET', uri: URI,
      username: USER, password: PASS,
      nc: '00000001', cnonce: '0123456789abcdef',
    });

    // RFC2617 §3.2.2.1 — qop=auth 일 때의 식을 여기 따로 적는다.
    const ha1 = md5(`${USER}:WEB SERVER:${PASS}`);
    const ha2 = md5(`GET:${URI}`);
    const expected = md5(`${ha1}:deadbeef:00000001:0123456789abcdef:auth:${ha2}`);

    expect(field(header, 'response')).toBe(expected);
  });

  it('method 가 바뀌면 response 도 바뀐다 — HA2 에 method 가 들어간다는 증거', () => {
    const common = { header: CHALLENGE, uri: URI, username: USER, password: PASS, nc: '00000001', cnonce: '0123456789abcdef' };
    const get = buildDigestHeader({ ...common, method: 'GET' });
    const post = buildDigestHeader({ ...common, method: 'POST' });
    expect(field(get, 'response')).not.toBe(field(post, 'response'));
    expect(field(post, 'response')).toBe(
      md5(`${md5(`${USER}:WEB SERVER:${PASS}`)}:deadbeef:00000001:0123456789abcdef:auth:${md5(`POST:${URI}`)}`),
    );
  });

  it('nonce 가 바뀌면 response 도 바뀐다 — 재생 공격 방지의 근거가 실제로 살아 있다', () => {
    const common = { method: 'GET', uri: URI, username: USER, password: PASS, nc: '00000001', cnonce: '0123456789abcdef' };
    const first = buildDigestHeader({ ...common, header: CHALLENGE });
    const second = buildDigestHeader({ ...common, header: CHALLENGE.replace('deadbeef', 'cafebabe') });
    expect(field(first, 'response')).not.toBe(field(second, 'response'));
  });
});

describe('T-D2 헤더 필드 집합', () => {
  it('Digest 로 시작하고 여덟 필드가 모두 있다', () => {
    const header = buildDigestHeader({
      header: CHALLENGE, method: 'GET', uri: URI, username: USER, password: PASS,
      nc: '00000001', cnonce: '0123456789abcdef',
    });
    expect(header.startsWith('Digest ')).toBe(true);
    for (const key of ['username', 'realm', 'nonce', 'uri', 'response', 'qop', 'nc', 'cnonce']) {
      expect(field(header, key), `${key} 가 없습니다`).toBeDefined();
    }
    expect(field(header, 'username')).toBe(USER);
    expect(field(header, 'realm')).toBe('WEB SERVER');
    expect(field(header, 'nonce')).toBe('deadbeef');
    expect(field(header, 'qop')).toBe('auth');
    expect(field(header, 'nc')).toBe('00000001');
    expect(field(header, 'cnonce')).toBe('0123456789abcdef');
  });

  it('**비밀번호가 헤더에 평문으로 실리지 않는다**', () => {
    const header = buildDigestHeader({ header: CHALLENGE, method: 'GET', uri: URI, username: USER, password: PASS });
    expect(header).not.toContain(PASS);
  });

  it('cnonce 를 주지 않으면 난수가 붙고, 두 번 부르면 서로 다르다', () => {
    const make = (): string => buildDigestHeader({ header: CHALLENGE, method: 'GET', uri: URI, username: USER, password: PASS });
    expect(field(make(), 'cnonce')).not.toBe(field(make(), 'cnonce'));
  });
});

describe('T-D3 opaque 통과', () => {
  it('챌린지에 있으면 헤더에 그대로 실린다', () => {
    const header = buildDigestHeader({
      header: `${CHALLENGE},opaque="5ccc069c403ebaf9f0171e9517f40e41"`,
      method: 'GET', uri: URI, username: USER, password: PASS,
    });
    expect(field(header, 'opaque')).toBe('5ccc069c403ebaf9f0171e9517f40e41');
  });

  it('챌린지에 없으면 헤더에도 없다 — 빈 opaque 를 지어내지 않는다', () => {
    const header = buildDigestHeader({ header: CHALLENGE, method: 'GET', uri: URI, username: USER, password: PASS });
    expect(header).not.toContain('opaque');
  });
});

describe('T-D4 qop 없는 챌린지 (RFC2069)', () => {
  const legacy = 'Digest realm="WEB SERVER",nonce="deadbeef"';

  it('response 는 MD5(HA1:nonce:HA2) 다 — nc·cnonce 가 식에 끼지 않는다', () => {
    const header = buildDigestHeader({ header: legacy, method: 'GET', uri: URI, username: USER, password: PASS });
    const expected = md5(`${md5(`${USER}:WEB SERVER:${PASS}`)}:deadbeef:${md5(`GET:${URI}`)}`);
    expect(field(header, 'response')).toBe(expected);
  });

  it('qop·nc·cnonce 필드 자체가 없다 — 있으면 기기가 계산을 달리해 403 이 난다', () => {
    const header = buildDigestHeader({ header: legacy, method: 'GET', uri: URI, username: USER, password: PASS });
    expect(field(header, 'qop')).toBeUndefined();
    expect(field(header, 'nc')).toBeUndefined();
    expect(field(header, 'cnonce')).toBeUndefined();
  });
});

describe('T-D5 uri 는 path+query 를 그대로 쓴다', () => {
  it('`uri=` 와 HA2 양쪽에 **같은 값**이 들어간다 — 불일치하면 기기가 403 이다', () => {
    const header = buildDigestHeader({
      header: CHALLENGE, method: 'GET', uri: URI, username: USER, password: PASS,
      nc: '00000001', cnonce: '0123456789abcdef',
    });
    expect(field(header, 'uri')).toBe(URI);
    // HA2 를 이 uri 로 계산한 값과 response 가 맞는지 — query 를 떼고 계산했다면 여기서 갈린다.
    const ha1 = md5(`${USER}:WEB SERVER:${PASS}`);
    expect(field(header, 'response'))
      .toBe(md5(`${ha1}:deadbeef:00000001:0123456789abcdef:auth:${md5(`GET:${URI}`)}`));
    // query 를 뗀 계산과는 **달라야** 한다(양쪽이 같으면 위 단언이 아무것도 증명하지 않는다).
    expect(field(header, 'response'))
      .not.toBe(md5(`${ha1}:deadbeef:00000001:0123456789abcdef:auth:${md5('GET:/cgi-bin/webSetup.cgi')}`));
  });
});

describe('지원 범위 밖 챌린지는 **조용히 MD5 로 계산하지 않고 던진다** (구현 추가분)', () => {
  it('algorithm=SHA-256 은 던진다 — 잘못된 response 를 보내면 401 만 돌아와 원인이 안 드러난다', () => {
    expect(() => buildDigestHeader({
      header: 'Digest realm="WEB SERVER",qop="auth",algorithm=SHA-256,nonce="deadbeef"',
      method: 'GET', uri: URI, username: USER, password: PASS,
    })).toThrow(/SHA-256/);
  });

  it('MD5-sess 도 던진다', () => {
    expect(() => buildDigestHeader({
      header: 'Digest realm="WEB SERVER",qop="auth",algorithm=MD5-sess,nonce="deadbeef"',
      method: 'GET', uri: URI, username: USER, password: PASS,
    })).toThrow(/MD5-sess/);
  });

  it('qop 에 auth 가 없으면 던진다', () => {
    expect(() => buildDigestHeader({
      header: 'Digest realm="WEB SERVER",qop="auth-int",algorithm=MD5,nonce="deadbeef"',
      method: 'GET', uri: URI, username: USER, password: PASS,
    })).toThrow(/auth-int/);
  });

  it('`qop="auth,auth-int"` 는 auth 를 골라 통과한다 — 따옴표 안 콤마에서 잘리지 않는다', () => {
    const header = buildDigestHeader({
      header: 'Digest realm="WEB SERVER",qop="auth,auth-int",algorithm=MD5,nonce="deadbeef"',
      method: 'GET', uri: URI, username: USER, password: PASS,
    });
    expect(field(header, 'qop')).toBe('auth');
  });

  it('챌린지에 cnonce 가 섞여 있어도 nonce 를 그것으로 착각하지 않는다', () => {
    const header = buildDigestHeader({
      header: 'Digest realm="WEB SERVER",cnonce="WRONG",nonce="deadbeef",qop="auth",algorithm=MD5',
      method: 'GET', uri: URI, username: USER, password: PASS, nc: '00000001', cnonce: '0123456789abcdef',
    });
    expect(field(header, 'nonce')).toBe('deadbeef');
  });
});

describe('Basic 헤더', () => {
  it('base64(user:pass) 를 테스트가 따로 계산한 값과 대조한다', () => {
    expect(buildBasicHeader({ username: USER, password: PASS }))
      .toBe(`Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`);
  });

  it('비밀번호가 평문으로 보이지 않는다(base64 라도 원문 문자열은 아니다)', () => {
    expect(buildBasicHeader({ username: USER, password: PASS })).not.toContain(PASS);
  });
});
