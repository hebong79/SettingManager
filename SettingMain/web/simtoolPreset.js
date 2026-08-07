import { wireOpenDialog } from './simtoolOpen.js';

const el = (id) => document.getElementById(id);
const fmt = (v, digits = 3) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '-');

/**
 * 프리셋 메이커 — **주차면 그룹**. 목록의 출처는 `save/3D/Preset` 의 저장 파일이다.
 *
 * ## 왜 `preset.list`(RPC)가 아닌가 (마스터 결정 2026-08-07)
 *
 * 시뮬레이터는 **위젯 목록과 RPC 목록을 따로** 갖고 있다. `preset.list` 는 RPC 가 만든
 * 것만 보여 주므로, 사람이 시뮬레이터 UI 로 그린 배치는 **거기 안 보인다**(실측: 빈 배열).
 * 실체는 저장 파일에 있다 — 그래서 목록을 파일에서 읽는다.
 * 근거: `docs/reference/unreal/20260807_173431_Park3D_RPC_메서드_목록.md` §5.
 *
 * ## 좌표는 서버가 바꿔 준다
 *
 * 저장 파일은 Unity(Y-up), RPC 는 언리얼(Z-up)이다. 서버(`simFiles.ts`)가 읽으면서
 * `RPC(x,y,z) = 파일(z,x,y)` 로 바꾸므로 **화면은 RPC 계 하나만 본다.**
 * 화면이 두 좌표계를 동시에 들면 반드시 섞이고, 그 실패는 오류로 뜨지 않는다 —
 * 좌표가 "그럴듯하게" 틀리기 때문이다.
 *
 * ## 상세는 읽기 전용이다
 *
 * 편집의 정본은 시뮬레이터 UI 와 저장 파일이다. 여기서 값을 고치게 두면 파일과 화면 중
 * 어느 쪽이 맞는지 알 수 없게 된다. 이 화면이 하는 쓰기는 **「시뮬로 보내기」 하나**다.
 *
 * ## 「시뮬로 보내기」는 위험하다
 *
 * `preset.clear` 로 시작하므로 **시뮬레이터가 그려 둔 주차면이 전부 사라진다.**
 * 그래서 탭 진입 시 배너로 알리고, 누를 때 개수를 적어 확인을 받는다.
 */
