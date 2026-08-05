import { zipDetections, type Detection, type DetectorClient, type DetectorResult } from './detectorTypes.js';
import { uploadJpeg } from './uploadJpeg.js';

/**
 * LPD(번호판 검출) 클라이언트.
 *
 * 실측 계약 — `Sub/lpd_api/routers/yolo.py:33-102` · `Sub/lpd_api/schemas/yolo.py:12-15`
 *   `POST {base}/lpd/api/v1/imgupload` (multipart `file`) → 201
 *   `{ success, id, polygons: [[[x,y]×4], …], confidences, classes }`
 *
 * VPD 와 달리 **회전 상자(OBB)** 다. 점 차례는 ultralytics 규약대로 TL→TR→BR→BL 이고,
 * 이 차례가 곧 변이므로 정렬하거나 뒤집지 않고 그대로 옮긴다.
 */

export interface LpdClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

const PATH = '/lpd/api/v1/imgupload';

export class LpdClient implements DetectorClient {
  readonly name = 'lpd' as const;

  constructor(private readonly options: LpdClientOptions) {}

  async detect(image: Buffer): Promise<DetectorResult> {
    const raw = await uploadJpeg({ detector: this.name, path: PATH, ...this.options }, image);
    const polygons = Array.isArray(raw.polygons) ? raw.polygons : [];
    return {
      detector: this.name,
      success: raw.success === true,
      imageId: Number(raw.id) || 0,
      detections: zipDetections(polygons.length, raw.confidences, raw.classes, (i) => polygon(polygons[i])),
    };
  }
}

/** 4점이 온전할 때만 싣는다. 점이 모자란 폴리곤은 닫히지 않아 그리는 쪽에서 도형이 무너진다. */
function polygon(raw: unknown): Pick<Detection, 'polygon'> {
  if (!Array.isArray(raw) || raw.length !== 4) return {};
  const points = raw.map((point) => (Array.isArray(point) ? { x: Number(point[0]), y: Number(point[1]) } : { x: Number.NaN, y: Number.NaN }));
  if (!points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return {};
  return { polygon: points };
}
