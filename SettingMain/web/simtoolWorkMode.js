const el = (id) => document.getElementById(id);

/**
 * 「작업모드」 — **키보드와 Ctrl+클릭의 소유권 플래그** (마스터 지시 2026-08-08).
 *
 * 켜지면 그 탭이 키보드를 가져간다: `W A S D` 로 **선택된 오브젝트**를 옮기고 `Q E` 로
 * 돌린다. 꺼져 있으면 `W A S D` 는 기존대로 **메인 뷰 시점**을 움직인다
 * (`simtoolViewControl.js`).
 *
 * ## 왜 공용으로 두는가
 *
 * 세 탭(프리셋·차량·카메라)이 같은 규율을 필요로 한다 — 특히 **키 반복 억제**(§아래)는
 * 빠뜨려도 오류로 뜨지 않고 "손을 뗐는데 계속 간다"로만 나타난다. 세 벌로 두면 한 곳만
 * 고치는 날이 온다. 탭은 「대상이 무엇인가」와 「어떻게 옮기는가」만 준다.
 *
 * ## ⚠ 이동 축은 **월드**다 — 화면 기준이 아니다
 *
 * `W` 를 「화면에서 위쪽」으로 만들려면 메인 뷰의 yaw 로 축을 돌려야 하는데, 그 삼각함수가
 * 화면에 들어오는 순간 **카메라 규약이 두 벌**이 된다. 메인 뷰 WASD 를 서버로 넘긴 것도
 * 같은 이유였고, 이 저장소는 그것을 테스트로 지킨다.
 *
 * 그래서 **기존 방향 패드와 같은 월드 축**을 쓴다 — 프리셋 탭의 ▲▼◀▶ 와 정확히 같은 뜻이라
 * 사람이 두 규약을 외우지 않는다. (언리얼은 Z-up 이라 평면이 x·y 다.)
 */
const MOVES = {
  KeyW: [0, 1],
  KeyS: [0, -1],
  KeyD: [1, 0],
  KeyA: [-1, 0],
};

/** `E` 가 +, `Q` 가 −. 어느 쪽이 시계인지는 시뮬레이터 규약이라 화면이 정하지 않는다. */
const TURNS = { KeyE: 1, KeyQ: -1 };

/**
 * @param spec.toggleId  작업모드 체크박스 id
 * @param spec.noteId    이 탭의 작업모드 안내 문단 id
 * @param spec.stepId    한 걸음 크기 입력칸 id (m / °)
 * @param spec.target    지금 움직일 것. 없으면 `null` — **지어내지 않는다**
 * @param spec.describe  대상을 사람 말로. 안내에 그대로 적힌다
 * @param spec.move      `(target, dx, dy)` → Promise. 월드 x·y 방향, 이미 step 이 곱해져 있다
 * @param spec.rotate    `(target, sign)` → Promise. **각도 단위는 탭이 정한다** —
 *                       `stepId` 는 이동(m)용이라, 카메라처럼 회전 단위가 다른 탭은
 *                       자기 입력칸(°)을 따로 읽는다. 여기서 step 을 곱해 주면 2° 를
 *                       돌리려던 사람이 2m 를 움직인다.
 * @param spec.ctx       껍데기 계약 (`toast`·`reportError`·`workModeChanged`)
 */
export function createWorkMode(spec) {
  /**
   * 한 걸음이 오가는 중인가. **키를 누르고 있으면 브라우저가 초당 수십 번 `keydown` 을
   * 준다** — 오는 족족 보내면 손을 뗀 뒤에도 오브젝트가 한참 더 간다. 응답을 기다리는
   * 동안 온 것은 **버린다**(회전과 달리 마지막 것을 살릴 이유가 없다 — 걸음은 누적이라
   * 하나를 버리면 그만큼 덜 갈 뿐, 어긋난 자리에 굳지 않는다).
   */
  let busy = false;

  const isOn = () => el(spec.toggleId).checked;
  const step = () => {
    const value = Number(el(spec.stepId).value);
    return Number.isFinite(value) && value !== 0 ? value : 0.5;
  };

  function render() {
    const note = el(spec.noteId);
    if (!isOn()) {
      note.className = 'hint';
      note.textContent = '작업모드를 켜면 키보드와 Ctrl+클릭이 이 탭으로 옵니다'
        + ' — 지금은 W A S D 가 메인 뷰 시점을 움직입니다.';
      return;
    }
    const target = spec.target();
    note.className = target ? 'hint ready' : 'hint warn';
    note.textContent = target
      ? `대상 「${spec.describe(target)}」 — W A S D 이동(한 걸음 ${step()}) · Q E 회전.`
        + ' 축은 방향 패드와 같은 월드 기준입니다(화면 기준이 아닙니다).'
      : '작업모드가 켜져 있지만 선택된 것이 없습니다 — 위 목록에서 고르세요.';
  }

  /**
   * 키 하나. **처리했으면 `true`** — 껍데기가 그때만 브라우저 기본 동작을 막고,
   * 아니면 메인 뷰 시점 이동으로 흘려보낸다.
   */
  function onKey(code) {
    if (!isOn()) return false;
    const moved = MOVES[code];
    const turned = TURNS[code];
    if (!moved && turned === undefined) return false;
    // 눌린 것은 맞으므로 여기서부터는 언제나 `true` 다 — 밀린 걸음을 버리더라도
    // 그 키가 페이지 스크롤로 새어 나가면 안 된다.
    if (busy) return true;
    const target = spec.target();
    if (!target) {
      spec.ctx.toast('작업모드 대상이 없습니다 — 목록에서 고르세요.', 'err');
      return true;
    }
    busy = true;
    const run = moved
      ? spec.move(target, moved[0] * step(), moved[1] * step())
      : spec.rotate(target, turned);
    void Promise.resolve(run)
      .catch(spec.ctx.reportError)
      .finally(() => { busy = false; render(); });
    return true;
  }

  el(spec.toggleId).addEventListener('change', () => {
    render();
    // 껍데기의 메인 뷰 안내가 **누가 키보드를 갖고 있는지** 말한다 — 안 말하면
    // "WASD 가 안 먹는다"가 고장으로 읽힌다.
    spec.ctx.workModeChanged();
  });

  return { isOn, onKey, render };
}
