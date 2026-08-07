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

  // --- 커미셔닝 DB -------------------------------------------------------
  // 편집을 여는 표는 셋뿐이다. 슬롯·주차상태는 커미셔닝이 만드는 산출물이라 뷰어에서 읽기만 한다.
  dbTables: () => request('GET', '/api/db/tables'),
  dbQuery: (query) => request('POST', '/api/db/query', query),
  dbPlaces: () => request('GET', '/api/db/places'),
  dbSavePlace: (place) => request('POST', '/api/db/places', place),
  dbRenamePlace: (placeId, placeName) => request('PUT', `/api/db/places/${placeId}`, { place_name: placeName }),
  dbRemovePlace: (placeId) => request('DELETE', `/api/db/places/${placeId}`),
  dbCameras: () => request('GET', '/api/db/cameras'),
  dbAddCamera: (camera) => request('POST', '/api/db/cameras', camera),
  dbSaveCamera: (camId, patch) => request('PUT', `/api/db/cameras/${camId}`, patch),
  dbRemoveCamera: (camId) => request('DELETE', `/api/db/cameras/${camId}`),
  /** 저장하지 않고 지금 값으로 시험한다. 실패는 예외가 아니라 { ok:false } 로 온다. */
  dbTestCamera: (camId, patch) => request('POST', `/api/db/cameras/${camId}/test`, patch ?? {}),
  dbPresets: (camId) => request('GET', camId ? `/api/db/presets?cam_id=${camId}` : '/api/db/presets'),
  dbAddPreset: (preset) => request('POST', '/api/db/presets', preset),
  dbSavePreset: (camId, presetId, patch) => request('PUT', `/api/db/presets/${camId}/${presetId}`, patch),
  dbRemovePreset: (camId, presetId) => request('DELETE', `/api/db/presets/${camId}/${presetId}`),

  setActiveCamera: (id) => request('POST', '/api/cameras/active', { id }),

  ptz: (cameraId) => request('GET', `/api/ptz?cameraId=${encodeURIComponent(cameraId)}`),
  moveAbsolute: (cameraId, ptz) => request('POST', '/api/ptz/absolute', { cameraId, ...ptz }),
  nudge: (cameraId, axis, delta) => request('POST', '/api/ptz/nudge', { cameraId, axis, delta }),
  centerPoint: (cameraId, point) => request('POST', '/api/core/center', { cameraId, ...point }),
  coreCapabilities: (cameraId) => request('GET', `/api/core/capabilities?cameraId=${encodeURIComponent(cameraId)}`),

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

  // --- 탐색 프리셋·점 ----------------------------------------------------
  // **cameraId 를 반드시 싣는다.** 서버는 없으면 *활성* 기기로 떨어지는데, 화면에서 고른
  // 기기와 활성 기기는 다를 수 있다 — 그러면 A 를 보면서 B 의 탐색 데이터를 고치게 된다.
  discoveryPresets: (cameraId) => request('GET', `/api/core/discovery/presets?cameraId=${encodeURIComponent(cameraId)}`),
  discoveryAddPreset: (cameraId, body) => request('POST', '/api/core/discovery/presets', { cameraId, ...body }),
  discoveryUpdatePreset: (cameraId, presetId, body) =>
    request('PUT', `/api/core/discovery/presets/${encodeURIComponent(presetId)}`, { cameraId, ...body }),
  discoveryRemovePreset: (cameraId, presetId) =>
    request('DELETE', `/api/core/discovery/presets/${encodeURIComponent(presetId)}?cameraId=${encodeURIComponent(cameraId)}`),
  discoveryGotoPreset: (cameraId, presetId) =>
    request('POST', `/api/core/discovery/presets/${encodeURIComponent(presetId)}/goto`, { cameraId }),
  discoveryPoints: (cameraId, presetId) =>
    request('GET', `/api/core/discovery/presets/${encodeURIComponent(presetId)}/points?cameraId=${encodeURIComponent(cameraId)}`),
  discoveryAddPoint: (cameraId, presetId, point) =>
    request('POST', `/api/core/discovery/presets/${encodeURIComponent(presetId)}/points`, { cameraId, ...point }),
  discoveryUpdatePoint: (cameraId, presetId, pointId, point) =>
    request('PUT', `/api/core/discovery/presets/${encodeURIComponent(presetId)}/points/${encodeURIComponent(pointId)}`, { cameraId, ...point }),
  discoveryRemovePoint: (cameraId, presetId, pointId) =>
    request('DELETE', `/api/core/discovery/presets/${encodeURIComponent(presetId)}/points/${encodeURIComponent(pointId)}?cameraId=${encodeURIComponent(cameraId)}`),

  // --- 번호판 호밍 -------------------------------------------------------
  // 시작은 **카메라를 점마다 수십 초씩 점유하고 고배율로 돌린다.** 캘리브레이션과 같은 규율이다.
  plateHomingStart: (cameraId, body) => request('POST', '/api/core/plate-homing/start', { cameraId, ...body }),
  plateHomingStatus: (cameraId) => request('GET', `/api/core/plate-homing/status?cameraId=${encodeURIComponent(cameraId)}`),
  plateHomingStop: (cameraId) => request('POST', '/api/core/plate-homing/stop', { cameraId }),
  /** 실패한 점을 **잡이 본 그대로** 다시 본다 — 스텝별 숫자와 프레임 URL. */
  plateHomingTrace: (cameraId, presetId, pointId) =>
    request('GET', `/api/core/discovery/presets/${encodeURIComponent(presetId)}/points/${encodeURIComponent(pointId)}/home-trace?cameraId=${encodeURIComponent(cameraId)}`),

  // --- 캘리브레이션 ------------------------------------------------------
  // 시작은 **카메라를 수십 분 점유한다.** 화면이 그 사실을 먼저 말하고 확인을 받는다.
  calibrationStart: (cameraId, mode) => request('POST', '/api/core/calibration/start', { cameraId, mode }),
  calibrationStatus: (cameraId) => request('GET', `/api/core/calibration/status?cameraId=${encodeURIComponent(cameraId)}`),
  calibrationStop: (cameraId) => request('POST', '/api/core/calibration/stop', { cameraId }),
  /** 발행은 별도 동작이다 — 게이트에 걸렸을 때 사람이 「그래도 발행」을 고를 여지가 있어야 한다. */
  calibrationMint: (cameraId, options = {}) => request('POST', '/api/core/calibration/mint', { cameraId, ...options }),

  // --- 카메라 프로파일 ---------------------------------------------------
  profile: (cameraId) => request('GET', `/api/profiles/camera/${encodeURIComponent(cameraId)}`),
  profileAt: (cameraId, revision) => request('GET', `/api/profiles/camera/${encodeURIComponent(cameraId)}/@${revision}`),
  profileApply: (cameraId, revision) => request('POST', `/api/profiles/camera/${encodeURIComponent(cameraId)}/apply`, revision === undefined ? {} : { revision }),
  profileImport: (cameraId, body) => request('POST', `/api/profiles/camera/${encodeURIComponent(cameraId)}`, body),
  profileCopy: (cameraId, body) => request('POST', `/api/profiles/camera/${encodeURIComponent(cameraId)}/copy`, body),

  // --- 차량 3D 육면체 ----------------------------------------------------
  // **카메라를 움직이지 않는다** — 그래서 확인 절차가 없다.
  vehicleBoxStatus: (cameraId) => request('GET', `/api/core/vehicle-box/status?cameraId=${encodeURIComponent(cameraId)}`),
  vehicleBoxDetect: (cameraId) => request('POST', '/api/core/vehicle-box', { cameraId }),
  vehicleBoxHistory: (cameraId, limit = 20) => request('GET', `/api/core/vehicle-box/history?cameraId=${encodeURIComponent(cameraId)}&limit=${limit}`),

  // --- 시뮬레이터 툴 -----------------------------------------------------
  // **카메라·DB 를 전혀 쓰지 않는다.** 이 셋이 시뮬레이터 툴의 표면 전부다 —
  // 늘어나면 독립 경계가 새고 있다는 뜻이다.
  simCatalog: () => request('GET', '/api/sim/catalog'),
  simCarCatalog: () => request('GET', '/api/sim/car-catalog'),
  simRpc: (method, params = {}) => request('POST', '/api/sim/rpc', { method, params }),

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
