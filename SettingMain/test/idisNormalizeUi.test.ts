import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { normalizeCamera } from '../src/config/normalize.js';

/**
 * 계획 §7 `test/normalize.test.ts` · `optionsDbUi.test.ts` (추가분) — T-N1·T-N2·T-UI1·T-UI2.
 *
 * `web/optionsDb.js` 는 브라우저 모듈이라 통째로 import 할 수 없다. 저장소 선례
 * (`test/optionsPark3dUi.test.ts`)대로 소스를 읽어 **순수 함수 본문만 떼어 내 실제로 평가**한다 —
 * 문자열 존재 확인만으로는 조건이 뒤집혀 있어도 통과한다.
 */

const readWeb = (name: string): Promise<string> => readFile(new URL(`../web/${name}`, import.meta.url), 'utf8');

type PortPairWarning = (controlUrl: string, streamUrl: string, kind?: string, camId?: string | number) => string;

async function loadPortPairWarning(): Promise<PortPairWarning> {
  const js = await readWeb('optionsDb.js');
  const start = js.indexOf('function portPairWarning');
  expect(start).toBeGreaterThan(-1);
  const end = js.indexOf('\n}', start) + 2;
  return new Function(`${js.slice(start, end)}\nreturn portPairWarning;`)() as PortPairWarning;
}

const base = {
  id: 'idis-1', label: 'IDIS 1', controlUrl: 'http://192.168.0.30:80',
  username: 'admin', password: 'pw', streamUrl: 'rtsp://192.168.0.30:554/trackID=1', timeoutMs: 2000,
};

describe('T-N1 normalizeCamera 가 kind:`idis` 를 보존한다', () => {
  it('`idis` 가 그대로 남는다 — `CAMERA_KINDS` 에 없으면 조용히 hucoms 로 떨어진다', () => {
    expect(normalizeCamera({ ...base, kind: 'idis' })?.kind).toBe('idis');
  });

  it('나머지 필드도 함께 살아남는다', () => {
    const camera = normalizeCamera({ ...base, kind: 'idis' })!;
    expect(camera).toMatchObject({
      id: 'idis-1', label: 'IDIS 1', kind: 'idis',
      controlUrl: 'http://192.168.0.30:80', streamUrl: 'rtsp://192.168.0.30:554/trackID=1', timeoutMs: 2000,
    });
  });

  it('네 종류가 모두 보존된다 — 새 종류를 더하다 기존 것을 떨어뜨리지 않았다', () => {
    for (const kind of ['hucoms', 'backend-core', 'park3d-rpc', 'idis']) {
      expect(normalizeCamera({ ...base, kind })?.kind, kind).toBe(kind);
    }
  });
});

describe('T-N2 알 수 없는 kind 는 여전히 hucoms 로 폴백한다 (회귀 방지)', () => {
  it('모르는 값·빈 값·엉뚱한 타입 전부 hucoms 다', () => {
    for (const kind of ['flexwatch', '', 'IDIS', 'idis ', undefined, null, 7, {}]) {
      expect(normalizeCamera({ ...base, kind })?.kind, JSON.stringify(kind)).toBe('hucoms');
    }
  });

  it('대소문자를 관대하게 받지 않는다 — `IDIS` 를 통과시키면 DB CHECK 가 나중에 거절한다', () => {
    expect(normalizeCamera({ ...base, kind: 'IDIS' })?.kind).toBe('hucoms');
  });
});

describe('T-UI1 options.html 드롭다운', () => {
  it('`idis` 옵션이 **2곳 모두**(편집 폼 · 새 기기 추가)에 있다', async () => {
    const html = await readWeb('options.html');
    expect(html.match(/<option value="idis">/g) ?? []).toHaveLength(2);
  });

  it('기존 세 종류도 두 곳에 그대로 있다 — 추가하다 하나를 밀어내지 않았다', async () => {
    const html = await readWeb('options.html');
    for (const kind of ['hucoms', 'backend-core', 'park3d-rpc']) {
      expect(html.match(new RegExp(`<option value="${kind}">`, 'g')) ?? [], kind).toHaveLength(2);
    }
  });

  it('드롭다운 목록이 `CAMERA_KINDS` 와 같은 집합이다 — 화면에서 고를 수 없는 종류가 생기지 않는다', async () => {
    const html = await readWeb('options.html');
    const shown = new Set([...html.matchAll(/<option value="(hucoms|backend-core|park3d-rpc|idis)">/g)].map((m) => m[1]));
    expect([...shown].sort()).toEqual(['backend-core', 'hucoms', 'idis', 'park3d-rpc']);
  });
});

