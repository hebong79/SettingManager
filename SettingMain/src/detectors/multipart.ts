/**
 * multipart/form-data 파일 1개짜리 본문을 손으로 만든다.
 *
 * 런타임 의존성 0 이라는 이 서비스의 규칙 때문이다. `FormData`/`Blob` 을 쓰면 Node 가 알아서
 * 인코딩해 주지만, 그러면 테스트가 **실제로 무엇이 나갔는지**를 볼 수 없다 — 상류(FastAPI)가
 * `file` 필드 이름을 요구하므로 그 이름이 맞는지 확인할 수 있어야 한다.
 */

export interface MultipartFile {
  /** 폼 필드 이름. FastAPI 의 `UploadFile` 파라미터 이름과 같아야 한다. */
  field: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface MultipartBody {
  contentType: string;
  body: Buffer;
}

/** 경계 문자열은 호출자가 넘긴다 — 난수를 쓰면 테스트가 본문을 단정할 수 없다. */
export function multipartFile(file: MultipartFile, boundary: string): MultipartBody {
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([head, file.data, tail]),
  };
}
