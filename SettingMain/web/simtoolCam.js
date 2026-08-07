const el = (id) => document.getElementById(id);
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
 * ## 상대 이동을 절대값으로 보낸다
 *
 * `cam.setPTZ` 에 속도 파라미터가 없다. 없는 파라미터를 지어 보내면 서버가 조용히 버려
 * "속도를 줬는데 왜 안 먹지"가 된다. 그래서 **현재값 + step** 을 절대값으로 보낸다.
 */
export function createCamPanel(ctx) {
  let ptz = null;
  let syncing = false;

  const AXES = [
    { key: 'z', slider: 'camZ', min: 'camZMin', max: 'camZMax', out: 'camZOut' },
    { key: 'x', slider: 'camX', min: 'camXMin', max: 'camXMax', out: 'camXOut' },
    { key: 'y', slider: 'camY', min: 'camYMin', max: 'camYMax', out: 'camYOut' },
  ];

  const camId = () => Number(el('camList').value);

  function currentCamera() {
    return ctx.cameras().find((camera) => String(camera.camId) === el('camList').value);
  }

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

  /** 방향 패드. `step` 은 pan·tilt 가 도(°), zoom 이 배율이다. */
  async function nudge(axis, sign) {
    if (!ptz) await readPtz();
    if (!ptz) throw new Error('현재 PTZ 를 읽지 못했습니다');
    const step = Number(el('camStep').value) * sign;
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
      await ctx.rpc('cam.setPosition', {
        camId: camId(),
        x: Number(el('camX').value),
        y: Number(el('camY').value),
      });
    }
    await ctx.refreshCameras();
  }

  const guard = (fn) => (...args) => void fn(...args).catch(ctx.reportError);

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
    const camera = currentCamera();
    // 새 카메라는 **지금 보고 있는 카메라 옆**에 세운다. 원점에 세우면 맵 밖일 수 있고,
    // 그러면 만들자마자 어디로 갔는지 찾아야 한다.
    const pos = camera?.pos ? { x: camera.pos.x + 5, y: camera.pos.y, z: camera.pos.z } : { x: 0, y: 0, z: 5 };
    await ctx.rpc('cam.create', { pos });
    await ctx.refreshCameras();
    ctx.toast('카메라를 추가했습니다', 'ok');
  }));

  el('camDelete').addEventListener('click', guard(async () => {
    if (!camId()) throw new Error('카메라를 선택하세요');
    if (!confirm(`카메라 #${camId()} 를 삭제합니다.\n이 카메라의 영상·프리셋도 함께 사라집니다.\n\n계속할까요?`)) return;
    await ctx.rpc('cam.delete', { camId: camId() });
    await ctx.refreshCameras();
  }));

  el('camPresetSave').addEventListener('click', guard(async () => {
    await ctx.rpc('cam.savePreset', { camId: camId(), presetId: Number(el('camPresetId').value) });
    ctx.toast('카메라 프리셋을 저장했습니다', 'ok');
  }));

  el('camPresetApply').addEventListener('click', guard(async () => {
    await ctx.rpc('cam.applyPreset', { camId: camId(), presetId: Number(el('camPresetId').value) });
    await readPtz();
    await ctx.refreshCameras();
  }));

  return {
    onCameras() {
      showPosition();
    },
    async onActivate() {
      applyRanges();
      showPosition();
      await readPtz();
    },
    async onConnect() {
      applyRanges();
    },
  };
}
