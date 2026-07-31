import { api, reportError, toast } from './api.js';

/** 카메라 제어 페이지. 계산은 서버가 하고, 이 파일은 값을 보내고 받아 그린다. */

const $ = (id) => document.getElementById(id);

const state = {
  cameras: [],
  cameraId: '',
  presets: [],
  presetId: '',
  ptz: null,
};

// ---------- 카메라 ----------

async function loadCameras() {
  const { cameras, activeCameraId } = await api.cameras();
  state.cameras = cameras;
  state.cameraId = activeCameraId;
  $('cameraSelect').innerHTML = cameras
    .map((c) => `<option value="${esc(c.id)}">${esc(c.label)} (${esc(c.id)})</option>`)
    .join('');
  $('cameraSelect').value = activeCameraId;
  showKind();
}

function showKind() {
  const camera = state.cameras.find((c) => c.id === state.cameraId);
  $('camKind').textContent = camera ? camera.kind : '-';
}

async function onCameraChange() {
  state.cameraId = $('cameraSelect').value;
  showKind();
  stopStream();
  await api.setActiveCamera(state.cameraId).catch(reportError);
  await Promise.all([loadPresets(), loadSlots(), refreshPtz().catch(() => {})]);
}

// ---------- PTZ ----------

async function refreshPtz() {
  const { ptz } = await api.ptz(state.cameraId);
  state.ptz = ptz;
  $('panDeg').textContent = ptz.panDeg.toFixed(2);
  $('tiltDeg').textContent = ptz.tiltDeg.toFixed(2);
  $('zoomRaw').textContent = String(ptz.zoom);
  $('ptzRaw').textContent = `장비 원시 · P ${ptz.pan} / T ${ptz.tilt} / Z ${ptz.zoom}`;
  return ptz;
}

/**
 * 서버 계약은 항상 raw 눈금이다. step 입력은 pan·tilt 에서 도(°)이고 1° = 100 raw 이며,
 * zoom 은 불투명 raw 라 같은 배수(×100)를 한 눈금 크기로 쓴다.
 */
function stepDelta(sign) {
  const step = Number($('stepDeg').value);
  if (!Number.isFinite(step) || step <= 0) throw new Error('step 은 0보다 큰 숫자여야 합니다');
  return Math.round(step * 100) * sign;
}

async function onPad(event) {
  const button = event.currentTarget;
  const axis = button.dataset.axis;
  const sign = Number(button.dataset.sign);
  try {
    const result = await api.nudge(state.cameraId, axis, stepDelta(sign));
    applyPtz(result);
    reportMove(result);
  } catch (error) {
    reportError(error);
  }
}

/** 이동 결과를 한 문장으로 알린다. 잘린 축과 미정착은 착지가 어긋났다는 유일한 신호다. */
function reportMove(result) {
  if (result.limited && result.limited.length > 0) {
    return toast(`${result.limited.join('·')} 축이 한계에 닿았습니다`);
  }
  if (result.settled === false) {
    return toast('아직 이동 중입니다 — 표시된 좌표가 최종값이 아닐 수 있습니다');
  }
  toast('이동 완료', 'ok');
}

async function onAbsoluteGo() {
  try {
    const ptz = {
      pan: numberField('absPan', 'pan'),
      tilt: numberField('absTilt', 'tilt'),
      zoom: numberField('absZoom', 'zoom'),
    };
    const result = await api.moveAbsolute(state.cameraId, ptz);
    applyPtz(result);
    reportMove(result);
  } catch (error) {
    reportError(error);
  }
}

function applyPtz(result) {
  state.ptz = result.ptz;
  $('panDeg').textContent = result.ptz.panDeg.toFixed(2);
  $('tiltDeg').textContent = result.ptz.tiltDeg.toFixed(2);
  $('zoomRaw').textContent = String(result.ptz.zoom);
  $('ptzRaw').textContent = `장비 원시 · P ${result.ptz.pan} / T ${result.ptz.tilt} / Z ${result.ptz.zoom}`;
}

function numberField(id, label) {
  const value = Number($(id).value);
  if (!Number.isFinite(value)) throw new Error(`${label} 값을 입력하세요`);
  return Math.round(value);
}

async function fillAbsolute() {
  try {
    const ptz = state.ptz ?? (await refreshPtz());
    $('absPan').value = ptz.pan;
    $('absTilt').value = ptz.tilt;
    $('absZoom').value = ptz.zoom;
  } catch (error) {
    reportError(error);
  }
}

// ---------- 프리셋 ----------

async function loadPresets() {
  const { presets } = await api.presets(state.cameraId);
  state.presets = presets;
  if (presets.length === 0) {
    $('presetSelect').innerHTML = '<option value="">(등록된 프리셋 없음)</option>';
    state.presetId = '';
    $('presetName').value = '';
    return;
  }
  $('presetSelect').innerHTML = presets
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
    .join('');
  if (!presets.some((p) => p.id === state.presetId)) state.presetId = presets[0].id;
  $('presetSelect').value = state.presetId;
  syncPresetName();
}

function syncPresetName() {
  const preset = state.presets.find((p) => p.id === state.presetId);
  $('presetName').value = preset ? preset.name : '';
}

async function onPresetGoto() {
  if (!state.presetId) return toast('이동할 프리셋을 선택하세요');
  try {
    const result = await api.gotoPreset(state.presetId);
    applyPtz(result);
    toast(`${result.preset.name} 이동 완료`, 'ok');
  } catch (error) {
    reportError(error);
  }
}

