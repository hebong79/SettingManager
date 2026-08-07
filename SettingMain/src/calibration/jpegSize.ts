/**
 * JPEG 헤더에서 치수만 읽는다. **디코딩하지 않는다.**
 *
 * ## 왜 이것이 필요한가
 *
 * 프레임 매칭은 그레이 래스터를 필요로 하고, 이 서비스는 그것을 ffmpeg 로 얻는다
 * (`frameDecode.ts`). 그런데 ffmpeg 의 `rawvideo` 출력에는 **헤더가 없다** — 바이트만 나온다.
 * 몇 × 몇인지는 따로 알아야 하고, 방법이 셋이었다.
 *
 * | 방법 | 왜 아닌가 |
 * |---|---|
 * | `ffprobe` 를 한 번 더 | 샘플마다 왕복이 두 배가 된다(112샘플 × 2프레임) |
 * | `-vf scale=1920:1080` 강제 | **정밀도를 잃는다.** 4K 스냅샷을 내리깎으면 서브픽셀이 뭉개지는데, 우리가 재는 신호 전체가 겨우 수십 픽셀 폭이다 |
 * | **SOF 마커 직독** | 채택. 25줄이고 왕복이 없다 |
 *
 * 그리고 이 함수의 값은 치수 자체보다 **대조**에 있다: 여기서 읽은 `width*height` 와 ffmpeg 가
 * 뱉은 바이트 수가 같아야 한다(`frameDecode.ts` 가 단언한다). 어긋나면 두 해석이 갈린 것이므로
 * 그 샘플은 조용히 틀린 좌표로 계산되는 대신 **버려진다.**
 */

export class JpegHeaderError extends Error {
  constructor(message: string) {
    super(`JPEG 헤더를 읽을 수 없습니다: ${message}`);
    this.name = 'JpegHeaderError';
  }
}

export interface JpegSize {
  width: number;
  height: number;
  /** `SOF2`(progressive)인가. 디코딩 방식이 달라서가 아니라 **진단에 쓴다**. */
  progressive: boolean;
}

/**
 * 길이 필드가 **없는** 마커. 건너뛸 바이트 수를 읽으려 하면 엉뚱한 곳으로 간다.
 *   `D8` SOI · `D9` EOI · `01` TEM · `D0`~`D7` RST
 */
function isStandalone(marker: number): boolean {
  return marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

/**
 * 프레임 시작(SOF) 마커인가.
 *
 * `C0`~`CF` 중 **셋은 SOF 가 아니다** — `C4`(DHT 허프만표) · `C8`(JPG 확장) · `CC`(DAC 산술부호).
 * 이 셋을 SOF 로 읽으면 허프만 표의 바이트를 치수로 해석해 그럴듯한 헛값이 나온다.
 */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

export function jpegSize(data: Buffer): JpegSize {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    throw new JpegHeaderError('SOI(FFD8) 로 시작하지 않습니다 — JPEG 이 아닙니다');
  }

  let offset = 2;
  while (offset + 1 < data.length) {
    // 마커 앞에는 0xFF 채움이 여러 개 올 수 있다(규격이 허용한다).
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = data[offset + 1]!;
    while (marker === 0xff && offset + 2 < data.length) {
      offset += 1;
      marker = data[offset + 1]!;
    }
    offset += 2;

    if (isStandalone(marker)) continue;
    if (offset + 1 >= data.length) break;

    const segmentLength = data.readUInt16BE(offset);
    if (segmentLength < 2) throw new JpegHeaderError(`세그먼트 길이가 ${segmentLength} 입니다 — 손상된 파일입니다`);

    if (isStartOfFrame(marker)) {
      // 길이(2) · 정밀도(1) · 높이(2) · 너비(2)
      if (offset + 7 >= data.length) throw new JpegHeaderError('SOF 세그먼트가 잘려 있습니다');
      const height = data.readUInt16BE(offset + 3);
      const width = data.readUInt16BE(offset + 5);
      if (width <= 0 || height <= 0) throw new JpegHeaderError(`치수가 ${width}×${height} 입니다`);
      return { width, height, progressive: marker === 0xc2 };
    }

    // 스캔 시작(SOS)까지 왔는데 SOF 가 없었다면 더 볼 것이 없다 — 뒤는 엔트로피 부호화 데이터라
    // 그 안의 0xFF 를 마커로 오독하게 된다.
    if (marker === 0xda) break;
    offset += segmentLength;
  }

  throw new JpegHeaderError('SOF 마커를 찾지 못했습니다');
}
