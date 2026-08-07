import { api, reportError, toast } from './api.js';
import { createStreamView } from './streamView.js';
import { createDiscoveryPanel } from './parkingDiscovery.js';
import { createCalibrationPanel } from './parkingCalibration.js';
import { createVehicleBoxPanel } from './parkingVehicleBox.js';

/**
 * 주차면 페이지의 **껍데기**. 세 탭(탐색·캘리브레이션·차량 3D)이 공유하는 것만 소유한다.
 *
 * ## 왜 카메라와 영상이 탭 밖에 있나
 *
 * 셋 다 "이 카메라를 이렇게 한다"는 화면이다. 탭마다 카메라를 따로 고르게 두면 사람이
 * **지금 어느 카메라를 보고 있는지 잃는다** — 탭을 옮겼는데 다른 카메라의 결과를 보면서
 * 같은 카메라의 것이라고 믿게 된다. 능력 조회(`/api/core/capabilities`)도 한 번만 하고
 * 세 패널이 그 결과를 나눠 읽는다.
 *
 * ## 패널은 자기가 활성일 때만 움직인다
 *
 * 캘리브레이션 폴링이 탐색 탭에서도 돌면 20분짜리 스윕 중에 세 배로 두드린다.
 * `onActivate`/`onDeactivate` 가 그 경계이고, **비활성 패널은 타이머를 반드시 끈다.**
 *
 * ## 클릭 센터링은 탐색 탭에만 있다
 *
 * 캘리브레이션 패널은 `onViewportClick` 을 아예 내놓지 않는다 — 스윕이 카메라를 점유한
 * 동안 사람이 조준을 끼워 넣으면 그 샘플이 조용히 오염되고, 오염된 줄 모르는 채 발행까지 간다.
 * 켜고 끄는 플래그가 아니라 **없는 것**이어야 실수로 켜지지 않는다.
 */

const el = (id) => document.getElementById(id);

let cameraId = '';
let capabilities = null;
let active = null;

/** 영상 뷰어. 세 탭이 같은 `img#stream` 을 쓴다 — 탭을 옮겨도 영상은 끊기지 않는다. */
const view = createStreamView({
  image: el('stream'),
  placeholder: el('streamPlaceholder'),
  tag: el('streamTag'),
  startButton: el('streamStart'),
  stopButton: el('streamStop'),
  snapshotButton: el('snapshotOnce'),
  cameraId: () => cameraId,
  onError: (message) => toast(message, 'err'),
  onFrame: () => active?.panel.onFrame?.(),
});

const ctx = {
  cameraId: () => cameraId,
  view,
  toast,
  reportError,
  setViewNote: (html) => { el('viewNote').innerHTML = html ?? ''; },
};

const panels = [
  { id: 'panelDiscovery', panel: createDiscoveryPanel(ctx) },
  { id: 'panelCalibration', panel: createCalibrationPanel(ctx) },
  { id: 'panelVehicleBox', panel: createVehicleBoxPanel(ctx) },
];

// --- 카메라와 능력 ---------------------------------------------------------

async function loadCameras() {
  const { cameras, activeCameraId } = await api.cameras();
  el('cameraSelect').innerHTML = cameras.map((c) => `<option value="${c.id}">${c.label}</option>`).join('');
  cameraId = activeCameraId || cameras[0]?.id || '';
  el('cameraSelect').value = cameraId;
}

/**
 * 능력을 **한 번** 읽어 세 패널에 나눠 준다.
 *
 * 실패해도 예외로 올리지 않고 `null` 을 뿌린다 — 패널마다 "조회 실패"를 자기 방식으로
 * 말해야 하고, 하나가 못 읽었다고 나머지 두 탭까지 빈 화면이 되면 안 된다.
 */
async function loadCapability() {
  const note = el('cameraNote');
  if (!cameraId) {
    capabilities = null;
    el('capability').textContent = '선택 필요';
    el('capability').className = 'tag';
    note.className = 'capability-note';
    note.textContent = '카메라를 선택하세요.';
  } else {
    try {
      capabilities = await api.coreCapabilities(cameraId);
      el('capability').textContent = `코어: ${capabilities.provider}`;
      el('capability').className = 'tag ok';
      note.className = 'capability-note ready';
      note.innerHTML = `구현은 <a href="/options">/options</a> 에서 정합니다. 각 탭은 이 코어가 <strong>할 수 있는 것만</strong> 켭니다.`;
    } catch (error) {
      capabilities = null;
      el('capability').textContent = '조회 실패';
      el('capability').className = 'tag warn';
      note.className = 'capability-note';
      note.textContent = error.message;
    }
  }
  for (const entry of panels) entry.panel.onCapability?.(capabilities);
}

async function selectCamera() {
  cameraId = el('cameraSelect').value;
  // 기기를 바꾸면 **영상을 먼저 끊는다** — 안 끊으면 옛 카메라의 MJPEG 가 계속 흐르면서
  // 아래 패널만 새 카메라의 것으로 바뀌어, 화면 전체가 조용히 거짓말을 한다.
  view.stop();
  view.setControls();
  el('streamClickMarker').hidden = true;
  for (const entry of panels) entry.panel.onCameraChange?.();
  await loadCapability();
  await active?.panel.onActivate?.();
}

// --- 탭 -------------------------------------------------------------------

async function showTab(panelId) {
  if (active?.id === panelId) return;
  active?.panel.onDeactivate?.();
  for (const entry of panels) el(entry.id).hidden = entry.id !== panelId;
  for (const button of el('parkingTabs').querySelectorAll('button[data-panel]')) {
    button.classList.toggle('active', button.dataset.panel === panelId);
  }
  active = panels.find((entry) => entry.id === panelId) ?? null;
  el('viewNote').innerHTML = '';
  await active?.panel.onActivate?.();
}

el('parkingTabs').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-panel]');
  if (button) void showTab(button.dataset.panel).catch(reportError);
});

// --- 뷰포트 클릭 -----------------------------------------------------------

el('viewport').addEventListener('mousedown', (event) => {
  active?.panel.onViewportClick?.(event);
});

// --- 배선 -----------------------------------------------------------------

el('cameraSelect').addEventListener('change', () => void selectCamera().catch(reportError));
el('activateCamera').addEventListener('click', () => {
  api.setActiveCamera(cameraId)
    .then(() => toast('활성 카메라를 변경했습니다', 'ok'))
    .catch(reportError);
});

// 탭을 떠나면 타이머가 남지 않게 한다. 페이지를 닫을 때도 마찬가지다.
addEventListener('pagehide', () => active?.panel.onDeactivate?.());

async function main() {
  await loadCameras();
  cameraId = el('cameraSelect').value;
  // 뷰어는 모듈 로드 시점(카메라 아직 없음)에 버튼을 잠갔다. 목록이 온 지금 다시 물어야
  // 「시작」이 열린다 — 이걸 빼면 카메라가 있는데도 영상 버튼이 회색으로 남는다.
  view.setControls();
  await loadCapability();
  await showTab('panelDiscovery');
}

void main().catch(reportError);
