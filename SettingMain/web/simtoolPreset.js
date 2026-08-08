import { createFileBar } from './simtoolFileBar.js';
import { createWorkMode } from './simtoolWorkMode.js';

const el = (id) => document.getElementById(id);
const num = (id) => Number(el(id).value);
const fmt = (v, digits = 3) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '');

/**
 * 프리셋 메이커 — **주차면 그룹**을 짓고 파일로 굳히고 시뮬레이터에 보낸다.
 *
 * 파일 막대(새로 만들기·열기…·저장…)는 세 툴이 공유한다 — `simtoolFileBar.js`.
 *
 * ## 왜 `preset.list`(RPC)로 목록을 채우지 않는가 (마스터 결정 2026-08-07)
 *
 * 시뮬레이터는 **위젯 목록과 RPC 목록을 따로** 갖고 있다. `preset.list` 는 RPC 가 만든
 * 것만 보여 주므로 사람이 시뮬레이터 UI 로 그린 배치는 **거기 안 보인다**(실측: 빈 배열).
 * 근거: `docs/reference/unreal/20260807_173431_Park3D_RPC_메서드_목록.md` §5.
 *
 * ## 좌표는 RPC 계 하나만 쓴다
 *
 * 축을 바꾸는 자리는 **서버 한 곳**이다(`simCoords.ts`). 화면이 두 좌표계를 동시에 들면
 * 반드시 섞이고, 그 실패는 오류로 뜨지 않는다 — 좌표가 "그럴듯하게" 틀리기 때문이다.
 */
