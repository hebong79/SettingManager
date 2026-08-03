/**
 * object-fit: contain 영상의 마우스 클릭을 Hucoms 1920×1080 논리 좌표로 바꾼다.
 * 렌더링 여백(letterbox/pillarbox)은 유효 영상이 아니므로 null을 돌려 명령을 막는다.
 */
export function streamPointFromPointer({ button, clientX, clientY, viewport, image, naturalWidth, naturalHeight }) {
  if (button !== 0 || naturalWidth <= 0 || naturalHeight <= 0 || image.width <= 0 || image.height <= 0) return null;
  const sourceRatio = naturalWidth / naturalHeight;
  const boxRatio = image.width / image.height;
  const content = sourceRatio > boxRatio
    ? { left: image.left, top: image.top + (image.height - image.width / sourceRatio) / 2, width: image.width, height: image.width / sourceRatio }
    : { left: image.left + (image.width - image.height * sourceRatio) / 2, top: image.top, width: image.height * sourceRatio, height: image.height };
  if (clientX < content.left || clientX > content.left + content.width || clientY < content.top || clientY > content.top + content.height) return null;
  const x = Math.round((clientX - content.left) / content.width * 1920);
  const y = Math.round((clientY - content.top) / content.height * 1080);
  return {
    x: Math.min(1920, Math.max(0, x)),
    y: Math.min(1080, Math.max(0, y)),
    left: content.left - viewport.left + (clientX - content.left),
    top: content.top - viewport.top + (clientY - content.top),
  };
}
