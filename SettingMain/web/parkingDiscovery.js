import { api } from './api.js';
import { streamPointFromPointer } from './streamCentering.js';

/**
 * 주차면 탐색 탭 — 탐색 프리셋·점·센터라이징·번호판 호밍.
 *
 * ## 캘리브레이션은 여기 없다
 *
 * 이 탭은 "주차면을 표시하고 조준한다"는 한 가지 일을 한다. 캘리브레이션은 **카메라의
 * 광학 곡선을 재는** 전혀 다른 일이고 20분간 카메라를 통째로 점유한다. 한 화면에 두면
 * 사람이 탐색 작업 중에 실수로 스윕을 시작한다 — 그래서 탭을 갈랐다(2026-08-07).
 *
 * ## 경로는 언제나 하나다
 *
 * 어느 코어 구현(bridge·remote)이 답하는지는 서버가 설정으로 정하고 화면은 모른다.
 * 화면은 `capabilities` 로 **무엇을 할 수 있는지**만 묻고 그것만 켠다.
 */

const el = (id) => document.getElementById(id);

/** 능력 맵의 어느 키가 이 컨트롤을 켜는가. 여기 없는 컨트롤은 카메라만 있으면 켜진다. */
const NEEDS = {
  center: 'center',
  centerBox: 'centerBox',
  homeStart: 'plateHoming',
  homeStop: 'plateHoming',
};

