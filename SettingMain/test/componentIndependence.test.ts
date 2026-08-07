import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * **"각각 독립적으로 제작"을 검사 가능한 규칙으로 못 박는다.**
 *
 * 규칙이 문장으로만 있으면 다음 사람이 "잠깐만 빌려 쓰지" 하고 한 줄 import 를 넣고,
 * 그 순간 독립은 끝난다. 그런 종류의 침식은 리뷰에서 잘 안 보인다 — 한 줄이고, 동작하고,
 * 그 자리에서는 합리적이기 때문이다.
 *
 * 셋이 만나는 자리는 **둘뿐이고 둘 다 코드가 아니다**:
 *   ① `vendor/baro-profile` — 벤더링된 순수 계산을 **각자** 부른다
 *   ② `profiles/` — 캘리브레이션이 발행하고 센터라이징이 읽는 **데이터**
 */

const COMPONENTS = ['calibration', 'centering', 'vehiclebox'] as const;

/** 컴포넌트가 의존해도 되는 아래 층. 여기 없는 것을 새로 부르면 이 목록부터 고쳐야 한다. */
const ALLOWED_PREFIXES = [
  'vendor/baro-profile',
  'devices/',
  'domain/',
  'config/',
  'profiles/',
  'db/',
  'detectors/detectorTypes',
  'paths',
];

async function sourcesOf(component: string): Promise<Array<{ file: string; text: string }>> {
  const dir = new URL(`../src/${component}/`, import.meta.url);
  const names = (await readdir(dir)).filter((name) => name.endsWith('.ts'));
  return Promise.all(names.map(async (file) => ({ file: `${component}/${file}`, text: await readFile(new URL(file, dir), 'utf8') })));
}

/** `import ... from '<여기>'` 의 경로만 뽑는다(타입 전용 import 도 포함 — 그것도 결합이다). */
function importsOf(text: string): string[] {
  return [...text.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]!);
}

describe('세 컴포넌트는 서로를 모른다', () => {
  it('calibration · centering · vehiclebox 사이에 import 가 하나도 없다', async () => {
    const violations: string[] = [];
    for (const component of COMPONENTS) {
      for (const { file, text } of await sourcesOf(component)) {
        for (const specifier of importsOf(text)) {
          const other = COMPONENTS.find((name) => name !== component && specifier.includes(`/${name}/`));
          if (other) violations.push(`${file} 이(가) ${other} 를 import 합니다: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('컴포넌트는 허용된 아래 층만 본다 — 옆이나 위를 보지 않는다', async () => {
    const violations: string[] = [];
    for (const component of COMPONENTS) {
      for (const { file, text } of await sourcesOf(component)) {
        for (const specifier of importsOf(text)) {
          // 상대 경로가 아니면 Node 내장 모듈이다(`node:*`). 런타임 의존성은 0 을 유지하므로
          // 여기 npm 패키지 이름이 나타나면 그 자체가 신호다.
          if (!specifier.startsWith('.')) {
            if (!specifier.startsWith('node:')) violations.push(`${file} 이(가) 외부 패키지를 import 합니다: ${specifier}`);
            continue;
          }
          if (specifier.startsWith('./')) continue; // 자기 컴포넌트 안
          const outside = specifier.replace(/^(\.\.\/)+/, '');
          if (!ALLOWED_PREFIXES.some((prefix) => outside.startsWith(prefix))) {
            violations.push(`${file} 이(가) 허용되지 않은 곳을 import 합니다: ${specifier}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('셋 다 벤더링한 순수 계산을 각자 부른다 — 한 컴포넌트가 대신 불러 주지 않는다', async () => {
    // 이것이 ①번 만남이 코드 결합이 아니라는 증거다. 게인 함수를 센터라이징이 소유하고
    // 캘리브레이션이 그것을 빌리면, verify 패스가 센터라이징의 버전 변경에 끌려다닌다.
    const users = new Set<string>();
    for (const component of COMPONENTS) {
      for (const { text } of await sourcesOf(component)) {
        if (text.includes("vendor/baro-profile")) users.add(component);
      }
    }
    expect([...users].sort()).toEqual(['calibration', 'centering']);
  });

  it('브리지 코어는 세 컴포넌트를 조립만 한다 — 기하도 이미지 처리도 갖지 않는다', async () => {
    const text = await readFile(new URL('../src/core/bridge/bridgeCoreProvider.ts', import.meta.url), 'utf8');
    // 이런 것이 다시 여기 들어오면 컴포넌트 경계가 무너진 것이다.
    expect(text).not.toContain('pixelToPtzDelta');
    expect(text).not.toContain('applyCenteringGain');
    expect(text).not.toContain('hfovFromZoomPos');
    expect(text).not.toContain('buildCalibration');
  });
});
