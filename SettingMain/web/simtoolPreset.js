import { wireOpenDialog, wireSaveDialog } from './simtoolOpen.js';

const el = (id) => document.getElementById(id);
const num = (id) => Number(el(id).value);
const fmt = (v, digits = 3) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '');

/**
 * 프리셋 메이커 — **주차면 그룹**을 만들고 파일로 굳히고 시뮬레이터에 보낸다.
 *
 * ## 세 곳이 서로 다른 것을 들고 있다
 *
 * | 어디 | 무엇 |
 * |---|---|
 * | **이 화면** | 지금 편집 중인 목록. 「추가·수정·삭제」가 바꾸는 곳 |
 * | **PC 파일** | 「열기…」로 읽고 「저장…」으로 굳힌다 (표준 위치 `SettingMain/save/3D/Preset`) |
 * | **시뮬레이터** | 「시뮬로 보내기」가 반영한다 |
 *
 * 셋을 한 덩어리로 보이게 만들면 어느 것을 고쳤는지 알 수 없게 된다. 그래서 **버튼마다
 * 무엇을 건드리는지 화면에 적어 두고**, 편집은 파일도 시뮬레이터도 건드리지 않는다.
 *
 * ## 왜 `preset.list`(RPC)로 목록을 채우지 않는가 (마스터 결정 2026-08-07)
 *
 * 시뮬레이터는 **위젯 목록과 RPC 목록을 따로** 갖고 있다. `preset.list` 는 RPC 가 만든
 * 것만 보여 주므로 사람이 시뮬레이터 UI 로 그린 배치는 **거기 안 보인다**(실측: 빈 배열).
 * 근거: `docs/reference/unreal/20260807_173431_Park3D_RPC_메서드_목록.md` §5.
 *
 * ## 좌표는 RPC 계 하나만 쓴다
 *
 * 저장 파일은 Unity(Y-up), RPC 는 언리얼(Z-up)이고 축을 바꾸는 자리는 **서버 한 곳**이다
 * (`simCoords.ts`). 화면이 두 좌표계를 동시에 들면 반드시 섞이고, 그 실패는 오류로 뜨지
 * 않는다 — 좌표가 "그럴듯하게" 틀리기 때문이다.
 */
