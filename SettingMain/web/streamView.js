/**
 * 영상 뷰어 — **시작/정지/스냅샷**. 두 커미셔닝 화면이 같은 것을 쓴다.
 *
 * 주차면 탐색 화면(`discovery.js`)에도 같은 일을 하는 코드가 있지만 그쪽은 **클릭 센터링이
 * 얽혀 있어** 함께 묶지 않았다. 돌고 있는 것을 리팩터링하는 것은 이번 작업의 범위가 아니다.
 *
 * ## 자동으로 시작하지 않는다
 *
 * 이 저장소의 관례다. 영상은 카메라와 네트워크를 계속 쓰므로, 화면을 열었다는 이유만으로
 * 흐르기 시작하면 안 된다 — 특히 캘리브레이션 화면은 **20분짜리 스윕이 도는 중**일 수 있다.
 *
 * ## 스냅샷과 스트림은 같은 `img` 를 쓴다
 *
 * 그래서 스냅샷을 걸기 전에 스트림을 반드시 먼저 끊는다. 안 끊으면 MJPEG 연결이 살아 있는
 * 채로 다음 프레임이 덮어써서 "스냅샷을 눌렀는데 계속 움직인다"가 된다.
 */

export function createStreamView(options) {
  const {
    image, placeholder, tag, startButton, stopButton, snapshotButton,
    cameraId, onError, onFrame,
  } = options;

  let live = false;

  function setControls() {
    const available = Boolean(cameraId());
    if (startButton) startButton.disabled = !available || live;
    if (stopButton) stopButton.disabled = !live;
    if (snapshotButton) snapshotButton.disabled = !available;
  }

  function stop() {
    live = false;
    image.onerror = null;
    image.removeAttribute('src');
    image.classList.remove('live');
    if (placeholder) placeholder.style.display = '';
    if (tag) tag.textContent = '정지';
    setControls();
  }

  function fail() {
    stop();
    onError?.('영상을 불러오지 못했습니다 — 카메라 영상 URL 과 연결을 확인하세요.');
  }

  /** `mode` 는 `stream`(연속) 또는 `snapshot`(한 장). */
  function show(mode) {
    const id = cameraId();
    if (!id) return;
    // 스냅샷이든 스트림이든 **먼저 끊는다** — 살아 있는 MJPEG 위에 덮어쓰면 안 된다.
    stop();
    live = mode === 'stream';
    image.onerror = fail;
    image.src = `/api/${mode === 'stream' ? 'stream' : 'snapshot'}?cameraId=${encodeURIComponent(id)}&t=${Date.now()}`;
    image.classList.add('live');
    if (placeholder) placeholder.style.display = 'none';
    if (tag) tag.textContent = mode === 'stream' ? '수신 중' : '스냅샷';
    setControls();
  }

  startButton?.addEventListener('click', () => show('stream'));
  stopButton?.addEventListener('click', stop);
  snapshotButton?.addEventListener('click', () => show('snapshot'));
  if (onFrame) image.addEventListener('load', onFrame);
  addEventListener('pagehide', stop);

  setControls();
  return {
    start: () => show('stream'),
    snapshot: () => show('snapshot'),
    stop,
    setControls,
    /** 연속 수신 중인가. 정지 화면(스냅샷)은 `false` 다. */
    isLive: () => live,
  };
}
