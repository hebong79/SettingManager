import { api } from './api.js';

/**
 * 옵션 화면의 **커미셔닝 DB 탭** — place_info · camera_info · preset_info.
 *
 * `options.js` 와 파일을 나눈 이유는 다루는 정본이 다르기 때문이다. 그쪽은 `config.json`
 * (접속 정보), 이쪽은 SQLite(분류·커미셔닝). 한 파일에 섞으면 "이 값을 고치면 어디가
 * 바뀌는가"를 코드에서 읽어 낼 수 없다.
 *
 * **카메라의 접속 정보는 이 탭에 없다.** 그 주인은 config 이고 「서비스 설정」 탭이 담당한다
 * (주인 표는 `src/db/cameraSync.ts`).
 */

const $ = (id) => document.getElementById(id);

/** 장소 목록은 세 탭이 함께 쓴다 — 카메라·프리셋의 place_id 콤보를 이걸로 그린다. */
let places = [];
let toast = () => {};
let reportError = () => {};

function td(value) {
  const cell = document.createElement('td');
  cell.textContent = value === null || value === undefined ? '' : String(value);
  cell.title = cell.textContent;
  return cell;
}

/** 빈 표는 "아직 없다"고 말한다 — 머리만 남은 표는 고장으로 보인다. */
function emptyRow(body, columns, message) {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = columns;
  cell.className = 'muted';
  cell.style.whiteSpace = 'normal';
  cell.textContent = message;
  row.append(cell);
  body.append(row);
}

function actionCell(...buttons) {
  const cell = document.createElement('td');
  cell.className = 'actions';
  for (const item of buttons) cell.append(item);
  return cell;
}

function makeButton(label, onClick) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.addEventListener('click', () => void onClick());
  return element;
}

/** 값이 **실제로 바뀔 때만** 저장을 부른다 — 포커스만 스쳐도 쓰기가 나가면 안 된다. */
function editableCell(value, onCommit, type = 'text') {
  const cell = document.createElement('td');
  const input = document.createElement('input');
  input.type = type;
  input.value = value === null || value === undefined ? '' : String(value);
  const initial = input.value;
  input.addEventListener('change', () => {
    if (input.value === initial) return;
    void onCommit(input.value);
  });
  cell.append(input);
  return cell;
}

function selectCell(options, current, onCommit) {
  const cell = document.createElement('td');
  const select = document.createElement('select');
  for (const option of options) {
    const element = document.createElement('option');
    element.value = String(option.value);
    element.textContent = option.label;
    select.append(element);
  }
  select.value = String(current);
  select.addEventListener('change', () => void onCommit(select.value));
  cell.append(select);
  return cell;
}

const placeOptions = () => places.map((place) => ({ value: place.place_id, label: `${place.place_id} · ${place.place_name}` }));

async function guard(work) {
  try {
    await work();
  } catch (error) {
    reportError(error);
  }
}

// --- 장소 -------------------------------------------------------------------

async function loadPlaces() {
  places = (await api.dbPlaces()).places;
  const body = document.querySelector('#placeTable tbody');
  body.replaceChildren();
  for (const place of places) {
    const row = document.createElement('tr');
    row.append(td(place.place_id));
    row.append(editableCell(place.place_name, (name) => guard(async () => {
      await api.dbRenamePlace(place.place_id, name);
      toast(`장소 ${place.place_id} 이름 변경`, 'ok');
      await loadAll();
    })));
    row.append(actionCell(makeButton('삭제', () => guard(async () => {
      if (!confirm(`장소 ${place.place_id}(${place.place_name}) 를 지울까요?`)) return;
      await api.dbRemovePlace(place.place_id);
      toast(`장소 ${place.place_id} 삭제`, 'ok');
      await loadAll();
    }))));
    body.append(row);
  }
  if (places.length === 0) emptyRow(body, 3, '장소가 없습니다. 아래에서 추가하십시오.');
  $('placeCount').textContent = `${places.length}곳`;
}

// --- 카메라 (정본) -----------------------------------------------------------
//
// `config.json` 에 있던 「기기」·「기기 편집」 카드가 통째로 이리로 왔다. 카메라의 정본이
// `camera_info` 로 옮겨졌기 때문이고, 편집 화면이 두 곳에 있으면 어느 쪽이 이겼는지
// 사람이 알 수 없다.
//
// 서버는 쓰기 뒤에 `configStore.reloadCameras()` 를 부른다 — 그래야 다음 PTZ 명령이
// 방금 바꾼 주소로 나간다. 화면은 그걸 믿고 저장 후 목록만 다시 읽는다.

