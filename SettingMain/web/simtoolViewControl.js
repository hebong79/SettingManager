const el = (id) => document.getElementById(id);
const fmt = (v, digits = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '-');

/**
 * 메인 뷰(자유 시점) 마우스 제어 — **드래그 회전 · 휠 화각 · 더블클릭 조준**.
 *
 * 2026-08-08 에 언리얼에 신설된 `view.*` 4개를 쓴다. 그 전까지 메인 뷰(13600)는
 * **영상만 나오고 제어가 불가능**했다 — `cam.*` 는 PTZ 카메라(13601+)만 알고,
 * `cam.list` 에 메인 뷰는 나오지도 않는다.
 *
 * ## ⚠ 영상이 5fps 다 — 이 파일의 설계는 거기서 나온다
 *
 * 실측(`cam.streamStatus` main): `targetFps 5 · captureAvgMs 170`. 후처리를 이미 다 끈
 * 상태의 값이라 더 빨라지지 않는다. **RPC 왕복이 아니라 영상 자체의 한계**다.
 *
 * 그래서 두 가지를 한다.
 *   ① **보낸 값을 즉시 화면에 적는다**(`simViewPose`). 영상은 늦게 따라오므로, 숫자가
 *      먼저 움직이지 않으면 사람은 "안 먹었다"고 판단하고 더 끌어서 과회전한다.
 *   ② **한 번에 한 요청만 띄운다**(§ 아래). 프레임마다 보내면 시뮬레이터가 밀린다 —
 *      `simtoolCam.js` 의 위치 슬라이더가 같은 이유로 `change`(손 뗄 때)만 보낸다.
 *
 * ## 한 번에 한 요청, 마지막 것만 살린다
 *
 * 드래그는 초당 수십 번 이벤트가 난다. 큐에 쌓으면 손을 뗀 뒤에도 카메라가 계속 움직이고,
 * 그 지연은 되돌릴 수 없다. 그래서 **응답을 기다리는 동안 온 것은 덮어쓴다** — 중간 값은
 * 버려도 되고(어차피 지나가는 자세다), 마지막 값만 도착하면 된다.
 *
 * ## ⚠ pitch 부호가 `cam.setTilt` 와 반대다
 *
 * `view` 의 `pitch` 는 **양수가 위**(UE FRotator 원본)이고, `cam.setTilt` 의 `tilt` 는
 * **양수가 하향**이다. 환산은 `tilt = -pitch`. 이름이 다른 것이 규약이 다르다는 표식이다.
 * 그래서 마우스를 아래로 끌면 `pitch` 를 **빼야** 아래를 본다.
 *
 * ## `fov` 는 건드린 뒤 되돌릴 수 있어야 한다
 *
 * 언리얼 `SetFOV` 는 `LockedFOV` 를 건다 — 한 번 값을 주면 **앱 재기동 전까지 기본 화각으로
 * 못 돌아간다.** 그래서 `fov: 0` 을 잠금 해제로 두었고(2026-08-08 신설), 「화각 되돌리기」가
 * 그것을 부른다. 이 버튼이 없으면 휠을 한 번 굴린 사람이 원상복구를 못 한다.
 */

/**
 * 회전은 **오른쪽 버튼**이다(마스터 지시 2026-08-08).
 *
 * 왼쪽 버튼으로 끌면 브라우저가 `<img>` 를 **드래그앤드롭으로 집어** 회전이 성립하지 않는다.
 * 오른쪽으로 옮기니 부수 효과가 하나 더 생겼다 — **왼쪽은 순수한 클릭이 되어** 「끈 것인가
 * 누른 것인가」를 가릴 필요가 사라졌다. 언리얼 뷰포트도 오른쪽 버튼으로 시선을 돌린다.
 */
const ROTATE_BUTTON = 2;
/** `MouseEvent.buttons` 의 오른쪽 비트. `button`(어느 것을 눌렀나)과 다른 값이다. */
const ROTATE_BUTTONS_BIT = 2;
/** 이만큼 안 움직이면 회전으로 치지 않는다(손떨림). */
const DRAG_THRESHOLD_PX = 4;
/**
 * WASD 한 걸음(m). 키 반복(누르고 있기)을 막지 않으므로 **누른 시간에 비례해 나아간다** —
 * 반복 1회가 한 걸음이고, 밀린 것은 아래 합치기가 모아 한 번에 보낸다.
 * 5fps 라 부드럽게는 안 가고 **띄엄띄엄 간다**.
 */
const MOVE_STEP_M = 1;
/** 화각 한계. 언리얼은 0 초과 180 미만을 받지만, 양 끝은 쓸모가 없어 더 좁게 잡는다. */
const FOV_MIN = 10;
const FOV_MAX = 150;
/** 휠 한 칸당 화각 변화(도). */
const FOV_STEP = 4;

