import { api, reportError, toast } from './api.js';
import { streamPointFromPointer } from './streamCentering.js';
import { createPresetPanel } from './simtoolPreset.js';
import { createCarPanel } from './simtoolCar.js';
import { createCamPanel } from './simtoolCam.js';
import { createMeasurePanel } from './simtoolMeasure.js';
import { createViewControl } from './simtoolViewControl.js';

/**
 * 시뮬레이터 툴의 **껍데기**. 연결·탭·영상만 소유한다.
 *
 * ## 카메라 설정도 DB 도 쓰지 않는다 (지시 7)
 *
 * 이 화면이 부르는 것은 `/api/sim/*` 뿐이다. SettingManager 에 카메라가 한 대도 등록돼
 * 있지 않아도 시뮬레이터 툴은 돈다. 반대로 시뮬레이터가 꺼져 있어도 카메라 제어는 멀쩡하다.
 * 그 경계는 서버 쪽 `test/simIndependence.test.ts` 가 강제한다.
 *
 * ## PTZ 단위가 다르다
 *
 * 카메라 제어 화면은 정수 raw(pan 4710 = 47.1°)를 쓰지만, 여기는 시뮬레이터가 준
 * **도·배율 실수**(pan 47.1 · zoom 2.4)를 그대로 쓴다. 드라이버 계층을 지나지 않기 때문이다.
 * 환산을 두 곳에서 하면 반드시 어긋난다 — 한쪽만 고치는 날이 온다.
 *
 * ## 영상 소스만 `camera_info` 를 쓴다 (마스터 지시 2026-08-08)
 *
 * 툴 로직은 여전히 `/api/sim/*` 뿐이지만, **영상 소스 목록은 등록된 카메라**(`camera_info`)
 * 에서 온다. 이유가 둘이다:
 *
 *   ① 시뮬레이터 **메인 카메라**가 `simulator-99` 로 등록돼 있다(스트림 `13600`, basePort).
 *      `cam.list` 는 PTZ 카메라(13601+)만 알려주므로 메인 뷰가 목록에 안 나온다.
 *   ② 실카메라(rtsp)도 같은 목록에서 고를 수 있다 — 영상은 `/api/stream?cameraId=` 이
 *      전송을 알아서 고른다(rtsp→ffmpeg, http MJPEG→그대로 중계).
 *
 * **이것이 독립 경계의 유일한 예외다.** 서버 쪽 `src/sim/` 은 여전히 카메라·코어·DB 를
 * import 하지 않는다 — 화면이 영상 소스 하나를 더 물어볼 뿐이다.
 */

const el = (id) => document.getElementById(id);

/** 시뮬레이터 메인 카메라의 등록 id. 스트림이 basePort(13600)로 나온다. */
const MAIN_CAMERA_ID = 'simulator-99';

let rpcUrl = '';
let cameras = [];
/** 영상 소스 — `camera_info` 에 등록된 카메라들. 시뮬 RPC 카메라와 **다른 축**이다. */
let streamCameras = [];
let active = null;
let streaming = false;

/** 시뮬레이터 RPC 한 번. 오류는 서버가 준 한글 사유를 그대로 들고 온다. */
async function rpc(method, params = {}) {
  const data = await api.simRpc(method, params);
  return data.result;
}

/** 차량 프리팹 이름. 시뮬레이터가 주지 않아 서버가 `config/car_catalog.json` 을 읽어 준다. */
let carCatalog = null;

const ctx = {
  rpc,
  toast,
  reportError,
  async carCatalog() {
    carCatalog ??= await api.simCarCatalog();
    return carCatalog;
  },
  /**
   * `save/3D/{Preset,CarPos,CameraPos}` 의 저장 파일. **좌표는 서버가 RPC 계로 바꿔 준다** —
   * 화면이 두 좌표계를 동시에 들면 반드시 섞이고, 그 실패는 오류로 뜨지 않는다.
   */
  files: (kind) => api.simFiles(kind),
  file: (kind, name) => api.simFile(kind, name),
  parseFile: (kind, name, data) => api.simParseFile(kind, name, data),
  serializeFile: (kind, resultKey, rows) => api.simSerialize(kind, resultKey, rows),
  /** 지금 시뮬레이터가 아는 카메라 목록. 세 탭이 나눠 쓴다. */
  cameras: () => cameras,
  refreshCameras: loadCameras,
  connected: () => Boolean(rpcUrl),
};

