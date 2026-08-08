import { CAR_TYPES, prefabName } from './simtoolCatalog.js';
import { createFileBar } from './simtoolFileBar.js';
import { createWorkMode } from './simtoolWorkMode.js';

const el = (id) => document.getElementById(id);
const num = (id) => Number(el(id).value);
const fmt = (v, digits = 3) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '');

/**
 * 차량 배치툴 — 프리셋 메이커와 **같은 형태**다(새로 만들기·열기…·저장… + 편집 + 보내기).
 *
 * ## 차종 목록의 정본은 `config/car_catalog.json`
 *
 * 시뮬레이터 RPC 에 이름 목록을 주는 메서드가 없어서(82개 어디에도) 서버가
 * `/api/sim/car-catalog` 로 그 파일을 읽어 준다. **배열 순서가 곧 `prefabId`(1부터)** 라,
 * 화면에 복사해 두면 파일을 고쳤을 때 한쪽만 바뀌고 저장된 `CarPos_*.json` 이 다른 차종으로
 * 해석된다.
 *
 * ## `random.*` 은 절반이 죽어 있다
 *
 * `slotPlace`·`placeInView`·`slotJitter`·`frontBack`·`randomizeAll` 다섯은 등록만 돼 있고
 * 동작하지 않는다(문서 §6·§10). 랜덤은 **`car.resetRandom`** 하나로만 한다.
 *
 * ## 「시뮬로 보내기」와 「시뮬에 줄 배치」는 다른 것이다
 *
 * 앞은 **이 화면의 목록**을 시뮬레이터에 반영하고, 뒤는 시뮬레이터를 **직접** 바꾼다
 * (목록과 무관). 뒤를 쓴 뒤에는 「시뮬에서 가져오기」로 결과를 목록에 담을 수 있다.
 */
