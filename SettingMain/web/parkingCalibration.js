import { api } from './api.js';

/**
 * 캘리브레이션 탭.
 *
 * 이 화면이 지키는 것 셋:
 *   ① **시작 전에 대가를 말한다** — 20분 점유는 확인 없이 시작할 일이 아니다.
 *   ② **게이트 미달에 화면 안의 탈출구가 있다** — 우회로를 API 에만 두면 그것은 우회로가 아니다.
 *      (상류에서 20분짜리 실측이 막다른 길에 선 적이 있다. 2026-08-05)
 *   ③ **잔차의 뜻을 함께 적는다** — full 의 잔차는 "이 카메라가 가진 오차"이고
 *      verify 의 잔차는 "보정 후 살아남은 오차"다. 같은 숫자가 정반대 뜻이다.
 *
 * **`onViewportClick` 을 내놓지 않는다.** 스윕이 카메라를 점유한 동안 사람이 조준을 끼워
 * 넣으면 그 샘플이 조용히 오염되고, 오염된 줄 모르는 채 발행까지 간다. 껍데기는 패널이
 * 준 것만 부르므로, 없는 것이 곧 꺼진 것이다.
 */

const el = (id) => document.getElementById(id);
const escape = (text) => String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmt = (v) => (typeof v === 'number' ? v.toFixed(v >= 10 ? 1 : 3) : '-');