/**
 * 메인 뷰 마우스 제어. **`view.*` 가 없는 시뮬레이터에서는 스스로 꺼진다**(`probe`) —
 * 신설 전 버전에 붙어도 나머지 기능은 멀쩡해야 한다.
 */
const viewControl = createViewControl({
  rpc,
  toast,
  reportError,
  image: () => el('simStream'),
});

const panels = [
  { id: 'panelPreset', panel: createPresetPanel(ctx) },
  { id: 'panelCar', panel: createCarPanel(ctx) },
  { id: 'panelCam', panel: createCamPanel(ctx) },
  { id: 'panelMeasure', panel: createMeasurePanel(ctx) },
  // 조명 탭은 언리얼에 light.* 가 없어 **화면을 만들지 않았다** — 정적 안내만 있다.
  { id: 'panelLight', panel: null },
];

// --- 연결 -----------------------------------------------------------------

async function loadSettings() {
  const settings = await api.settings();
  rpcUrl = settings.simTool?.rpcUrl ?? '';
  el('simUrl').value = rpcUrl;
}

/**
 * 연결 확인. **`system.health` 와 `system.catalog` 를 둘 다 본다** —
 * 살아 있다는 것과 우리가 기대하는 메서드를 갖고 있다는 것은 다른 질문이다.
 */
async function connect() {
  const tag = el('simTag');
  const note = el('simNote');
  if (!rpcUrl) {
    tag.textContent = '미설정';
    tag.className = 'tag warn';
    note.className = 'capability-note';
    note.textContent = 'RPC 주소가 비어 있습니다 — 주소를 넣고 「저장」을 누르세요.';
    setPanelsEnabled(false);
    cameras = [];
    updateClickNote();
    return;
  }
  tag.textContent = '확인 중';
  tag.className = 'tag';
  try {
    const [health, catalog, allowed] = await Promise.all([
      rpc('system.health'),
      rpc('system.catalog'),
      api.simCatalog(),
    ]);
    const have = new Set(catalog.methods ?? []);
    // **우리가 부를 것 중 서버에 없는 것**을 화면이 먼저 말한다. 눌러 본 뒤에 501 을
    // 보는 것보다 낫고, 시뮬레이터 버전이 뒤처졌을 때 무엇이 빠졌는지 바로 보인다.
    const missing = allowed.methods.filter((entry) => !have.has(entry.method)).map((entry) => entry.method);
    // **등록 ≠ 동작.** `system.catalog` 는 등록 여부만 알려주므로, 호출하면 실패하는 것들은
    // 우리 카탈로그가 따로 알고 있다 — 그 수를 함께 보여 준다.
    const dead = allowed.methods.filter((entry) => entry.unimplemented).length;
    tag.textContent = `연결됨 · ${have.size} method`;
    tag.className = 'tag ok';
    note.className = 'capability-note ready';
    note.innerHTML = missing.length
      ? `포트 ${health.port} 에 연결됐지만 이 화면이 쓰는 메서드 ${missing.length}개가 서버에 없습니다: <code>${missing.join('</code> <code>')}</code>`
      : `포트 ${health.port} · 이 화면이 쓰는 메서드가 전부 등록돼 있습니다.`
        + (dead ? ` 그중 <strong>${dead}개는 등록만 되고 동작하지 않습니다</strong> — 해당 기능은 화면에서 빼거나 대체 경로를 씁니다.` : '');
    setPanelsEnabled(true);
    // **카메라 목록보다 먼저** 묻는다 — 목록 로딩이 클릭·시점 안내를 다시 그리는데,
    // 그때 `view.*` 가 있는지 이미 알고 있어야 안내가 한 번에 맞는 말을 한다.
    await viewControl.probe();
    await loadCameras();
    await active?.panel?.onConnect?.();
  } catch (error) {
    tag.textContent = '연결 실패';
    tag.className = 'tag warn';
    note.className = 'capability-note';
    note.textContent = error.message;
    setPanelsEnabled(false);
    // 연결이 끊기면 자세를 물을 수 없다 — 클릭 안내가 「된다」고 남아 있으면 안 된다.
    cameras = [];
    updateClickNote();
  }
}

