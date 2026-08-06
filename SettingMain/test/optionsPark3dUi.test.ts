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

type PortPairWarning = (controlUrl: string, streamUrl: string, kind?: string, camId?: string | number) => string;

/** `function portPairWarning(...) { ... }` 블록만 떼어 낸다(최상위 함수라 닫는 중괄호가 열 0에 있다). */
async function loadPortPairWarning(): Promise<PortPairWarning> {
  const js = await optionsSource();
  const start = js.indexOf('function portPairWarning');
  expect(start).toBeGreaterThan(-1);
  const end = js.indexOf('\n}', start) + 2;
  const body = js.slice(start, end);
  return new Function(`${body}\nreturn portPairWarning;`)() as PortPairWarning;
}

describe('옵션 화면 — Park3D 포트 경고', () => {
  it('힌트가 화면의 지금 값(종류·camId)을 넘긴다 — 저장된 행을 보면 바꾸는 즉시 거짓말이 된다', async () => {
    const js = await optionsSource();
    // 기기 편집이 카메라 탭으로 옮겨지면서 입력칸 id 가 fieldControlUrl → camUrl 이 됐다.
    expect(js).toContain("portPairWarning($('camUrl').value.trim(), raw, kind, $('camPark3d').value.trim())");
    expect(js).toContain("const kind = $('camKind').value;");
    expect(js).toContain("$('camPark3d').addEventListener('input', streamHint);");
  });

  it('camId 에 맞는 영상 포트(13600 + camId)면 경고하지 않는다', async () => {
    const portPairWarning = await loadPortPairWarning();
    expect(portPairWarning('http://h:13510', 'http://h:13602/stream', 'park3d-rpc', 2)).toBe('');
    expect(portPairWarning('http://h:13510', 'http://h:13601/stream', 'park3d-rpc', '1')).toBe('');
    expect(portPairWarning('http://h:13510', 'http://h:13650/stream', 'park3d-rpc', 50)).toBe('');
  });

  it('영상 포트가 camId 와 어긋나면 올바른 포트를 알려 준다 — 다른 카메라를 보게 된다', async () => {
    const portPairWarning = await loadPortPairWarning();
    const warning = portPairWarning('http://h:13510', 'http://h:13605/stream', 'park3d-rpc', 2);
    expect(warning).toMatch(/13602/);
    expect(warning).toMatch(/13605/);
  });

  it('제어 URL 에 영상 포트를 적으면 경고한다 — 404 가 아니라 영상이 와서 조용히 실패하는 자리다', async () => {
    const portPairWarning = await loadPortPairWarning();
    expect(portPairWarning('http://h:13601', 'http://h:13601/stream', 'park3d-rpc', 1)).toMatch(/영상 포트/);
    expect(portPairWarning('http://h:13650', 'http://h:13650/stream', 'park3d-rpc', 50)).toMatch(/영상 포트/);
    // 경계 밖 — RPC 서버 포트는 경고 대상이 아니다.
    expect(portPairWarning('http://h:13600', 'http://h:13601/stream', 'park3d-rpc', 1)).toBe('');
  });

  it('camId 를 아직 안 적었으면 경고하지 않는다 — 포트를 계산할 근거가 없다', async () => {
    const portPairWarning = await loadPortPairWarning();
    expect(portPairWarning('http://h:13510', 'http://h:13602/stream', 'park3d-rpc', '')).toBe('');
    expect(portPairWarning('http://h:13510', 'http://h:13602/stream', 'park3d-rpc')).toBe('');
  });

  it('다른 종류의 기존 경고 로직은 그대로다', async () => {
    const portPairWarning = await loadPortPairWarning();
    expect(portPairWarning('http://h:8081', 'http://h:8091', 'hucoms')).toBe('');
    expect(portPairWarning('http://h:8081', 'http://h:8095', 'hucoms')).toMatch(/8091/);
    // kind 를 모르는 옛 호출부가 남아 있어도 종전 동작이다.
    expect(portPairWarning('http://h:8081', 'http://h:8095')).toMatch(/8091/);
  });

  it('영상 안내 문구가 카메라별 포트 규칙을 말한다 — "같은 포트" 전제는 사라졌다', async () => {
    const js = await optionsSource();
    expect(js).toContain('Park3D 영상은 카메라별 포트 13600 + camId 입니다');
    expect(js).not.toContain('같은 포트');
  });

  it('kind 편집 입력칸은 여전히 없다 — kind 는 config.json 직접 편집으로만 바꾼다', async () => {
    const js = await optionsSource();
    const html = await readFile(new URL('../web/options.html', import.meta.url), 'utf8');
    expect(html).not.toContain('id="fieldKind"');
    expect(js).not.toContain("$('fieldKind')");
  });
});
