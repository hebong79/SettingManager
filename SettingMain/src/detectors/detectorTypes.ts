/**
 * API 계층 — 구성도(`docs/my_think/my_setting_manager_구성.md`)의 **VPD · LPD · LPR**.
 *
 * 이 계층은 SettingManager 밖에서 도는 추론 서비스로 나가는 **유일한 통로**다.
 * 검출기마다 응답 모양이 다르지만(VPD 는 축정렬 상자, LPD 는 회전 상자) 상위 계층이
 * 그 차이로 분기하지 않도록 여기서 하나의 봉투로 정리한다.
 */

export const DETECTOR_NAMES = ['vpd', 'lpd', 'lpr'] as const;
export type DetectorName = (typeof DETECTOR_NAMES)[number];

export interface Point2 {
  x: number;
  y: number;
}

/** 검출 1건. `bbox` 와 `polygon` 중 검출기가 실제로 준 쪽만 실린다 — 없는 쪽을 지어내지 않는다. */
export interface Detection {
  className: string;
  confidence: number;
  /** 축정렬 상자 `[x1, y1, x2, y2]` (픽셀). VPD 가 준다. */
  bbox?: [number, number, number, number];
  /** 회전 상자 4점 (픽셀, TL→TR→BR→BL). LPD 가 준다. */
  polygon?: Point2[];
}

export interface DetectorResult {
  detector: DetectorName;
  /** 상류가 "검출이 하나라도 있었다"고 답했는가. 호출 성공 여부가 아니다. */
  success: boolean;
  /**
   * 상류가 보관한 주석 이미지 번호. `GET {baseUrl}/…/resp/img_{imageId}` 로 받아 볼 수 있다.
   * 상류가 메모리에만 들고 있으므로 재기동하면 사라진다 — 영속 식별자가 아니다.
   */
  imageId: number;
  detections: Detection[];
}

export interface DetectorClient {
  readonly name: DetectorName;
  /** JPEG 1장을 보내고 검출 결과를 받는다. */
  detect(image: Buffer): Promise<DetectorResult>;
}

/** 검출기 호출이 실패했다. 상류의 상태·본문을 잘라 내지 않고 메시지에 싣는다. */
export class DetectorError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
    this.name = 'DetectorError';
  }
}

/**
 * 이 검출기는 **지금 이 설치에서 쓸 수 없다** — 501 확정 답이다.
 * 일시 장애(502)와 구분해야 호출자가 재시도 여부를 판단할 수 있다.
 * `CoreUnsupportedError` 와 같은 규약을 쓴다.
 */
export class DetectorUnsupportedError extends Error {
  readonly statusCode = 501;
  constructor(readonly detector: DetectorName, reason: string) {
    super(reason);
    this.name = 'DetectorUnsupportedError';
  }
}

/**
 * 상류의 `confidences[]`·`classes[]` 는 검출과 **같은 차례의 평행 배열**이다
 * (근거: `Sub/vpd_api/schemas/yolo.py`, `Sub/lpd_api/schemas/yolo.py` — 둘 다 같은 규약).
 * 길이가 어긋나면 짝이 밀려 엉뚱한 신뢰도가 붙으므로, 없는 자리는 채우지 않고 `0`·`''` 로 남긴다.
 */
export function zipDetections(
  count: number,
  confidences: unknown,
  classes: unknown,
  shape: (index: number) => Pick<Detection, 'bbox' | 'polygon'>,
): Detection[] {
  const conf = Array.isArray(confidences) ? confidences : [];
  const cls = Array.isArray(classes) ? classes : [];
  return Array.from({ length: count }, (_, i) => ({
    className: typeof cls[i] === 'string' ? (cls[i] as string) : '',
    confidence: Number.isFinite(Number(conf[i])) ? Number(conf[i]) : 0,
    ...shape(i),
  }));
}
