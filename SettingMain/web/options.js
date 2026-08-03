import { api, reportError, toast } from './api.js';

/**
 * 옵션 페이지.
 * 콤보박스에서 카메라를 고르면 그 기기의 설정만 아래 편집 폼에 뜨고,
 * 「이 기기 적용」이 config/config.json 에 저장한다.
 */

const $ = (id) => document.getElementById(id);

const state = {
  cameras: [],
  selectedId: '',
  activeId: '',
  simulatorUrl: '',
  dirty: false,
};

/** 편집 폼의 입력칸 ↔ 카메라 필드 대응. */
const FIELDS = [
  ['fieldLabel', 'label'],

  ['fieldControlUrl', 'controlUrl'],
  ['fieldUsername', 'username'],
  ['fieldStreamUrl', 'streamUrl'],
  ['fieldTimeout', 'timeoutMs'],
];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function selected() {
  return state.cameras.find((c) => c.id === state.selectedId);
}

// ---------- 그리기 ----------

function renderCameraList() {
  $('cameraSelect').innerHTML = state.cameras
    .map((c) => `<option value="${esc(c.id)}">${esc(c.label)} (${esc(c.id)})${c.id === state.activeId ? ' · 활성' : ''}</option>`)
    .join('');
  $('cameraSelect').value = state.selectedId;
  $('activeTag').textContent = `활성: ${state.activeId}`;
}

function renderEditor() {
  const camera = selected();
  if (!camera) return;

  $('editTitle').textContent = `기기 편집: ${camera.id}`;
  $('fieldId').value = camera.id;
  $('fieldLabel').value = camera.label;

  $('fieldControlUrl').value = camera.controlUrl;
  $('fieldUsername').value = camera.username;
  $('fieldStreamUrl').value = camera.streamUrl;
  $('fieldTimeout').value = camera.timeoutMs;

  // 비밀번호는 서버가 돌려주지 않는다. 보유 여부만 안내한다.
  $('fieldPassword').value = '';
  $('fieldPassword').placeholder = camera.hasPassword ? '(저장됨 · 변경 시에만 입력)' : '(미설정)';


  applyStreamHint();
  setDirty(false);
}


/** 영상 URL 의 스킴이 어떤 경로로 가는지 즉시 알려준다 — 서버의 streamTransportFor 와 같은 규칙. */
function applyStreamHint() {
  const raw = $('fieldStreamUrl').value.trim();
  const url = raw.toLowerCase();
  let text;
  if (url.startsWith('rtsp://') || url.startsWith('rtsps://')) text = '→ RTSP 를 ffmpeg 로 MJPEG 전사합니다 (ffmpeg 필요).';
  else if (url.startsWith('http://') || url.startsWith('https://')) text = '→ 연속 MJPEG 를 그대로 중계합니다 (UE 시뮬 직결 포트 = 제어 포트 + 10).';
  else if (url) text = '⚠ 알 수 없는 스킴입니다 — rtsp:// 또는 http:// 로 시작해야 합니다. 지금 값은 스냅샷 폴링으로 처리됩니다.';
  else text = '→ 비어 있음: 스냅샷을 반복해서 받아 영상처럼 보여줍니다.';

  const mismatch = portPairWarning($('fieldControlUrl').value.trim(), raw);
  $('streamHint').textContent = mismatch ? `${text}  ${mismatch}` : text;
  $('streamHint').style.color = mismatch ? 'var(--warn)' : '';
}

/**
 * UE 시뮬은 카메라마다 제어 포트(8081~)와 영상 포트(8091~)가 **1:1 로 짝**이다.
 * 짝이 어긋나면 다른 카메라의 영상을 보게 되고, PTZ 숫자는 바뀌는데 화면은 그대로라
 * "버튼이 동작하지 않는다"로 보인다(실제로 겪은 증상). 조용히 두면 원인을 짚을 수 없다.
 */
function portPairWarning(controlUrl, streamUrl) {
  let control;
  let stream;
  try {
    control = new URL(controlUrl);
    stream = new URL(streamUrl);
  } catch {
    return '';
  }
  if (!control.protocol.startsWith('http') || !stream.protocol.startsWith('http')) return '';
  if (control.hostname !== stream.hostname) return '';
  const controlPort = Number(control.port);
  const streamPort = Number(stream.port);
  if (!controlPort || !streamPort || streamPort === controlPort + 10) return '';
  return `⚠ 제어 ${controlPort} 의 영상 포트는 ${controlPort + 10} 입니다 — ${streamPort} 는 다른 카메라의 영상일 수 있습니다.`;
}

function setDirty(value) {
  state.dirty = value;
  $('dirtyTag').hidden = !value;
  $('editCard').classList.toggle('dirty', value);
}

// ---------- 읽기 ----------

async function load(keepSelection = false) {
  const settings = await api.settings();
  state.cameras = settings.cameras;
  state.activeId = settings.activeCameraId;
  state.simulatorUrl = settings.simulator.baseUrl;

  const stillThere = keepSelection && state.cameras.some((c) => c.id === state.selectedId);
  if (!stillThere) state.selectedId = settings.activeCameraId;

  $('simulatorUrl').value = state.simulatorUrl;
  renderCameraList();
  renderEditor();
}

// ---------- 저장 ----------

function collectCameraChange() {
  const change = { id: state.selectedId };
  for (const [elementId, field] of FIELDS) {
    const input = $(elementId);
    if (field === 'timeoutMs') {
      const value = Number(input.value);
      if (!Number.isFinite(value)) throw new Error('타임아웃은 숫자여야 합니다');
      change.timeoutMs = value;
    } else {
      change[field] = input.value.trim();
    }
  }
  // 빈 비밀번호는 "변경 없음"이다 — 그대로 보내면 저장 한 번에 자격증명이 지워진다.
  const password = $('fieldPassword').value;
  if (password) change.password = password;
  return change;
}

