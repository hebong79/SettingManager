import { streamPointFromPointer } from './streamCentering.js';

const $ = (id) => document.getElementById(id);
let cameras = [], presets = [], points = [], activeCameraId = '', advanced = false, poller = 0, streaming = false, centering = false;
const status = (message, error = false) => { const el = $('status'); el.textContent = message; el.className = `show ${error ? 'err' : 'ok'}`; clearTimeout(status.timer); status.timer = setTimeout(() => el.className = '', 4500); };
// 경로는 언제나 하나다. 어느 코어 구현이 답하는지는 서버가 설정으로 정하고 화면은 모른다.
async function api(path, init) { const r = await fetch(path, { headers: init?.body ? {'content-type':'application/json'} : undefined, ...init }); const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`); return data; }
function selected(select, values) { $(select).replaceChildren(...values.map(v => new Option(v.name || v.label || v.id, v.id))); }
function currentPreset() { return presets.find(x => x.id === $('presetSelect').value); }
function currentPoint() { return points.find(x => x.id === $('pointSelect').value); }
function pointPayload() { const x = Number($('pointX').value), y = Number($('pointY').value); if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x, y는 숫자여야 합니다'); return { x, y }; }
async function loadPresets() { const data = await api('/api/core/discovery/presets'); presets = data.presets || []; selected('presetSelect', presets); await loadPoints(); }
async function loadPoints() { const p = currentPreset(); points = p ? (await api(`/api/core/discovery/presets/${encodeURIComponent(p.id)}/points`)).points || [] : []; selected('pointSelect', points); fillPoint(); }
function fillPoint() { const p = currentPoint(); $('pointX').value = p?.x ?? ''; $('pointY').value = p?.y ?? ''; }
async function poll() { if (!advanced) return; try { for (const [path,id] of [['/api/core/calibration/status','calibrationStatus'],['/api/core/plate-homing/status','homeStatus']]) { const d=await api(path); $(id).textContent= d.status || (d.running ? 'running' : 'idle'); } } catch (e) { status(e.message, true); } }
function setAdvancedControlsDisabled(disabled, supported) {
  const NEEDS = { centerBox: 'centerBox', center: 'center', calibrationStart: 'calibration', calibrationStop: 'calibration', homeStart: 'plateHoming', homeStop: 'plateHoming' };
  for (const control of $('advanced').querySelectorAll('input, select, button')) {
    const capability = NEEDS[control.id];
    const state = capability ? supported?.[capability] : undefined;
    control.disabled = disabled || (capability ? !state?.ok : false);
    if (control.disabled) control.title = state?.reason ?? '현재 코어가 이 기능을 지원하지 않습니다';
    else control.removeAttribute('title');
  }
}
function selectedCameraId() { return $('cameraSelect').value; }
function hasSelectedCamera() { return cameras.some(camera => camera.id === selectedCameraId()); }
function setStreamControls() {
  const available = hasSelectedCamera();
  $('streamStart').disabled = !available || streaming;
  $('streamStop').disabled = !streaming;
  $('snapshotOnce').disabled = !available;
}
function stopStream() {
  const image = $('stream');
  streaming = false;
  image.onerror = null;
  image.removeAttribute('src');
  image.classList.remove('live');
  $('streamPlaceholder').style.display = '';
  $('streamTag').textContent = '정지';
  $('discoveryStreamClickMarker').hidden = true;
  setStreamControls();
}
function streamError() {
  stopStream();
  status('영상을 불러오지 못했습니다. 카메라 영상 URL 또는 BackendCore 연결을 확인하세요.', true);
}
function startStream() {
  const cameraId = selectedCameraId();
  if (!cameraId) return;
  stopStream();
  const image = $('stream');
  streaming = true;
  image.onerror = streamError;
  image.src = `/api/stream?cameraId=${encodeURIComponent(cameraId)}&t=${Date.now()}`;
  image.classList.add('live');
  $('streamPlaceholder').style.display = 'none';
  $('streamTag').textContent = '수신 중';
  setStreamControls();
}
function snapshotOnce() {
  const cameraId = selectedCameraId();
  if (!cameraId) return;
  stopStream();
  const image = $('stream');
  streaming = false;
  image.onerror = streamError;
  image.src = `/api/snapshot?cameraId=${encodeURIComponent(cameraId)}&t=${Date.now()}`;
  image.classList.add('live');
  $('streamPlaceholder').style.display = 'none';
  $('streamTag').textContent = '스냅샷';
  setStreamControls();
}
function streamPointFromClick(event) {
  const image = $('stream');
  if (!image.classList.contains('live')) return null;
  return streamPointFromPointer({
    button: event.button,
    clientX: event.clientX,
    clientY: event.clientY,
    viewport: $('discoveryStreamViewport').getBoundingClientRect(),
    image: image.getBoundingClientRect(),
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
  });
}
async function centerStreamClick(event) {
  if (centering) return;
  const point = streamPointFromClick(event);
  if (!point) return;
  const cameraId = $('cameraSelect').value;
  if (!cameraId) return status('센터링할 카메라를 선택하세요.', true);
  const marker = $('discoveryStreamClickMarker');
  marker.hidden = true;
  centering = true;
  $('discoveryStreamViewport').classList.add('centering');
  try {
    const result = await api('/api/core/center',{method:'POST',body:JSON.stringify({cameraId,x:point.x,y:point.y})});
    marker.style.left = '50%';
    marker.style.top = '50%';
    marker.hidden = false;
    status(`클릭 지점을 화면 중앙으로 이동했습니다 (코어: ${result.provider ?? '-'}).`);
  } catch (e) {
    status(e.message, true);
  } finally {
    centering = false;
    $('discoveryStreamViewport').classList.remove('centering');
  }
}
async function refreshCameras() { stopStream(); const data = await api('/api/cameras'); cameras=data.cameras; activeCameraId=data.activeCameraId; selected('cameraSelect', cameras); $('cameraSelect').value=activeCameraId; setStreamControls(); await setCapability(); }
async function setCapability() {
  const c=cameras.find(x=>x.id===$('cameraSelect').value);
  clearInterval(poller); poller=0;
  const note=$('cameraNote');
  if (!c) { advanced=false; setAdvancedControlsDisabled(true); $('capability').textContent='선택 필요'; note.className='capability-note'; note.textContent='카메라를 선택하세요.'; return; }
  let capabilities;
  try { capabilities = await api(`/api/core/capabilities?cameraId=${encodeURIComponent(c.id)}`); }
  catch (e) { advanced=false; setAdvancedControlsDisabled(true); $('capability').textContent='조회 실패'; note.className='capability-note'; note.textContent=e.message; return; }
  // 화면은 구현 이름으로 분기하지 않는다 — 무엇을 할 수 있는지만 본다.
  advanced = Boolean(capabilities.supported?.discoveryPresets?.ok);
  setAdvancedControlsDisabled(!advanced, capabilities.supported);
  $('capability').textContent = `코어: ${capabilities.provider}`;
  if (advanced) {
    note.className='capability-note ready';
    note.textContent=`${capabilities.provider} 코어가 탐색 데이터와 자동 작업을 제공합니다.`;
    await loadPresets(); await poll(); poller=setInterval(poll,1500);
  } else {
    note.className='capability-note';
    note.innerHTML=`현재 코어(<strong>${capabilities.provider}</strong>)는 주차면 탐색을 지원하지 않습니다: ${capabilities.supported?.discoveryPresets?.reason ?? '사유 없음'}<br><a href="/options">/options</a> 에서 코어 구현을 바꿀 수 있습니다.`;
  }
}
function bind(id, fn) { $(id).addEventListener('click', () => fn().catch(e => status(e.message, true))); }
$('cameraSelect').addEventListener('change', () => { stopStream(); setCapability().catch(e=>status(e.message,true)); }); $('presetSelect').addEventListener('change',()=>loadPoints().catch(e=>status(e.message,true))); $('pointSelect').addEventListener('change',fillPoint);
bind('streamStart', async()=>{ startStream(); }); bind('streamStop', async()=>{ stopStream(); }); bind('snapshotOnce', async()=>{ snapshotOnce(); });
$('discoveryStreamViewport').addEventListener('mousedown', (event) => void centerStreamClick(event));
bind('activateCamera', async()=>{ await api('/api/cameras/active',{method:'POST',body:JSON.stringify({id:$('cameraSelect').value})}); await refreshCameras(); status('활성 카메라를 변경했습니다'); });
bind('presetCreate',async()=>{ const name=$('presetName').value.trim(); if(!name) throw Error('프리셋 이름을 입력하세요'); const current=await api('/api/ptz'); await api('/api/core/discovery/presets',{method:'POST',body:JSON.stringify({name,ptz:current.ptz})}); await loadPresets(); }); bind('presetUpdate',async()=>{ const p=currentPreset(); if(!p) throw Error('프리셋을 선택하세요'); await api(`/api/core/discovery/presets/${encodeURIComponent(p.id)}`,{method:'PUT',body:JSON.stringify({name:$('presetName').value.trim()})}); await loadPresets(); }); bind('presetDelete',async()=>{ const p=currentPreset(); if(!p) throw Error('프리셋을 선택하세요'); await api(`/api/core/discovery/presets/${encodeURIComponent(p.id)}`,{method:'DELETE'}); await loadPresets(); }); bind('presetGoto',async()=>{const p=currentPreset();if(!p)throw Error('프리셋을 선택하세요');await api(`/api/core/discovery/presets/${encodeURIComponent(p.id)}/goto`,{method:'POST'});status('프리셋 이동 요청 완료');});
for (const [id,method] of [['pointCreate','POST'],['pointUpdate','PUT'],['pointDelete','DELETE']]) bind(id,async()=>{const p=currentPreset(), q=currentPoint();if(!p)throw Error('프리셋을 선택하세요');if(method!=='POST'&&!q)throw Error('점을 선택하세요');const pointId=method==='POST'?undefined:q.id;await api(`/api/core/discovery/presets/${encodeURIComponent(p.id)}/points${pointId?`/${encodeURIComponent(pointId)}`:''}`,{method,body:method==='DELETE'?undefined:JSON.stringify(pointPayload())});await loadPoints();});
bind('center',async()=>{const p=currentPoint();if(!p)throw Error('점을 선택하세요');await api('/api/core/center',{method:'POST',body:JSON.stringify({x:p.x,y:p.y})});status('개별 센터 요청 완료');});
bind('calibrationStart',async()=>{await api('/api/core/calibration/start',{method:'POST',body:JSON.stringify({mode:$('calibrationMode').value})});await poll();}); bind('calibrationStop',async()=>{await api('/api/core/calibration/stop',{method:'POST'});await poll();}); bind('homeStart',async()=>{const p=currentPreset(),q=currentPoint();if(!p)throw Error('프리셋을 선택하세요');await api('/api/core/plate-homing/start',{method:'POST',body:JSON.stringify({presetId:p.id,pointIds:q?[q.id]:undefined})});await poll();}); bind('homeStop',async()=>{await api('/api/core/plate-homing/stop',{method:'POST'});await poll();});
refreshCameras().catch(e=>status(e.message,true));
addEventListener('pagehide', () => { stopStream(); clearInterval(poller); poller=0; });
