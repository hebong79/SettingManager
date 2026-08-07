/**
 * 「열기…」·「저장…」 — **이 PC 의 파일**을 브라우저 대화상자로 다룬다.
 *
 * ## 시작 폴더를 지정할 수 없다
 *
 * 웹 페이지는 파일 대화상자의 시작 폴더를 임의 경로(`SettingMain/save/3D/Preset`)로
 * **지정할 수 없다** — 보안상 막혀 있고 우회로도 없다. 할 수 있는 것은 셋뿐이다:
 *
 *   ① 파일명을 미리 채운다 (`suggestedName`)
 *   ② `id` 를 주면 **크롬 계열이 그 대화상자의 마지막 폴더를 기억한다** — 한 번 그 폴더에서
 *      열고 나면 다음부터 거기서 열린다
 *   ③ 표준 위치를 화면에 적어 둔다
 *
 * 그래서 File System Access API(`showOpenFilePicker`·`showSaveFilePicker`)를 먼저 쓰고,
 * 없는 브라우저에서는 `<input type="file">` + 다운로드로 물러난다.
 *
 * ## 해석·좌표변환은 브라우저가 하지 않는다
 *
 * 브라우저는 파일을 **읽어 넘기고 받아 적기만** 한다. 형식 해석과 축 변환(Unity Y-up ↔
 * 언리얼 Z-up)은 서버가 한다 — 여기서 하면 규약이 두 벌이 되고, 그 실패는 화면에 오류로
 * 뜨지 않는다(좌표가 "그럴듯하게" 틀린다).
 *
 * 브라우저가 하는 일은 **BOM 제거**와 `JSON.parse` 둘뿐이다(BOM 붙은 파일이 실제로 있다).
 */

const MAX_BYTES = 4 * 1024 * 1024;

const hasPicker = () => typeof window.showOpenFilePicker === 'function';

const JSON_TYPE = [{ description: 'JSON 파일', accept: { 'application/json': ['.json'] } }];

/**
 * @param options.input   숨겨진 `<input type="file">` (물러설 때 쓴다)
 * @param options.button  누르면 대화상자를 여는 버튼
 * @param options.kind    `preset` | `car` | `camera` — 대화상자 기억 id 로도 쓴다
 * @param options.parse   `(kind, name, data) => 해석 결과` — 서버로 보낸다
 * @param options.onLoad  `(result, fileName) => void`
 */
export function wireOpenDialog(options) {
  const { input, button, kind, parse, onLoad, onError } = options;

  async function handle(text, fileName) {
    const data = parseJson(text, fileName);
    onLoad(await parse(kind, fileName, data), fileName);
  }

  button.addEventListener('click', () => void (async () => {
    if (!hasPicker()) return input.click();
    let handle_;
    try {
      // `id` 가 있어야 이 대화상자의 마지막 폴더를 기억한다.
      [handle_] = await window.showOpenFilePicker({ id: `sim-${kind}`, types: JSON_TYPE, multiple: false });
    } catch {
      return;   // 사용자가 취소했다 — 오류가 아니다.
    }
    const file = await handle_.getFile();
    assertSize(file);
    await handle(await file.text(), file.name);
  })().catch(onError));

  // 물러선 경로. `<input type="file">` 은 **같은 파일을 다시 고르면 `change` 가 안 난다** —
  // 값이 안 바뀌기 때문이다. 그래서 매번, 그리고 **읽기 전에** 비운다(아래에서 던지더라도
  // 다음 선택이 살아 있어야 한다). 이걸 빼면 "파일을 고쳤는데 화면이 그대로"가 된다.
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    void (async () => {
      assertSize(file);
      await handle(await file.text(), file.name);
    })().catch(onError);
  });
}

/**
 * 「저장…」. File System Access API 가 있으면 저장 대화상자를, 없으면 다운로드로 물러선다.
 *
 * @param options.build  `() => { name, data }` — 저장 직전에 부른다(최신 상태를 담기 위해)
 */
export function wireSaveDialog(options) {
  const { button, kind, build, onDone, onError } = options;

  button.addEventListener('click', () => void (async () => {
    const { name, data } = await build();
    const text = `${JSON.stringify(data)}\n`;

    if (typeof window.showSaveFilePicker === 'function') {
      let handle;
      try {
        handle = await window.showSaveFilePicker({ id: `sim-${kind}`, suggestedName: name, types: JSON_TYPE });
      } catch {
        return;   // 취소.
      }
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      onDone?.(handle.name);
      return;
    }

    // 물러선 경로: 브라우저 다운로드. **폴더를 고를 수 없다** — 브라우저 설정을 따른다.
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    // 즉시 해제하면 다운로드가 시작되기 전에 끊긴다.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    onDone?.(name, true);
  })().catch(onError));
}

function assertSize(file) {
  if (file.size > MAX_BYTES) {
    throw new Error(`파일이 너무 큽니다 (${(file.size / 1024 / 1024).toFixed(1)} MB) — 4 MB 까지 읽습니다`);
  }
}

function parseJson(text, fileName) {
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    // 어디가 틀렸는지 브라우저가 알려 준 그대로 싣는다 — "JSON 오류"만 있으면 손쓸 수 없다.
    throw new Error(`${fileName} 이(가) JSON 이 아닙니다: ${error.message}`);
  }
}
