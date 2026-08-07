/**
 * 큐보이드 오버레이 — **받은 선분만 잇는다.**
 *
 * 사이드카가 `segments` 를 이미 이미지 좌표(1920×1080 논리 프레임)로 준다. 우리는 투영하지
 * 않는다 — 그럴 만한 값(마운트 높이·피치·롤)을 갖고 있지도 않다.
 *
 * **개수를 가정하지 않는 것이 이 파일의 유일한 규칙이다.** 큐보이드는 12모서리(바닥 4 + 천장 4 +
 * 수직 4)라 보통 12개지만, 투영이 화면 크기의 3배를 넘어 날아간 모서리는 사이드카가 개별적으로
 * 버린다. 12개를 기대하고 인덱스로 면을 재구성하면 조용히 깨진다.
 */

const FRAME = { width: 1920, height: 1080 };

/**
 * `object-fit: contain` 으로 그려진 이미지의 **실제 내용 영역**. 여백(레터박스)은 영상이
 * 아니므로 거기에 선을 그리면 큐보이드가 화면 밖에 떠 있는 것처럼 보인다.
 *
 * 순수 함수라 DOM 없이 검사된다.
 */
export function contentBox(box, naturalWidth, naturalHeight) {
  if (!(naturalWidth > 0) || !(naturalHeight > 0) || !(box.width > 0) || !(box.height > 0)) return null;
  const sourceRatio = naturalWidth / naturalHeight;
  const boxRatio = box.width / box.height;
  return sourceRatio > boxRatio
    ? { left: 0, top: (box.height - box.width / sourceRatio) / 2, width: box.width, height: box.width / sourceRatio }
    : { left: (box.width - box.height * sourceRatio) / 2, top: 0, width: box.height * sourceRatio, height: box.height };
}

/** 논리 프레임 좌표 → 캔버스 좌표. */
export function toCanvas(point, content) {
  return {
    x: content.left + (point[0] / FRAME.width) * content.width,
    y: content.top + (point[1] / FRAME.height) * content.height,
  };
}

/**
 * 검출 하나의 선분을 캔버스 좌표 선분으로. **개수를 세지 않고, 모양이 이상한 것만 버린다.**
 * 4원소가 아닌 항목을 그냥 그리면 `undefined` 가 NaN 좌표가 되어 캔버스 전체가 조용히 빈다.
 */
export function segmentsToCanvas(detection, content) {
  const segments = Array.isArray(detection?.segments) ? detection.segments : [];
  return segments
    .filter((s) => Array.isArray(s) && s.length === 4 && s.every((n) => Number.isFinite(Number(n))))
    .map((s) => ({ from: toCanvas([Number(s[0]), Number(s[1])], content), to: toCanvas([Number(s[2]), Number(s[3])], content) }));
}

/** 마지막으로 그린 검출. 이미지가 늦게 로드돼도 다시 그릴 수 있어야 한다. */
let lastDetections = [];

export function drawSegments(canvas, image, detections) {
  if (detections !== undefined) lastDetections = detections;
  if (!canvas || !image) return;

  const rect = image.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);

  const content = contentBox({ width: rect.width, height: rect.height }, image.naturalWidth, image.naturalHeight);
  if (!content) return;

  context.lineWidth = 2;
  context.font = '13px system-ui, sans-serif';
  for (const [index, detection] of lastDetections.entries()) {
    // 검출마다 색을 돌린다 — 차량이 겹쳐 서 있으면 어느 선분이 어느 차의 것인지 알 수 없다.
    const hue = (index * 67) % 360;
    context.strokeStyle = `hsl(${hue} 90% 55%)`;
    context.fillStyle = `hsl(${hue} 90% 55%)`;

    context.beginPath();
    for (const { from, to } of segmentsToCanvas(detection, content)) {
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
    }
    context.stroke();

    const anchor = Array.isArray(detection?.label_point) ? detection.label_point : null;
    if (anchor) {
      const point = toCanvas([Number(anchor[0]), Number(anchor[1])], content);
      const score = typeof detection.score === 'number' ? ` ${detection.score.toFixed(2)}` : '';
      context.fillText(`${detection.label ?? '?'}${score}`, point.x + 4, point.y - 4);
    }
  }
}
