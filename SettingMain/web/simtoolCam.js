import { createFileBar } from './simtoolFileBar.js';
import { createWorkMode } from './simtoolWorkMode.js';

const el = (id) => document.getElementById(id);
const num = (id) => Number(el(id).value);
const fmt = (v, digits = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '-');

/**
 * 카메라 컨트롤 — 위치 슬라이더 3개 + **인라인 PTZ 제어 패널**.
 *
 * ## 마스터 지시 (2026-08-07)
 *
 * > pan, tilt, zoom 슬라이드 대신 상단은 컨트롤 패널을 사용하고 슬라이드 위치에 삽입한다.
 *
 * 위치 슬라이더(높이·X·Y)는 남기고, **PTZ 슬라이더 3개를 뺀 자리에 방향 패드를 넣되
 * 그 패널 상단에 P/T/Z 현재값을 둔다.** 별도 플로팅 「PTZ 제어」 창은 만들지 않는다 —
 * 인라인으로 들어왔는데 창까지 있으면 조작 지점이 둘이 된다.
 *
 * ## 축 이름이 스크린샷과 다르다
 *
 * 언리얼은 **Z-up** 이다(실측: `cam.list.pos.z = 13.5` 이고 `measure.cameraHeight` 도 13.5).
 * 스크린샷의 "Camera Z 축 이동(앞뒤)"은 Unity(Y-up) 기준이라, 그대로 베끼면 사람이
 * **높이 칸에 앞뒤 값을 넣는다.** 화면에는 X(좌우) · Y(앞뒤) · 높이(Z) 로 적는다.
 *
 * ## Min/Max 는 화면 전용이다
 *
 * 시뮬레이터에 저장되지 않는다(마스터 확인). `cam.setLimits` 같은 RPC 도 없다 —
 * 슬라이더가 다룰 범위를 사람이 정하는 것뿐이다.
 *
 * ## ⚠ tilt 는 **양수가 하향**이다
 *
 * 근거: RPC 목록 문서 §3 — `cam.setTilt` "tilt 양수가 하향". 짐벌 규약이 화면 직관과
 * 반대라, ▲ 버튼에 `tilt + step` 을 넣으면 **카메라가 아래로 내려간다.** 그래서 tilt 축만
 * 부호를 뒤집는다. 이 한 줄이 없으면 방향 패드가 통째로 거꾸로 동작한다.
 *
 * ## `cam.setPosition` 은 `pos` 객체를 받는다
 *
 * `{camId, x, y}` 로 평평하게 보내면 파라미터가 안 잡힌다 — `{camId, pos:{x,y,z}}` 여야 한다.
 *
 * ## 카메라 프리셋의 정본은 **파일**이다
 *
 * `cam.savePreset`·`loadPreset`·`applyPreset` 셋 다 등록만 돼 있고 동작하지 않는다
 * (per-camera 프리셋 메모리 없음 — 문서 §10). 문서는 이것이 "웹 프리셋 이동 = PTZ만 변경"
 * 현상의 직접 원인이라고 적고 있다.
 *
 * 그래서 프리셋은 `save/3D/CameraPos` 의 파일이 정본이고, 다른 두 탭과 **같은 형태**로
 * 새로 만들기·열기…·저장…·추가/수정/삭제를 둔다. 「이 프리셋으로 이동」은 없는 RPC 를
 * 부르는 대신 `cam.setPosition`·`setHeight`·`setPTZ` 로 **그 자세를 직접 만든다.**
 *
 * ## 상대 이동을 절대값으로 보낸다
 *
 * `cam.setPTZ` 에 속도 파라미터가 없다. 없는 파라미터를 지어 보내면 서버가 조용히 버려
 * "속도를 줬는데 왜 안 먹지"가 된다. 그래서 **현재값 + step** 을 절대값으로 보낸다.
 */