/**
 * 시뮬레이터가 필요한 조작만 잠근다.
 *
 * **프리셋 메이커의 파일·편집 부분은 잠그지 않는다** — 새로 만들기·열기·저장·추가/수정/삭제는
 * 이 PC 안에서 끝나는 일이라, 시뮬레이터가 꺼져 있다고 못 하게 막을 이유가 없다.
 * 잠기는 것은 시뮬레이터를 실제로 두드리는 버튼들이다.
 */
const OFFLINE_OK = new Set([
  // 프리셋 메이커
  'spNew', 'spOpen', 'spOpenInput', 'spSave', 'spAdd', 'spUpdate', 'spDelete', 'spList',
  'spIdx', 'spName', 'spFaceCount', 'spCamIdx', 'spOffsetX', 'spOffsetY', 'spOffsetZ',
  'spGroupRot', 'spFaceRot', 'spXSize', 'spZSize', 'spDirType', 'spBaseWidth', 'spStep',
  'spModeMove', 'spModeRotate',
  // 차량 배치
  'carNew', 'carOpen', 'carOpenInput', 'carSave', 'carAdd', 'carUpdate', 'carDelete', 'carList',
  'carPrefab', 'carType', 'carPresetId', 'carCount', 'carSpacing', 'carVertical',
  'carX', 'carY', 'carZ', 'carSelId', 'carSelPreset', 'carSelFace', 'carSelRotY', 'carFront', 'carBack',
  // 카메라 컨트롤 — 파일 쪽만
  'kNew', 'kOpen', 'kOpenInput', 'kSave', 'kAdd', 'kUpdate', 'kDelete', 'kList',
  'kName', 'kCamId', 'kPresetId', 'kPosX', 'kPosY', 'kPosZ', 'kPan', 'kTilt', 'kZoom',
]);

function setPanelsEnabled(enabled) {
  for (const entry of panels) {
    if (entry.id === 'panelLight') continue;
    for (const control of el(entry.id).querySelectorAll('input, select, button')) {
      control.disabled = !enabled && !OFFLINE_OK.has(control.id);
    }
  }
  // **영상은 시뮬 RPC 와 무관하다** — 등록된 카메라에서 바로 받으므로 연결 실패에도 잠그지 않는다.
  el('simStreamStart').disabled = streaming || !el('simStreamCam').value;
  el('simStreamStop').disabled = !streaming;
}

// --- 카메라 · 영상 ---------------------------------------------------------

/**
 * 시뮬레이터가 아는 카메라 — **PTZ 제어·측정의 대상**이다(`camId` 축).
 * 영상 소스와는 다른 목록이다.
 */
async function loadCameras() {
  const result = await rpc('cam.list');
  cameras = result.cameras ?? [];
  const options = cameras.map((camera) => new Option(`${camera.name ?? 'Camera'} (#${camera.camId})`, String(camera.camId)));
  for (const id of ['camList', 'mCamId']) {
    const select = el(id);
    const previous = select.value;
    select.replaceChildren(...options.map((option) => option.cloneNode(true)));
    if (previous && cameras.some((camera) => String(camera.camId) === previous)) select.value = previous;
  }
  await showStreamSlots();
  updateClickNote();
  for (const entry of panels) entry.panel?.onCameras?.(cameras);
}

/**
 * 영상 소스 — 등록된 카메라(`camera_info`). **시뮬레이터 연결과 무관하다** —
 * 시뮬 RPC 가 꺼져 있어도 영상은 볼 수 있어야 한다.
 */
async function loadStreamCameras() {
  const { cameras: registered } = await api.cameras();
  streamCameras = registered ?? [];
  const select = el('simStreamCam');
  const previous = select.value;
  select.replaceChildren(...streamCameras.map((camera) => {
    const isMain = camera.id === MAIN_CAMERA_ID;
    const option = new Option(`${camera.label ?? camera.id}${isMain ? '  — 시뮬레이터 메인' : ''}`, camera.id);
    option.title = camera.streamUrl || '(영상 URL 없음 — 스냅샷 폴링)';
    return option;
  }));
  // 기본은 **메인 카메라**다. 없으면 첫 번째를 쓴다(지어내지 않는다).
  const wanted = previous || (streamCameras.some((c) => c.id === MAIN_CAMERA_ID) ? MAIN_CAMERA_ID : streamCameras[0]?.id);
  if (wanted) select.value = wanted;
  el('simStreamStart').disabled = streaming || !select.value;
  updateClickNote();
}

