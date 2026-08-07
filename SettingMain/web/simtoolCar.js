import { CAR_TYPES, prefabName } from './simtoolCatalog.js';
import { wireOpenDialog } from './simtoolOpen.js';

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
 * ## 차종 목록의 정본은 `config/car_catalog.json` 이다
 *
 * 시뮬레이터 RPC 에 이름 목록을 주는 메서드가 없어서(82개 어디에도) 서버가
 * `/api/sim/car-catalog` 로 그 파일을 읽어 준다. **배열 순서가 곧 `prefabId`(1부터)** 라,
 * 화면에 복사해 두면 파일을 고쳤을 때 한쪽만 바뀌고 저장된 `CarPos_*.json` 이
 * 다른 차종으로 해석된다.
 *
 * ## `random.*` 은 절반이 죽어 있다
 *
 * `slotPlace`·`placeInView`·`slotJitter`·`frontBack`·`randomizeAll` 다섯은 등록만 돼 있고
 * 동작하지 않는다(문서 §6·§10). 그래서 랜덤은 **`car.resetRandom`** 하나로만 한다 —
 * 이쪽은 실제로 구현돼 있다.
 *
 * ## Front / Back
 *
 * `car.list` 에 방향 필드가 따로 없고 `rotY` 만 있다. 그래서 라디오는 **`rotY` 를 쓰는
 * 방식**이다 — Front = 지금 값, Back = 180° 돌린 값. 없는 필드를 지어내지 않는다.
 */
export function createCarPanel(ctx) {
  let cars = [];
  /** `config/car_catalog.json` 에서 온 프리팹 목록. 못 읽었으면 **비어 있고 화면이 그렇게 말한다.** */
  let prefabs = [];
  /** 「열기…」·드롭다운으로 읽어 둔 배치. 시뮬레이터의 현재 상태와 **다른 것**이다. */
  let loaded = [];
  let source = '';

  function setSource(text) {
    source = text;
    el('carSource').textContent = text || '-';
  }

  async function loadFileList() {
    const { files } = await ctx.files('car');
    const previous = el('carFile').value;
    el('carFile').replaceChildren(...files.map((file) => {
      const option = new Option(file.name, file.name);
      option.title = `${(file.sizeBytes / 1024).toFixed(1)} KB · ${file.modifiedAt.slice(0, 16).replace('T', ' ')}`;
      return option;
    }));
    if (previous && files.some((file) => file.name === previous)) el('carFile').value = previous;
  }

  async function loadSelectedFile() {
    const name = el('carFile').value;
    if (!name) { loaded = []; setSource(''); return; }
    const data = await ctx.file('car', name);
    loaded = data.cars ?? [];
    setSource(`save/3D/CarPos/${name} · ${loaded.length}대`);
  }

  /**
   * 파일의 배치를 시뮬레이터에 밀어 넣는다.
   *
   * `car.clear` 로 시작하므로 **시뮬레이터의 기존 차량이 전부 사라진다.** 좌표는 서버가
   * 이미 RPC 계로 바꿔 준 것을 그대로 보낸다 — 여기서 축을 다시 만지면 두 벌이 된다.
   */
  async function push() {
    if (!loaded.length) throw new Error('보낼 배치가 없습니다 — 파일을 고르거나 「열기…」로 여세요');
    if (!confirm(
      `${source} 의 차량 ${loaded.length}대를 시뮬레이터로 보냅니다.

`
      + '⚠ 시뮬레이터의 기존 차량이 **전부 사라집니다.**

계속할까요?',
    )) return;

    await ctx.rpc('car.clear');
    let sent = 0;
    const failed = [];
    for (const car of loaded) {
      try {
        await ctx.rpc('car.create', {
          pos: car.pos,
          prefabId: car.prefabId,
          presetId: car.presetId,
          rotY: car.rotY,
          isFront: car.isFront,
        });
        sent += 1;
      } catch (error) {
        // 멈추면 시뮬레이터가 **반쯤 지워진** 상태로 남는다. 끝까지 보내고 모아서 보고한다.
        failed.push(`${car.id} (${error.message})`);
        // 같은 사유로 전부 실패할 것이 뻔하면 그만둔다 — 65번 반복해 봐야 같은 오류다.
        if (failed.length >= 5) { failed.push(`… 이후 중단 (${loaded.length - sent - failed.length + 1}대 남음)`); break; }
      }
    }
    await reload();
    ctx.toast(
      `${sent}/${loaded.length}대를 보냈습니다.` + (failed.length ? ` 실패: ${failed.join(' / ')}` : ''),
      failed.length ? 'err' : 'ok',
    );
  }

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
    } else if (prefabs.some((entry) => entry.name === '기아_K5')) {
      el('carPrefab').value = String(prefabs.find((entry) => entry.name === '기아_K5').prefabId);
    }
  }

  function selected() {
    return cars.find((car) => car.carNameId === el('carList').value);
  }

  function renderList() {
    el('carCountTag').textContent = `${cars.length}대`;
    const previous = el('carList').value;
    el('carList').replaceChildren(...cars.map((car) => {
      const option = new Option(`${car.carNameId}  ·  ${prefabName(prefabs, car.prefabId)}`, car.carNameId);
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

  el('carFile').addEventListener('change', guard(loadSelectedFile));
  el('carReload').addEventListener('click', guard(async () => { await loadFileList(); await loadSelectedFile(); }));
  el('carPush').addEventListener('click', guard(push));

  // 「열기…」 — 이 PC 의 파일. 해석·좌표변환은 서버가 한다(`simtoolOpen.js`).
  wireOpenDialog({
    input: el('carOpenInput'),
    button: el('carOpen'),
    kind: 'car',
    parse: ctx.parseFile,
    onError: ctx.reportError,
    onLoad: (result, fileName) => {
      loaded = result.cars ?? [];
      // 폴더 선택을 푼다 — 「시뮬에 저장」이 엉뚱한 이름으로 나가지 않게.
      el('carFile').value = '';
      setSource(`내 PC · ${fileName} · ${loaded.length}대`);
      ctx.toast(`${fileName} 에서 차량 ${loaded.length}대를 읽었습니다. 「시뮬로 보내기」로 반영합니다.`, 'ok');
    },
  });

  el('carSimSave').addEventListener('click', guard(async () => {
    const fileName = el('carFile').value;
    if (!fileName) throw new Error('저장 파일 드롭다운에서 이름을 고르세요 (「열기…」로 연 PC 파일은 이름이 시뮬레이터에 없습니다)');
    await ctx.rpc('car.save', { fileName });
    ctx.toast(`시뮬레이터 디스크에 ${fileName} 로 저장했습니다`, 'ok');
  }));

  el('carClear').addEventListener('click', guard(async () => {
    if (!confirm('시뮬레이터의 차량 배치를 초기화합니다.\n\n계속할까요?')) return;
    await ctx.rpc('car.clear');
    await reload();
  }));

  return {
    async onActivate() {
      await fillCatalogs();
      await loadFileList();
      // 목록 조회(car.list)는 시뮬레이터가 필요하다. 꺼져 있어도 파일은 볼 수 있어야 하므로
      // 실패를 삼키지 않고 화면에 알리되 탭 자체는 뜬다.
      await reload().catch(ctx.reportError);
    },
    async onConnect() {
      await fillCatalogs();
    },
  };
}
