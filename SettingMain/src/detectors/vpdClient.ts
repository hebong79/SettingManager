import { zipDetections, type Detection, type DetectorClient, type DetectorResult } from './detectorTypes.js';
import { numberPairs, uploadJpeg } from './uploadJpeg.js';

/**
 * VPD(차량 검출) 클라이언트.
 *
 * 실측 계약 — `Sub/vpd_api/routers/yolo.py:32-100` · `Sub/vpd_api/schemas/yolo.py`
 *   `POST {base}/vpd/api/v2/det/imgupload` (multipart `file`) → 201
 *   `{ success, id, bboxes: [[x1,y1,x2,y2], …], masks, confidences, classes }`
 *
 * `masks` 는 세그먼트 경로(`/seg/imgupload`)에서만 의미가 있고 검출 경로에서는 비어 온다 —
 * 지금 쓰는 곳이 없으므로 **버린다**. 필요해지면 그때 계약을 다시 보고 싣는다.
 */

export interface VpdClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

const PATH = '/vpd/api/v2/det/imgupload';

export class VpdClient implements DetectorClient {
  readonly name = 'vpd' as const;

  constructor(private readonly options: VpdClientOptions) {}

  async detect(image: Buffer): Promise<DetectorResult> {
    const raw = await uploadJpeg({ detector: this.name, path: PATH, ...this.options }, image);
    const bboxes = numberPairs(raw.bboxes);
    return {
      detector: this.name,
      success: raw.success === true,
      imageId: Number(raw.id) || 0,
      detections: zipDetections(bboxes.length, raw.confidences, raw.classes, (i) => bbox(bboxes[i])),
    };
  }
}

/** 네 값이 다 있는 상자만 싣는다 — 모자란 자리를 0 으로 채우면 화면 왼쪽 위에 유령 상자가 그려진다. */
function bbox(row: number[] | undefined): Pick<Detection, 'bbox'> {
  if (!row || row.length < 4 || !row.slice(0, 4).every(Number.isFinite)) return {};
  return { bbox: [row[0]!, row[1]!, row[2]!, row[3]!] };
}
