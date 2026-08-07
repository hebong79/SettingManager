const el = (id) => document.getElementById(id);
const num = (id) => Number(el(id).value);

/**
 * 프리셋 메이커 — **주차면 그룹**을 만들고 배치한다.
 *
 * ## 용어 충돌 주의
 *
 * SettingManager 의 「프리셋」은 **PTZ 프리셋**(`preset_info` DB)이다. 여기 「프리셋」은
 * **주차면 그룹**(N개 면의 배치 단위)이며 전혀 다른 것이다. RPC 이름은 시뮬레이터
 * 계약(`preset.*`)을 그대로 쓰되, 화면과 이 주석에서 구분을 못 박는다.
 *
 * ## Offset Pick 이 없다
 *
 * 화면 클릭 → 월드 좌표는 언리얼 `view.pick` 이 해야 한다. 아직 없으므로 좌표를
 * 직접 넣는다. 웹이 역투영을 흉내 내면 언리얼이 아는 정답과 갈린다.
 *
 * ## 파생값(각도·step폭·전체X폭)은 계산하지 않는다
 *
 * 배치 규칙은 언리얼이 소유한다. `preset.get` 이 파생값을 실어 주면 그것을 그대로 쓰고,
 * 안 주면 **비워 둔다** — 여기서 재현하면 규칙이 두 벌이 되고 반드시 갈린다.
 */
export function createPresetPanel(ctx) {
  let presets = [];

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
    if (preset) {
      el('spFaceCount').value = preset.faceCount ?? 0;
      el('spCamIdx').value = preset.camIdx ?? 1;
      el('spOffsetX').value = preset.offset?.x ?? preset.offsetPos?.x ?? 0;
      el('spOffsetY').value = preset.offset?.y ?? preset.offsetPos?.y ?? 0;
      el('spOffsetZ').value = preset.offset?.z ?? preset.offsetPos?.z ?? 0;
      el('spGroupRot').value = preset.groupRot ?? 0;
      el('spFaceRot').value = preset.faceRot ?? 0;
      el('spXSize').value = preset.xSize ?? 2.5;
      el('spZSize').value = preset.zSize ?? 5;
      el('spDirType').value = String(preset.dirType ?? 0);
      el('spBaseWidth').checked = preset.useBaseWidth !== false;
    }
    showDerived(preset);
  }

  /** 언리얼이 준 것만 적는다. 없으면 없다고 말한다 — 우리가 계산하지 않는다. */
  function showDerived(preset) {
    const derived = preset?.derived;
    el('spDerived').textContent = derived
      ? `각도 ${derived.angleDeg ?? '-'}° | 1개 step폭 ${derived.stepWidthM ?? '-'}m | 전체 X폭 ${derived.totalXM ?? '-'}m | 세로폭 ${derived.depthM ?? '-'}m`
      : '파생값(각도·step폭·전체X폭)은 시뮬레이터가 preset.get 에 실어 줄 때만 표시됩니다 — 웹에서 계산하지 않습니다.';
  }

  function formPayload() {
    return {
      presetName: el('spName').value.trim() || undefined,
      faceCount: num('spFaceCount'),
      offset: { x: num('spOffsetX'), y: num('spOffsetY'), z: num('spOffsetZ') },
      faceRot: num('spFaceRot'),
      groupRot: num('spGroupRot'),
      dirType: num('spDirType'),
      camIdx: num('spCamIdx'),
      useBaseWidth: el('spBaseWidth').checked,
      xSize: num('spXSize'),
      zSize: num('spZSize'),
    };
  }

  async function reload() {
    const result = await ctx.rpc('preset.list');
    // 서버가 배열을 그대로 주기도 하고 `{presets:[…]}` 로 감싸기도 한다 — 둘 다 받는다.
    presets = Array.isArray(result) ? result : (result?.presets ?? []);
    renderList();
  }

  const guard = (fn) => (...args) => void fn(...args).catch(ctx.reportError);

  el('spList').addEventListener('change', guard(async () => {
    showSelected();
    const preset = selected();
    if (preset) await ctx.rpc('preset.select', { idx: preset.idx });
  }));

  el('spAdd').addEventListener('click', guard(async () => {
    await ctx.rpc('preset.create', formPayload());
    await reload();
  }));

  el('spUpdate').addEventListener('click', guard(async () => {
    const preset = selected();
    if (!preset) throw new Error('프리셋을 선택하세요');
    await ctx.rpc('preset.update', { idx: preset.idx, ...formPayload() });
    await reload();
  }));

  el('spDelete').addEventListener('click', guard(async () => {
    const preset = selected();
    if (!preset) throw new Error('프리셋을 선택하세요');
    await ctx.rpc('preset.delete', { idx: preset.idx });
    await reload();
  }));

  el('spClear').addEventListener('click', guard(async () => {
    if (!confirm(`주차면 프리셋 ${presets.length}개를 전부 지웁니다.\n\n계속할까요?`)) return;
    await ctx.rpc('preset.clear');
    await reload();
  }));

  /**
   * **3D 는 전역 토글이다.** `preset.setBoxVisible`(면 단위)은 시뮬레이터에 등록만 돼 있고
   * 동작하지 않는다 — 문서 §10 이 "전역 3D 는 rebuildAll" 이라고 지시한다.
   * 그래서 체크박스가 프리셋 하나가 아니라 **전체 재빌드**를 부른다. 라벨도 그렇게 적었다.
   */
  el('spUse3d').addEventListener('change', guard(async () => {
    await ctx.rpc('preset.rebuildAll', { showQubeBox: el('spUse3d').checked });
    await reload();
  }));

  /** 방향 패드. 이동은 X·Y 델타(Z-up), 회전은 Face/Group 을 나눠 쓴다. */
  async function nudge(dx, dy) {
    const preset = selected();
    if (!preset) throw new Error('프리셋을 선택하세요');
    const step = Number(el('spStep').value);
    if (el('spModeRotate').checked) {
      await ctx.rpc('preset.rotate', {
        idx: preset.idx,
        deltaFaceRot: dx * step,
        deltaGroupRot: dy * step,
      });
    } else {
      await ctx.rpc('preset.move', { idx: preset.idx, delta: { x: dx * step, z: dy * step } });
    }
    await reload();
  }

  el('spLeft').addEventListener('click', guard(() => nudge(-1, 0)));
  el('spRight').addEventListener('click', guard(() => nudge(1, 0)));
  el('spUp').addEventListener('click', guard(() => nudge(0, 1)));
  el('spDown').addEventListener('click', guard(() => nudge(0, -1)));

  el('spRenumber').addEventListener('click', guard(async () => {
    const result = await ctx.rpc('preset.renumber');
    const rows = Array.isArray(result) ? result : (result?.assignments ?? []);
    ctx.toast(`주차면 번호를 재계산했습니다 (${rows.length}개 프리셋)`, 'ok');
    await reload();
  }));

  el('spSave').addEventListener('click', guard(async () => {
    const fileName = el('spFile').value.trim();
    if (!fileName) throw new Error('파일명을 입력하세요');
    await ctx.rpc('preset.save', { fileName });
    ctx.toast(`시뮬레이터에 ${fileName} 로 저장했습니다`, 'ok');
  }));

  el('spLoad').addEventListener('click', guard(async () => {
    const fileName = el('spFile').value.trim();
    if (!fileName) throw new Error('파일명을 입력하세요');
    await ctx.rpc('preset.load', { fileName });
    await reload();
  }));

  return {
    async onActivate() {
      await reload();
    },
  };
}