export function createCalibrationPanel(ctx) {
  let timer = null;
  let supported = false;

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function renderSamples(recent = []) {
    el('samples').querySelector('tbody').innerHTML = recent.map((s) => `<tr class="${s.usable ? '' : 'bad'}">
      <td>${s.zoom}</td><td>${s.dx}</td><td>${s.dy}</td>
      <td>${fmt(s.residualX)}</td><td>${fmt(s.residualY)}</td>
      <td>${fmt(s.peak)}</td><td>${fmt(s.margin)}</td>
      <td>${s.usable ? '쓸 수 있음' : `기각 (${reasonText(s.reason)})`}</td>
    </tr>`).join('');
  }

  /** 기각 사유마다 **처방이 다르다** — 하나는 아침에 다시 오면 되고 하나는 카메라를 돌려야 한다. */
  function reasonText(reason) {
    return {
      dark: '너무 어두움 — 밝을 때 다시',
      smooth: '위치 특정 불가 — 미세 디테일 없음',
      featureless: '무늬 없음 — 차량·주차선 쪽으로',
      error: '매칭 실패',
    }[reason] ?? (reason ?? '-');
  }

  function renderResult(status) {
    const result = status.result;
    const box = el('result');
    if (!result) {
      box.innerHTML = '<p class="hint">아직 결과가 없습니다.</p>';
      el('mint').disabled = true;
      return;
    }

    if (result.mode === 'verify') {
      const verdictText = {
        pass: '통과 — 설치된 보정이 이 카메라에 맞습니다',
        fail: '미달 — 보정 후에도 오차가 남습니다',
        // **장면이 답하지 못한 줌은 통과가 아니다.** 통과라고 부르는 것이 이 기능이 낼 수 있는
        // 최악의 결과다 — 그 줌에서 쓸 수 있는 프레임을 한 장도 못 봤는데 "멀쩡하다"고 듣는다.
        incomplete: '미완 — 일부 줌에서 화면을 읽지 못했습니다 (통과가 아닙니다)',
        unknown: '판정 불가',
      }[result.verdict];
      box.innerHTML = `
        <p><strong>${verdictText}</strong>${result.worstPx === null ? '' : ` · 최악 잔차 ${result.worstPx}px`}</p>
        <p class="hint">이 패스의 잔차는 <strong>보정을 통과한 뒤 살아남은</strong> 오차입니다.</p>
        <table class="grid"><thead><tr><th>zoom</th><th>남은 잔차</th><th>적용된 게인</th><th>필요한 게인</th></tr></thead><tbody>
          ${result.checks.map((c) => `<tr><td>${c.zoom}</td><td>${c.residualPx}px</td><td>${c.gainApplied}</td><td>${c.gainNeeded ?? '-'}</td></tr>`).join('')}
        </tbody></table>
        ${result.unmeasured.length ? `<p class="warn">측정 못 한 줌: ${result.hint}</p>` : ''}`;
      el('mint').disabled = true;   // verify 는 발행하지 않는다 — 새 곡선을 만들지 않았다
      return;
    }

    box.innerHTML = `
      <p><strong>보정 전</strong> 조준 오차 ${result.residual.beforePx}px · 앵커 ${result.residual.anchors}개 ·
         쓸 수 있는 표본 ${result.usable}/${result.of}</p>
      <p class="hint">
        이 값은 <strong>보정 전</strong> 오차입니다 — 보정 후 남는 오차가 아닙니다.
        그것은 verify 패스만 말할 수 있습니다.
        초점 적합 중앙값 ${result.residual.fitRmsMedianPx}px (최댓값 ${result.residual.fitRmsPx}px).
      </p>
      <table class="grid"><thead><tr><th>zoom</th><th>화각(도)</th><th>게인</th></tr></thead><tbody>
        ${result.zoomHfov.map((p, i) => `<tr><td>${p.z}</td><td>${p.h}</td><td>${result.centeringGain[i]?.k ?? '-'}</td></tr>`).join('')}
      </tbody></table>
      ${result.skipped.length ? `<p class="warn">건너뛴 줌: ${result.skipped.map((s) => `${s.zoom} (${s.why})`).join(' · ')}</p>` : ''}`;
    el('mint').disabled = status.state !== 'done';
  }

  async function poll() {
    if (!ctx.cameraId()) return;
    try {
      const status = await api.calibrationStatus(ctx.cameraId());
      el('state').textContent = status.state;
      el('state').className = `badge ${status.state}`;
      el('message').textContent = status.message ?? '';
      el('progress').value = status.progress?.percent ?? 0;
      el('progressText').textContent = status.progress ? `${status.progress.done}/${status.progress.total}` : '-';
      renderSamples(status.recent);
      renderResult(status);

      const running = status.state === 'running';
      el('start').disabled = running || !supported;
      el('stop').disabled = !running;
      if (!running) stopTimer();
    } catch (error) {
      ctx.reportError(error);
      stopTimer();
    }
  }

  async function start() {
    const mode = el('mode').value;
    if (mode === 'full' && !confirm(
      '이 카메라를 20분가량 점유하고 고배율로 돌립니다.\n그 동안 이 카메라는 자기 자리를 보지 않습니다.\n\n시작할까요?',
    )) return;
    try {
      await api.calibrationStart(ctx.cameraId(), mode);
      ctx.toast('스윕을 시작했습니다', 'ok');
      if (!timer) timer = setInterval(poll, 2000);
      await poll();
    } catch (error) {
      ctx.reportError(error);
    }
  }

  async function mint(force = false) {
    try {
      const result = await api.calibrationMint(ctx.cameraId(), { apply: el('apply').checked, force });
      el('gate').hidden = true;
      ctx.toast(`rev-${result.profile.revision} 발행${result.applied ? ' · 런타임 적용됨' : ' (런타임은 아직 옛 값)'}`, 'ok');
      await loadProfile();
    } catch (error) {
      // ★ 게이트 미달은 막다른 길이 아니다 — 사유와 함께 화면 안에 탈출구를 낸다.
      if (String(error.message).includes('발행 게이트')) {
        el('gate').hidden = false;
        el('gate').innerHTML = `<p class="warn">${escape(error.message).replace(/\n/g, '<br>')}</p>`;
        const button = document.createElement('button');
        button.className = 'danger';
        button.textContent = '그래도 발행 (사유가 문서에 기록됩니다)';
        button.onclick = () => mint(true);
        el('gate').append(button);
        return;
      }
      ctx.reportError(error);
    }
  }

  async function loadProfile() {
    if (!ctx.cameraId()) return;
    try {
      const data = await api.profile(ctx.cameraId());
      el('revisions').innerHTML = data.revisions.map((r) => `<option value="${r}">rev-${String(r).padStart(4, '0')}</option>`).join('')
        || '<option value="">없음</option>';
      if (data.latest) el('revisions').value = String(data.latest);
      // 일치하거나 발행본이 없으면 조용하다 — 늘 떠 있는 경고는 아무도 읽지 않는다.
      el('drift').innerHTML = data.drift ? `<p class="warn">${escape(data.drift.message)}</p>` : '';
      el('profile').textContent = data.published ? JSON.stringify(data.published.optics, null, 2) : '발행된 프로파일이 없습니다.';
    } catch (error) {
      ctx.reportError(error);
    }
  }

  el('start').addEventListener('click', start);
  el('stop').addEventListener('click', () => api.calibrationStop(ctx.cameraId()).then(poll).catch(ctx.reportError));
  el('mint').addEventListener('click', () => mint(false));
  el('applyRevision').addEventListener('click', () => {
    const revision = Number(el('revisions').value);
    if (!revision) return;
    api.profileApply(ctx.cameraId(), revision)
      .then(() => { ctx.toast(`rev-${revision} 을 적용했습니다`, 'ok'); return loadProfile(); })
      .catch(ctx.reportError);
  });

  return {
    onCapability(caps) {
      const state = caps?.supported?.calibration;
      supported = Boolean(state?.ok);
      el('start').disabled = !supported;
      // 못 하는 이유를 **그대로** 보여준다. "불가"만 있으면 운영자가 손쓸 수 없다.
      const note = el('calibNote');
      note.hidden = supported;
      note.textContent = supported ? '' : (state?.reason ?? '코어 능력을 읽지 못했습니다.');
    },

    onCameraChange() {
      stopTimer();
    },

    async onActivate() {
      ctx.setViewNote(`
        스윕이 도는 동안 카메라가 실제로 어디를 보고 있는지 확인하는 용도입니다.
        가운데 십자가 클릭이 <strong>중앙으로 와야 할 자리</strong>입니다.
        <strong>이 탭에서는 클릭 센터링을 하지 않습니다</strong> — 스윕이 카메라를 점유하고 있는 동안
        사람이 끼어들면 그 샘플이 조용히 오염됩니다.`);
      await Promise.all([poll(), loadProfile()]);
    },

    onDeactivate() {
      stopTimer();
    },
  };
}
