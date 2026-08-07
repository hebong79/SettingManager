import { api, reportError, toast } from './api.js';
import { createPresetPanel } from './simtoolPreset.js';
import { createCarPanel } from './simtoolCar.js';
import { createCamPanel } from './simtoolCam.js';
import { createMeasurePanel } from './simtoolMeasure.js';

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
 * ## 영상은 시뮬레이터에서 **직접** 받는다
 *
 * MJPEG 를 `<img>` 로 받는 것은 CORS 대상이 아니므로 프록시가 필요 없다.
 * 주소는 RPC 주소의 호스트 + `cam.list` 가 준 `streamPort` 로 조립한다.
 */

const el = (id) => document.getElementById(id);

let rpcUrl = '';
let cameras = [];
let active = null;
let streaming = false;

/** 시뮬레이터 RPC 한 번. 오류는 서버가 준 한글 사유를 그대로 들고 온다. */
async function rpc(method, params = {}) {
  const data = await api.simRpc(method, params);
  return data.result;
}

const ctx = {
  rpc,
  toast,
  reportError,
  /** 지금 시뮬레이터가 아는 카메라 목록. 세 탭이 나눠 쓴다. */
  cameras: () => cameras,
  refreshCameras: loadCameras,
  connected: () => Boolean(rpcUrl),
};

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
    tag.textContent = `연결됨 · ${have.size} method`;
    tag.className = 'tag ok';
    note.className = 'capability-note ready';
    note.innerHTML = missing.length
      ? `포트 ${health.port} 에 연결됐지만 이 화면이 쓰는 메서드 ${missing.length}개가 서버에 없습니다: <code>${missing.join('</code> <code>')}</code>`
      : `포트 ${health.port} · 이 화면이 쓰는 메서드가 전부 있습니다.`;
    setPanelsEnabled(true);
    await loadCameras();
    await active?.panel?.onConnect?.();
  } catch (error) {
    tag.textContent = '연결 실패';
    tag.className = 'tag warn';
    note.className = 'capability-note';
    note.textContent = error.message;
    setPanelsEnabled(false);
  }
}

function setPanelsEnabled(enabled) {
  for (const entry of panels) {
    if (entry.id === 'panelLight') continue;
    for (const control of el(entry.id).querySelectorAll('input, select, button')) control.disabled = !enabled;
  }
  el('simStreamStart').disabled = !enabled || streaming;
  el('simStreamStop').disabled = !streaming;
}

// --- 카메라 · 영상 ---------------------------------------------------------

async function loadCameras() {
  const result = await rpc('cam.list');
  cameras = result.cameras ?? [];
  const options = cameras.map((camera) => new Option(`${camera.name ?? 'Camera'} (#${camera.camId})`, String(camera.camId)));
  for (const id of ['simStreamCam', 'camList', 'mCamId']) {
    const select = el(id);
    const previous = select.value;
    select.replaceChildren(...options.map((option) => option.cloneNode(true)));
    if (previous && cameras.some((camera) => String(camera.camId) === previous)) select.value = previous;
  }
  await showStreamSlots();
  for (const entry of panels) entry.panel?.onCameras?.(cameras);
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

/** 영상 주소 = RPC 호스트 + `cam.list` 의 `streamPort`. 우리 서버를 거치지 않는다. */
function streamUrlFor(camId) {
  const camera = cameras.find((entry) => String(entry.camId) === String(camId));
  if (!camera?.streamPort) return null;
  try {
    const host = new URL(rpcUrl).hostname;
    return `http://${host}:${camera.streamPort}/?t=${Date.now()}`;
  } catch {
    return null;
  }
}

function startStream() {
  const url = streamUrlFor(el('simStreamCam').value);
  if (!url) return toast('이 카메라의 스트림 포트를 알 수 없습니다.', 'err');
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
  el('simStreamStart').disabled = !rpcUrl;
  el('simStreamStop').disabled = true;
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
  if (rpcUrl) await active?.panel?.onActivate?.();
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
el('simStreamCam').addEventListener('change', () => { if (streaming) startStream(); });
addEventListener('pagehide', stopStream);

async function main() {
  setPanelsEnabled(false);
  await loadSettings();
  await showTab('panelPreset');
  await connect();
}

void main().catch(reportError);
