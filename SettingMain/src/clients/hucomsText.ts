/**
 * Hucoms CGI 는 `key = value` 줄들의 text/plain 을 돌려준다.
 * 오류는 HTTP 상태가 아니라 본문 `Error: ...` 로 온다 — 200 을 성공으로 읽으면 조용히 틀린다.
 * 근거: AgentVLA/ParkAgent/SettingAgent/src/clients/hucoms/parser.ts
 */

const ERROR_RE = /^\s*error\s*:\s*(.*)$/i;

export interface HucomsResponse {
  values: Record<string, string>;
  rawText: string;
  /** 본문이 오류를 선언했을 때만 채워진다. */
  errorMessage?: string;
}

export function parseHucomsText(rawText: string): HucomsResponse {
  const values: Record<string, string> = {};
  let errorMessage: string | undefined;

  for (const original of rawText.replace(/\r\n?/g, '\n').split('\n')) {
    const line = original.trim();
    if (!line) continue;
    const error = ERROR_RE.exec(line);
    if (error) {
      errorMessage = error[1]?.trim() ?? '';
      continue;
    }
    if (line.startsWith('[') && line.endsWith(']')) continue;
    const equal = original.indexOf('=');
    if (equal < 1) continue;
    const key = original.slice(0, equal).trim();
    // 값 뒤의 ` * 주석`을 잘라낸다(장비가 범위 안내를 덧붙이는 경우가 있다).
    const value = original.slice(equal + 1).trim().replace(/\s+\*\s+.*$/, '').trim();
    values[key] = value;
  }
  return { values, rawText, errorMessage };
}

/** 응답에서 정수 필드를 꺼낸다. 없거나 숫자가 아니면 던진다 — 0 으로 대체하면 카메라가 원점으로 간다. */
export function requireInt(response: HucomsResponse, key: string): number {
  const raw = response.values[key];
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value)) {
    throw new Error(`Hucoms 응답에 ${key} 가 없습니다`);
  }
  return Math.round(value);
}
