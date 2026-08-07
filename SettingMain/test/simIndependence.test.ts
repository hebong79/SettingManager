import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * 지시 7 — **"시뮬레이터 툴은 완전 독립적으로 사용한다"** 를 검사 가능한 것으로 바꾼다.
 *
 * 말로만 두면 다음 사람이 "카메라 목록이 필요하네" 하며 `devices/` 를 하나 import 하고,
 * 그 순간 시뮬레이터 툴은 카메라 설정이 깨지면 같이 죽는 화면이 된다. 여기서 막는다.
 *
 * 독립의 실질적 이득도 함께 지킨다: 드라이버 계층은 PTZ 를 정수 raw(×100)로 다루고
 * 시뮬툴은 서버가 준 **도·배율 실수**를 그대로 쓴다. 두 곳에서 변환하면 반드시 어긋난다 —
 * `devices/` 를 안 보는 것이 그 어긋남을 원천에서 없앤다.
 */

const SIM_DIR = new URL('../src/sim/', import.meta.url);

/** 시뮬레이터 툴이 **절대 보면 안 되는** 것들. */
const FORBIDDEN = ['devices/', 'core/', 'db/', 'calibration/', 'centering/', 'detectors/', 'homing/', 'vehiclebox/', 'store/', 'profiles/', 'media/'];

async function simSources(): Promise<Array<{ name: string; source: string }>> {
  const names = (await readdir(SIM_DIR)).filter((n) => n.endsWith('.ts'));
  return Promise.all(names.map(async (name) => ({ name, source: await readFile(new URL(name, SIM_DIR), 'utf8') })));
}

function importedPaths(source: string): string[] {
  return [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
}

describe('시뮬레이터 툴 독립 경계', () => {
  it('스캔이 실제로 파일을 찾았다', async () => {
    expect((await simSources()).length).toBeGreaterThanOrEqual(2);
  });

  it('src/sim/** 는 카메라·코어·DB·검출기를 import 하지 않는다', async () => {
    const offences: string[] = [];
    for (const { name, source } of await simSources()) {
      for (const path of importedPaths(source)) {
        if (FORBIDDEN.some((forbidden) => path.includes(`/${forbidden}`) || path.startsWith(`../${forbidden}`))) {
          offences.push(`${name} → ${path}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('반대로 카메라·코어도 src/sim/ 을 import 하지 않는다', async () => {
    const roots = ['devices', 'core', 'calibration', 'centering', 'homing', 'detectors', 'db'];
    const offences: string[] = [];
    for (const root of roots) {
      const dir = new URL(`../src/${root}/`, import.meta.url);
      for (const name of await walk(dir)) {
        const source = await readFile(new URL(name, dir), 'utf8');
        if (/from\s+'[^']*\/sim\//.test(source)) offences.push(`${root}/${name}`);
      }
    }
    expect(offences).toEqual([]);
  });

  /**
   * 라우트는 **드라이버를 조립하지 않는다.** `driverFor()` 를 부르는 순간 카메라 설정이
   * 없으면 시뮬레이터 툴이 통째로 못 뜬다 — 시뮬레이터는 카메라와 아무 상관이 없는데도.
   */
  it('simRoutes 는 카메라·DB 를 만지지 않는다', async () => {
    // **주석은 걷어내고 본다.** 주석에 "driverFor 를 부르지 않는다"고 적는 것은 규율을
    // 설명하는 일이고, 그 문장 때문에 검사가 실패하면 설명을 못 남기게 된다.
    const source = stripComments(await readFile(new URL('../src/api/routes/simRoutes.ts', import.meta.url), 'utf8'));
    for (const forbidden of ['driverFor', 'deps.db', 'config.cameras', 'activeCameraId']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  /**
   * 드라이버는 ×100 정수 raw 로 바꾸고 시뮬툴은 도·배율을 그대로 쓴다.
   * 시뮬툴 쪽에 환산이 생기면 두 벌이 되고, 한쪽만 고치는 날이 온다.
   */
  it('시뮬툴은 PTZ 단위를 환산하지 않는다 — 서버가 준 도·배율 그대로다', async () => {
    for (const { name, source } of await simSources()) {
      expect(stripComments(source), name).not.toMatch(/[*/]\s*100/);
    }
  });
});

/** 블록·줄 주석 제거. 규율을 설명하는 문장이 그 규율의 검사에 걸리지 않게 한다. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

async function walk(dir: URL): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const nested of await walk(new URL(`${entry.name}/`, dir))) out.push(`${entry.name}/${nested}`);
    } else if (entry.name.endsWith('.ts')) {
      out.push(entry.name);
    }
  }
  return out;
}
