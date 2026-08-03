import { createServer } from './api/server.js';
import { ConfigStore } from './config/configStore.js';
import { PresetStore } from './store/presetStore.js';
import { DevicePresetRegistryStore } from './store/devicePresetRegistryStore.js';
import { SlotStore } from './store/slotStore.js';

/** SettingManager 진입점 — 설정을 읽고 웹 콘솔 + 제어 API 를 띄운다. */
async function main(): Promise<void> {
  const configStore = new ConfigStore();
  const config = await configStore.load();

  const presetStore = new PresetStore();
  await presetStore.load();

  const devicePresetRegistryStore = new DevicePresetRegistryStore();
  await devicePresetRegistryStore.load();

  const slotStore = new SlotStore();
  await slotStore.load();

  const server = createServer({ configStore, presetStore, slotStore, devicePresetRegistryStore });
  server.listen(config.server.port, config.server.host, () => {
    const { host, port } = config.server;
    console.log(`SettingManager  http://${host}:${port}/`);
    console.log(`  설정 파일     ${configStore.path}`);
    console.log(`  활성 카메라   ${config.activeCameraId}`);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