export function createViewControl(ctx) {
  /** 시뮬레이터가 마지막으로 알려준 상태. **우리가 유일한 쓰기 주체**라 캐시가 유효하다. */
  let pose = null;
  /** 그 시뮬레이터에 `view.*` 가 있는가. 없으면 이 화면 전체가 조용히 꺼진다. */
  let available = false;
  /** 응답을 기다리는 중인가. 한 번에 하나만 띄운다. */
  let inFlight = false;
  /** 아직 못 보낸 마지막 희망값. `{rot?, fov?}` — 나중 것이 앞의 것을 덮는다. */
  let pending = null;
  /** WASD 한 걸음이 오가는 중인가. 회전과 달리 **덮어쓰지 않고 흘려보낸다**(§step). */
  let moving = false;

  // 드래그 상태
  let pressed = false;
  let dragged = false;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;

  const rot = () => pose?.rot ?? { pitch: 0, yaw: 0 };
  const fov = () => (typeof pose?.fov === 'number' ? pose.fov : 90);

  /**
   * `view.*` 가 있는지 물어본다. **없으면 던지지 않고 false 로 답한다** —
   * 신설 전 시뮬레이터에 붙어도 나머지 기능(PTZ·파일)은 멀쩡해야 한다.
   */
  async function probe() {
    try {
      pose = await ctx.rpc('view.get');
      available = true;
    } catch {
      pose = null;
      available = false;
    }
    showPose();
    return available;
  }

  /**
   * 화면의 숫자. **보낸 값을 먼저 적는다** — 영상(5fps)이 따라오기 전에 사람이
   * 명령이 나갔다는 것을 알아야 과회전하지 않는다.
   */
  function showPose() {
    const box = el('simViewPose');
    const at = pose?.pos;
    box.textContent = available && pose
      ? `(${fmt(at?.x)}, ${fmt(at?.y)}, ${fmt(at?.z)}) · pitch ${fmt(rot().pitch)}° · yaw ${fmt(rot().yaw)}° · 화각 ${fmt(fov())}°`
      : '-';
  }

  /** 희망값을 합친다. 같은 축이 여러 번 오면 **마지막 것만** 남는다. */
  function want(patch) {
    pending = { ...(pending ?? {}), ...patch };
    // 화면 숫자는 응답을 기다리지 않는다 — 사람이 즉시 되먹임을 받아야 한다.
    if (patch.rot) pose = { ...(pose ?? {}), rot: patch.rot };
    if (patch.pos) pose = { ...(pose ?? {}), pos: patch.pos };
    if (typeof patch.fov === 'number') pose = { ...(pose ?? {}), fov: patch.fov };
    showPose();
    void flush();
  }

  /**
   * 실제 전송. **응답이 곧 정본**이다 — 요청값을 그대로 믿지 않는다.
   * (언리얼이 pitch 를 ±89 로 자르므로, 우리가 89 를 넘겨 보내도 응답은 89 다.)
   */
  async function flush() {
    if (inFlight || !pending || !available) return;
    inFlight = true;
    const sending = pending;
    pending = null;
    try {
      // **바뀐 것만 보낸다.** fov 를 매번 실으면 안 건드린 휠까지 매 프레임 잠금을 다시 건다.
      pose = await ctx.rpc('view.set', sending);
      showPose();
    } catch (error) {
      // 실패하면 밀린 것을 버린다 — 실패한 자세 위에 다음 델타를 쌓으면 어긋난 채로 굳는다.
      pending = null;
      ctx.reportError(error);
      await probe();
    } finally {
      inFlight = false;
    }
    if (pending) void flush();
  }

  /**
   * 드래그 1픽셀이 몇 도인가. **화각에 비례**시킨다 — 망원(화각이 좁을 때)에서 같은 픽셀이
   * 훨씬 큰 각도면 조작이 튄다. `img` 상자 폭을 쓰므로 레터박스가 있으면 약간 둔해지지만,
   * 감도의 문제일 뿐 좌표가 어긋나지는 않는다.
   */
  function degPerPixel() {
    const width = ctx.image().getBoundingClientRect().width;
    return width > 0 ? fov() / width : 0.1;
  }

  function onDown(event) {
    if (event.button !== ROTATE_BUTTON || !available) return;
    pressed = true;
    dragged = false;
    startX = lastX = event.clientX;
    startY = lastY = event.clientY;
  }

  function onMove(event) {
    if (!pressed || !available) return;
    // **놓친 `mouseup` 을 여기서 회수한다.** 창 밖에서 버튼을 떼면 그 이벤트가 우리에게 오지
    // 않아, 버튼을 놓았는데도 마우스만 움직이면 시점이 계속 돈다.
    // `buttons` 는 지금 눌려 있는 버튼이라 그 상태를 매 이동마다 확인할 수 있다.
    if ((event.buttons & ROTATE_BUTTONS_BIT) === 0) {
      pressed = false;
      dragged = false;
      return;
    }
    if (!dragged && Math.hypot(event.clientX - startX, event.clientY - startY) < DRAG_THRESHOLD_PX) return;
    dragged = true;
    const scale = degPerPixel();
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    want({
      rot: {
        // 오른쪽으로 끌면 오른쪽을 본다(언리얼 뷰포트와 같은 방향).
        yaw: rot().yaw + dx * scale,
        // ⚠ pitch 는 양수가 **위**다. 아래로 끌면(dy>0) 아래를 봐야 하므로 뺀다.
        pitch: rot().pitch - dy * scale,
      },
    });
  }

  /**
   * 손을 뗐다. 회전이 오른쪽 버튼으로 옮겨간 뒤로 **왼쪽 클릭과 겹치지 않으므로**
   * 「끈 것인가 누른 것인가」를 껍데기에 알려 줄 필요가 없다 — 상태만 지운다.
   */
  function onUp() {
    pressed = false;
    dragged = false;
  }

  /** WASD → 어느 축으로 얼마나. **물리 키 위치**라 자판 배치·입력기와 무관하다. */
  const STEPS = {
    KeyW: ['forward', 1],
    KeyS: ['forward', -1],
    KeyD: ['right', 1],
    KeyA: ['right', -1],
  };

  /**
   * WASD 이동. **방향 벡터는 서버가 만든다**(`/api/sim/view/move`).
   *
   * 화면이 yaw·pitch 로 방향을 직접 계산하면 카메라 규약이 두 벌이 되고, 그 실패는 오류로
   * 뜨지 않는다 — 카메라가 조금 엇나간 쪽으로 갈 뿐이다. 특히 **메인 뷰의 pitch 는 양수가
   * 위**로 `cam.setTilt` 와 반대라, 그 부호가 화면에도 있으면 언젠가 반드시 갈린다.
   * (이 저장소는 그 규율을 테스트로 지킨다 — 화면 스크립트에 삼각함수를 두지 않는다.)
   *
   * 서버가 **지금 자세를 직접 읽어** 옮기므로, 다른 곳에서 시점을 움직였어도 옛 값 위에
   * 걸음을 쌓지 않는다.
   *
   * 키를 누르고 있으면 반복이 들어오지만 **한 번에 하나만 보낸다** — 오는 족족 보내면
   * 손을 뗀 뒤에도 한참 더 나아간다. 왕복 한 번에 한 걸음이라 대략 초당 5걸음이다.
   */
  function step(code) {
    const wanted = STEPS[code];
    if (!wanted || !available) return false;
    if (moving) return true;   // 눌린 것은 맞으므로 브라우저 기본 동작은 막는다
    moving = true;
    const [axis, sign] = wanted;
    void ctx.move(axis, sign * MOVE_STEP_M)
      .then((answer) => {
        // 응답이 정본이다 — 우리가 보낸 걸음이 아니라 시뮬레이터가 실제로 간 자리를 적는다.
        if (answer?.result) { pose = answer.result; showPose(); }
      })
      .catch(ctx.reportError)
      .finally(() => { moving = false; });
    return true;
  }

  /** 휠 = 화각. 위로 굴리면 좁아진다(당겨 본다). */
  function onWheel(event) {
    if (!available) return;
    event.preventDefault();
    const next = fov() + (event.deltaY > 0 ? FOV_STEP : -FOV_STEP);
    want({ fov: Math.min(FOV_MAX, Math.max(FOV_MIN, next)) });
  }

  /**
   * 더블클릭 = 그 지점을 바라본다. **자리는 그대로 두고 방향만** 돌린다
   * (`distance` 를 주면 그 거리로 이동해 버려, 두 번 누른 사람이 놀란다).
   */
  async function lookAt(pixel) {
    if (!available) return;
    const hit = await ctx.rpc('view.pick', { x: pixel.x, y: pixel.y });
    if (!hit?.hit) return ctx.toast('그 방향에는 조준할 것이 없습니다.', 'err');
    pose = await ctx.rpc('view.lookAt', { world: hit.world });
    showPose();
  }

  /** 화각 잠금 해제(`fov: 0`). 휠을 굴린 뒤 기본 화각으로 되돌리는 유일한 길이다. */
  async function resetFov() {
    if (!available) return;
    pending = null;
    pose = await ctx.rpc('view.set', { fov: 0 });
    showPose();
    ctx.toast('화각을 기본값으로 되돌렸습니다', 'ok');
  }

  return {
    probe,
    isAvailable: () => available,
    /** 메인 뷰 영상이 나가는 포트. 시뮬레이터가 알려준 값이지 우리가 조립한 것이 아니다. */
    mainStreamPort: () => (available ? Number(pose?.streamPort) || 0 : 0),
    onDown,
    onMove,
    onUp,
    onWheel,
    step,
    lookAt,
    resetFov,
    showPose,
  };
}