export function createPresetPanel(ctx) {
  let presets = [];
  /** 지금 목록이 어디서 왔는가. 「보내기」·「저장」 전에 무엇을 다루는지 알아야 한다. */
  let origin = '새 목록';
  /** 파일로 굳히지 않은 편집이 있는가. 「새로 만들기」·「열기」가 확인을 받는 근거다. */
  let dirty = false;
  /** 마지막으로 쓴 파일명. 「저장…」의 기본 이름이 된다. */
  let fileName = '';

  const selected = () => presets.find((preset) => String(preset.idx) === el('spList').value);

  function setStatus() {
    el('presetCount').textContent = `${presets.length}개`;
    el('spSource').textContent = `${origin}${dirty ? ' · 저장 안 함' : ''}`;
    el('spSource').className = dirty ? 'warn' : 'hint';
  }

  function renderList(keepIdx) {
    const previous = keepIdx ?? el('spList').value;
    el('spList').replaceChildren(...presets.map((preset) =>
      new Option(`${preset.idx}. ${preset.presetName ?? ''}  (면 ${preset.faceCount ?? '-'})`, String(preset.idx))));
    if (previous && presets.some((preset) => String(preset.idx) === String(previous))) el('spList').value = String(previous);
    setStatus();
    showSelected();
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
    showDerived(preset);
  }

  /** 언리얼이 준 것만 적는다. 배치 규칙은 그쪽이 소유하므로 여기서 계산하지 않는다. */
  function showDerived(preset) {
    el('spDerived').textContent = preset?.derived
      ? `각도 ${preset.derived.angleDeg ?? '-'}° | 1개 step폭 ${preset.derived.stepWidthM ?? '-'}m | 전체 X폭 ${preset.derived.totalXM ?? '-'}m`
      : '파생값(각도·step폭·전체X폭)은 시뮬레이터가 실어 줄 때만 표시됩니다 — 웹에서 계산하지 않습니다.';
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

  /** 비어 있지 않은 번호 중 가장 큰 것 + 1. 실측 파일의 idx 는 연속이 아니다(1~5, 7). */
  const nextIdx = () => (presets.length ? Math.max(...presets.map((p) => p.idx)) + 1 : 1);

  /** 저장하지 않은 편집을 버리기 전에 묻는다. */
  function confirmDiscard(what) {
    return !dirty || confirm(`저장하지 않은 편집이 있습니다.\n${what} 하면 사라집니다.\n\n계속할까요?`);
  }

  function replaceAll(rows, label, name = '') {
    presets = rows;
    origin = label;
    fileName = name;
    dirty = false;
    renderList('');
  }

  const guard = (fn) => (...args) => void fn(...args).catch(ctx.reportError);

  // --- 새로 만들기 · 열기 · 저장 -------------------------------------------

  el('spNew').addEventListener('click', () => {
    if (!confirmDiscard('새로 만들기를')) return;
    replaceAll([], '새 목록');
    ctx.toast('빈 목록에서 시작합니다 — 아래 상세를 채우고 「추가」를 누르세요', 'ok');
  });

  wireOpenDialog({
    input: el('spOpenInput'),
    button: el('spOpen'),
    kind: 'preset',
    parse: ctx.parseFile,
    onError: ctx.reportError,
    onLoad: (result, name) => {
      if (!confirmDiscard('다른 파일을 열면')) return;
      replaceAll(result.presets ?? [], `내 PC · ${name}`, name);
      ctx.toast(`${name} 에서 프리셋 ${presets.length}개를 읽었습니다`, 'ok');
    },
  });

  wireSaveDialog({
    button: el('spSave'),
    kind: 'preset',
    onError: ctx.reportError,
    // **저장 직전에** 만든다 — 그래야 방금 고친 것이 담긴다.
    // 파일 모양(Unity 좌표)으로 되돌리는 것은 **서버**가 한다: 축 규약이 읽기/쓰기로
    // 갈리면 열었다 저장한 것만으로 배치가 틀어지고, 그 실패는 오류로 뜨지 않는다.
    build: async () => {
      if (!presets.length) throw new Error('저장할 프리셋이 없습니다');
      const { file } = await ctx.serializePresets(presets);
      return { name: fileName || '001_Preset_new.json', data: file };
    },
    onDone: (name, downloaded) => {
      dirty = false;
      fileName = name;
      origin = `내 PC · ${name}`;
      setStatus();
      ctx.toast(
        downloaded
          ? `${name} 을 내려받았습니다 — 브라우저 다운로드 폴더에 있습니다. save/3D/Preset 으로 옮기세요.`
          : `${name} 으로 저장했습니다`,
        'ok',
      );
    },
  });

  // --- 목록 편집 (이 화면만 바꾼다) ------------------------------------------

  el('spList').addEventListener('change', showSelected);

  el('spAdd').addEventListener('click', () => {
    // 번호는 비어 있으면 자동으로 매기고, 사람이 적었으면 그것을 쓴다 —
    // 다만 **겹치면 거절한다**: 같은 번호가 둘이면 어느 것을 고쳤는지 알 수 없다.
    const typed = num('spIdx');
    const idx = Number.isFinite(typed) && typed >= 1 ? typed : nextIdx();
    if (presets.some((preset) => preset.idx === idx)) throw new Error(`이미 있는 번호입니다: ${idx}`);
    try {
      presets = [...presets, formPreset(idx)].sort((a, b) => a.idx - b.idx);
      dirty = true;
      renderList(idx);
      ctx.toast(`프리셋 ${idx} 을(를) 목록에 넣었습니다 (아직 파일·시뮬레이터에 반영되지 않았습니다)`, 'ok');
    } catch (error) {
      ctx.reportError(error);
    }
  });

  el('spUpdate').addEventListener('click', () => {
    const preset = selected();
    if (!preset) return ctx.reportError(new Error('프리셋을 선택하세요'));
    try {
      // 번호는 바꾸지 않는다 — 목록의 정체성이라, 바꾸려면 지우고 다시 넣는 편이 명확하다.
      presets = presets.map((entry) => (entry.idx === preset.idx ? formPreset(preset.idx) : entry));
      dirty = true;
      renderList(preset.idx);
    } catch (error) {
      ctx.reportError(error);
    }
  });

  el('spDelete').addEventListener('click', () => {
    const preset = selected();
    if (!preset) return ctx.reportError(new Error('프리셋을 선택하세요'));
    presets = presets.filter((entry) => entry.idx !== preset.idx);
    dirty = true;
    renderList('');
  });

  // --- 시뮬레이터 -----------------------------------------------------------

  /**
   * 목록을 시뮬레이터에 밀어 넣는다.
   *
   * **`preset.clear` 로 시작한다** — 그래야 목록이 곧 시뮬레이터 상태가 된다. 그 대가로
   * 시뮬레이터가 그려 둔 것이 사라지므로 확인을 받는다.
   *
   * 하나가 실패해도 **멈추지 않는다** — 멈추면 시뮬레이터가 반쯤 지워진 채 남는다.
   * 대신 실패를 모아 끝에 보고하고, `preset.create` 가 번호를 스스로 매기므로 바뀐 번호도 알린다.
   */
  async function push() {
    if (!presets.length) throw new Error('보낼 프리셋이 없습니다');
    if (!confirm(
      `${origin} 의 주차면 프리셋 ${presets.length}개를 시뮬레이터로 보냅니다.\n\n`
      + '⚠ 시뮬레이터의 기존 주차면이 **전부 사라집니다** — 시뮬레이터 UI 로 그린 것도 포함됩니다.\n\n'
      + '계속할까요?',
    )) return;

    await ctx.rpc('preset.clear');
    const sent = [];
    const failed = [];
    for (const preset of presets) {
      try {
        const created = await ctx.rpc('preset.create', {
          presetName: preset.presetName,
          faceCount: preset.faceCount,
          offset: preset.offset,
          faceRot: preset.faceRot,
          groupRot: preset.groupRot,
          dirType: preset.dirType,
          camIdx: preset.camIdx,
          useBaseWidth: preset.useBaseWidth,
          xSize: preset.xSize,
          zSize: preset.zSize,
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
    if (!confirm('시뮬레이터의 주차면 프리셋을 전부 지웁니다.\n\n⚠ 시뮬레이터 UI 로 그린 것도 함께 사라집니다.\n\n이 화면의 목록은 그대로입니다.\n\n계속할까요?')) return;
    await ctx.rpc('preset.clear');
    ctx.toast('시뮬레이터 프리셋을 비웠습니다', 'ok');
  }));

  /**
   * 3D 는 **전역 토글**이다. `preset.setBoxVisible`(면 단위)은 등록만 돼 있고 동작하지
   * 않으므로 문서가 지시하는 `preset.rebuildAll {showQubeBox}` 를 쓴다.
   */
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
      // RPC 계에서 지면은 x·y 다(높이가 z).
      await ctx.rpc('preset.move', { idx: preset.idx, delta: { x: dx * step, y: dy * step } });
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
    const name = prompt('시뮬레이터 디스크에 저장할 파일명', fileName || '001_Preset_new.json');
    if (!name) return;
    await ctx.rpc('preset.save', { fileName: name });
    ctx.toast(`시뮬레이터 디스크에 ${name} 로 저장했습니다`, 'ok');
  }));

  el('spSimLoad').addEventListener('click', guard(async () => {
    const name = prompt('시뮬레이터 디스크에서 열 파일명', fileName || '001_Preset_new.json');
    if (!name) return;
    if (!confirm(`시뮬레이터가 자기 디스크의 ${name} 을 엽니다.\n\n⚠ 지금 시뮬레이터에 있는 주차면이 대체됩니다.\n(이 화면의 목록은 그대로입니다)\n\n계속할까요?`)) return;
    await ctx.rpc('preset.load', { fileName: name });
    ctx.toast(`시뮬레이터가 ${name} 을 열었습니다`, 'ok');
  }));

  return {
    onActivate() {
      // 파일도 시뮬레이터도 자동으로 읽지 않는다 — 편집 중인 목록을 덮어쓰면 안 되고,
      // 탭을 여는 것만으로 시뮬레이터를 두드릴 이유도 없다.
      setStatus();
    },
  };
}
