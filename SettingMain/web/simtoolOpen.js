/**
 * 「열기…」 — **이 PC 의 파일**을 브라우저 대화상자로 고른다.
 *
 * ## 해석은 브라우저가 하지 않는다
 *
 * 브라우저는 파일을 **읽어 넘기기만** 하고, 형식 해석과 좌표 변환은 서버가 한다
 * (`POST /api/sim/files/:kind/parse`). 여기서 해석하면 저장 폴더 경로와 업로드 경로가
 * **서로 다른 해석기**를 갖게 되고, 축 규약(Unity Y-up ↔ 언리얼 Z-up)이 두 벌이 된다.
 * 그 실패는 화면에 오류로 뜨지 않는다 — 좌표가 "그럴듯하게" 틀리기 때문이다.
 *
 * 브라우저가 하는 일은 둘뿐이다: **BOM 제거**와 `JSON.parse`.
 * (BOM 이 붙은 파일이 실제로 있고, 그대로 파싱하면 첫 글자에서 터진다.)
 *
 * ## 같은 파일을 다시 골라도 열린다
 *
 * `<input type="file">` 은 **같은 파일을 다시 고르면 `change` 가 안 난다** — 값이 안
 * 바뀌었기 때문이다. 그래서 매번 값을 비운다. 이걸 빼면 "파일을 고쳤는데 화면이 그대로"가 된다.
 */

const MAX_BYTES = 4 * 1024 * 1024;

/**
 * @param options.input   숨겨진 `<input type="file">`
 * @param options.button  누르면 대화상자를 여는 버튼
 * @param options.kind    `preset` | `car` | `camera`
 * @param options.onLoad  서버가 해석한 결과를 받는다 `(result, fileName) => void`
 */
export function wireOpenDialog(options) {
  const { input, button, kind, parse, onLoad, onError } = options;

  button.addEventListener('click', () => input.click());

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    // 값을 **먼저** 비운다. 아래에서 던지더라도 다음번 같은 파일 선택이 살아 있어야 한다.
    input.value = '';
    if (!file) return;

    void (async () => {
      if (file.size > MAX_BYTES) {
        throw new Error(`파일이 너무 큽니다 (${(file.size / 1024 / 1024).toFixed(1)} MB) — 4 MB 까지 읽습니다`);
      }
      const text = (await file.text()).replace(/^﻿/, '');
      let data;
      try {
        data = JSON.parse(text);
      } catch (error) {
        // 어디가 틀렸는지 브라우저가 알려 준 그대로 싣는다 — "JSON 오류"만 있으면 손쓸 수 없다.
        throw new Error(`${file.name} 이(가) JSON 이 아닙니다: ${error.message}`);
      }
      onLoad(await parse(kind, file.name, data), file.name);
    })().catch(onError);
  });
}
