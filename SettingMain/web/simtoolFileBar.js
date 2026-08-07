import { wireOpenDialog, wireSaveDialog } from './simtoolOpen.js';

/**
 * 세 툴(프리셋·차량·카메라)이 **같은 형태**로 쓰는 파일 막대 —
 * 「새로 만들기 · 열기… · 저장…」 + 상태줄.
 *
 * ## 왜 공용인가
 *
 * 셋이 같은 일을 한다: 목록을 짓고, PC 파일에서 읽고, PC 파일로 굳히고, 저장 안 한 편집을
 * 지키는 것. 탭마다 따로 쓰면 **세 벌이 되고 한 곳만 고치는 날이 온다** — 특히
 * "저장 안 한 편집을 버리기 전에 묻는다" 같은 규율은 빠뜨려도 테스트가 아니면 안 보인다.
 *
 * ## 무엇을 건드리는지 화면이 말한다
 *
 * 세 곳이 서로 다른 것을 들고 있다 — **이 화면의 목록 · PC 파일 · 시뮬레이터**.
 * 한 덩어리로 보이면 어느 것을 고쳤는지 알 수 없게 되므로, 상태줄이 출처와
 * 「저장 안 함」을 늘 보여 준다.
 *
 * ## 축 변환은 서버가 한다
 *
 * 읽기(`parse`)도 쓰기(`serialize`)도 서버를 지난다. 브라우저가 축을 만지면 읽기와 쓰기의
 * 규약이 갈려 **열었다 저장한 것만으로 배치가 틀어지고**, 그 실패는 오류로 뜨지 않는다.
 */

/**
 * @param options.kind        `preset` | `car` | `camera`
 * @param options.ids         `{ newButton, openButton, openInput, saveButton, status }`
 * @param options.resultKey   서버 응답에서 목록을 꺼낼 키 (`presets`·`cars`·`cameras`)
 * @param options.defaultName 저장 대화상자의 기본 파일명
 * @param options.getRows     `() => 현재 목록`
 * @param options.setRows     `(rows, originLabel) => void` — 목록을 통째로 갈아 끼운다
 * @param options.ctx         시뮬툴 껍데기 컨텍스트
 */
export function createFileBar(options) {
  const { kind, ids, resultKey, defaultName, getRows, setRows, ctx, emptyLabel = '새 목록' } = options;
  const el = (id) => document.getElementById(id);

  let origin = emptyLabel;
  let dirty = false;
  let fileName = '';

  function render() {
    const status = el(ids.status);
    status.textContent = `${origin} · ${getRows().length}건${dirty ? ' · 저장 안 함' : ''}`;
    status.className = dirty ? 'warn' : 'hint';
  }

  /** 저장하지 않은 편집을 버리기 전에 묻는다. 지키지 않으면 사람이 작업물을 잃는다. */
  function confirmDiscard(what) {
    return !dirty || confirm(`저장하지 않은 편집이 있습니다.\n${what} 하면 사라집니다.\n\n계속할까요?`);
  }

  function replace(rows, label, name = '') {
    origin = label;
    fileName = name;
    dirty = false;
    setRows(rows, label);
    render();
  }

  el(ids.newButton).addEventListener('click', () => {
    if (!confirmDiscard('새로 만들기를')) return;
    replace([], emptyLabel);
    ctx.toast('빈 목록에서 시작합니다', 'ok');
  });

  wireOpenDialog({
    input: el(ids.openInput),
    button: el(ids.openButton),
    kind,
    parse: ctx.parseFile,
    onError: ctx.reportError,
    onLoad: (result, name) => {
      if (!confirmDiscard('다른 파일을 열면')) return;
      const rows = result[resultKey] ?? [];
      replace(rows, `내 PC · ${name}`, name);
      ctx.toast(`${name} 에서 ${rows.length}건을 읽었습니다`, 'ok');
    },
  });

  wireSaveDialog({
    button: el(ids.saveButton),
    kind,
    onError: ctx.reportError,
    // **저장 직전에** 만든다 — 그래야 방금 고친 것이 담긴다.
    build: async () => {
      const rows = getRows();
      if (!rows.length) throw new Error('저장할 것이 없습니다');
      const { file } = await ctx.serializeFile(kind, resultKey, rows);
      return { name: fileName || defaultName, data: file };
    },
    onDone: (name, downloaded) => {
      dirty = false;
      fileName = name;
      origin = `내 PC · ${name}`;
      render();
      ctx.toast(
        downloaded
          ? `${name} 을 내려받았습니다 — 브라우저 다운로드 폴더에 있습니다.`
          : `${name} 으로 저장했습니다`,
        'ok',
      );
    },
  });

  return {
    /** 목록을 고쳤다 — 상태줄이 「저장 안 함」을 표시한다. */
    markDirty() { dirty = true; render(); },
    /** 시뮬레이터에서 끌어온 것처럼, 파일과 무관한 출처로 목록을 채울 때. */
    adopt(label) { origin = label; dirty = false; render(); },
    origin: () => origin,
    fileName: () => fileName,
    render,
  };
}
