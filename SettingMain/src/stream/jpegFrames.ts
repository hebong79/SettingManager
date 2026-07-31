/**
 * image2pipe 로 이어 붙은 JPEG 바이트열에서 완결된 프레임만 잘라낸다.
 * SOI(FFD8) ~ EOI(FFD9) 로 구분하며, 잘린 꼬리는 `rest` 로 남겨 다음 청크와 이어 붙인다.
 */

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

export function splitJpegFrames(buffer: Buffer): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = [];
  let cursor = 0;

  for (;;) {
    const start = buffer.indexOf(SOI, cursor);
    if (start < 0) {
      // SOI 가 없으면 전부 버려도 되지만, 경계에 걸친 FF 한 바이트는 남긴다.
      return { frames, rest: buffer.subarray(Math.max(cursor, buffer.length - 1)) };
    }
    const end = buffer.indexOf(EOI, start + SOI.length);
    if (end < 0) return { frames, rest: buffer.subarray(start) };
    frames.push(buffer.subarray(start, end + EOI.length));
    cursor = end + EOI.length;
  }
}
