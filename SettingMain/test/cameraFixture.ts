import type { DatabaseSync } from 'node:sqlite';
import { toCameraRow } from '../src/db/configCameras.js';
import { normalizeCamera } from '../src/config/normalize.js';
import { SetupRepository } from '../src/db/setupRepository.js';

/**
 * 테스트가 카메라를 세팅하는 **한 곳**.
 *
 * 예전에는 하네스마다 `config.json` 에 `cameras[]` 를 적었다. 카메라의 정본이
 * `camera_info` 로 옮겨지면서 그 자리가 DB 가 됐고, 하네스가 저마다 SQL 을 들면
 * 스키마가 바뀔 때 어디까지 고쳐야 하는지 알 수 없게 된다.
 *
 * 입력은 **예전 config 모양 그대로** 받는다 — 기존 테스트의 카메라 정의를 한 글자도
 * 고치지 않고 옮겨 올 수 있어야, 옮기다 값이 달라지는 사고가 안 생긴다.
 */
export function seedCameras(db: DatabaseSync, cameras: Array<Record<string, unknown>>): void {
  const repo = new SetupRepository(db);
  for (const raw of cameras) {
    const camera = normalizeCamera(raw);
    if (!camera) throw new Error(`테스트 카메라 정의가 잘못됐습니다: ${JSON.stringify(raw)}`);
    repo.upsertCamera(toCameraRow(camera));
  }
}
