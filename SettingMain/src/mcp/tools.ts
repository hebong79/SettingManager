import { matchCatalog, ROUTE_CATALOG } from './routeCatalog.js';

/**
 * MCP 도구의 **알맹이**. SDK 를 import 하지 않는다 —
 * 테스트가 MCP 내부 구조를 뒤지지 않고 이 함수들만 부르면 되도록 분리했다.
 * `server.ts` 는 이것을 MCP 도구로 등록하기만 한다.
 */

export interface McpToolDeps {
  /** SettingManager REST 기준 주소. */
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface CallArgs {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  confirm?: boolean;
}

export function catalogTool(deps: McpToolDeps): Record<string, unknown> {
  return { ok: true, baseUrl: deps.baseUrl, routes: ROUTE_CATALOG };
}

export async function callTool(args: CallArgs, deps: McpToolDeps): Promise<Record<string, unknown>> {
  const { method, path, body, confirm } = args;
  const pathname = path.split('?')[0] ?? path;
  const entry = matchCatalog(method, pathname);

  // 카탈로그 밖 경로는 대신 쏘지 않는다 — 도구가 임의 요청 통로가 되면 안 된다.
  if (!entry) {
    return { ok: false, error: `카탈로그에 없는 경로입니다: ${method} ${path}. settingmanager_catalog 로 확인하세요.` };
  }
  // 운영 카메라를 실수로 돌리는 것이 이 도구의 가장 큰 위험이다.
  if (entry.movesCamera && confirm !== true) {
    return {
      ok: false,
      movesCamera: true,
      error: `${entry.title} 은(는) 카메라를 실제로 움직입니다. confirm:true 를 함께 보내야 실행됩니다.`,
    };
  }
  if (!deps.baseUrl) return { ok: false, error: 'SettingManager 주소를 알 수 없습니다 (baseUrl 미설정).' };

  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${deps.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 60_000),
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      // 스냅샷·스트림은 바이너리다 — 대화에 싣지 않고 크기만 알린다.
      const bytes = (await response.arrayBuffer()).byteLength;
      return { ok: response.ok, status: response.status, contentType, bytes };
    }
    return { ok: response.ok, status: response.status, data: (await response.json()) as unknown };
  } catch (error) {
    return { ok: false, error: `SettingManager 호출 실패: ${error instanceof Error ? error.message : String(error)}` };
  }
}
