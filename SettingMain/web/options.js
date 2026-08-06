import { api, reportError, toast } from './api.js';
import { wireDbTabs } from './optionsDb.js';

/**
 * 옵션 화면의 **서비스 설정 탭** — 코어 구현과 BackendCore 주소.
 *
 * 카메라는 여기 없다. 카메라의 정본이 `camera_info`(DB)로 옮겨지면서 「기기」·「기기 편집」
 * 카드가 통째로 **카메라 탭**(`optionsDb.js`)으로 갔다. 편집 화면이 두 곳에 있으면
 * 어느 쪽이 이겼는지 사람이 알 수 없기 때문이다.
 */

const $ = (id) => document.getElementById(id);

async function load() {
  const settings = await api.settings();
  $('simulatorUrl').value = settings.simulator.baseUrl;
  if (settings.core?.provider) $('coreProvider').value = settings.core.provider;
  $('coreTag').textContent = settings.core?.provider === 'remote' ? 'backend-core 경유' : '브리지 코어';
}

async function saveCoreProvider() {
  try {
    const result = await api.saveSettings({ core: { provider: $('coreProvider').value } });
    $('coreTag').textContent = result.core?.provider === 'remote' ? 'backend-core 경유' : '브리지 코어';
    toast(`코어 구현: ${result.core?.provider ?? $('coreProvider').value}`, 'ok');
  } catch (error) {
    reportError(error);
  }
}

async function saveSimulatorUrl() {
  try {
    const result = await api.saveSettings({ simulator: { baseUrl: $('simulatorUrl').value.trim() } });
    $('simulatorUrl').value = result.simulator.baseUrl;
    toast('BackendCore URL 저장', 'ok');
  } catch (error) {
    reportError(error);
  }
}

async function main() {
  $('coreSave').addEventListener('click', () => void saveCoreProvider());
  $('simulatorSave').addEventListener('click', () => void saveSimulatorUrl());
  wireDbTabs({ toast, reportError });
  try {
    await load();
  } catch (error) {
    reportError(error);
  }
}

void main();
