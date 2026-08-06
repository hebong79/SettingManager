import { createServer } from './api/server.js';
import { ConfigStore, DEFAULT_CONFIG_PATH } from './config/configStore.js';
import { PresetStore } from './store/presetStore.js';
import { DevicePresetRegistryStore } from './store/devicePresetRegistryStore.js';
import { SlotStore } from './store/slotStore.js';
import { DEFAULT_DB_PATH, openDatabase } from './db/database.js';
import { migratePresetsFile } from './db/configPresets.js';

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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