export function createCamPanel(ctx) {
  let ptz = null;
  let syncing = false;
  /** 파일에서 읽은 카메라 프리셋들. 시뮬레이터의 현재 상태와 **다른 것**이다. */
  let saved = [];

  const bar = createFileBar({
    kind: 'camera',
    resultKey: 'cameras',
    defaultName: 'CamPos_new.json',
    ids: { newButton: 'kNew', openButton: 'kOpen', openInput: 'kOpenInput', saveButton: 'kSave', status: 'kStatus' },
    getRows: () => saved,
    setRows: (rows) => { saved = rows; renderSaved(''); },
    ctx,
  });

  const pickedSaved = () => saved.find((row) => String(row.idx) === el('kList').value);

  function renderSaved(keepIdx) {
    const previous = keepIdx ?? el('kList').value;
    el('kList').replaceChildren(...saved.map((row) =>
      new Option(`${row.presetId}. ${row.name || '(이름 없음)'}  · cam ${row.camId}  · P${fmt(row.pan, 1)} T${fmt(row.tilt, 1)} Z${fmt(row.zoom, 2)}`, String(row.idx))));
    if (previous && saved.some((row) => String(row.idx) === String(previous))) el('kList').value = String(previous);
    el('kCount').textContent = `${saved.length}건`;
    bar.render();
    showSavedForm();
  }

  function showSavedForm() {
    const row = pickedSaved();
    if (!row) return;
    el('kName').value = row.name ?? '';
    el('kCamId').value = row.camId ?? 1;
    el('kPresetId').value = row.presetId ?? 1;
    el('kPosX').value = fmt(row.pos?.x, 3);
    el('kPosY').value = fmt(row.pos?.y, 3);
    el('kPosZ').value = fmt(row.pos?.z, 3);
    el('kPan').value = fmt(row.pan, 1);
    el('kTilt').value = fmt(row.tilt, 1);
    el('kZoom').value = fmt(row.zoom, 2);
  }

  /** 폼 → 프리셋 1건. `limits` 는 파일에 있던 것을 보존한다(화면이 다루지 않는다). */
  function formSaved(idx, previous) {
    return {
      idx,
      name: el('kName').value.trim() || `Preset ${num('kPresetId')}`,
      camId: num('kCamId'),
      presetId: num('kPresetId'),
      pos: { x: num('kPosX'), y: num('kPosY'), z: num('kPosZ') },
      pan: num('kPan'),
      tilt: num('kTilt'),
      zoom: num('kZoom'),
      ...(previous?.limits ? { limits: previous.limits } : {}),
    };
  }

  const AXES = [
    { key: 'z', slider: 'camZ', min: 'camZMin', max: 'camZMax', out: 'camZOut' },
    { key: 'x', slider: 'camX', min: 'camXMin', max: 'camXMax', out: 'camXOut' },
    { key: 'y', slider: 'camY', min: 'camYMin', max: 'camYMax', out: 'camYOut' },
  ];

  const camId = () => Number(el('camList').value);

  function currentCamera() {
    return ctx.cameras().find((camera) => String(camera.camId) === el('camList').value);
  }

  /**
   * 카메라를 그 자리로 옮긴다. **높이(z)는 지금 것을 지킨다** — 클릭이 맞힌 것은 지면이라
   * 그 z 를 그대로 쓰면 카메라가 바닥에 처박힌다.
   *
   * ## 폴대는 함께 간다 — 별도 RPC 가 없다
   *
   * 마스터 지시는 「카메라 위치 이동(+폴대위치 이동)」이다. 시뮬레이터 RPC 82개 어디에도
   * pole/mast 가 없다 — 폴대는 카메라 액터에 붙어 있어 `cam.setPosition` 이 함께 옮긴다는
   * 것이 전제다. **없는 메서드를 지어 부르지 않는다**(라이브에서 확인한다).
   */
  async function moveTo(x, y) {
    const camera = currentCamera();
    if (!camera) throw new Error('카메라를 선택하세요');
    await ctx.rpc('cam.setPosition', { camId: camera.camId, pos: { x, y, z: camera.pos?.z ?? 0 } });
    await ctx.refreshCameras();
  }

  /**
   * 작업모드 — 켜면 `W A S D` 로 카메라를 옮기고 `Q E` 로 pan 을 돌린다.
   *
   * 한 걸음은 **미터**라 PTZ 의 도(°)와 단위가 달라 입력칸을 따로 둔다(`camMoveStep`) —
   * 한 칸으로 겹치면 2° 를 돌리려던 사람이 카메라를 2m 옮긴다.
   */
  const work = createWorkMode({
    toggleId: 'camWork',
    noteId: 'camWorkNote',
    stepId: 'camMoveStep',
    ctx,
    target: currentCamera,
    describe: (camera) => `${camera.name ?? 'Camera'} (#${camera.camId})`,
    move: (camera, dx, dy) => moveTo((camera.pos?.x ?? 0) + dx, (camera.pos?.y ?? 0) + dy),
    /**
     * 회전은 pan 이다. 각도는 **`camStep`(°)** 을 읽는다 — 이동의 `camMoveStep` 은 미터라,
     * 그것을 도로 쓰면 2° 를 돌리려던 사람이 카메라를 2m 옮긴다.
     *
     * `cam.setPTZ` 는 **생략한 축을 0·1 로 덮어쓰므로** 셋을 다 실어야 한다.
     */
    async rotate(camera, sign) {
      if (!ptz) await readPtz();
      if (!ptz) throw new Error('현재 PTZ 를 읽지 못했습니다');
      const next = { ...ptz, pan: (ptz.pan ?? 0) + sign * num('camStep') };
      await ctx.rpc('cam.setPTZ', { camId: camera.camId, pan: next.pan, tilt: next.tilt, zoom: next.zoom });
      ptz = next;
      showPtz();
    },
  });

  /** 슬라이더 범위는 사람이 정한다 — 값이 범위 밖이면 범위를 넓혀 **값을 자르지 않는다**. */
  function applyRanges() {
    for (const axis of AXES) {
      const slider = el(axis.slider);
      slider.min = el(axis.min).value;
      slider.max = el(axis.max).value;
    }
  }

  function showPosition() {
    const camera = currentCamera();
    syncing = true;
    for (const axis of AXES) {
      const value = camera?.pos?.[axis.key];
      if (typeof value === 'number') {
        // 값이 슬라이더 범위 밖이면 범위를 벌린다. 안 그러면 슬라이더가 값을 잘라
        // 화면이 실제와 다른 위치를 보여 준다.
        if (value < Number(el(axis.min).value)) el(axis.min).value = String(Math.floor(value) - 1);
        if (value > Number(el(axis.max).value)) el(axis.max).value = String(Math.ceil(value) + 1);
        applyRanges();
        el(axis.slider).value = String(value);
      }
      el(axis.out).textContent = fmt(value);
    }
    syncing = false;
    work.render();
  }

  function showPtz() {
    el('camPan').textContent = fmt(ptz?.pan, 1);
    el('camTilt').textContent = fmt(ptz?.tilt, 1);
    el('camZoom').textContent = fmt(ptz?.zoom, 2);
  }

  async function readPtz() {
    if (!camId()) return;
    ptz = await ctx.rpc('cam.getPTZ', { camId: camId() });
    showPtz();
  }

  /**
   * 방향 패드. `step` 은 pan·tilt 가 도(°), zoom 이 배율이다.
   *
   * **tilt 만 부호를 뒤집는다** — 시뮬레이터에서 tilt 양수가 하향이라, ▲(위)가 보낸
   * `sign:+1` 을 그대로 더하면 카메라가 내려간다.
   */
  async function nudge(axis, sign) {
    if (!ptz) await readPtz();
    if (!ptz) throw new Error('현재 PTZ 를 읽지 못했습니다');
    const towardScreen = axis === 'tilt' ? -1 : 1;
    const step = Number(el('camStep').value) * sign * towardScreen;
    const next = { ...ptz, [axis]: (ptz[axis] ?? 0) + step };
    await ctx.rpc('cam.setPTZ', { camId: camId(), pan: next.pan, tilt: next.tilt, zoom: next.zoom });
    ptz = next;
    showPtz();
  }

  async function movePosition(axis) {
    if (syncing || !camId()) return;
    const value = Number(el(axis.slider).value);
    el(axis.out).textContent = fmt(value);
    // 높이는 전용 메서드가 있다. 평면(X·Y)은 둘이 함께 가야 한 번의 이동이 된다.
    if (axis.key === 'z') {
      await ctx.rpc('cam.setHeight', { camId: camId(), height: value });
    } else {
      // `pos` **객체**여야 한다. 평평하게 보내면 파라미터가 안 잡힌다.
      // 높이(z)도 함께 실어야 이동이 카메라를 바닥으로 떨어뜨리지 않는다.
      await ctx.rpc('cam.setPosition', {
        camId: camId(),
        pos: { x: Number(el('camX').value), y: Number(el('camY').value), z: Number(el('camZ').value) },
      });
    }
    await ctx.refreshCameras();
  }

  const guard = (fn) => (...args) => void fn(...args).catch(ctx.reportError);
  const attempt = (fn) => () => { try { fn(); } catch (error) { ctx.reportError(error); } };

  // --- 파일 프리셋 (다른 두 탭과 같은 형태) ---------------------------------

  el('kList').addEventListener('change', showSavedForm);

  /** 「현재 자세로 추가」 — 지금 시뮬레이터가 보고 있는 값을 그대로 굳힌다. */
  el('kAdd').addEventListener('click', guard(async () => {
    const camera = currentCamera();
    if (camera) {
      el('kCamId').value = camera.camId;
      el('kPosX').value = fmt(camera.pos?.x, 3);
      el('kPosY').value = fmt(camera.pos?.y, 3);
      el('kPosZ').value = fmt(camera.pos?.z, 3);
    }
    if (ptz) {
      el('kPan').value = fmt(ptz.pan, 1);
      el('kTilt').value = fmt(ptz.tilt, 1);
      el('kZoom').value = fmt(ptz.zoom, 2);
    }
    const idx = saved.length ? Math.max(...saved.map((row) => row.idx)) + 1 : 0;
    saved = [...saved, formSaved(idx)];
    bar.markDirty();
    renderSaved(idx);
  }));

  el('kUpdate').addEventListener('click', attempt(() => {
    const row = pickedSaved();
    if (!row) throw new Error('프리셋을 선택하세요');
    saved = saved.map((entry) => (entry.idx === row.idx ? formSaved(row.idx, entry) : entry));
    bar.markDirty();
    renderSaved(row.idx);
  }));

  el('kDelete').addEventListener('click', attempt(() => {
    const row = pickedSaved();
    if (!row) throw new Error('프리셋을 선택하세요');
    saved = saved.filter((entry) => entry.idx !== row.idx);
    bar.markDirty();
    renderSaved('');
  }));

  /**
   * 「이 프리셋으로 이동」 — `cam.applyPreset` 이 죽어 있으므로 **자세를 직접 만든다.**
   * 위치를 먼저, PTZ 를 나중에 보낸다: 반대로 하면 이동 중의 자세가 잠깐 어긋난다.
   */
  el('kApply').addEventListener('click', guard(async () => {
    const row = pickedSaved();
    if (!row) throw new Error('프리셋을 선택하세요');
    if (!confirm(`카메라 #${row.camId} 를 「${row.name}」 자세로 보냅니다.

계속할까요?`)) return;
    await ctx.rpc('cam.setPosition', { camId: row.camId, pos: row.pos });
    await ctx.rpc('cam.setPTZ', { camId: row.camId, pan: row.pan, tilt: row.tilt, zoom: row.zoom });
    await ctx.refreshCameras();
    el('camList').value = String(row.camId);
    showPosition();
    await readPtz();
    ctx.toast(`카메라 #${row.camId} 를 「${row.name}」 자세로 보냈습니다`, 'ok');
  }));

  el('camList').addEventListener('change', guard(async () => {
    ptz = null;
    showPosition();
    await readPtz();
  }));

  for (const axis of AXES) {
    el(axis.slider).addEventListener('input', () => { el(axis.out).textContent = fmt(Number(el(axis.slider).value)); });
    // 이동은 **손을 뗄 때** 한 번만 보낸다. `input` 마다 보내면 드래그 한 번에 수십 번
    // 이동 명령이 나가고 시뮬레이터가 그것을 순서대로 처리하느라 화면이 밀린다.
    el(axis.slider).addEventListener('change', guard(() => movePosition(axis)));
    el(axis.min).addEventListener('change', applyRanges);
    el(axis.max).addEventListener('change', applyRanges);
  }

  el('camRefresh').addEventListener('click', guard(readPtz));
  for (const button of document.querySelectorAll('#panelCam .pad button[data-axis]')) {
    button.addEventListener('click', guard(() => nudge(button.dataset.axis, Number(button.dataset.sign))));
  }

  el('camAdd').addEventListener('click', guard(async () => {
    // `cam.create` 는 파라미터를 받지 않는다(문서 §3) — 시뮬레이터가 자리를 정한다.
    // 원하는 자리는 만든 **뒤에** setPosition 으로 옮긴다.
    const created = await ctx.rpc('cam.create');
    await ctx.refreshCameras();
    const newId = created?.camId;
    if (newId) el('camList').value = String(newId);
    showPosition();
    await readPtz();
    ctx.toast(`카메라를 추가했습니다${newId ? ` (#${newId})` : ''}`, 'ok');
  }));

  el('camDelete').addEventListener('click', guard(async () => {
    if (!camId()) throw new Error('카메라를 선택하세요');
    if (!confirm(`카메라 #${camId()} 를 삭제합니다.\n이 카메라의 영상·프리셋도 함께 사라집니다.\n\n계속할까요?`)) return;
    await ctx.rpc('cam.delete', { camId: camId() });
    await ctx.refreshCameras();
  }));

  /**
   * 영상 클릭 — **Ctrl+왼쪽이면 카메라를 그 자리로** 옮긴다(마스터 지시 2026-08-08).
   * 그냥 클릭은 아무 일도 하지 않는다: 영상에서 카메라 자신을 집을 일이 없다.
   */
  async function viewportClick({ ctrl, ground }) {
    if (!ctrl) return;
    if (!ground) return ctx.toast('그 방향은 지면과 만나지 않습니다 — 지면 쪽을 클릭하세요.', 'err');
    await moveTo(ground.x, ground.y);
    ctx.toast(`카메라 #${camId()} 를 (${fmt(ground.x)}, ${fmt(ground.y)}) 로 옮겼습니다 — 높이는 그대로입니다`, 'ok');
  }

  return {
    isWorkMode: work.isOn,
    onKey: work.onKey,
    onViewportClick: viewportClick,
    clickHelp: 'Ctrl+왼쪽 클릭 = 고른 카메라를 그 자리로 옮깁니다 (높이 유지 · 폴대 동행).',

    onCameras() {
      showPosition();
    },
    async onActivate() {
      applyRanges();
      renderSaved();
      showPosition();
      // 시뮬레이터가 꺼져 있어도 파일 쪽은 뜬다 — PTZ 읽기 실패가 탭을 막지 않는다.
      await readPtz().catch(ctx.reportError);
    },
    async onConnect() {
      applyRanges();
    },
  };
}
