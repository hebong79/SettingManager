import type { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DiscoveryDbStore } from './discoveryDbStore.js';
import { SpotDbStore } from './spotDbStore.js';

/**
 * DB → **backend-core 형식 JSON 파일** 내보내기.
 *
 * 정본은 SQLite 다. 그런데 baro_calory backend-core 와는 오랫동안 *파일을 복사해 주고받는*
 * 경로가 있었고, 그것을 잃지 않기 위해 뽑아 주는 자리를 남긴다.
 *
 * **변환 코드가 여기 없다는 점이 요점이다.** `DiscoveryDbStore.load()` 와
 * `SpotDbStore.load()` 가 이미 backend-core 모양으로 답하므로(그 모양으로 REST 도 돈다),
 * 이 파일이 하는 일은 그 결과를 디스크에 쓰는 것뿐이다. 형식 변환기를 따로 두면 그것이
 * 실제 동작과 어긋나도 아무도 모르는데, 여기서는 어긋날 자리가 없다.
 *
 * 반대 방향(가져오기)은 만들지 않았다. 필요해지면 그때 만든다 — 지금 쓰는 곳이 없다.
 */

export interface ExportResult {
  cameraId: string;
  files: string[];
}

/**
 * 한 카메라의 탐색 프리셋·점과 주차면을 두 파일로 뽑는다.
 * 파일 이름은 backend-core 저장소가 쓰던 것과 같다 — 그래야 그대로 복사해 넣을 수 있다.
 */
export async function exportBackendCoreFiles(db: DatabaseSync, cameraId: string, dir: string): Promise<ExportResult> {
  await mkdir(dir, { recursive: true });
  const discovery = join(dir, `discovery-${cameraId}.json`);
  const spots = join(dir, `spots-${cameraId}.json`);

  await writeFile(discovery, `${JSON.stringify(await new DiscoveryDbStore(db, cameraId).load(), null, 2)}\n`, 'utf8');
  await writeFile(spots, `${JSON.stringify(await new SpotDbStore(db, cameraId).load(), null, 2)}\n`, 'utf8');

  return { cameraId, files: [discovery, spots] };
}

/** DB 에 있는 카메라 전부. 내보내기 대상을 스스로 찾는다. */
export function exportableCameraIds(db: DatabaseSync): string[] {
  const rows = db.prepare('SELECT cam_uuid FROM camera_info ORDER BY cam_id').all() as unknown as Array<{ cam_uuid: string }>;
  return rows.map((row) => row.cam_uuid);
}