/**
 * 동시 스트림 슬롯은 제한돼 있다(실측 `slots:1 / hardMaxSlots:2`).
 * **조용히 남의 스트림을 끊지 않는다** — 사람이 다툼을 볼 수 있게 표시만 한다.
 */
async function showStreamSlots() {
  try {
    const status = await rpc('cam.streamStatus');
    const serving = (status.channels ?? []).filter((channel) => channel.clients > 0);
    const box = el('simStreamSlots');
    box.hidden = status.slots > serving.length;
    box.textContent = box.hidden
      ? ''
      : `동시 스트림 슬롯 ${serving.length}/${status.slots} 을 다 쓰고 있습니다 (최대 ${status.hardMaxSlots}). 다른 화면의 영상을 멈추거나 슬롯을 늘려야 새 영상이 뜹니다.`;
  } catch {
    // 슬롯 조회 실패가 화면을 막을 이유는 아니다.
  }
}

/**
 * 영상은 **우리 서버를 거친다**(`/api/stream?cameraId=`). 전송(rtsp→ffmpeg,
 * http MJPEG→그대로 중계, 없으면 스냅샷 폴링)은 서버가 URL 스킴으로 고른다 —
 * 화면이 포트를 조립하면 그 규칙이 두 벌이 된다.
 */
function startStream() {
  const cameraId = el('simStreamCam').value;
  if (!cameraId) return toast('영상 소스를 고르세요.', 'err');
  const url = `/api/stream?cameraId=${encodeURIComponent(cameraId)}&t=${Date.now()}`;
  stopStream();
  const image = el('simStream');
  streaming = true;
  image.onerror = () => { stopStream(); toast('시뮬레이터 영상을 받지 못했습니다 — 스트림 슬롯을 확인하세요.', 'err'); };
  image.src = url;
  image.classList.add('live');
  el('simPlaceholder').style.display = 'none';
  el('simStreamTag').textContent = '수신 중';
  el('simStreamStart').disabled = true;
  el('simStreamStop').disabled = false;
  void showStreamSlots();
}

function stopStream() {
  const image = el('simStream');
  streaming = false;
  image.onerror = null;
  image.removeAttribute('src');
  image.classList.remove('live');
  el('simPlaceholder').style.display = '';
  el('simStreamTag').textContent = '정지';
  el('simStreamStart').disabled = !el('simStreamCam').value;
  el('simStreamStop').disabled = true;
}

// --- 영상 클릭 -------------------------------------------------------------

/**
 * 지금 보고 있는 영상이 **시뮬레이터의 어느 카메라인가**.
 *
 * 클릭을 월드 좌표로 바꾸려면 그 영상을 찍는 카메라의 위치·pan·tilt·zoom 을 알아야 하는데,
 * 그것을 알려주는 것은 `cam.get` 뿐이고 그것은 **PTZ 카메라만** 안다.
 *
 * **메인 카메라(`simulator-99`, 스트림 13600)는 자세를 알 수 없다** — RPC 82개 어디에도
 * 메인 뷰의 위치나 방향을 주는 것이 없다. 그래서 메인 영상 위에서는 클릭이 성립하지 않는다.
 * 여기서 `null` 을 돌려 화면이 그 사실을 말하게 한다 — 대충 찍어서 엉뚱한 자리에 차를
 * 놓는 것보다 낫다.
 *
 * 짝은 **스트림 포트로** 맞춘다(`cam.list` 가 `streamPort` 를 준다). `13600+camId` 라는
 * 규칙을 여기서 다시 계산하면 시뮬레이터가 basePort 를 바꾸는 날 조용히 어긋난다.
 */
function projectionCamId() {
  const port = streamPort();
  if (!port) return null;
  return cameras.find((camera) => camera.streamPort === port)?.camId ?? null;
}