async function applyCamera() {
  try {
    const result = await api.saveSettings({ cameras: [collectCameraChange()] });
    state.cameras = result.cameras;
    state.activeId = result.activeCameraId;
    renderCameraList();
    renderEditor();
    toast(`${state.selectedId} 저장 완료 — config/config.json 갱신`, 'ok');
  } catch (error) {
    reportError(error);
  }
}

async function saveSimulatorUrl() {
  try {
    const result = await api.saveSettings({ simulator: { baseUrl: $('simulatorUrl').value.trim() } });
    state.simulatorUrl = result.simulator.baseUrl;
    $('simulatorUrl').value = state.simulatorUrl;
    toast('시뮬레이터 URL 저장 완료', 'ok');
  } catch (error) {
    reportError(error);
  }
}

async function addCamera() {
  const id = $('newCameraId').value.trim();
  if (!id) return toast('새 기기 ID 를 입력하세요');
  try {
    const result = await api.addCamera({ id });
    state.cameras = result.cameras;
    state.activeId = result.activeCameraId;
    state.selectedId = result.camera.id;
    $('newCameraId').value = '';
    renderCameraList();
    renderEditor();
    toast(`${result.camera.id} 등록 완료 — 접속 정보를 채우고 「이 기기 적용」`, 'ok');
  } catch (error) {
    reportError(error);
  }
}

async function deleteCamera() {
  const camera = selected();
  if (!camera) return;
  if (!confirm(`기기 「${camera.label} (${camera.id})」을(를) 삭제할까요?\n이 기기의 프리셋도 함께 지워집니다.`)) return;
  try {
    const result = await api.removeCamera(camera.id);
    state.cameras = result.cameras;
    state.activeId = result.activeCameraId;
    state.selectedId = result.activeCameraId;
    setDirty(false);
    renderCameraList();
    renderEditor();
    showTestResult('');
    const presetNote = result.removedPresets > 0 ? ` (프리셋 ${result.removedPresets}건 함께 삭제)` : '';
    toast(`${result.removed} 삭제 완료${presetNote}`, 'ok');
  } catch (error) {
    reportError(error);
  }
}

/** 연결 테스트 — 저장하지 않고 지금 화면의 값으로 시도한다. */
async function testCamera() {
  const camera = selected();
  if (!camera) return;
  const button = $('testCamera');
  button.disabled = true;
  showTestResult('연결 확인 중…');
  try {
    const result = await api.testCamera(camera.id, collectCameraChange());
    if (result.ok) {
      showTestResult(
        `✅ 연결 성공 · ${result.elapsedMs}ms · PTZ P ${result.ptz.pan} / T ${result.ptz.tilt} / Z ${result.ptz.zoom}`,
        'ok',
      );
      toast('연결 성공', 'ok');
    } else {
      showTestResult(`❌ 연결 실패 · ${result.elapsedMs}ms · ${result.error}`, 'err');
      toast('연결 실패 — 아래 사유를 확인하세요', 'err');
    }
  } catch (error) {
    showTestResult(`❌ ${error.message}`, 'err');
    reportError(error);
  } finally {
    button.disabled = false;
  }
}

function showTestResult(text, kind = '') {
  const box = $('testResult');
  box.textContent = text;
  box.style.color = kind === 'ok' ? 'var(--ok)' : kind === 'err' ? 'var(--err)' : 'var(--muted)';
}

async function makeActive() {
  try {
    const result = await api.saveSettings({ activeCameraId: state.selectedId });
    state.activeId = result.activeCameraId;
    renderCameraList();
    toast(`활성 기기: ${state.activeId}`, 'ok');
  } catch (error) {
    reportError(error);
  }
}

// ---------- 배선 ----------

function onCameraChange() {
  const next = $('cameraSelect').value;
  // 저장 안 한 편집은 카메라를 바꾸는 순간 사라진다 — 조용히 버리지 않는다.
  if (state.dirty && !confirm('저장하지 않은 변경이 있습니다. 버리고 다른 기기를 볼까요?')) {
    $('cameraSelect').value = state.selectedId;
    return;
  }
  state.selectedId = next;
  renderEditor();
  showTestResult('');
}

function wire() {
  $('cameraSelect').addEventListener('change', onCameraChange);
  $('makeActive').addEventListener('click', () => void makeActive());
  $('reload').addEventListener('click', () => void load(true).catch(reportError));
  $('addCamera').addEventListener('click', () => void addCamera());
  $('simulatorSave').addEventListener('click', () => void saveSimulatorUrl());
  $('applyCamera').addEventListener('click', () => void applyCamera());
  $('testCamera').addEventListener('click', () => void testCamera());
  $('deleteCamera').addEventListener('click', () => void deleteCamera());
  $('revertCamera').addEventListener('click', () => {
    renderEditor();
    showTestResult('');
  });

  for (const [elementId] of FIELDS) {
    $(elementId).addEventListener('input', () => setDirty(true));
  }
  $('fieldPassword').addEventListener('input', () => setDirty(true));

  $('fieldStreamUrl').addEventListener('input', applyStreamHint);
  $('fieldControlUrl').addEventListener('input', applyStreamHint);
}

async function main() {
  wire();
  try {
    await load();
  } catch (error) {
    reportError(error);
  }
}

void main();