export function createCarPanel(ctx) {
  let cars = [];
  /** `config/car_catalog.json` 에서 온 프리팹 목록. 못 읽었으면 **비어 있고 화면이 그렇게 말한다.** */
  let prefabs = [];

  const bar = createFileBar({
    kind: 'car',
    resultKey: 'cars',
    defaultName: 'CarPos_new.json',
    ids: { newButton: 'carNew', openButton: 'carOpen', openInput: 'carOpenInput', saveButton: 'carSave', status: 'carStatus' },
    getRows: () => cars,
    setRows: (rows) => { cars = rows; renderList(''); },
    ctx,
  });

  const selected = () => cars.find((car) => car.id === el('carList').value);

  /**
   * 목록의 한 대를 고쳐 다시 그린다. **키보드 이동이 목록과 시뮬레이터를 함께** 움직이게
   * 하는 자리다 — 시뮬레이터만 옮기면 「저장…」한 파일이 화면에서 본 자리와 달라진다.
   */
  function patch(id, change) {
    cars = cars.map((entry) => (entry.id === id ? { ...entry, ...change } : entry));
    bar.markDirty();
    renderList(id);
  }

  /**
   * 작업모드 — 켜면 `W A S D` 로 고른 차를 옮기고 `Q E` 로 돌린다.
   *
   * `car.setPosition` 은 **절대값**을 받으므로 지금 자리에 걸음을 더해 보낸다. 그 「지금
   * 자리」는 이 목록이 갖고 있다 — 시뮬레이터에 매번 되묻지 않는 대신, 보낸 뒤 목록도
   * 같이 고쳐 **둘이 갈리지 않게** 한다.
   *
   * ## ⚠ 고른 차가 시뮬레이터에 없을 수 있다
   *
   * 이 목록은 파일에서 열었을 수 있고 클릭 배치는 목록만 바꾼다 — 두 축이 다르다.
   * 없는 `carNameId` 를 보내면 시뮬레이터가 거절하고, 그 오류를 **그대로 보여 준다**
   * (「시뮬로 보내기」를 먼저 해야 한다는 뜻이다).
   */
  const work = createWorkMode({
    toggleId: 'carWork',
    noteId: 'carWorkNote',
    stepId: 'carStep',
    ctx,
    target: selected,
    describe: (car) => car.id,
    async move(car, dx, dy) {
      const pos = { x: (car.pos?.x ?? 0) + dx, y: (car.pos?.y ?? 0) + dy, z: car.pos?.z ?? 0 };
      await ctx.rpc('car.setPosition', { carNameId: car.id, pos });
      patch(car.id, { pos });
    },
    // `carStep` 하나가 m 이자 ° 다 — 프리셋 탭과 같은 규약이다.
    async rotate(car, sign) {
      const rotY = (car.rotY ?? 0) + sign * num('carStep');
      await ctx.rpc('car.setRotationY', { carNameId: car.id, rotY });
      patch(car.id, { rotY });
    },
  });

  async function fillCatalogs() {
    if (!el('carType').options.length) {
      el('carType').replaceChildren(...CAR_TYPES.map((entry) => {
        const option = new Option(entry.name, String(entry.id));
        option.title = entry.note;
        return option;
      }));
      el('carType').value = '1';
    }
    if (prefabs.length) return;
    const catalog = await ctx.carCatalog();
    prefabs = catalog.cars ?? [];
    el('carPrefab').replaceChildren(...prefabs.map((entry) =>
      new Option(`${entry.prefabId}. ${entry.name}`, String(entry.prefabId))));
    // 못 읽었으면 **지어내지 않는다** — 잘못된 이름으로 배치해 놓고 맞다고 믿는 것이 최악이다.
    if (catalog.reason) {
      el('carCatalogNote').className = 'warn';
      el('carCatalogNote').textContent = catalog.reason;
    }
  }

  function renderList(keepId) {
    const previous = keepId ?? el('carList').value;
    el('carList').replaceChildren(...cars.map((car) => {
      const option = new Option(`${car.id}  ·  ${prefabName(prefabs, car.prefabId)}`, car.id);
      if (car.visible === false) option.textContent += '  (숨김)';
      return option;
    }));
    if (previous && cars.some((car) => car.id === previous)) el('carList').value = previous;
    el('carCountTag').textContent = `${cars.length}대`;
    bar.render();
    showSelected();
    work.render();
  }

  function showSelected() {
    const car = selected();
    if (!car) return;
    el('carSelId').value = car.id;
    el('carPrefab').value = String(car.prefabId ?? 1);
    el('carType').value = String(car.type ?? 0);
    el('carSelPreset').value = car.presetId ?? 0;
    el('carSelFace').value = car.slotId ?? car.faceSlot ?? 0;
    el('carSelRotY').value = car.rotY ?? 0;
    el('carX').value = fmt(car.pos?.x);
    el('carY').value = fmt(car.pos?.y);
    el('carZ').value = fmt(car.pos?.z);
    el(car.isFront === false ? 'carBack' : 'carFront').checked = true;
  }

  /** 폼 → 차량 1대. 추가·수정이 같은 규칙을 쓰도록 여기서만 값을 읽는다. */
  function formCar(id) {
    return {
      id,
      type: num('carType'),
      presetId: num('carSelPreset'),
      slotId: num('carSelFace'),
      prefabId: num('carPrefab'),
      pos: { x: num('carX'), y: num('carY'), z: num('carZ') },
      rotY: num('carSelRotY'),
      isFront: el('carFront').checked,
    };
  }

  /**
   * 새 식별자. 실측 파일의 id 는 `0-13.50.46` 처럼 **순번-시각**이다 — 그 관례를 따르되
   * 순번은 겹치지 않게 고른다(같은 초에 둘을 넣어도 부딪히지 않는다).
   */
  function newId() {
    const now = new Date();
    const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, '0')).join('.');
    const used = new Set(cars.map((car) => car.id));
    for (let seq = cars.length; seq < cars.length + 1000; seq += 1) {
      const id = `${seq}-${stamp}`;
      if (!used.has(id)) return id;
    }
    return `${Date.now()}`;
  }

  const guard = (fn) => (...args) => void fn(...args).catch(ctx.reportError);
  const attempt = (fn) => () => { try { fn(); } catch (error) { ctx.reportError(error); } };

  el('carList').addEventListener('change', () => { showSelected(); work.render(); });

  el('carAdd').addEventListener('click', attempt(() => {
    const typed = el('carSelId').value.trim();
    const id = typed && !cars.some((car) => car.id === typed) ? typed : newId();
    if (cars.some((car) => car.id === id)) throw new Error(`이미 있는 Idx 입니다: ${id}`);
    cars = [...cars, formCar(id)];
    bar.markDirty();
    renderList(id);
  }));

  el('carUpdate').addEventListener('click', attempt(() => {
    const car = selected();
    if (!car) throw new Error('차량을 선택하세요');
    cars = cars.map((entry) => (entry.id === car.id ? { ...formCar(car.id), visible: entry.visible } : entry));
    bar.markDirty();
    renderList(car.id);
  }));

  el('carDelete').addEventListener('click', attempt(() => {
    const car = selected();
    if (!car) throw new Error('차량을 선택하세요');
    cars = cars.filter((entry) => entry.id !== car.id);
    bar.markDirty();
    renderList('');
  }));

  // --- 시뮬레이터 -----------------------------------------------------------

  /**
   * 목록을 시뮬레이터에 밀어 넣는다. `car.clear` 로 시작하므로 **기존 차량이 전부 사라진다.**
   * 하나가 실패해도 멈추지 않되 5건에서 그만둔다 — 같은 사유로 전부 실패할 것이 뻔하면
   * 수십 번 반복해도 같은 오류이고, 아예 멈추면 시뮬레이터가 반쯤 지워진 채 남는다.
   */
  async function push() {
    if (!cars.length) throw new Error('보낼 차량이 없습니다');
    if (!confirm(
      `${bar.origin()} 의 차량 ${cars.length}대를 시뮬레이터로 보냅니다.\n\n`
      + '⚠ 시뮬레이터의 기존 차량이 **전부 사라집니다.**\n\n계속할까요?',
    )) return;

    await ctx.rpc('car.clear');
    let sent = 0;
    const failed = [];
    for (const car of cars) {
      try {
        await ctx.rpc('car.create', {
          pos: car.pos, prefabId: car.prefabId, presetId: car.presetId,
          rotY: car.rotY, isFront: car.isFront,
        });
        sent += 1;
      } catch (error) {
        failed.push(`${car.id} (${error.message})`);
        if (failed.length >= 5) { failed.push('… 이후 중단'); break; }
      }
    }
    ctx.toast(`${sent}/${cars.length}대를 보냈습니다.` + (failed.length ? ` 실패: ${failed.join(' / ')}` : ''), failed.length ? 'err' : 'ok');
  }

  el('carPush').addEventListener('click', guard(push));

  /** 시뮬레이터의 **현재 상태**를 목록으로 가져온다. 줄 배치·랜덤을 쓴 뒤에 쓴다. */
  el('carPull').addEventListener('click', guard(async () => {
    const result = await ctx.rpc('car.list');
    const rows = (result.cars ?? []).map((car) => ({
      id: car.carNameId, type: car.type ?? 0, presetId: car.presetId ?? 0,
      slotId: car.faceSlot ?? 0, prefabId: car.prefabId ?? 0,
      pos: car.pos, rotY: car.rotY ?? 0,
      // `car.list` 에 방향 필드가 없다 — 180° 근처면 Back 으로 읽는다(없는 필드를 지어내지 않는다).
      isFront: !(typeof car.rotY === 'number' && Math.abs(((car.rotY % 360) + 360) % 360 - 180) < 90),
      visible: car.visible,
    }));
    cars = rows;
    bar.adopt('시뮬레이터 현재 상태');
    renderList('');
    ctx.toast(`시뮬레이터에서 ${rows.length}대를 가져왔습니다`, 'ok');
  }));

  el('carClear').addEventListener('click', guard(async () => {
    if (!confirm('시뮬레이터의 차량을 전부 지웁니다.\n(이 화면의 목록은 그대로입니다)\n\n계속할까요?')) return;
    await ctx.rpc('car.clear');
    ctx.toast('시뮬레이터 차량을 비웠습니다', 'ok');
  }));

  el('carAutoLine').addEventListener('click', guard(async () => {
    await ctx.rpc('car.createLine', {
      presetId: num('carPresetId'), count: num('carCount'),
      offset: { x: num('carX'), y: num('carY'), z: num('carZ') },
      spacing: num('carSpacing'), vertical: el('carVertical').checked,
      rotY: el('carBack').checked ? 180 : 0,
    });
    ctx.toast('시뮬레이터에 줄 배치했습니다 — 「시뮬에서 가져오기」로 목록에 담을 수 있습니다', 'ok');
  }));

  el('carResetRandom').addEventListener('click', guard(async () => {
    const mode = el('carRandomMode').value;
    if (mode !== 'color' && !confirm(`「${el('carRandomMode').selectedOptions[0].textContent}」 는 시뮬레이터의 차량을 다시 만듭니다.\n\n계속할까요?`)) return;
    await ctx.rpc('car.resetRandom', { mode });
    ctx.toast('시뮬레이터에 랜덤을 적용했습니다', 'ok');
  }));

  el('carSimSave').addEventListener('click', guard(async () => {
    const name = prompt('시뮬레이터 디스크에 저장할 파일명', bar.fileName() || 'CarPos_new.json');
    if (!name) return;
    await ctx.rpc('car.save', { fileName: name });
    ctx.toast(`시뮬레이터 디스크에 ${name} 로 저장했습니다`, 'ok');
  }));

  el('carSimLoad').addEventListener('click', guard(async () => {
    const name = prompt('시뮬레이터 디스크에서 열 파일명', bar.fileName() || 'CarPos_new.json');
    if (!name) return;
    if (!confirm(`시뮬레이터가 자기 디스크의 ${name} 을 엽니다.\n\n⚠ 지금 시뮬레이터의 차량이 대체됩니다.\n(이 화면의 목록은 그대로입니다)\n\n계속할까요?`)) return;
    await ctx.rpc('car.load', { fileName: name });
    ctx.toast(`시뮬레이터가 ${name} 을 열었습니다`, 'ok');
  }));

  /**
   * 영상 클릭 — **Ctrl+왼쪽은 추가, 그냥 왼쪽은 선택**(마스터 지시 2026-08-08).
   *
   * 껍데기가 이미 **월드 좌표로 바꿔서** 넘겨준다 — 여기서 기하를 다시 계산하지 않는다
   * (`src/sim/simProject.ts` 한 곳).
   *
   * ## 고른 차가 이 목록에 없을 수 있다
   *
   * 클릭이 맞히는 것은 **시뮬레이터의 현재 차량**(`car.list`)이고, 이 목록은 파일에서 연
   * 것일 수 있다. 두 축이 다르므로 id 가 없으면 **그렇다고 말한다** — 비슷한 것을 찾아
   * 골라 주면 사람은 맞는 차를 고른 줄 알게 된다.
   */

  /** **Ctrl+왼쪽 = 추가.** 목록만 바꾼다 — 시뮬레이터 반영은 「시뮬로 보내기」다. */
  function placeAt(ground) {
    // 지면과 만나지 않는 곳(하늘·수평선 위)을 찍으면 좌표가 없다.
    if (!ground) return ctx.toast('그 방향은 지면과 만나지 않습니다 — 지면 쪽을 클릭하세요.', 'err');
    el('carX').value = fmt(ground.x);
    el('carY').value = fmt(ground.y);
    el('carZ').value = fmt(ground.z);
    const id = newId();
    cars = [...cars, formCar(id)];
    bar.markDirty();
    renderList(id);
    ctx.toast(`${id} 를 (${fmt(ground.x, 2)}, ${fmt(ground.y, 2)}) 에 추가했습니다 — 목록만 바뀝니다`, 'ok');
  }

  /**
   * **그냥 왼쪽 클릭 = 선택.** 작업모드일 때는 시뮬레이터에서도 고른다(`car.select`) —
   * 이어서 키보드로 옮길 것이라, 화면과 시뮬레이터가 같은 차를 보고 있어야 한다.
   */
  async function selectAt(car) {
    if (!car) return ctx.toast('그 자리에서 차량을 찾지 못했습니다.', 'err');
    if (!cars.some((entry) => entry.id === car.id)) {
      return ctx.toast(`시뮬레이터의 ${car.id} 를 클릭했지만 이 목록에 없습니다 — 「시뮬에서 가져오기」로 현재 상태를 담을 수 있습니다.`, 'err');
    }
    el('carList').value = car.id;
    showSelected();
    work.render();
    if (work.isOn()) await ctx.rpc('car.select', { carNameId: car.id });
    ctx.toast(`${car.id} 를 골랐습니다`, 'ok');
  }

  const viewportClick = ({ ctrl, ground, car }) => (ctrl ? placeAt(ground) : selectAt(car));

  return {
    isWorkMode: work.isOn,
    onKey: work.onKey,
    onViewportClick: viewportClick,
    clickHelp: 'Ctrl+왼쪽 클릭 = 그 자리에 차량 추가(목록만) · 그냥 왼쪽 클릭 = 그 차량 선택.',

    async onActivate() {
      // 카탈로그는 이 PC 것이라 시뮬레이터가 꺼져 있어도 읽힌다. 목록은 자동으로
      // 가져오지 않는다 — 편집 중인 것을 덮어쓰면 안 된다.
      await fillCatalogs();
      renderList();
    },
  };
}
