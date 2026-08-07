import { api, reportError, toast } from './api.js';
import { drawSegments } from './vehicleBoxOverlay.js';

/**
 * 차량 3D 육면체 화면.
 *
 * **투영하지 않는다.** 사이드카가 `segments` 를 이미 이미지 좌표로 준다 — 받은 선분을 잇기만
 * 하면 되고, 그래서 이 화면은 마운트 높이·피치·롤을 알 필요가 없다(우리는 갖고 있지도 않다).
 */

const el = (id) => document.getElementById(id);
let cameraId = '';

async function loadCameras() {
  const { cameras, activeCameraId } = await api.cameras();
  el('cameraSelect').innerHTML = cameras.map((c) => `<option value="${c.id}">${c.label}</option>`).join('');
  cameraId = activeCameraId || cameras[0]?.id || '';
  el('cameraSelect').value = cameraId;
}

async function loadStatus() {
  const status = await api.vehicleBoxStatus(cameraId);
  const ready = status.configured && status.ready;
  el('capability').textContent = !status.configured ? '미설정' : ready ? '준비됨' : '준비 안 됨';
  el('capability').className = `tag ${ready ? 'ok' : 'warn'}`;
  // **꺼져 있다는 사실만으로는 손쓸 수 없다** — 무엇을 채워야 하는지까지 말한다.
  el('cameraNote').textContent = status.reason
    ?? (ready ? `모델 ${status.model ?? '-'} 로 답할 준비가 됐습니다.` : '사이드카가 아직 모델을 올리지 않았습니다 — 잠시 뒤 다시 시도하세요.');
  el('detect').disabled = !status.configured;
}

function renderDetections(detections) {
  el('detections').querySelector('tbody').innerHTML = detections.map((d, i) => `<tr>
    <td>${i + 1}</td><td>${d.label ?? '-'}</td><td>${fmt(d.score)}</td>
    <td>${vec(d.position_m)}</td><td>${vec(d.size_m)}</td><td>${fmt(d.yaw_deg)}</td>
    <td>${Array.isArray(d.segments) ? d.segments.length : 0}</td>
  </tr>`).join('') || '<tr><td colspan="7">검출된 차량이 없습니다.</td></tr>';
}

const fmt = (v) => (typeof v === 'number' ? v.toFixed(2) : '-');
const vec = (v) => (Array.isArray(v) ? v.map((n) => Number(n).toFixed(2)).join(', ') : '-');

async function detect() {
  el('detect').disabled = true;
  try {
    // 프레임을 먼저 걸어 둔다 — 검출 결과와 같은 순간일 수는 없지만, 오버레이가 얹힐 바탕이 필요하다.
    el('frame').src = `/api/snapshot?cameraId=${encodeURIComponent(cameraId)}&t=${Date.now()}`;
    el('placeholder').hidden = true;

    const result = await api.vehicleBoxDetect(cameraId);
    renderDetections(result.detections);
    el('calibration').textContent = result.calibration ? JSON.stringify(result.calibration, null, 2) : '사이드카가 캘리브레이션을 싣지 않았습니다.';
    drawSegments(el('overlay'), el('frame'), result.detections);
    toast(`${result.count}대 검출 (${result.latencyMs ?? '-'}ms)`, 'ok');
    await loadHistory();
  } catch (error) {
    reportError(error);
  } finally {
    el('detect').disabled = false;
  }
}

async function loadHistory() {
  const { records } = await api.vehicleBoxHistory(cameraId, 20);
  el('history').querySelector('tbody').innerHTML = records.map((r) => `<tr>
    <td>${r.detectId}</td><td>${r.capturedAt}</td><td>${r.count}</td>
    <td>${r.ptz ? `${r.ptz.pan}/${r.ptz.tilt}/${r.ptz.zoom}` : '-'}</td>
    <td>${r.model ?? '-'}</td><td>${r.latencyMs ?? '-'}</td>
  </tr>`).join('') || '<tr><td colspan="6">아직 없습니다.</td></tr>';
}

async function selectCamera() {
  cameraId = el('cameraSelect').value;
  el('overlay').getContext('2d')?.clearRect(0, 0, el('overlay').width, el('overlay').height);
  await Promise.all([loadStatus(), loadHistory()]);
}

el('cameraSelect').addEventListener('change', () => selectCamera().catch(reportError));
el('detect').addEventListener('click', detect);
el('frame').addEventListener('load', () => drawSegments(el('overlay'), el('frame')));

loadCameras().then(selectCamera).catch(reportError);
