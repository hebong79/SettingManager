import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * 옵션 화면의 park3d-rpc 대응.
 *
 * `web/optionsDb.js` 는 브라우저 모듈이라(최상단에서 `./api.js` 를 import 하고 document 를 만진다)
 * 테스트가 통째로 import 할 수 없다. 그래서 소스를 읽어 검사하고,
 * 순수 함수인 `portPairWarning` 만 본문을 떼어 내 **실제로 평가**한다 — 문자열 존재 확인만으로는
 * 조건이 뒤집혀 있어도 통과하기 때문이다.
 */

async function optionsSource(): Promise<string> {
  return readFile(new URL('../web/optionsDb.js', import.meta.url), 'utf8');
}

/** `function portPairWarning(...) { ... }` 블록만 떼어 낸다(최상위 함수라 닫는 중괄호가 열 0에 있다). */
async function loadPortPairWarning(): Promise<(controlUrl: string, streamUrl: string, kind?: string) => string> {
  const js = await optionsSource();
  const start = js.indexOf('function portPairWarning');
  expect(start).toBeGreaterThan(-1);
  const end = js.indexOf('\n}', start) + 2;
  const body = js.slice(start, end);
  return new Function(`${body}\nreturn portPairWarning;`)() as (controlUrl: string, streamUrl: string, kind?: string) => string;
}

describe('옵션 화면 — Park3D 포트짝 경고 오탐', () => {
  it('kind 를 넘겨받아 park3d-rpc 는 경고 대상에서 뺀다', async () => {
    const js = await optionsSource();
    expect(js).toContain("if (kind === 'park3d-rpc') return '';");
    // 기기 편집이 카메라 탭으로 옮겨지면서 입력칸 id 가 fieldControlUrl → camUrl 이 됐다.
    expect(js).toContain("portPairWarning($('camUrl').value.trim(), raw, kind)");
    expect(js).toContain("const kind = selected()?.kind;");
  });

  it('제어와 영상이 같은 포트여도 경고하지 않는다 — Park3D 는 /stream 이 같은 포트다', async () => {
    const portPairWarning = await loadPortPairWarning();
    expect(portPairWarning('http://h:13510', 'http://h:13510/stream', 'park3d-rpc')).toBe('');
  });

  it('다른 종류의 기존 경고 로직은 그대로다', async () => {
    const portPairWarning = await loadPortPairWarning();
    expect(portPairWarning('http://h:8081', 'http://h:8091', 'hucoms')).toBe('');
    expect(portPairWarning('http://h:8081', 'http://h:8095', 'hucoms')).toMatch(/8091/);
    // kind 를 모르는 옛 호출부가 남아 있어도 종전 동작이다.
    expect(portPairWarning('http://h:8081', 'http://h:8095')).toMatch(/8091/);
  });

  it('영상 안내 문구도 park3d-rpc 에서는 포트 +10 규칙을 말하지 않는다', async () => {
    const js = await optionsSource();
    expect(js).toContain('Park3D 는 같은 포트의 /stream 을 중계합니다');
  });

  it('kind 편집 입력칸은 여전히 없다 — kind 는 config.json 직접 편집으로만 바꾼다', async () => {
    const js = await optionsSource();
    const html = await readFile(new URL('../web/options.html', import.meta.url), 'utf8');
    expect(html).not.toContain('id="fieldKind"');
    expect(js).not.toContain("$('fieldKind')");
  });
});
