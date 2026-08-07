import { CAR_PREFABS, CAR_TYPES, prefabName } from './simtoolCatalog.js';

const el = (id) => document.getElementById(id);
const num = (id) => Number(el(id).value);

/**
 * 차량 배치툴.
 *
 * ## 클릭 배치는 아직 없다
 *
 * 화면 클릭 → 월드 좌표는 언리얼의 `view.pick` 이 해야 한다(웹이 역투영을 재현하면
 * 언리얼과 갈린다). 그 메서드가 아직 없으므로 지금은 **자동생성**(`car.createLine`)과
 * **좌표 직접 입력**으로 배치한다. 없는 기능을 흉내 내지 않는다.
 *
 * ## 차종 목록은 화면이 들고 있다
 *
 * 시뮬레이터 RPC 에 이름 목록을 주는 메서드가 없다(실측). `simtoolCatalog.js` 참조 —
 * 서버가 주게 되면 그쪽으로 옮긴다.
 *
 * ## Front / Back
 *
 * `car.list` 에 방향 필드가 따로 없고 `rotY` 만 있다. 그래서 라디오는 **`rotY` 를 쓰는
 * 방식**이다 — Front = 지금 값, Back = 180° 돌린 값. 없는 필드를 지어내지 않는다.
 */
export function createCarPanel(ctx) {
  let cars = [];

  function fillCatalogs() {
    if (el('carPrefab').options.length) return;
    el('carPrefab').replaceChildren(...CAR_PREFABS.map((entry) => {
      const option = new Option(`${entry.id}. ${entry.name}`, String(entry.id));
      option.title = entry.size;
      return option;
    }));
    el('carPrefab').value = '4';   // 기아_K5 — 스크린샷 기본값
    el('carType').replaceChildren(...CAR_TYPES.map((entry) => {
      const option = new Option(entry.name, String(entry.id));
      option.title = entry.note;
      return option;
    }));
    el('carType').value = '1';
  }

  function selected() {
    return cars.find((car) => car.carNameId === el('carList').value);
  }

  function renderList() {
    el('carCountTag').textContent = `${cars.length}대`;
    const previous = el('carList').value;
    el('carList').replaceChildren(...cars.map((car) => {
      const option = new Option(`${car.carNameId}  ·  ${prefabName(car.prefabId)}`, car.carNameId);
      if (!car.visible) option.textContent += '  (숨김)';
      return option;
    }));
    if (previous && cars.some((car) => car.carNameId === previous)) el('carList').value = previous;
    showSelected();
  }

  function showSelected() {
    const car = selected();
    el('carSelId').value = car?.carNameId ?? '';
    el('carSelPreset').value = car?.presetId ?? '';
    el('carSelFace').value = car?.faceSlot ?? '';
    el('carSelRotY').value = car?.rotY ?? '';
    // 180° 근처면 Back 으로 본다. 정확히 180 이 아닐 수 있다(그룹 회전·지터).
    const back = typeof car?.rotY === 'number' && Math.abs(((car.rotY % 360) + 360) % 360 - 180) < 90;
    el(back ? 'carBack' : 'carFront').checked = true;
  }

  async function reload() {
    const result = await ctx.rpc('car.list');
    cars = result.cars ?? [];
    renderList();
  }

  const guard = (fn) => (...args) => void fn(...args).catch(ctx.reportError);

  el('carList').addEventListener('change', showSelected);

  el('carCreate').addEventListener('click', guard(async () => {
    await ctx.rpc('car.create', {
      pos: { x: num('carX'), y: num('carY'), z: 0 },
      prefabId: num('carPrefab'),
      presetId: num('carPresetId'),
      rotY: el('carBack').checked ? 180 : 0,
    });
    await reload();
  }));

  el('carAutoLine').addEventListener('click', guard(async () => {
    await ctx.rpc('car.createLine', {
      presetId: num('carPresetId'),
      count: num('carCount'),
      offset: { x: num('carX'), y: num('carY'), z: 0 },
      spacing: num('carSpacing'),
      vertical: el('carVertical').checked,
      rotY: el('carBack').checked ? 180 : 0,
    });
    await reload();
  }));

  el('carUpdate').addEventListener('click', guard(async () => {
    const car = selected();
    if (!car) throw new Error('차량을 선택하세요');
    // 라디오가 회전을 이긴다 — 사람이 Front/Back 을 바꿨으면 그것이 의도다.
    const base = Number(el('carSelRotY').value);
    const rotY = el('carBack').checked
      ? (Math.abs(((base % 360) + 360) % 360 - 180) < 90 ? base : base + 180)
      : (Math.abs(((base % 360) + 360) % 360 - 180) < 90 ? base - 180 : base);
    await ctx.rpc('car.setRotationY', { carNameId: car.carNameId, rotY });
    await reload();
  }));

  el('carDelete').addEventListener('click', guard(async () => {
    const car = selected();
    if (!car) throw new Error('차량을 선택하세요');
    await ctx.rpc('car.delete', { carNameId: car.carNameId });
    await reload();
  }));

  el('carDeleteAll').addEventListener('click', guard(async () => {
    if (!confirm(`배치된 차량 ${cars.length}대를 전부 삭제합니다.\n\n계속할까요?`)) return;
    await ctx.rpc('car.deleteAll');
    await reload();
  }));

  el('carResetRandom').addEventListener('click', guard(async () => {
    const mode = el('carRandomMode').value;
    if (mode !== 'color' && !confirm(`「${el('carRandomMode').selectedOptions[0].textContent}」 는 배치된 차량을 다시 만듭니다.\n지금 배치가 바뀝니다 — 계속할까요?`)) return;
    await ctx.rpc('car.resetRandom', { mode });
    await reload();
  }));

  el('carSave').addEventListener('click', guard(async () => {
    const fileName = el('carFile').value.trim();
    if (!fileName) throw new Error('파일명을 입력하세요');
    await ctx.rpc('car.save', { fileName });
    ctx.toast(`시뮬레이터에 ${fileName} 로 저장했습니다`, 'ok');
  }));

  el('carLoad').addEventListener('click', guard(async () => {
    const fileName = el('carFile').value.trim();
    if (!fileName) throw new Error('파일명을 입력하세요');
    await ctx.rpc('car.load', { fileName });
    await reload();
    // 참조 문서 §4 의 미해결 사항이다 — 조용히 넘기면 다른 차종이 떴을 때 아무도 모른다.
    ctx.toast(`${fileName} 을 열었습니다. prefabId ↔ 차종 대응은 미확정이라 차종이 다를 수 있습니다.`, 'ok');
  }));

  el('carClear').addEventListener('click', guard(async () => {
    if (!confirm('차량 배치를 초기화합니다.\n\n계속할까요?')) return;
    await ctx.rpc('car.clear');
    await reload();
  }));

  return {
    async onActivate() {
      fillCatalogs();
      await reload();
    },
    async onConnect() {
      fillCatalogs();
    },
  };
}
