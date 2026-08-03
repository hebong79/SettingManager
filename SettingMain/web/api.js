/** SettingManager REST 계약. 화면 코드가 fetch 를 직접 부르지 않게 여기 한 곳에 모은다. */

async function request(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`응답이 JSON 이 아닙니다 (${response.status})`);
    }
  }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export const api = {
  cameras: () => request('GET', '/api/cameras'),
  setActiveCamera: (id) => request('POST', '/api/cameras/active', { id }),
  addCamera: (camera) => request('POST', '/api/cameras', camera),
  removeCamera: (id) => request('DELETE', `/api/cameras/${encodeURIComponent(id)}`),
  /** camera 를 주면 저장하지 않은 값으로 시험한다. 실패는 예외가 아니라 { ok: false } 로 온다. */
  testCamera: (id, camera) => request('POST', `/api/cameras/${encodeURIComponent(id)}/test`, camera ? { camera } : {}),

  ptz: (cameraId) => request('GET', `/api/ptz?cameraId=${encodeURIComponent(cameraId)}`),
  moveAbsolute: (cameraId, ptz) => request('POST', '/api/ptz/absolute', { cameraId, ...ptz }),
  nudge: (cameraId, axis, delta) => request('POST', '/api/ptz/nudge', { cameraId, axis, delta }),
  centerPoint: (cameraId, point) => request('POST', '/api/ptz/center', { cameraId, ...point }),

  presets: (cameraId) => request('GET', `/api/presets?cameraId=${encodeURIComponent(cameraId)}`),
  addPreset: (cameraId, name, ptz) => request('POST', '/api/presets', { cameraId, name, ptz }),
  updatePreset: (id, change) => request('PUT', `/api/presets/${encodeURIComponent(id)}`, change),
  removePreset: (id) => request('DELETE', `/api/presets/${encodeURIComponent(id)}`),
  gotoPreset: (id) => request('POST', `/api/presets/${encodeURIComponent(id)}/goto`),

  devicePresetCapability: (cameraId) => request('GET', `/api/device-preset-capability?cameraId=${encodeURIComponent(cameraId)}`),
  devicePresets: (cameraId) => request('GET', `/api/cameras/${encodeURIComponent(cameraId)}/device-presets`),
  goDevicePreset: (cameraId, number, mode) => request('POST', `/api/cameras/${encodeURIComponent(cameraId)}/device-presets/${number}/go`, { mode }),
  syncDevicePresetCoordinate: (cameraId, number) => request('POST', `/api/cameras/${encodeURIComponent(cameraId)}/device-presets/${number}/sync-coordinate`, {}),

  slots: (cameraId) => request('GET', `/api/slots?cameraId=${encodeURIComponent(cameraId)}`),

  settings: () => request('GET', '/api/settings'),
  saveSettings: (patch) => request('PUT', '/api/settings', patch),
};

/** 화면 하단 상태줄. 오류를 조용히 삼키지 않기 위한 유일한 출구다. */
export function toast(message, kind = '') {
  const box = document.getElementById('status');
  if (!box) return;
  box.textContent = message;
  box.className = `show ${kind}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    box.className = '';
  }, kind === 'err' ? 6000 : 2500);
}

export function reportError(error) {
  toast(error instanceof Error ? error.message : String(error), 'err');
}