/** 지금 고른 영상 소스가 나가는 포트. 두 판정(메인 뷰인가 / 어느 PTZ 인가)이 함께 쓴다. */
function streamPort() {
  const source = streamCameras.find((camera) => camera.id === el('simStreamCam').value);
  if (!source?.streamUrl) return 0;
  try { return Number(new URL(source.streamUrl).port) || 0; } catch { return 0; }
}

/**
 * 지금 보고 있는 것이 **메인 뷰(자유 시점)** 인가.
 *
 * 포트는 **시뮬레이터가 알려준 것**(`view.get.streamPort`)과 맞춘다 — `13600` 이라는 숫자를
 * 여기 적어 두면 언리얼이 basePort 를 바꾸는 날 조용히 어긋난다. `cam.list.streamPort` 로
 * PTZ 를 맞추는 것과 같은 규율이다.
 */
function isMainView() {
  const port = streamPort();
  return port > 0 && port === viewControl.mainStreamPort();
}

/** 클릭이 되는 상태인지, 안 되면 왜 안 되는지 한 줄로 말한다. */
function updateClickNote() {
  const mode = el('simClickMode').value;
  const note = el('simClickNote');
  const main = isMainView();
  const camId = projectionCamId();
  if (mode === 'off') {
    note.className = 'hint';
    note.textContent = '영상 클릭을 쓰지 않습니다.';
  } else if (main) {
    // 메인 뷰는 **언리얼이 직접 맞힌다**(라인트레이스) — 지면 평면을 가정하지 않으므로
    // 경사·구조물 위도 그대로 찍힌다. 그래서 「지면 높이 z」가 필요 없다.
    note.className = 'hint ready';
    note.textContent = mode === 'select'
      ? '영상 위의 차량을 왼쪽 클릭하면 「차량 배치」 목록에서 그 차를 고릅니다 (메인 뷰 — 언리얼이 직접 맞힙니다).'
      : '영상을 왼쪽 클릭하면 그 자리에 차량을 추가합니다 (메인 뷰 — 실제 지형에 맞으므로 「지면 높이 z」를 쓰지 않습니다).';
  } else if (!rpcUrl || !cameras.length) {
    note.className = 'hint warn';
    note.textContent = '시뮬레이터에 연결돼야 영상 클릭을 쓸 수 있습니다 — 카메라 자세를 물어야 하기 때문입니다.';
  } else if (camId === null) {
    note.className = 'hint warn';
    note.textContent = '지금 영상 소스는 카메라 자세를 알 수 없어 클릭이 되지 않습니다.'
      + ' PTZ 카메라 영상(13601 이상)이나 메인 뷰를 고르세요.';
  } else {
    note.className = 'hint ready';
    note.textContent = mode === 'select'
      ? `영상 위의 차량을 왼쪽 클릭하면 「차량 배치」 목록에서 그 차를 고릅니다 (카메라 #${camId} 기준).`
      : `영상의 빈 자리를 왼쪽 클릭하면 그 지면 좌표로 차량을 추가합니다 (카메라 #${camId} 기준).`;
  }
  // 메인 뷰는 실제 지형에 맞으므로 평면 높이를 받지 않는다.
  el('simGroundZ').disabled = mode !== 'place' || main;
  updateViewNote();
}

/** 메인 뷰 마우스 제어가 되는 상태인지 한 줄로 말한다. */
function updateViewNote() {
  const note = el('simViewNote');
  const off = el('simClickMode').value === 'off';
  if (!isMainView()) {
    note.className = 'hint';
    note.textContent = '마우스로 시점을 돌리는 것은 메인 뷰에서만 됩니다 — PTZ 카메라는 「카메라 컨트롤」 탭에서 움직입니다.';
  } else if (!viewControl.isAvailable()) {
    note.className = 'hint warn';
    note.textContent = '이 시뮬레이터에는 view.* 가 없어 시점을 움직일 수 없습니다 — 언리얼에 ViewRpcModule 이 배포돼야 합니다.';
  } else {
    note.className = 'hint ready';
    note.textContent = '드래그로 시점 회전 · 휠로 화각.'
      + (off
        ? ' 더블클릭하면 그 지점을 바라봅니다.'
        : ' (더블클릭 조준은 「영상 클릭」을 「쓰지 않음」으로 두어야 씁니다 — 클릭 배치와 겹칩니다.)')
      + ' 영상이 초당 5장이라 조작보다 늦게 따라옵니다 — 위의 숫자가 먼저 움직입니다.';
  }
  el('simViewFovReset').disabled = !isMainView() || !viewControl.isAvailable();
}

