import { createServer } from './api/server.js';
import { ConfigStore, DEFAULT_CONFIG_PATH } from './config/configStore.js';
import { PresetStore } from './store/presetStore.js';
import { DevicePresetRegistryStore } from './store/devicePresetRegistryStore.js';
import { SlotStore } from './store/slotStore.js';
import { DEFAULT_DB_PATH, openDatabase } from './db/database.js';

/** SettingManager 진입점 — 설정을 읽고 웹 콘솔 + 제어 API 를 띄운다. */
async function main(): Promise<void> {
  // **DB 를 먼저 연다** — 카메라의 정본이 그 안에 있고, 설정을 읽을 때 이미 붙어 있어야 한다.
  const db = openDatabase();

  const configStore = new ConfigStore(DEFAULT_CONFIG_PATH, db);
  const config = await configStore.load();

  const presetStore = new PresetStore();
  await presetStore.load();

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
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
