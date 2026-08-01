const $ = (id) => document.getElementById(id);
let cameras = [], presets = [], points = [], activeCameraId = '', advanced = false, poller = 0, streaming = false;
const status = (message, error = false) => { const el = $('status'); el.textContent = message; el.className = `show ${error ? 'err' : 'ok'}`; clearTimeout(status.timer); status.timer = setTimeout(() => el.className = '', 4500); };
async function api(path, init) { const r = await fetch(path, { headers: init?.body ? {'content-type':'application/json'} : undefined, ...init }); const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`); return data; }
function selected(select, values) { $(select).replaceChildren(...values.map(v => new Option(v.name || v.label || v.id, v.id))); }
function currentPreset() { return presets.find(x => x.id === $('presetSelect').value); }
function currentPoint() { return points.find(x => x.id === $('pointSelect').value); }
function pointPayload() { const x = Number($('pointX').value), y = Number($('pointY').value); if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x, y는 숫자여야 합니다'); return { x, y }; }
async function loadPresets() { const data = await api('/api/discovery/presets'); presets = data.presets || []; selected('presetSelect', presets); await loadPoints(); }
async function loadPoints() { const p = currentPreset(); points = p ? (await api(`/api/discovery/presets/${encodeURIComponent(p.id)}/points`)).points || [] : []; selected('pointSelect', points); fillPoint(); }
function fillPoint() { const p = currentPoint(); $('pointX').value = p?.x ?? ''; $('pointY').value = p?.y ?? ''; }
async function poll() { if (!advanced) return; try { for (const [path,id] of [['/api/discovery/calibration/status','calibrationStatus'],['/api/discovery/plate-home/status','homeStatus']]) { const d=await api(path); $(id).textContent= d.status || (d.running ? 'running' : 'idle'); } } catch (e) { status(e.message, true); } }
function setAdvancedControlsDisabled(disabled) {
  for (const control of $('advanced').querySelectorAll('input, select, button')) {
    control.disabled = disabled || control.id === 'centerBox';
    if (control.disabled) control.title = control.id === 'centerBox' ? 'BackendCore discovery point는 box 좌표를 저장하지 않습니다' : '활성 BackendCore 카메라가 필요합니다';
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
async function refreshCameras() { stopStream(); const data = await api('/api/cameras'); cameras=data.cameras; activeCameraId=data.activeCameraId; selected('cameraSelect', cameras); $('cameraSelect').value=activeCameraId; setStreamControls(); await setCapability(); }
async function setCapability() {
  const c=cameras.find(x=>x.id===$('cameraSelect').value);
  const activeCamera=cameras.find(x=>x.id===activeCameraId);
  advanced=Boolean(c && c.id===activeCameraId && c.kind==='backend-core');
  clearInterval(poller); poller=0;
  setAdvancedControlsDisabled(!advanced);
  const note=$('cameraNote');
  if (advanced) {
    $('capability').textContent='BackendCore 사용 가능';
    note.className='capability-note ready';
    note.textContent='활성 BackendCore 카메라입니다. discovery 데이터와 자동 작업을 사용할 수 있습니다.';
    await loadPresets(); await poll(); poller=setInterval(poll,1500);
  } else {
    $('capability').textContent=c?.id !== activeCameraId ? '활성화 필요' : '사용 불가';
    note.className='capability-note';
    const selectedNeedsActivation=c?.kind==='backend-core' && c.id!==activeCameraId;
    note.innerHTML=selectedNeedsActivation
      ? '선택한 BackendCore 카메라는 아직 활성 카메라가 아닙니다. 먼저 <strong>활성으로 선택</strong>을 누르세요. 고급 작업은 활성 카메라에서만 실행됩니다.'
      : `현재 활성 카메라(${activeCamera?.label || activeCameraId || '없음'})가 BackendCore 경유가 아니므로 고급 작업을 실행할 수 없습니다. <a href="/options">/options</a>에서 기기를 추가하거나 기존 기기의 타입을 backend-core로 바꾸고 제어 URL 또는 시뮬레이터 BackendCore URL을 설정한 뒤, 이 화면에서 해당 기기를 활성으로 선택하세요.`;
  }
}
function bind(id, fn) { $(id).addEventListener('click', () => fn().catch(e => status(e.message, true))); }
$('cameraSelect').addEventListener('change', () => { stopStream(); setCapability().catch(e=>status(e.message,true)); }); $('presetSelect').addEventListener('change',()=>loadPoints().catch(e=>status(e.message,true))); $('pointSelect').addEventListener('change',fillPoint);
bind('streamStart', async()=>{ startStream(); }); bind('streamStop', async()=>{ stopStream(); }); bind('snapshotOnce', async()=>{ snapshotOnce(); });
bind('activateCamera', async()=>{ await api('/api/cameras/active',{method:'POST',body:JSON.stringify({id:$('cameraSelect').value})}); await refreshCameras(); status('활성 카메라를 변경했습니다'); });
bind('presetCreate',async()=>{ const name=$('presetName').value.trim(); if(!name) throw Error('프리셋 이름을 입력하세요'); const current=await api('/api/ptz'); await api('/api/discovery/presets',{method:'POST',body:JSON.stringify({name,ptz:current.ptz})}); await loadPresets(); }); bind('presetUpdate',async()=>{ const p=currentPreset(); if(!p) throw Error('프리셋을 선택하세요'); await api(`/api/discovery/presets/${encodeURIComponent(p.id)}`,{method:'PUT',body:JSON.stringify({name:$('presetName').value.trim()})}); await loadPresets(); }); bind('presetDelete',async()=>{ const p=currentPreset(); if(!p) throw Error('프리셋을 선택하세요'); await api(`/api/discovery/presets/${encodeURIComponent(p.id)}`,{method:'DELETE'}); await loadPresets(); }); bind('presetGoto',async()=>{const p=currentPreset();if(!p)throw Error('프리셋을 선택하세요');await api(`/api/discovery/presets/${encodeURIComponent(p.id)}/goto`,{method:'POST'});status('프리셋 이동 요청 완료');});
for (const [id,method] of [['pointCreate','POST'],['pointUpdate','PUT'],['pointDelete','DELETE']]) bind(id,async()=>{const p=currentPreset(), q=currentPoint();if(!p)throw Error('프리셋을 선택하세요');if(method!=='POST'&&!q)throw Error('점을 선택하세요');const pointId=method==='POST'?undefined:q.id;await api(`/api/discovery/presets/${encodeURIComponent(p.id)}/points${pointId?`/${encodeURIComponent(pointId)}`:''}`,{method,body:method==='DELETE'?undefined:JSON.stringify(pointPayload())});await loadPoints();});
bind('center',async()=>{const p=currentPoint();if(!p)throw Error('점을 선택하세요');await api('/api/center',{method:'POST',body:JSON.stringify({x:p.x,y:p.y})});status('개별 센터 요청 완료');});
bind('calibrationStart',async()=>{await api('/api/discovery/calibration/start',{method:'POST',body:JSON.stringify({mode:$('calibrationMode').value})});await poll();}); bind('calibrationStop',async()=>{await api('/api/discovery/calibration/stop',{method:'POST'});await poll();}); bind('homeStart',async()=>{const p=currentPreset(),q=currentPoint();if(!p)throw Error('프리셋을 선택하세요');await api('/api/discovery/plate-home/start',{method:'POST',body:JSON.stringify({presetId:p.id,pointIds:q?[q.id]:undefined})});await poll();}); bind('homeStop',async()=>{await api('/api/discovery/plate-home/stop',{method:'POST'});await poll();}); bind('tour',async()=>{await api('/api/vla/tour',{method:'POST',body:JSON.stringify({zoomIn:false,saveSpots:false})});status('VLA 투어 요청 완료');});
refreshCameras().catch(e=>status(e.message,true));
addEventListener('pagehide', () => { stopStream(); clearInterval(poller); poller=0; });