let cameras = [];
let selectedCamId = null;
let dirty = false;

const FIELDS = [
  ['camName', 'cam_name'],
  ['camUrl', 'url'],
  ['camUser', 'user_id'],
  ['camRtsp', 'rtsp_url'],
  ['camTimeout', 'timeout_ms'],
  ['camPark3d', 'park3d_cam_id'],
];

const selected = () => cameras.find((camera) => camera.cam_id === selectedCamId) ?? null;

function setDirty(value) {
  dirty = value;
  $('camApply').classList.toggle('primary', value || true);
}

/**
 * 영상 URL 이 어느 경로로 갈지 · 포트짝이 맞는지 알려 준다. 종류마다 규칙이 다르다.
 *
 * hucoms·backend-core — UE 시뮬 직결이라 **영상 = 제어 + 10**. 짝이 어긋나면 PTZ 숫자는 바뀌는데 그림은 그대로다.
 *
 * park3d-rpc — 제어는 **RPC 서버 하나**(실측 13510), 영상은 **카메라마다 다른 포트 = 13600 + camId**
 * (13601~13650). 스트림 포트는 경로를 보지 않고 무조건 MJPEG 를 돌려주므로, 제어 URL 에 스트림 포트를
 * 적어도 404 가 나지 않고 "RPC 응답을 해석할 수 없습니다" 로만 드러난다 — 연결은 되는데 PTZ 만 안 먹는
 * 꼴이라 원인을 짚기 어렵다. 그래서 화면에서 미리 잡는다.
 *
 * 최상위 순수 함수로 둔 이유: 테스트가 본문만 떼어 내 **실제로 평가**한다 —
 * 문자열 존재 확인만으로는 조건이 뒤집혀 있어도 통과한다. 같은 이유로 포트 상수도 **함수 안**에 둔다
 * (바깥에 두면 떼어 낸 본문이 참조하지 못해 죽는다).
 */