/**
 * 클릭 한 번을 월드 좌표로 바꿔 활성 패널에 넘긴다.
 *
 * **계산은 서버가 한다**(`/api/sim/pick`). 카메라 기하를 화면에도 한 벌 두면 언젠가
 * 한쪽만 고쳐지고, 그 실패는 오류로 뜨지 않는다 — 차가 조금 엇나간 자리에 놓일 뿐이다.
 */
/**
 * 포인터 한 점을 **영상의 실제 픽셀**로 바꾼다.
 *
 * 공용 도우미는 1920×1080 으로 정규화해 준다(Hucoms 규약). 서버·시뮬레이터에는 실제
 * 픽셀로 보낸다 — 화면비가 16:9 가 아닌 영상이 와도 세로 화각이 어긋나지 않는다.
 * 메인 뷰(960×540)와 PTZ 영상이 크기가 달라도 이 한 자리가 흡수한다.
 */
function imagePoint(event) {
  const image = el('simStream');
  if (!image.classList.contains('live')) return null;
  const point = streamPointFromPointer({
    button: event.button,
    clientX: event.clientX,
    clientY: event.clientY,
    viewport: el('simViewport').getBoundingClientRect(),
    image: image.getBoundingClientRect(),
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
  });
  if (!point) return null;
  return {
    x: (point.x / 1920) * image.naturalWidth,
    y: (point.y / 1080) * image.naturalHeight,
    width: image.naturalWidth,
    height: image.naturalHeight,
    left: point.left,
    top: point.top,
  };
}

async function viewportClick(event) {
  const mode = el('simClickMode').value;
  if (mode === 'off') return;
  // 클릭을 받는 탭은 「차량 배치」뿐이다. 다른 탭에서 눌렀을 때 조용히 아무 일도 없으면
  // 사람은 기능이 고장난 줄 안다 — 어디로 가야 하는지 말한다.
  if (!active?.panel?.onViewportClick) return toast('영상 클릭은 「차량 배치」 탭에서 씁니다.', 'err');
  const point = imagePoint(event);
  if (!point) return;

  const marker = el('simClickMarker');
  marker.style.left = `${point.left}px`;
  marker.style.top = `${point.top}px`;
  marker.hidden = false;

  // **메인 뷰는 언리얼이 직접 맞힌다**(`view.pick` = DeprojectScreenToWorld + 라인트레이스).
  // 우리 서버의 `/api/sim/pick` 은 PTZ 자세(`cam.get`)로 기하를 푸는 것이라 메인 뷰에 쓸 수
  // 없다 — 메인 뷰의 자세를 주는 `cam.*` 가 없기 때문이다. 그리고 라인트레이스는 평면을
  // 가정하지 않으므로 경사·구조물 위도 그대로 맞는다.
  if (isMainView()) {
    if (!viewControl.isAvailable()) return toast('이 시뮬레이터에는 view.pick 이 없어 메인 뷰를 클릭할 수 없습니다.', 'err');
    const hit = await rpc('view.pick', { x: point.x, y: point.y });
    // 빗나가면 좌표를 지어내지 않는다 — 패널이 「지면과 만나지 않는다」고 말한다.
    return active.panel.onViewportClick({
      mode,
      camId: null,
      ground: hit?.hit ? hit.world : null,
      car: hit?.actorId ? { id: hit.actorId } : null,
    });
  }

  const camId = projectionCamId();
  if (camId === null) return toast('이 영상 소스는 카메라 자세를 알 수 없어 클릭할 수 없습니다.', 'err');
  const result = await api.simPick(
    camId, point.x, point.y, point.width, point.height,
    mode === 'place' ? Number(el('simGroundZ').value) || 0 : 0,
  );
  await active.panel.onViewportClick({ mode, camId, ground: result.ground, car: result.car });
}

// --- 탭 -------------------------------------------------------------------