/**
 * ## T-UI2 판정 — **계획의 기대가 성립하지 않는다. 현재 동작을 고정하고 결함으로 올린다.**
 *
 * 계획 T-UI2 는 "IDIS 는 park3d 전용 포트 경고 대상이 아니다(빈 문자열)" 를 기대한다.
 * 앞쪽 절반(park3d 전용 분기에 걸리지 않는다)은 참이지만, **뒷쪽 절반은 거짓이다** —
 * `portPairWarning` 은 `kind === 'park3d-rpc'` 만 따로 다루고 나머지는 전부 "영상 = 제어 + 10"
 * 이라는 **UE 시뮬레이터 직결 규칙**으로 떨어진다. IDIS 에는 그런 규칙이 없다.
 *
 * 실제로 빈 문자열이 나오는 것은 **규칙 때문이 아니라 우연** 이다:
 *   - IDIS 제어는 보통 80/443 인데 `new URL().port` 가 기본 포트를 지워 `controlPort = 0` 이 되고,
 *     함수가 그 앞에서 빠져나간다.
 *   - IDIS 영상은 보통 `rtsp://` 라 첫 관문(`/^https?:\/\//`)에서 빠져나간다.
 * 둘 중 하나라도 어긋나면 — 비기본 포트로 연 IDIS + MJPEG 중계 — **근거 없는 경고**가 뜬다.
 *
 * 고치지 않는 이유: "IDIS 의 올바른 포트짝 규칙이 무엇인가" 는 설계 판단이고(실은 규칙이 없다),
 * UI 경고 규칙 변경은 계획 범위 밖이다. 대신 현재 동작을 **정확한 문자열로** 못박아 두어,
 * 누가 고치는 순간 이 시험이 알려 주게 한다(계획 T-S5 가 쓴 것과 같은 방식).
 */
describe('T-UI2 portPairWarning — 계획 미충족을 사실대로 고정한다', () => {
  it('참인 절반: IDIS 는 park3d **전용** 경고(13600+camId · 제어칸에 영상포트)의 대상이 아니다', async () => {
    const portPairWarning = await loadPortPairWarning();
    // park3d 라면 "13601 은 영상 포트입니다" 가 떴을 입력.
    expect(portPairWarning('http://h:13601', 'http://h:13601/stream', 'park3d-rpc', 1)).toMatch(/영상 포트입니다/);
    expect(portPairWarning('http://h:13601', 'http://h:13611/stream', 'idis', 1)).toBe('');
    // camId 에 맞는 영상 포트 규칙도 IDIS 에는 적용되지 않는다.
    expect(portPairWarning('http://h:13510', 'http://h:13605/stream', 'park3d-rpc', 2)).toMatch(/13602/);
  });

  it('우연히 빈 문자열이 나오는 경우 — IDIS 의 **보통 모습**에서는 경고가 안 뜬다', async () => {
    const portPairWarning = await loadPortPairWarning();
    // rtsp 영상 → 첫 관문에서 빠져나간다.
    expect(portPairWarning('http://192.168.0.30:80', 'rtsp://192.168.0.30:554/trackID=1', 'idis')).toBe('');
    // 제어가 기본 포트(80/443) → URL 이 포트를 지워 controlPort 가 0 이 된다.
    expect(portPairWarning('http://192.168.0.30:80', 'http://192.168.0.30:8080/stream', 'idis')).toBe('');
    expect(portPairWarning('https://192.168.0.30:443', 'http://192.168.0.30:8080/stream', 'idis')).toBe('');
  });

  it('**결함**: 비기본 제어 포트 + http 영상이면 근거 없는 "제어 + 10" 경고가 뜬다 (계획 T-UI2 미충족)', async () => {
    const portPairWarning = await loadPortPairWarning();
    // ⚠ 아래가 **바람직한 동작이 아니다.** 계획은 여기서도 '' 를 기대했다.
    //    고치면 이 단언이 깨지고, 그때가 이 결함이 해소된 시점이다.
    expect(portPairWarning('http://192.168.0.30:8000', 'http://192.168.0.30:8080/stream', 'idis'))
      .toBe(' ⚠ 제어 8000 의 영상 포트는 8010 입니다 — 지금 8080 는 다른 카메라를 볼 수 있습니다');
    expect(portPairWarning('https://192.168.0.30:8443', 'http://192.168.0.30:8080/stream', 'idis'))
      .toBe(' ⚠ 제어 8443 의 영상 포트는 8453 입니다 — 지금 8080 는 다른 카메라를 볼 수 있습니다');
  });

  it('그 경고가 IDIS 만의 문제가 아니다 — hucoms 와 **같은 갈래**에서 나온다(원인 위치를 고정한다)', async () => {
    const portPairWarning = await loadPortPairWarning();
    const idis = portPairWarning('http://h:8000', 'http://h:8080/stream', 'idis');
    const hucoms = portPairWarning('http://h:8000', 'http://h:8080/stream', 'hucoms');
    expect(idis).toBe(hucoms);   // 분기가 없다 = 폴백 한 갈래를 공유한다
  });

  it('기존 종류의 경고는 그대로다 — 회귀 방지', async () => {
    const portPairWarning = await loadPortPairWarning();
    expect(portPairWarning('http://h:8081', 'http://h:8091', 'hucoms')).toBe('');
    expect(portPairWarning('http://h:8081', 'http://h:8095', 'hucoms')).toMatch(/8091/);
    expect(portPairWarning('http://h:13510', 'http://h:13602/stream', 'park3d-rpc', 2)).toBe('');
  });
});

describe('영상 경로 안내 문구 — IDIS 는 park3d 전용 문구를 받지 않는다', () => {
  it('`streamHint` 의 park3d 분기는 kind 로만 갈린다', async () => {
    const js = await readWeb('optionsDb.js');
    expect(js).toContain("kind === 'park3d-rpc'");
    expect(js).toContain('Park3D 영상은 카메라별 포트 13600 + camId 입니다');
  });
});
