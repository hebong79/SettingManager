import { zipDetections, type Detection, type DetectorClient, type DetectorResult } from './detectorTypes.js';
import { numberPairs, uploadJpeg } from './uploadJpeg.js';

/**
 * VPD **세그멘테이션** 클라이언트 — 차량 실루엣(윤곽 폴리곤)을 받는다.
 *
 * 실측 계약 — `Sub/vpd_api/routers/yolo.py:103-170` · `schemas/yolo.py`
 *   `POST {base}/vpd/api/v2/seg/imgupload` (multipart `file`) → 201
 *   `{ success, id, bboxes: [[x1,y1,x2,y2],…], masks: [[[x,y],…],…], confidences, classes }`
 *
 * 2026-08-07 라이브 실측(192.168.0.125:9081, 시뮬레이터 스냅샷 1장):
 *   seg → 차량 4대, `masks[0]` 이 417점 윤곽. det → `masks: []`.
 *
 * ## 왜 검출(`VpdClient`)과 따로 두는가
 *
 * **같은 서버의 다른 모델이다.** `/det` 는 상자만 주고 `masks` 는 늘 비어 온다(위 실측).
 * 번호판 호밍은 "**내 차 실루엣 안의** 번호판만 후보"라는 규칙으로 옆차 드리프트를 막는데,
 * 상자만으로는 그 규칙이 성립하지 않는다 — 주차장에서 차량 상자는 서로 크게 겹친다.
 * 그래서 마스크가 없으면 호밍을 켜지 않는다(`plateHomingComponent.support()`).
 *
 * ## 마스크가 비어 오면 **성공이라고 부르지 않는다**
 *
 * 세그 경로를 불렀는데 마스크가 없다면 그건 세그 모델이 아니거나 주소가 `/det` 로
 * 잘못 배선된 것이다. 조용히 빈 배열을 흘려보내면 호밍이 "차를 못 찾았다"로 퇴화하고,
 * 진짜 원인(배선 오류)은 영원히 안 보인다.
 */

export interface VpdSegClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

const PATH = '/vpd/api/v2/seg/imgupload';

export class VpdSegClient implements DetectorClient {
  readonly name = 'vpd' as const;

  constructor(private readonly options: VpdSegClientOptions) {}

  async detect(image: Buffer): Promise<DetectorResult> {
    const raw = await uploadJpeg({ detector: this.name, path: PATH, ...this.options }, image);
    const bboxes = numberPairs(raw.bboxes);
    const masks = Array.isArray(raw.masks) ? raw.masks : [];
    return {
      detector: this.name,
      success: raw.success === true,
      imageId: Number(raw.id) || 0,
      detections: zipDetections(
        // 상자와 마스크의 개수가 다를 수 있다(상류가 하나를 못 만들 수 있다).
        // **긴 쪽을 기준으로 삼지 않는다** — 짝이 없는 자리를 빈 값으로 채우면 "윤곽 없는 차량"이
        // 마스크 판정에서 조용히 탈락해, 왜 후보가 줄었는지 알 수 없게 된다.
        Math.min(bboxes.length, masks.length) || bboxes.length,
        raw.confidences,
        raw.classes,
        (i) => ({ ...bbox(bboxes[i]), ...contour(masks[i]) }),
      ),
    };
  }
}

/** 네 값이 다 있는 상자만 싣는다 — 모자란 자리를 0 으로 채우면 화면 왼쪽 위에 유령 상자가 그려진다. */
function bbox(raw: number[] | undefined): Pick<Detection, 'bbox'> {
  if (!raw || raw.length < 4 || !raw.slice(0, 4).every(Number.isFinite)) return {};
  return { bbox: [raw[0]!, raw[1]!, raw[2]!, raw[3]!] };
}

/**
 * 윤곽 폴리곤. LPD 의 4점 OBB 와 달리 **점 개수가 정해져 있지 않다**(실측 417점).
 *
 * 3점 미만은 면적이 없어 "안쪽"을 판정할 수 없으므로 버린다 — 그런 마스크를 남겨 두면
 * 점-내부 판정이 언제나 false 를 돌려주는데, 그건 "차량이 없다"와 구별되지 않는다.
 */
function contour(raw: unknown): Pick<Detection, 'polygon'> {
  if (!Array.isArray(raw) || raw.length < 3) return {};
  const points = raw.map((point) => (Array.isArray(point)
    ? { x: Number(point[0]), y: Number(point[1]) }
    : { x: Number.NaN, y: Number.NaN }));
  if (!points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return {};
  return { polygon: points };
}
