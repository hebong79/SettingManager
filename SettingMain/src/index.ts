import { createServer } from './api/server.js';
import { ConfigStore, DEFAULT_CONFIG_PATH } from './config/configStore.js';
import { PresetStore } from './store/presetStore.js';
import { DevicePresetRegistryStore } from './store/devicePresetRegistryStore.js';
import { SlotStore } from './store/slotStore.js';
import { DEFAULT_DB_PATH, openDatabase } from './db/database.js';
import { migratePresetsFile } from './db/configPresets.js';
import { CameraLockStore } from './calibration/cameraLock.js';
import { createDriver, findCamera } from './devices/driverFactory.js';
import type { AppConfig } from './config/types.js';

/** SettingManager 진입점 — 설정을 읽고 웹 콘솔 + 제어 API 를 띄운다. */
async function main(): Promise<void> {
  // **DB 를 먼저 연다** — 카메라의 정본이 그 안에 있고, 설정을 읽을 때 이미 붙어 있어야 한다.
  const db = openDatabase();

  const configStore = new ConfigStore(DEFAULT_CONFIG_PATH, db);
  const config = await configStore.load();

  // 프리셋 정본도 DB(`preset_info`)다. 옛 `config/presets.json` 이 남아 있으면 1회 옮기고
  // 파일을 물러나게 한다 — 두 정본이 공존하는 상태를 남기지 않는다.
  const presetMigration = await migratePresetsFile(db);
  const presetStore = new PresetStore(db);

  const devicePresetRegistryStore = new DevicePresetRegistryStore();
  await devicePresetRegistryStore.load();

  const slotStore = new SlotStore();
  await slotStore.load();

  // 지난번 스윕이 비정상 종료했으면 카메라가 고배율로 엉뚱한 데를 보고 있다. 유언장이 남아
  // 있을 때만 되돌린다 — 비어 있는 것이 정상이라 평소에는 아무 소리도 나지 않는다.
  await recoverCameraLocks(config);

  const server = createServer({ configStore, presetStore, slotStore, devicePresetRegistryStore, db });
  server.listen(config.server.port, config.server.host, () => {
    const { host, port } = config.server;
    console.log(`SettingManager  http://${host}:${port}/`);
    console.log(`  설정 파일     ${configStore.path}`);
    console.log(`  활성 카메라   ${config.activeCameraId}`);
    console.log(`  커미셔닝 DB   ${DEFAULT_DB_PATH}`);
    console.log(`  카메라        ${config.cameras.length}대 (정본: camera_info)`);
    if (presetMigration) {
      console.log(`  프리셋 이관   ${presetMigration.imported.length}건 (건너뜀 ${presetMigration.skipped.length}건) — 정본: preset_info`);
      // 어긋나면 파일을 물러나게 하지 않았다. 조용히 넘어가면 되돌릴 시점을 놓친다.
      for (const problem of presetMigration.mismatches) console.error(`  ⚠ 프리셋 이관 대조 실패: ${problem}`);
    }
  });
}

/**
 * 남아 있는 유언장을 이행한다 — **지난 실행이 카메라를 두고 죽었다는 뜻이다.**
 *
 * 20분짜리 스윕 도중 재시작·배포·OOM 이 들어오면 잡의 홈 복귀도 같이 죽는다. 그때 카메라는
 * 고배율로 엉뚱한 데를 본 채 남고, 다음 사람은 원래 어디를 보고 있었는지 알 방법이 없다.
 *
 * **되돌리는 데 성공했을 때만 찢는다.** 카메라가 아직 안 떠 있으면 다음 기동이 다시 시도한다.
 * 여기서 실패해도 서버 기동은 막지 않는다 — 카메라 한 대 때문에 콘솔 전체가 안 뜨면 더 나쁘다.
 */
async function recoverCameraLocks(config: AppConfig): Promise<void> {
  const locks = new CameraLockStore();
  for (const lock of await locks.pending()) {
    try {
      const camera = findCamera(config, lock.cameraId);
      await createDriver(camera, config).goPtz(lock.home);
      await locks.release(lock.cameraId);
      console.log(`  카메라 복귀   ${lock.cameraId} — 중단된 "${lock.job}" 이(가) 두고 간 자세로 되돌렸습니다`);
    } catch (error) {
      console.error(
        `  ⚠ 카메라 복귀 실패 ${lock.cameraId} (${lock.job}, ${lock.heldAt}) — 유언장을 남겨 둡니다: `
        + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
