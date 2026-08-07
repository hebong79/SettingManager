import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from '../paths.js';

/**
 * 차량 프리팹 카탈로그 — 정본은 **`config/car_catalog.json`** 이다.
 *
 * 그 파일의 주석이 계약을 말한다:
 *
 * > 배열 순서가 prefabId(1부터)다. 순서를 바꾸면 저장된 `CarPos_*.json` 의 차종 해석이 바뀐다.
 *
 * ## 왜 서버가 읽어 주는가
 *
 * 시뮬레이터 RPC 에 **차종 이름 목록을 주는 메서드가 없다**(82개 어디에도). `car.get` 은
 * `prefabId` 숫자만 준다 — 목록이 없으면 사람이 "6번이 뭐였지"를 외워야 한다.
 *
 * 화면에 박아 두지 않는 이유는 **정본이 갈리지 않게** 하기 위해서다. 저 파일을 고치면
 * 시뮬레이터와 이 화면이 함께 바뀐다. 화면 코드에 복사해 두면 한쪽만 고치는 날이 온다.
 *
 * ## 없거나 깨져 있으면 **빈 목록 + 사유**다
 *
 * 지어낸 기본 목록을 채우면, 잘못된 이름으로 차를 배치해 놓고 사람은 맞다고 믿는다.
 * 빈 목록이 뜨면 무엇이 문제인지 화면이 바로 말할 수 있다.
 */

export interface CarCatalog {
  /** 배열 index + 1 = `prefabId`. */
  cars: Array<{ prefabId: number; name: string }>;
  /** 읽지 못했으면 그 사유. 있으면 `cars` 는 비어 있다. */
  reason?: string;
  source: string;
}

const FILE = 'car_catalog.json';

export async function loadCarCatalog(dir: string = CONFIG_DIR): Promise<CarCatalog> {
  const path = join(dir, FILE);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { cars: [], source: FILE, reason: `${FILE} 를 읽지 못했습니다 — config/ 에 그 파일이 있어야 차종 이름을 알 수 있습니다` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { cars: [], source: FILE, reason: `${FILE} 가 JSON 이 아닙니다: ${error instanceof Error ? error.message : String(error)}` };
  }

  const names = (parsed as { cars?: unknown })?.cars;
  if (!Array.isArray(names)) {
    return { cars: [], source: FILE, reason: `${FILE} 에 cars 배열이 없습니다` };
  }

  // 빈 칸을 건너뛰면 **그 뒤 전부가 한 칸씩 밀린다** — 배열 위치가 곧 prefabId 이기 때문이다.
  // 그래서 위치는 지키고, 이름이 없는 자리만 그렇다고 표시한다.
  return {
    source: FILE,
    cars: names.map((name, index) => ({
      prefabId: index + 1,
      name: typeof name === 'string' && name.trim() ? name : `(이름 없음 #${index + 1})`,
    })),
  };
}