export function createPresetPanel(ctx) {
  let presets = [];

  const bar = createFileBar({
    kind: 'preset',
    resultKey: 'presets',
    defaultName: '001_Preset_new.json',
    ids: { newButton: 'spNew', openButton: 'spOpen', openInput: 'spOpenInput', saveButton: 'spSave', status: 'spStatus' },
    getRows: () => presets,
    setRows: (rows) => { presets = rows; renderList(''); },
    ctx,
  });

  const selected = () => presets.find((preset) => String(preset.idx) === el('spList').value);

  /**
   * 프리셋을 평면으로 **얼마만큼** 옮긴다.
   *
   * ## ⚠ `preset.move` 의 `delta` 는 시뮬레이터가 **조용히 무시한다**
   *
   * 실측(2026-08-08, 라이브 13510): `preset.move {idx:1, delta:{x:0,y:5}}` 는
   * `{ok:true, x, y, z}` 를 주는데 **좌표가 그대로다.** `to` 는 정상 동작한다.
   * 응답이 성공이라 화면은 실패를 알 수 없다 — 오류로 뜨지 않고 그냥 안 움직인다.
   *
   * 그래서 **지금 자리를 읽어 절대(`to`)로 보낸다.** 왕복이 한 번 늘지만, 그 대신
   * 「눌렀는데 아무 일도 안 일어난다」가 사라진다. `preset.get` 이 주는 `offsetPos` 는
   * `to` 와 같은 좌표계다(`/api/sim/rpc` 는 그대로 통과시킨다).
   *
   * **방향 패드도 같은 함정에 빠져 있었다** — 이 저장소가 처음부터 `delta` 를 보내고 있었다.
   * 같은 자리를 쓰게 해서 한쪽만 고쳐지는 일이 없게 한다.
   */
  async function movePreset(idx, dx, dy) {
    const now = await ctx.rpc('preset.get', { idx });
    const at = now?.offsetPos ?? {};
    await ctx.rpc('preset.move', { idx, to: { x: (at.x ?? 0) + dx, y: (at.y ?? 0) + dy } });
  }

  /**
   * 작업모드 — 켜면 `W A S D` 로 이 프리셋을 옮기고 `Q E` 로 돌린다.
   *
   * 회전은 **그룹 회전**(`deltaGroupRot`)이다. 면 회전(`deltaFaceRot`)은 그룹 안에서 각 면이
   * 도는 것이라 「오브젝트를 돌린다」는 몸짓과 다르고, 방향 패드에 이미 있다(◀▶).
   */
  const work = createWorkMode({
    toggleId: 'spWork',
    noteId: 'spWorkNote',
    stepId: 'spStep',
    ctx,
    target: selected,
    describe: (preset) => `${preset.idx}. ${preset.presetName ?? ''}`,
    move: (preset, dx, dy) => movePreset(preset.idx, dx, dy),
    // `spStep` 하나가 m 이자 ° 다 — 방향 패드가 이미 그렇게 쓰고 있어 규약을 나누지 않는다.
    rotate: (preset, sign) => ctx.rpc('preset.rotate', { idx: preset.idx, deltaGroupRot: sign * num('spStep') }),
  });

  function renderList(keepIdx) {
    const previous = keepIdx ?? el('spList').value;
    el('spList').replaceChildren(...presets.map((preset) =>
      new Option(`${preset.idx}. ${preset.presetName ?? ''}  (면 ${preset.faceCount ?? '-'})`, String(preset.idx))));
    if (previous && presets.some((preset) => String(preset.idx) === String(previous))) el('spList').value = String(previous);
    el('presetCount').textContent = `${presets.length}개`;
    bar.render();
    showSelected();
    work.render();
  }

  function showSelected() {
    const preset = selected();
    if (!preset) return;
    el('spIdx').value = preset.idx;
    el('spName').value = preset.presetName ?? '';
    el('spFaceCount').value = preset.faceCount ?? '';
    el('spCamIdx').value = preset.camIdx ?? 1;
    el('spOffsetX').value = fmt(preset.offset?.x);
    el('spOffsetY').value = fmt(preset.offset?.y);
    el('spOffsetZ').value = fmt(preset.offset?.z);
    el('spGroupRot').value = preset.groupRot ?? 0;
    el('spFaceRot').value = preset.faceRot ?? 0;
    el('spXSize').value = preset.xSize ?? 2.5;
    el('spZSize').value = preset.zSize ?? 5;
    el('spDirType').value = String(preset.dirType ?? 0);
    el('spBaseWidth').checked = preset.useBaseWidth !== false;
    el('spDerived').textContent = preset.derived
      ? `각도 ${preset.derived.angleDeg ?? '-'}° | step폭 ${preset.derived.stepWidthM ?? '-'}m | 전체 X폭 ${preset.derived.totalXM ?? '-'}m`
      : '파생값은 시뮬레이터가 실어 줄 때만 표시됩니다 — 웹에서 계산하지 않습니다.';
  }

  /** 폼 → 프리셋 1건. 여기서만 값을 읽으므로 추가·수정이 같은 규칙을 쓴다. */
  function formPreset(idx) {
    const faceCount = num('spFaceCount');
    if (!Number.isFinite(faceCount) || faceCount < 1) throw new Error('Face Count 는 1 이상이어야 합니다');
    return {
      idx,
      presetName: el('spName').value.trim() || `Preset ${idx}`,
      faceCount,
      offset: { x: num('spOffsetX'), y: num('spOffsetY'), z: num('spOffsetZ') },
      faceRot: num('spFaceRot'),
      groupRot: num('spGroupRot'),
      xSize: num('spXSize'),
      zSize: num('spZSize'),
      dirType: num('spDirType'),
      useBaseWidth: el('spBaseWidth').checked,
      camIdx: num('spCamIdx'),
    };
  }

  /** 가장 큰 번호 + 1. 실측 파일의 idx 는 연속이 아니다(1~5, 7) — 개수로 매기면 겹친다. */
  const nextIdx = () => (presets.length ? Math.max(...presets.map((p) => p.idx)) + 1 : 1);

  const guard = (fn) => (...args) => void fn(...args).catch(ctx.reportError);
  const attempt = (fn) => () => { try { fn(); } catch (error) { ctx.reportError(error); } };

  /**
   * 목록을 고르면 **시뮬레이터의 그 프리셋도 고른다**(마스터 지시 2026-08-08).
   *
   * ## ⚠ 작업모드일 때만 시뮬레이터를 두드린다
   *
   * 이 목록은 **파일**에서 온 것이고 시뮬레이터의 프리셋과 **다른 축**이다(§파일 상단).
   * 파일에 6건이 있고 시뮬레이터가 비어 있으면, 목록을 훑는 것만으로 매번 오류가 난다.
   * 작업모드가 "지금 나는 시뮬레이터를 몰고 있다"는 선언이므로 그때만 부른다 —
   * 실패는 **삼키지 않고** 말한다(고른 줄 알고 키보드를 누르면 엉뚱한 것이 움직인다).
   */
  el('spList').addEventListener('change', () => {
    showSelected();
    work.render();
    const preset = selected();
    if (!work.isOn() || !preset) return;
    void ctx.rpc('preset.select', { idx: preset.idx }).catch(ctx.reportError);
  });

  el('spAdd').addEventListener('click', attempt(() => {
    // 번호는 비어 있으면 자동으로 매기고 사람이 적었으면 그것을 쓴다 —
    // 다만 **겹치면 거절한다**: 같은 번호가 둘이면 어느 것을 고쳤는지 알 수 없다.
    const typed = num('spIdx');
    const idx = Number.isFinite(typed) && typed >= 1 ? typed : nextIdx();
    if (presets.some((preset) => preset.idx === idx)) throw new Error(`이미 있는 번호입니다: ${idx}`);
    presets = [...presets, formPreset(idx)].sort((a, b) => a.idx - b.idx);
    bar.markDirty();
    renderList(idx);
  }));

  el('spUpdate').addEventListener('click', attempt(() => {
    const preset = selected();
    if (!preset) throw new Error('프리셋을 선택하세요');
    // 번호는 바꾸지 않는다 — 목록의 정체성이라, 바꾸려면 지우고 다시 넣는 편이 명확하다.
    presets = presets.map((entry) => (entry.idx === preset.idx ? formPreset(preset.idx) : entry));
    bar.markDirty();
    renderList(preset.idx);
  }));

  el('spDelete').addEventListener('click', attempt(() => {
    const preset = selected();
    if (!preset) throw new Error('프리셋을 선택하세요');
    presets = presets.filter((entry) => entry.idx !== preset.idx);
    bar.markDirty();
    renderList('');
  }));

  /**
   * 목록을 시뮬레이터에 밀어 넣는다. **`preset.clear` 로 시작하므로** 시뮬레이터가 그려 둔
   * 것이 사라진다 — 확인을 받는다. 하나가 실패해도 멈추지 않는다(멈추면 시뮬레이터가
   * 반쯤 지워진 채 남는다). `preset.create` 가 번호를 스스로 매기므로 바뀐 번호도 알린다.
   */
  async function push() {
    if (!presets.length) throw new Error('보낼 프리셋이 없습니다');
    if (!confirm(
      `${bar.origin()} 의 주차면 프리셋 ${presets.length}개를 시뮬레이터로 보냅니다.\n\n`
      + '⚠ 시뮬레이터의 기존 주차면이 **전부 사라집니다** — 시뮬레이터 UI 로 그린 것도 포함됩니다.\n\n계속할까요?',
    )) return;

    await ctx.rpc('preset.clear');
    const sent = [];
    const failed = [];
    for (const preset of presets) {
      try {
        const created = await ctx.rpc('preset.create', {
          presetName: preset.presetName, faceCount: preset.faceCount, offset: preset.offset,
          faceRot: preset.faceRot, groupRot: preset.groupRot, dirType: preset.dirType,
          camIdx: preset.camIdx, useBaseWidth: preset.useBaseWidth, xSize: preset.xSize, zSize: preset.zSize,
        });
        sent.push({ from: preset.idx, to: created?.idx ?? '?' });
      } catch (error) {
        failed.push(`${preset.idx} (${error.message})`);
        if (failed.length >= 5) { failed.push('… 이후 중단'); break; }
      }
    }
    await ctx.rpc('preset.renumber').catch(() => undefined);
    const moved = sent.filter((entry) => String(entry.from) !== String(entry.to));
    ctx.toast(
      `${sent.length}/${presets.length}개를 보냈습니다.`
      + (moved.length ? ` 번호 변경 ${moved.length}건: ${moved.map((m) => `${m.from}→${m.to}`).join(', ')}.` : '')
      + (failed.length ? ` 실패: ${failed.join(' / ')}` : ''),
      failed.length ? 'err' : 'ok',
    );
  }

  el('spPush').addEventListener('click', guard(push));

  el('spClear').addEventListener('click', guard(async () => {
    if (!confirm('시뮬레이터의 주차면 프리셋을 전부 지웁니다.\n\n⚠ 시뮬레이터 UI 로 그린 것도 함께 사라집니다.\n(이 화면의 목록은 그대로입니다)\n\n계속할까요?')) return;
    await ctx.rpc('preset.clear');
    ctx.toast('시뮬레이터 프리셋을 비웠습니다', 'ok');
  }));

  /** 3D 는 **전역 토글**이다 — `preset.setBoxVisible`(면 단위)은 동작하지 않는다(문서 §10). */
  el('spUse3d').addEventListener('change', guard(async () => {
    await ctx.rpc('preset.rebuildAll', { showQubeBox: el('spUse3d').checked });
  }));

  /** 방향 패드 — **시뮬레이터의** 선택된 프리셋을 움직인다. 이 화면의 목록은 안 바뀐다. */
  async function nudge(dx, dy) {
    const preset = selected();
    if (!preset) throw new Error('프리셋을 선택하세요');
    const step = Number(el('spStep').value);
    if (el('spModeRotate').checked) {
      await ctx.rpc('preset.rotate', { idx: preset.idx, deltaFaceRot: dx * step, deltaGroupRot: dy * step });
    } else {
      // RPC 계에서 지면은 x·y 다(높이가 z). ⚠ `delta` 는 시뮬레이터가 조용히 무시하므로
      // `movePreset` 이 지금 자리를 읽어 절대값으로 보낸다 — 그 사유는 거기 적혀 있다.
      await movePreset(preset.idx, dx * step, dy * step);
    }
  }

  el('spLeft').addEventListener('click', guard(() => nudge(-1, 0)));
  el('spRight').addEventListener('click', guard(() => nudge(1, 0)));
  el('spUp').addEventListener('click', guard(() => nudge(0, 1)));
  el('spDown').addEventListener('click', guard(() => nudge(0, -1)));

  el('spRenumber').addEventListener('click', guard(async () => {
    const result = await ctx.rpc('preset.renumber');
    const rows = Array.isArray(result) ? result : (result?.assignments ?? []);
    ctx.toast(`주차면 번호를 재계산했습니다 (${rows.length}개)`, 'ok');
  }));

  el('spSimSave').addEventListener('click', guard(async () => {
    const name = prompt('시뮬레이터 디스크에 저장할 파일명', bar.fileName() || '001_Preset_new.json');
    if (!name) return;
    await ctx.rpc('preset.save', { fileName: name });
    ctx.toast(`시뮬레이터 디스크에 ${name} 로 저장했습니다`, 'ok');
  }));

  el('spSimLoad').addEventListener('click', guard(async () => {
    const name = prompt('시뮬레이터 디스크에서 열 파일명', bar.fileName() || '001_Preset_new.json');
    if (!name) return;
    if (!confirm(`시뮬레이터가 자기 디스크의 ${name} 을 엽니다.\n\n⚠ 지금 시뮬레이터에 있는 주차면이 대체됩니다.\n(이 화면의 목록은 그대로입니다)\n\n계속할까요?`)) return;
    await ctx.rpc('preset.load', { fileName: name });
    ctx.toast(`시뮬레이터가 ${name} 을 열었습니다`, 'ok');
  }));

  /**
   * 영상 클릭. **Ctrl+왼쪽 = 클릭한 자리로 프리셋을 옮긴다**(마스터 지시 2026-08-08).
   *
   * `preset.move` 의 **절대(`to`)** 를 쓴다 — 방향 패드가 쓰는 상대(`delta`)로 하려면 지금
   * 위치를 알아야 하고, 그 값은 우리가 아니라 시뮬레이터가 갖고 있다. 한 번 더 물어
   * 빼는 것보다 "여기로 가라"고 말하는 편이 짧고, 중간에 누가 옮겨도 어긋나지 않는다.
   *
   * 그냥 클릭은 **아무 일도 하지 않는다.** 프리셋을 영상에서 집는 수단이 없기 때문이다
   * (`view.pick` 은 차량 액터만 알려준다) — 목록으로 고른다.
   */
  async function viewportClick({ ctrl, ground }) {
    if (!ctrl) return;
    const preset = selected();
    if (!preset) throw new Error('프리셋을 선택하세요');
    // 빗나간 클릭에 좌표를 지어내지 않는다 — 프리셋이 하늘로 날아간다.
    if (!ground) return ctx.toast('그 방향은 지면과 만나지 않습니다 — 지면 쪽을 클릭하세요.', 'err');
    // 높이(z)는 보내지 않는다. 클릭이 맞힌 것은 지형이고 프리셋의 높이는 사람이 정한
    // Offset Z 라, 여기서 덮어쓰면 「상세」의 값과 시뮬레이터가 조용히 갈린다.
    await ctx.rpc('preset.move', { idx: preset.idx, to: { x: ground.x, y: ground.y } });
    ctx.toast(`프리셋 ${preset.idx} 를 (${fmt(ground.x, 2)}, ${fmt(ground.y, 2)}) 로 옮겼습니다 — 시뮬레이터만 바뀝니다`, 'ok');
  }

  return {
    isWorkMode: work.isOn,
    onKey: work.onKey,
    onViewportClick: viewportClick,
    /** 이 탭이 클릭으로 하는 일. 껍데기의 「영상 클릭」 안내가 그대로 적는다. */
    clickHelp: 'Ctrl+왼쪽 클릭 = 고른 프리셋을 그 자리로 옮깁니다 (시뮬레이터만 바뀝니다).',

    // 파일도 시뮬레이터도 자동으로 읽지 않는다 — 편집 중인 목록을 덮어쓰면 안 되고,
    // 탭을 여는 것만으로 시뮬레이터를 두드릴 이유도 없다.
    onActivate() { renderList(); },
  };
}