export function createPresetPanel(ctx) {
  let presets = [];
  /** 지금 목록이 어디서 왔는가. 사람이 「보내기」 전에 무엇을 보내는지 알아야 한다. */
  let source = '';

  function setSource(text) {
    source = text;
    el('spSource').textContent = text || '-';
  }

  const selected = () => presets.find((preset) => String(preset.idx) === el('spList').value);

  function renderList() {
    el('presetCount').textContent = `${presets.length}개`;
    const previous = el('spList').value;
    el('spList').replaceChildren(...presets.map((preset) =>
      new Option(`${preset.idx}. ${preset.presetName ?? ''}  (면 ${preset.faceCount ?? '-'})`, String(preset.idx))));
    if (previous && presets.some((preset) => String(preset.idx) === previous)) el('spList').value = previous;
    showSelected();
  }

  function showSelected() {
    const preset = selected();
    el('spIdx').value = preset?.idx ?? '';
    el('spName').value = preset?.presetName ?? '';
    el('spFaceCount').value = preset?.faceCount ?? '';
    el('spCamIdx').value = preset?.camIdx ?? '';
    el('spOffsetX').value = preset ? fmt(preset.offset?.x) : '';
    el('spOffsetY').value = preset ? fmt(preset.offset?.y) : '';
    el('spOffsetZ').value = preset ? fmt(preset.offset?.z) : '';
    el('spGroupRot').value = preset?.groupRot ?? '';
    el('spFaceRot').value = preset?.faceRot ?? '';
    el('spXSize').value = preset?.xSize ?? '';
    el('spZSize').value = preset?.zSize ?? '';
    el('spDirType').value = String(preset?.dirType ?? 0);
    el('spBaseWidth').checked = preset?.useBaseWidth !== false;
    showDerived(preset);
  }

  /** 언리얼이 준 것만 적는다. 배치 규칙은 그쪽이 소유하므로 여기서 계산하지 않는다. */
  function showDerived(preset) {
    const derived = preset?.derived;
    el('spDerived').textContent = derived
      ? `각도 ${derived.angleDeg ?? '-'}° | 1개 step폭 ${derived.stepWidthM ?? '-'}m | 전체 X폭 ${derived.totalXM ?? '-'}m | 세로폭 ${derived.depthM ?? '-'}m`
      : '파생값(각도·step폭·전체X폭)은 시뮬레이터가 실어 줄 때만 표시됩니다 — 웹에서 계산하지 않습니다.';
  }

  // --- 파일 --------------------------------------------------------------

  async function loadFileList() {
    const { files } = await ctx.files('preset');
    const previous = el('spFile').value;
    el('spFile').replaceChildren(...files.map((file) => {
      const option = new Option(file.name, file.name);
      option.title = `${(file.sizeBytes / 1024).toFixed(1)} KB · ${file.modifiedAt.slice(0, 16).replace('T', ' ')}`;
      return option;
    }));
    if (previous && files.some((file) => file.name === previous)) el('spFile').value = previous;
    if (!files.length) {
      presets = [];
      renderList();
      ctx.toast('save/3D/Preset 에 저장 파일이 없습니다.', 'err');
    }
  }

  async function loadSelectedFile() {
    const name = el('spFile').value;
    if (!name) { presets = []; setSource(''); renderList(); return; }
    const data = await ctx.file('preset', name);
    presets = data.presets ?? [];
    setSource(`save/3D/Preset/${name} · ${presets.length}개`);
    renderList();
  }

  // 「열기…」 — 이 PC 의 파일. 해석은 서버가 한다(simtoolOpen.js 주석 참조).
  wireOpenDialog({
    input: el('spOpenInput'),
    button: el('spOpen'),
    kind: 'preset',
    parse: ctx.parseFile,
    onError: ctx.reportError,
    onLoad: (result, fileName) => {
      presets = result.presets ?? [];
      // 폴더 드롭다운의 선택을 **푼다** — 목록은 PC 파일 것인데 드롭다운이 다른 이름을
      // 가리키고 있으면 「시뮬에 저장」이 엉뚱한 이름으로 나간다.
      el('spFile').value = '';
      setSource(`내 PC · ${fileName} · ${presets.length}개`);
      renderList();
      ctx.toast(`${fileName} 에서 프리셋 ${presets.length}개를 읽었습니다`, 'ok');
    },
  });

  // --- 시뮬로 보내기 -------------------------------------------------------

  /**
   * 파일의 프리셋을 시뮬레이터에 밀어 넣는다.
   *
   * **`preset.clear` 로 시작한다** — 그래야 파일이 곧 시뮬레이터 상태가 된다. 그 대가로
   * 시뮬레이터가 그려 둔 것이 사라지므로 확인을 받는다.
   *
   * **`idx` 는 파일의 것을 그대로 쓰지 않는다.** `preset.create` 는 번호를 스스로 매기고
   * (필수 파라미터가 `offset`·`faceCount` 뿐이다), 파일의 idx 는 연속이 아니다(실측 1~5,7).
   * 지어낸 번호를 보내면 다른 프리셋을 덮는다 — 그래서 **보낸 순서와 결과를 함께 보고한다.**
   */
  async function push() {
    if (!presets.length) throw new Error('보낼 프리셋이 없습니다 — 파일을 고르거나 「열기…」로 여세요');
    // **어디서 온 목록인지 확인 문구에 적는다.** 폴더 파일과 PC 파일이 섞여 있을 수 있고,
    // 이 동작은 되돌릴 수 없다 — 무엇을 보내는지 모르고 누르면 안 된다.
    if (!confirm(
      `${source} 의 주차면 프리셋 ${presets.length}개를 시뮬레이터로 보냅니다.\n\n`
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
        // 하나가 실패해도 나머지를 계속 보낸다 — 여기서 멈추면 시뮬레이터가 **반쯤 지워진**
        // 상태로 남는다. 대신 무엇이 실패했는지 끝에 전부 보고한다.
        failed.push(`${preset.idx} (${error.message})`);
      }
    }
    await ctx.rpc('preset.renumber').catch(() => undefined);

    const moved = sent.filter((entry) => String(entry.from) !== String(entry.to));
    ctx.toast(
      `${sent.length}/${presets.length}개를 보냈습니다.`
      + (moved.length ? ` 번호가 바뀐 것 ${moved.length}개: ${moved.map((m) => `${m.from}→${m.to}`).join(', ')}.` : '')
      + (failed.length ? ` 실패 ${failed.length}건: ${failed.join(' / ')}` : ''),
      failed.length ? 'err' : 'ok',
    );
  }

  const guard = (fn) => (...args) => void fn(...args).catch(ctx.reportError);

  el('spFile').addEventListener('change', guard(loadSelectedFile));
  el('spList').addEventListener('change', showSelected);
  el('spReload').addEventListener('click', guard(async () => { await loadFileList(); await loadSelectedFile(); }));
  el('spPush').addEventListener('click', guard(push));

  el('spClear').addEventListener('click', guard(async () => {
    if (!confirm('시뮬레이터의 주차면 프리셋을 전부 지웁니다.\n\n⚠ 시뮬레이터 UI 로 그린 것도 함께 사라집니다.\n\n계속할까요?')) return;
    await ctx.rpc('preset.clear');
    ctx.toast('시뮬레이터 프리셋을 비웠습니다 (이 화면의 파일 목록은 그대로입니다)', 'ok');
  }));

  /**
   * 3D 는 **전역 토글**이다. `preset.setBoxVisible`(면 단위)은 등록만 돼 있고 동작하지
   * 않으므로 문서가 지시하는 `preset.rebuildAll {showQubeBox}` 를 쓴다.
   */
  el('spUse3d').addEventListener('change', guard(async () => {
    await ctx.rpc('preset.rebuildAll', { showQubeBox: el('spUse3d').checked });
  }));

  /** 방향 패드 — 시뮬레이터의 **선택된** 프리셋을 움직인다. 파일은 바뀌지 않는다. */
  async function nudge(dx, dy) {
    const preset = selected();
    if (!preset) throw new Error('프리셋을 선택하세요');
    const step = Number(el('spStep').value);
    if (el('spModeRotate').checked) {
      await ctx.rpc('preset.rotate', { idx: preset.idx, deltaFaceRot: dx * step, deltaGroupRot: dy * step });
    } else {
      // RPC 계에서 지면은 x·y 다(높이가 z). 파일의 x·z 평면과 축 이름이 다르다.
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
    const fileName = el('spFile').value;
    // PC 파일을 연 상태에서는 폴더 이름이 없다 — 시뮬레이터에 어떤 이름으로 저장할지
    // 알 수 없으므로 지어내지 않고 고르게 한다.
    if (!fileName) throw new Error('저장 파일 드롭다운에서 이름을 고르세요 (「열기…」로 연 PC 파일은 이름이 시뮬레이터에 없습니다)');
    await ctx.rpc('preset.save', { fileName });
    ctx.toast(`시뮬레이터 디스크에 ${fileName} 로 저장했습니다`, 'ok');
  }));

  el('spSimLoad').addEventListener('click', guard(async () => {
    const fileName = el('spFile').value;
    if (!fileName) throw new Error('저장 파일 드롭다운에서 이름을 고르세요');
    if (!confirm(`시뮬레이터가 자기 디스크의 ${fileName} 을 엽니다.\n\n⚠ 지금 시뮬레이터에 있는 주차면이 대체됩니다.\n\n계속할까요?`)) return;
    await ctx.rpc('preset.load', { fileName });
    ctx.toast(`시뮬레이터가 ${fileName} 을 열었습니다`, 'ok');
  }));

  return {
    async onActivate() {
      await loadFileList();
      await loadSelectedFile();
    },
  };
}