async function showTab(panelId) {
  if (active?.id === panelId) return;
  active?.panel?.onDeactivate?.();
  for (const entry of panels) el(entry.id).hidden = entry.id !== panelId;
  for (const button of el('simTabs').querySelectorAll('button[data-panel]')) {
    button.classList.toggle('active', button.dataset.panel === panelId);
  }
  active = panels.find((entry) => entry.id === panelId) ?? null;
  // **연결 여부와 무관하게 활성화한다.** 저장 파일 목록은 이 PC 것이라 시뮬레이터가
  // 꺼져 있어도 읽을 수 있다 — 패널이 RPC 가 필요한 부분만 알아서 실패한다.
  await active?.panel?.onActivate?.();
}

// --- 배선 -----------------------------------------------------------------

el('simTabs').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-panel]');
  if (button) void showTab(button.dataset.panel).catch(reportError);
});

el('simSave').addEventListener('click', () => void (async () => {
  const result = await api.saveSettings({ simTool: { rpcUrl: el('simUrl').value.trim() } });
  rpcUrl = result.simTool?.rpcUrl ?? '';
  el('simUrl').value = rpcUrl;
  toast('시뮬레이터 주소를 저장했습니다', 'ok');
  await connect();
})().catch(reportError));

el('simConnect').addEventListener('click', () => void connect().catch(reportError));
el('simStreamStart').addEventListener('click', startStream);
el('simStreamStop').addEventListener('click', stopStream);
el('simStreamCam').addEventListener('change', () => { updateClickNote(); if (streaming) startStream(); });
el('simClickMode').addEventListener('change', () => {
  el('simClickMarker').hidden = true;
  updateClickNote();
});
// --- 영상 위의 마우스 -------------------------------------------------------
//
// 한 벌의 몸짓이 둘로 갈린다: **끌면 회전, 그냥 누르면 클릭.** 그래서 클릭은 누를 때가
// 아니라 **뗄 때** 판정한다 — 누르는 순간에 처리하면 드래그 시작이 매번 클릭이 된다.
// 움직임·뗌은 창 전체에서 듣는다. 영상 밖으로 끌고 나가도 회전이 이어져야 하고,
// 밖에서 손을 떼도 드래그 상태가 남으면 안 되기 때문이다.
// 오른쪽 버튼: **영상 위에서는 브라우저 팝업을 띄우지 않는다.** 시점을 끄는 도중에 뜨면
// 그 메뉴 위에서 손을 떼게 되어 `mouseup` 이 화면에 오지 않고, 회전이 눌린 채로 남는다.
el('simViewport').addEventListener('contextmenu', (event) => event.preventDefault());
el('simViewport').addEventListener('mousedown', (event) => { if (isMainView()) viewControl.onDown(event); });
addEventListener('mousemove', (event) => viewControl.onMove(event));
addEventListener('mouseup', (event) => {
  const wasDrag = viewControl.onUp();
  if (wasDrag || event.button !== 0) return;
  if (!el('simViewport').contains(event.target)) return;
  void viewportClick(event).catch(reportError);
});
// `passive:false` 여야 preventDefault 가 먹는다 — 아니면 휠이 페이지를 함께 스크롤한다.
el('simViewport').addEventListener('wheel', (event) => { if (isMainView()) viewControl.onWheel(event); }, { passive: false });
// 더블클릭 조준은 **클릭 모드가 꺼져 있을 때만** 받는다. 켜져 있으면 dblclick 이 오기 전에
// 클릭이 이미 두 번 처리되어 차가 두 대 놓인다 — 억누르는 대신 겹치지 않게 둔다.
el('simViewport').addEventListener('dblclick', (event) => {
  if (!isMainView() || el('simClickMode').value !== 'off') return;
  const point = imagePoint(event);
  if (point) void viewControl.lookAt(point).catch(reportError);
});
el('simViewFovReset').addEventListener('click', () => void viewControl.resetFov().catch(reportError));
addEventListener('pagehide', stopStream);

async function main() {
  setPanelsEnabled(false);
  // 영상 소스는 시뮬 연결보다 **먼저** 채운다 — 시뮬이 꺼져 있어도 영상은 봐야 한다.
  await loadStreamCameras().catch(reportError);
  await loadSettings();
  await showTab('panelPreset');
  await connect();
}

void main().catch(reportError);