function portPairWarning(controlUrl, streamUrl, kind, camId) {
  if (!/^https?:\/\//i.test(streamUrl) || !/^https?:\/\//i.test(controlUrl)) return '';
  let controlPort = 0;
  let streamPort = 0;
  try {
    controlPort = Number(new URL(controlUrl).port);
    streamPort = Number(new URL(streamUrl).port);
  } catch {
    return '';   // URL 이 아직 덜 적힌 상태다 — 경고하지 않는다
  }
  if (!controlPort || !streamPort) return '';

  if (kind === 'park3d-rpc') {
    const STREAM_PORT_BASE = 13600;
    const STREAM_PORT_LAST = 13650;
    // 제어 칸에 영상 포트를 적는 사고가 가장 흔하고 가장 안 보인다 — 이쪽을 먼저 본다.
    if (controlPort > STREAM_PORT_BASE && controlPort <= STREAM_PORT_LAST) {
      return ` ⚠ ${controlPort} 은 영상 포트입니다 — 제어 URL 에는 RPC 서버 포트(예: 13510)를 적으십시오`;
    }
    const camNumber = Number(camId);
    if (!Number.isInteger(camNumber) || camNumber < 1) return '';   // camId 를 아직 안 적었다
    const expected = STREAM_PORT_BASE + camNumber;
    if (streamPort === expected) return '';
    return ` ⚠ camId ${camNumber} 의 영상 포트는 ${expected} 입니다 — 지금 ${streamPort} 는 다른 카메라를 봅니다`;
  }

  if (streamPort === controlPort + 10) return '';
  return ` ⚠ 제어 ${controlPort} 의 영상 포트는 ${controlPort + 10} 입니다 — 지금 ${streamPort} 는 다른 카메라를 볼 수 있습니다`;
}

/** 영상 URL 이 어느 경로로 갈지 + 포트짝 경고. */
function streamHint() {
  const raw = $('camRtsp').value.trim();
  // 저장된 행이 아니라 **화면의 지금 값**을 본다 — 종류·camId 를 바꾸는 즉시 경고가 따라와야 하고,
  // `draft()` 가 저장하는 값과도 같은 출처여야 힌트가 거짓말을 하지 않는다.
  const kind = $('camKind').value;

  let route = '비움 → 스냅샷 폴링';
  if (/^rtsps?:\/\//i.test(raw)) route = 'rtsp:// → ffmpeg 전사';
  else if (/^https?:\/\//i.test(raw)) {
    route = kind === 'park3d-rpc'
      ? 'http:// → MJPEG 중계 (Park3D 영상은 카메라별 포트 13600 + camId 입니다 — 제어는 RPC 서버 하나)'
      : 'http:// → MJPEG 중계 (UE 시뮬 직결 포트 = 제어 포트 + 10)';
  }
  $('camStreamHint').textContent =
    route + portPairWarning($('camUrl').value.trim(), raw, kind, $('camPark3d').value.trim());
}

function renderEditor() {
  const camera = selected();
  // 저장된 비밀번호는 **되돌려받지 않는다**(서버가 `hasPassword` 만 준다). 있다는 사실만
  // `****` 로 보이고, 칸 자체는 비어 있다 — 값을 채워 두면 저장할 때 그 별표가 그대로 나간다.
  $('camPasswordNote').textContent = camera?.hasPassword ? ' (저장됨 · 변경 시에만 입력)' : ' (없음)';
  $('camPassword').placeholder = camera?.hasPassword ? '****' : '(없음)';
  $('camPassword').value = '';
  applyPasswordClear(false);
  $('camTestResult').textContent = '';
  if (!camera) {
    for (const [elementId] of FIELDS) $(elementId).value = '';
    $('camInsecureTls').checked = false;
    $('camStreamHint').textContent = '';
    return;
  }
  for (const [elementId, key] of FIELDS) {
    $(elementId).value = camera[key] === null || camera[key] === undefined ? '' : String(camera[key]);
  }
  $('camKind').value = camera.kind;
  $('camType').value = camera.cam_type;
  // DB 는 0/1 로 담는다(SQLite 에 boolean 이 없다). `park3d_cam_id` 와 같이 idis 가 아닌
  // 기기에서도 칸은 보이되 뜻이 없다 — 드라이버가 idis 일 때만 이 값을 읽는다.
  $('camInsecureTls').checked = Boolean(camera.insecure_tls);
  $('camIntrinsics').value = camera.intrinsics ?? '';
  $('camPlace').replaceChildren();
  for (const place of places) {
    const option = document.createElement('option');
    option.value = String(place.place_id);
    option.textContent = `${place.place_id} · ${place.place_name}`;
    $('camPlace').append(option);
  }
  $('camPlace').value = String(camera.place_id);
  streamHint();
  setDirty(false);
}

/** 「삭제」를 켜면 입력칸을 잠근다 — 지우면서 동시에 새 값을 넣는 뜻은 없다. */
function applyPasswordClear(checked) {
  $('camPasswordClear').checked = checked;
  $('camPassword').disabled = checked;
  if (checked) $('camPassword').value = '';
}

/** 화면의 지금 값. 저장과 연결 테스트가 **같은 것**을 쓴다 — 다르면 시험이 거짓말이 된다. */
function draft() {
  const patch = {
    cam_name: $('camName').value.trim(),
    kind: $('camKind').value,
    cam_type: $('camType').value,
    url: $('camUrl').value.trim(),
    user_id: $('camUser').value.trim(),
    rtsp_url: $('camRtsp').value.trim(),
    place_id: Number($('camPlace').value),
    timeout_ms: Number($('camTimeout').value) || 5000,
    park3d_cam_id: $('camPark3d').value.trim() === '' ? null : Number($('camPark3d').value),
    insecure_tls: $('camInsecureTls').checked,
    intrinsics: $('camIntrinsics').value.trim() === '' ? null : $('camIntrinsics').value.trim(),
  };
  // 비밀번호는 세 갈래로 나간다 — 서버의 규칙과 같아야 한다.
  //   안 보냄  → 기존 값 유지 (이름만 고치는 저장이 자격증명을 지우면 안 된다)
  //   null    → 지움 (「비밀번호 삭제」를 켠 경우. 빈 문자열로는 이 뜻을 낼 수 없다)
  //   문자열   → 바꿈
  const password = $('camPassword').value;
  if ($('camPasswordClear').checked) patch.password = null;
  else if (password) patch.password = password;
  return patch;
}

async function loadCameras() {
  cameras = (await api.dbCameras()).cameras;
  const select = $('camSelect');
  select.replaceChildren();
  for (const camera of cameras) {
    const option = document.createElement('option');
    option.value = String(camera.cam_id);
    option.textContent = `${camera.cam_uuid} · ${camera.cam_name}`;
    select.append(option);
  }
  if (!cameras.some((camera) => camera.cam_id === selectedCamId)) {
    selectedCamId = cameras[0]?.cam_id ?? null;
  }
  if (selectedCamId !== null) select.value = String(selectedCamId);
  $('dbCameraCount').textContent = `${cameras.length}대`;
  renderEditor();
  void refreshActiveNote();
}

/** 활성 기기는 config 가 주인이다 — 카메라 자체가 DB 로 가도 "지금 무엇을 보는가"는 운영 상태다. */
async function refreshActiveNote() {
  try {
    const active = (await api.cameras()).activeCameraId;
    const camera = selected();
    $('camActiveNote').textContent = camera && camera.cam_uuid === active ? '현재 활성 기기입니다' : `현재 활성: ${active}`;
  } catch {
    $('camActiveNote').textContent = '';
  }
}

function wireCameraTab() {
  $('camSelect').addEventListener('change', () => {
    if (dirty && !confirm('저장하지 않은 편집이 있습니다. 버리고 옮길까요?')) {
      $('camSelect').value = String(selectedCamId);
      return;
    }
    selectedCamId = Number($('camSelect').value);
    renderEditor();
    void refreshActiveNote();
  });

  for (const [elementId] of FIELDS) $(elementId).addEventListener('input', () => setDirty(true));
  for (const elementId of ['camKind', 'camType', 'camPlace', 'camIntrinsics', 'camPassword', 'camPasswordClear', 'camInsecureTls']) {
    $(elementId).addEventListener('input', () => setDirty(true));
    $(elementId).addEventListener('change', () => setDirty(true));
  }
  $('camPasswordClear').addEventListener('change', () => applyPasswordClear($('camPasswordClear').checked));
  $('camRtsp').addEventListener('input', streamHint);
  $('camUrl').addEventListener('input', streamHint);
  $('camKind').addEventListener('change', streamHint);
  $('camPark3d').addEventListener('input', streamHint);   // camId 가 영상 포트를 정한다 — 고치면 경고도 다시 계산한다

  $('camApply').addEventListener('click', () => guard(async () => {
    const camera = selected();
    if (!camera) throw new Error('편집할 기기를 고르십시오');
    await api.dbSaveCamera(camera.cam_id, draft());
    toast(`${camera.cam_uuid} 저장`, 'ok');
    await loadCameras();
  }));

  $('camTest').addEventListener('click', () => guard(async () => {
    const camera = selected();
    if (!camera) throw new Error('시험할 기기를 고르십시오');
    $('camTestResult').textContent = '시험 중…';
    const result = await api.dbTestCamera(camera.cam_id, draft());
    $('camTestResult').textContent = result.ok
      ? `✅ 연결 성공 · ${result.elapsedMs}ms · PTZ P ${result.ptz.pan} / T ${result.ptz.tilt} / Z ${result.ptz.zoom}`
      : `❌ 연결 실패 · ${result.elapsedMs}ms · ${result.error}`;
  }));

  $('camRevert').addEventListener('click', () => renderEditor());

  $('camActivate').addEventListener('click', () => guard(async () => {
    const camera = selected();
    if (!camera) return;
    await api.setActiveCamera(camera.cam_uuid);
    toast(`활성 기기: ${camera.cam_uuid}`, 'ok');
    await refreshActiveNote();
  }));

  $('camDelete').addEventListener('click', () => guard(async () => {
    const camera = selected();
    if (!camera) return;
    if (!confirm(`${camera.cam_uuid} 를 지울까요?\n이 카메라의 프리셋·주차면이 함께 사라집니다.`)) return;
    const result = await api.dbRemoveCamera(camera.cam_id);
    selectedCamId = null;
    toast(`${result.cam_uuid} 삭제 — 프리셋 ${result.removedPresets}개 동반 삭제`, 'ok');
    await loadAll();
  }));

  $('camAdd').addEventListener('click', () => guard(async () => {
    const id = $('camNewId').value.trim();
    if (!id) throw new Error('새 기기 ID 를 입력하십시오');
    const result = await api.dbAddCamera({ cam_uuid: id, kind: $('camNewKind').value, label: id });
    $('camNewId').value = '';
    selectedCamId = result.camera.cam_id;
    toast(`${id} 추가 — 접속 정보를 채우고 「이 기기 적용」`, 'ok');
    await loadCameras();
  }));
}

// --- 프리셋 ------------------------------------------------------------------

async function loadPresets() {
  const presets = (await api.dbPresets()).presets;
  const body = document.querySelector('#dbPresetTable tbody');
  body.replaceChildren();
  for (const preset of presets) {
    // 경로는 **지금 있는 자리**를 가리킨다 — 본문이 열쇠를 바꾸더라도 찾아갈 곳은 옛 번호다.
    const save = (patch) => guard(async () => {
      const result = await api.dbSavePreset(preset.cam_id, preset.preset_id, patch);
      toast(result.movedSlots
        ? `프리셋 이동 — 주차면 ${result.movedSlots}개 함께 옮김`
        : `프리셋 p-${result.preset.preset_id} 저장`, 'ok');
      await loadPresets();
    });

    const row = document.createElement('tr');
    // 열쇠(preset_id·cam_id)도 고칠 수 있다. 서버가 주차면까지 한 덩어리로 옮긴다.
    row.append(editableCell(preset.preset_id, (value) => save({ preset_id: Number(value) }), 'number'));
    // cam_id 는 콤보다 — 없는 번호를 손으로 적으면 외래키에 막혀 저장이 통째로 실패한다.
    row.append(selectCell(
      cameras.map((camera) => ({ value: camera.cam_id, label: `${camera.cam_id} · ${camera.cam_uuid}` })),
      preset.cam_id,
      (value) => save({ cam_id: Number(value) }),
    ));
    row.append(editableCell(preset.preset_name, (value) => save({ preset_name: value })));
    // 한 축만 고쳐도 세 축을 함께 보낸다 — 서버의 pos 는 통째로 받는 값이다.
    for (const axis of ['pan', 'tilt', 'zoom']) {
      row.append(editableCell(preset[`pos_${axis}`], (value) => save({
        pos: { pan: preset.pos_pan, tilt: preset.pos_tilt, zoom: preset.pos_zoom, [axis]: Number(value) },
      }), 'number'));
    }
    row.append(selectCell(placeOptions(), preset.place_id, (value) => save({ place_id: Number(value) })));
    row.append(actionCell(makeButton('삭제', () => guard(async () => {
      if (!confirm(`프리셋 ${preset.preset_name}(cam ${preset.cam_id} · p-${preset.preset_id}) 을 지울까요?\n그 안의 주차면이 함께 사라집니다.`)) return;
      const result = await api.dbRemovePreset(preset.cam_id, preset.preset_id);
      toast(`프리셋 삭제 — 주차면 ${result.removedSlots}개 동반 삭제`, 'ok');
      await loadPresets();
    }))));
    body.append(row);
  }
  if (presets.length === 0) emptyRow(body, 8, '프리셋이 없습니다. 아래에서 추가하거나 카메라 제어 화면에서 만듭니다.');
  $('dbPresetCount').textContent = `${presets.length}개`;
}

// --- 조립 --------------------------------------------------------------------

/** 장소를 **먼저** 읽는다 — 카메라·프리셋의 장소 콤보가 그 목록으로 그려진다. */
async function loadAll() {
  await loadPlaces();
  await loadCameras();
  await loadPresets();
}

export function wireDbTabs(deps) {
  toast = deps.toast;
  reportError = deps.reportError;
  wireCameraTab();

  const tabs = $('optionTabs');
  tabs.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-panel]');
    if (!button) return;
    for (const other of tabs.querySelectorAll('button[data-panel]')) {
      other.classList.toggle('active', other === button);
      $(other.dataset.panel).hidden = other !== button;
    }
    // DB 탭으로 옮길 때마다 다시 읽는다 — 다른 창에서 커미셔닝이 진행 중일 수 있다.
    if (button.dataset.panel !== 'panelService') void guard(loadAll);
  });

  $('placeAdd').addEventListener('click', () => guard(async () => {
    const name = $('newPlaceName').value.trim();
    if (!name) throw new Error('장소 이름을 입력하세요');
    await api.dbSavePlace({ place_id: Number($('newPlaceId').value), place_name: name });
    $('newPlaceName').value = '';
    toast('장소 저장', 'ok');
    await loadAll();
  }));

  $('presetAdd').addEventListener('click', () => guard(async () => {
    const name = $('newPresetName').value.trim();
    if (!name) throw new Error('프리셋 이름을 입력하세요');
    const result = await api.dbAddPreset({
      cam_id: Number($('newPresetCam').value),
      preset_name: name,
      pos: {
        pan: Number($('newPresetPan').value),
        tilt: Number($('newPresetTilt').value),
        zoom: Number($('newPresetZoom').value),
      },
    });
    $('newPresetName').value = '';
    toast(`프리셋 p-${result.preset.preset_id} 추가`, 'ok');
    await loadPresets();
  }));
}
