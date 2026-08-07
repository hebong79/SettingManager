import { api } from './api.js';
import { drawSegments } from './vehicleBoxOverlay.js';

/**
 * 차량 3D 육면체 탭.
 *
 * **투영하지 않는다.** 사이드카가 `segments` 를 이미 이미지 좌표로 준다 — 받은 선분을 잇기만
 * 하면 되고, 그래서 이 화면은 마운트 높이·피치·롤을 알 필요가 없다(우리는 갖고 있지도 않다).
 *
 * ## 흐르는 영상 위에는 선분을 그리지 않는다
 *
 * 큐보이드는 **검출한 그 한 장**의 것이다. 카메라가 움직이거나 차가 지나가면 그 선분은 더 이상
 * 아무것도 가리키지 않는데, 화면에서는 여전히 차량 위에 얹혀 있는 것처럼 보인다 —
 * 그것이 이 화면이 낼 수 있는 가장 나쁜 거짓말이다. 그래서 **검출은 그 프레임에서 멈춘다.**
 *
 * ## 탭을 떠날 때 오버레이를 지운다
 *
 * 세 탭이 `img#stream` 하나를 나눠 쓰므로, 남겨 두면 **캘리브레이션 스윕 화면 위에 차량
 * 큐보이드가 얹힌 채로 보인다.** 그건 어느 탭의 그림도 아니다.
 */

const el = (id) => document.getElementById(id);
const fmt = (v) => (typeof v === 'number' ? v.toFixed(2) : '-');
const vec = (v) => (Array.isArray(v) ? v.map((n) => Number(n).toFixed(2)).join(', ') : '-');

export function createVehicleBoxPanel(ctx) {
  let live = false;

  /** 지금 그려 둔 것이 더 이상 이 화면을 설명하지 못한다 — 지운다. */
  function clearOverlay() {
    drawSegments(el('overlay'), el('stream'), []);
    el('staleNotice').hidden = !ctx.view.isLive();
  }

  async function loadStatus() {
    if (!ctx.cameraId()) return;
    const status = await api.vehicleBoxStatus(ctx.cameraId());
    const ready = status.configured && status.ready;
    // **꺼져 있다는 사실만으로는 손쓸 수 없다** — 무엇을 채워야 하는지까지 말한다.
    el('vboxNote').textContent = status.reason
      ?? (ready ? `모델 ${status.model ?? '-'} 로 답할 준비가 됐습니다.` : '사이드카가 아직 모델을 올리지 않았습니다 — 잠시 뒤 다시 시도하세요.');
    el('vboxNote').className = `capability-note ${ready ? 'ready' : ''}`;
    el('detect').disabled = !status.configured;
  }

  function renderDetections(detections) {
    el('detections').querySelector('tbody').innerHTML = detections.map((d, i) => `<tr>
      <td>${i + 1}</td><td>${d.label ?? '-'}</td><td>${fmt(d.score)}</td>
      <td>${vec(d.position_m)}</td><td>${vec(d.size_m)}</td><td>${fmt(d.yaw_deg)}</td>
      <td>${Array.isArray(d.segments) ? d.segments.length : 0}</td>
    </tr>`).join('') || '<tr><td colspan="7">검출된 차량이 없습니다.</td></tr>';
  }

  async function detect() {
    el('detect').disabled = true;
    try {
      // 흐르고 있었다면 **여기서 멈춘다.** 선분은 한 장의 것이라 움직이는 화면 위에서는 거짓말이 된다.
      const wasLive = ctx.view.isLive();
      ctx.view.snapshot();
      el('staleNotice').hidden = true;
      // 새 프레임이 로드되는 동안 **직전 검출의 선분이 잠깐 얹히지 않게** 지운다.
      // 추론이 도는 사이(수백 ms)에 옛 선분이 새 그림 위에 보이면 그것도 틀린 그림이다.
      drawSegments(el('overlay'), el('stream'), []);

      const result = await api.vehicleBoxDetect(ctx.cameraId());
      renderDetections(result.detections);
      el('calibration').textContent = result.calibration ? JSON.stringify(result.calibration, null, 2) : '사이드카가 캘리브레이션을 싣지 않았습니다.';
      drawSegments(el('overlay'), el('stream'), result.detections);
      ctx.toast(
        `${result.count}대 검출 (${result.latencyMs ?? '-'}ms)${wasLive ? ' · 이 프레임에서 멈췄습니다' : ''}`,
        'ok',
      );
      await loadHistory();
    } catch (error) {
      ctx.reportError(error);
    } finally {
      el('detect').disabled = false;
    }
  }

  async function loadHistory() {
    if (!ctx.cameraId()) return;
    const { records } = await api.vehicleBoxHistory(ctx.cameraId(), 20);
    el('history').querySelector('tbody').innerHTML = records.map((r) => `<tr>
      <td>${r.detectId}</td><td>${r.capturedAt}</td><td>${r.count}</td>
      <td>${r.ptz ? `${r.ptz.pan}/${r.ptz.tilt}/${r.ptz.zoom}` : '-'}</td>
      <td>${r.model ?? '-'}</td><td>${r.latencyMs ?? '-'}</td>
    </tr>`).join('') || '<tr><td colspan="6">아직 없습니다.</td></tr>';
  }

  el('detect').addEventListener('click', detect);
  // 스트리밍을 시작하면 그려 둔 선분은 곧 어긋난다 — 지우고, 왜 비었는지 화면이 말한다.
  el('streamStart').addEventListener('click', () => { if (live) clearOverlay(); });
  el('streamStop').addEventListener('click', () => { if (live) el('staleNotice').hidden = true; });

  return {
    // 능력 맵에는 차량 3D 가 없다 — 이 기능은 코어가 아니라 **사이드카**가 답한다.
    // `/api/core/vehicle-box/status` 가 별도로 준비 상태를 말한다.
    onCapability() {},

    onCameraChange() {
      // 기기를 바꾸면 오버레이도 함께 버린다 — 옛 카메라의 선분이 새 카메라 화면에 남으면
      // 그 자체가 틀린 그림이다.
      clearOverlay();
      el('detections').querySelector('tbody').innerHTML = '';
      el('calibration').textContent = '-';
    },

    /** 껍데기가 `img` 의 load 마다 부른다. 상자 크기가 달라졌을 수 있다(창 크기·레터박스). */
    onFrame() {
      if (live) drawSegments(el('overlay'), el('stream'));
    },

    async onActivate() {
      live = true;
      el('overlay').hidden = false;
      clearOverlay();
      ctx.setViewNote(`
        선분은 <strong>사이드카가 이미지 좌표로 준 것</strong>(<code>segments</code>)을 그대로 잇습니다 — 우리가 투영하지 않습니다.
        큐보이드는 12모서리지만 <strong>항상 12개가 오지는 않습니다</strong>: 화면 밖으로 크게 날아간 모서리는 개별적으로 버려집니다.`);
      await Promise.all([loadStatus(), loadHistory()]);
    },

    onDeactivate() {
      live = false;
      // 다른 탭 화면 위에 차량 큐보이드를 남기지 않는다.
      drawSegments(el('overlay'), el('stream'), []);
      el('overlay').hidden = true;
      el('staleNotice').hidden = true;
    },
  };
}