async function onPresetAdd() {
  const name = $('presetName').value.trim();
  if (!name) return toast('프리셋 이름을 입력하세요');
  try {
    const { preset } = await api.addPreset(state.cameraId, name); // ptz 생략 = 현재 자세 저장
    state.presetId = preset.id;
    await loadPresets();
    toast(`${preset.name} 저장 완료`, 'ok');
  } catch (error) {
    reportError(error);
  }
}

async function onPresetSave() {
  if (!state.presetId) return toast('저장할 프리셋을 선택하세요');
  const name = $('presetName').value.trim();
  if (!name) return toast('프리셋 이름을 입력하세요');
  try {
    const ptz = await refreshPtz();
    const { preset } = await api.updatePreset(state.presetId, { name, ptz: { pan: ptz.pan, tilt: ptz.tilt, zoom: ptz.zoom } });
    await loadPresets();
    toast(`${preset.name} 갱신 완료`, 'ok');
  } catch (error) {
    reportError(error);
  }
}

async function onPresetDelete() {
  if (!state.presetId) return toast('삭제할 프리셋을 선택하세요');
  const preset = state.presets.find((p) => p.id === state.presetId);
  if (!confirm(`프리셋 「${preset ? preset.name : state.presetId}」을(를) 삭제할까요?`)) return;
  try {
    await api.removePreset(state.presetId);
    state.presetId = '';
    await loadPresets();
    toast('삭제 완료', 'ok');
  } catch (error) {
    reportError(error);
  }
}

// ---------- 주차면 ----------

async function loadSlots() {
  const area = $('slotArea');
  try {
    const { slots, source } = await api.slots(state.cameraId);
    $('slotSource').textContent = source === 'simulator' ? '시뮬레이터' : '로컬 등록';
    if (slots.length === 0) {
      area.innerHTML = '<p class="empty">등록된 주차면이 없습니다. 시뮬레이터 카메라는 씬에서, 실카메라는 config/slots.json 에서 읽습니다.</p>';
      return;
    }
    area.innerHTML = `<table><thead><tr><th>ID</th><th>이름</th><th>상태</th></tr></thead><tbody>${slots
      .map((s) => `<tr><td>${esc(s.id)}</td><td>${esc(s.label)}</td><td>${slotBadge(s)}</td></tr>`)
      .join('')}</tbody></table>`;
  } catch (error) {
    $('slotSource').textContent = '-';
    area.innerHTML = `<p class="empty">주차면을 불러오지 못했습니다: ${esc(error.message)}</p>`;
  }
}

function slotBadge(slot) {
  if (slot.occupied === undefined) return '<span class="badge">미확인</span>';
  return slot.occupied ? '<span class="badge busy">점유</span>' : '<span class="badge free">비어 있음</span>';
}

// ---------- 영상 ----------

function startStream() {
  const img = $('stream');
  // 캐시·이전 연결을 확실히 끊기 위해 매번 새 URL 을 만든다.
  img.src = `/api/stream?cameraId=${encodeURIComponent(state.cameraId)}&t=${Date.now()}`;
  img.classList.add('live');
  $('streamPlaceholder').style.display = 'none';
  $('streamTag').textContent = '수신 중';
  img.onerror = () => {
    stopStream();
    toast('영상을 받지 못했습니다 — 옵션 페이지에서 RTSP·시뮬레이터 URL 을 확인하세요', 'err');
  };
}

function stopStream() {
  const img = $('stream');
  img.onerror = null;
  img.removeAttribute('src');
  img.classList.remove('live');
  $('streamPlaceholder').style.display = '';
  $('streamTag').textContent = '정지';
}

function snapshotOnce() {
  const img = $('stream');
  img.onerror = () => {
    stopStream();
    toast('스냅샷을 받지 못했습니다', 'err');
  };
  img.src = `/api/snapshot?cameraId=${encodeURIComponent(state.cameraId)}&t=${Date.now()}`;
  img.classList.add('live');
  $('streamPlaceholder').style.display = 'none';
  $('streamTag').textContent = '스냅샷';
}

// ---------- 배선 ----------

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function wire() {
  $('cameraSelect').addEventListener('change', () => void onCameraChange());
  $('presetSelect').addEventListener('change', () => {
    state.presetId = $('presetSelect').value;
    syncPresetName();
  });
  $('presetGoto').addEventListener('click', () => void onPresetGoto());
  $('presetAdd').addEventListener('click', () => void onPresetAdd());
  $('presetSave').addEventListener('click', () => void onPresetSave());
  $('presetDelete').addEventListener('click', () => void onPresetDelete());

  for (const button of document.querySelectorAll('.pad button[data-axis]')) {
    button.addEventListener('click', onPad);
  }
  $('padStop').addEventListener('click', () => void refreshPtz().then(() => toast('현재 자세를 다시 읽었습니다')).catch(reportError));
  $('ptzRefresh').addEventListener('click', () => void refreshPtz().catch(reportError));
  $('absGo').addEventListener('click', () => void onAbsoluteGo());
  $('absFill').addEventListener('click', () => void fillAbsolute());

  $('streamStart').addEventListener('click', startStream);
  $('streamStop').addEventListener('click', stopStream);
  $('snapshotOnce').addEventListener('click', snapshotOnce);
  $('slotRefresh').addEventListener('click', () => void loadSlots());
}

async function main() {
  wire();
  try {
    await loadCameras();
  } catch (error) {
    return reportError(error);
  }
  await Promise.all([loadPresets().catch(reportError), loadSlots()]);
  // 카메라가 꺼져 있어도 페이지는 떠야 한다 — PTZ 실패는 상태줄로만 알린다.
  await refreshPtz().catch(reportError);
}

void main();
