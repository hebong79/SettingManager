import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ConfigStore } from '../config/configStore.js';
import { callTool, catalogTool, type McpToolDeps } from './tools.js';

/**
 * SettingManager 를 **MCP 도구로 노출**한다 — 다른 에이전트가 카메라를 다루는 입구다.
 *
 * ## 왜 HTTP 를 다시 부르는가
 *
 * 도구는 SettingManager 자신의 REST API 를 호출한다. 인프로세스 서비스를 직접 부르지 않는 이유는
 * 하나다 — **규칙을 두 벌로 만들지 않기 위해서**다. 본문 검증·능력 게이트·오류 매핑은 이미
 * 라우트가 소유하고 있고, MCP 가 그것을 우회하면 같은 규칙이 두 곳에 생겨 반드시 갈라진다.
 * (이 저장소가 방금 센터링 3중 경로로 겪은 실패가 정확히 그것이다.)
 *
 * ## 도구가 둘뿐인 이유
 *
 * 라우트마다 도구를 등록하면 라우트가 늘 때마다 이 파일을 고쳐야 한다. 대신 자기 설명적
 * 카탈로그 + 범용 호출 둘로 노출한다(형제 프로젝트 `SettingAgent/src/mcp/server.ts` 와 같은 설계).
 *
 * ## 안전
 *
 * **카메라를 물리적으로 움직이는 호출은 `confirm: true` 없이는 거절한다.** 두뇌가 실수로
 * 운영 카메라를 돌리는 것이 이 도구의 가장 큰 위험이라, 카탈로그의 `movesCamera` 를 게이트로 쓴다.
 */

export interface McpServerOptions {
  /** SettingManager REST 기준 주소. 없으면 config.json 의 server 설정에서 만든다. */
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

const text = (payload: unknown): ToolResult => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });

export function buildMcpServer(options: McpServerOptions = {}): McpServer {
  const deps: McpToolDeps = {
    baseUrl: (options.baseUrl ?? '').replace(/\/+$/, ''),
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  };

  const server = new McpServer({ name: 'settingmanager-tools', version: '0.1.0' });

  server.registerTool(
    'settingmanager_catalog',
    {
      title: 'SettingManager API 카탈로그',
      description:
        'SettingManager 가 제공하는 REST 경로 목록을 돌려준다. ' +
        '★ settingmanager_call 을 쓰기 전에 반드시 이 도구로 경로와 플래그를 확인하라. ' +
        'mutating:true 는 설정·저장소를 바꾸고, movesCamera:true 는 **실제 카메라를 움직인다**.',
      inputSchema: {},
    },
    async () => text(catalogTool(deps)),
  );

  server.registerTool(
    'settingmanager_call',
    {
      title: 'SettingManager API 호출',
      description:
        'SettingManager REST API 를 호출한다. 경로는 카탈로그에 있는 것만 허용된다. ' +
        '★ movesCamera:true 인 경로는 confirm:true 를 함께 보내야 실행된다 — 운영 카메라가 실제로 움직인다. ' +
        '★ 코어 작업(센터링·탐색·캘리브레이션·호밍)은 먼저 GET /api/core/capabilities 로 지원 여부를 확인하라. ' +
        '오류는 status 로 구분된다: 501(이 구현이 하지 않음 — 재시도 무의미, 옵션에서 코어 구현을 바꿔야 한다) / ' +
        '409(점유·충돌 — 잠시 후 재시도 가능) / 422(기기가 못 함) / 400(요청 오류) / 404(없음) / 502(통신 실패).',
      inputSchema: {
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).describe('HTTP 메서드'),
        path: z.string().min(1).describe('카탈로그의 경로. 예: /api/core/capabilities, /api/cameras/cam-a/test'),
        body: z.record(z.unknown()).optional().describe('POST·PUT 본문(선택)'),
        confirm: z.boolean().optional().describe('movesCamera:true 경로에 필수. 카메라를 실제로 움직인다는 확인.'),
      },
    },
    async ({ method, path, body, confirm }) => text(await callTool({ method, path, body, confirm }, deps)),
  );

  return server;
}

/** config.json 의 server 설정에서 자기 자신의 주소를 만든다. */
export async function resolveBaseUrl(): Promise<string> {
  const config = await new ConfigStore().load();
  const host = config.server.host === '0.0.0.0' || config.server.host === '::' ? '127.0.0.1' : config.server.host;
  return `http://${host}:${config.server.port}`;
}

/** stdio MCP 서버로 기동(호출하는 에이전트가 자식 프로세스로 연결한다). */
async function main(): Promise<void> {
  const server = buildMcpServer({ baseUrl: process.env.SETTINGMANAGER_URL || (await resolveBaseUrl()) });
  await server.connect(new StdioServerTransport());
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('server.ts') || entry.endsWith('server.js')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
