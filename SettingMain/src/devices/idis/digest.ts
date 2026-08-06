import { createHash, randomBytes } from 'node:crypto';

/**
 * RFC2617 Digest/Basic 인증 헤더 생성. 외부 I/O 없는 순수 계층.
 *
 * 매뉴얼이 `The API is based on the standard HTTP Authentication. (refer RFC2617)` 라고만
 * 적어 `[매뉴얼 §0]` Basic·Digest 중 무엇인지 말하지 않는다. 실측기는 **Digest 만 받고
 * Basic 에는 401** 이었다 `[실측 DC-S6261XT · realm="WEB SERVER", qop=auth, algorithm=MD5]`.
 * 그래서 방식을 우리가 고르지 않고 **챌린지를 읽어 고른다**(`idisTransport.ts`).
 *
 * **`cnonce`·`nc` 를 인자로 받는다.** 참조구현은 `randomBytes(8)` 을 함수 안에서 직접 불러
 * 헤더 생성을 결정적으로 검증할 수 없다. 기본값만 난수로 두면 테스트가 챌린지와 이 둘을
 * 고정해 RFC2617 식을 **독립적으로 다시 계산**해 대조할 수 있다.
 *
 * 지원 범위는 `algorithm=MD5` + `qop=auth`(또는 qop 없는 RFC2069)다. `MD5-sess`·`SHA-256`
 * 은 `[미확인]` 이라 **조용히 MD5 로 계산하지 않고 던진다** — 잘못된 response 를 보내면
 * 401 만 돌아와 원인이 인증 방식이라는 사실이 어디에도 드러나지 않는다.
 */

export interface DigestHeaderInput {
  /** 401 응답의 `WWW-Authenticate` 헤더 원문. */
  header: string;
  method: string;
  /** 요청의 path + query. **HA2 와 `uri=` 에 같은 값이 들어가야 한다**(다르면 기기가 403). */
  uri: string;
  username: string;
  password: string;
  nc?: string;
  cnonce?: string;
}

export interface BasicHeaderInput {
  username: string;
  password: string;
}

const md5 = (value: string): string => createHash('md5').update(value).digest('hex');

/**
 * 챌린지에서 값 하나를 읽는다. 따옴표 안에 콤마가 들어간 경우(`qop="auth,auth-int"`)와
 * 따옴표 없는 경우(`algorithm=MD5`)를 모두 다룬다. 앞을 `^|[\s,]` 로 묶어 `nonce` 를 찾다가
 * `cnonce` 를 잡는 일이 없게 한다.
 */
function readParam(header: string, key: string): string | undefined {
  const match = new RegExp(`(?:^|[\\s,])${key}\\s*=\\s*(?:"([^"]*)"|([^",\\s]+))`, 'i').exec(header);
  if (!match) return undefined;
  return match[1] ?? match[2];
}

function unsupported(what: string): never {
  throw new Error(`지원하지 않는 Digest 방식입니다: ${what} — digest.ts 를 넓히십시오`);
}

export function buildDigestHeader(input: DigestHeaderInput): string {
  const { header, method, uri, username, password, nc = '00000001' } = input;
  const cnonce = input.cnonce ?? randomBytes(8).toString('hex');

  const algorithm = readParam(header, 'algorithm');
  if (algorithm !== undefined && algorithm.toUpperCase() !== 'MD5') unsupported(`algorithm=${algorithm}`);

  const realm = readParam(header, 'realm') ?? '';
  const nonce = readParam(header, 'nonce') ?? '';
  const opaque = readParam(header, 'opaque');

  const offered = readParam(header, 'qop');
  const qop = offered === undefined
    ? undefined
    : offered.split(',').map((value) => value.trim()).includes('auth')
      ? 'auth'
      : unsupported(`qop=${offered}`);

  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (opaque) parts.push(`opaque="${opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

export function buildBasicHeader({ username, password }: BasicHeaderInput): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}
