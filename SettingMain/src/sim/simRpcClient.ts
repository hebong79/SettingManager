import { findSimMethod } from './simCatalog.js';

/**
 * 언리얼 Park3D JSON-RPC 클라이언트 — **시뮬레이터 툴 전용.**
 *
 * ## `devices/park3d/park3dRpcClient.ts` 와 코드를 공유하지 않는다
 *
 * 그쪽은 **카메라 드라이버**다. 상위 계층(`PtzRaw`·`clampPtz`·화면)이 정수 raw 만 보도록
 * 도·배율을 ×100 해서 넘긴다. 이쪽은 그 계층을 지나지 않으므로 **서버가 준 도·배율을
 * 그대로 쓴다**(`pan 47.1` 은 47.1°, `zoom 2.4` 는 2.4배).
 *
 * 두 곳에서 변환하면 반드시 어긋난다 — 한쪽만 고치는 날이 오기 때문이다.
 * 그래서 규약(오류 봉투 우선 등)은 같지만 코드는 나눠 둔다. 이것이 "완전 독립"의 값이다.
 *
 * ## 지키는 것 셋 (셋 다 상류가 실제로 당했다)
 *
 * 1. **본문은 `text()` 로 한 번만 읽는다.** `json()` 은 스트림을 소비해, 실패했을 때
 *    원문을 다시 읽을 수 없다 — 그러면 오류 메시지에 서버가 실제로 돌려준 내용을 실을 수
 *    없어 오진(경로 오배선 등)이 반복된다.
 * 2. **JSON-RPC error 봉투가 상태코드보다 먼저다.** 이 서버는 오류도 HTTP 200 으로 보낸다
 *    (실측). 상태코드를 먼저 보면 `-32000 타겟점 미설정` 같은 사유가 통째로 사라진다.
 * 3. **봉투 없는 non-2xx 를 따로 잡는다.** 이 검사를 빼면 404 본문이 `result: undefined` 로
 *    조용히 통과해 먼 곳에서 TypeError 로 터진다.
 */

export interface SimRpcClientOptions {
  /** 예: `http://192.168.0.125:13510`. 비어 있으면 생성 자체가 거절된다. */
  rpcUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** 언리얼이 돌려준 오류. `code` 가 처방을 가른다 — §`statusFor`. */
export class SimRpcError extends Error {
  constructor(message: string, readonly statusCode: number, readonly rpcCode?: number) {
    super(message);
    this.name = 'SimRpcError';
  }
}

interface RpcEnvelope {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/**
 * RPC 오류 코드 → HTTP 상태.
 *
 * **`-32601`(미등록 method)은 501 이다.** 이 시뮬레이터가 아직 그 기능을 갖고 있지
 * 않다는 확정 답이고, 일시 장애(502)와 구분돼야 호출자가 재시도 여부를 판단할 수 있다.
 * **`-32000`(도메인 위반)은 409** — 순서를 지키면 되는 것이라 재시도가 의미 있다.
 */
function statusFor(rpcCode: number | undefined): number {
  if (rpcCode === -32601) return 501;
  if (rpcCode === -32602 || rpcCode === -32700) return 400;
  return 409;
}

export class SimRpcClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SimRpcClientOptions) {
    if (!options.rpcUrl) {
      throw new SimRpcError('시뮬레이터 RPC 주소가 설정되지 않았습니다 — config.json 의 simTool.rpcUrl 을 채우세요', 501);
    }
    // `/rpc` 는 루트 서비스다. 주소에 경로 접미사가 붙어 있으면 `/stream/rpc` 같은 주소로
    // 조립돼 404 가 난다(형제 프로젝트에서 실제로 겪은 사고).
    this.url = `${options.rpcUrl.replace(/\/+$/, '')}/rpc`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * 카탈로그에 있고 **실제로 동작하는** 메서드만 나간다.
   *
   * 등록만 되고 호출하면 실패하는 것이 10개 있는데(`system.catalog` 로는 구분되지 않는다),
   * 그것들은 서버를 두드리기 전에 **501 + 사유**로 거절한다. 눌러 보고 나서
   * `-32000 미구현` 을 읽는 것보다 무엇을 대신 써야 하는지까지 알 수 있다.
   */
  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const entry = findSimMethod(method);
    if (!entry) {
      throw new SimRpcError(`허용되지 않은 시뮬레이터 메서드입니다: ${method}`, 400);
    }
    if (entry.unimplemented) {
      throw new SimRpcError(`${method} 은(는) 시뮬레이터에 등록만 돼 있고 동작하지 않습니다 — ${entry.unimplemented}`, 501);
    }
    return this.send(method, params);
  }

  private async send(method: string, params: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        // 인증 헤더를 싣지 않는다 — 이 서버는 무인증이다(실측).
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new SimRpcError(`시뮬레이터에 연결하지 못했습니다 (${this.url} ${method}): ${reason}`, 502);
    }

    const raw = await response.text();
    let body: RpcEnvelope;
    try {
      body = JSON.parse(raw) as RpcEnvelope;
    } catch {
      throw new SimRpcError(
        `시뮬레이터 응답을 해석할 수 없습니다: HTTP ${response.status} ${this.url} ${method} — ${raw.slice(0, 200)}`,
        502,
      );
    }

    if (body.error) {
      const code = body.error.code;
      // 서버가 한글 사유를 준다(실측: "타겟점 미설정 — measure.setTargetPoint 를 먼저
      // 호출하세요."). **다시 쓰지 않고 그대로 싣는다** — 우리가 지어낸 문장보다 정확하다.
      throw new SimRpcError(body.error.message ?? `시뮬레이터 오류 [${code}]`, statusFor(code), code);
    }
    if (!response.ok) {
      throw new SimRpcError(`시뮬레이터 HTTP ${response.status} (${this.url} ${method}) — ${raw.slice(0, 200)}`, 502);
    }
    return body.result;
  }
}