export function createDiscoveryPanel(ctx) {
  let presets = [];
  let points = [];
  let advanced = false;
  let supported = null;
  let timer = null;
  let centering = false;
  let trace = null;
  let traceStep = 0;

  const currentPreset = () => presets.find((p) => p.id === el('presetSelect').value);
  const currentPoint = () => points.find((p) => p.id === el('pointSelect').value);

  function fill(select, values) {
    el(select).replaceChildren(...values.map((v) => new Option(v.name || v.label || v.id, v.id)));
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // --- 프리셋·점 -----------------------------------------------------------

  async function loadPresets() {
    const data = await api.discoveryPresets(ctx.cameraId());
    presets = data.presets || [];
    fill('presetSelect', presets);
    await loadPoints();
  }

  async function loadPoints() {
    const preset = currentPreset();
    points = preset ? (await api.discoveryPoints(ctx.cameraId(), preset.id)).points || [] : [];
    fill('pointSelect', points);
    fillPoint();
  }

  function fillPoint() {
    const point = currentPoint();
    el('pointX').value = point?.x ?? '';
    el('pointY').value = point?.y ?? '';
  }

  function pointPayload() {
    const x = Number(el('pointX').value);
    const y = Number(el('pointY').value);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x, y는 숫자여야 합니다');
    return { x, y };
  }

  // --- 능력 게이트 ---------------------------------------------------------

  function setControlsDisabled(disabled) {
    for (const control of el('advanced').querySelectorAll('input, select, button')) {
      const capability = NEEDS[control.id];
      const state = capability ? supported?.[capability] : undefined;
      control.disabled = disabled || (capability ? !state?.ok : false);
      // 못 하는 이유를 **그대로** 붙인다. 회색 버튼만 있으면 운영자가 손쓸 수 없다.
      if (control.disabled) control.title = state?.reason ?? '현재 코어가 이 기능을 지원하지 않습니다';
      else control.removeAttribute('title');
    }
    // 「개별 센터+줌」은 탐색 점이 box 를 저장하지 않아 늘 꺼져 있다 — 능력과 무관하다.
    el('centerBox').disabled = true;
  }

  // --- 호밍 ---------------------------------------------------------------

  const STATE_TEXT = {
    idle: '대기', running: '진행 중', done: '완료', failed: '실패', stopped: '중지됨',
  };

  /** 실패 코드마다 **처방이 다르다** — 하나는 점을 다시 찍어야 하고 하나는 검출기를 봐야 한다. */
  const CODE_TEXT = {
    plate_not_found: '번호판을 찾지 못함',
    plate_too_small: '판이 끝까지 작음 — 더 가까운 프리셋이 필요',
    target_not_found: '마킹점에 차량이 없음 — 점을 다시 찍으세요',
    target_ambiguous: '마킹점에 차량이 겹침 — 점을 차량 중앙으로',
    target_lost: '타깃 번호판 추적 상실 — 옆차와 겹쳤을 수 있음',
    detector_error: '검출기 오류 — 사이드카 연결을 확인하세요',
    stopped: '사용자 중지',
  };

  function renderHomeResults(results = []) {
    el('homeResults').querySelector('tbody').innerHTML = results.map((r) => {
      const ptz = r.closeupPtz ? `${r.closeupPtz.pan}/${r.closeupPtz.tilt}/${r.closeupPtz.zoom}` : '-';
      const ok = r.status === 'ok';
      return `<tr class="${ok ? '' : 'bad'}">
        <td>${escape(r.name ?? r.pointId)}</td>
        <td>${ok ? '조준 확보' : r.status === 'uncertain' ? '불확실' : '실패'}</td>
        <td>${r.plateW ? `${r.plateW}px` : '-'}</td>
        <td>${ptz}</td>
        <td>${escape(CODE_TEXT[r.code] ?? r.reason ?? '-')}</td>
        <td><button type="button" class="home-trace" data-point="${escape(r.pointId)}">과정 보기</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="6">아직 결과가 없습니다.</td></tr>';
  }

  async function pollHome() {
    if (!advanced || !ctx.cameraId()) return;
    try {
      const status = await api.plateHomingStatus(ctx.cameraId());
      const state = status.state ?? (status.running ? 'running' : 'idle');
      el('homeStatus').textContent = STATE_TEXT[state] ?? state;
      el('homeStatus').className = `badge ${state}`;
      const total = status.total ?? 0;
      const done = status.currentIdx ?? 0;
      el('homeProgress').value = total ? Math.round((done / total) * 100) : 0;
      el('homeProgressText').textContent = total ? `${done}/${total}` : '-';
      el('homeMessage').textContent = status.current
        ? `${status.current.name ?? status.current.pointId} · ${status.current.phase ?? ''} ${status.current.thought ?? ''}`.trim()
        : (status.error ?? '');
      // **카메라를 못 돌려놨다는 사실은 사람이 알아야 한다.** 조용히 넘기면 카메라가
      // 고배율로 엉뚱한 곳을 보는 채 남는다.
      el('homeStranded').hidden = !status.cameraStranded;
      el('homeStranded').textContent = status.cameraStranded
        ? '잡이 끝났지만 카메라를 와이드 프리셋으로 되돌리지 못했습니다 — 사람이 확인해야 합니다.'
        : '';
      renderHomeResults(status.results);

      const running = state === 'running';
      el('homeStart').disabled = running || !supported?.plateHoming?.ok;
      el('homeStop').disabled = !running;
      if (!running) stopTimer();
    } catch (error) {
      ctx.reportError(error);
      stopTimer();
    }
  }

  // --- 호밍 과정 재생 -------------------------------------------------------

  async function showTrace(pointId) {
    const preset = currentPreset();
    if (!preset) return;
    try {
      trace = await api.plateHomingTrace(ctx.cameraId(), preset.id, pointId);
      traceStep = 0;
      el('homeTraceCard').hidden = false;
      el('homeTraceTitle').textContent = trace.name ?? pointId;
      renderTraceStep();
    } catch (error) {
      ctx.reportError(error);
    }
  }

  function renderTraceStep() {
    const steps = trace?.steps ?? [];
    if (!steps.length) {
      el('homeTraceStep').textContent = '스텝 기록이 없습니다';
      return;
    }
    traceStep = Math.max(0, Math.min(traceStep, steps.length - 1));
    const step = steps[traceStep];
    el('homeTraceStep').textContent =
      `${traceStep + 1}/${steps.length} · zoom ${step.zoom}${step.plateW ? ` · 판 ${step.plateW}px` : ''}`;
    el('homeTracePrev').disabled = traceStep === 0;
    el('homeTraceNext').disabled = traceStep === steps.length - 1;
    const image = el('homeTraceFrame');
    // 프레임 URL 은 **잡이 준 것을 그대로 쓴다** — 경로를 우리가 조립하면 서버의 검증과 어긋난다.
    if (step.frameUrl) {
      image.onload = () => drawTraceBoxes(step);
      image.src = step.frameUrl;
    } else {
      image.removeAttribute('src');
      drawTraceBoxes(step);
    }
  }

  /** 후보는 노랑, 선택된 판은 초록. **그 스텝의 스냅샷 좌표계 그대로** 그린다. */
  function drawTraceBoxes(step) {
    const canvas = el('homeTraceOverlay');
    const image = el('homeTraceFrame');
    const width = image.naturalWidth || 1920;
    const height = image.naturalHeight || 1080;
    canvas.width = image.clientWidth || width;
    canvas.height = image.clientHeight || height;
    const ctx2d = canvas.getContext('2d');
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    const sx = canvas.width / width;
    const sy = canvas.height / height;
    ctx2d.lineWidth = 2;
    for (const box of step.boxes ?? []) {
      ctx2d.strokeStyle = 'rgba(234, 179, 8, .9)';
      ctx2d.strokeRect(box[0] * sx, box[1] * sy, (box[2] - box[0]) * sx, (box[3] - box[1]) * sy);
    }
    if (step.pick) {
      ctx2d.strokeStyle = 'rgba(34, 197, 94, 1)';
      ctx2d.lineWidth = 3;
      ctx2d.strokeRect(step.pick[0] * sx, step.pick[1] * sy, (step.pick[2] - step.pick[0]) * sx, (step.pick[3] - step.pick[1]) * sy);
    }
  }

  // --- 클릭 센터링 ---------------------------------------------------------

  async function centerStreamClick(event) {
    if (centering) return;
    const image = el('stream');
    if (!image.classList.contains('live')) return;
    const point = streamPointFromPointer({
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
      viewport: el('viewport').getBoundingClientRect(),
      image: image.getBoundingClientRect(),
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    });
    if (!point) return;
    if (!ctx.cameraId()) return ctx.toast('센터링할 카메라를 선택하세요.', 'err');
    const marker = el('streamClickMarker');
    marker.hidden = true;
    centering = true;
    el('viewport').classList.add('centering');
    try {
      const result = await api.centerPoint(ctx.cameraId(), point);
      marker.style.left = '50%';
      marker.style.top = '50%';
      marker.hidden = false;
      ctx.toast(`클릭 지점을 화면 중앙으로 이동했습니다 (코어: ${result.provider ?? '-'}).`, 'ok');
    } catch (error) {
      ctx.reportError(error);
    } finally {
      centering = false;
      el('viewport').classList.remove('centering');
    }
  }

  // --- 배선 ---------------------------------------------------------------

  const guard = (fn) => () => void fn().catch(ctx.reportError);

  el('presetSelect').addEventListener('change', guard(loadPoints));
  el('pointSelect').addEventListener('change', fillPoint);

  el('presetGoto').addEventListener('click', guard(async () => {
    const preset = currentPreset();
    if (!preset) throw new Error('프리셋을 선택하세요');
    await api.discoveryGotoPreset(ctx.cameraId(), preset.id);
    ctx.toast('프리셋 이동 요청 완료', 'ok');
  }));

  el('presetCreate').addEventListener('click', guard(async () => {
    const name = el('presetName').value.trim();
    if (!name) throw new Error('프리셋 이름을 입력하세요');
    const current = await api.ptz(ctx.cameraId());
    await api.discoveryAddPreset(ctx.cameraId(), { name, ptz: current.ptz });
    await loadPresets();
  }));

  el('presetUpdate').addEventListener('click', guard(async () => {
    const preset = currentPreset();
    if (!preset) throw new Error('프리셋을 선택하세요');
    await api.discoveryUpdatePreset(ctx.cameraId(), preset.id, { name: el('presetName').value.trim() });
    await loadPresets();
  }));

  el('presetDelete').addEventListener('click', guard(async () => {
    const preset = currentPreset();
    if (!preset) throw new Error('프리셋을 선택하세요');
    await api.discoveryRemovePreset(ctx.cameraId(), preset.id);
    await loadPresets();
  }));

  el('pointCreate').addEventListener('click', guard(async () => {
    const preset = currentPreset();
    if (!preset) throw new Error('프리셋을 선택하세요');
    await api.discoveryAddPoint(ctx.cameraId(), preset.id, pointPayload());
    await loadPoints();
  }));

  el('pointUpdate').addEventListener('click', guard(async () => {
    const preset = currentPreset();
    const point = currentPoint();
    if (!preset) throw new Error('프리셋을 선택하세요');
    if (!point) throw new Error('점을 선택하세요');
    await api.discoveryUpdatePoint(ctx.cameraId(), preset.id, point.id, pointPayload());
    await loadPoints();
  }));

  el('pointDelete').addEventListener('click', guard(async () => {
    const preset = currentPreset();
    const point = currentPoint();
    if (!preset) throw new Error('프리셋을 선택하세요');
    if (!point) throw new Error('점을 선택하세요');
    await api.discoveryRemovePoint(ctx.cameraId(), preset.id, point.id);
    await loadPoints();
  }));

  el('center').addEventListener('click', guard(async () => {
    const point = currentPoint();
    if (!point) throw new Error('점을 선택하세요');
    await api.centerPoint(ctx.cameraId(), { x: point.x, y: point.y });
    ctx.toast('개별 센터 요청 완료', 'ok');
  }));

  el('homeStart').addEventListener('click', guard(async () => {
    const preset = currentPreset();
    if (!preset) throw new Error('프리셋을 선택하세요');
    const point = currentPoint();
    const scope = point ? `점 「${point.name || point.id}」 하나` : `점 ${points.length}개 전부`;
    if (!confirm(`${scope}를 호밍합니다.\n점마다 카메라를 고배율로 돌리며 수십 초씩 점유합니다.\n\n시작할까요?`)) return;
    await api.plateHomingStart(ctx.cameraId(), { presetId: preset.id, ...(point ? { pointIds: [point.id] } : {}) });
    if (!timer) timer = setInterval(pollHome, 1500);
    await pollHome();
  }));

  el('homeStop').addEventListener('click', guard(async () => {
    await api.plateHomingStop(ctx.cameraId());
    await pollHome();
  }));

  el('homeResults').addEventListener('click', (event) => {
    const button = event.target.closest('button.home-trace');
    if (button) void showTrace(button.dataset.point);
  });
  el('homeTracePrev').addEventListener('click', () => { traceStep -= 1; renderTraceStep(); });
  el('homeTraceNext').addEventListener('click', () => { traceStep += 1; renderTraceStep(); });
  el('homeTraceClose').addEventListener('click', () => { el('homeTraceCard').hidden = true; trace = null; });

  return {
    onCapability(caps) {
      supported = caps?.supported ?? null;
      // 화면은 구현 이름으로 분기하지 않는다 — 무엇을 할 수 있는지만 본다.
      advanced = Boolean(supported?.discoveryPresets?.ok);
      setControlsDisabled(!advanced);
      const note = el('discoveryNote');
      if (advanced) {
        note.hidden = true;
        note.textContent = '';
      } else {
        note.hidden = false;
        note.innerHTML = `현재 코어는 주차면 탐색을 지원하지 않습니다: ${escape(supported?.discoveryPresets?.reason ?? '사유 없음')}<br><a href="/options">/options</a> 에서 코어 구현을 바꿀 수 있습니다.`;
      }
    },

    onCameraChange() {
      stopTimer();
      presets = [];
      points = [];
      el('homeTraceCard').hidden = true;
      trace = null;
      renderHomeResults([]);
    },

    onViewportClick: (event) => void centerStreamClick(event),

    async onActivate() {
      ctx.setViewNote('영상 위를 <strong>왼쪽 클릭</strong>하면 그 지점을 화면 중앙으로 가져옵니다. 가운데 십자가 목표 지점입니다.');
      if (!advanced || !ctx.cameraId()) return;
      await loadPresets();
      await pollHome();
      // 진행 중인 잡이 있으면 폴링을 이어 붙인다 — 다른 창에서 시작했을 수 있다.
      if (el('homeStatus').className.includes('running') && !timer) timer = setInterval(pollHome, 1500);
    },

    onDeactivate() {
      stopTimer();
    },
  };
}

const escape = (text) => String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
